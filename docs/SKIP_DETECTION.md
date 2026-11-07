# Fast-forward / skip detection

Automatic text now passes through a short stats-admission window in the text
coordinator. This detects the game rapidly producing text, not whether someone
read a sentence. Text history and manual mining remain available immediately.
Live stats, saved lines, and the downstream goals/tokenization/sync that consume
them only receive admitted text. Clean shutdown commits undecided normal text.

## Evidence

- A rolling 1.5-second window measures new alphanumeric characters after
  duplicate and overlapping-prefix handling. It requires at least 300 characters
  in total and 180 beyond the largest single contribution, spanning at least
  150 ms. A single huge page therefore does not prove skipping.
- Four substantial replacements in 750 ms, totaling at least 100 characters,
  also establish a burst. Typewriter prefix growth is not a replacement, and
  same-frame fragments alone cannot establish elapsed activity.
- On Windows, plain Ctrl held while the captured game has foreground focus is
  supporting evidence: two substantial replacements totaling 48 characters
  over at least 150 ms suffice. Ctrl alone, stationary text, AltGr, and modifier
  shortcuts do not establish skipping. Other platforms retain text detection.
- Evidence is tracked separately by source instance, within the current game.
  Transport retries and correlated duplicate observations do not add evidence.

The first buffered lines are excluded when a burst is confirmed. Exclusion is
authoritative and includes a persisted reading break, so skip time does not
become a gap credited as reading. Manual OCR and explicit manual input bypass
automatic classification. Existing text-intake pause remains authoritative.

## Overlay recovery

Suspicion pauses automatic overlay work before stats exclusion is certain.
Pause/resume control is separate from the coalescing visual mailbox, so a flood
cannot overwrite it. Old work and presence monitoring are cancelled; periodic
scans and geometry-only re-sends are held too. The explicit scan hotkey can still
request a scan.

After 1.5–2.5 seconds without new text activity (adjusted for observed flush
spacing), or when burst evidence expires as the cadence slows, a timer requests
a fresh current-screen scan even if no hook event
arrives. Cheap image comparisons first wait for a settled screen, bounded at
1.2 seconds so animated backgrounds cannot starve lookups. Normal OCR retries
handle an early blank frame. This also scans choices while Ctrl is still held;
no game-specific menu recognition is required to make them available for lookup.

VN Guide checks the current instruction and up to three upcoming choices on the
completed scan, retaining its save/load barriers. An expired “choice logged”
confirmation does not stop detection. If dimmed options are missing from OCR,
a compact hook batch received within ten seconds can corroborate the menu when
the scan independently reads an exact, isolated option above the dialogue area.
Separated options retain their boundaries; for concatenated batches, this
fallback recognizes only the visible first option or a complete final answer.
Short answers, ambiguous route matches, stale batches, and partial scans cannot
use this fallback. It adds no OCR passes and does not admit skipped text to stats.

Recovery never reuses old coordinates or requires the last hooked sentence to
remain visible. It does not use ordinary scanned-text injection. Only an exact,
normalized visible suffix of the final skipped batch (8–500 characters) can be
restored to stats, once, with a fresh timestamp. New text or a game change
invalidates that opportunity. Ambiguous landing text remains available for
lookups/mining without restoring a whole skipped batch.

## Validation against saved samples

`python -m scripts.analyze_skip_sample <path-to-gsm.db>` opens the database
read-only and reports replay classifications without exporting dialogue.
Saved rows have already been merged and filtered; they omit original fragment
timing, discarded events, and Ctrl state. The report is not a recall estimate.

The October 31 sample had four game names. Text-only replay of surviving rows
excluded 99.7% of Steins;Gate characters, 41.9% of Nekopara Vol.4, and 79.9% of
9-nine Episode 1, while Akai Ito's sparse surviving rows alone did not establish
an extreme burst. Backend logs showed the old event filter repeatedly activating
in Akai Ito and Nekopara. The new detector sees those events instead of dropping
them first, and live Ctrl evidence can support sparsely sampled skip streams.
The sample database was not edited or retroactively reclassified.

Tests cover batch volume, initial burst exclusion, prefix growth, duplicate
redraws, short dialogue, game changes, Ctrl focus, timer-only recovery, verified
landing admission, manual input, shutdown, and both stats projections.
