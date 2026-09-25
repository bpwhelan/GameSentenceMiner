// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionApi } from "./browser-api.js";
import { decodeBase64 } from "./base64.js";
import { buildAnkiResourceFields } from "./anki-resources.js";
import { exportAnkiAudio } from "./anki-audio.js";
import { MINING_CAPABILITIES } from "./overlay-mode.js";

// Resolve and parse the complete scoped note set away from the background and
// engine request threads; only compact index rows cross back to the commit.
async function refreshAnkiIndex(window, source) {
  const worker = new window.Worker(new URL("./anki-index-worker.js", import.meta.url), { type: "module" });
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve({ rows: data.rows });
      worker.onerror = event => reject(new Error(event.message || "Anki index refresh worker failed."));
      worker.postMessage(source);
    });
  } finally {
    worker.terminate();
  }
}

async function recordSpeechAudio(...args) {
  if (!MINING_CAPABILITIES.browserSpeech) {
    throw new Error("Browser text-to-speech recording is unavailable in Firefox.");
  }
  const capture = await import("./capture-host.js");
  return capture.recordSpeechAudio(...args);
}

function clientSpeechPlan(source, term) {
  return {
    sourceId: source.id,
    sourceKey: JSON.stringify(source),
    expression: term.expression,
    reading: term.reading,
  };
}

function sameClientSpeech(plan, source, term) {
  const expected = clientSpeechPlan(source, term);
  return plan && Object.entries(expected).every(([key, value]) => plan[key] === value);
}

function decodeClientSpeech(window, data) {
  return decodeBase64(data, { atob: window.atob.bind(window) });
}

function linkedSpeechRecorder(window, message) {
  if (message.clientSpeechProbe !== true && !message.clientSpeech) return recordSpeechAudio;
  return async (source, term, signal, { record = true } = {}) => {
    signal.throwIfAborted();
    const plan = clientSpeechPlan(source, term);
    if (!record || message.clientSpeechProbe === true) {
      return { recordingRequired: true, clientSpeech: plan };
    }
    const supplied = message.clientSpeech;
    if (!sameClientSpeech(supplied, source, term)) {
      throw new Error("The linked browser did not supply the requested browser speech.");
    }
    return {
      data: decodeClientSpeech(window, supplied.data),
      filename: supplied.filename,
      candidate: { name: "Linked browser speech", text: term.reading || term.expression, voice: "", index: 0 },
    };
  };
}

export function createAnkiOffscreenService(window, getAudioRepository, captureSpeech = recordSpeechAudio) {
  return async message => {
    if (message.type === "hd_anki_index_refresh") return refreshAnkiIndex(window, message.source);
    if (message.type === "hd_anki_audio") {
      return exportAnkiAudio(window, await getAudioRepository(), message, window.AbortSignal.timeout(30_000), {
        recordSpeechAudio: message.clientSpeechProbe === true || message.clientSpeech
          ? linkedSpeechRecorder(window, message)
          : captureSpeech,
      });
    }
    if (message.type !== "hd_anki_fields") throw new Error("Unknown Anki rendering request.");
    return buildAnkiResourceFields(message.request, message.templates, {
      document: window.document, dictionaryPaths: message.dictionaryPaths, audio: message.audio,
      styles: async () => {
        const reply = await extensionApi.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_styles", requestId: message.requestId });
        if (!reply.ok || reply.generation !== message.request.generation) throw new Error(reply.error || "Dictionary styles changed during Anki preparation.");
        return reply.styles;
      },
    });
  };
}
