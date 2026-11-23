# Desktop text intake

Measured November 20, 2026 on Windows 11, AMD Ryzen 7 5800X, Python 3.13.2 and Rust 1.97.0. Times are medians of three alternating Python and Rust runs. Both paths use the same desktop release binary. The Python baseline uses the installed native correlation and journal extensions, as the previous desktop did.

## Source to reader

The benchmark starts an isolated desktop and backend for each sample. It measures from the producer through receipt of an ordered append by a Python consumer, including the desktop preview and receipt logging. Both paths use their production console and file logger. The reader collects the results in memory. Database writes, overlay scans, audio capture and rendering a reader window are outside the measurement. Each case sends 512 distinct lines. Every run verifies all 2,561 lines against the final snapshot, including order and text. After timing, each Rust run also checks every native receipt in the desktop log and submits a speech correction twice. The log must contain one append and one revision for that speech line. The fixture leaves clipboard copying disabled.

| Input | Previous wall time per line | Rust wall time per line | Previous CPU per line | Rust CPU per line |
| --- | ---: | ---: | ---: | ---: |
| Loopback WebSocket, one at a time | 6.020 ms | 0.453 ms | 3.296 ms | 1.251 ms |
| Loopback WebSocket, burst | 5.914 ms | 0.120 ms | 2.991 ms | 0.763 ms |
| Synchronous Python producer | 5.614 ms | 0.766 ms | 1.892 ms | 1.770 ms |
| Asynchronous Python producer | 5.934 ms | 1.067 ms | 2.106 ms | 2.075 ms |

The old producer checked whether projection had finished in 5 ms intervals. Publishing a receipt and desktop preview often kept the queue busy long enough to incur a wait. Rust publishes the preview directly, signals the consumer and returns up to 32 ordered events together. The 95th-percentile latency for individual WebSocket lines fell from 6.343 ms to 0.546 ms.

Wall time ends when the reader receives the last line. CPU includes draining the file logger after each workload. Including the wait for the final receipt on disk, the burst took **5.918 ms per line in Python** and **0.416 ms in Rust**.

A control disabled receipt logging and preview publication in the legacy Python consumer. This brought its synchronous producer down to **0.311 ms per line**. Rust still produced both outputs and took **0.749 ms**. Python-originated observations cross the desktop transport and their accepted events cross back to the Python consumer.

Combined private memory of the desktop and backend measured **53.82 → 58.90 MiB** over the Python run and **54.19 → 60.15 MiB** over the Rust run. The two-second idle sample measured **0.00 ms of CPU per second** for Python and **7.81 ms** for Rust. Windows process CPU counters are coarse over intervals this short. These figures cover the two measured processes and the fixture workload. [Desktop samples and binary fingerprints](intake-sources-2026-11-20.json)

## Stream processing

Each worker replays 216 timed observations 48 times per sample. A separate verification pass compares every receipt and ordered event, including text, line sequence, revision, stats disposition and contributing observation IDs. The traces exercise OCR approximations, duplicate inputs, speech corrections, scene changes and fast-forwarding. Both workers advance speech deadlines on the trace clock. Filtering is disabled for the shared post-filter trace.

| Replay | Previous wall time per input | Rust wall time per input | Previous CPU per input | Rust CPU per input |
| --- | ---: | ---: | ---: | ---: |
| Mixed sources | 18.94 µs | 3.11 µs | 18.08 µs | 3.01 µs |
| Long mixed-source lines | 46.67 µs | 41.29 µs | 43.70 µs | 42.20 µs |
| Overlapping fast-forward text | 26.04 µs | 10.05 µs | 25.62 µs | 9.04 µs |

The native stream owns one journal. Events share immutable record revisions. Peak private memory for the isolated mixed-source worker measured 18.23 MiB for Python and 1.02 MiB for Rust, including each language runtime. The desktop measurements above show the effect when the Python consumers remain loaded.

Two additional measurements isolate implementation decisions.

- Reusing a profile's compiled filters took **0.91 µs** per line versus **55.49 µs** with fresh compilation. Each sample checked 2,048 outputs from one regex and one literal replacement. The stream reuses compiled rules until the processing configuration or target language changes.
- A posted Windows clipboard change reached the waiting consumer in **12.1 µs** at the median in Rust versus **71.9 µs** in Python. The corresponding 95th percentiles were **40.4 µs** and **204.5 µs**. Each sample posted 1,024 notifications to the real message pumps. Windows denied creation of a private clipboard for this run, so collection of actual clipboard text, ownership contention and the non-Windows polling fallback were unmeasured. [Replay, filter and notification samples](intake-stream-2026-11-20.json)

## Ownership and delivery

The desktop receives clipboard changes, incoming text from configured WebSocket connections, hook observations and OCR worker results. Python-based producers such as the speech recognizer submit observations to the same Rust stream. Rust owns filtering, duplicate detection, speech deadlines, skip detection, revisions, retention and snapshots. The OCR and hook coordinators update clipboard availability directly. The desktop writes accepted lines and speech revisions to the terminal under `[rust:text-intake]` and makes requested clipboard copies from an ordered, bounded worker. A full worker queue backpressures the producer before the stream accepts a line. The status API exposes the native accepted-line count separately from the number of events delivered to Python. This benchmark stopped at the projection callback. The subsequent [reader migration and end-to-end measurements](reader-projection-2026-11-20.md) cover native reader and overlay delivery, durable history, live stats, Discord and mining context. The standalone Python launcher and older desktops retain their compatibility path.

The desktop retains unacknowledged events across a transport reconnect within the same backend session. A full projection queue applies backpressure. Hook retries keep their observation ID and place in line. Snapshot transfers preserve the original revision even when the encoded reply exceeds the transport frame limit. Regression tests exercise cursor replay, late speech, profile changes and oversized reads.

## Reproduce on Windows

From the repository root with its Python environment and native extension installed, run the following commands.

```powershell
node scripts/build-native-dev.mjs
cargo build --locked --release --examples --manifest-path native/gsm-intake/Cargo.toml
.\.venv\Scripts\python.exe -m scripts.benchmark_intake_stream --binary src-tauri/target/native-dev/release/examples/replay.exe --clipboard-binary src-tauri/target/native-dev/release/examples/clipboard_notify.exe --output docs/benchmarks/intake-stream-2026-11-20.json
.\.venv\Scripts\python.exe scripts/benchmark_mining_history.py --case dialogue-intake-sources --rounds 3 --output docs/benchmarks/intake-sources-2026-11-20.json
```
