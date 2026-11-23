# Longplay subtitles, Anki Beacon and saved clips

Windows 11, release Rust workers, five alternating rounds per workload. Wall time and process CPU are median milliseconds per recording, event batch or library operation. Memory is the median of the workers' lifetime peak working sets, including imports and fixtures. The measurements cover these components in isolation. The OBS encoder, Anki application and desktop WebView run outside the measured workers.

| Workload | Python wall / CPU (ms) | Rust wall / CPU (ms) | Python / Rust peak MiB |
| --- | ---: | ---: | ---: |
| 64 subtitles, recording path known | 26.14 / 26.17 | 0.93 / 1.17 | 37.23 / 10.00 |
| 2,500 subtitles, path known | 1,022.38 / 1,000.00 | 7.55 / 5.21 | 38.66 / 9.92 |
| 2,500 subtitles, path supplied at stop | 1,000.05 / 989.58 | 26.00 / 10.42 | 38.29 / 9.94 |
| 256 Beacon notes, one duplicate each and a heartbeat | 2.25 / 2.34 | 0.31 / 0.26 | 58.08 / 9.45 |
| List 32 saved clips | 11.43 / 11.46 | 5.72 / 6.25 | 65.63 / 9.37 |
| List 512 saved clips | 191.67 / 192.71 | 91.46 / 88.54 | 78.83 / 11.03 |
| Resolve 512 clip folders and two invalid IDs | 26.55 / 26.04 | 62.34 / 62.50 | 64.62 / 9.09 |

The native subtitle worker holds the file open and writes each numbered UTF-8 cue in one operation. Only the pending line and a reusable formatting buffer survive between cues. If OBS supplies a path late, the writer moves the temporary subtitles before finalization, including across volumes. The benchmark compares every completed cue. Python repeats the penultimate line on stop. Rust writes the last observed line and prevents a subsecond clip from ending before it starts.

The Beacon benchmark parses the same JSON strings in both processes and drains the accepted messages. The receiver reserves queue capacity before acknowledging an event. The desktop smoke test also posts events over HTTP, forces an unsuccessful AnkiConnect lookup, accepts the redelivery, then checks deduplication after the note has disappeared. Complete Beacon payloads avoid that AnkiConnect call.

Clip listing reads one saved manifest at a time. Fixtures contain five dialogue lines per clip and include missing videos. Both implementations returned identical ordered IDs, selected text and sizes. For folder actions Rust resolves the library root once per batch and checks each real folder against its expected path before passing it to the shell. Repeating root resolution for every item took 106.59 ms for 512 folders in the initial Rust run. The remaining filesystem checks account for a slower batch than Python's lexical join. The folder benchmark excludes the operating system's file manager and trash operation.

### Saving a clip

On a new 16-second replay with one video stream and two audio tracks, the Python writer took 244.65 ms per save and Rust took 264.14 ms. Total process-tree CPU including FFmpeg and FFprobe was 296.88 ms and 312.50 ms respectively. Peak committed memory across each tree was 61.35 MiB and 37.09 MiB. The writers themselves had peak working sets of 49.32 MiB and 9.85 MiB. Each of the five alternating rounds saved two clips from distinct replay paths.

Both used the same FFmpeg 8.1.1 binaries and preserved every stream. The fixture compared each packet's SHA-256, presentation time and duration, all manifest fields, pause ranges and the video modification time. Rust stages the media and publishes the manifest last so an incomplete copy stays out of the library. The separate desktop smoke test submits five dialogue lines, requests a clip over HTTP, waits for the saved library entry, and verifies that a second request causes no additional OBS save.

Run from the repository root on Windows.

```powershell
cargo build --locked --release --manifest-path native/gsm-mining/Cargo.toml --examples
.venv/Scripts/python.exe scripts/benchmark_recording.py --output recording.json
.venv/Scripts/python.exe scripts/benchmark_clip_library.py --output clip-library.json
node scripts/build-native-dev.mjs --release
node scripts/test-native-desktop.mjs longplay
.venv/Scripts/python.exe scripts/benchmark_clip_capture.py --desktop --output clip-capture.json
```

Individual samples and worker hashes are available in the [recording results](recording-2026-11-21.json), [clip library results](clip-library-2026-11-21.json) and [clip capture results](clip-capture-2026-11-21.json).
## Text Feed media playback and video export

The release Rust worker exported a two-second MP4 with the same 111 encoded packets, stream timestamps and packet data as the Python worker. Rust took 20 ms longer on this recording and used 47 MiB less peak process-tree commit. A 44.1 kHz audio export produced identical PCM samples. Combining duration, codec and channel discovery into one FFprobe invocation reduced median Rust audio extraction from 378 ms to 277 ms across the two benchmark runs.

| Operation | Python wall ms | Rust wall ms | Python process-tree CPU ms | Rust process-tree CPU ms | Python peak tree commit MiB | Rust peak tree commit MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Trim and publish an MP4 | 119.98 | 140.30 | 179.69 | 164.06 | 103.13 | 55.88 |
| Extract playable audio | 300.14 | 276.81 | 343.75 | 351.56 | 80.78 | 37.97 |

Each worker processed two requests per round across five alternating rounds using FFmpeg 8.1.1 on Windows. Each request used a fresh input path. The MP4 fixture had 16 seconds of video and two AAC tracks. The audio fixture contained one AAC track and a recorded pause interval. The audio comparison checked all 88,201 decoded samples. Windows job counters include the benchmark worker and FFmpeg processes. A separate desktop check exercises live and saved video export, replay reuse, audio on a two-soundtrack input, byte ranges, HEAD and expiry of old playback URLs.

Build `clip_capture_benchmark` in release mode, then run `.venv/Scripts/python.exe scripts/benchmark_clip_capture.py` with `--trim` or `--audio`. Add `--desktop` to the multi-track run for the isolated OBS and Text Feed checks. [Video samples](video-trim-2026-11-21.json) · [Audio samples](reader-audio-2026-11-21.json) · [Audio samples with separate probes](reader-audio-separate-probes-2026-11-21.json)

### Screenshot selection

Both workers probed a 16-second recording, decoded 25 half-second previews with a single seek, then exported the frames at 6.125 and 1.125 seconds in that order. All 25 PNGs and both JPEGs matched byte for byte. At a preview width of 160 pixels the Qt worker took 203.43 ms and the Rust worker took 238.43 ms. Process-tree CPU was 273.44 and 328.13 ms respectively. Peak process-tree commit fell from 90.45 to 37.57 MiB. These measurements cover frame preparation and export. They exclude window rendering and user selection time. Run the harness with `--frames`. [Raw samples and image digest](screenshot-selector-2026-11-21.json)

### Multi-line media folders

With screenshots disabled, exporting a folder for two lines took 410.99 ms in Python and 401.68 ms in Rust. The sentence text, decoded audio samples, and MP4 stream timestamps and packet data matched. Process-tree CPU fell from 539.06 to 445.31 ms and peak process-tree commit from 105.34 to 57.14 MiB. Both workers used the line after the selection as the audio cutoff and the line after the first sentence as the video cutoff. Run the harness with `--folder`. [Raw samples and media digest](reader-media-folder-2026-11-21.json)
