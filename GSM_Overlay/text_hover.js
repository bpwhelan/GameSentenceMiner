// Hover is independent of native mouse ownership. Text can feed a dictionary
// scanner while Windows/macOS deliver the real button press to the game.
const DICTIONARY_SURFACES = 'iframe.yomitan-popup, yomitan-popup-tag-name, hachidori-host';
const CONTROLS = 'button, input, select, textarea, a[href], [contenteditable="true"], #action-panel, #font-size-popover';
const GAME_TEXT = '.text-box, .nav-char-box, .big-interactive-area, #text';

function isClickableHoverTarget(target) {
  if (!target?.closest) return false;
  if (target.closest(`${DICTIONARY_SURFACES}, ${CONTROLS}`)) return true;
  if (target.closest(GAME_TEXT)) return false;
  return !!target.closest('.interactive');
}

function createTextHoverController({ window: win, document: doc, onIgnore }) {
  let projected = false, dispatching = false, lastPoint = null, lastTarget = null;
  let lastSignature = '', interactive = false, publishedIgnore = null;
  const events = ['pointermove', 'pointerover', 'pointerout', 'pointerup',
    'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave'];

  function update(point, synthesize) {
    const { x, y } = point;
    const target = Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0
      && x < win.innerWidth && y < win.innerHeight ? doc.elementFromPoint(x, y) : null;
    // Never split a press/release between the game and the overlay, including a
    // drag from a cross-origin dictionary frame back onto the game text.
    if (!point.buttons) interactive = isClickableHoverTarget(target);
    lastPoint = point;
    if (synthesize) {
      const signature = [x, y, point.buttons || 0, !!point.shiftKey, !!point.ctrlKey, !!point.altKey, !!point.metaKey].join(':');
      if (target !== lastTarget || signature !== lastSignature) {
        const init = { bubbles: true, cancelable: true, composed: true, pointerId: 1,
          pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y,
          buttons: point.buttons || 0, shiftKey: !!point.shiftKey, ctrlKey: !!point.ctrlKey,
          altKey: !!point.altKey, metaKey: !!point.metaKey };
        dispatching = true;
        try {
          if (target !== lastTarget && lastTarget?.isConnected) {
            lastTarget.dispatchEvent(new win.PointerEvent('pointerout', { ...init, relatedTarget: target }));
            lastTarget.dispatchEvent(new win.MouseEvent('mouseout', { ...init, relatedTarget: target }));
          }
          // The popup's own frame handles its real pointer. Sending root-page
          // scans over that frame would search the page beneath the dictionary.
          if (target && !target.closest(DICTIONARY_SURFACES)) {
            if (target !== lastTarget) target.dispatchEvent(new win.PointerEvent('pointerover', { ...init, relatedTarget: lastTarget }));
            target.dispatchEvent(new win.PointerEvent('pointermove', init));
            target.dispatchEvent(new win.MouseEvent('mousemove', init));
          }
        } finally { dispatching = false; }
      }
      lastSignature = signature;
    } else if (publishedIgnore !== !interactive) {
      publishedIgnore = !interactive;
      onIgnore(publishedIgnore);
    }
    lastTarget = target;
    return interactive;
  }

  function onEvent(event) {
    if (dispatching) return;
    if (projected) {
      // Once Magpie releases capture, native enter/leave events must still
      // reach the popup frame and toolbar controls (including their ancestors).
      if (isClickableHoverTarget(event.target) && (!lastPoint?.captured
        || event.target === lastTarget || event.target.contains?.(lastTarget))) return;
      // Magpie's hardware cursor can still be in source space. The projected
      // samples below are the sole root-page hover stream during that session.
      event.stopImmediatePropagation();
      return;
    }
    if (!event.type.startsWith('pointer')) return;
    update({ x: event.clientX, y: event.clientY, buttons: event.buttons || 0 }, false);
  }
  for (const name of events) win.addEventListener(name, onEvent, true);
  return {
    project(point) { projected = true; return update(point, true); },
    refresh() {
      if (lastPoint && !projected) { publishedIgnore = null; update(lastPoint, false); }
    },
    reset() {
      if (lastTarget?.isConnected && !lastTarget.closest(DICTIONARY_SURFACES)) {
        dispatching = true;
        try {
          // Cancel a pending scan before ownership/geometry changes. This does
          // not synthesize a click or dismiss an already open dictionary.
          lastTarget.dispatchEvent(new win.PointerEvent('pointerout', {
            bubbles: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true,
          }));
        } finally { dispatching = false; }
      }
      projected = false; lastPoint = null; lastTarget = null;
      lastSignature = ''; interactive = false; publishedIgnore = null;
    },
    dispose() { for (const name of events) win.removeEventListener(name, onEvent, true); },
  };
}

module.exports = { createTextHoverController, isClickableHoverTarget };
