const ALLOWED_ACTIONS = new Set(['state', 'toggle-intake', 'replay-audio']);

function createQuickActionsBridge({ getBackend, timeoutMs = 15000 }) {
  const pending = new Map();
  let sequence = 0;
  return {
    request(action) {
      if (!ALLOWED_ACTIONS.has(action)) return Promise.reject(new Error('Unknown quick action'));
      const backend = getBackend();
      if (!backend?.connected) return Promise.reject(new Error('GSM is disconnected. Try again when it is ready.'));
      const request_id = `quick-action-${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request_id); reject(new Error('GSM did not respond. Please try again.'));
        }, timeoutMs);
        pending.set(request_id, { resolve, reject, timer });
        try {
          if (!backend.sendImmediate({ type: 'quick-action-request', request_id, action })) {
            throw new Error('GSM is disconnected. Please try again.');
          }
        }
        catch (error) { clearTimeout(timer); pending.delete(request_id); reject(error); }
      });
    },
    receive(message) {
      if (message?.type !== 'quick-action-result') return false;
      const request = pending.get(message.request_id);
      if (request) {
        clearTimeout(request.timer); pending.delete(message.request_id);
        if (message.success === false) request.reject(new Error(message.error || 'Quick action failed'));
        else request.resolve(message);
      }
      return true;
    },
    destroy() {
      for (const request of pending.values()) {
        clearTimeout(request.timer); request.reject(new Error('Overlay closed'));
      }
      pending.clear();
    },
  };
}
module.exports = { createQuickActionsBridge };
