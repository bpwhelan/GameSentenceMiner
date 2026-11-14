// This window can call only its own Agent session. No Node/Electron bridge.
(() => {
  const token = __GSM_AGENT_TOKEN__, session = __GSM_AGENT_SESSION__;
  const handlers = new Map();
  const decode = value => value?.type === 'Buffer' && Array.isArray(value.data) ? Uint8Array.from(value.data) : Array.isArray(value) ? value.map(decode) : value;
  const call = (method, func, args) => window.__TAURI_INTERNALS__.invoke('agent_ui_call', { token, session, method, func: String(func), args }).then(decode);
  window.__GSM_AGENT_EVENT__ = payload => {
    if (payload?.sessionId !== session || !Array.isArray(payload.args)) return;
    for (const handler of handlers.get(payload.func) || []) {
      try { handler(...payload.args); } catch (error) { console.error(error); }
    }
  };
  window.rpc = {
    exports: new Proxy({}, { get: (_target, name) => (...args) => call('rpcCall', name, args) }),
    on(name, handler) {
      const key = String(name), list = handlers.get(key) || [];
      list.push(handler); handlers.set(key, list);
    },
    send: (name, ...args) => call('rpcSend', name, args),
  };
})();
