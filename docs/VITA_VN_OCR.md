# VOCR local OCR

GSM can use [bee-san/vita-vn-ocr](https://github.com/bee-san/vita-vn-ocr) as the
experimental `vitaocr` engine for Japanese visual-novel dialogue. GSM downloads
and installs the prebuilt runtime and selected model automatically on first use.
Users do not need CMake, a compiler, PyTorch, a GPU, or a separate server.
Existing OCR defaults stay the same.
The display name is **VOCR**; the saved `vitaocr` engine key and existing asset
directory are retained so earlier settings keep working.

Open **OCR → Advanced → Recognition** and select
**VOCR (experimental)** under **Main OCR**. It is also available as
**Stability OCR**. Keep the current stability engine for a first comparison, or
select VOCR for both passes to try an entirely local VOCR pipeline. Select a
tight dialogue area instead of the whole game window.

The first setup needs an internet connection. Settings show download progress
and offer **Retry** if setup fails. The main OCR settings and overlay settings
use the same installer and selection. Later scans work offline with the cached
files. Simply importing the OCR modules or checking installation status does
not start a download.

Prebuilt packages support Windows x64, macOS Intel/Apple Silicon (11+), and
Linux x64/arm64 (glibc 2.35+). Windows packages include the C runtime statically,
so a separate Visual C++ redistributable installation is not needed.

For overlay OCR, open **Overlay Settings → Capture → OCR / Capture Source**
and choose **VOCR (experimental)** under **OCR Engine**. It uses the same
installed model and supplies character boxes for lookups. Area-select OCR can
reuse the overlay's loaded VOCR model when Main OCR is also set to `vitaocr`.
The overlay releases the model after its usual inactivity timeout. For best
results, enable an OCR capture area around horizontal Japanese dialogue.

To use **only the line detector** before Google Lens:

- Main OCR: enable two-pass OCR in Advanced Recognition, select **VOCR Line
  Detector** as Stability OCR and **Google Lens** as Main OCR. Another main
  recognizer can also consume the detected crop. No VOCR recognizer is loaded
  for this detector-only pass. Stable crop contents can trigger a new scan even
  when a game's next sentence occupies identical line boxes.
  Nonempty detections count as activity even though they have no transcription,
  so they keep the configured scan interval instead of triggering idle backoff.
  Capture and recognition time count toward that interval; slow work can still
  limit the actual scan frequency.
- Overlay: choose **VOCR line detector → Google Lens** in the OCR Engine menu.
  The detector masks the capture to its line regions while preserving their
  original positions. Lens supplies the text and character coordinates; an
  empty detection clears old targets and skips Lens entirely.

Both use the pinned 52,176-byte `textspot8_t64n8c16_w8.vtsp` detector. Detection
is performed in a frame no larger than 960×544, keeping the capture's aspect
ratio; boxes are mapped back to the original capture for recognition and
overlay placement. The detector can find vertical regions for Lens, while the
local VOCR recognizer remains horizontal-only.

The detector-only pipeline also sets itself up automatically. It downloads the
runtime and detector assets without downloading a recognizer model or changing
the selected recognizer size.

The installation lives in `<GSM data directory>/ocr/vita-vn-ocr`. `GSM_DATA_DIR`
and GSM's relocated data directory are respected. For a separate installation,
launch GSM with `GSM_VITA_OCR_DIR` set to the desired path. Prebuilt libraries
live in a versioned `runtime/<build>/<platform>` subdirectory, while models and
the shared selection stay in the asset directory. Complete earlier source-built
installations continue to work.

When VOCR is selected, use **VOCR model size** in either the main OCR
recognition settings or overlay capture settings to choose Small (0.82 MB),
Normal (1.19 MB, default), or Large (2.48 MB). This is one shared selection
across main OCR, overlay OCR and profiles. The selected size is saved in
`installation.json`; selecting an engine alone never resets it.

The backend downloads a missing model once, verifies its pinned SHA-256 and
checks that the native runtime can load it before saving the change. Cached
models can be selected offline. A failed download or load leaves the previous
selection in place. Existing engines pick up changes on their next scan;
an already-running scan keeps its original model. No GSM restart, CMake build,
or DLL replacement is needed for size changes. Initial setup and model changes
are serialized across main and overlay processes; the previous choice is only
replaced after the new runtime and model load successfully.

## Building from source (developers)

The optional developer installer still supports building locally with CMake
and a C compiler. From the repository root:

```powershell
.venv/Scripts/python.exe scripts/setup_vita_ocr.py --model large
```

It also accepts `--directory PATH` and `--spotter-only`. Close GSM before a
full source install because that command replaces its source-built libraries.
Ordinary users do not need to run it.

Maintainers build distributable packages with
`python scripts/build_vocr_runtime.py`. The **Build VOCR Runtime** workflow
builds and load-checks both libraries on each supported platform. Publish its
archives to the versioned `vocr-runtime-<build>` prerelease, then pin their
SHA-256 hashes in `GameSentenceMiner/ocr/vocr_runtime.py`. Never overwrite an
archive already pinned by a released GSM version; increment the runtime build
instead. Each archive includes the exact C source, GSM bridge, CMake project,
source checksums, GPL licence and rebuild instructions.

Developer benchmark CSVs include `model` and `model_revision` on each VOCR
observation, with the filename and release in `metadata_json.ocr_model`.
The session settings also snapshot the starting selection. Row metadata comes
from the model that read the capture, so switching sizes during a session does
not relabel earlier or in-flight results.

## What this trial runs

- Source revision: `205f47ec4e56ca87c00e7dba0a61c9aaec726707`.
- Models: release `v0.5.0`, default `VOCR6.2_N_w8g2.vocr`.
- Upstream textspot8 line finder, half-scale crop decode, automatic per-line
  polarity, int8 recognition, and the model's head optimizations. GRAD is the
  structural fallback when the spotter cannot run (missing or invalid assets,
  a refused frame or truncated detection). A successful empty spotter result
  stays empty; low confidence alone never invokes GRAD.
- Greedy CTC decoding, with upstream character-cell positions for overlay lookup.
  GSM receives normalized line and character boxes through its usual OCR result
  converter, including its normal furigana size filter.
- Calls sharing the same native context are serialized.

This trial supports horizontal Japanese dialogue, up to 64 detected lines per
capture with the spotter (16 with GRAD). It does not include Rubi's
beam/language-model decoder, cascade, counter corrections or vertical-text
recognizer. The separate text-presence gate is not used: successful empty
spotter reads already skip recognition. Its output therefore should
not be treated as a reproduction of Rubi's end-to-end benchmarks. PC game fonts,
translucent boxes, backgrounds and whole-window captures need real testing.

## Licensing and distribution

The C runtime is GPL-3.0. The current VOCR6 weights are **non-commercial use
only**, as documented in upstream's
[model catalogue](https://github.com/bee-san/vita-vn-ocr/blob/main/docs/models.md).
Setup installs `VOCR6-ATTRIBUTION.md` alongside the model. The spotter includes
`SPOTTER-ATTRIBUTION.md` and is also marked for non-commercial use. The runtime
archive includes its GPL licence and complete corresponding source. Models and
compiled libraries are downloaded separately into GSM's data directory; they
are not committed to the repository or bundled as Python dependencies.

The source checksums are recorded in `native/vita-ocr/source-lock.json`; model
checksums and the Python ABI pin are in `GameSentenceMiner/ocr/vita_ocr.py`.
Prebuilt archive and attribution checksums are in
`GameSentenceMiner/ocr/vocr_runtime.py`. Update these together when testing
another upstream revision.
