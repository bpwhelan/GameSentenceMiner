(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.GSMQuickActions = api;
}(typeof window !== 'undefined' ? window : globalThis, function () {
  const DEFAULT_ACTIONS = ['pause-input', 'replay-audio', 'furigana', 'translate-menu'];
  const STUDY_ACTIONS = [
    { id: 'translation', label: 'Translate / show translation' },
    { id: 'sentence', label: 'Sentence breakdown' },
    { id: 'grammar', label: 'Grammar' },
    { id: 'vocabulary', label: 'Vocabulary' },
    { id: 'nuance', label: 'Nuance and tone' },
    { id: 'context', label: 'Scene summary' },
    { id: 'custom', label: 'Ask a custom question' },
  ];
  const ACTIONS = [
    { id: 'pause-input', label: 'Pause / resume text input' },
    { id: 'replay-audio', label: 'Replay last line’s audio' },
    { id: 'furigana', label: 'Show / hide furigana' },
    { id: 'translate-menu', label: 'Translate & explain…' },
    ...STUDY_ACTIONS,
  ];
  const known = new Set(ACTIONS.map(action => action.id));
  function normalizeActions(actions) {
    return Array.isArray(actions) ? [...new Set(actions.filter(id => known.has(id)))] : [...DEFAULT_ACTIONS];
  }

  class QuickActions {
    constructor({ document, runAction, explain, translate, toggleFurigana, getFuriganaVisible = () => false,
      onOpenChange = () => {}, onDismissAnalysis = () => {} } = {}) {
      Object.assign(this, { document, runAction, explain, translate, toggleFurigana, getFuriganaVisible,
        onOpenChange, onDismissAnalysis });
      this.actions = [...DEFAULT_ACTIONS];
      this.question = 'Explain this sentence in simpler terms.';
      this.isOpen = false;
      this.view = 'actions';
      this.selected = 0;
      this.paused = false;
      this.canReplay = false;
      this.busy = false;
      this.generation = 0;
      this.status = '';
      this.preventNativeKeyAction = event => { if (this.isOpen) event.preventDefault(); };
    }

    configure({ actions, question, hints } = {}) {
      if (actions !== undefined) this.actions = normalizeActions(actions);
      if (typeof question === 'string') this.question = question.trim().slice(0, 4000);
      if (hints) this.hints = hints;
      this.selected = Math.max(0, Math.min(this.selected, this.items().length - 1));
      this.render();
    }

    items() {
      const ids = this.view === 'translate' ? STUDY_ACTIONS.map(action => action.id) : this.actions;
      return ids.map(id => {
        const item = { ...ACTIONS.find(action => action.id === id) };
        if (id === 'pause-input') item.label = this.paused ? 'Resume text input' : 'Pause text input';
        if (id === 'furigana') item.label = this.getFuriganaVisible() ? 'Hide furigana' : 'Show furigana';
        return item;
      });
    }

    async open() {
      if (this.isOpen) return;
      this.isOpen = true;
      this.view = 'actions'; this.selected = 0; this.status = ''; this.result = '';
      const generation = ++this.generation;
      this.busy = true;
      this.onOpenChange(true);
      this.document?.addEventListener('keydown', this.preventNativeKeyAction, true);
      this.render();
      try {
        const state = await this.runAction('state');
        if (generation !== this.generation) return;
        this.applyState(state);
      } catch (error) {
        if (generation === this.generation) this.status = error.message;
      } finally {
        if (generation === this.generation) { this.busy = false; this.render(); }
      }
    }

    close() {
      if (!this.isOpen) return;
      this.isOpen = false; this.busy = false; ++this.generation;
      this.onDismissAnalysis();
      this.document?.removeEventListener('keydown', this.preventNativeKeyAction, true);
      this.root?.remove(); this.root = null;
      this.onOpenChange(false);
    }

    back() {
      if (this.view === 'result') {
        this.onDismissAnalysis();
        this.view = this.resultParent || 'actions'; this.busy = false;
      } else if (this.view === 'translate') {
        this.view = 'actions'; this.selected = Math.max(0, this.actions.indexOf('translate-menu'));
      } else { this.close(); return; }
      this.status = ''; this.render();
    }

    navigate(direction) {
      if (!this.isOpen) return;
      if (this.view === 'result') {
        this.content?.scrollBy({ top: ['Up', 'Left'].includes(direction) ? -130 : 130, behavior: 'smooth' });
        return;
      }
      const count = this.items().length;
      if (!count) return;
      const row = Math.floor(this.selected / 2);
      const column = this.selected % 2;
      if (direction === 'Left' || direction === 'Right') {
        this.selected = row * 2 + (row * 2 + 1 < count ? 1 - column : 0);
      } else {
        const rows = Math.ceil(count / 2);
        const nextRow = (row + (direction === 'Up' ? -1 : 1) + rows) % rows;
        this.selected = Math.min(nextRow * 2 + column, count - 1);
      }
      this.render();
    }

    applyState(state) {
      if (typeof state?.paused === 'boolean') this.paused = state.paused;
      if (typeof state?.canReplay === 'boolean') this.canReplay = state.canReplay;
    }

    async confirm() {
      if (!this.isOpen || this.busy || this.view === 'result') return;
      const item = this.items()[this.selected];
      if (!item) return;
      this.status = '';
      if (item.id === 'translate-menu') { this.view = 'translate'; this.selected = 0; this.render(); return; }
      if (item.id === 'furigana') { this.toggleFurigana(); this.render(); return; }
      if (item.id === 'translation') {
        this.busy = true; this.render();
        try { await this.translate(); this.status = 'Translation requested / visibility toggled'; }
        catch (error) { this.status = error.message; }
        finally { this.busy = false; this.render(); }
        return;
      }
      if (STUDY_ACTIONS.some(action => action.id === item.id)) {
        if (item.id === 'custom' && !this.question) {
          this.status = 'Set a custom question in Controller → Quick actions first.'; this.render(); return;
        }
        this.resultParent = this.view; this.view = 'result';
        this.resultTitle = item.label; this.result = 'Explaining…'; this.busy = true; this.render();
        this.explain({ mode: item.id, ...(item.id === 'custom' ? { question: this.question } : {}) });
        return;
      }
      this.busy = true; this.render();
      const generation = this.generation;
      try {
        const state = await this.runAction(item.id === 'pause-input' ? 'toggle-intake' : 'replay-audio');
        this.applyState(state);
        if (generation === this.generation) this.status = item.id === 'pause-input'
          ? (this.paused ? 'Text input paused' : 'Text input resumed') : 'Replaying latest audio';
      } catch (error) {
        if (generation === this.generation) this.status = error.message;
      } finally {
        if (generation === this.generation) { this.busy = false; this.render(); }
      }
    }

    showResult(text) {
      if (!this.isOpen || this.view !== 'result') return false;
      this.result = String(text); this.busy = false; this.render(); return true;
    }

    render() {
      if (!this.document || !this.isOpen) return;
      if (!this.root) {
        this.root = this.document.createElement('section');
        this.root.id = 'gsm-quick-actions'; this.root.className = 'interactive';
        this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-label', 'Quick actions');
        this.document.body.appendChild(this.root);
      }
      this.root.replaceChildren();
      const make = (tag, className, text) => {
        const element = this.document.createElement(tag); element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
      };
      const header = make('header', 'quick-actions-header');
      header.append(make('strong', '', this.view === 'result' ? this.resultTitle : this.view === 'translate' ? 'Translate & explain' : 'Quick actions'));
      const back = make('button', 'quick-actions-back', this.view === 'actions' ? 'Close' : 'Back');
      back.type = 'button'; back.onclick = () => this.back(); header.append(back); this.root.append(header);
      if (this.view === 'result') {
        this.content = make('div', 'quick-actions-result', this.result);
        this.content.setAttribute('aria-live', 'polite'); this.root.append(this.content);
      } else {
        const grid = make('div', 'quick-actions-grid');
        const items = this.items();
        items.forEach((item, index) => {
          const button = make('button', 'quick-actions-button', item.label);
          button.type = 'button'; button.dataset.action = item.id;
          button.classList.toggle('selected', index === this.selected);
          button.setAttribute('aria-current', index === this.selected ? 'true' : 'false');
          button.disabled = this.busy;
          button.onclick = () => { this.selected = index; void this.confirm(); };
          grid.append(button);
        });
        this.root.append(grid);
        if (!items.length) this.root.append(make('p', '', 'Choose your shortcuts in Controller → Quick actions.'));
        if (this.view === 'translate' && items[this.selected]?.id === 'custom') {
          this.root.append(make('p', 'quick-actions-question', this.question || 'No custom question configured.'));
        }
        grid.children[this.selected]?.scrollIntoView?.({ block: 'nearest' });
      }
      const status = make('p', 'quick-actions-status', this.busy && this.view !== 'result' ? 'Working…' : this.status);
      status.setAttribute('role', 'status'); this.root.append(status);
      this.root.append(make('footer', '', this.hints || 'D-pad / stick: move · Confirm: select · Back: return'));
    }
  }
  return { QuickActions, ACTIONS, STUDY_ACTIONS, DEFAULT_ACTIONS, normalizeActions };
}));
