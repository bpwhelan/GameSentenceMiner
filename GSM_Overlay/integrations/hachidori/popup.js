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
    let styledRoot;
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
          ...level.popup.querySelectorAll('.gsm-hoshidicts-audio-menu button')])].sort((a, b) => {
          const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
          return Math.abs(ar.top - br.top) > 4 ? ar.top - br.top : ar.left - br.left;
        });
      },
      preferred: (buttons, scope) => scope === 'grading'
        ? buttons.find(button => button.dataset.rating === '3') || buttons.find(button => button.dataset.deck === 'neverForget')
        : buttons.find(button => button.dataset.action === 'add') || buttons.find(button => button.dataset.action === 'view'),
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
      destroy() { controller.destroy(); grading?.destroy(); },
    };
  }
  const api = { create, currentResult };
  if (typeof window !== 'undefined') window.GsmHachidoriPopup = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
