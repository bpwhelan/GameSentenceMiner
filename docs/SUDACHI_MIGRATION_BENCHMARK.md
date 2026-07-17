# Sudachi migration and benchmark report

Date: 2026-07-16

## Decision

GSM now uses the existing Rust input service as its single Sudachi host. The service uses
`sudachi.rs` v0.6.10 in split mode B and exposes tokenization over its local WebSocket protocol.
Python code uses a small synchronous client with a persistent connection and LRU result cache.

This was simpler than adding SudachiPy because the desktop application already starts and supervises
the Rust service. Reusing it keeps one dictionary and tokenizer instance shared by Python and the
overlay, avoids another native Python package, and gives both callers the same token contract.
SudachiPy itself is a Python binding over the same Rust implementation, so it would not provide a
second tokenizer engine with different capabilities.

References:

- [sudachi.rs](https://github.com/WorksApplications/sudachi.rs)
- [SudachiPy bindings in sudachi.rs](https://github.com/WorksApplications/sudachi.rs/blob/develop/python/README.md)

## Benchmark result

The steady-state comparison uses the removed Python MeCab controller as the baseline and the final
Python-to-Rust Sudachi client as the replacement. Each run tokenized 400 unique short Japanese
sentences sequentially, so neither implementation's result cache could hide tokenizer cost.

| Metric | MeCab baseline | Shared Rust Sudachi | Change |
| --- | ---: | ---: | ---: |
| Batch wall time | 9.0869 s | 0.2012 s | 45.2x faster |
| Throughput | 44.0 requests/s | 1,988.1 requests/s | 45.2x higher |
| Mean request latency | 22.717 ms | 0.502 ms | 45.2x lower |
| Median request latency | 22.519 ms | 0.484 ms | 46.5x lower |
| p95 request latency | 24.424 ms | 0.609 ms | 40.1x lower |
| Total CPU time for 400 requests | 9.125 s | 0.156 s | 58.4x lower |
| CPU time per request | 22.813 ms | 0.391 ms | 58.4x lower |
| Average CPU during the batch | 100.4% | 77.7% | 22.6 percentage points lower |
| Isolated combined peak RSS | 46.1 MB | 302.8 MB | 6.6x higher |

The final Python wrapper includes WebSocket framing, JSON serialization, and Python token object
creation. A direct Rust-service run reached 2,305.6 requests/s at 0.416 ms mean latency, so the
wrapper adds about 0.09 ms per request while keeping most of the native service's gain.

### CPU interpretation

The sequential MeCab baseline kept approximately one logical CPU saturated because it repeatedly
spawned and waited for the tokenizer process. Sudachi completed the same batch so quickly that its
average CPU percentage was lower even though individual requests also run on one core. Total CPU
seconds, rather than the instantaneous percentage, is the useful comparison: the finished path used
0.156 seconds instead of 9.125 seconds for the same request count.

### Memory interpretation

Sudachi's core dictionary trades memory for speed:

- MeCab benchmark peak: 33.8 MB Python client plus 12.4 MB child process.
- Sudachi benchmark peak: 31.2 MB Python client plus 271.6 MB shared Rust service.
- The downloaded core dictionary file used for the run is 217,203,456 bytes (207.1 MiB).

The isolated comparison therefore favors MeCab. Electron already starts the lightweight Rust service,
but the large dictionary becomes resident only after a Sudachi client uses it. When the overlay has
already loaded Sudachi, Python reuses that same instance and removes the approximately 12.4 MB
transient MeCab child and its process churn. When Python is the only Sudachi consumer, the isolated
figures apply: working set increases by about 257 MB compared with the old Python-plus-MeCab path.
Outside the desktop application, the Rust service must be started separately and its roughly 272 MB
resident set is the cost of the chosen core dictionary.

### Cold start

Dictionary loading is the main regression. In the first head-to-head run, the first MeCab request
took 29.8 ms and the first Sudachi request took 144.7 ms. A later run with the dictionary in the OS
file cache took 69.4 ms through the final Python wrapper. Users should therefore expect roughly
70-145 ms for the first Sudachi request on this machine, followed by sub-millisecond requests.

## Test environment and method

- Windows 11 `10.0.26200`, 16 logical CPUs.
- Python 3.12.12 from the project `.venv`.
- Release-mode `gsm_overlay_server.exe` using `sudachi.rs` v0.6.10.
- Sudachi core dictionary release 20260116, split mode B.
- 400 unique Japanese sentences, submitted synchronously over one persistent connection.
- Client caches disabled for the timed loop.
- CPU time measured as user plus system time for the Python/client side and tokenizer process.
- RSS sampled during each timed loop; the reported combined value sums the relevant process peaks.
- MeCab was measured before its vendored runtime was deleted from the working tree.

These are local engineering measurements, not universal hardware claims. Dictionary page sharing,
antivirus scanning, OS file-cache state, sentence length, and concurrent callers will change the
absolute numbers. Unique inputs make the steady-state result conservative for normal use because
the production Sudachi client retains a 1,024-entry LRU cache.

## Migration impact

- Python furigana, VAD normalization, database tokenization, and maintenance scripts now use the
  shared Sudachi client.
- The overlay tokenizer and furigana paths expose Sudachi only; the local MeCab bridge and backend
  selection settings were removed.
- The bundled Yomitan build no longer contains its native MeCab connector, parser setting, API
  action, permission behavior, or parser UI. A one-time options migration removes the obsolete
  stored setting from existing profiles.
- The Rust protocol no longer advertises or handles a MeCab capability.
- The tracked vendored MeCab tree was deleted: 32 files and 82,683,256 bytes (78.85 MiB).

## Expected gains

For steady-state tokenization on the benchmark machine, expect approximately 40-45x lower latency,
45x higher sequential throughput, and about 58x less CPU time per uncached request. Memory drops by
roughly the removed MeCab child-process peak when the overlay has already loaded the shared dictionary;
otherwise, core-dictionary residency raises working set as described above. Distribution contents
shrink by 78.85 MiB. The other tradeoff is a slower first request while the dictionary loads.
