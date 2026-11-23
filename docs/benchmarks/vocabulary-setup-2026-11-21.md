# Vocabulary startup and personal Yomitan dictionaries

The first import of the shipped dictionary took 1.06 seconds in Rust and 3.38 seconds in Python. Updating a partially changed dictionary took 0.73 seconds and 6.37 seconds respectively. The ordered word/rank pairs matched across both implementations in all five rounds.

## Bundled dictionary and vocabulary setup

| Workload | Calls per round | Wall ms, Python → Rust | CPU ms, Python → Rust | Peak MiB, Python → Rust |
| --- | ---: | ---: | ---: | ---: |
| Enable tables and jobs | 1 | 17.380 → 4.263 | 0.000 → 0.000 | 41.66 → 6.00 |
| Recheck enabled schema and jobs | 40 | 1.133 → 0.067 | 1.172 → 0.000 | 42.21 → 6.01 |
| Import all shipped ranks | 1 | 3,378.252 → 1,057.412 | 3,328.125 → 1,000.000 | 199.50 → 46.00 |
| Reopen with an uncached manifest | 1 | 3.436 → 0.324 | 15.625 → 0.000 | 199.50 → 46.00 |
| Check an unchanged dictionary | 25 | 1.023 → 0.252 | 0.625 → 0.625 | 199.50 → 46.00 |
| Upgrade a partly changed dictionary | 1 | 6,369.175 → 729.843 | 6,343.750 → 671.875 | 199.89 → 46.33 |
| Disable tables and jobs | 1 | 59.785 → 39.764 | 46.875 → 31.250 | 199.89 → 46.33 |

The setup benchmark uses the complete 424,746-entry Jiten dictionary shipped with GSM. Each pair starts with two identical disposable WAL profiles. The Python worker uses the release native extension for schema changes, the existing Python job registration functions, and the Python frequency importer. The Rust worker uses the desktop's database implementation. A fresh pair of workers starts every round, and the driver alternates execution order.

The upgrade fixture renames words whose rank is divisible by 97 and changes ranks divisible by 20 before asking each importer to install the shipped version. The Rust importer sorts by word and compares against the existing SQLite primary-key index. Only additions, removals and changed ranks need database writes. A regression test puts aborting triggers on unchanged rows to check that upgrades preserve them.

After each workload the driver runs SQLite integrity checks and compares database contents. The frequency checks cover the source metadata, a SHA-256 digest of all ordered word/rank pairs, two cached ranks and an unranked word. The job checks cover both schedules and enabled states. Separate tests cover duplicate words, a replacement with no usable rows, changes to the default source, rollback after a failed write and a refresh that reaches the writer after the feature was disabled.

## Personal frequency export

| Workload | Calls per round | Wall ms, Python → Rust | CPU ms, Python → Rust | Peak MiB, Python → Rust |
| --- | ---: | ---: | ---: | ---: |
| 100 live words | 80 | 0.478 → 0.405 | 0.391 → 0.391 | 48.30 → 6.74 |
| 25,000 live words | 3 | 52.697 → 31.985 | 52.083 → 31.250 | 63.18 → 11.09 |
| 25,000 words with archived occurrences | 3 | 61.531 → 38.100 | 57.292 → 36.458 | 64.40 → 11.46 |

The 100-word export used 0.391 ms of CPU in both workers. On 25,000 live words the native ZIP was 112,006 bytes and the Python ZIP was 123,626 bytes. With archived occurrences those sizes were 118,818 and 121,445 bytes.

The export benchmark starts from live word occurrences with and without readings. Three quarters of the words occur once and one quarter occur twice. In the archived fixture, every fifth word also has three archived occurrences. The Rust and Python workers generate an in-memory Yomitan ZIP from the same database. Rust serializes one bank at a time, with up to 10,000 entries in each. Both implementations compress the complete export.

Each worker warms up once per fixture. The driver verifies the ZIP checksums, manifest fields, revision timestamp, bank boundaries and a digest of every ordered entry before the repeated measurements. This includes words tied on frequency. The release desktop smoke test separately downloads the index and ZIP over HTTP, checks the update URL and headers, and reads the exported occurrence count from inside the archive.

## Measurement scope

Wall and process CPU are milliseconds per call. RAM is the Windows worker's peak working set in MiB through that workload. CPU includes the worker's request handling. Windows CPU counters can round short calls down to zero. Timed work excludes interpreter startup, HTTP transport, fixture creation and content verification. For setup the wall clock starts after opening the worker's database connection. For export the clock includes the database query, JSON serialization and ZIP compression. Each table reports the median of five paired rounds on a Ryzen 7 5800X using Windows 11 build 26300, CPython 3.13.2 and rustc 1.97.0.

The existing first-seen repair has separate measurements on 4,096 words with 32,768 live occurrences and 1,024 archived words. This change moves the scheduling of that repair into the desktop. [First-seen repair measurements](../RUST_MIGRATION.md#mining-vocabulary)

The raw results include individual samples and executable checksums. [Vocabulary setup results](vocabulary-setup-2026-11-21.json) · [Yomitan export results](yomitan-frequency-2026-11-21.json)

## Reproduce on Windows

```powershell
cargo build --locked --release --manifest-path native/gsm-native/Cargo.toml
cargo build --locked --release --manifest-path native/gsm-db/Cargo.toml --example vocabulary_setup
cargo build --locked --release --manifest-path native/gsm-web/Cargo.toml --example report_benchmark
.venv/Scripts/python.exe scripts/benchmark_vocabulary_setup.py --extension src-tauri/target/native-dev/release/_native.dll --rounds 5 --output docs/benchmarks/vocabulary-setup-2026-11-21.json
.venv/Scripts/python.exe scripts/benchmark_yomitan_frequency.py --rounds 5 --output docs/benchmarks/yomitan-frequency-2026-11-21.json
node scripts/build-native-dev.mjs --release
node scripts/test-native-desktop.mjs vocabulary database database-recovery workspace
```
