# Collecting VAD test audio

In a development checkout, use **Development → Record VAD Debug Audio (includes
FireRed analysis)**, then mine cards or preview audio normally. Use **Development
→ Open VAD Debug Folder** to open `<GSM data directory>/vad-debug`.

The switch starts off, applies immediately, and resets when the Python backend
restarts. Turn it off when finished collecting. Saved samples stay in the folder
until you remove them; there is no automatic rotation of this test library.

Each VAD call creates a unique timestamped folder containing:

- `pre_vad.<extension>`: an exact copy of the clip supplied to VAD, before model
  processing. Its SHA-256 is included to identify duplicate inputs.
- `post_vad.<extension>`: the output of the configured VAD pipeline, including
  padding, beginning trimming, and splicing settings. Rejected/failed runs have
  no post-VAD file; the report explains the rejection or failure.
- `firered_input.wav`: the exact temporary 16 kHz, 16-bit mono WAV used by FireRed
  after resampling, without noise reduction or dialogue enhancement. Use this
  file to reproduce inference.
- `result.json`: the `gsm_vad_debug_v1` report described below.

When FireRed is selected, the recorder captures that inference. When another
model is selected, debug mode also runs FireRed on the same input for analysis.
The configured model and fallback chain still determine the card audio. FireRed
does not consult Silero. Extra inference and file copies add work while debug
recording is enabled.

## Report contents

The JSON includes the profile, dialogue text and line context; relevant VAD and
audio settings; installed package versions; audio filenames, sizes and hashes;
each selected/backup model's detected segments, validation decision, errors and
detection/validation/render times; and the final result before replay timestamps
are rebased onto the video timeline. `firered.analysis_only` identifies extra
diagnostic inference.

FireRed details include raw and smoothed probabilities for every 10 ms frame,
thresholded predictions, final speech decisions, segment timestamps, the actual
postprocessor settings, ONNX execution providers, model and CMVN hashes, input
duration and a `reaches_clip_end` flag. A failed FireRed run records its error.
`firered.preprocessing` records the PCM format and empty filter list. Older
captures without this field used GSM's shared `afftdn,dialoguenhance` conversion
on Windows/macOS (`afftdn` on Linux); retain those original inputs when comparing
old and new results.

All speech timestamps refer to seconds from the start of the captured input.
Frame `i` starts at `i * frame_shift_seconds`; feature windows are 25 ms. The
reported final trim can include configured offsets beyond the last speech frame.

To build a reviewed test library, fill in `review.expected_speech_start_seconds`,
`review.expected_speech_end_seconds`, `review.verdict` and `review.notes` after
listening. Keep both good and bad cases, including clips with music, effects,
quiet/short speech, pauses, trailing silence, and speech that really reaches the
clip boundary. Captures include dialogue and audio and stay local.

For an individual timing comparison, the existing benchmark accepts the saved
input, for example:

```powershell
.venv\Scripts\python.exe scripts/benchmark_vad_models.py "<sample>/firered_input.wav" --models firered,silero --json
```

Debug disk-write failures stop recording and report the error to Electron.
Failures of the extra FireRed analysis are saved in JSON. Neither changes the
configured audio result.
