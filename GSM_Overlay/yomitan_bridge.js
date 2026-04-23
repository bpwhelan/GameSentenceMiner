/*
 * GSM Overlay <-> Yomitan bridge
 *
 * This bridge uses window.postMessage to invoke Yomitan API actions exposed by
 * the GSM-patched Yomitan content script, and resolves a Promise with the
 * response payload.
 */

(() => {
  const REQUEST_TYPE = 'gsm-yomitan-api-request';
  const RESPONSE_TYPE = 'gsm-yomitan-api-response';
  const DEFAULT_TIMEOUT_MS = 2500;

  function clampTimeout(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_TIMEOUT_MS;
    return Math.max(150, Math.min(120000, Math.floor(numeric)));
  }

  class YomitanOverlayBridge {
    constructor(options = {}) {
      this._timeoutMs = clampTimeout(options.timeoutMs);
      this._nextRequestId = 1;
      this._pending = new Map();
      this._onMessage = this._onMessage.bind(this);
      window.addEventListener('message', this._onMessage, false);
    }

    destroy() {
      window.removeEventListener('message', this._onMessage, false);
      for (const { reject, timeoutId } of this._pending.values()) {
        clearTimeout(timeoutId);
        reject(new Error('Yomitan overlay bridge destroyed'));
      }
      this._pending.clear();
    }

    async invoke(action, body = {}, options = {}) {
      if (typeof action !== 'string' || action.length === 0) {
        throw new Error('Bridge action must be a non-empty string');
      }

      const requestId = `${Date.now()}-${this._nextRequestId++}`;
      const timeoutMs = clampTimeout(options.timeoutMs ?? this._timeoutMs);
      const payloadBody = (typeof body === 'object' && body !== null) ? body : {};

      return await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          this._pending.delete(requestId);
          reject(new Error(`Bridge request timed out after ${timeoutMs}ms (${action})`));
        }, timeoutMs);

        this._pending.set(requestId, { resolve, reject, timeoutId, action });
        window.postMessage({
          type: REQUEST_TYPE,
          requestId,
          action,
          body: payloadBody,
        }, '*');
      });
    }

    async yomitanVersion(options = {}) {
      return await this.invoke('yomitanVersion', {}, options);
    }

    async termEntries(term, options = {}) {
      return await this.invoke('termEntries', { term }, options);
    }

    async kanjiEntries(character, options = {}) {
      return await this.invoke('kanjiEntries', { character }, options);
    }

    async ankiFields(input, options = {}) {
      return await this.invoke('ankiFields', input || {}, options);
    }

    async tokenize(text, scanLength = 10, options = {}) {
      return await this.invoke('tokenize', { text, scanLength }, options);
    }

    async closePopups(options = {}) {
      return await this.invoke('closePopups', {}, options);
    }

    async ensureGsmCharacterDictionary(input = {}, options = {}) {
      return await this.invoke('ensureGsmCharacterDictionary', input || {}, options);
    }

    _onMessage(event) {
      if (!event || event.source !== window) return;
      const data = event.data;
      if (typeof data !== 'object' || data === null) return;
      if (data.type !== RESPONSE_TYPE) return;

      const requestId = data.requestId;
      if (typeof requestId !== 'string' && typeof requestId !== 'number') return;

      const key = String(requestId);
      const pending = this._pending.get(key);
      if (!pending) return;

      this._pending.delete(key);
      clearTimeout(pending.timeoutId);

      const statusCode = Number(data.responseStatusCode);
      const hasError = (typeof data.error === 'string' && data.error.length > 0);
      const failed = hasError || !Number.isFinite(statusCode) || statusCode >= 400;
      if (failed) {
        const message = hasError ? data.error : `Bridge request failed (${statusCode})`;
        const error = new Error(message);
        error.action = pending.action;
        error.statusCode = Number.isFinite(statusCode) ? statusCode : 500;
        error.responseData = data.data;
        pending.reject(error);
        return;
      }

      pending.resolve(data.data);
    }
  }

  const bridge = new YomitanOverlayBridge();
  window.GsmYomitanBridge = YomitanOverlayBridge;
  window.gsmYomitanBridge = bridge;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { YomitanOverlayBridge };
  }
})();
