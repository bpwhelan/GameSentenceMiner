// SPDX-License-Identifier: GPL-3.0-or-later
import { createAnkiGateway } from "./anki.js";
import { fetchAnkiIndex } from "./anki-index.js";

self.onmessage = async ({ data: source }) => {
  try {
    const gateway = createAnkiGateway();
    const invoke = (action, params, timeoutMs) =>
      gateway.invoke(action, params, source.apiKey, timeoutMs, source.url);
    self.postMessage({ rows: await fetchAnkiIndex(invoke, source) });
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
};
