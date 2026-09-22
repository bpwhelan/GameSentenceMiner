# Rust text migration benchmarks

Three deterministic text computations now use the existing PyO3 extension: OCR sequence matching,
text-hook repetition cleanup, and batched kanji frequency counting. Python fallbacks remain available
for older binaries, unsupported arguments, and `GSM_NATIVE_TEXT_MODE=python`. Shadow mode compares
outputs and returns the Python result. No new Rust dependencies were added.

Measured on Windows with CPython 3.13.2 and the optimized editable extension. The Python baseline is
revision `90eb145b5b8dd1a91ba4c0eca99ec20984b46b64`. Each result is the median of seven rounds, with three
workload executions per round and alternating Python/Rust order. Timings include the Python facade,
argument conversion, and result conversion. Exact output equality is required before timing.

| Workload | Python | Rust via Python | Speedup |
| --- | ---: | ---: | ---: |
| OCR stability ratios, 128 sentence pairs | 15.684 ms | 1.603 ms | 9.78× |
| OCR matching-block coverage, 128 uncached pairs | 15.007 ms | 1.590 ms | 9.44× |
| Repeated-character cleanup, 32 lines | 1.934 ms | 0.117 ms | 16.58× |
| Repeated-line cleanup, 32 lines | 4.088 ms | 0.125 ms | 32.78× |
| Full kanji frequency calculation, 10,000 lines | 198.610 ms | 7.970 ms | 24.92× |

These are deterministic synthetic Japanese workloads. OCR pairs contain 48–144 characters with small
substitutions; cleanup workloads contain three copies of each character or six copies of each line.
The statistics benchmark includes collecting line text, Rust batches, merging counts, sorting, and
assigning gradient colors. It compares the complete original statistics function loaded from the
recorded revision. The other benchmarks compare the retained Python kernels with their production
callers. These gains do not measure OCR inference, database queries, or overall application latency.
Existing cache hits bypass matching in both implementations and do not receive the reported speedup.

Raw samples and environment metadata are in [results.json](results.json).

## Reproduce

From the repository root:

```powershell
.venv\Scripts\python.exe -m uv pip install --python .venv\Scripts\python.exe --no-deps --reinstall --editable .
.venv\Scripts\python.exe scripts/benchmark_native_text.py --reference-ref 90eb145b --output .tmp_test_env/native_text_benchmark/results.json
```

The benchmark uses configuration under `.tmp_test_env` and does not access a user database.

## Verification

- 656 Python tests passed across native code, OCR, text processing, statistics APIs/dashboard, and
  game archives; 29 tests were skipped by the suite.
- All 15 Rust tests passed; `cargo fmt --check` and Clippy with `-D warnings` passed.
- Added property tests compare Unicode output against Python, including a separate exhaustive check
  of all 3,969 pairs of binary strings up to five characters long.
- Contract tests cover asymmetric matching ties, repeated/popular characters, CJK range boundaries,
  first-seen ordering, archive interleaving, incomplete repetition groups, older/missing extensions,
  native failures, lone surrogates, large integers, and Python/native/shadow modes.
- Rust calls are asserted at the application boundaries; fallback success alone cannot pass those
  integration tests.
- Repository-wide Ruff formatting was run. New files pass Ruff checks; touched older modules retain
  their existing lint findings with no added diagnostics.
