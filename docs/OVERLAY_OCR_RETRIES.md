# Overlay OCR retries

Enable **Adaptive OCR Retries (Experimental)** in **Overlay Settings → Capture → OCR / Capture** to try faster handling of text that appears gradually. The setting is saved with the active GSM profile as `overlay.adaptive_ocr_retries` and defaults to `false`, including for existing profiles.

With the option off, text-bearing local OCR passes keep their one-second retry delay and normal attempt limit. Empty initial results use the existing 100 ms fallback. **Text Appears Instantly** retains its existing early-exit behavior and takes precedence over adaptive retries. Sources that already request a single pass, including ordinary periodic scans and OCR-originated text, still run once.

With adaptive retries enabled:

- The first uncertain pass schedules a 100 ms retry. Clear growth schedules a 10 ms retry; time spent processing and sending the result counts toward that delay. Every retry captures a fresh image and yields to allow cancellation by newer text.
- Growth means the normalized result contains every previous character in order, with new characters inserted. This handles dialogue expanding before static footer text or across several lines. Width, whitespace, and punctuation differences are normalized away. Substitutions, unrelated changes, shrinking text, and blank/failed reads use the uncertain cadence.
- Uncertain passes back off through 100, 200, 400, 800, and 1,000 ms. Clear growth resets this backoff.
- An exact match to the full normalized known sentence can finish immediately, after safe OCR corrections. Adaptive mode does not use fuzzy similarity to finish early: an incomplete sentence can score highly when speaker names or HUD text pad the OCR result. Otherwise, consecutive agreement requires the normalized text to remain unchanged across captures spanning at least one second. This also lets persistent OCR misreads settle without requiring an exact match.
- Rapid passes share a bounded window instead of consuming the normal attempt count. The default five-attempt request gives four seconds after the first OCR call completes. An OCR call already in flight can finish after that deadline; further retries do not start. The latest delivered local-only result receives the final marker even if the window ends during a send or after empty results.

The option affects local OCR passes, including preliminary local passes before Google Lens. It does not repeat Lens requests or alter native coordinate conversion. It may increase CPU use while text expands. Retry orchestration remains in `GameSentenceMiner/util/overlay/get_overlay_coords.py`; the adaptive progress state is in `GameSentenceMiner/util/overlay/ocr_retry.py`.
