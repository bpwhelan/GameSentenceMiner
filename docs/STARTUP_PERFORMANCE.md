# Startup performance

Startup improvements measured on Windows 11 / Python 3.13.2, October 27, 2026,
against repository revision `ee5b024a`.

## Measurements

Three alternating runs of the original and updated backend used isolated empty
profiles, databases and local ports. Each run waited for a successful HTTP
status response and initialized text intake, opened the settings window, then
verified clean shutdown.

| Measurement | Original median | Updated median | Reduction |
| --- | ---: | ---: | ---: |
| Isolated backend readiness | 5.146 s | 2.406 s | 53.3% |
| Installed package version lookup | 0.770 s | 0.239 s | 68.9% |

Backend readiness samples were 5.491 / 5.122 / 5.146 seconds before and
2.415 / 2.406 / 2.337 seconds after. This measures Python imports, database
initialization, API registration, Qt, overlay processing, HTTP and text intake.
It excludes Electron startup, OBS startup, downloads, global input hooks,
external integrations and scheduled maintenance. The changes use shared code
on Windows, macOS and Linux; these timings are measurements on Windows only.

The full desktop baseline on this machine took about 12.4 seconds from the
desktop session log to the mining-ready notification. A full desktop comparison
should use the new startup markers below, with the same profile and external
applications in the same state. Do not add the individual savings together:
some work overlaps.

## Changes

- Read installed distribution metadata directly, avoiding importing and running
  `pip show` for routine version checks. Missing packages still enter setup.
- Create the Python settings window when requested. The Qt application and
  dialog manager remain available from startup. A first settings opening now
  pays the construction cost (about 2.4–2.6 seconds in these isolated runs).
  The saved preference to open settings at startup is respected.
- Stop Qt cleanly even when no settings window has been created.
- Remove the fixed two-second pause after OBS has already passed websocket and
  scene-readiness checks. Run readiness probes off the shared transport loop
  and reread the managed port while Electron is starting OBS.
- Start OBS alongside desktop dependencies, and start input and message services
  concurrently. Children still wait for both services. Start the configured
  overlay before waiting for Steam launch or OCR startup.
- Bind the legacy HTTP redirect without reverse DNS. Use the internal HTTP
  listener's readiness event instead of polling an initially unbound port.
- Retry the overlay command connection after 250 ms, then 500 ms, then at most
  once per second during startup. After twenty failures, return to the existing
  five-second interval. Successful connections reset the retry delay.

Required updates, dependency installation and repair remain on the startup path.
This work does not skip necessary setup to make a first installation appear
ready early.

## Repeating the benchmark

Use the repository environment:

```powershell
.venv/Scripts/python.exe scripts/benchmark_startup.py --runs 3 --output temp/startup-results.json
```

On macOS/Linux, use `.venv/bin/python`. The benchmark uses temporary data and
ports, disables external integrations, verifies settings creation after startup
and requires the worker process to exit cleanly. Run it without other builds or
test suites competing for CPU. Compare medians from equivalent installations;
a fresh empty database is not representative of a large personal database.

## Validation

- 189 Python startup, OBS, settings, profile, HTTP and shutdown tests passed.
- All 141 desktop test files passed: 1,446 tests passed, two platform skips.
- Overlay tests: 599 passed, one existing skip.
- Electron main and renderer builds passed; Ruff formatting completed.
- A final run of the reusable benchmark reached readiness in 1.960 seconds,
  created settings on demand and shut down cleanly. This single smoke run is
  separate from the paired before/after measurements above.

## Full application timing

Look for `[Startup]` entries in GSM's logs:

- `desktop.log`: Electron ready, input/message services, OBS launch check,
  desktop window, Python runtime/update checks, backend spawn/IPC/initialization
  and HTTP availability. Times share the desktop bootstrap origin.
- `backend.log`: imports, database/application construction, core initialization,
  Qt, background services, overlay processing and backend initialization. Each
  marker includes total time since backend entry and time since the prior stage.
- Overlay output: extension loading, renderer readiness and the first command
  connection, measured from their respective initialization points.

Readiness is measured separately from process creation. An OBS launch check may
be skipped by configuration or find an existing OBS process; it does not mean
OBS has finished loading its scenes. Compare mining-ready notifications too
when recording/OBS availability is the relevant endpoint.
