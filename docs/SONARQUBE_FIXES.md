# SonarCloud — prioritized fix backlog

Snapshot **2026-06-15** of `bpwhelan_GameSentenceMiner` (org `beangate`). See
[SONARQUBE_MCP.md](SONARQUBE_MCP.md) for how to pull/refresh this. Quality gate is currently
**FAILING (ERROR)**.

Headline numbers: **331 bugs**, **21 vulnerabilities**, **150 security hotspots**, **3699 code
smells**, 6.4% duplication, ~239k LOC. Issues by severity: 34 BLOCKER / 881 CRITICAL / 1480 MAJOR /
1648 MINOR. Most js/ts/web issues are in **vendored** code (see scope note below).

---

## Done in this pass (branch `sonarcube_fixes`, 2026-06-15)

- **[x] Scope config** — added `.sonarcloud.properties` excluding vendored trees (owocr, mecab,
  yomitan, texthooker, node_modules, .venv, dist/build, minified assets). This is also the
  **Google-API-key exception**: the `secrets:S6334` hits in owocr disappear because owocr is excluded.
- **[x] Open redirect / header injection** — `web/texthooking_page.py` `_send_moved_page`: pin host
  to `localhost`, strip CR/LF + collapse leading slashes on the path. Clears `S5146`/`S6839`.
- **[x] Wrong argument count** — `web` `ui/qt_main.py:302`: pass `for_overlay=False` to
  `_logic_minimum_char_size`. Fixes the runtime `TypeError` (`python:S930`).
- **[x] ReDoS guard** — `web/database_api.py`: cap regex length at 500 chars + `# NOSONAR(S2631)`
  (intentional regex-search feature on the localhost single-user DB).
- **[x] Intentional kill-switch** — `web/gsm_websocket.py:754` `# NOSONAR(S2583)` (deliberate
  `_ENABLE_LEGACY_PORT_LISTENERS = False` toggle, not a bug).

**Still manual:** rotate the SonarCloud user token that was exposed in chat while wiring up the MCP
(My Account → Security → revoke + regenerate; update the MCP `env`).

---

## Pass 2 (branch `sonarcube_fixes`, 2026-06-15) — risk-ranked bug batch

Pulled fresh via REST API: 306 bugs / 15 vulns / 142 hotspots / 3433 smells. Worked Python
first-party only, ranked by *real* risk rather than Sonar severity.

**Genuine bugs fixed**
- **[x] Real data bug (`python:S1226`, filed only MINOR)** — `util/database/db.py`
  `set_gemini_models` / `set_groq_models` did `models = cls.all()` on the first line, shadowing the
  `models` param so the caller's list was silently discarded. Renamed the local to `existing`; added
  regression test `tests/util/database/test_db.py::test_set_gemini_groq_models_persist_their_input`.
- **[x] Fire-and-forget tasks GC'd (`python:S7502`, 5)** — bare `asyncio.create_task(...)` kept no
  strong ref. Added an instance-level task `set()` + `add_done_callback(discard)` in
  `web/gsm_websocket.py` (2), `util/communication/bus_client.py`, and
  `util/platform/windows_window_monitor.py` (via new `_spawn_reprocess_last_results`).
- **[x] CancelledError swallowed (`python:S7497`, 1 real)** — `gsm.py` `background_tasks_async`:
  dropped the `except CancelledError: pass`, kept `try/finally` so cancellation propagates. The two
  overlay sites in `get_overlay_coords.py` are intentional (cancel-previous / replace-task) →
  `# NOSONAR(S7497)`.
- **[x] Sync `open()` in async (`python:S7493`, 3)** — `gsm.py` pid-file read/write wrapped in
  `asyncio.to_thread`. The overlay `oneocr_results.json` dump is dev-only (`is_beangate`) →
  `# NOSONAR(S7493)`.

**Test-suite bugs fixed (low risk, better CI signal)**
- **[x] `pythonbugs:S6466` possible `IndexError` (8)** — added non-empty `assert` guards before the
  flagged subscripts in `tests/util/media/test_ffmpeg_screenshots.py`,
  `tests/util/communication/test_*_ipc.py`, `tests/util/shared/test_base_api_client.py`.
- **[x] `python:S3827` use-before-def (1)** — `tests/test_obs_source_selection.py:739` init
  `first_client_id = None` up front.
- **[x] `python:S1763` unreachable (2)** & **`python:S930` wrong args (1)** — false positives:
  the `yield` after `raise` is required for `@contextmanager` to stay a generator; the
  `trigger(False, "extra")` call exercises the decorator that absorbs extra Qt signal args. Both
  `# NOSONAR` with a why.

**Cheap cleanups / confirmed FPs**
- **[x] `python:S1764` (1)** — `config/configuration.py` `1 / 1` → `1.0` (intentional 1:1 ratio).
- **[x] `python:S1226` (1)** — `configuration.py:1582` folded the bare `previous: ProfileConfig`
  annotation into the signature. (`obs_old.py:2131` left alone — dead module.)
- **[x] `python:S1045` (1)** — `util/port_diagnostics.py` false positive (outer `except` vs nested
  `kill()` handler are separate scopes) → `# NOSONAR(S1045)`.
- **[x] `pythonbugs:S2583` (2)** — benchmark scripts' `if fraction >= 1:` is a real upper-bound
  guard; Sonar misreads it as constant → `# NOSONAR(S2583)`.

**Verification:** touched-file tests green (89 passed); full suite 1829 passed / 1 pre-existing
failure (`test_stats_dashboard_e2e` session count, unrelated, fails identically on clean HEAD).

---

## Remaining

### "Invariant return" methods (BLOCKER, `python:S3516`) — review, first-party only
Methods that always return the same value (often a stray `return True`/`None`). Review each; many are
quick fixes, some are intentional and can be marked won't-fix:
- `util/platform/base_window_monitor.py:943`
- `util/platform/windows_window_monitor.py:655, 1293, 1441`
- `obs/screenshot_capture.py:623`
- `ocr/gsm_ocr.py:876, 1505`
- `obs/launch.py:405`
- (owocr `ocr_runtime.py:643`, `run.py:630` — vendored, skip)

### Lower priority

- **`python:S1244` float equality (125)** — comparing floats with `==`. **All 125 are in test
  files** (`assert x == 0.5` on exact literals): low real risk, high churn. Convert to
  `math.isclose` as a separate mechanical pass if pursued at all.
- **`python:S3776` cognitive complexity (308)**, `S125` commented code (62), `S116/S117/S100`
  naming (119), `S1192` duplicate strings (52) — large mechanical/refactor efforts; separate batches.
- **150 security hotspots** — review pass (these are "review", not confirmed vulns); the MCP
  `search_security_hotspots` / `show_security_hotspot` tools or the SonarCloud UI are best for this.

## Deprioritize (vendored / upstream — fixing causes drift)
- `python:S3923` identical if-branches (10) — all in `owocr/ocr_runtime.py`, `owocr/run.py`.
- `python:S5443` publicly-writable dir (2) — `owocr/ocr_runtime.py`.
- `javascript:S2819` (7), `Web:S5725` (4) and most js/ts/web findings — yomitan / texthooker /
  owocr. Excluded by `.sonarcloud.properties`.

---

*Regenerate this snapshot by re-running the REST/MCP queries in [SONARQUBE_MCP.md](SONARQUBE_MCP.md).*
