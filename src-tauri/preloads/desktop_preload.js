(() => {
  const local = /^http:\/\/gsm(?:-yomitan|-hachidori|-jiten)?\.localhost$/.test(location.origin) || /^gsm(?:-yomitan|-hachidori|-jiten)?:$/.test(location.protocol) || (location.hostname === 'localhost' && location.port === '5173');
  if (!local) {
    // External reading pages receive a gesture-only lookup bridge, never the
    // extension's storage/network APIs or desktop IPC. Keep the nonce private.
    const lookup = window.__TAURI_INTERNALS__?.invoke.bind(window.__TAURI_INTERNALS__);
    const token = __GSM_WINDOW_TOKEN__;
    if (lookup && /^https?:$/.test(location.protocol)) window.addEventListener('click', event => {
      if (!event.isTrusted || !event.shiftKey || event.button !== 0) return;
      const selected = window.getSelection()?.toString().trim();
      const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
      const range = !caret && document.caretRangeFromPoint?.(event.clientX, event.clientY);
      const node = caret?.offsetNode || range?.startContainer;
      const offset = caret?.offset ?? range?.startOffset ?? 0;
      const context = selected || (node?.nodeType === Node.TEXT_NODE ? node.textContent.slice(offset) : '');
      const text = context.trim().slice(0, 200);
      if (!text) return;
      event.preventDefault(); event.stopPropagation();
      void lookup('dictionary_selection', {token, text, context:context.slice(0, 20000)}).catch(console.error);
    }, true);
    return;
  }
  if (/\/(?:search-frame|template-renderer)\.html$/.test(location.pathname)) return;
  if (window.ipcRenderer) return;
  const token = __GSM_WINDOW_TOKEN__;
  const nativeInvoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
  const dictionaryPage = /gsm-(?:yomitan|hachidori|jiten)/.test(location.hostname + location.protocol);
  const invoke = (command, args) => {
    if (dictionaryPage && !['dictionary_call', 'evaluation_result', 'renderer_log', 'desktop_clipboard', 'window_input'].includes(command)) return Promise.reject(Error('Dictionary pages cannot control the desktop.'));
    return nativeInvoke(command, { ...args, token });
  };
  window.__GSM_INVOKE__ = invoke;
  const listeners = new Map();
  window.__GSM_DESKTOP_DISPATCH__ = (channel, args) => {
    for (const listener of [...listeners.get(channel) || []]) {
      try { listener({ sender: null }, ...args); } catch (error) { console.error(error); }
    }
  };
  const ipcRenderer = {
    invoke: (channel, ...args) => invoke('desktop_call', { mode: 'invoke', channel, args }),
    send: (channel, ...args) => { void invoke('desktop_call', { mode: 'send', channel, args }).catch(console.error); },
    on(channel, listener) {
      const set = listeners.get(channel) || new Set(); set.add(listener); listeners.set(channel, set);
      return () => set.delete(listener);
    },
    once(channel, listener) { const off = this.on(channel, (event, ...args) => { off(); listener(event, ...args); }); },
    removeListener(channel, listener) { listeners.get(channel)?.delete(listener); },
    removeAllListeners(channel) { listeners.delete(channel); },
  };
  const clipboard = {
    readText: () => invoke('desktop_clipboard', { operation: 'read' }),
    writeText: text => invoke('desktop_clipboard', { operation: 'write', text }),
    readImage: () => invoke('desktop_clipboard', { operation: 'read-image' }),
  };
  const platform = { ipcRenderer, clipboard, contextBridge: { exposeInMainWorld: (key, value) => { window[key] = value; } } };
  window.ipcRenderer = ipcRenderer; window.clipboard = clipboard;
  window.require = name => { if (name === 'electron' || name === '#gsm/desktop') return platform; throw Error(`Unsupported renderer module: ${name}`); };
  window.gsmEnv = { platform: __GSM_PLATFORM__, shell: 'tauri' };
  if (dictionaryPage) Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{readText:clipboard.readText, writeText:clipboard.writeText}});
  window.addEventListener('keydown',event=>{
    if(!['f','g','f3','escape','f12'].includes(event.key.toLowerCase()))return;
    if(((event.ctrlKey||event.metaKey)&&['f','g'].includes(event.key.toLowerCase()))||event.key==='F3')event.preventDefault();
    void invoke('window_input',{input:{type:'keyDown',key:event.key,code:event.code,control:event.ctrlKey,meta:event.metaKey,shift:event.shiftKey,alt:event.altKey,isAutoRepeat:event.repeat}}).catch(console.error);
  },true);
  window.__GSM_NATIVE_REPLY__ = (id, result, error) => invoke('evaluation_result', { id, result, error });
  const report = (level, args) => {
    const message = args.map(value => typeof value === 'string' ? value : value instanceof Error ? `${value}\n${value.stack||''}` : (() => { try { return JSON.stringify(value); } catch { return String(value); } })()).join(' ').slice(0, 16000);
    void invoke('renderer_log', { level, message }).catch(() => {});
  };
  for (const level of ['error', 'warn', 'info']) { const original = console[level].bind(console); console[level] = (...args) => { original(...args); report(level, args); }; }
  window.addEventListener('error', event => report('error', [event.error || event.message]));
  window.addEventListener('unhandledrejection', event => report('error', [event.reason]));
})();
