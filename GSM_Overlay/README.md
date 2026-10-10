# Overview

https://github.com/bpwhelan/GameSentenceMiner

This Overlay is designed to take plaintext and coordinates output from GSM to both display in a main textbox, as well as on-screen lookups overtop of the characters on screen.

This is practically a completely different project from the original, and such, it cannot be used standalone, and should NOT be merged with the original project.

https://github.com/user-attachments/assets/c691f5d6-da86-4e1c-802f-7c410211846e

# Development
- Run `npm run dev` in `GSM_Overlay` to start Vite + Electron with hot reload for overlay HTML/CSS/JS and automatic Electron restarts for main/preload script changes.

# Custom pages
- Open **Overlay Settings → Interaction → Custom Page**, paste an `http://` or `https://` URL, and enable the option. For example, use [VN-Guide](https://kanjieater.github.io/VN-Guide/) or a specific game's walkthrough.
- While the game is available to the overlay, press **Alt+Shift+U** (configurable) to show or hide the page. **Escape** returns to the game, **Alt+Left/Right** goes back/forward, and **Ctrl+R** or **F5** reloads.
- This is off by default and loads nothing until opened. Hiding keeps your place. Closing and reopening the overlay resumes the last page visited for each configured URL, including route fragments; the website's saved progress also persists across GSM restarts. The URL and hotkey follow overlay profiles when those are enabled.

# VN Guide helper
- Open **Overlay Settings → Interaction → VN Guide**, enable the helper, and paste a specific game page from [kanjieater’s VN-Guide](https://kanjieater.github.io/VN-Guide/), or choose **Use current Custom Page**. The import button also imports the page’s route and step when present in its URL. Select a route in settings; step numbers in GSM start at 1.
- **Alt+Shift+G** toggles the top-left card, **Alt+Shift+Right** advances/confirms, and **Alt+Shift+Left** goes back/undoes. All three shortcuts are configurable. The card has Back/Next/Done buttons; settings also offer a numbered jump without revealing future choices. Completing a route stops there so you can choose the next route yourself.
- Choose automatic visibility, always-visible, or hotkey-only. Save/load instructions stay visible in automatic mode until you confirm them with **Done**. Hiding the card does not mark a step complete. The card only appears while the overlay has a usable game capture, and hides for Custom Page/Text Feed or an unavailable game.
- Detection uses the existing overlay OCR, not additional polling or uploads. It requires an exact isolated instruction plus a separate, similarly sized and aligned option, with stricter spacing for short text such as 大丈夫. Substrings, quoted dialogue, closely spaced dialogue lines, lower dialogue boxes, text hooks without coordinates, supplemental scans, and uncertain layouts do not qualify. Manual mode may require an overlay scan at the choice screen; always-visible/hotkey modes work without choice detection.
- Optional automatic advance waits for a fresh final OCR frame where the entire detected menu has disappeared. It is **tentative**: OCR cannot confirm which option was clicked. The card marks an automatic advance and **Back** undoes it. Save/load steps never advance automatically, and disabling automatic advance leaves all progression manual.
- Only VN-Guide’s `guide.json` plus ordered `route_<id>.json` / `simpleJp` format is supported. The official game page, GitHub file/folder, and raw JSON URLs work; arbitrary walkthrough sites are unsupported. Routes retain upstream order, including documented detours. Instructions and source review status come from VN-Guide; GSM does not rewrite or redistribute the guides.
- Imports are cached in `vn-guide-cache.json`, and independent per-game/route progress is saved in `vn-guide-progress.json` under the overlay data directory. Cached routes work offline. **Reload guide from source** explicitly refreshes the cache; changed instructions reset the position and show a notice. GSM’s progress is separate from the website’s local storage. Guide URL, route, display options, and shortcuts follow overlay profiles when enabled.

# Acknowledgement
- [VN-Guide by kanjieater](https://github.com/kanjieater/VN-Guide) (on-demand route data)
- [Original Project](https://github.com/Saplling/transparent-texthooker-overlay)
- [Yomitan](https://github.com/yomidevs/yomitan)
- [Yomininja](https://github.com/matt-m-o/YomiNinja) (rip)
