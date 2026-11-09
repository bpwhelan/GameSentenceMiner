// SPDX-License-Identifier: GPL-3.0-or-later
import { connectNetflixRecorder } from "./netflix-capture.js";

// The hidden frame the YouTube reader (netflix-content.js) adds to the YouTube
// tab for one recording.
connectNetflixRecorder(globalThis, { port: "hachidori-youtube-recorder", site: "YouTube" });
