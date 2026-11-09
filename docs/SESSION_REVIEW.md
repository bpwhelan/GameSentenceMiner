# Review Anki cards after a session

Open **Anki → Confirmation** in GSM settings, turn on **Enabled**, and select **After session**. Select **As soon as possible** to confirm cards during play instead. Turning off **Enabled** disables both confirmation modes.

GSM continues updating existing Anki notes with sentence audio, images, and translations while you play. It skips the immediate confirmation dialog and saves a separate review copy of the replay, nearby dialogue, audio editing context, and screenshot previews. Media reuse shortcuts are bypassed so each queued card has its own editable replay. Session review does not run field grouping.

When GSM detects that the tracked game has closed, it opens the review window after a short delay. Minimizing a tracked game does not end the session. For capture sources without a tracked window, GSM uses its existing capture activity detection. **Review pending cards now** also opens the queue, including unfinished reviews from previous launches.

On startup, a notification tells you how many cards are pending and offers a **Review cards** button. **Edit in Anki** opens the selected note in Anki's editor while keeping your unsaved review draft.

Select an expression on the left and use the usual confirmation controls on the right. **Confirm with audio** applies your edits with the selected audio; **Confirm without audio** applies them and removes the sentence audio. Sentence and translation edits, dialogue expansion, screenshot selections, audio cuts, and TTS are applied to the original Anki note. The immediate confirmation countdown is disabled in this window. Draft edits survive switching between cards while the window stays open. Closing with unsaved edits asks before discarding those edits; the original pending reviews remain saved.

The confirmation page shows these options for **After session**:

- Maximum future context lines, from 0–100; defaults to 3. Set 0 to disable extra captures.
- Autoplay audio when opening a card.
- Replay audio after generating TTS.

The immediate confirmation controls are shown only for **As soon as possible**. Session review automatically advances after confirming, removes its finished local replay/media copies, and cleans up replaced GSM media in Anki. Files referenced by another note or a note template are kept. Cleanup failures can be retried with **Retry media cleanup**. Existing profile values for these hidden behaviors are preserved.

**Keep card / remove from queue** keeps the card as it currently exists in Anki. **Delete card** asks before deleting the Anki note and all of its cards.

Pending review files are stored under `session_review` in the GSM data directory. Full replay copies retain the available audio/screenshot editing range and consume disk space until reviewed. GSM links replay files when possible and copies them when needed. Normal saved clips and configured output-folder exports are separate and are not deleted by review cleanup. Unreviewed entries never expire automatically.

For newly mined cards, GSM watches for the configured number of following dialogue lines in the same game/session. It then saves one additional replay, with a short tail for audio. This does not delay mining or upload anything to Anki. **Add next** can include those lines during review; only then does the editor use the extra replay to prepare the extended audio and make its screenshots available. Undo restores the original replay and media. The extra replay is deleted once the review finishes, even if you keep the original review files.

Following lines must reach GSM through text hooking or OCR before the mined line leaves the replay buffer. If the required lines do not arrive, capture fails, or the game/profile changes, the original review remains usable. Captured future context survives restarts; unfinished future captures are not resumed across sessions.

Confirming an unchanged card only removes its saved review from the queue. It does not contact Anki, generate or upload media, rewrite fields, or run media cleanup in Anki. This also works when Anki is closed.

Edits are saved in the background, including audio trimming and uploads. You can review and confirm other cards while saves finish. Saving cards are marked in the list and cannot be submitted twice. A failed save restores that card for retry with its draft intact, without changing the card you are currently editing. The window closes automatically when the queue is empty and every save has finished; a failed save keeps it open.

Only changed parts are processed: a sentence edit updates the sentence and its configured furigana field, while leaving audio, screenshots, video, and translation untouched. Removing audio changes only the sentence-audio field and its configured unvoiced tag. Media cleanup checks only files replaced by that edit; the other media stay in use.

Anki must be open to apply edits. Reviews are tied to the GSM profile, Anki endpoint, Anki profile, note ID, expression, and note type that created them. A failed save keeps the entry and replay for retry. GSM checks for external changes to the fields being edited and verifies the updated fields before completing a review. Review saves do not increment mined-card statistics again.
