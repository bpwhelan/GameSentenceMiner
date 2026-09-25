/* Request/reply transport shared by dictionary extensions. No reader-specific API lives here. */
(() => {
  let nextInstance = 0;
  const timeout = value => Number.isFinite(Number(value))
    ? Math.max(150, Math.min(120000, Math.floor(Number(value)))) : 2500;

  class ExtensionBridge {
    constructor(options = {}) {
      this._window = options.window || window;
      this._reader = options.reader;
      this._requestType = `gsm-${this._reader}-api-request`;
      this._responseType = `gsm-${this._reader}-api-response`;
      this._timeoutMs = timeout(options.timeoutMs);
      this._prefix = `${Date.now()}-${++nextInstance}`;
      this._nextRequestId = 0;
      this._pending = new Map();
      this._destroyed = false;
      this._onMessage = this._onMessage.bind(this);
      this._window.addEventListener('message', this._onMessage);
    }

    destroy() {
      this._destroyed = true;
      this._window.removeEventListener('message', this._onMessage);
      for (const { reject, timeoutId } of this._pending.values()) {
        clearTimeout(timeoutId);
        reject(new Error(`${this._reader} overlay bridge destroyed`));
      }
      this._pending.clear();
    }

    async invoke(action, body = {}, options = {}) {
      if (this._destroyed) throw new Error(`${this._reader} overlay bridge destroyed`);
      if (typeof action !== 'string' || !action) throw new Error('Bridge action must be a non-empty string');
      const requestId = `${this._prefix}-${++this._nextRequestId}`;
      const timeoutMs = timeout(options.timeoutMs ?? this._timeoutMs);
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          this._pending.delete(requestId);
          reject(new Error(`Bridge request timed out after ${timeoutMs}ms (${action})`));
        }, timeoutMs);
        this._pending.set(requestId, { resolve, reject, timeoutId, action });
        try {
          this._window.postMessage({ type: this._requestType, requestId, action,
            body: body && typeof body === 'object' ? body : {} }, '*');
        } catch (error) {
          clearTimeout(timeoutId);
          this._pending.delete(requestId);
          reject(error);
        }
      });
    }

    _onMessage(event) {
      if (event?.source !== this._window || event.data?.type !== this._responseType) return;
      const data = event.data;
      const key = String(data.requestId);
      const pending = this._pending.get(key);
      if (!pending) return;
      this._pending.delete(key);
      clearTimeout(pending.timeoutId);
      const statusCode = Number(data.responseStatusCode);
      if (data.error || !Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 400) {
        const error = new Error(data.error || `Bridge request failed (${statusCode})`);
        Object.assign(error, { action: pending.action, statusCode, responseData: data.data });
        pending.reject(error);
      } else {
        pending.resolve(data.data);
      }
    }
  }
  if (typeof window !== 'undefined') window.GsmExtensionBridge = ExtensionBridge;
  if (typeof module !== 'undefined' && module.exports) module.exports = { ExtensionBridge };
})();
