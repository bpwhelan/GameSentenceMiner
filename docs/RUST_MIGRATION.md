# Incremental Rust migration

GSM uses one private PyO3 extension, `GameSentenceMiner._native`, for in-process native components.
Application code must call a Python facade under `GameSentenceMiner.native` instead of importing the
extension directly. This keeps Rust ABI details, fallback behavior, and rollout controls at one boundary.

## Layout

```text
native/gsm-native/
  Cargo.toml
  src/
    lib.rs          # Thin PyO3 conversion layer only
    text_filter.rs  # Pure Rust OCR text filtering
    layout.rs       # Pure Rust OCR geometry/layout engine
GameSentenceMiner/native/
  runtime.py        # Shared rollout mode
  ocr.py            # Typed Python facade
```

Future components should follow the same split: domain logic remains independent of Python in a Rust
module, `lib.rs` converts a small number of coarse-grained calls, and a typed Python facade owns rollout
and compatibility. Avoid Python callbacks and per-character or per-pixel FFI calls.

The extension exposes a small integer API version. Each facade validates that version before enabling
native calls, so an old binary beside new Python source falls back safely. Bump the version only for a
breaking boundary change; additive Rust-internal changes do not require it.

## Current OCR boundary

Rust owns script-aware character filtering, source-separator preservation, repeated-prefix removal,
spatial line joining, writing-direction detection, paragraph grouping, overlapping-line merging, and
furigana filtering. The overlay's structured line/word language gate is also one batched Rust call;
Python reconstructs the selected dictionaries so bounding boxes and OCR metadata stay unchanged. Python
still owns sentence segmentation, rolling OCR history, configuration, normalization, and reconstruction
of the existing `OcrResult`/`Paragraph`/`Line` objects. Those state owners can move later without changing
current OCR callers.

The native Japanese/Chinese text path uses the same target-script extraction as the legacy filter and
does not run the legacy statistical language classifier once per text block. Python and shadow modes
retain that classifier for rollback and representative parity audits.

## Development

The root setuptools build uses `setuptools-rust`, so the normal environment sync builds the extension:

```powershell
uv lock --check
uv sync --frozen --extra dev
cargo test --manifest-path native/gsm-native/Cargo.toml
.venv\Scripts\python.exe -m pytest tests/native tests/ocr/test_text_filtering_punctuation.py
```

PyO3 is configured for CPython's `abi3` stable ABI beginning with Python 3.10. A wheel is still required
for each supported operating system and architecture.

Development prerelease CI builds and smoke-tests one platform wheel per Electron target. The wheel and
its SHA-256 digest are bundled with the app through `electron-src/assets/prerelease.json`; the managed
Python environment installs that immutable local artifact rather than compiling a GitHub branch archive
on the user's machine. The same wheels are attached to the matching GitHub prerelease for inspection.

## Rollout and rollback

The default mode is `native`. Set either environment variable before starting GSM:

- `GSM_NATIVE_OCR_MODE=python` uses the retained Python reference implementation.
- `GSM_NATIVE_OCR_MODE=shadow` computes both implementations, logs mismatches, and returns the Python
  result. Shadow mode is diagnostic and intentionally slower.
- `GSM_NATIVE_MODE` applies the same mode to every native component unless a component-specific value
  overrides it.

If the extension cannot be imported or a native call raises, OCR automatically uses the Python reference.
The Python implementation should remain until representative shadow runs and release telemetry establish
parity; it can then be removed in a separate change.

## Adding another component

1. Add pure Rust logic and Rust unit tests under `native/gsm-native/src`.
2. Export one coarse-grained operation from `lib.rs`, releasing the GIL during CPU work.
3. Add a typed facade under `GameSentenceMiner/native`.
4. Extend the native API version only if the Python/Rust boundary is no longer backward compatible.
5. Keep state and Python object reconstruction in the facade until the entire state owner is ready to move.
6. Add Python contract/parity tests, an end-to-end benchmark, and import smoke tests for every release target.
