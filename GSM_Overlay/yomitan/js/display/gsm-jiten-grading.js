/*
 * GSM add-on (not part of upstream Yomitan).
 *
 * Renders a small Jiten SRS grading bar at the very top of the popup, above the
 * dictionary entries, without altering the rest of the layout. The bar is a thin
 * UI shell: it asks the GSM overlay (its parent frame) to do all Jiten API work
 * (resolve the term to a wordId and call srs/review or srs/set-vocabulary-state),
 * so no API key or host permission lives in the Yomitan extension.
 *
 * It only appears when the overlay reports that BOTH "Jiten Reader" and "Jiten
 * highlighting" are enabled. Kept as its own module so the fork stays mergeable
 * with upstream — wired in from popup-main.js with two lines and nothing else.
 *
 * Messaging (mirrors the existing gsm-yomitan-control bridge):
 *   popup -> overlay : {type:'gsm-jiten-grading-config-request'}
 *   overlay -> popup : {type:'gsm-jiten-grading-config', enabled, showGrading, twoGrades, hasApiKey}
 *   popup -> overlay : {type:'gsm-jiten-grade', requestId, kind, term, reading, rating?, deck?, action?}
 *   overlay -> popup : {type:'gsm-jiten-grade-result', requestId, ok, error?}
 */

export class GsmJitenGrading {
    /**
     * @param {import('./display.js').Display} display
     */
    constructor(display) {
        /** @type {import('./display.js').Display} */
        this._display = display;
        /** @type {?HTMLElement} */
        this._bar = null;
        /** @type {?HTMLElement} */
        this._buttonsContainer = null;
        /** @type {?HTMLElement} */
        this._statusEl = null;
        /** @type {boolean} */
        this._enabled = false;
        /** @type {boolean} */
        this._showGrading = true;
        /** @type {boolean} */
        this._twoGrades = false;
        /** @type {boolean} */
        this._hasApiKey = true;
        /** @type {string} */
        this._renderedSignature = '';
        /** @type {Map<string, (result: object) => void>} */
        this._pending = new Map();
        /** @type {?number} */
        this._statusTimer = null;
        /** @type {(event: MessageEvent) => void} */
        this._onMessageBind = this._onMessage.bind(this);
    }

    /** */
    prepare() {
        // Not framed (e.g. the standalone search page) — nothing to talk to.
        if (typeof window === 'undefined' || window.top === window) { return; }

        this._ensureStyle();
        window.addEventListener('message', this._onMessageBind);
        this._display.on('contentUpdateComplete', this._onContentUpdateComplete.bind(this));
        this._display.on('contentClear', this._onContentClear.bind(this));

        // Ask the overlay for the current grading config (handles the case where
        // we load after the overlay already pushed it).
        this._requestConfig();
    }

    // Private

    /** */
    _requestConfig() {
        const msg = {type: 'gsm-jiten-grading-config-request'};
        for (const target of [window.top, window.parent]) {
            try { if (target) { target.postMessage(msg, '*'); } } catch (e) { /* ignore */ }
        }
    }

    /**
     * @param {MessageEvent} event
     */
    _onMessage(event) {
        const data = event && event.data;
        if (!data || typeof data !== 'object') { return; }
        if (data.type === 'gsm-jiten-grading-config') {
            this._applyConfig(data);
        } else if (data.type === 'gsm-jiten-grade-result' && typeof data.requestId === 'string') {
            const resolve = this._pending.get(data.requestId);
            if (resolve) {
                this._pending.delete(data.requestId);
                resolve(data);
            }
        }
    }

    /**
     * @param {{enabled?: boolean, showGrading?: boolean, twoGrades?: boolean, hasApiKey?: boolean}} cfg
     */
    _applyConfig(cfg) {
        this._enabled = cfg.enabled === true;
        this._showGrading = cfg.showGrading !== false;
        this._twoGrades = cfg.twoGrades === true;
        this._hasApiKey = cfg.hasApiKey !== false;
        if (!this._enabled) {
            this._renderedSignature = '';
            if (this._bar) { this._bar.hidden = true; }
            return;
        }
        this._renderButtons();
        // Config can arrive after content already rendered (e.g. right after the
        // popup opens), so make sure the bar is in the DOM, not just built.
        this._ensureBarAttached();
        this._updateVisibility();
    }

    /** */
    _onContentUpdateComplete() {
        if (!this._enabled) { return; }
        this._ensureBarAttached();
        this._updateVisibility();
    }

    /** */
    _onContentClear() {
        if (this._bar) { this._bar.hidden = true; }
        this._setStatus('');
    }

    /**
     * @returns {?{term: string, reading: string}}
     */
    _getCurrentHeadword() {
        const entries = this._display.dictionaryEntries;
        const index = this._display.selectedIndex;
        const entry = (Array.isArray(entries) && index >= 0 && index < entries.length) ? entries[index] : null;
        if (!entry || entry.type !== 'term') { return null; }
        const headwords = entry.headwords;
        if (!Array.isArray(headwords) || headwords.length === 0) { return null; }
        const hw = headwords[0];
        const term = typeof hw.term === 'string' ? hw.term : '';
        const reading = typeof hw.reading === 'string' ? hw.reading : '';
        if (!term) { return null; }
        return {term, reading};
    }

    /** */
    _updateVisibility() {
        if (!this._bar) { return; }
        const hasWord = this._getCurrentHeadword() !== null;
        this._bar.hidden = !(this._enabled && hasWord);
    }

    /** */
    _ensureBarAttached() {
        if (this._bar && this._bar.isConnected) { return; }
        const entries = document.querySelector('#dictionary-entries');
        const parent = entries ? entries.parentElement : (document.querySelector('.content-body-inner') || document.querySelector('#content-body'));
        if (!parent) { return; }
        if (!this._bar) { this._buildBar(); }
        if (entries && entries.parentElement === parent) {
            parent.insertBefore(this._bar, entries);
        } else {
            parent.insertBefore(this._bar, parent.firstChild);
        }
    }

    /** */
    _buildBar() {
        const bar = document.createElement('div');
        bar.className = 'gsm-jiten-bar';
        bar.hidden = true;

        const inner = document.createElement('div');
        inner.className = 'gsm-jiten-bar-inner';

        const buttons = document.createElement('div');
        buttons.className = 'gsm-jiten-bar-buttons';

        const status = document.createElement('span');
        status.className = 'gsm-jiten-bar-status';

        inner.append(buttons, status);
        bar.append(inner);

        this._bar = bar;
        this._buttonsContainer = buttons;
        this._statusEl = status;
        this._renderButtons();
    }

    /** */
    _renderButtons() {
        if (!this._buttonsContainer) {
            if (!this._bar) { this._buildBar(); }
            if (!this._buttonsContainer) { return; }
        }
        const signature = `${this._showGrading ? 1 : 0}:${this._twoGrades ? 1 : 0}`;
        if (signature === this._renderedSignature && this._buttonsContainer.childElementCount > 0) { return; }
        this._renderedSignature = signature;

        /** @type {Array<{label: string, cls: string, kind: string, rating?: number, deck?: string, action?: string, sep?: boolean}>} */
        const specs = [
            {label: 'Blacklist', cls: 'blacklist', kind: 'state', deck: 'blacklist', action: 'add'},
            {label: 'Never Forget', cls: 'never-forget', kind: 'state', deck: 'neverForget', action: 'add'},
        ];
        if (this._showGrading) {
            specs.push({sep: true});
            if (this._twoGrades) {
                specs.push({label: 'Again', cls: 'again', kind: 'review', rating: 1});
                specs.push({label: 'Good', cls: 'good', kind: 'review', rating: 3});
            } else {
                specs.push({label: 'Again', cls: 'again', kind: 'review', rating: 1});
                specs.push({label: 'Hard', cls: 'hard', kind: 'review', rating: 2});
                specs.push({label: 'Good', cls: 'good', kind: 'review', rating: 3});
                specs.push({label: 'Easy', cls: 'easy', kind: 'review', rating: 4});
            }
        }

        this._buttonsContainer.replaceChildren();
        for (const spec of specs) {
            if (spec.sep) {
                const sep = document.createElement('span');
                sep.className = 'gsm-jiten-bar-sep';
                this._buttonsContainer.append(sep);
                continue;
            }
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `gsm-jiten-btn gsm-jiten-${spec.cls}`;
            btn.textContent = spec.label;
            btn.dataset.kind = spec.kind;
            if (spec.kind === 'review') {
                btn.dataset.rating = String(spec.rating);
            } else {
                btn.dataset.deck = String(spec.deck);
                btn.dataset.action = String(spec.action);
            }
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                void this._onButtonClick(btn);
            });
            this._buttonsContainer.append(btn);
        }
    }

    /**
     * @param {HTMLButtonElement} btn
     */
    async _onButtonClick(btn) {
        const headword = this._getCurrentHeadword();
        if (!headword) { this._setStatus('No word', 'error'); return; }
        if (!this._hasApiKey) { this._setStatus('Set Jiten API key', 'error'); return; }

        const kind = btn.dataset.kind;
        /** @type {Record<string, unknown>} */
        const message = {
            type: 'gsm-jiten-grade',
            requestId: `gsm-grade-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            kind,
            term: headword.term,
            reading: headword.reading,
        };
        if (kind === 'review') {
            message.rating = Number(btn.dataset.rating);
        } else {
            message.deck = btn.dataset.deck;
            message.action = btn.dataset.action;
        }

        this._setBusy(true);
        this._setStatus('…');
        let result;
        try {
            result = await this._sendGrade(message);
        } catch (e) {
            result = {ok: false, error: 'Timed out'};
        }
        this._setBusy(false);

        if (result && result.ok) {
            this._setStatus(`${btn.textContent} ✓`, 'success');
        } else {
            this._setStatus(`${(result && result.error) || 'Failed'}`, 'error');
        }
    }

    /**
     * @param {Record<string, unknown>} message
     * @returns {Promise<object>}
     */
    _sendGrade(message) {
        return new Promise((resolve, reject) => {
            const requestId = /** @type {string} */ (message.requestId);
            const timeout = setTimeout(() => {
                if (this._pending.has(requestId)) {
                    this._pending.delete(requestId);
                    reject(new Error('timeout'));
                }
            }, 8000);
            this._pending.set(requestId, (result) => {
                clearTimeout(timeout);
                resolve(result);
            });
            for (const target of [window.top, window.parent]) {
                try { if (target) { target.postMessage(message, '*'); } } catch (e) { /* ignore */ }
            }
        });
    }

    /**
     * @param {boolean} busy
     */
    _setBusy(busy) {
        if (!this._buttonsContainer) { return; }
        for (const el of this._buttonsContainer.querySelectorAll('button')) {
            /** @type {HTMLButtonElement} */ (el).disabled = busy;
        }
    }

    /**
     * @param {string} text
     * @param {string} [tone]
     */
    _setStatus(text, tone) {
        if (!this._statusEl) { return; }
        this._statusEl.textContent = text;
        this._statusEl.dataset.tone = tone || '';
        if (this._statusTimer !== null) { clearTimeout(this._statusTimer); this._statusTimer = null; }
        if (text) {
            this._statusTimer = window.setTimeout(() => {
                if (this._statusEl) { this._statusEl.textContent = ''; this._statusEl.dataset.tone = ''; }
                this._statusTimer = null;
            }, 1800);
        }
    }

    /** */
    _ensureStyle() {
        if (document.querySelector('#gsm-jiten-grading-style') !== null) { return; }
        const style = document.createElement('style');
        style.id = 'gsm-jiten-grading-style';
        style.textContent = `
            .gsm-jiten-bar {
                box-sizing: border-box;
                width: 100%;
                padding: 0.35em var(--entry-horizontal-padding, 0.72em);
                background-color: var(--background-color);
                border-bottom: var(--thin-border-size, 1px) solid var(--light-border-color, rgba(127,127,127,0.3));
                font-size: var(--font-size, 14px);
            }
            .gsm-jiten-bar[hidden] { display: none; }
            .gsm-jiten-bar-inner {
                display: flex;
                align-items: center;
                gap: 0.5em;
                flex-wrap: wrap;
            }
            .gsm-jiten-bar-buttons {
                display: flex;
                align-items: center;
                gap: 0.35em;
                flex-wrap: wrap;
            }
            .gsm-jiten-bar-sep {
                width: 1px;
                align-self: stretch;
                margin: 0.1em 0.15em;
                background-color: var(--light-border-color, rgba(127,127,127,0.35));
            }
            .gsm-jiten-btn {
                cursor: pointer;
                color: var(--text-color);
                background-color: transparent;
                border: 1px solid currentColor;
                border-radius: var(--button-border-radius, 0.25em);
                padding: 0.2em 0.7em;
                font-size: 0.85em;
                line-height: 1.4;
                transition: background-color 0.15s ease, box-shadow 0.15s ease, transform 0.1s ease;
                white-space: nowrap;
            }
            .gsm-jiten-btn:hover:not(:disabled) { box-shadow: inset 0 0 0 100px rgba(127,127,127,0.12); }
            .gsm-jiten-btn:active:not(:disabled) { transform: translateY(1px); }
            .gsm-jiten-btn:disabled { opacity: 0.5; cursor: default; }
            .gsm-jiten-btn.gsm-jiten-blacklist { color: var(--text-color-light2, #888); }
            .gsm-jiten-btn.gsm-jiten-never-forget { color: var(--success-color, #51ab30); }
            .gsm-jiten-btn.gsm-jiten-again { color: var(--danger-color, #c83c28); }
            .gsm-jiten-btn.gsm-jiten-hard { color: #df6d2b; }
            .gsm-jiten-btn.gsm-jiten-good { color: var(--accent-color, #1a73e8); }
            .gsm-jiten-btn.gsm-jiten-easy { color: var(--success-color, #51ab30); }
            .gsm-jiten-bar-status {
                font-size: 0.8em;
                color: var(--text-color-light1, #888);
                margin-left: auto;
            }
            .gsm-jiten-bar-status[data-tone="success"] { color: var(--success-color, #51ab30); }
            .gsm-jiten-bar-status[data-tone="error"] { color: var(--danger-color, #c83c28); }
        `;
        document.head.append(style);
    }
}
