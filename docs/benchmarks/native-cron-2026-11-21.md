# Desktop scheduling and Anki sync

The Rust desktop can run scheduled statistics and Anki collection sync as soon as the active database is ready. In five alternating pairs on Windows 11, a full collection sync finished 88 ms sooner and used 7.4 MiB less private memory. The ten-day statistics job finished 1.2 ms sooner and used 1.3 MiB more private memory.

| Scheduled job | Wall time, Python → Rust | Process CPU, Python → Rust | Settled private memory, Python → Rust |
| --- | ---: | ---: | ---: |
| Rebuild ten days of statistics | 35.51 → 34.31 ms | 31.25 → 15.63 ms | 54.35 → 55.66 MiB |
| Sync 1,200 notes, 2,400 cards and 14,400 reviews | 344.46 → 256.58 ms | 281.25 → 156.25 ms | 62.82 → 55.38 MiB |

Both sides ran an optimized desktop and an authenticated Python test process. The baseline scheduler called the existing Rust database or collection worker through Python. The new scheduler called the same worker directly. Timing began at scheduler startup and ended when the observer saw the job's completion in SQLite. CPU and memory include both processes. The local AnkiConnect fixture ran outside the measured pair. Private memory was sampled after completion. The Windows CPU clock advances in 15.625 ms ticks, so the short rollup's one-tick difference needs that context. [Individual samples, executable hash and result digests](native-cron-2026-11-21.json)

The harness checked the database contents on every pair, including daily and per-game rollups, Anki fields, tags, review times, word membership and kanji links. The release desktop separately ran against an old test profile without a Python installation. That check verified scheduled game linking and statistics, queried a configured mock AnkiConnect address with an empty cache, requested a second sync and read the resulting note, card and review from a verified backup. The manual sync preserved the next scheduled run.

Run the paired jobs with `.venv/Scripts/python.exe scripts/benchmark_mining_history.py --case cron-rollup cron-anki-sync --rounds 5`. Run the Python-free release checks with `node scripts/test-native-desktop.mjs database vocabulary database-recovery`.
