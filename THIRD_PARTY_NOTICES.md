# Third-party notices

## Optional HoshiDicts native host

The optional HoshiDicts host is built from the MIT `main-mit` source line:

- source: https://github.com/Manhhao/hoshidicts
- commit: `af99b554cd4ab289aa65e16fd2a4eea0d3870d3b`
- license: MIT

It includes or links the following pinned permissive dependencies:

| Component | License | License file in the source tree |
| --- | --- | --- |
| HoshiDicts | MIT | `vendor/hoshidicts/LICENSE` |
| Jiten deconjugation rules | Apache-2.0 | `vendor/hoshidicts/external/Jiten/LICENSE` |
| glaze | MIT | `vendor/hoshidicts/external/glaze/LICENSE` |
| libdeflate | MIT | `vendor/hoshidicts/external/libdeflate/COPYING` |
| unordered_dense | MIT | `vendor/hoshidicts/external/unordered_dense/LICENSE` |
| utfcpp | BSL-1.0 | `vendor/hoshidicts/external/utfcpp/LICENSE` |
| xxHash | BSD-2-Clause | `vendor/hoshidicts/external/xxHash/LICENSE` |
| zstd | BSD-3-Clause | `vendor/hoshidicts/external/zstd/LICENSE` |

Zstandard is available under BSD-3-Clause or GPL-2.0; this distribution selects
BSD-3-Clause. The GPL HoshiDicts line is not used.

The packaged host notice directory contains the complete license texts. Exact
commits, hashes, source provenance, and capability differences are documented
in `docs/third-party/hoshidicts-provenance.md` and
`docs/third-party/hoshidicts-capability-report.md`.
