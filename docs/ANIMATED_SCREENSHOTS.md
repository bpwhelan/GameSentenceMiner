# Animated screenshots

In **Screenshot → Animated Screenshot Settings**, enable **Animated** to save an animated AVIF in the card's picture field.

**Target size (KB)** is an approximate file size budget. Set it to 0 (Off) to retain the configured FPS, width, and quality, or the existing duration-based **Adaptive compact AVIF** behavior. A positive target takes precedence over duration-based reductions. One KB is 1,024 bytes.

GSM encodes short samples from the beginning, middle, and end of the selected time range, using the same crop and filters as the final animation. It estimates the full clip's size and reduces settings only as needed:

- **Prefer FPS** reduces image quality, then width, before lowering FPS.
- **Prefer quality** lowers FPS before reducing image quality and width.
- **Balanced** reduces FPS, image quality, and width together.

The configured FPS, width, and quality are starting limits. Sampling adds encoding time. Very small targets can reach the minimum settings and still be exceeded; scene changes and compression also mean that final size can differ from the estimate. If the encoder falls back, GSM estimates again with that encoder. Changing the confirmed time range also triggers a new estimate from the source video.

**Only animate voiced lines** uses an animation when GSM detects speech in the game audio and the audio is kept. Unvoiced prose uses the normal still screenshot settings. This requires voice detection; disabled or unavailable VAD, raw audio retained after a failed detection, and TTS fallback do not qualify as detected game speech. Changes to the selected dialogue or audio choice in the confirmation dialog are checked again. The option is off by default.
