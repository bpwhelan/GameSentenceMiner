// SPDX-License-Identifier: GPL-3.0-or-later

// A narrow request/result contract for an embedding host. Browser mode keeps
// using the service worker and chrome.tabs.create; overlay mode uses this only
// after external-links.js has normalized the URL.
(function () {
  "use strict";

  const REQUEST_EVENT = "hachidori-open-external";
  const RESULT_EVENT = "hachidori-open-external-result";
  const DEFAULT_TIMEOUT_MS = 5000;
  let nextRequestId = 0;

  function requestId(windowRef) {
    if (typeof windowRef.crypto?.randomUUID === "function") return windowRef.crypto.randomUUID();
    nextRequestId += 1;
    return `hachidori-external-${Date.now().toString(36)}-${nextRequestId.toString(36)}`;
  }

  function open(windowRef, value, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const url = globalThis.HDExternalLinks.normaliseExternalUrl(value?.url);
    if (!url) return Promise.reject(new TypeError("external link URL is invalid"));
    const active = value?.active === undefined ? true : value.active;
    if (typeof active !== "boolean") {
      return Promise.reject(new TypeError("external link activation is invalid"));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      return Promise.reject(new TypeError("external link timeout is invalid"));
    }

    const id = requestId(windowRef);
    return new Promise((resolve, reject) => {
      let timer = null;
      const finish = (callback, result) => {
        if (timer !== null) windowRef.clearTimeout(timer);
        windowRef.removeEventListener(RESULT_EVENT, onResult);
        callback(result);
      };
      const onResult = (event) => {
        const detail = event?.detail;
        if (!detail || detail.requestId !== id) return;
        if (detail.ok === true) {
          finish(resolve, { opened: true });
          return;
        }
        const message = typeof detail.error === "string" && detail.error
          ? detail.error : "the overlay host could not open the link";
        finish(reject, new Error(message));
      };
      windowRef.addEventListener(RESULT_EVENT, onResult);
      timer = windowRef.setTimeout(() => {
        finish(reject, new Error("the overlay host did not answer the external link request"));
      }, timeoutMs);
      windowRef.dispatchEvent(new windowRef.CustomEvent(REQUEST_EVENT, {
        detail: { requestId: id, url, active },
      }));
    });
  }

  globalThis.HDExternalLinkHost = Object.freeze({
    REQUEST_EVENT,
    RESULT_EVENT,
    open,
  });
})();
