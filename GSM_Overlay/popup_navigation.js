/* Popup action selection, independent of a reader's rendering and input stack. */
(() => {
  const selectionClass = 'gsm-controller-selected';
  class PopupNavigation {
    constructor(adapter) {
      this.adapter = adapter;
      this.selected = null;
      this.scope = 'entry';
      this.active = false;
      this.revision = null;
    }
    clear() {
      this.selected?.classList.remove(selectionClass);
      this.selected = null;
    }
    buttons() {
      return this.adapter.buttons(this.scope).filter(button => this.adapter.isAvailable(button));
    }
    select(button) {
      if (button && button === this.selected) return true;
      this.clear();
      if (!button) return false;
      this.selected = button;
      button.classList.add(selectionClass);
      return true;
    }
    reset() {
      this.scope = 'entry';
      this.automatic = true;
      const buttons = this.buttons();
      return this.select(this.adapter.preferred(buttons, this.scope) || buttons[0]);
    }
    grading() {
      if (this.scope === 'grading') return true;
      if (!this.adapter.buttons('grading').some(button => this.adapter.isAvailable(button))) return false;
      this.adapter.firstEntry();
      this.scope = 'grading';
      const buttons = this.buttons();
      return this.select(this.adapter.preferred(buttons, this.scope) || buttons[0]);
    }
    refresh() {
      if (!this.active) return;
      const revision = this.adapter.revision();
      if (revision !== this.revision) {
        this.revision = revision;
        this.reset();
      } else if (!this.selected?.isConnected || this.automatic) {
        const buttons = this.buttons();
        const preferred = this.adapter.preferred(buttons, this.scope);
        // A ready preferred action can replace even a hidden/disabled provisional default.
        // Keep a busy selection when there is no preferred action to promote.
        if (preferred || !this.selected?.isConnected || this.adapter.isAvailable(this.selected)) {
          this.select(preferred || buttons[0]);
        }
      }
    }
    control(action, body = {}) {
      if (action === 'clear-action-selection') { this.active = false; this.clear(); return true; }
      this.active = true;
      if (action === 'confirm-action' || action === 'select-action') this.automatic = false;
      this.refresh();
      switch (action) {
        case 'reset-action-selection': return this.reset();
        case 'select-action': {
          this.automatic = false;
          const buttons = this.buttons();
          if (!buttons.length) return false;
          const index = buttons.indexOf(this.selected);
          return this.select(buttons[(Math.max(0, index) + (body.direction < 0 ? -1 : 1) + buttons.length) % buttons.length]);
        }
        case 'confirm-action': {
          this.automatic = false;
          // A busy/disabled control must never fall through to a different action.
          if (this.selected && !this.adapter.isAvailable(this.selected)) return false;
          if (!this.selected) this.reset();
          if (!this.selected || !this.adapter.isAvailable(this.selected)) return false;
          this.selected.click();
          return true;
        }
        case 'previous-entry':
          if (this.adapter.entryIndex() === 0 && this.grading()) return true;
          this.adapter.moveEntry(-1); return this.reset();
        case 'next-entry':
          if (this.scope === 'grading') this.adapter.firstEntry();
          else this.adapter.moveEntry(1);
          return this.reset();
        case 'scroll': {
          const scroll = this.adapter.scroller();
          if (!scroll) return false;
          const direction = body.direction < 0 ? -1 : 1;
          if (direction < 0 && scroll.scrollTop <= 0 && this.grading()) return true;
          if (direction > 0 && this.scope === 'grading') this.reset();
          const step = Math.max(10, Math.min(500, Number(body.step) || 80));
          scroll.scrollBy({ top: direction * step, behavior: 'auto' });
          return true;
        }
        default: return false;
      }
    }
    destroy() { this.active = false; this.clear(); }
  }
  if (typeof window !== 'undefined') window.GsmPopupNavigation = PopupNavigation;
  if (typeof module !== 'undefined' && module.exports) module.exports = { PopupNavigation };
})();
