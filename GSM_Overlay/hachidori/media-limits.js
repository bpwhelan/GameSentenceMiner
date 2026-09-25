// Shared media payload limits. Firefox keeps these validators without shipping
// the Chrome-only recording and encoding implementation.
// SPDX-License-Identifier: GPL-3.0-or-later

export const MAX_LIVE_FRAME_BYTES = 64 * 1024 * 1024;
export const MAX_PINNED_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_WAV_BYTES = 1024 * 1024;
export const CAPTURE_SAMPLE_RATE = 48_000;
export const MAX_ANIMATED_AVIF_BYTES = 4 * 1024 * 1024;
