/*
 * GSM Anki popup grader.
 *
 * The overlay owns Anki access. This module asks the overlay to check the
 * selected Yomitan headword, display AnkiConnect V1's interval predictions,
 * and submit the final answer with elapsedMs.
 */
export class GsmJitenGrading {
    constructor(display) {
        this._display = display;
        this._bar = null;
        this._barResizeObserver = null;
        this._buttonsContainer = null;
        this._statusEl = null;
        this._enabled = false;
        this._showGrading = true;
        this._twoGrades = false;
        this._atBottom = false;
        this._configSignature = '';
        this._renderedSignature = '';
        this._pending = new Map();
        this._statusPending = new Map();
        this._statusTimer = null;
        this._statusGeneration = 0;
        this._eligibility = null;
        this._eligibilityKey = '';
        this._checkingEligibility = false;
        this._readyAt = null;
        this._selectionRefreshTimer = null;
        this._entryObserver = null;
        this._onMessageBind = this._onMessage.bind(this);
    }

    prepare() {
        if (typeof window === 'undefined' || window.top === window) return;
        this._ensureStyle();
        window.addEventListener('message', this._onMessageBind);
        this._display.on('contentUpdateComplete', this._onContentUpdateComplete.bind(this));
        this._display.on('contentClear', this._onContentClear.bind(this));
        this._requestConfig();
        this._observeEntrySelection();
    }

    _requestConfig() {
        const message = {type: 'gsm-jiten-grading-config-request'};
        for (const target of new Set([window.top, window.parent])) {
            try { if (target) target.postMessage(message, '*'); } catch (_) { /* ignore */ }
        }
    }

    _onMessage(event) {
        const data = event?.data;
        if (!data || typeof data !== 'object') return;
        if (data.type === 'gsm-anki-popup-current-entry-request' && typeof data.requestId === 'string') {
            const headword = this._getCurrentHeadword();
            try {
                event.source?.postMessage({
                    type: 'gsm-anki-popup-current-entry-response',
                    requestId: data.requestId,
                    term: headword?.term || '',
                    reading: headword?.reading || '',
                }, '*');
            } catch (_) { /* ignore */ }
        } else if (data.type === 'gsm-jiten-grading-config') {
            this._applyConfig(data);
        } else if (data.type === 'gsm-jiten-grading-state-changed') {
            // The main process sends this only after the targeted Anki cache
            // refresh has completed. Cancel any older status request so its
            // stale result cannot restore the just-used rating buttons.
            if (this._enabled && this._showGrading) {
                this._statusGeneration++;
                this._checkingEligibility = false;
                this._eligibility = null;
                this._readyAt = null;
                void this._refreshEligibility(true);
            }
        } else if (data.type === 'gsm-jiten-grade-status-result' && typeof data.requestId === 'string') {
            const resolve = this._statusPending.get(data.requestId);
            if (resolve) {
                this._statusPending.delete(data.requestId);
                resolve(data);
            }
        } else if (data.type === 'gsm-jiten-grade-result' && typeof data.requestId === 'string') {
            const resolve = this._pending.get(data.requestId);
            if (resolve) {
                this._pending.delete(data.requestId);
                resolve(data);
            }
        }
    }

    _applyConfig(config) {
        const nextConfigSignature = JSON.stringify({
            enabled: config.enabled === true,
            showGrading: config.showGrading !== false,
            twoGrades: config.twoGrades === true,
            position: config.position === 'bottom' ? 'bottom' : 'top',
        });
        if (nextConfigSignature !== this._configSignature) {
            this._configSignature = nextConfigSignature;
            this._eligibility = null;
            this._checkingEligibility = false;
            this._readyAt = null;
        }
        this._enabled = config.enabled === true;
        this._showGrading = config.showGrading !== false;
        this._twoGrades = config.twoGrades === true;
        this._atBottom = config.position === 'bottom';
        if (!this._enabled) {
            this._eligibility = null;
            this._checkingEligibility = false;
            this._readyAt = null;
            this._renderedSignature = '';
            if (this._bar) this._bar.hidden = true;
            this._updateScrollInset();
            this._setBusy(false);
            return;
        }
        this._ensureBarAttached();
        this._updateVisibility();
        this._refreshEligibility(false);
    }

    _observeEntrySelection() {
        const entries = document.querySelector('#dictionary-entries');
        if (!entries || typeof MutationObserver === 'undefined') return;
        if (this._entryObserver) this._entryObserver.disconnect();
        this._entryObserver = new MutationObserver(records => {
            // Only react when the entry-current marker itself is added or
            // removed. Other class changes on the selected entry are common
            // during hover/definition rendering and must not restart the lookup.
            if (records.some(record => {
                const wasCurrent = String(record.oldValue || '').split(/\s+/).includes('entry-current');
                const isCurrent = record.target.classList?.contains('entry-current') === true;
                return wasCurrent !== isCurrent;
            })) {
                this._queueEligibilityRefresh();
            }
        });
        this._entryObserver.observe(entries, {subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class']});
    }

    _queueEligibilityRefresh() {
        if (this._selectionRefreshTimer !== null) window.clearTimeout(this._selectionRefreshTimer);
        this._selectionRefreshTimer = window.setTimeout(() => {
            this._selectionRefreshTimer = null;
            this._refreshEligibility(false);
        }, 100);
    }

    _onContentUpdateComplete() {
        if (!this._enabled) return;
        this._ensureBarAttached();
        this._updateVisibility();
        this._observeEntrySelection();
        this._refreshEligibility(false);
    }

    _onContentClear() {
        if (this._bar) this._bar.hidden = true;
        this._updateScrollInset();
        this._eligibility = null;
        this._eligibilityKey = '';
        this._checkingEligibility = false;
        this._readyAt = null;
        this._statusGeneration++;
        this._setBusy(false);
        this._renderButtons();
        this._setStatus('');
    }

    _getCurrentHeadword() {
        const entries = this._display.dictionaryEntries;
        const index = this._display.selectedIndex;
        const entry = Array.isArray(entries) && index >= 0 && index < entries.length ? entries[index] : null;
        if (!entry || entry.type !== 'term' || !Array.isArray(entry.headwords) || !entry.headwords.length) return null;
        const headword = entry.headwords[0];
        const term = typeof headword.term === 'string' ? headword.term.trim() : '';
        const reading = typeof headword.reading === 'string' ? headword.reading.trim() : '';
        return term ? {term, reading} : null;
    }

    _headwordKey(headword) {
        return headword ? `${headword.term.normalize('NFKC')}\u0000${(headword.reading || '').normalize('NFKC')}` : '';
    }

    _updateVisibility() {
        if (!this._bar) return;
        const entries = this._display.dictionaryEntries;
        const hasEntries = Array.isArray(entries) && entries.length > 0;
        this._bar.hidden = !(this._enabled && hasEntries);
        this._updateScrollInset();
    }

    _updateScrollInset() {
        const scroll = document.querySelector('#content-scroll');
        if (!scroll) return;
        // The footer overlays the scroll viewport. Reserve its toolbar height
        // so the final dictionary entry can scroll fully above the buttons.
        const height = this._atBottom && this._bar && !this._bar.hidden &&
            this._bar.parentElement === document.querySelector('#content-footer')
            ? this._bar.getBoundingClientRect().height : 0;
        scroll.style.setProperty('--gsm-jiten-footer-height', `${height}px`);
    }

    _ensureBarAttached() {
        const entries = document.querySelector('#dictionary-entries');
        const parent = entries ? entries.parentElement
            : (document.querySelector('.content-body-inner') || document.querySelector('#content-body'));
        if (!parent) return;
        if (!this._bar) this._buildBar();
        this._bar.dataset.position = this._atBottom ? 'bottom' : 'top';
        if (this._atBottom) {
            const footer = document.querySelector('#content-footer');
            if (footer) {
                // Do not detach/reinsert the toolbar on every dictionary update.
                // Reparenting a hovered node can disturb the popup's layout and
                // cursor-exit boundary in the host iframe.
                if (this._bar.parentElement !== footer) {
                    footer.appendChild(this._bar);
                }
                this._updateScrollInset();
                return;
            }
        }

        const referenceNode = entries && entries.parentElement === parent
            ? entries
            : parent.firstChild;
        // contentUpdateComplete fires for normal hover-driven definition updates.
        // Keep the existing bar in place unless its configured position changed.
        if (this._bar.parentElement !== parent || this._bar.nextSibling !== referenceNode) {
            parent.insertBefore(this._bar, referenceNode);
        }
        this._updateScrollInset();
    }

    _buildBar() {
        const bar = document.createElement('div');
        // This is extension UI, not dictionary text. Exclude the entire toolbar
        // from Yomitan's popup text scanner so hovering controls cannot create
        // nested lookups or interfere with the popup's cursor-exit lifecycle.
        bar.className = 'gsm-jiten-bar scan-disable';
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
        if (typeof ResizeObserver !== 'undefined') {
            this._barResizeObserver = new ResizeObserver(() => this._updateScrollInset());
            this._barResizeObserver.observe(bar);
        }
        this._buttonsContainer = buttons;
        this._statusEl = status;
        this._renderButtons();
    }

    _renderButtons() {
        if (!this._buttonsContainer) {
            if (!this._bar) this._buildBar();
            if (!this._buttonsContainer) return;
        }
        const eligibility = this._eligibility;
        const canRate = this._showGrading && eligibility?.eligible === true;
        const signature = JSON.stringify({
            show: this._showGrading,
            two: this._twoGrades,
            key: this._eligibilityKey,
            canRate,
            activeFlag: eligibility?.localFlag?.flag || eligibility?.reason || '',
            intervals: canRate ? eligibility.intervals : null,
        });
        if (signature === this._renderedSignature && this._buttonsContainer.childElementCount > 0) return;
        this._renderedSignature = signature;

        const activeFlag = eligibility?.localFlag?.flag
            || (eligibility?.reason === 'blacklist' ? 'blacklist'
                : eligibility?.reason === 'never-forget' ? 'neverForget' : '');
        const specs = [
            {label: activeFlag === 'blacklist' ? 'Blacklist ✓' : 'Blacklist', cls: 'blacklist', kind: 'state', deck: 'blacklist', action: activeFlag === 'blacklist' ? 'remove' : 'add'},
            {label: activeFlag === 'neverForget' ? 'Never Forget ✓' : 'Never Forget', cls: 'never-forget', kind: 'state', deck: 'neverForget', action: activeFlag === 'neverForget' ? 'remove' : 'add'},
        ];
        if (canRate) {
            specs.push({sep: true});
            const ratings = this._twoGrades ? [
                {rating: 1, name: 'again', label: 'Again'},
                {rating: 3, name: 'good', label: 'Good'},
            ] : [
                {rating: 1, name: 'again', label: 'Again'},
                {rating: 2, name: 'hard', label: 'Hard'},
                {rating: 3, name: 'good', label: 'Good'},
                {rating: 4, name: 'easy', label: 'Easy'},
            ];
            for (const item of ratings) {
                const interval = eligibility.intervals?.[item.name];
                specs.push({
                    // The interval is the visible button text; keep the rating name
                    // only in its accessible label and data attributes.
                    label: interval || '—',
                    ariaLabel: `${item.label} · ${interval || 'predicted interval unavailable'}`,
                    cls: item.name,
                    kind: 'review',
                    rating: item.rating,
                    ratingName: item.name,
                    ratingLabel: item.label,
                    interval: interval || '',
                });
            }
        }

        this._buttonsContainer.replaceChildren();
        for (const spec of specs) {
            if (spec.sep) {
                const separator = document.createElement('span');
                separator.className = 'gsm-jiten-bar-sep';
                this._buttonsContainer.append(separator);
                continue;
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `gsm-jiten-btn gsm-jiten-${spec.cls}`;
            button.textContent = spec.label;
            if (spec.ariaLabel) button.setAttribute('aria-label', spec.ariaLabel);
            button.dataset.kind = spec.kind;
            if (spec.kind === 'review') {
                button.dataset.rating = String(spec.rating);
                button.dataset.ratingName = spec.ratingName;
                button.dataset.ratingLabel = spec.ratingLabel;
                button.dataset.interval = spec.interval;
            } else {
                button.dataset.deck = spec.deck;
                button.dataset.action = spec.action;
            }
            button.addEventListener('click', event => {
                event.preventDefault();
                void this._onButtonClick(button);
            });
            this._buttonsContainer.append(button);
        }
    }

    async _refreshEligibility(force) {
        if (!this._enabled || !this._showGrading) return;
        const headword = this._getCurrentHeadword();
        const key = this._headwordKey(headword);
        if (!headword) {
            this._eligibility = null;
            this._eligibilityKey = '';
            this._checkingEligibility = false;
            this._readyAt = null;
            this._statusGeneration++;
            this._renderButtons();
            this._setStatus('Select a dictionary term to check its Anki card.', '', 0);
            return;
        }
        if (key === this._eligibilityKey && this._checkingEligibility) return;
        if (!force && key === this._eligibilityKey && this._eligibility) return;
        this._eligibilityKey = key;
        // Keep the existing buttons in place while the newly selected entry is
        // checked. This avoids a visible flash on every hover/selection change.
        // Rating clicks are ignored until the new result arrives, so stale
        // intervals can never be submitted for the newly selected headword.
        this._checkingEligibility = true;
        this._readyAt = null;
        // Keep the previous controls visible, but prevent either ratings or
        // flag toggles from acting on a different headword during the lookup.
        this._setBusy(true);
        const generation = ++this._statusGeneration;
        let result;
        try {
            result = await this._sendStatus(headword);
        } catch (_) {
            result = {eligible: false, reason: 'timeout', message: 'Anki status check timed out. Check that Anki is open and AnkiConnect is responding.'};
        }
        if (generation !== this._statusGeneration || this._headwordKey(this._getCurrentHeadword()) !== key) return;
        this._checkingEligibility = false;
        this._setBusy(false);
        if (!result || result.eligible !== true) {
            this._eligibility = {
                eligible: false,
                reason: result?.reason || 'error',
                localFlag: result?.localFlag || null,
            };
            this._renderButtons();
            const reason = result?.reason || '';
            const simpleInfo = ['new', 'mature', 'blacklist', 'never-forget', 'reviewed-today'].includes(reason);
            this._setStatus(result?.message || 'No eligible card.', simpleInfo ? 'info' : 'error', 0);
            return;
        }
        this._eligibility = result;
        this._readyAt = performance.now();
        this._renderButtons();
        this._setStatus(result.statusLabel || 'young', 'info', 0);
    }

    _sendStatus(headword) {
        return new Promise((resolve, reject) => {
            const requestId = `gsm-grade-status-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const timeout = window.setTimeout(() => {
                if (this._statusPending.has(requestId)) {
                    this._statusPending.delete(requestId);
                    reject(new Error('status-timeout'));
                }
            }, 15000);
            this._statusPending.set(requestId, result => {
                window.clearTimeout(timeout);
                resolve(result);
            });
            const message = {type: 'gsm-jiten-grade-status', requestId, term: headword.term, reading: headword.reading};
            for (const target of new Set([window.top, window.parent])) {
                try { if (target) target.postMessage(message, '*'); } catch (_) { /* ignore */ }
            }
        });
    }

    async _onButtonClick(button) {
        const headword = this._getCurrentHeadword();
        if (!headword) { this._setStatus('No word selected.', 'error', 0); return; }
        const kind = button.dataset.kind;
        if (kind === 'review') {
            if (this._checkingEligibility) return;
            if (this._eligibility?.eligible !== true
                || this._eligibilityKey !== this._headwordKey(headword)) {
                this._setStatus('Rating is disabled until Anki confirms exactly one eligible card.', 'error', 0);
                this._queueEligibilityRefresh();
                return;
            }
        }

        const message = {
            type: 'gsm-jiten-grade',
            requestId: `gsm-grade-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            kind,
            term: headword.term,
            reading: headword.reading,
        };
        if (kind === 'review') {
            message.rating = Number(button.dataset.rating);
            message.elapsedMs = this._readyAt === null ? 0 : Math.max(0, Math.round(performance.now() - this._readyAt));
        } else {
            message.deck = button.dataset.deck;
            message.action = button.dataset.action;
        }

        this._setBusy(true);
        this._setStatus('Saving…', '', 0);
        let result;
        try { result = await this._sendGrade(message); }
        catch (_) { result = {ok: false, error: 'The request timed out. Check Anki before clicking again; it may already have recorded the review.'}; }
        this._setBusy(false);

        if (result?.ok) {
            if (kind === 'review') {
                const elapsed = Number.isFinite(result.elapsedMs) ? `${(result.elapsedMs / 1000).toFixed(1)}s` : '';
                const interval = result.nextInterval || button.dataset.interval || button.textContent;
                this._eligibility = null;
                this._readyAt = null;
                this._renderButtons();
                this._setStatus(`${interval} ✓${elapsed ? ` · ${elapsed}` : ''}`, 'success', 2600);
                window.setTimeout(() => this._refreshEligibility(true), 900);
            } else {
                const flagLabel = button.dataset.deck === 'blacklist' ? 'Blacklist' : 'Never Forget';
                // Invalidate any status request that began before this local
                // flag change, so it cannot briefly overwrite the new state.
                this._statusGeneration++;
                this._checkingEligibility = false;
                this._eligibility = null;
                this._readyAt = null;
                this._renderButtons();
                this._setStatus(result.action === 'remove' ? `${flagLabel} removed` : `${flagLabel} ✓`, 'success', 1800);
                // Re-read the local flag state. Adding a flag hides rating
                // buttons; removing it restores the cached Anki eligibility.
                window.setTimeout(() => this._refreshEligibility(true), 150);
            }
        } else {
            this._setStatus(result?.error || 'Anki rejected the request.', 'error', 0);
            if (kind === 'review') window.setTimeout(() => this._refreshEligibility(true), 300);
        }
    }

    _sendGrade(message) {
        return new Promise((resolve, reject) => {
            const requestId = message.requestId;
            const timeout = window.setTimeout(() => {
                if (this._pending.has(requestId)) {
                    this._pending.delete(requestId);
                    reject(new Error('timeout'));
                }
            }, 30000);
            this._pending.set(requestId, result => {
                window.clearTimeout(timeout);
                resolve(result);
            });
            for (const target of new Set([window.top, window.parent])) {
                try { if (target) target.postMessage(message, '*'); } catch (_) { /* ignore */ }
            }
        });
    }

    _setBusy(busy) {
        if (!this._buttonsContainer) return;
        for (const button of this._buttonsContainer.querySelectorAll('button')) button.disabled = busy;
    }

    _setStatus(text, tone, duration = 1800) {
        if (!this._statusEl) return;
        this._statusEl.textContent = text;
        this._statusEl.dataset.tone = tone || '';
        if (this._statusTimer !== null) {
            window.clearTimeout(this._statusTimer);
            this._statusTimer = null;
        }
        if (text && duration > 0) {
            this._statusTimer = window.setTimeout(() => {
                if (this._statusEl) {
                    this._statusEl.textContent = '';
                    this._statusEl.dataset.tone = '';
                }
                this._statusTimer = null;
            }, duration);
        }
    }

    _ensureStyle() {
        if (document.querySelector('#gsm-jiten-grading-style')) return;
        const style = document.createElement('style');
        style.id = 'gsm-jiten-grading-style';
        style.textContent = `
            #content-scroll { bottom: var(--gsm-jiten-footer-height, 0px); }
            .gsm-jiten-bar {
                box-sizing: border-box;
                width: 100%;
                padding: 0.35em var(--entry-horizontal-padding, 0.72em);
                background-color: var(--background-color);
                border-bottom: var(--thin-border-size, 1px) solid var(--light-border-color, rgba(127,127,127,0.3));
                font-size: var(--font-size, 14px);
            }
            .gsm-jiten-bar[data-position="bottom"] {
                width: 100%;
                pointer-events: auto;
                border-top: var(--thin-border-size, 1px) solid var(--light-border-color, rgba(127,127,127,0.3));
                border-bottom: 0;
            }
            .gsm-jiten-bar[hidden] { display: none; }
            .gsm-jiten-bar-inner { display: flex; align-items: center; gap: 0.5em; flex-wrap: wrap; }
            .gsm-jiten-bar-buttons { display: flex; align-items: center; gap: 0.35em; flex-wrap: wrap; }
            .gsm-jiten-bar-sep { width: 1px; align-self: stretch; margin: 0.1em 0.15em; background-color: var(--light-border-color, rgba(127,127,127,0.35)); }
            .gsm-jiten-btn {
                cursor: pointer; color: var(--text-color); background-color: transparent;
                border: 1px solid currentColor; border-radius: var(--button-border-radius, 0.25em);
                padding: 0.2em 0.7em; font-size: 0.85em; line-height: 1.4;
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
            .gsm-jiten-btn.gsm-jiten-good { color: var(--success-color, #51ab30); }
            .gsm-jiten-btn.gsm-jiten-easy { color: var(--accent-color, #1a73e8); }
            /* Interval labels can be very short (for example, "1d"). Keep the
               four grading targets comfortably wide and consistent regardless
               of the predicted interval text, without increasing their height. */
            .gsm-jiten-btn.gsm-jiten-again,
            .gsm-jiten-btn.gsm-jiten-hard,
            .gsm-jiten-btn.gsm-jiten-good,
            .gsm-jiten-btn.gsm-jiten-easy {
                box-sizing: border-box;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                min-width: 4.2em;
                padding: 0.2em 0.8em;
                text-align: center;
            }
            .gsm-jiten-bar-status { font-size: 0.8em; color: var(--text-color-light1, #888); margin-left: auto; }
            .gsm-jiten-bar-status[data-tone="success"] { color: var(--success-color, #51ab30); }
            .gsm-jiten-bar-status[data-tone="error"] { color: var(--danger-color, #c83c28); }
        `;
        document.head.append(style);
    }
}
