**GSM trim candidates — September 28, 2026**

Priority: features and settings that make GSM feel bloated. This is a repository audit and a set of product judgments, not a claim that particular features have no users. No usage telemetry or live performance measurements were used.

I surveyed the desktop UI, Python settings, overlay, text feed, statistics pages, capture and mining paths, integrations, dependencies, and packaging. I inventoried 2,373 tracked files, totaling 323.1 MiB in this checkout, and traced the candidates below through their settings and callers. That inventory is not a line-by-line review of every vendored file. Sizes are raw file sizes, not compressed installer savings.

**My recommendation**

Start by removing visible overlap and small side tools. Then decide how much of a goals/analytics application GSM should be. Preserve the main loop: get game text, look up words, create an Anki card with the right audio and image, and revisit recent lines.

The largest interface simplifications do not require removing capture engines or rewriting the application. There are 34 entries in the settings catalog spread across desktop, main GSM, and overlay settings. The overlay settings HTML alone contains 165 input/select/textarea elements outside comments; these are spread across tabs and some are conditional. The web dashboard has seven primary navigation links. These counts describe interface breadth, not simultaneously visible controls.

Evidence: [settings catalog](C:/Users/Beangate/GSM/GameSentenceMiner/electron-src/renderer/src/components/tabs/settingsCatalog.ts:66), [overlay settings](C:/Users/Beangate/GSM/GameSentenceMiner/GSM_Overlay/settings.html:1380), [dashboard navigation](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/web/templates/components/navigation.html:5).

**Ranked candidates**

| Rank | Candidate | Proposed trim | What it buys / what it costs |
| --- | --- | --- | --- |
| 1 | Python and Logs as normal desktop tabs | Move them into Help / Troubleshooting; keep automatic links to logs when something fails. | Two fewer default tabs, with no loss of repair or diagnostic capabilities. Existing users who pinned them should retain access. |
| 2 | Two text-filtering editors | Keep the desktop editor with its preview, move its navigation under Capture, and replace the Python editor with a link. | Removes an entire normal tab and a duplicate editor. Both currently edit the active profile's text-processing configuration; preserve all existing rules and their ordering. |
| 3 | Floating overlay main box | Retire it from normal settings, or make it development-only. | GSM's own warning already says it is for temporary/debug use and directs people to the tray. Verify any remaining debug operations have an alternative before deleting the window implementation. |
| 4 | General window-transparency helper | Remove it from GSM or distribute it as a separate utility. | Removes a Windows helper, startup option, hotkey, and target-window settings. Users lose the ability to make arbitrary windows transparent through GSM; this is separate from normal overlay transparency. |
| 5 | Goals beyond a simple daily target | Keep today's reading target; consider retiring forecasts, trophy cabinet, and per-weekday Easy Days. | Substantial reduction in concepts and maintenance. Costs a habit-building feature set some users may value. The four principal goals API/UI files total about 7,254 physical lines, including documentation and whitespace; that is scope evidence, not an estimate of deletable lines. |
| 6 | Detailed statistics and Anki analytics | Keep time, characters, reading speed, cards mined, recent sessions, and basic game history. Put deeper reports behind an explicit advanced entry, then evaluate removing them. | Reduces long dashboards and separate destinations. Strong candidates are genre/tag rankings and the lagged learning pipeline. Costs exploratory learning analytics; preserve stored history and useful vocabulary features. |
| 7 | Longplay recording and subtitle generation | Move to an optional recording utility, or remove if it is outside GSM's intended scope. | Drops a separate recording/SRT lifecycle. It is disabled by default and is only a 310-line handler plus integration points, so the implementation savings are moderate. Keep replay-buffer capture for cards. |
| 8 | Pomodoro | Remove it, or make it an opt-in extra outside the overlay's main settings. | A clean boundary: timer state, tray controls, and work/break settings are separate from sentence mining. It is already disabled by default, so the gain is mostly less settings clutter. |
| 9 | Fragmented settings and game setup | Give users one settings entry and one per-game setup entry, with clear links to the existing owners. | High UX payoff. GSM profiles, OCR regions, hook profiles, automation, and overlay profiles have different scopes; a unified entry should explain those scopes rather than blindly merge their storage. A full Qt-to-React rewrite is unnecessary for the first pass. |
| 10 | Six tokenizer providers and navigation experiments | Offer an automatic/local default, and place provider overrides, remote credentials, dictionaries, and experimental navigation in Advanced. | Far fewer choices before someone can read. Costs easy access for power users, not the capability. Keep furigana, pinyin, offline operation, and controller navigation. |
| 11 | Translation configuration breadth | Lead with provider, model, credentials, target language, and a prompt preset. Put backup models, sampling controls, full templates, and legacy prompt toggles behind Advanced. | Reduces a large setup form while retaining translation. The AI config declares 45 annotated fields, including credentials and compatibility fields; not all are visible controls. Provider presets can share a form without pretending every provider has identical behavior. |
| 12 | Older launcher-specific UI | Consolidate the separate Steam/VN/Yuzu windows into per-game setup; remove the standalone Show Yuzu Launcher preference if that route is retired. | Reduces parallel ways to configure a game. Keep emulator hooking and launch arguments that actually enable mining. These files still have callers, so they are not all dead assets. |

Evidence for the ranked list:

1. [Default desktop navigation](C:/Users/Beangate/GSM/GameSentenceMiner/electron-src/renderer/src/App.tsx:35), [default visible tabs](C:/Users/Beangate/GSM/GameSentenceMiner/electron-src/renderer/src/components/tabs/SettingsTab.tsx:58).
2. [Desktop filtering editor](C:/Users/Beangate/GSM/GameSentenceMiner/electron-src/renderer/src/components/tabs/TextProcessingTab.tsx:176), [active-profile config access](C:/Users/Beangate/GSM/GameSentenceMiner/electron-src/main/ui/textprocess.ts:65), [Python filtering editor](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/ui/config/tabs/text_processing.py:1).
3. [Main-box warning](C:/Users/Beangate/GSM/GameSentenceMiner/GSM_Overlay/settings.html:2810), [startup option](C:/Users/Beangate/GSM/GameSentenceMiner/GSM_Overlay/settings.html:1653).
4. [Transparency settings](C:/Users/Beangate/GSM/GameSentenceMiner/electron-src/renderer/src/components/tabs/SettingsTab.tsx:1417), [helper](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/tools/window_transparency.py:1).
5. [Forecasts and trophies](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/web/templates/goals.html:95), [Easy Days](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/web/templates/goals.html:472), [goals API](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/web/goals_api.py:1).
6. [Genre/tag statistics](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/web/templates/stats.html:274), [Anki learning pipeline](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/web/templates/anki_stats.html:404).
7. [Longplay settings](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/ui/config/tabs/features.py:37), [recording handler](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/longplay_handler.py:17).
8. [Pomodoro controls](C:/Users/Beangate/GSM/GameSentenceMiner/GSM_Overlay/settings.html:1617).
9. [Settings owners](C:/Users/Beangate/GSM/GameSentenceMiner/electron-src/renderer/src/components/tabs/settingsCatalog.ts:23), [GSM profile editor](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/ui/config/tabs/profiles.py:15), [overlay profiles](C:/Users/Beangate/GSM/GameSentenceMiner/GSM_Overlay/settings.html:2760), [game automation](C:/Users/Beangate/GSM/GameSentenceMiner/electron-src/renderer/src/components/tabs/GameAutomationTab.tsx:981).
10. [Tokenizer choices](C:/Users/Beangate/GSM/GameSentenceMiner/GSM_Overlay/settings.html:1963), [navigation experiments](C:/Users/Beangate/GSM/GameSentenceMiner/GSM_Overlay/settings.html:2588).
11. [AI configuration](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/util/config/configuration.py:1363), [prompt customization](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/ui/config/tabs/ai.py:389).
12. [Launcher preference](C:/Users/Beangate/GSM/GameSentenceMiner/electron-src/renderer/src/components/tabs/SettingsTab.tsx:1284), [Yuzu launcher](C:/Users/Beangate/GSM/GameSentenceMiner/electron-src/main/ui/yuzu.ts:1).

**Secondary candidates**

| Candidate | Recommendation | Reason |
| --- | --- | --- |
| Discord Rich Presence | Move into an opt-in Integrations area; consider removing only if it is outside the product's scope. | Peripheral to mining, but relatively small: a 231-line manager plus UI. It is a weaker first cut than the larger interface overlaps. |
| Tadoku and Kechimochi sync | Collapse their full forms until enabled; group them under Integrations. | Both settings cards are included on the Tools page. Useful to their users, but everyone does not need to see their setup. A new plugin framework would be excessive just to hide two forms. |
| Character-name and frequency dictionary exporters | Put them under Advanced Tools or Integrations. | They add separate dictionary-generation workflows to a general maintenance page. Keep game metadata and tokenization that other features use. |
| Screenshot/audio/VAD tuning | Expose useful presets first; hide codecs, raw FFmpeg options, fallback models, and fine timing parameters until requested. | These features support the core mining loop, so simplify their setup rather than removing capture quality options indiscriminately. |
| Alternate application icons | Low-priority trim or optional asset pack. | Cosmetic choice and some duplicated image weight, but little conceptual complexity compared with the settings and dashboards. |

Evidence: [Discord manager](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/util/clients/discord_rpc.py:25), [sync cards included in Tools](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/web/templates/database.html:332), [dictionary exporters](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/web/templates/database.html:123), [screenshot settings](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/ui/config/tabs/screenshot.py:12), [VAD settings](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/ui/config/tabs/vad.py:12).

**Cleanup that does not require cutting useful product features**

| Candidate | Evidence and likely benefit | Qualification |
| --- | --- | --- |
| Changelog media | The tracked changelog tree is 66.30 MiB; `speechrecog.avif` alone is 51.06 MiB. Re-encode it, ship a poster, or load historical demos on demand. | The assets are included through packaging. These are raw bytes, not measured installer savings. Text release notes can stay. |
| Old OBS module | `obs_old.py` has 3,101 lines. The repository's own SonarQube notes call it a dead module; active OBS integration lives in the `obs` package. | I found a reference in an ignored manual `obs/test.py`, but no tracked runtime consumer. Remove or relocate that manual probe along with cleanup and verify imports. |
| Upstream OCR snapshot | `ocr_upstream.py` has 2,597 lines and no named reference in the tracked source search. | Likely reference material; move outside the shipped Python package if it is still useful. Check dynamic loading before deletion. |
| Old RapidOCR model | A 9.32 MiB PP-OCRv4 model is tracked. The current RapidOCR constructor selects PP-OCRv5 models; no tracked literal reference to the old filename was found. | A strong removal candidate, pending a focused check for external configuration or implicit model discovery. |
| Broad legacy asset copying | The legacy sync copies the entire Electron asset tree; packaging also copies the original asset tree, with limited exclusions. | Replace blanket copying with a list of assets actually needed by remaining HTML pages. Some legacy pages are still opened from current code. Inspect the packaged output to measure duplication. |
| Tracked temporary captures | Four files under `temp/` total 7.84 MiB, including screenshots and a diagnostic archive. | Repository housekeeping, not a demonstrated installer or UI improvement. Removing tracked files does not shrink existing Git history. |
| Deprecated Anki word sync | The scheduler's old word-sync task explicitly returns a skipped/deprecated result; card sync supersedes it. | Remove the old implementation after checking callers, but retain the migration that disables old scheduled rows. |

Evidence: [changelog animation](C:/Users/Beangate/GSM/GameSentenceMiner/electron-src/assets/changelog/images/2026.9.0/speechrecog.avif), [packaging rules](C:/Users/Beangate/GSM/GameSentenceMiner/package.json:45), [OBS cleanup note](C:/Users/Beangate/GSM/GameSentenceMiner/docs/SONARQUBE_FIXES.md:64), [old OBS code](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/obs_old.py:1), [upstream OCR snapshot](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/owocr/owocr/ocr_upstream.py:1), [current RapidOCR constructor](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/owocr/owocr/ocr.py:4798), [asset copying](C:/Users/Beangate/GSM/GameSentenceMiner/electron-src/renderer/scripts/sync-legacy-assets.mjs:21), [deprecated scheduler task](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/util/cron/run_crons.py:137).

**Areas I would preserve in the first pass**

- OCR and text-hook alternatives: they provide game/platform compatibility. OCR already has a basic mode, so counting 12 possible main engines overstates the choices facing a new user. Keep the simple default and treat rarely used engines as later maintenance decisions.
- Controller navigation, furigana/pinyin, history, and Anki confirmation: these directly help people read and mine. Simplify their advanced settings first.
- MeCab: its tracked tree is 78.85 MiB, but it is an active local tokenizer and fallback used for card furigana. On-demand installation is plausible; blind deletion is not.
- PyQt and faster-whisper: Qt still supplies active settings, selectors, and confirmation dialogs. Faster-whisper also supplies Silero VAD; it is not merely a speech-recognition add-on.
- Speech recognition: it is already hidden by default, so removing it would give less immediate UI relief than removing Python and Logs from the default navigation.
- Hachidori/Yomitan: these are selectable dictionary readers. Choosing only one would be a deliberate product decision with user-visible tradeoffs. Keep one default and avoid making everyone configure both. Jiten also provides distinct highlighting/grading behavior.
- GSM Cloud preview: its settings tab is already gated. Encrypted device sync and statistics-export integrations are different features; do not count them as equivalent duplicates.
- Data migrations, backups, game archives, and core tests: they protect existing collections. Retiring a UI should preserve stored user data and the ability to upgrade.
- A second bundled Electron runtime is not an established saving here: overlay staging copies resources and current launch code reuses the main runtime.

Evidence: [OCR basic mode](C:/Users/Beangate/GSM/GameSentenceMiner/electron-src/renderer/src/components/tabs/OCRTab.tsx:1177), [tokenizer fallback](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/tokenizer/__init__.py:91), [Silero dependency](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/vad.py:998), [cloud preview gate](C:/Users/Beangate/GSM/GameSentenceMiner/GameSentenceMiner/util/config/configuration.py:74), [reader selection](C:/Users/Beangate/GSM/GameSentenceMiner/GSM_Overlay/dictionary_reader.js:17), [shared overlay runtime](C:/Users/Beangate/GSM/GameSentenceMiner/electron-src/main/ui/front.ts:384).

**A practical first batch**

1. Move Python and Logs into Troubleshooting, and text processing under Capture.
2. Choose one text-filtering editor and make the other entry a link.
3. Remove normal-user access to the floating debug box and window-transparency utility.
4. Collapse opt-in integrations and advanced overlay/provider settings.
5. Make a separate product decision on Goals and advanced analytics; those offer the largest substantive feature reduction.
6. Clean old code and shipped media independently, with focused checks before removing candidate files.

This audit added only this report. It did not change application behavior, run a new build, or restart GSM.
