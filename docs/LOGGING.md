# GSM diagnostic logs

Open the logs folder or use **Export Logs** from GSM. All diagnostics live under
`logs/` in the selected GSM data directory, including on installations that move
their data folder. OCR diagnostics survive OCR restarts and temporary-file cleanup.

| File | Contents |
| --- | --- |
| `backend.log` | Python backend and helper messages, errors, and tracebacks |
| `ocr.log` | OCR startup, engines, recognition, and errors, including OCR inside the backend; always enabled |
| `desktop.log` | Desktop startup, updates, console output, and embedded overlay |
| `process-output.log` | Raw managed child output and lifecycle events, including failures before Python logging starts |
| `ocr-debug.jsonl` | Optional advanced OCR diagnostics, including timestamps and process IDs |
| `anki-timing.log` | Optional development Anki card timing diagnostics |
| `history/` | Previous rotations and consolidated diagnostics from older versions |

The Python overlay entrypoint uses `overlay.log` when run separately. Files are
created when there is something to record. Errors stay with their component, so
there is no separate empty error file for each subprocess.

Each log appends across restarts, rotates at 5 MiB, and keeps at most five numbered
backups under `history/`. Startup removes managed history older than seven days.
Advanced OCR JSONL uses the same limits. Oversized individual messages are bounded;
oversized JSONL events are replaced with a valid diagnostic indicating their size.

Python writers coordinate with OS file locks under `.locks/`, opening and closing
the log for each write so concurrent helpers can rotate safely on Windows. Process
IDs and source locations remain inside each record. Desktop and managed child
output files are owned by the main Electron process.

On upgrade, known PID-named logs, old compressed rotations, and surviving
`temp/ocr_logs/` files are consolidated by component as `history/legacy-*.log`.
Each legacy component retains up to three 5 MiB files, newest content last.
Empty files are removed; live processes, unreadable files, and unrecognized files
are left alone. The old temporary OCR logger has been removed, and the embedded
OWOCR runtime preserves GSM's handlers instead of replacing them.

Exports include nonempty `.log`, `.txt`, and `.jsonl` files and rotations throughout
the log directory. They keep the folder layout, redact both names and contents,
and decompress/redact older ZIP/GZIP logs. Links and internal directories are
excluded. A log that disappears during export is recorded in `EXPORT_NOTES.txt`.
Unsupported or unsanitizable content still fails the export without replacing a
previous archive. Local logs are unchanged by export.

For new Python code, use the configured logger so diagnostics reach the correct
component file. The import through `configuration` remains compatible.

```python
from GameSentenceMiner.util.logging_config import logger

logger.info("OCR engine initialized: {}", engine_name)
try:
    run_operation()
except Exception:
    logger.exception("Operation failed")
```

`logger.background(...)` keeps routine messages below INFO in the console while
preserving them in the file. `logger.display(...)` is console-only. File records
include milliseconds, severity, process ID, component, source module, function,
and line number. Tracebacks are retained without dumping local variable values.
