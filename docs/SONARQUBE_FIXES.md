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

- **Test-suite bugs** (real, low-risk, improve CI signal):
  - `python:S3827` undefined name — `tests/test_obs_source_selection.py:739`
  - `python:S930` wrong args — `tests/ui/test_config_safety.py:64`
  - `pythonbugs:S6466` possible `IndexError` — 8 hits across
    `tests/util/media/test_ffmpeg_screenshots.py`, `tests/util/communication/test_*_ipc.py`,
    `tests/util/shared/test_base_api_client.py`
- **`python:S1244` float equality (127)** — comparing floats with `==`. Mostly mechanical
  (`math.isclose`), but high count — do *after* scope-narrowing so you only touch first-party hits.
- **150 security hotspots** — review pass (these are "review", not confirmed vulns); the MCP
  `search_security_hotspots` / `show_security_hotspot` tools or the SonarCloud UI are best for this.

## Deprioritize (vendored / upstream — fixing causes drift)
- `python:S3923` identical if-branches (10) — all in `owocr/ocr_runtime.py`, `owocr/run.py`.
- `python:S5443` publicly-writable dir (2) — `owocr/ocr_runtime.py`.
- `javascript:S2819` (7), `Web:S5725` (4) and most js/ts/web findings — yomitan / texthooker /
  owocr. Excluded by `.sonarcloud.properties`.

---

*Regenerate this snapshot by re-running the REST/MCP queries in [SONARQUBE_MCP.md](SONARQUBE_MCP.md).*
