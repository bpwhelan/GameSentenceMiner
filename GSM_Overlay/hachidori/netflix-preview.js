// SPDX-License-Identifier: GPL-3.0-or-later

// Serialized by scripting.executeScript into Netflix's MAIN world. Keep this
// function self-contained: its only input is the exact reading page URL.
export async function captureNetflixPreview(expectedUrl) {
  const unavailable = reason => ({ error: `Netflix preview screenshot: ${reason}` });
  try {
    if (window.location.href !== expectedUrl) return unavailable("the episode changed before the preview was read.");
    const movieId = /^\/watch\/(\d+)$/u.exec(new URL(expectedUrl).pathname)?.[1];
    const watchPlayer = () => {
      const api = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
      const candidates = (api?.getAllPlayerSessionIds?.() ?? [])
        .filter(id => typeof id === "string" && id.startsWith("watch"))
        .map(id => ({ sessionId: id, player: api.getVideoPlayerBySessionId?.(id) }))
        .filter(({ player }) => typeof player?.getMovieId === "function" && String(player.getMovieId()) === movieId);
      const root = document.querySelector(".watch-video");
      const attached = candidates.filter(({ player }) => typeof player.getElement === "function" && root?.contains(player.getElement()));
      if (attached.length > 0) return attached.length === 1 ? attached[0] : null;
      return candidates.length === 1 && typeof candidates[0].player.getElement !== "function" ? candidates[0] : null;
    };
    const { sessionId, player } = watchPlayer() ?? {};
    if (typeof player?.getTrickPlayFrame !== "function") return unavailable("this player has no seek preview image.");
    const video = document.querySelector(".watch-video video") ?? document.querySelector("video");
    const time = typeof player.getCurrentTime === "function" ? player.getCurrentTime() : video?.currentTime * 1000;
    if (!Number.isFinite(time) || time < 0) return unavailable("the playback time is unavailable.");
    const frame = await player.getTrickPlayFrame(time);
    const current = watchPlayer();
    if (window.location.href !== expectedUrl || current?.sessionId !== sessionId || current.player !== player) {
      return unavailable("the episode or player changed while the preview was read.");
    }
    const image = frame?.image;
    let bytes = image;
    if (image instanceof ArrayBuffer) bytes = new Uint8Array(image);
    else if (ArrayBuffer.isView(image)) bytes = new Uint8Array(image.buffer, image.byteOffset, image.byteLength);
    if (bytes == null || typeof bytes[Symbol.iterator] !== "function") return unavailable("the seek preview image is unavailable.");
    let binary = "";
    for (const byte of bytes) {
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) return unavailable("the seek preview contains invalid image bytes.");
      binary += String.fromCodePoint(byte);
    }
    if (!binary.startsWith("\xff\xd8\xff")) return unavailable("the seek preview is not a JPEG image.");
    return { dataUrl: `data:image/jpeg;base64,${btoa(binary)}` };
  } catch {
    return unavailable("Netflix could not provide its seek preview image. Reload the episode and try again.");
  }
}
