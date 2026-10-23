# Updating GSM's LunaHook engines

## Versions and compatibility

GSM reads the v2 catalog at:

`https://r2.gamesentenceminer.com/texthook/zip/texthook_manifest_v2.json`

The catalog contains `schemaVersion: 2`, `recommendedVersion`, and `releases`.
Each release includes a semantic package `version`, its `files` and SHA-256
hashes, and an `archive` with a SHA-256 and an immutable relative path:
`versions/<version>/texthook.zip`. Optional `notes` and
`engineVersions: { luna, textractor }` describe the build. Releases are displayed
newest first. Package versions identify matched LunaHook and Textractor bundles;
both architectures and both engines switch together.

**Latest and recommended are separate.** First installation and automatic updates
use `recommendedVersion`. Automatic updates only move to a newer semantic
version, never downgrade an installation or trial. A newly rebuilt engine can
be offered as an opt-in latest release while the established package remains
recommended. Initially, 1.0.3 remains recommended and 1.0.4 is opt-in.

Under **Texthook / Agent > Tools > Troubleshooting**, users can check the catalog,
choose any listed version, reinstall that version, or select **Update to latest**.
Installing a selected version permits downgrades and turns automatic updates off
after download verification. This preference is persisted, keeping the choice
across app restarts. Users can explicitly re-enable automatic updates later.
Checking manually only refreshes the catalog. Background checks run at startup
and every six hours and remain quiet during normal use.

**Do not overwrite either legacy endpoint:**

- `texthook/zip/texthook_manifest.json`
- `texthook/zip/texthook.zip`

These keep serving the restored 1.0.3 package to existing clients. Leave the
older loose-file `texthook/` objects intact too. New publications only add
versioned ZIPs and replace `texthook_manifest_v2.json`. The publisher rejects
legacy-only candidate directories. Do not deploy 1.0.4 through a v1 manifest.

## Safe local installation

GSM verifies the ZIP hash before extraction and every extracted runtime file
against the selected release. Unexpected files, duplicate entries, symlinks,
unsafe paths, unsupported schemas, and unavailable versions are rejected.
An active hook session continues using its existing package; a verified update
waits until all managed hook sessions stop. Explicit selections can replace a
queued automatic update. Staged files are verified again before activation.

Packages live in `<GSM data directory>/texthook/packages/<32 lowercase hex>`.
The local root `texthook_manifest.json` selects a package with `packageDirectory`;
older manifests without that field still use the flat directory. The pointer
switch is atomic and keeps the previous package and
`texthook_manifest.previous.json` for recovery. Local pointers keep the old
single-package manifest shape, including `archive.path: texthook.zip`, so older
desktop versions can still resolve the engines after a desktop rollback.
`profiles.json` stays in the root and is never downloaded or overwritten.
Failed downloads or activation leave the active package untouched.

## Sync and build

- Fork: <https://github.com/bpwhelan/LunaTranslator>
- Upstream: <https://github.com/HIllya51/LunaTranslator>
- Integration: `codex/gsm-lunahook-update`
- Workflow: `.github/workflows/gsm-lunahook.yml`
- CLI: `src/NativeImpl/LunaHook/LunaHost/LunaHostCLI.cpp`

Inspect both working trees and use a clean LunaTranslator checkout. Fast-forward
the fork's `main` from upstream when possible, preserving fork changes. Merge
upstream into the integration branch without force-pushing. Keep GSM's restored
CLI: upstream no longer builds the interface GSM uses. Inspect API changes
against `electron-src/main/ui/texthook.ts`.

A push touching the workflow or native sources starts **GSM LunaHook artifacts**
on Windows 2022. It builds matched x86/x64 LunaHook, LunaHost, LunaHostCLI, and the
shared `LunaTmpFontLoader.dll`, then tests both architectures. The isolated test
checks UTF-16LE commands, attachment, Japanese output in GSM's context format,
hook removal, detachment, clean EOF, and target survival. Use the exact successful
run SHA. These tests establish protocol compatibility; a real game still needs
a spot check. The workflow does not publish a release or R2 objects.

For local builds, Visual Studio 2022 C++ tools, a Windows SDK, ATL, CMake, Node,
and .NET Framework's C# compiler are required. Check every exit code; the old
Python build wrapper can hide native failures. Do not remove engine features
when a dependency is missing; use the artifact workflow instead.

```powershell
cmake -S src/NativeImpl/LunaHook -B build/gsm-x64 -G "Visual Studio 17 2022" -A x64 -DBUILD_CLI=ON -DBUILD_GUI=OFF -DWIN10ABOVE=ON -DBUILD_GSM_SMOKE_TARGET=ON
cmake --build build/gsm-x64 --config Release --target LunaHook LunaHostDll LunaHostCLI GsmHookSmokeTarget --parallel 4
node src/scripts/test_gsm_lunahook.mjs src/NativeImpl/LunaHook/builds/Release_win10 64
```

Use another build directory, `-A Win32`, and test argument `32` for x86.

## Prepare a package and catalog

Download both artifacts from the same successful run into a fresh directory:

```powershell
gh run download <run-id> --repo bpwhelan/LunaTranslator --dir .agent_scripts/lunahook-update/<date>/artifacts
node scripts/prepare-lunahook-update.mjs --artifacts .agent_scripts/lunahook-update/<date>/artifacts --output .agent_scripts/lunahook-update/<date>/candidate --version <new-version>
```

The package preparer rejects mismatched source/dependency revisions and invalid
PE architectures. It retains Textractor and NOTICE bytes and stages the seven
Luna runtime files. `candidate/texthook` contains the runtime, a reproducible
`texthook.zip`, and local single-package `texthook_manifest.json` metadata.
`candidate/provenance.json` records revisions and hashes. This local metadata
must not replace a public legacy manifest. Do not upload unpacked DLLs/EXEs,
fixtures, libraries, build intermediates, or provenance files.

To package checked-out engines without rebuilding, use
`scripts/generate_texthook_manifest.ps1 -Version <version> -OutFile <package>/texthook_manifest.json`.
This also generates local package metadata, not the public catalog.

Fetch the existing public v2 catalog, then retain it while adding the new package:

```powershell
node scripts/prepare-texthook-catalog.mjs --catalog <downloaded-v2-catalog.json> --package <candidate>/texthook --recommended <stable-version> --output <fresh-publish-directory>
```

For the initial migration, omit `--catalog` and repeat `--package` for both the
verified current 1.0.3 package and the new 1.0.4 package. Keep `--recommended 1.0.3`.
The builder copies ZIPs to `versions/<version>/texthook.zip` and writes
`texthook_manifest_v2.json`. Existing catalog entries are retained; changed bytes
or metadata require a new package version. Previous archives need not be copied
into later candidates: the publisher verifies the retained remote copies.

## Publish and verify

The destination is `gamesentenceminer` at
`https://eb6f3aaa8492feed2490ff04c24c21a1.r2.cloudflarestorage.com`, under
`texthook/zip/`. `R2_STORAGE` is read from the Process, User, then Machine
environment. It is verified as a Cloudflare API token. Its token ID is the S3
access key ID; SHA-256 of the token is the S3 secret, derived only in memory.
Credentials are never persisted or passed as command arguments. The helper
requires `rclone` and R2 read/write access. `-PurgeCache` also needs
**Zone > Cache Purge** for `gamesentenceminer.com`.

```powershell
# Read-only validation and backup:
pwsh -NoProfile -File scripts/publish-lunahook-update.ps1 -CandidateDirectory <publish-directory> -BackupDirectory <fresh-preflight-directory>

# Publish with a separate fresh rollback directory:
pwsh -NoProfile -File scripts/publish-lunahook-update.ps1 -CandidateDirectory <publish-directory> -BackupDirectory <fresh-publication-directory> -Publish -PurgeCache
```

The publisher verifies ZIP and member hashes, backs up the previous catalog and
all referenced archives, and refuses removal or alteration of published releases.
An existing archive path is reused only after verifying its bytes; it is never
overwritten. New archives use immutable caching. Before changing objects, the
helper proves cache-purge access for only the affected URLs. It uploads archives,
verifies authenticated origin bytes and actual public GET bodies, checks that the
catalog has not changed, and publishes the catalog last with revalidation caching.
A client holding the previous catalog can still download every old archive.

On failure after a catalog write, it restores and verifies the previous catalog.
After a failed first publication, it removes the new catalog. Unadvertised
immutable ZIPs can remain and are verified before reuse. A failed rollback is
reported explicitly; inspect the saved backup and remote state before retrying.
Never reuse a backup directory. `publication.json` records hashes, versions,
verified file count, URLs, and backup location. Public checks use ordinary GETs,
not HEAD or cache-busting queries. A mismatch saves `public-mismatch.json`.

## Validation and handoff

```powershell
node --test scripts/prepare-lunahook-update.test.mjs scripts/generate-texthook-manifest.test.mjs scripts/prepare-texthook-catalog.test.mjs
pwsh -NoProfile -File scripts/publish-lunahook-update.test.ps1
npx vitest run --config vitest.config.ts electron-src/main/ui/texthook_downloader.test.ts electron-src/main/ui/texthook.test.ts electron-src/main/ui/texthook_engine_updates.test.ts electron-src/main/services/texthook_updates.test.ts electron-src/renderer/src/components/tabs/TextHookTab.engine-updates.test.tsx
```

For a local trial, activate a verified new package through GSM's managed lifecycle
and retain its previous package. Resolve the actual data directory, which may be
relocated. Do not overwrite active DLLs or profiles. Prefer the in-app version
picker after v2 publication. A narrow R2 publication needs no GSM release or app
restart. For GSM code changes, finish builds and checks, then follow
`AGENTS.md` and `docs/AGENT_RESTART.md`: request an agent restart with `--handoff`
and hand control back once the warning is accepted, without waiting for relaunch.
