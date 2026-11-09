# Overlay OCR retries

Long spooled dialogue keeps retrying while its match to the known texthook sentence improves. This works with **Adaptive OCR Retries (Experimental)** turned off or missing from an existing profile. After the normal retry limit, every new best match renews a progress window (four seconds with the default five-attempt request), and scanning continues at one-second intervals plus OCR time. A complete sentence finishes immediately; stalled progress ends the extra retries.

Enable **Adaptive OCR Retries (Experimental)** in **Overlay Settings → Capture → OCR / Capture** to opt into faster initial scans. The setting is saved with the active GSM profile as `overlay.adaptive_ocr_retries` and defaults to `false`. With it off, text-bearing local OCR passes keep their one-second retry delay, and empty initial results use the existing 100 ms fallback. The normal attempt limit still applies when the hook match does not improve, including with slow OCR or repeated blank results.

**Text Appears Instantly** retains its existing early-exit behavior and takes precedence over retry tracking. Sources that already request a single pass, including ordinary periodic scans and OCR-originated text, still run once.

In both normal and adaptive retry modes:

- Progress counts expected characters found in order, so missing endings matter and OCR substitutions can improve without increasing the text length. The first read establishes a baseline; returning to an old best after a misread or blank does not count as progress.
- An exact match to the full normalized known sentence can finish immediately, after safe OCR corrections. Progress-tracked retries do not use fuzzy similarity to finish early: an incomplete sentence can score highly when speaker names or HUD text pad the OCR result. Otherwise, consecutive agreement requires the normalized text to remain unchanged across captures spanning at least one second. After the hook match improves, agreement also waits for the progress window, allowing pauses in a slowly appearing sentence. Persistent OCR misreads can still settle without requiring an exact match.
- Extra retries stay at one-second intervals plus OCR time, even when text is growing. Every retry captures a fresh image and yields to allow cancellation by newer text.
- An OCR call already in flight can finish after the current deadline; further retries require time remaining or new match progress. The latest delivered local-only result receives the final marker even if the window ends during a send or after empty results.

With adaptive retries enabled, the initial scans also change:

- During the initial retry window, the first uncertain pass schedules a 100 ms retry. Clear growth schedules a 10 ms retry; time spent processing and sending the result counts toward that delay. Every retry captures a fresh image and yields to allow cancellation by newer text.
- Growth means the normalized result contains every previous character in order, with new characters inserted. This handles dialogue expanding before static footer text or across several lines. Width, whitespace, and punctuation differences are normalized away. Substitutions, unrelated changes, shrinking text, and blank/failed reads use the uncertain cadence.
- Uncertain passes back off through 100, 200, 400, 800, and 1,000 ms. Clear growth resets this backoff during the initial window.
- Rapid passes share an initial window instead of consuming the normal attempt count. The default five-attempt request gives four seconds after the first OCR call completes. Without an improving match to a known sentence, that remains the retry limit.

These retry behaviors affect local OCR passes, including preliminary local passes before Google Lens. They do not repeat Lens requests or alter native coordinate conversion. Aggressive initial scanning may increase CPU use while text expands. Retry orchestration remains in `GameSentenceMiner/util/overlay/get_overlay_coords.py`; the progress state is in `GameSentenceMiner/util/overlay/ocr_retry.py`.
