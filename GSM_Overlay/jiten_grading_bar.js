/* Reader-neutral Jiten grading UI. GSM's existing host service owns credentials and requests. */
(() => {
  class JitenGradingBar {
    constructor({ window, document, getHeadword }) {
      Object.assign(this, { window, document, getHeadword });
      this.config = { enabled: false };
      this.views = new Map();
      this.pending = new Map();
      this.sequence = 0;
      this.onMessage = this.onMessage.bind(this);
      window.addEventListener('message', this.onMessage);
      window.postMessage({ type: 'gsm-jiten-grading-config-request' }, '*');
    }
    onMessage(event) {
      if (event.source !== this.window) return;
      const data = event.data;
      if (data?.type === 'gsm-jiten-grading-config') {
        this.config = data;
        for (const [owner, view] of this.views) this.render(owner, view);
      } else if (data?.type === 'gsm-jiten-grade-result') {
        this.pending.get(data.requestId)?.(data);
      }
    }
    refresh(owner, container) {
      for (const [oldOwner, view] of this.views) {
        if (oldOwner.retired || !view.bar.isConnected) { view.bar.remove(); this.views.delete(oldOwner); }
      }
      let view = this.views.get(owner);
      if (!view) {
        const bar = this.document.createElement('div');
        bar.className = 'gsm-jiten-bar';
        bar.style.cssText = 'padding:8px;display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid #8885';
        const buttons = this.document.createElement('div');
        buttons.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
        const status = this.document.createElement('span');
        status.setAttribute('role', 'status');
        bar.append(buttons, status);
        view = { bar, buttons, status, revision: null, busy: false };
        this.views.set(owner, view);
      }
      if (view.bar.parentNode !== container || container.firstChild !== view.bar) container.prepend(view.bar);
      this.render(owner, view);
    }
    render(owner, view) {
      const headword = this.getHeadword(owner);
      view.bar.hidden = !(this.config.enabled && headword?.term);
      // Inline display needs to respect hidden even in reader styles that reset it.
      view.bar.style.display = view.bar.hidden ? 'none' : 'flex';
      const signature = `${this.config.showGrading !== false}:${this.config.twoGrades === true}`;
      const revision = `${owner.lookupToken}:${headword?.term}:${headword?.reading}`;
      if (view.revision !== revision) { view.revision = revision; view.status.textContent = ''; }
      if (view.signature === signature) return;
      view.signature = signature;
      const specs = [
        { label: 'Blacklist', kind: 'state', deck: 'blacklist', action: 'add' },
        { label: 'Never Forget', kind: 'state', deck: 'neverForget', action: 'add' },
      ];
      if (this.config.showGrading !== false) {
        for (const [rating, label] of [[1, 'Again'], [2, 'Hard'], [3, 'Good'], [4, 'Easy']]) {
          if (!this.config.twoGrades || rating === 1 || rating === 3) specs.push({ label, kind: 'review', rating });
        }
      }
      view.buttons.replaceChildren();
      for (const { label, ...fields } of specs) {
        const button = this.document.createElement('button');
        button.type = 'button'; button.textContent = label;
        button.className = 'gsm-jiten-btn';
        button.style.cssText = 'border:1px solid currentColor;border-radius:4px;padding:3px 8px;background:transparent;color:inherit;cursor:pointer';
        for (const [key, value] of Object.entries(fields)) button.dataset[key] = String(value);
        button.disabled = view.busy;
        button.addEventListener('click', () => { void this.grade(owner, view, fields, label); });
        view.buttons.append(button);
      }
    }
    buttons(owner) { return [...(this.views.get(owner)?.buttons.querySelectorAll('button') || [])]; }
    async grade(owner, view, fields, label) {
      if (view.busy || view.bar.hidden) return;
      const headword = this.getHeadword(owner);
      if (!headword) return;
      if (this.config.hasApiKey === false) { view.status.textContent = 'Set Jiten API key'; return; }
      const revision = view.revision;
      const requestId = `gsm-hachidori-grade-${Date.now()}-${++this.sequence}`;
      view.busy = true;
      this.buttons(owner).forEach(button => { button.disabled = true; });
      view.status.textContent = '…';
      const result = await new Promise(resolve => {
        const timer = setTimeout(() => finish({ ok: false, error: 'Timed out' }), 8000);
        const finish = result => { clearTimeout(timer); this.pending.delete(requestId); resolve(result); };
        this.pending.set(requestId, finish);
        try { this.window.postMessage({ type: 'gsm-jiten-grade', requestId, ...headword, ...fields }, '*'); }
        catch (error) { finish({ ok: false, error: error.message }); }
      });
      view.busy = false;
      this.buttons(owner).forEach(button => { button.disabled = false; });
      if (view.revision === revision && view.bar.isConnected) view.status.textContent = result.ok ? `${label} ✓` : result.error || 'Failed';
    }
    destroy() {
      this.window.removeEventListener('message', this.onMessage);
      for (const finish of this.pending.values()) finish({ ok: false, error: 'Closed' });
      for (const view of this.views.values()) view.bar.remove();
      this.views.clear();
    }
  }
  window.GsmJitenGradingBar = JitenGradingBar;
})();
