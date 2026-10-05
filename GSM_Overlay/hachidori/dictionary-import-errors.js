// SPDX-License-Identifier: GPL-3.0-or-later

class DictionaryImportError extends Error {
  constructor(message, errorCode, cause) {
    super(message, { cause });
    this.name = "DictionaryImportError";
    this.errorCode = errorCode;
  }
}

export function isImportMemoryError(error) {
  return error?.errorCode === "import-memory"
    || error?.errno === 48
    || /bad_alloc|out of memory|not enough memory|cannot allocate memory|memory access out of bounds|failed to grow memory|could not allocate|invalid (?:array|typed array) length/iu
      .test(error?.message ?? error?.error ?? String(error));
}

export function dictionaryImportError(error, fileName, phase) {
  if (error?.name === "DictionaryImportError") return error;
  const memory = isImportMemoryError(error);
  let detail = error?.message || error?.error || String(error ?? "");
  if (detail.startsWith(`${fileName}: `)) {
    return new DictionaryImportError(detail, memory ? "import-memory" : error?.errorCode || "import-failed", error);
  }
  let advice = "";
  let errorCode = error?.errorCode || "import-failed";
  if (memory) {
    errorCode = "import-memory";
    advice = "Close other tabs or applications and enable Low memory mode in Settings → Advanced → Memory, then retry.";
  } else if (error?.name === "QuotaExceededError" || error?.errno === 51 || /no space left|disk full/iu.test(detail)) {
    errorCode = "import-storage-full";
    detail = `Dictionary storage is full or its browser quota is exhausted. ${detail}`;
    advice = "Free disk space or remove unused dictionaries, then retry.";
  } else if (error?.errno === 44) {
    detail = "A required file or directory could not be found (ENOENT).";
  } else if (error?.errno === 2 || error?.name === "NotAllowedError") {
    detail = `The browser denied access to dictionary storage. ${detail}`;
    advice = "Check that this browser allows Hachidori to use its local storage.";
  } else if (error?.errno !== undefined) {
    detail = `${detail} (filesystem errno ${error.errno})`;
  } else if (/^(?:exception|unknown error|FS error|undefined|null|\[object Object\])$/iu.test(detail) || detail === "") {
    detail = "The dictionary engine stopped without an error description.";
    advice = "Retry the import; if it still fails, report this filename and stage together with your browser and Hachidori versions.";
  }
  if (memory) detail = `The browser could not allocate enough memory. ${detail}`;
  const guidance = advice ? ` ${advice}` : "";
  return new DictionaryImportError(`${fileName}: ${phase} failed. ${detail}${guidance}`, errorCode, error);
}

// FS methods can throw a C++ exception before the guarded hdw_import call.
// Decode and release it here, while its owning module is still alive.
export function nativeImportCall(module, operation) {
  const stack = module.stackSave?.();
  try {
    return operation();
  } catch (error) {
    if (stack !== undefined) module.stackRestore(stack);
    if (typeof WebAssembly.Exception !== "function" || !(error instanceof WebAssembly.Exception)) throw error;
    let description = "The WebAssembly engine threw an exception without a description.";
    try {
      const [type, message] = module.getExceptionMessage(error);
      description = message ? `${type}: ${message}` : type;
    } finally {
      module.decrementExceptionRefcount(error);
    }
    throw new Error(description);
  }
}
