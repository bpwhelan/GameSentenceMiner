// SPDX-License-Identifier: GPL-3.0-or-later
import { encodeVideoImage } from "./video-image.js";

globalThis.onmessage = async ({ data: { entries, width, height, options } }) => {
  try {
    const bytes = await encodeVideoImage(entries, width, height, options);
    globalThis.postMessage({ bytes }, [bytes.buffer]);
  } catch (error) { globalThis.postMessage({ error: error.message }); }
};
