/* Maps Hachidori's view objects into the shared popup navigation controller. */
(() => {
  function currentResult(level) {
    const index = level?.view?.currentEntryIndex() ?? 0;
    // Dictionary tabs can project/reorder results. Use the rendered entry's binding.
    return level?.entryAudio?.[index]?.result || level?.entryMining?.[index]?.result || null;
  }
  function create(api, { window, document }) {
    const current = () => api.state().levels.findLast(level => level.popup && !level.popup.hidden && !level.retired);
    const available = button => button?.isConnected && !button.disabled && !button.closest('[hidden]')
      && button.getClientRects().length > 0 && window.getComputedStyle(button).visibility !== 'hidden';
    let styledRoot, observedPopup;
    const identities = new WeakMap();
    let nextIdentity = 0;
    const controller = new window.GsmPopupNavigation({
      revision: () => {
        const level = current();
        if (!level) return null;
        if (!identities.has(level)) identities.set(level, ++nextIdentity);
        return `${identities.get(level)}:${level.lookupToken}:${level.view.currentEntryIndex()}`;
      },
      entryIndex: () => current()?.view.currentEntryIndex() ?? 0,
      moveEntry: offset => current()?.view.focusEntry({ offset }),
      firstEntry: () => current()?.view.focusEntry('first'),
      scroller: () => current()?.view.scrollElement,
      isAvailable: available,
      buttons(scope) {
        const level = current();
        if (!level) return [];
        if (scope === 'grading') return grading?.buttons(level) || [];
        const index = level.view.currentEntryIndex();
        const actions = level.entryMining?.[index]?.actions;
        const audio = level.entryAudio?.[index]?.button;
        return [...new Set([...(actions?.querySelectorAll('button') || []), ...(audio ? [audio] : []),
          ...level.popup.querySelectorAll('.gsm-hoshidicts-audio-menu button')])];
      },
      // Default selection uses action identity, not screen order. Sorting during
      // readiness/render callbacks forced layout of each new word's definitions.
      orderButtons(buttons) {
        return buttons.map(button => ({ button, rect: button.getBoundingClientRect() }))
          .sort(({ rect: a }, { rect: b }) => Math.abs(a.top - b.top) > 4 ? a.top - b.top : a.left - b.left)
          .map(({ button }) => button);
      },
      preferred: (buttons, scope) => scope === 'grading'
        ? buttons.find(button => button.dataset.rating === '3') || buttons.find(button => button.dataset.deck === 'neverForget')
        : buttons.find(button => button.dataset.action === 'add') || buttons.find(button => button.dataset.action === 'view'),
    });
    // An entry's Anki check can finish without a layout/lifecycle callback.
    // Track readiness directly, independently of audio and other entries' checks.
    const observer = new window.MutationObserver(changes => {
      if (!controller.active) return;
      const level = current();
      if (!level) return;
      const controls = [
        ...(level.entryMining || []).map(entry => entry?.actions),
        ...(level.entryAudio || []).map(entry => entry?.button),
        ...(grading?.buttons(level) || []),
        controller.selected,
      ].filter(Boolean);
      // Glossaries, images and deferred definitions share the popup subtree.
      // Only action readiness/replacement can change the controller default.
      const relevant = changes.some(change => controls.some(control =>
        control.contains(change.target)
        || (change.type === 'attributes' && change.target.contains(control))
        || (change.type === 'childList' && [...change.addedNodes, ...change.removedNodes]
          .some(node => node.contains(control)))));
      if (relevant) controller.refresh();
    });
    const grading = window.GsmJitenGradingBar ? new window.GsmJitenGradingBar({ window, document,
      getHeadword: level => {
        const result = currentResult(level);
        return result?.term ? { term: result.term.expression, reading: result.term.reading || '' } : null;
      },
    }) : null;
    return {
      control: (action, body) => controller.control(action, body),
      refresh() {
        const level = current();
        if (level?.popup !== observedPopup) {
          observer.disconnect();
          observedPopup = level?.popup;
          if (observedPopup) observer.observe(observedPopup, { subtree: true, childList: true,
            attributes: true, attributeFilter: ['disabled', 'hidden', 'data-action'] });
        }
        if (level) {
          const root = level.popup.getRootNode();
          if (root !== styledRoot) {
            const style = document.createElement('style');
            style.textContent = '.gsm-controller-selected { outline: 2px solid #00ffa8 !important; outline-offset: 2px !important; }';
            root.appendChild(style); styledRoot = root;
          }
          grading?.refresh(level, level.view.scrollElement);
        }
        controller.refresh();
      },
      destroy() { observer.disconnect(); controller.destroy(); grading?.destroy(); },
    };
  }
  const api = { create, currentResult };
  if (typeof window !== 'undefined') window.GsmHachidoriPopup = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
