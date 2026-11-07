# Recording OCR against a text hook

In a development GSM build, start your text hook and automatic or overlay OCR for the same
game. Choose **Development → Record OCR vs Texthook (suppress automatic OCR)**.
The check mark appears after the backend confirms that recording has started.

While this is enabled:

- Automatic OCR keeps scanning and appears in the OCR diagnostics, but the
  backend records its emitted results instead of accepting them into sentence
  history, stats, mining or clipboard output.
- Texthook text continues through normal intake and is recorded as reference.
- Overlay OCR is also recorded. Its coordinates and lookups continue normally,
  while automatic `inject_scanned_lines` text is withheld from history and stats.
- Manual OCR, area-select, whole-window and secondary OCR continue normally.
  Their explicitly tagged observations are also recorded for context.
- Ordinary OCR stability, area filtering and duplicate detection still run in
  the OCR process. This captures the candidates GSM would deliver, rather than
  every scanned frame or raw neural-network output.
- Overlay rows are captured immediately after each engine call, before any
  hooked-text/backlog correction, stabilization or repeat suppression. They
  include local and Lens passes, adaptive-crop reacquisitions, and successful
  empty or failed results. Precomputed coordinates do not create OCR rows.

Uncheck the same menu item to stop recording and resume automatic OCR intake.
This switch is session-only and resets when the backend restarts. The current
session is closed on a normal shutdown.

Choose **Development → Open OCR Benchmark Folder** to find the output:

```text
<GSM data directory>/ocr-benchmarks/<UTC timestamp>_<session id>/
    events.csv
    session.json
```

`events.csv` contains an ordered row for each observed hook or OCR candidate:

| Column | Meaning |
| --- | --- |
| `sequence` | Event order within this recording |
| `recorded_at_utc` | Backend receipt/recording time |
| `captured_at_utc` | Producer's capture timestamp, when available |
| `elapsed_ms` | Monotonic time since recording started |
| `source` | `texthook`, `ocr`, `overlay`, or an explicit manual source |
| `source_instance` | Hook/source identity |
| `engine` | OCR engine actually attached to the result, or hook engine |
| `model` | Actual Vita model size (`small`, `normal`, `large`), when available |
| `model_revision` | Pinned Vita runtime source revision |
| `scene` | Capture's OBS scene, falling back to the backend's current game |
| `observation_id` | Original ingress identifier |
| `suppressed` | `true` for automatic OCR withheld from normal intake |
| `text` | Exact emitted text, before backend replacements and deduplication |
| `metadata_json` | Hook identity, OCR provenance, or overlay attempt details |

The CSV uses UTF-8 with a BOM for Excel and standard CSV quoting, including
commas, quotes and multiline dialogue. Use a CSV reader instead of splitting
lines or commas. Each completed row is flushed, so an agent can inspect a
recording while it is running and a crash preserves the flushed rows.

`session.json` stores the starting OCR engines, language, scan interval,
two-pass setting, overlay OCR settings and initial Vita model selection. On stop it also records the ending time, per-source counts
and any write error. Rows stream to disk without accumulating session history
in memory. A write failure reports an error and keeps automatic OCR suppressed
until you uncheck the toggle; hook and manual intake continue.

To make a quick comparison report, run this from the repository root:

```powershell
uv run python scripts/analyze_ocr_benchmark.py
```

It selects the newest session and writes `analysis.md` beside its `events.csv`.
Pass a session folder or CSV path to choose an older recording, and use
`--window-seconds 3` to widen the default two-second matching window. The report
summarizes paired coverage, exact and punctuation-tolerant matches, and character
error rates, then lists readings that need review. Overlay retries are grouped
by workflow, engine and phase; manual scans and geometry-only detector results
are excluded from transcription accuracy. `--include-exact` includes every
hook line, while `--output -` prints the full Markdown report to the terminal.

The script pairs each OCR event with its nearest texthook event in the same
scene and time window. This is a review aid, not a human-labeled accuracy set:
short or delayed dialogue, hook fragments, and screen transitions can still
make a time-based pair ambiguous. Read the listed Japanese text when judging
those cases.

For analysis, align the independent streams by capture/receipt time and scene,
then account for hook fragments or speaker-name threads before computing exact
matches or character error rates. They are deliberately not paired by assuming
the most recent hook line is always the reference: a hook can arrive before or
after OCR, and a dialogue box may contain several hook messages. Keep unmatched
events when estimating missed lines. A repeated transport observation can also
appear more than once; use `observation_id` when removing transport retries.

Overlay rows include `workflow_id`, `overlay_phase` (`local`,
`local_preliminary`, `local_reacquire`, `local_detection`, or `lens`), `attempt`, `duration_ms`,
`success`, `crop_box`, `overlay_trigger` and `overlay_manual` in `metadata_json`.
Group attempts by workflow and engine when comparing final readings, so retries
are not mistaken for separate dialogue lines. A failed read has empty text and
its error in metadata. Manual overlay scans are marked `suppressed=false`.
Optional text injection is gated separately without recording the corrected
text a second time. Overlay mining still keeps its transient scan/audio context.

With **VOCR line detector → Google Lens**, `local_detection` rows contain empty
text and their `detection_boxes` in metadata; these are detections, not failed
transcriptions. Successful empty detections skip Lens. `ocr_finder` records
whether the spotter or structural GRAD fallback actually ran and why a fallback
was needed. Local VOCR recognition also carries this finder metadata through
the ordinary OCR result path.

No screenshots are captured by this recorder. It writes the text already
emitted by the two sources. If you switch OCR engines during a session, the
per-event engine column identifies results carrying normal pipeline metadata;
the session settings describe the initial configuration only.
Vita results also include their actual model size and revision in each row,
with filename and release in `metadata_json.ocr_model`, including when models
are changed during recording or while a scan is in flight.
