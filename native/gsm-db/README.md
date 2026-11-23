# GSM database migrations

`gsm-db` owns the core, archive, vocabulary and Anki-cache schemas for the active SQLite profile. Before opening the history service, desktop startup repairs pending relocations, takes an enabled pre-upgrade backup, upgrades the core schema and registers scheduled jobs. Subsequent database changes use the serialized history writer. Standalone Python can call the same schema implementation through the native extension. Existing row IDs, SQLite affinities, sync triggers and optional-feature lifetimes are part of the on-disk contract.

## Changing the core schema

1. Add the next numbered SQL file under `migrations/`. Append its entry to `MIGRATIONS` in `src/lib.rs`. Use a Rust migration function for a change that depends on existing columns or data.
2. Leave released migration files in place. Each profile starts at its own `PRAGMA user_version`. The runner rechecks the version after taking an immediate write transaction and advances it only after the step succeeds. A failure rolls back every step from that invocation. A newer schema produces an error.
3. Update readers and any remaining Python model fields that use the changed data. Give frequently used predicates an index when the query plan and benchmarks justify the extra write cost.
4. Exercise a fresh file, a populated file at the previous version and a second open. Include a failure-and-retry case for changes that rewrite user data. The migration tests use temporary SQLite profiles.

GSM enables and disables the vocabulary and Anki cache together. Their schema version lives in `gsm_feature_schemas`, separately from the core version. Put changes to those tables in the vocabulary migration sequence in `src/vocabulary.rs`. Preserve archived word IDs and the existing tokenization flags when upgrading an enabled profile. A fresh enable resets eligible lines for backfill.

Desktop feature changes use `vocabulary::configure_desktop` to publish the schema and job registrations in one transaction. The bundled dictionary importer reads version metadata before parsing the term list. It sorts and deduplicates new entries on a reader and applies changed ranks through the profile writer. A failed publication rolls back the source metadata, frequency rows and cached ranks together. The desktop drains the refresh before releasing the profile for restore. [Vocabulary measurements](../../docs/benchmarks/vocabulary-setup-2026-11-21.md)

## Verification

```sh
cargo test --locked --manifest-path native/gsm-db/Cargo.toml
cargo test --locked --manifest-path native/gsm-history/Cargo.toml
cargo test --locked --manifest-path native/gsm-web/Cargo.toml
```

The [performance report](../../docs/benchmarks/stats-web-2026-11-20.md) covers warm schema checks, reports, imports and verified online backups. The backup test restores a committed WAL transaction and checks that a failed snapshot preserves the previous backup.

The [profile startup benchmark](../../docs/benchmarks/profile-files-2026-11-21.md) covers relocation, manual and daily backup, and registration of eight startup jobs. Recovery tests also reopen the displaced database with its archived WAL and exercise concurrent attempts to recover the same profile.
