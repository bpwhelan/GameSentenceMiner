# Native desktop CI and dependency handoff

## Build status

On November 24, 2026, all four hosted jobs were still running when this handoff was written. The artifact-only run tests commit `0b6c1489` on `codex/tauri-architecture`. Its version check passed. The run has publishing disabled. [Four-platform run](https://github.com/bpwhelan/GameSentenceMiner/actions/runs/45520686266)

| Platform | Latest evidence before this run | What still needs verification |
| --- | --- | --- |
| Windows x64 | The previous run passed native services, windows, settings, database, vocabulary, input and notification tests. The first Yomitan lookup then timed out after two 60-second attempts. Another hosted run passed Yomitan import, Home lookup and reopen. | **First investigation if CI is red.** Capture which stage stalls in the hidden WebView2 lookup page on a cold profile. The timeout precedes the Home popup test. [Failed job](https://github.com/bpwhelan/GameSentenceMiner/actions/runs/45517496205/job/138880791625) |
| Linux x64 | The previous hosted run passed the desktop scenarios, including both dictionary engines, and reached bundle creation. The revised bridge also passed a local Yomitan import and Home lookup. | Confirm the final desktop checks, bundle creation and artifact upload. [Previous job](https://github.com/bpwhelan/GameSentenceMiner/actions/runs/45517496205/job/138880792464) |
| macOS arm64 | Runtime, foundation and native service checks passed after fixing resource-directory selection. The Home test then failed before it could find the transcript. | The latest commit presents Home through its regular focus and visibility path. If the transcript is still missing, check for `Reader requested its transcript snapshot` and the failure's visibility, active tab and page text. [Failed job](https://github.com/bpwhelan/GameSentenceMiner/actions/runs/45517496205/job/138880791608) |
| macOS Intel | An earlier hosted package test returned HTTP 404. Its fixture parsed a partial TCP read as a complete request. A regression test reproduced the 404 locally. All 19 package integration tests passed after the fix. | Confirm the fixture fix, desktop checks and Intel bundle on the hosted runner. [Failed job](https://github.com/bpwhelan/GameSentenceMiner/actions/runs/45514373611/job/138870095105) |

These commands show the current run and list its uploaded artifacts.

```sh
gh run view 45520686266 -R bpwhelan/GameSentenceMiner
gh api repos/bpwhelan/GameSentenceMiner/actions/runs/45520686266/artifacts --jq '.artifacts[].name'
```

For the Windows timeout, start with `lookup_reader_dictionary` in `src-tauri/src/reader_service.rs`. It evaluates Yomitan's module imports and `termsFind` in a single browser call. Log page readiness, module import completion and the first dictionary reply separately. The existing log cannot distinguish those stages. A clean-profile local Windows run has passed on the hosted WebView2 version, so the hosted failure log matters.

## Dictionary popup

The portable Tauri host now connects Home to its embedded Yomitan popup through the registered reader origin. A regression test reproduces the case where the background reports a connection before both frames receive their ports. All five transport tests pass with the fix. Hachidori also has a regression test for a lost readiness reply during startup.

The verification exercises a real dictionary import, stationary Shift lookup in Home, overlay lookup and reopening a retained profile. Native migration tests now read captured synthetic profiles for both dictionaries. The Windows and Linux migration checks passed locally. On Linux the staged application audit found 77.5 MiB in 1,203 files and zero Node or Electron runtime payloads. The renderer build and CI test harness still use Node as a development tool.

## Native dependency candidates

These changes were tested in an isolated checkout. The pushed CI fixes leave the dependency decisions open.

| Candidate | Evidence |
| --- | --- |
| Drop direct `chrono` from `gsm-dictionary-transfer`, `serde` from `gsm-texthook`, and `ndarray` from `gsm-mining` | The crates build without these declarations. Other dependencies still bring the libraries into the application. |
| Consolidate `zip` on 4.6.1 in `gsm-overlay` and the Sudachi input helper | This removes the duplicate 2.6.1 version. The overlay and language tests passed. |
| Reuse `dirs` in `gsm-overlay` | Both uses of `directories` only obtain the home directory. The desktop already uses `dirs`. |
| Use the Tokio features of `rfd` and `ashpd` on Linux | The dependency tree drops `async-fs` and `async-net`. Exercise a real file chooser through the Linux desktop portal before adopting this change. |

Together these candidates reduced unique packages on normal Cargo dependency edges from 463 to 461 on Windows, 580 to 576 on Linux, 474 to 472 on Apple Silicon, and 477 to 475 on Intel Mac. Installed-size impact is unmeasured.

Keep the current Google Vision JWT signing backend. An AWS-LC trial removed another 16–28 packages depending on platform, but the stripped Linux RS256 signing probe grew from 1.25 to 3.11 MiB. Both implementations produced identical signatures verified by OpenSSL.
