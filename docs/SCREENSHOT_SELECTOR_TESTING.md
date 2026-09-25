# Screenshot selector verification

The selector chooses still screenshots from GSM's saved replay buffer. Each batch contains up to 25 frames sampled every 0.5 seconds. Thumbnails have an image area at least 280 pixels wide; the grid uses up to five columns, switches to fewer columns in smaller windows, and scrolls vertically instead of shrinking the images. Left/Right arrow keys or the Earlier/Later buttons move by a full batch (12.5 seconds). The first and last batches may contain fewer frames; paging never repeats sample positions or goes beyond the recording.

Each batch uses one FFmpeg decoding pass and at most one black-bar detection pass. Sampled frames are saved as lossless PNGs with fast compression before the configured final export. Two batches plus selected frames are cached, so returning to a cached page does not decode it again. Paging away cancels an obsolete decode.

Click a frame to use one screenshot immediately. Ctrl-click or Shift-click starts a collection; subsequent clicks add or remove frames until you click **Use N screenshots**. The selected frames are numbered in click order and remain selected across pages. **Clear selection** returns to single-click selection. **Return to default** restores the initial batch without clearing selected frames.

The initial batch includes the default screenshot and respects the configured beginning/middle/end timing preference. Timestamps are relative to that default. All selected images use the configured static image format, quality, dimensions, and black bar trimming. Automatic animated screenshots remain available through the existing settings; this selector only replaces them with still images.

## Manual checklist

Use a replay with visible motion and a note whose Picture field contains an image plus unrelated text or media. Also check a short replay and one with black bars.

1. Open the selector and check the 25-frame batch, half-second spacing, and marked default frame. Resize the window and select multiple images: thumbnails should remain large, with fewer columns and vertical scrolling when needed. Click a frame once with no collection active; the dialog should close and use that still image.
2. Reopen it and use Left/Right and Earlier/Later to load other batches. Check that frames do not repeat between adjacent pages and that returning loads the same batch. Keyboard paging should also work after clicking a frame or focusing a button.
3. Ctrl-click two frames, then Shift-click a frame on another page. Confirm that the selected count and tray preserve all three in click order. Return to the first page and check the numbered highlights.
4. Click a selected frame again or use its tray's Remove button. Click **Use 2 screenshots** and check that both remaining images appear in click order in the same field, preserving unrelated text and media. Repeat with the field's append policy enabled.
5. Collect frames, then use **Clear selection**. Check that highlights and the tray clear and that an ordinary click once again chooses one screenshot immediately.
6. Page rapidly while frames are loading. Old frames must not appear in a new batch, and pending frames must not be clickable. Check the partial batches and disabled navigation at both recording boundaries.
7. Collect frames, then press Escape; repeat with Cancel and the window close button. The note should not change.
8. Temporarily make the configured encoder unavailable or use an unreadable replay. An error should leave the original note untouched. Restore the encoder and retry; collected frames should still be available after an export failure.
9. Open the selector for another note. Check that the page, selected count, and frames belong to the new invocation.
10. Open from the Anki confirmation dialog while an automatic animation is pending. Choose one or several stills and confirm that those images replace the pending animation without changing sentence or audio timing.

For a picture field containing several images, GSM treats its first image tag as the screenshot being corrected. Other image tags and surrounding markup remain in place. The existing Anki field policy still controls whether the collection is appended instead. The source replay is retained through the Anki update, and exported files remain in GSM's temporary media directory for upload.
