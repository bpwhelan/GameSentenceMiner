# Overview

https://github.com/bpwhelan/GameSentenceMiner

This Overlay is designed to take plaintext and coordinates output from GSM to both display in a main textbox, as well as on-screen lookups overtop of the characters on screen.

This is practically a completely different project from the original, and such, it cannot be used standalone, and should NOT be merged with the original project.

https://github.com/user-attachments/assets/c691f5d6-da86-4e1c-802f-7c410211846e

# Development
- Run `npm run dev` in `GSM_Overlay` to start Vite + Electron with hot reload for overlay HTML/CSS/JS and automatic Electron restarts for main/preload script changes.

# Acknowledgement
- [Original Project](https://github.com/Saplling/transparent-texthooker-overlay)
- [Yomitan](https://github.com/yomidevs/yomitan)
- [Yomininja](https://github.com/matt-m-o/YomiNinja) (rip)
- [Hoshidicts, Hoshi Reader, and Yomitan attribution](HOSHIDICTS_ATTRIBUTION.md)

# Migrating imported dictionaries (`.hoshidicts_4` → `.hoshidicts_3`)

The overlay now builds against the upstream Hoshidicts engine, which reads and
writes the `.hoshidicts_3` on-disk dictionary marker. Earlier development builds
generated a fork-only `.hoshidicts_4` marker that the upstream engine cannot
read.

If you imported dictionaries with an earlier build and see them fail to load,
delete the imported dictionary directories (or the `.hoshidicts_4` marker inside
them) and re-import the source archives through the dictionary installer. The
re-import writes the `.hoshidicts_3` marker the engine expects. No automatic
conversion is performed; this is a one-time manual step.
