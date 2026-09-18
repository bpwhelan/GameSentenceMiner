// SPDX-License-Identifier: GPL-3.0-or-later
import { decodedBase64Length } from "./anki-client-media.js";

const GENERATED_MEDIA_FILENAME = /^hachidori_[0-9a-f]{64}\.[a-z0-9]+$/u;

function validatePayload(data, kind) {
  const bytes = decodedBase64Length(data);
  if (bytes === null || bytes < 1) throw new Error(`The ${kind} payload is not valid base64.`);
  return bytes;
}

async function exactMediaExists(invoke, filename) {
  const names = await invoke("getMediaFilesNames", { pattern: filename }, 10_000);
  if (!Array.isArray(names) || names.some(name => typeof name !== "string")) {
    throw new Error("Anki returned an invalid media inventory.");
  }
  return names.includes(filename);
}

function referenced(fields, filename) {
  return Object.values(fields).some(value => typeof value === "string" && value.includes(filename));
}

function requiredDictionaryMedia(resources, fields) {
  if (!Array.isArray(resources.media)) throw new Error("The planned dictionary media is invalid.");
  const required = new Map();
  for (const item of resources.media) {
    if (!item || typeof item !== "object" || typeof item.filename !== "string"
        || typeof item.dictionary !== "string" || typeof item.path !== "string") {
      throw new Error("The planned dictionary media entry is invalid.");
    }
    if (!referenced(fields, item.filename)) continue;
    const previous = required.get(item.filename);
    if (previous && (previous.dictionary !== item.dictionary || previous.path !== item.path)) {
      throw new Error(`Two dictionary resources planned the same Anki filename: ${item.filename}`);
    }
    required.set(item.filename, item);
  }
  return [...required.values()];
}

async function ensure({
  invoke,
  filename,
  kind,
  data,
  load,
  validate,
}) {
  if (!GENERATED_MEDIA_FILENAME.test(filename)) {
    throw new Error("The generated Anki media filename is invalid.");
  }
  await validate?.();
  const exists = await exactMediaExists(invoke, filename);
  await validate?.();
  if (exists) {
    return { filename, status: "existing", bytes: 0 };
  }
  const loaded = data === undefined ? await load() : { data };
  const payload = typeof loaded === "string" ? loaded : loaded?.data;
  const bytes = validatePayload(payload, kind);
  await validate?.();
  let stored;
  try {
    stored = await invoke("storeMediaFile", { filename, data: payload, deleteExisting: false }, 30_000);
  } catch (error) {
    // A timed-out acknowledgement may follow a completed write. Confirm the
    // exact deterministic name before deciding that the note cannot proceed.
    if (await exactMediaExists(invoke, filename).catch(() => false)) {
      return { filename, status: "confirmed-after-error", bytes };
    }
    throw error;
  }
  if (stored !== filename) {
    const exists = await exactMediaExists(invoke, filename);
    if (!exists) throw new Error(`Anki stored ${kind} under a different filename.`);
    return { filename, status: "existing-race", bytes };
  }
  if (!await exactMediaExists(invoke, filename)) {
    throw new Error(`Anki acknowledged ${kind} without confirming the requested media filename.`);
  }
  return { filename, status: "stored", bytes };
}

export function createAnkiMediaStore() {
  async function prepare({
    request,
    invoke,
    appliedFields,
    resources,
    media,
    validate,
  }) {
    const files = [];
    try {
      for (const item of requiredDictionaryMedia(resources, appliedFields)) {
        files.push(await ensure({
          invoke,
          filename: item.filename,
          kind: "dictionary image",
          validate,
          load: () => media(item, request.generation),
        }));
      }
      if (resources.audioPrepared && resources.audio && referenced(appliedFields, resources.audio.filename)) {
        files.push(await ensure({
          invoke,
          filename: resources.audio.filename,
          data: resources.audio.data,
          kind: "pronunciation",
          validate,
        }));
      }
    } catch (error) {
      const retained = files.length;
      if (retained > 0) {
        throw new Error(`${error.message} ${retained} confirmed media ${retained === 1 ? "file was" : "files were"} retained for a safe retry.`, { cause: error });
      }
      throw error;
    }
    resources.confirmedMedia = files.map(file => file.filename);
    return {
      files,
      required: files.length,
      existing: files.filter(file => file.status !== "stored").length,
      stored: files.filter(file => file.status === "stored").length,
      uploadedBytes: files.reduce((sum, file) => sum + (file.status === "stored" ? file.bytes : 0), 0),
    };
  }

  return { ensure, prepare };
}
