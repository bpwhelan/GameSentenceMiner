// Presentation adapter only. Capture, OCR, layout and scheduling live in Tauri.
function createNativeOverlay({ enabled, getWindow, call, report = console.error }) {
  let pending = Promise.resolve();
  let label = null;
  let disposed = false;
  const submit = message => {
    const window = getWindow();
    if (window && !window.isDestroyed()) label = window.label;
    if (!label) return pending;
    const target = label;
    pending = pending.then(() => call('overlay.command', { label: target, message }))
      .catch(error => report('Native overlay failed:', error));
    return pending;
  };
  return {
    receive(source, message) {
      if (!enabled || message?.type !== 'native-overlay-command') return false;
      if (disposed) return true;
      // The control and data sockets receive the same broadcast. Submit once.
      if (source === 'ws2') void submit(message);
      return true;
    },
    stop() { return enabled && label ? submit({action:'stop'}) : Promise.resolve(); },
    destroy() { disposed = true; return this.stop(); },
  };
}
module.exports = {createNativeOverlay};
