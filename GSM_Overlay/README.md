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

# Acknowledgement
- [Original Project](https://github.com/Saplling/transparent-texthooker-overlay)
- [Yomitan](https://github.com/yomidevs/yomitan)
- [Yomininja](https://github.com/matt-m-o/YomiNinja) (rip)
