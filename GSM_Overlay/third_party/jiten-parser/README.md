# Jiten parser rules

The token correction rules and rewrite algorithm are from
[Jiten](https://github.com/Sirush/Jiten), by **Sirush and contributors**, under
the **Apache License 2.0**. The full license accompanies this directory in
`LICENSE`. The pinned revision and source SHA-256 are in `manifest.json`.
Thank you to the Jiten authors for making their parser available.

`upstream/MorphologicalAnalyser.RewriteRules.cs` is an unmodified copy of the
upstream source, including its explanatory comments. `token-rewrite-rules.json`
is a GSM-generated conversion of its complete 133-rule table. GSM's modified
Rust port of the engine lives in `input_server/src/jiten_rules.rs`.

GSM modifications: conversion from C# to JSON/Rust; UTF-8 source-span checks
before rewriting and UTF-16 output offsets; preservation of whitespace; local
SQLite vocabulary matching; and conservative handling of unavailable JMdict
guards and remote word identities. Parsing uses no network connection.

## Scope

All 133 declarative rules are imported. The 128 rules without JMdict guards
can run in the original Early, Late, Cleanup, Reading phase order. The five
guarded rules (`kariru`, `konna-no`, `sonna-no`, `anna-no`, `donna-no`) remain
inactive: GSM does not have Jiten's complete JMdict lookup database. Missing
dictionary data is **unknown**, not evidence that a compound is absent. The
user's known-word list must never be substituted for that dictionary.

This is a port of the **declarative token rewrite component**, not Jiten's full
parser. Other C# split/combine/repair stages, its deconjugator, dictionary and
frequency-based candidate selection, and its custom Sudachi user dictionary
are not included. Consequently some rules require token sequences that GSM's
base Sudachi dictionary does not produce, and results can differ from Jiten.
`RecoverConjugations` and `HardPin` are retained in the imported data; GSM does
not generate conjugation explanations or run the later compound lookup that
hard pins protect against. Pins still prevent ordinary subsequent rewrites.

Only an identity matched to an imported vocabulary record can be exposed for
grading. A rule's JMdict pin disambiguates that lookup; a reading index is never
invented. Corrections also work with Anki-only vocabulary, within these limits.

## Updating

```powershell
node scripts/sync-jiten-parser-rules.mjs <clean-Jiten-checkout>
node --test GSM_Overlay/tests/jiten_rule_import.test.cjs
cargo test --manifest-path GSM_Overlay/input_server/Cargo.toml
```

The importer reads committed Git blobs, retains ordering, and fails on unknown
C# syntax, constructor fields, phases, or enum values. Review the source and
generated-data diff, license, guard inventory, and rule-count test when updating.
The Rust schema also rejects unknown fields. No upstream code is executed.
The rules are embedded in the Rust binary; this directory, including its credits
and license, must accompany packaged overlays.
