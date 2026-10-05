/*
 * Dictionary uploads into this Hachidori: a linked browser, or an app driving
 * one, sends a Yomitan ZIP as hd_import_begin, sequential hd_import_chunk
 * frames and hd_import_commit. The bytes wait in the offscreen document (a
 * service worker cannot make the blob: URL the engine imports from); commit
 * runs the ordinary local import with a decision built from `replace`.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { encodeBase64 } from "./base64.js";
import { dictionaryImportMatches, dictionaryImportTarget } from "./dictionary-import.js";

// Raw bytes per chunk: about 1.4 MB of base64 in one relay frame.
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;
// An upload with no chunk for this long is abandoned.
export const UPLOAD_IDLE_MS = 2 * 60 * 1000;
// The engine refuses an import while another dictionary change runs; the
// upload then stays open so the sender can commit it again.
export const ENGINE_BUSY_CODE = "engine-mutating";

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function decodedLength(data) {
  if (!BASE64.test(data)) throw new Error("the dictionary upload chunk is not base64");
  const padding = data.endsWith("==") ? 2 : Number(data.endsWith("="));
  return data.length / 4 * 3 - padding;
}

// The decision a person makes in the import dialog, made for a remote sender:
// a new title installs, an installed one is replaced or kept beside the new copy.
export function uploadImportDecision(identity, dictionaries, replace) {
  const [match] = dictionaryImportMatches(identity, dictionaries);
  if (match === undefined) return { action: "install", identity, matchKind: null, target: null };
  return {
    action: replace ? "replace" : "separate",
    identity,
    matchKind: match.kind,
    target: dictionaryImportTarget(match.dictionary),
  };
}

// `store` keeps the bytes: append(token, base64, byteLength), discard(token).
// `importUpload(token, { fileName, replace })` imports a complete upload and
// returns the engine's import reply. Each upload belongs to the owner that began it.
export function createUploadHost({
  store, importUpload, idleMs = UPLOAD_IDLE_MS,
  chunkBytes = UPLOAD_CHUNK_BYTES, randomToken = () => crypto.randomUUID(),
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  const sessions = new Map();

  function drop(token) {
    const session = sessions.get(token);
    if (session === undefined) return;
    sessions.delete(token);
    clearTimer(session.timer);
    void Promise.resolve(store.discard(token)).catch(() => {});
  }

  function arm(token, session) {
    clearTimer(session.timer);
    session.timer = setTimer(() => drop(token), idleMs);
  }

  function owned(token, owner) {
    const session = sessions.get(token);
    if (session === undefined || session.owner !== owner) {
      throw new Error("The dictionary upload is no longer open on the host. Import it again.");
    }
    return session;
  }

  function begin({ fileName, size, replace }, owner) {
    if (fileName === "" || fileName === "." || fileName === ".." || /[/\\\0]/u.test(fileName)) {
      throw new Error("The dictionary upload has no usable file name.");
    }
    if (/\.md[dx]$/iu.test(fileName)) {
      throw new Error("MDX dictionaries cannot be sent to another Hachidori. Import them on that Hachidori itself.");
    }
    if (size <= 0) throw new Error(`${fileName} is empty.`);
    const token = randomToken();
    const session = { owner, fileName, size, replace, received: 0, busy: false, timer: null };
    sessions.set(token, session);
    arm(token, session);
    return { token, chunkBytes };
  }

  async function chunk({ token, offset, data }, owner) {
    const session = owned(token, owner);
    if (session.busy || offset !== session.received) {
      drop(token);
      throw new Error(`The dictionary upload expected byte ${session.received}, not ${offset}. Import it again.`);
    }
    let length;
    try {
      length = decodedLength(data);
      if (length === 0 || length > chunkBytes || session.received + length > session.size) {
        throw new Error("the dictionary upload chunk does not fit the announced size");
      }
    } catch (error) {
      drop(token);
      throw error;
    }
    session.busy = true;
    try {
      await store.append(token, data, length);
    } catch (error) {
      drop(token);
      throw error;
    }
    session.busy = false;
    // An abort, a timeout or a disconnect may have retired it meanwhile.
    if (sessions.get(token) !== session) throw new Error("The dictionary upload was cancelled.");
    session.received += length;
    arm(token, session);
    return { received: session.received };
  }

  async function commit({ token }, owner) {
    const session = owned(token, owner);
    if (session.busy || session.received !== session.size) {
      drop(token);
      throw new Error(`The dictionary upload ended after ${session.received} of ${session.size} bytes. Import it again.`);
    }
    // From here the import belongs to the engine; a disconnect cannot cancel it.
    sessions.delete(token);
    clearTimer(session.timer);
    let reply;
    try {
      reply = await importUpload(token, { fileName: session.fileName, replace: session.replace });
    } catch (error) {
      void Promise.resolve(store.discard(token)).catch(() => {});
      throw error;
    }
    if (reply?.errorCode === ENGINE_BUSY_CODE) {
      sessions.set(token, session);
      arm(token, session);
    } else {
      void Promise.resolve(store.discard(token)).catch(() => {});
    }
    return reply;
  }

  return {
    begin,
    chunk,
    commit,
    abort({ token }, owner) {
      if (sessions.get(token)?.owner === owner) drop(token);
      return {};
    },
    // Every upload of a client that disconnected.
    dropWhere(predicate) {
      for (const [token, session] of sessions) if (predicate(session.owner)) drop(token);
    },
    size: () => sessions.size,
  };
}

// The sending side, for Settings on a linked browser or any app with a Blob.
// `send(type, fields)` answers like chrome.runtime.sendMessage; the commit
// reply is the host's import reply, report included.
export async function uploadDictionary({ blob, fileName, replace, send }) {
  const checked = async (type, fields) => {
    const reply = await send(type, fields);
    if (!reply?.ok) throw new Error(reply?.error || "The linked Hachidori refused the dictionary upload.");
    return reply;
  };
  const { token, chunkBytes } = await checked("hd_import_begin", { fileName, size: blob.size, replace });
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new Error("The linked Hachidori sent an invalid upload chunk size.");
  try {
    for (let offset = 0; offset < blob.size; offset += chunkBytes) {
      // Offsets must arrive in order, so each chunk waits for the last.
      const bytes = new Uint8Array(await blob.slice(offset, offset + chunkBytes).arrayBuffer()); // NOSONAR
      await checked("hd_import_chunk", { token, offset, data: encodeBase64(bytes) }); // NOSONAR
    }
  } catch (error) {
    await Promise.resolve(send("hd_import_abort", { token })).catch(() => {});
    throw error;
  }
  return send("hd_import_commit", { token });
}
