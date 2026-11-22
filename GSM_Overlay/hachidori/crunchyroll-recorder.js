// SPDX-License-Identifier: GPL-3.0-or-later
import { connectNetflixRecorder } from "./netflix-capture.js";

// The hidden frame the Crunchyroll reader (netflix-content.js) adds to the
// Crunchyroll tab for one recording.
connectNetflixRecorder(globalThis, { port: "hachidori-crunchyroll-recorder", site: "Crunchyroll" });
