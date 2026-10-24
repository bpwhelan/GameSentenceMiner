const { normalizeMagpieInfo, mapCursorToMagpie } = require('./magpie');

// Owns the native Magpie session. There are no periodic mouse releases or
// topmost retries. The short timer samples input (and geometry only during a
// windowed drag); capture changes only after a current renderer hit test.
function createMagpieSession({ native, window: win, canTrackPointer, onScaling, onPointer,
  setIgnoreMouseEvents, requestRefresh, onPointerReset = () => {}, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let target = null, info = null, timer = null, dragging = false, disposed = false;
  let sequence = 0, pendingSequence = null, pendingAt = 0, lastCaptured = null, ignoring = null;
  let pointerActive = false;

  function invalidatePointer() {
    if (pointerActive) { pointerActive = false; onPointerReset(); }
    pendingSequence = null;
    lastCaptured = null;
    ignoring = null;
  }

  function update(raw, kind) {
    const next = normalizeMagpieInfo(raw);
    const changed = next?.signature !== info?.signature;
    if (info && !next && !win.isDestroyed() && canTrackPointer()) setIgnoreMouseEvents(true);
    info = next;
    if (changed) invalidatePointer();
    if (changed || kind !== 'drag') onScaling({ kind, info, sourceFocused: raw?.source_focused === true });
    if (info && !timer) timer = setIntervalFn(tick, 16);
    if (!info && timer) { clearIntervalFn(timer); timer = null; }
  }

  function refresh(kind = 'sync') { update(native.read(target), kind); }

  function notify(code, parameter) {
    if (disposed || !target || ![0, 1, 2, 3].includes(code)) return;
    dragging = code === 3;
    // A broadcast is a hint, not authority: always revalidate the visible
    // scaling window and its source instead of trusting lParam as an HWND.
    const next = native.read(target);
    if (code > 0 && next && next.scaling_hwnd !== parameter) return;
    update(next, code === 0 ? (parameter === 1 ? 'background' : 'stopped')
      : code === 1 ? 'foreground' : code === 3 ? 'drag-start' : 'geometry');
    requestRefresh();
  }

  function tick() {
    if (disposed || !info) return;
    if (dragging) refresh('drag');
    if (!info || win.isDestroyed() || !win.isVisible() || !canTrackPointer()) {
      invalidatePointer();
      return;
    }
    const cursor = native.cursor(info);
    if (!cursor) { refresh('sync'); invalidatePointer(); return; }
    // Magpie updates its style before warping the cursor. Ignore that transition
    // sample instead of treating a source coordinate as a destination hit.
    if (lastCaptured !== null && cursor.captured !== lastCaptured) {
      lastCaptured = cursor.captured;
      pendingSequence = null;
      return;
    }
    lastCaptured = cursor.captured;
    // At most one hit test in flight. A busy renderer must not perpetually lose
    // a race against a newer sequence. Expiry discards a stalled reply; it never
    // changes mouse ownership.
    if (pendingSequence !== null && Date.now() - pendingAt < 100) return;
    const point = cursor.captured ? mapCursorToMagpie(cursor, info) : cursor;
    pendingSequence = ++sequence;
    pendingAt = Date.now();
    pointerActive = true;
    onPointer({ ...cursor, sequence, x: point?.x ?? -Infinity, y: point?.y ?? -Infinity, signature: info.signature });
  }

  const unwatch = native.watch(win, notify);
  return {
    updateTarget(hwnd) {
      if (disposed) return;
      const next = Number(hwnd) || null;
      if (next !== target) { target = next; dragging = false; invalidatePointer(); }
      refresh('sync');
    },
    handleHit(reply) {
      if (disposed || win.isDestroyed()) return;
      if (!canTrackPointer() || !win.isVisible()) { invalidatePointer(); return; }
      if (!info || !reply || reply.sequence !== pendingSequence) return;
      pendingSequence = null;
      const next = reply.hit !== true;
      if (next !== ignoring) {
        // A press may have started while Chromium was answering the hit test.
        // Keep its current native recipient until all buttons are released.
        const cursor = native.cursor(info);
        if (!cursor) { refresh('sync'); return; }
        if (cursor.buttons) return;
        ignoring = next;
        setIgnoreMouseEvents(next);
      }
    },
    ownsPointer() { return !disposed && !!info && !win.isDestroyed() && win.isVisible() && canTrackPointer(); },
    invalidatePointer,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (info && !win.isDestroyed() && canTrackPointer()) setIgnoreMouseEvents(true);
      if (timer) clearIntervalFn(timer);
      timer = null;
      unwatch();
      invalidatePointer();
    },
  };
}

module.exports = { createMagpieSession };
