# Desktop dialogue delivery and mining context

On the managed desktop, Rust delivers accepted dialogue to TextFeed and the overlay, maintains selection and live session statistics, commits eligible lines to SQLite, and updates Discord presence. Card mining reads the same Rust session directly. The standalone Python launcher retains its reader. Optional longplay subtitles, goals, non-dialogue overlay controls and the legacy reader input queue can still use the backend.

## Release measurements

Each column is the median of 3 independent Windows runs. Each run used a fresh temporary profile, one warm-up line, and 160 distinct lines in each of four workloads. Every configuration produced the same 641 ordered reader texts, database rows and final character total. With the backend attached, the native runs delivered zero ordinary projection events to Python.

| Workload | Previous Python projection | Rust with Python backend | Rust without Python backend |
| --- | ---: | ---: | ---: |
| One v2 reader, p95 source-to-reader latency (ms) | 1.729 | 0.433 | 0.335 |
| Burst, reader delivery (ms/line) | 0.950 | 0.160 | 0.134 |
| Burst, through SQLite commit (ms/line) | 1.631 | 0.224 | 0.198 |
| Burst, process CPU through commit (ms/line) | 2.441 | 0.293 | 0.391 |
| Five simultaneous readers, p95 delivery to all five (ms) | 2.446 | 0.649 | 0.615 |
| Five simultaneous readers, process CPU through commit (ms/line) | 4.297 | 1.172 | 0.977 |
| Reader plus overlay stats, p95 delivery to both (ms) | 2.567 | 0.511 | 0.424 |
| Short idle sample, process CPU (ms/second) | 62.5 | 15.6 | 7.8 |
| Unique resident memory before the workloads (MiB) | 75.4 | 57.0 | 7.9 |
| Unique resident memory after the workloads (MiB) | 87.0 | 64.0 | 11.3 |

The first two columns include the desktop, the same Python compatibility worker and their child processes. The third runs the desktop alone after database setup. The driver, source socket and reader clients run outside the measured process tree. Unique resident memory counts private resident pages. These figures describe the fixture, which omits WebView rendering, game capture, network AI and live Anki media work. Idle CPU comes from a two-second sample and has coarser resolution than the per-line timings.

The previous release receives observations in Rust, crosses the backend bus, and serves the real Python reader WebSocket. The new release serves the public Rust socket. All runs send identical Japanese dialogue over a configured loopback WebSocket and check the immutable v2 snapshot and SQLite row order. The five-reader workload uses two v2, two legacy TextFeed and one plaintext connection. SQLite polling at 10 ms intervals sets the resolution of the final commit observation. Run order rotates between rounds. All reported runs use an isolated OBS endpoint and reject any scene transition.

## Component measurements

| Timed work (median) | Python | Rust |
| --- | ---: | ---: |
| Prepare mining context from 1,024 active lines, including an older selection and its neighbors | 1.014 ms | 0.075 ms |
| Refresh an established Discord activity deadline for the same scene | 1.667 µs | 0.032 µs |

Both measurements use 300 samples. The context fixture returns 259 candidates and one checked line. Python timing includes its previous line serializer and JSON encoding. The timer stops before JSON decoding and excludes IPC latency. The encoded sample occupies 125,431 bytes. Rust times the production selection-consuming method through construction of the typed mining context. Its broker payload size is zero. The Discord fixture measures groups of 128 activity updates with an established session. Python refreshes its scheduler directly, excluding the background submission hop. Rust refreshes the existing worker deadline. Discord network latency and the external client are outside both measurements. The Rust component harness uses Cargo’s release profile.

## Implementation and verification

- The reader indexes session lines by ID and retains compact display and mining fields after replay expiry. OCR metadata follows the shorter journal lifetime. Mining takes the latest 256 active rows plus active neighbors of selected rows, and copies checked rows separately. Tests cover an expired selection, selection aging, and a speech correction retaining identity and neighbors.
- Each socket protocol shares a serialized frame among its subscribers. A lagging reader has a bounded backlog and can reconnect for a snapshot. The snapshot and subscription share a sequence boundary. Tests exercise independent fast and slow clients. A native-only fixture also negotiates the direct socket, selects a line over HTTP and receives live overlay stats.
- A dedicated FIFO worker groups up to 64 adjacent captures into one transaction on the existing history writer. Flushing orders database close and card updates after accepted writes. A locked-database test holds a competing write transaction while delivering another line, releases it, and verifies that SQLite contains the line exactly once. The desktop relies on the existing profile schema initializer for new or legacy databases. Pending captures wait for that schema. They become durable at commit. Graceful shutdown reports a timeout if the database stays unavailable. The throughput measurements exercise the production batch and queue settings together.
- Discord shares the live-session statistics and rate-limits local IPC independently of intake. A duplex mock checks the handshake and ping response. Regression tests also cover the scene blacklist, explicit reading breaks, revised character credits and idle expiry. The fixture leaves live Discord and Anki accounts untouched.

## Reproduction on Windows

Run from the repository root. Supply the previous release executable for the baseline. The raw report records both executable hashes. Choose the optimized test executable printed by Cargo for the component measurements.

```powershell
node scripts/build-native-dev.mjs --release
cargo test --locked --release --features local-build --manifest-path src-tauri/Cargo.toml text_intake:: -- --test-threads=1
$desktop = (Get-Content src-tauri/target/desktop-runs/win32-x64.json | ConvertFrom-Json).executable
$previous = "src-tauri/target/desktop-runs/win32-x64-574aaa84c614bcdbb06b/gsm-desktop.exe"
$tests = "src-tauri/target/native-dev/release/deps/gsm_desktop-902443c50e559f62.exe"
.\.venv\Scripts\python.exe scripts/benchmark_reader_projection.py --old-desktop $previous --desktop $desktop --native-tests $tests --count 160 --rounds 3 --output docs/benchmarks/reader-projection-2026-11-20.json
```

Individual samples, artifact hashes and host details are in the [raw results](reader-projection-2026-11-20.json).
