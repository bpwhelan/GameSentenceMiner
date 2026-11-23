# OBS control and capture-window tracking

Measured November 20, 2026 on Windows 11 Education build 26300, a Ryzen 7 5800X (8 cores, 16 threads), and 31.9 GiB of usable RAM. The desktop binaries are optimized local builds. Python is 3.13.2 and Rust is 1.97.0. The raw results include the executable SHA-256 digests and the request counts for every run. [Raw results](obs-window-2026-11-20.json)

## Results

Values are medians of the three runs for each version. The latency rows use each run's median. The CPU and memory rows combine the desktop and Python worker.

| Measurement | Previous desktop | Rust ownership |
| --- | ---: | ---: |
| OBS control connections | 5 | 1 |
| Process threads | 53 | 45 |
| Idle CPU, ms/s | 10.94 | 9.37 |
| Unique resident memory, MiB | 72.73 | 71.43 |
| Window move to overlay monitor, ms | 1,009.44 | 108.42 |
| Positions seen during a 120-position drag | 3 | 47 |
| Drag CPU, ms/s | 41.96 | 71.26 |
| Cached replay-status read, µs | 3.19 | 0.96 |
| Uncached scene-list read, ms | 0.451 | 0.776 |
| 128 KiB screenshot transfer, ms | 21.34 | 1.46 |
| 7 MiB screenshot transfer, ms | 1,159.22 | 74.81 |

The slowest of the 24 individual window moves was 1,012 ms before and 114 ms after. During a continuous drag, the Rust path delivered 47 intermediate positions in every run, up from three. Drag CPU rose from 41.96 to 71.26 ms/s at the median. It ranged from 25.16 to 49.98 ms/s before and from 50.33 to 117.63 ms/s after. Idle CPU ranged from 6.25 to 17.97 ms/s before and from 3.91 to 16.41 ms/s after. Those overlapping ranges limit what three runs establish about idle CPU.

Each Rust run issued exactly the 200 full scene-list queries requested by the worker. The previous desktop issued 237 to 238 over its longer runs. The native switcher skips scene-list queries when the active collection has no usable switcher configuration. An explicit scene-list request from Python cost an additional 0.325 ms at the median. The 128 KiB screenshot took 14.6 times as long to transfer on the previous build, and the 7 MiB screenshot took 15.5 times as long.

## What the comparison measures

Each run starts a fresh desktop process and a Python worker with an isolated profile. Both connect through production transports to the same loopback OBS WebSocket v5 fixture. The worker creates a real Win32 window, starts the production session subscription and window monitor, and waits for GSM to identify the window by its OBS selector. The previous build also starts its Python OBS service, pool, event client, manager, and foreground hook. Its Python OBS and platform modules come from commit `4fea8c90`. The reference desktop executable is the release build staged before this migration.

Three paired rounds alternate the order of the builds. Each run includes a two-second warmup, 20 idle seconds, 2,000 replay-status reads, 200 uncached scene-list requests, eight individual moves, and a 120-position drag paced to 60 requests per second. Move latency ends when the Python overlay monitor observes the new left edge. The harness checks for receipt every 5 ms. The drag reports how many distinct positions that consumer saw while the moves were issued. Synchronous Win32 calls can extend the drag beyond its scheduled two seconds. Drag CPU uses the actual elapsed time. Every run also waits for the final position. The screenshot measurements transfer 20 synthetic 128 KiB image strings and four 7 MiB strings through the production screenshot request path.

CPU is the sum of user and kernel CPU time for the desktop and the Python worker, in milliseconds per wall-clock second. One fully occupied logical core would measure 1,000. Memory is the sum of the two processes' unique resident memory after the drag, before transferring the large images. Both include the fixture window's message pump. The separate OBS protocol server is excluded. Logging is muted in both Python workers. The fixture controls protocol timing and image size. Actual OBS encoding, GPU capture, decoded image processing, Magpie rendering, a live game, and an open overlay webview are outside these measurements.

## Implementation decisions

- **One desktop OBS control connection.** The native socket carries requests and output events. Python consumers share its published replay and session state. An explicit full scene-list read still goes to OBS so an editor can see live changes. Output mutations are serialized and issued once. The connection count, replay-status reads, and live scene queries measure different costs of this choice.
- **Window events with a timed fallback.** Win32 notifications use the desktop's existing message pump. Repeated position changes share a pending wake, with a 65 ms coalescing interval. A one-second reconciliation covers missed notifications and state without reliable events. The individual move and continuous-drag cases measure responsiveness, CPU, and how much intermediate work the coalescer drops. Display bounds are reused between topology checks.
- **A bounded path for large screenshots.** Ordinary replies fit in a single desktop message. A screenshot above 6 MiB is retained once and read in chunks up to 2 MiB to fit the existing 8 MiB frame limit. Completed transfers are released immediately. Four concurrent retained images and a 60-second expiry bound abandoned transfers. The two timed screenshot sizes exercise both paths. A separate 17 MiB single-frame check exercises the OBS-side frame limit. Both fragmented and unfragmented OBS messages are capped at 64 MiB.
- **Separate control from media consumption.** Rust applies profile settings, manages output transitions, and publishes the recording directory. The existing Python subtitle writer consumes ordered recording events. Process muting and pausing remain Python consumers of the target identity and window state. OCR and preview helpers use a separate read-only desktop identity. Window input checks both the captured handle and its owning PID immediately before acting. The five-minute background grace, replay-duration grace, and output-stop verification are behavior and correctness constraints.

The connection count covers desktop control in the measured workload. Native OCR can also open a Rust media-capture connection when it reads frames from OBS. A standalone Python installation without the desktop runtime retains the existing OBS and platform services.

## Concurrent requests on one connection

One Rust task reads the OBS socket. Each outstanding call has its own reply channel and a connection-local request ID. The receiver checks the echoed ID and operation before delivering a response. Its pending table is local to that socket, and ordinary replies need no shared replay lock. A duplicate or late reply cannot claim a later call. [OBS request/response protocol](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md#requestresponse-opcode-7)

The verification workload starts 32 requests from the mining backend and 32 from the OCR reader. The simulated OBS server waits for all 64 on the same socket and replies in reverse order. Three operations repeat throughout the batch. Every seventh call returns a uniquely labeled error. The server also injects eight duplicate replies and eight unsolicited events per batch. Both clients check the exact payload or error for every call. A separate check has two Python callers concurrently retrieve different 7 MiB screenshots through the shared client and verifies every byte of each reassembled image.

Three paired release runs each issued 16 batches. All 3,072 calls on the updated build received the expected result, including 441 intentionally distinct errors. The reported times cover a full batch of 64, from submitting the first group to completing both groups in Python. They include the loopback transport and simulated server. The two builds' timings overlapped.

| Time per 64 requests | Run 1 median | Run 2 median | Run 3 median | Median of runs |
| --- | ---: | ---: | ---: | ---: |
| Previous single-connection build | 8.218 ms | 8.452 ms | 8.154 ms | 8.218 ms |
| With operation validation | 8.330 ms | 8.541 ms | 8.153 ms | 8.330 ms |

Replay saves require special handling because OBS sends the file path in an event without a request ID. GSM permits one of its own saves at a time and keeps track of an expired save while its completion can still arrive. The regression tests cover the file arriving before or after the acknowledgement, duplicate acknowledgements, and a late file while another caller requests recording status. A save initiated directly in OBS while GSM is saving can still produce an indistinguishable file event. [OBS replay-saved event](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md#replaybuffersaved)

## Reproduction

From the repository root on Windows, use the two staged release executables and the repository's Python environment.

```powershell
$before = 'src-tauri/target/desktop-runs/win32-x64-97afea115fb6d81f9d6b/gsm-desktop.exe'
$after = 'src-tauri/target/desktop-runs/win32-x64-8cde5a307e86cb2eda8f/gsm-desktop.exe'
.venv/Scripts/python scripts/benchmark_obs_window.py --before $before --after $after --reference 4fea8c90 --rounds 3 --idle 20 --moves 8 --output docs/benchmarks/obs-window-2026-11-20.json
$current = 'src-tauri/target/desktop-runs/win32-x64-f24af71c1b35899b778a/gsm-desktop.exe'
foreach ($binary in @($after, $current, $current, $after, $after, $current)) {
    .venv/Scripts/python scripts/benchmark_obs_window.py --mode after --after $binary --rounds 1 --idle 1 --moves 2 --verify
    if ($LASTEXITCODE -ne 0) { throw 'OBS verification failed' }
}
```

The separate verification run exercises externally triggered replay transitions, recording rollover, large-image assembly, window-owner checks, read-only OCR access, disconnect and reconnect, profile changes while replay/recording/streaming are running, and recovery from an unwritable recording directory. The Windows path tests cover drive letters, Unicode names, and network shares. Its extra connections and mutations are excluded from the performance results. [Benchmark and verification harness](../../scripts/benchmark_obs_window.py)
