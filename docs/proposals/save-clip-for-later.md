# Proposal: Save clip for later / Clips to mine

Draft for the upstream feature request. Fork-only notes; drop this file before opening a PR.

## Problem

I don't always want to, or can, create an Anki card in the time window GSM/OBS currently gives me. For example:

- I like to play the game full screen and put the Text Feed on my tablet, so I don't have to alt-tab out of the game or play in windowed mode. I only check the Text Feed when I didn't fully understand a line. Creating cards on mobile is tedious, if even possible (Yomitan isn't available on iOS).
- Even on desktop, creating a card and tweaking the screenshot, audio trimming, etc. takes time to do properly. This takes me out of the game's immersion.
- If I don't create the card straight away, the OBS replay buffer expires and the chance to add media to the card is gone. That forces me to create cards as I play.

The Text Feed serves two purposes:

- Understand the text.
- Create a card for a vocabulary word (optional).

Sometimes I want to understand the text now but create the card later, for example after the gaming session. Today that isn't possible because the OBS buffer expires.

## Solution

- Add a "Save clip for later" option to each line in the Text Feed.
- It saves the line and its timestamps together with a video clip, so the card can be generated later without the OBS buffer's time limit.
- This removes the time pressure on card creation, lets users choose their own workflow, and lets them prioritize immersion if they prefer.

## Design notes

- **Phase 1 (fork branch `feat/clips-to-mine`):** each save writes `Output/Clips/<date>/<time>_<text>/` containing:
  - `clip.<ext>`: a lossless stream copy of the replay span, from shortly before the previous line to shortly after the next one. Same container and every audio track.
  - `manifest.json`: the selected and neighbouring lines with timestamps, the game, and the clip's end time.
- The clip is shaped like an OBS replay: its modification time is the wall-clock time of its last frame. The existing Anki flow locates lines in it the same way it does in a fresh replay, so later changes to the Anki flow apply without extra work. Verified on a real OBS replay: GSM's Anki audio extraction from the saved clip matches the original within 13ms.
- Separate from the existing "Create media folder" (Migaku helper) button, which keeps its purpose.
- **Phase 2 (same branch):** making cards from clips, with the normal Anki flow (confirmation dialog, screenshot picker, audio start/end editing) running on a temporary copy of the saved clip instead of a fresh OBS replay.
  - **Automatic:** a new card is matched in this order: checked lines, live lines in the replay window, then clips (same ranking as live lines), then the existing latest-line fallback. Clips are only consulted when nothing live matches, so every card that works today is handled as before.
  - **Manual:** a "Clips to mine" page (`/clips`, linked from the dashboard nav and the text feed) with **Enrich latest card**, which works with OBS closed and for cards synced from AnkiMobile/AnkiDroid. A mismatched sentence or existing media asks for confirmation, then rewrites the card from the clip.
  - **Safety:** clip jobs run on the same worker as live cards, so dialogs never overlap; notes enriched from a clip are skipped by the live flow.
  - Each clip records the cards made from it and stays available for more. Play serves the line's audio as MP3 (works on phones), and Delete moves the folder to the system trash, from which it can be restored.

## Demo material to capture

- Tablet: tapping "Save clip for later" on a line while the game runs full screen on the PC.
- The resulting folder, and the clip playing back.
- Phase 2: making a card from a clip after the session.
