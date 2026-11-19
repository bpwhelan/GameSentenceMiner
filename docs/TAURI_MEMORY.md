# Tauri memory behavior

Measured on Windows on November 15, 2026, against the existing uncommitted Tauri
implementation. This pass prioritizes resources used while a game is running
and the desktop is hidden. OCR accuracy, saved mining history, dictionaries, and
recording settings are preserved.

## Measurements

One before/after run used fresh isolated profiles, the same 1,000-line transcript,
and the complete native desktop process tree. Each checkpoint settled for 12
seconds, then took five samples; the table reports their medians. The fixture
includes the input helper and WebView2 processes. It excludes the Python backend,
OBS, games, loaded OCR models, and imported dictionary datasets. These are desktop
fixture results, not a promise about total gaming-session RAM.

| State | Private resident before → after (MiB) | Private committed before → after (MiB) |
| --- | ---: | ---: |
| Home visible | 310.18 → 310.04 | 485.78 → 481.49 |
| Home hidden | 281.41 → 229.18 | 450.46 → 405.37 |
| Overlay prepared, Home hidden | 365.95 → 260.85 | 592.37 → 552.31 |
| Overlay disabled and idle, Home hidden | 328.54 → 31.88 | 538.04 → 367.50 |
| Home and overlay reopened | 327.39 → 226.85 | 531.91 → 560.97 |

The idle disabled case used **31.7% less committed memory**. Its larger resident
reduction also reflects WebView2 releasing or paging out inactive browser memory.
USS measures private resident pages without double-counting shared Chromium
pages; it must not be confused with private commit. Summed RSS double-counts
shared pages and is retained only as a diagnostic in the raw files.

Reopening rebuilds a released overlay. In this run it used 5.5% more committed
memory after 12 seconds than the retained-view implementation, although private
resident memory was lower. This is a memory/first-use latency tradeoff, not a
reduction in every state. Visible Home's footprint is essentially unchanged.
Repeat with representative games and dictionaries before setting a release-wide
memory budget. OCR model changes are not included in these measured savings.

Raw results: [before](benchmarks/tauri-memory-before-2026-11-15.json),
[after](benchmarks/tauri-memory-after-2026-11-15.json). The after run additionally
checks that an old 30-second cleanup cannot destroy a re-enabled overlay, that
an idle disabled overlay disappears, and that reopening restores all 1,000 rows
and the dictionary-ready handshake.

A separate [live snapshot](benchmarks/tauri-memory-live-before-2026-11-15.json)
records the original process tree with a real game, OBS, backend, and dictionaries.
Its totals include those external processes and are not comparable to the fixture.
There is no matched live-session after measurement in this pass.

## Resource lifetimes

| Resource | Behavior |
| --- | --- |
| Overlay presentation | Created on first enable. Quick toggles reuse it; 30 seconds disabled releases it. Shared dictionaries remain available to Home and backend requests. |
| Hidden desktop pages | Native visibility supplements browser visibility, which WebView2 does not consistently update when Tauri hides a window. Polling and terminal presentation stop while hidden and resume on return. |
| Home transcript | Intake, corrections, and persistence continue in a bounded buffer. Hidden rows are unmounted: this fixture went from 25,102 document nodes to 1,099. Selection, translations, and scroll position remain in the retained component. |
| Reader history | At most 1,000 lines and one million characters including textual metadata. Ordinary 1,000-line histories remain intact; unusually large captures cannot retain 100 MB of text. Translations are removed when their source line leaves history or changes. Backend/database history is separate. |
| Hidden presentation webviews | After a 10-second grace, request WebView2's low-memory target. Restore normal on focus/show. Active overlay and dictionary/service views are exempt; shared dictionary renderers are never suspended. |
| OneOCR | A shared pipeline serialized with inference. After 60 seconds without recognition, a 30-second maintenance check can release it; next use reloads it. Cleanup never waits for or interrupts an in-flight scan. |
| Private OCR models | Paused/manual idle workers release frames immediately and private models after about 60 seconds. Engine changes discard obsolete models while retaining configured two-pass and composite dependencies. |
| ScreenAI resources | File-size callbacks read metadata; data callbacks read directly into ScreenAI's supplied buffer. GSM no longer retains/clones every resource file. ScreenAI itself stays loaded because its exposed ABI has no safe engine teardown. |
| Closed dictionary consumers | Remove attachment, context, and port bookkeeping; notify remaining port endpoints. Recreated windows attach dictionaries again. |

The Windows browser policy follows Microsoft's
[WebView2 performance guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance).
It does not force working-set trims, run repeated garbage collections, disable
GPU acceleration, or move dictionary storage. Chromium background flags remain
compatible with the live overlay and extension services.

The audit also checked existing safeguards: native capture mailboxes hold one
pending request; WGC/OBS capture sessions are shared and released when inactive;
Yomitan/Hachidori lookup caches have 128-entry/8-MiB budgets; Jiten's parse cache
has a 2,000-entry/16-MiB serialized-size budget; Sudachi loads on demand and unloads
after five idle minutes; backend game/recycle history is bounded. These are
existing protections, not new savings from this pass. Serialized cache budgets
are not exact allocator/heap ceilings.

## Repeat and verify

```powershell
npm run build:tauri
.venv/Scripts/python.exe scripts/benchmark_desktop_memory.py --output temp/memory.json
```

The runner leaves its isolated profile and log in the system temporary directory.
`--executable` selects a staged build. `--pid <desktop-pid>` samples an existing
application without changing its state; account separately for OBS and games
launched as children. No user profile is used for fixture tests.

Validation passed: 38 focused renderer tests, TypeScript checking, 201 desktop
tests, 50 overlay engine unit tests, and 13 overlay integration tests. The installed
OneOCR unload/reload regression also passed. Live desktop checks covered immediate
and delayed tray reopening, overlay interaction, Yomitan and Hachidori import and
reopening, and Japanese recognition with both OneOCR and ScreenAI. The tray check
waits for the dictionary's one-time initial document reload before recording state.
The memory fixture checks quick and delayed overlay reactivation and transcript
restoration. Runtime validation is Windows-only; macOS/Linux need their own acceptance.

Further architectural opportunities include virtualizing visible transcript rows,
moving more backend responsibilities out of Python, and isolating engines without
safe unload APIs. Each needs separate behavior and latency measurements; a smaller
working set alone is not evidence of fewer allocations.
