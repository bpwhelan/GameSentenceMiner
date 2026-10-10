// SPDX-License-Identifier: GPL-3.0-or-later
import { connectNetflixRecorder } from "./netflix-capture.js";

// The hidden frame netflix-content.js adds to the Netflix tab for one recording.
connectNetflixRecorder(globalThis);
