# Updating GSM's LunaHook engines

## In-app updates

After the first engine installation, GSM checks at startup and every six hours.
Automatic engine updates are enabled by default. They download one ZIP in the background,
verify its SHA-256 before extraction and every extracted file against the manifest,
and wait for all active text
hooks to stop before activation. GSM rechecks the staged files before switching.
Only a newer semantic package version is offered; a newer local trial is never
automatically downgraded.

Updates happen silently during normal use, independently of desktop app updates.
For manual recovery, **Texthook / Agent** has a fully collapsed **Troubleshooting**
section at the bottom, below **Engine Log**. Opening it reveals package status,
**Check now**, **Update now** or **Repair / reinstall**, and the automatic update
preference. Background activity and errors never open this section or show update
notifications. First-use setup only shows **Preparing text capture…**.

Downloaded packages live in `<GSM data directory>/texthook/packages/<id>`.
The root `texthook_manifest.json` selects the active package with its
`packageDirectory` field; manifests without this field still use the legacy
flat layout. Installation switches that manifest atomically after verification
and keeps the previous binaries and `texthook_manifest.previous.json` for recovery.
An interrupted download or failed switch leaves the active package untouched.
`profiles.json` remains in the root directory and is never part of a download.

GSM needs a matched pair of 32-bit and 64-bit LunaHook, LunaHost, and
LunaHostCLI binaries. Current upstream does not build the CLI used by GSM.
The fork's `codex/gsm-lunahook-update` branch restores it and provides an
artifact-only build workflow with a native integration test.

- Fork: <https://github.com/bpwhelan/LunaTranslator>
- Upstream: <https://github.com/HIllya51/LunaTranslator>
- Build branch: <https://github.com/bpwhelan/LunaTranslator/tree/codex/gsm-lunahook-update>
- Workflow: `.github/workflows/gsm-lunahook.yml`
- CLI: `src/NativeImpl/LunaHook/LunaHost/LunaHostCLI.cpp`

## Sync and build

Inspect both repositories' working trees before starting. Use a separate clean
LunaTranslator checkout and preserve the existing CLI integration branch.
Fast-forward the fork's `main` from upstream when possible; do not force-sync
over fork-only commits. Merge the current upstream revision into the CLI branch
and resolve source/API changes there. Read the actual workflow before running it.

Pushes to `codex/gsm-lunahook-update` that touch the workflow or hook sources
start the **GSM LunaHook artifacts** workflow. It builds on Windows 2022,
tests both architectures, and uploads `gsm-lunahook-32` and `gsm-lunahook-64`.
It does not create releases or change GSM's public R2 files. For an unchanged
revision, rerun its existing build; once the workflow exists on the default
branch, it can also be dispatched manually for an explicit ref.

Check the run's exact `headSha` and both jobs' conclusions. The native test
launches an isolated fixture, attaches the CLI, inserts a Unicode R-code,
verifies Japanese output in GSM's format, removes the hook, detaches, and checks
clean EOF. This is a protocol check; real games still need a spot check.

Local builds need Visual Studio 2022 C++ tools, a Windows SDK, ATL, CMake, Node,
and .NET Framework's C# compiler. Build both architectures with:

```powershell
cmake -S src/NativeImpl/LunaHook -B build/gsm-x64 -G "Visual Studio 17 2022" -A x64 -DBUILD_CLI=ON -DBUILD_GUI=OFF -DWIN10ABOVE=ON -DBUILD_GSM_SMOKE_TARGET=ON
cmake --build build/gsm-x64 --config Release --target LunaHook LunaHostDll LunaHostCLI GsmHookSmokeTarget --parallel 4
node src/scripts/test_gsm_lunahook.mjs src/NativeImpl/LunaHook/builds/Release_win10 64
```

Use another build directory with `-A Win32` and test argument `32` for x86.
Check each command's exit code. The old `buildlunahook.yml` uses stale paths
and is not the GSM workflow. The upstream Python build wrapper can also hide
failed native commands; prefer the direct CMake commands above.

## Prepare a candidate

From GSM's repository root, download the successful run and stage a new package:

```powershell
gh run download <run-id> --repo bpwhelan/LunaTranslator --dir .agent_scripts/lunahook-update/artifacts
node scripts/prepare-lunahook-update.mjs --artifacts .agent_scripts/lunahook-update/artifacts --output .agent_scripts/lunahook-update/candidate --version <new-manifest-version>
node --test scripts/prepare-lunahook-update.test.mjs scripts/generate-texthook-manifest.test.mjs
```

Use fresh artifact/output directories for each candidate. The staging script
rejects mismatched source/dependency revisions and incorrectly labeled native
architectures. It preserves the existing Textractor files and notice, copies
the six native Luna components plus `LunaTmpFontLoader.dll`, and generates
`texthook.zip` plus a UTF-8 manifest without a BOM. The manifest's `archive`
contains the ZIP path and SHA-256; `files` retains each runtime file's SHA-256.
The ZIP includes `NOTICE.md` and the DLLs/EXEs with their existing relative paths,
without a wrapper folder, library files, or build intermediates.
It does not install or publish files. Only `candidate/texthook/texthook.zip` and
`candidate/texthook/texthook_manifest.json` are uploaded; the unpacked files are
retained locally for trials. `candidate/provenance.json` records source revisions
and hashes. Keep the source commit publicly accessible.

To repackage the current checked-out engines without a new native build:

```powershell
.\scripts\generate_texthook_manifest.ps1 -Version <new-manifest-version> -OutFile .agent_scripts/texthook-zip/texthook_manifest.json
```

Both generators use `scripts/generate-texthook-manifest.mjs`. It writes one
`texthook.zip` next to the requested manifest, with reproducible timestamps.

Choose a semantic manifest version higher than both the checked-in and published
version. GSM offers only newer versions, and verifies the files using their
hashes. Do not reuse `1.0.0` for changed binaries.

## Try it in GSM

GSM resolves the downloaded runtime through
`<active GSM data directory>/texthook/texthook_manifest.json`, even during
development. Its `packageDirectory` selects the active package; an older
manifest without this field uses the root texthook folder. Updating
`electron-src/assets/texthook` alone does not activate a trial. Resolve the active
data directory using `data_dir.json` and GSM's data-directory code; do not assume
the default if the user relocated it.

Before installation, back up the root manifest and preserve the current package
and `profiles.json`. Ensure no managed text hook session is active. Copy the
candidate's manifest-listed runtime files into a new `packages/<32 lowercase hex characters>` folder
and verify every manifest-listed SHA-256 there. Only after verification, atomically
replace the root manifest with the candidate manifest plus `packageDirectory`
pointing at that folder. If the previous manifest had a `packageDirectory`, retain
it as `previousPackageDirectory`. Never copy a trial over the active binaries.
Keep a restore script alongside the backup.

Copy the seven new Luna files into `electron-src/assets/texthook/luna_builds/`
and the candidate manifest into the repository root for review. Follow
`docs/AGENT_RESTART.md`: check `npm run agent:status`, then run
`npm run agent:restart -- --reason "LunaHook trial is ready to test"`.
Native-only updates do not require rebuilding the unchanged Electron code.
Treat any nonzero restart result as a failure.

For a trial, use a version higher than the published version. GSM will not
replace it with older published engines. Disable automatic updates under
**Engine settings** if the trial should remain pinned. Test by selecting Luna and attaching to a
game; check discovered hooks, Japanese text, a saved/manual hook, and detach.

## Publish after the trial

The bucket is `gamesentenceminer`, with S3 endpoint
`https://eb6f3aaa8492feed2490ff04c24c21a1.r2.cloudflarestorage.com`.
Exactly two objects under `texthook/zip/` are served at
`https://r2.gamesentenceminer.com/texthook/zip/`: `texthook.zip` and
`texthook_manifest.json`. Keep these fixed names; do not upload individual DLLs,
EXEs, per-engine ZIPs, or versioned ZIPs. Leave the older `texthook/` objects
available for older GSM clients.

Set `R2_STORAGE` to the Cloudflare API token. The upload helper reads it from
the process, Windows User, or Windows Machine environment, so a newly added
machine variable works without restarting the terminal or Codex. It verifies
the token and derives S3 credentials in memory: the token ID is the access key
ID, and SHA-256 of the token value is the secret access key. See
[Cloudflare's authentication documentation](https://developers.cloudflare.com/r2/api/tokens/#get-s3-api-credentials-from-an-api-token).
Credentials are never written to configuration or passed on the command line.
The helper requires `rclone` on PATH. The token needs R2 read/write access and
**Zone > Cache Purge** for `gamesentenceminer.com` when using `-PurgeCache`.

```powershell
# Read-only preflight, including a verified local copy of the current public payload:
.\scripts\publish-lunahook-update.ps1 -CandidateDirectory .agent_scripts/lunahook-update/candidate/texthook -BackupDirectory .agent_scripts/lunahook-update/r2-preflight

# Publish the approved candidate, keeping a separate rollback copy:
.\scripts\publish-lunahook-update.ps1 -CandidateDirectory .agent_scripts/lunahook-update/candidate/texthook -BackupDirectory .agent_scripts/lunahook-update/r2-publication -Publish -PurgeCache
```

Use fresh backup directories. The publisher validates the ZIP hash and its
contents against every manifest entry, then backs up the previous ZIP and
manifest when present. An empty ZIP prefix is supported for the first upload.
It uploads `texthook.zip`, verifies the authenticated origin and the normal
public URL, then uploads `texthook_manifest.json` **last** and verifies both
public objects. It sets uploaded objects to revalidate rather than retain stale
cached versions. Provenance, unpacked files, fixtures, and backups stay local.
With `-PurgeCache`, it verifies purge access before overwriting objects and
clears only these two URLs. `publication.json` records both hashes and URLs,
the version, verified runtime file count, and backup location.

The publisher's local tests cover first publication, later updates, and rollback:

```powershell
pwsh -NoProfile -File scripts/publish-lunahook-update.test.ps1
```

On a publication failure, the helper attempts to restore and publicly verify
the previous ZIP and manifest. A failed rollback is reported explicitly;
inspect the saved backup and remote state before retrying. A failed first upload
removes any new manifest; an unreferenced ZIP can remain for inspection.
No legacy texthook objects are changed. Do not republish changed bytes under an
existing manifest version.

Cloudflare can retain old `.exe` GET responses for four hours despite fresh
origin bytes and fresh HEAD responses. Changing Cache-Control on R2 does not
evict a previously cached response. Verify actual downloads at the exact URLs
GSM uses; do not declare success based on HEAD, origin-only checks, or
cache-busting queries. A mismatch saves `public-mismatch.json`. If Cloudflare
refuses the purge, add the specific zone permission or manually clear the
affected URLs before retrying. Do not purge the whole zone. `-PurgeCache` may
be omitted when the relevant cache has already been cleared or is disabled.

R2's existing layout overwrites fixed filenames, so this is not an atomic
deployment: clients downloading during the upload window can encounter a hash
mismatch. Keep the previous payload available for rollback and minimize the
window. Do not mark publication successful on upload exit codes alone.

After changes, run the downloader and integration tests:

```powershell
npx vitest run --config vitest.config.ts electron-src/main/ui/texthook_downloader.test.ts electron-src/main/ui/texthook.test.ts
```

The downloader uses only the ZIP endpoint; it no longer falls back to loose
GitHub DLL/EXE downloads. A failed download leaves installed engines untouched.
Old local manifests without archive metadata remain readable. A narrow R2 upload
does not require a GSM release or an unrelated GitHub push.
