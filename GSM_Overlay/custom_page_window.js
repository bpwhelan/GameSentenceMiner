function normalizeCustomPageUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

// A separate persistent session keeps a guide's saved progress across launches,
// without exposing GSM's preload, Node APIs, or dictionary extensions to it.
function createCustomPageController({
  BrowserWindow, getWindowOptions, getBounds, onShow, onHide, focusWindow,
  getSavedUrl = () => '', onNavigate = () => {},
}) {
  let window = null;
  let enabled = false;
  let configuredUrl = '';
  let active = false;
  let lastUrl = '';
  let loadFailed = false;

  function isVisible() {
    return active && !!window && !window.isDestroyed() && window.isVisible();
  }

  function hide(reason = 'custom-page-hide') {
    if (!active) return;
    active = false;
    if (window && !window.isDestroyed()) window.hide();
    onHide(reason);
  }

  function dispose(reason = 'custom-page-dispose') {
    hide(reason);
    if (window && !window.isDestroyed()) window.destroy();
    window = null;
  }

  function configure(settings) {
    const nextEnabled = settings.customPageEnabled === true;
    const nextUrl = normalizeCustomPageUrl(settings.customPageUrl);
    if (!nextEnabled || nextUrl !== configuredUrl) dispose('custom-page-settings-changed');
    enabled = nextEnabled;
    configuredUrl = nextUrl;
  }

  function loadPage(url) {
    const target = normalizeCustomPageUrl(url);
    if (!target || !window || window.isDestroyed()) return;
    const win = window;
    lastUrl = target;
    loadFailed = false;
    void win.loadURL(target).catch(error => {
      if (win.isDestroyed() || window !== win || lastUrl !== target || error.code === 'ERR_ABORTED') return;
      loadFailed = true;
      const html = '<!doctype html><html><head><meta charset="utf-8"><title>Custom Page</title></head>' +
        '<body style="background:#202124;color:#eee;font:18px system-ui;padding:48px">' +
        '<h1>Could not load this page</h1><p>Check the URL and your connection.</p>' +
        '<p>Press Ctrl+R or F5 to retry, or Escape to return to your game.</p></body></html>';
      void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
    });
  }

  function createWindow() {
    const win = new BrowserWindow({
      ...getWindowOptions(),
      ...getBounds(),
      show: false,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      title: 'GSM Overlay - Custom Page',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: 'persist:gsm-custom-pages',
      },
    });
    window = win;
    win.setOpacity(0.95);
    win.on('page-title-updated', (event, title) => {
      event.preventDefault();
      win.setTitle(`GSM Overlay - ${title || 'Custom Page'}`);
    });
    win.on('close', event => {
      event.preventDefault();
      hide('custom-page-close');
    });
    win.on('closed', () => {
      hide('custom-page-closed');
      window = null;
    });
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'Escape') {
        event.preventDefault();
        hide('custom-page-escape');
      } else if (input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r')) {
        event.preventDefault();
        if (loadFailed) loadPage(lastUrl);
        else win.webContents.reload();
      } else if (input.alt && ['ArrowLeft', 'ArrowRight'].includes(input.key)) {
        event.preventDefault();
        const history = win.webContents.navigationHistory;
        if (input.key === 'ArrowLeft' && history.canGoBack()) history.goBack();
        if (input.key === 'ArrowRight' && history.canGoForward()) history.goForward();
      }
    });
    for (const eventName of ['will-navigate', 'will-redirect']) {
      win.webContents.on(eventName, (event, url) => {
        if (!normalizeCustomPageUrl(url)) event.preventDefault();
      });
    }
    const rememberPage = (url) => {
      if (window !== win || win.isDestroyed()) return;
      const target = normalizeCustomPageUrl(url);
      if (!target) return;
      lastUrl = target;
      loadFailed = false;
      onNavigate(configuredUrl, target);
    };
    win.webContents.on('did-navigate', (_event, url) => rememberPage(url));
    win.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) rememberPage(url);
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      // Walkthrough links opening a new tab stay in the same managed window.
      loadPage(url);
      return { action: 'deny' };
    });
    loadPage(normalizeCustomPageUrl(getSavedUrl(configuredUrl)) || configuredUrl);
    return win;
  }

  function toggle() {
    if (isVisible()) {
      hide('custom-page-hotkey-hide');
      return;
    }
    if (!enabled || !configuredUrl) return;
    const win = window && !window.isDestroyed() ? window : createWindow();
    win.setBounds(getBounds());
    active = true;
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
    onShow();
    win.focus();
    focusWindow(win);
  }

  function syncBounds(bounds) {
    if (window && !window.isDestroyed()) window.setBounds(bounds);
  }

  return { configure, toggle, hide, dispose, isVisible, syncBounds };
}

module.exports = { createCustomPageController, normalizeCustomPageUrl };
