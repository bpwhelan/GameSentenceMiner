// SPDX-License-Identifier: GPL-3.0-or-later

// Serialized by scripting.executeScript into a YouTube page's isolated world,
// where the page's own code cannot change what it calls: the frame YouTube's
// player shows now, as a JPEG data URL for {screenshot}. YouTube's video is
// the page's own media, so its pixels can be read, except a protected (EME)
// video's, which a canvas reads back as black. Keep this function
// self-contained: its only input is the exact reading page URL. A player that
// shows no picture, or a protected one, answers `none`, and the page gets the
// ordinary screenshot.
export function captureYouTubeFrame(expectedUrl) {
  const unavailable = reason => ({ error: `YouTube video frame: ${reason}` });
  try {
    if (window.location.href !== expectedUrl) return unavailable("the page changed before the frame was read.");
    const video = document.querySelector("#movie_player video.html5-main-video")
      ?? document.querySelector("#movie_player video");
    if (!video || video.mediaKeys || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return { none: true };
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.92) };
  } catch {
    return unavailable("the video's picture could not be read.");
  }
}
