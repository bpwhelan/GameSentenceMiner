const path = require('node:path');

function createVnGuideHud({ BrowserWindow, getBounds, getWindowOptions = () => ({}) }) {
  let window = null;
  let state = null;
  let ready = false;
  function bounds() {
    const area = getBounds();
    const plain = state?.displayStyle === 'text';
    const height = typeof state?.loggedChoice === 'string' ? 96 : plain ? Math.min(300, area.height - 36) : state?.saveNotice ? 176 : state?.saveInstructions?.length ? 278 : 246;
    return { x: area.x + 18, y: area.y + 18, width: Math.min(plain ? 600 : 400, area.width - 36), height };
  }
  function render() {
    if (!window || window.isDestroyed() || !ready) return;
    window.setIgnoreMouseEvents(state?.displayStyle === 'text');
    window.webContents.send('vn-guide-state', state);
    if (state?.visible) {
      window.setBounds(bounds());
      reassertTopmost();
    } else window.hide();
  }
  function reassertTopmost() {
    if (!ready || !state?.visible || !window || window.isDestroyed()) return;
    window.setAlwaysOnTop(true, 'screen-saver');
    if (!window.isVisible()) window.showInactive();
    // A newly shown lookup/freeze-frame window has the same topmost level.
    // Restore the guide above it without taking focus from the game or lookup.
    if (typeof window.moveTop === 'function') {
      try { window.moveTop(); } catch { /* Not supported by every window manager. */ }
    }
  }
  function update(next) {
    state = next;
    if (next.visible && (!window || window.isDestroyed())) {
      ready = false;
      const win = new BrowserWindow({
        ...getWindowOptions(), ...bounds(), show: false, transparent: true, frame: false,
        alwaysOnTop: true, resizable: false, focusable: false, skipTaskbar: true,
        title: 'GSM VN Guide',
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'vn_guide_preload.js') },
      });
      window = win;
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', event => event.preventDefault());
      win.webContents.on('did-finish-load', () => { if (window === win) { ready = true; render(); } });
      win.on('closed', () => { if (window === win) { window = null; ready = false; } });
      void win.loadFile(path.join(__dirname, 'vn_guide_hud.html')).catch(error => console.warn('[VNGuide] Could not open guide card:', error.message));
    }
    render();
  }
  return {
    update,
    reassertTopmost,
    owns: sender => !!window && !window.isDestroyed() && sender === window.webContents,
    syncBounds: () => { if (window && !window.isDestroyed()) window.setBounds(bounds()); },
    dispose: () => { if (window && !window.isDestroyed()) window.destroy(); window = null; ready = false; },
  };
}

module.exports = { createVnGuideHud };
