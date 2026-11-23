# Windows desktop port measurements

All Rust results below used unoptimized builds on Windows. Each row is a median of five rounds. The fixtures used temporary profiles and loopback ports.

## Windows speech recognition

The workers used the same two deterministic helper executables. The capture fixture sent numbered PCM blocks and the recognizer verified every byte and emitted 64 timestamped results. The live fixture sent 20 ms blocks at 16 kHz. The burst sent 64 MiB as fast as the helpers could transfer and verify it. Each pair alternated execution order across rounds.

| Workload | Coordinator | Elapsed | Coordinator CPU | Peak working set | Median result delivery |
| --- | --- | ---: | ---: | ---: | ---: |
| Real-time PCM | Python relay | 1,520 ms | 15.6 ms | 22.0 MiB | 132.2 ms |
| Real-time PCM | Rust direct pipe | 1,332 ms | 31.3 ms | 14.2 MiB | 0.111 ms |
| 64 MiB burst | Python relay | 266 ms | 78.1 ms | 22.0 MiB | 156.1 ms |
| 64 MiB burst | Rust direct pipe | 206 ms | 15.6 ms | 14.2 MiB | 0.064 ms |

Result delivery starts when the recognizer emits a result and ends when the coordinator reads it. Passing the OS pipe directly between the capture helper and recognizer removes the desktop PCM copy. Reading result events as they arrive also removes the Python queue's 250 ms polling interval. Windows reported CPU time in increments of roughly 15.6 ms, so the live CPU difference is one tick. CPU and memory cover the coordinator in isolation. Speech inference, helper memory, actual game audio, WebView memory and time to display a subtitle are outside this measurement.

An isolated Tauri desktop also exercised the Speech Recognition tab's commands with Python removed from the search path. All 32 partial/final pairs reached text intake. The smoke test checks the last revision, rejection of a mismatched scene, automatic stop on a scene change, and an explicit start/stop on the new scene.

## Reading-stat writes

The benchmark replaced one source's 500 reading entries in a disposable SQLite database, with 20 requests per round. The Flask reference uses the current batch writer. The Rust example runs the production JSON validation and writer. Both workers produced the same totals, counts and response. Timings cover application-layer request handling and exclude network round trips. On Windows, memory measurements use the worker's lifetime peak working set.

| Handler | Wall time per request | CPU per request | Working set |
| --- | ---: | ---: | ---: |
| Flask | 5.84 ms | 5.47 ms | 73.5 MiB |
| Rust debug | 6.98 ms | 6.25 ms | 8.6 MiB |

The direct Rust handler used less memory and took longer for this workload. Requests now validate entries before replacing rows in one transaction on the shared writer. The gateway contract test also exercises manual entry, partial success, deleted entry IDs and percent-encoded source names with the upstream server absent.

## Yomitan character dictionary

The fixture has 5,000 reading-history rows and character entries with Japanese names, aliases, honorifics, portraits and spoilers. The comparison unpacks the dictionaries and checks each JSON member and image. Term banks use fast DEFLATE and share one serialized definition across each character's terms. The Rust archive was 652,066 bytes, compared with 358,044 bytes from Flask. At the default compression level the Rust handler took 1,113 ms. Lower compression reduced that time to 696 ms.

| Operation | Handler | Wall time | CPU | Peak working set |
| --- | --- | ---: | ---: | ---: |
| Update index | Flask | 1.27 ms | 1.56 ms | 74.5 MiB |
| Update index | Rust debug | 1.86 ms | 1.56 ms | 10.6 MiB |
| Generate archive | Flask | 473 ms | 469 ms | 138.7 MiB |
| Generate archive | Rust debug | 696 ms | 688 ms | 15.6 MiB |

## OCR model settings

The workers use the same local graphs and isolated selection files. Status reads return the model shown in Settings. A selection opens the real inference session and validates the graph before saving the new size. Timings exclude downloads and OCR of a screen capture.

| Operation | Handler | Wall time | CPU | Peak working set |
| --- | --- | ---: | ---: | ---: |
| Meiki status | Python | 2.29 ms | 2.23 ms | 36.6 MiB |
| Meiki status | Rust debug | 0.065 ms | 0.063 ms | 12.6 MiB |
| Select small Meiki detector | Python | 387 ms | 349 ms | 117.2 MiB |
| Select small Meiki detector | Rust debug | 678 ms | 672 ms | 63.4 MiB |
| VOCR status | Python | 14.65 ms | 14.06 ms | 59.5 MiB |
| VOCR status | Rust debug | 1.01 ms | 1.04 ms | 13.5 MiB |
| Select small VOCR recognizer | Python | 164 ms | 161 ms | 88.0 MiB |
| Select small VOCR recognizer | Rust debug | 185 ms | 177 ms | 47.7 MiB |

The VOCR fixture started with Large selected and an old C runtime marker. Both settings handlers reported ONNX and the same three installed sizes. Rust reuses a successful status checksum while the file path, length and modification time match. Inference validates the bytes it passes to ONNX Runtime on each session load. A separate isolated desktop smoke test checked the Large-to-Small change across the settings command and HTTP gateway with Python absent from the profile.

## Startup work

The reference loads the former folder scan and redirect listener definitions from commit `4fea8c90c9448e603370e831c67b37b9154f178a`. The fixture contains 384 word directories, each with one file that the reference visits and leaves in place. The listener binds to an ephemeral loopback port. Startup measurements begin after importing the GSM module.

| Operation | Previous wall time | Previous CPU | Current wall time | Current CPU |
| --- | ---: | ---: | ---: | ---: |
| Construct GSM application and initialize compatibility media imports | 252.6 ms | 234.4 ms | 0.047 ms | 0 ms |
| Scan the Anki output fixture | 130.9 ms | 140.6 ms | — | — |
| Start the old-port listener | 0.80 ms | 0 ms | — | — |

The listener also held one server thread and one socket for the lifetime of the reference process. Overall process peak working set was 81.0 MiB in both startup samples. The remaining Flask services can load media modules later. These are startup-stage measurements and do not establish a total application memory saving.

## Reproduction

Run in PowerShell from the repository root. The Cargo overrides disable the desktop manifest's per-dependency optimizations.

```powershell
$overrides = Select-String src-tauri/Cargo.toml -Pattern '^\[profile\.dev\.package\.(.+)\]$' | ForEach-Object {
    '--config'
    'profile.test.package.' + $_.Matches[0].Groups[1].Value + '.opt-level=0'
}
cargo test --offline --locked --manifest-path src-tauri/Cargo.toml @overrides --no-run
$debug = 'src-tauri/target/native-dev/debug'
rustc --edition=2021 scripts/fixtures/speech_helper.rs -o "$debug/gsm-speech-fixture.exe"
# Use the test executable path printed by cargo test --no-run.
.venv/Scripts/python.exe -m scripts.benchmark_speech_pipe --helper "$debug/gsm-speech-fixture.exe" --desktop-test "$debug/deps/<test-executable>.exe"
cargo build --offline --locked --manifest-path native/gsm-web/Cargo.toml --example report_benchmark
.venv/Scripts/python.exe scripts/benchmark_stats_web.py --exe "$debug/examples/report_benchmark.exe" --only import-stats-500 --rounds 5 --rows 0
.venv/Scripts/python.exe scripts/benchmark_stats_web.py --exe "$debug/examples/report_benchmark.exe" --only /api/yomitan-index --only '/api/yomitan-dict?spoiler_level=1' --rounds 5 --rows 5000
.venv/Scripts/python.exe scripts/benchmark_meiki_settings.py --desktop-test "$debug/deps/<test-executable>.exe" --small-model "<pinned small Meiki ONNX file>"
.venv/Scripts/python.exe scripts/benchmark_meiki_settings.py --desktop-test "$debug/deps/<test-executable>.exe" --engine vocr
.venv/Scripts/python.exe -m scripts.benchmark_retired_startup
```
