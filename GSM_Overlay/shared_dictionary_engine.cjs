// One Hachidori filesystem mirror per Electron session, shared by the desktop
// reader and the overlay. Both callers may arrive during the same startup.
const key = Symbol.for('gsm.hachidori.engine.hosts');
const hosts = globalThis[key] ??= new Map();
const identity = (session, extensionId) => `${session.getStoragePath()}/${extensionId}`;

function ensureHachidoriEngine(BrowserWindow, session, extensionId) {
  const id = identity(session, extensionId);
  if (hosts.has(id)) return hosts.get(id);
  const ready = (async () => {
    const window = new BrowserWindow({ show: false, width: 1, height: 1, skipTaskbar: true,
      webPreferences: { session, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    try {
      await window.loadURL(`chrome-extension://${extensionId}/gsm/engine-host.html`);
      if (await window.webContents.executeJavaScript(`(async () => {
        await import('./engine-host.js');
        return globalThis.GsmHachidoriEngineHost;
      })()`)) {
        window.destroy();
        return null; // The extension's own offscreen document owns the engine.
      }
      await window.loadURL(`chrome-extension://${extensionId}/offscreen.html`);
      window.once('closed', () => { if (hosts.get(id) === ready) hosts.delete(id); });
      return window;
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  })();
  hosts.set(id, ready);
  ready.catch(() => { if (hosts.get(id) === ready) hosts.delete(id); });
  return ready;
}

function forgetHachidoriEngine(session, extensionId) { hosts.delete(identity(session, extensionId)); }
module.exports = { ensureHachidoriEngine, forgetHachidoriEngine };
