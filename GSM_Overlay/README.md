# Overview

https://github.com/bpwhelan/GameSentenceMiner

This Overlay is designed to take plaintext and coordinates output from GSM to both display in a main textbox, as well as on-screen lookups overtop of the characters on screen.

This is practically a completely different project from the original, and such, it cannot be used standalone, and should NOT be merged with the original project.

https://github.com/user-attachments/assets/c691f5d6-da86-4e1c-802f-7c410211846e

# Development
- Run `npm run dev` in `GSM_Overlay` to start Vite + Electron with hot reload for overlay HTML/CSS/JS and automatic Electron restarts for main/preload script changes.

## Hachidori browser speech

The synced Hachidori extension enables `EMBEDDED_SPEECH_CAPTURE`. GSM owns a
hidden `speech-capture.html` extension window, grants display media only to that
exact active Hachidori frame, and exposes bounded speech synthesis through its
preload. For an eSpeak or eSpeak NG browser voice, GSM exports the matching
system voice as 16-bit PCM WAV, Hachidori plays those exact bytes, stores them
through AnkiConnect, and writes the resulting `[sound:...]` reference into the
configured note field.

Other browser voices fall back to capture of the dedicated frame's audio. If
Electron cannot provide audible frame bytes, mining fails before creating or
updating a note. Audible Web Speech playback alone is never reported as an
attachment. The capture processor writes silence through a zero-gain keepalive
node so its input cannot be echoed back into the frame.

Sync Hachidori from its source checkout instead of editing `hachidori/`:

```sh
node ../scripts/sync-hachidori.mjs /path/to/hachidori
```

Focused host tests run with `npm test`. The real Electron and Anki acceptance
harness is `npm run test:hachidori-tts-electron -- fixed`; its required
executable and evidence paths are supplied through the
`GSM_HACHIDORI_TTS_*` environment variables documented by the runner.

# Acknowledgement
- [Original Project](https://github.com/Saplling/transparent-texthooker-overlay)
- [Yomitan](https://github.com/yomidevs/yomitan)
- [Yomininja](https://github.com/matt-m-o/YomiNinja) (rip)
