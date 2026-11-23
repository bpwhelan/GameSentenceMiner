# Desktop profile recovery, backup and job registration

On a 50,000-line Windows profile, registering eight jobs and the Tadoku export cursor took 0.79 ms in Rust and 7.13 ms in Python. Checking the same jobs on a subsequent open took 0.040 ms and 0.331 ms respectively. The Rust implementation uses one SQLite transaction and leaves existing, correctly configured rows untouched.

Raw snapshot creation took 2.54 ms longer in the Rust worker. Daily gzip creation and one-time relocation differed by less than 0.1 ms at the median. Python already called a release-built Rust extension for raw and compressed snapshots. Moving ownership to the desktop allows the backup endpoint and Settings export to work before a Python backend starts. The release smoke test exercised the endpoint and restored its output with Python unavailable.

## Measurements

Medians over nine alternating rounds on an AMD Ryzen 7 5800X running Windows 11 build 26300, with CPython 3.13.2 and rustc 1.97.0. Wall and CPU are milliseconds per operation. RAM is each long-lived worker's peak working set in MiB through that workload, including its runtime and imported modules. Whole-desktop memory and launch time require a separate measurement.

| Operation | Calls per round | Python wall | Rust wall | Python CPU | Rust CPU | Python RAM | Rust RAM |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Recover pending relocation | 1 | 56.155 | 56.067 | 46.875 | 46.875 | 62.46 | 14.88 |
| Check an already repaired profile | 100 | 0.184 | 0.066 | 0.156 | 0.000 | 62.48 | 14.89 |
| Create a manual SQLite backup | 1 | 47.272 | 49.815 | 46.875 | 46.875 | 64.78 | 14.91 |
| Create today's gzip backup | 1 | 71.791 | 71.804 | 78.125 | 78.125 | 65.14 | 15.00 |
| Check an existing daily backup and apply retention | 25 | 1.109 | 0.814 | 1.250 | 0.625 | 65.17 | 15.00 |
| Register jobs and cursor on first open | 1 | 7.127 | 0.792 | 0.000 | 0.000 | 65.73 | 15.00 |
| Check existing jobs and cursor | 50 | 0.331 | 0.040 | 0.313 | 0.000 | 65.73 | 15.00 |

The driver samples the Windows user and system CPU counters across each batch. A zero median means the operation fell below the counter resolution in at least half the rounds. Both workers recorded the same median CPU for all three full-file operations. Individual samples, binary hashes and the input digest are in the [raw results](profile-files-2026-11-21.json).

## Fixture and checks

Each worker receives a separate SQLite database with the same Japanese text. The driver keeps the source connection open with WAL auto-checkpointing disabled. After each produced snapshot, the driver decompresses gzip where applicable, runs SQLite `quick_check`, and verifies a SHA-256 digest of every ordered row ID and line. It also verifies the archived destination bytes and cleared pointer after each relocation. For job registration, the driver compares all eight names, descriptions, schedules, enabled states and deadlines, and checks the export cursor. These checks run outside the timed section.

The manual backup case measures Python's public database backup method and Rust's profile-file operation on an idle writer. It excludes HTTP transport, desktop dispatch and ZIP packaging. The Python relocation case uses the original Python online backup implementation. For daily and manual backups the driver explicitly loads the extension containing both native snapshot functions. Optional vocabulary setup and job execution are outside the job-registration timing.

## Reproduce on Windows

Run from the repository root. The extension in the recorded run was an existing release build. If the extension is missing, the first command builds it from the checked-out source. The driver stores the hashes of the actual binaries it uses.

```powershell
cargo build --locked --release --manifest-path native/gsm-native/Cargo.toml
cargo build --locked --release --manifest-path native/gsm-db/Cargo.toml --example profile_files
.venv/Scripts/python.exe scripts/benchmark_profile_files.py --rounds 9 --rows 50000 --python-extension src-tauri/target/native-dev/release/_native.dll --output docs/benchmarks/profile-files-2026-11-21.json
```

The desktop checks use disposable profiles and an isolated application root. One checks the daily backup from before an upgrade and the manual backup from afterward. The recovery case checks that Settings responds with a corrupt database, supplies a replacement, then calls the same native backup endpoint.

```powershell
node scripts/build-native-dev.mjs --release
node scripts/test-native-desktop.mjs database database-recovery workspace
```
