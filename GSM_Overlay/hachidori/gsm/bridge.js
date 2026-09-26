/* GSM-owned Hachidori integration. Installed through the small content.js hook.
 * This runs in the extension's isolated world, only on GSM's overlay page.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
(() => {
  const protocolVersion = 1;
  const targetAttribute = 'data-gsm-hachidori-lookup-target';
  const popupControls = new Set(['scroll', 'select-action', 'reset-action-selection', 'confirm-action',
    'clear-action-selection', 'next-entry', 'previous-entry']);
  const commands = new Set(['close', 'addNote', 'viewNotes', 'playAudio', 'playAudioFromSource',
    'nextEntry', 'previousEntry', 'firstEntry', 'lastEntry', 'nextEntryDifferentDictionary',
    'previousEntryDifferentDictionary', 'historyBackward', 'scanSelectedText', 'scanTextAtSelection']);
  // Deliberately explicit: callers cannot supply an arbitrary chrome.runtime target or message type.
  const routes = {
    status: ['hd_status', 'hoshidicts-offscreen'],
    terms: ['hd_lookup', 'hoshidicts-offscreen'],
    termsInDictionary: ['hd_lookup_dictionary', 'hoshidicts-offscreen'],
    kanji: ['hd_kanji', 'hoshidicts-offscreen'],
    styles: ['hd_styles', 'hoshidicts-offscreen'],
    media: ['hd_media', 'hoshidicts-offscreen'],
    dictionaries: ['hd_state_read', 'hoshidicts-worker'],
    updateDictionaries: ['hd_state_cas', 'hoshidicts-worker'],
    updateOptions: ['hd_options_write', 'hoshidicts-worker'],
    customDictionary: ['hd_custom_read', 'hoshidicts-worker'],
    saveCustomDictionary: ['hd_custom_save', 'hoshidicts-offscreen'],
    appendCustomEntry: ['hd_custom_append', 'hoshidicts-offscreen'],
    reload: ['hd_reload', 'hoshidicts-offscreen'],
    lookupStats: ['hd_lookup_stats_read', 'hoshidicts-worker'],
    ankiStatus: ['hd_anki_status', 'hachidori-anki'],
    ankiPreflight: ['hd_anki_preflight', 'hachidori-anki'],
    ankiSubmit: ['hd_anki_submit', 'hachidori-anki'],
    ankiBrowse: ['hd_anki_browse', 'hachidori-anki'],
  };
  function isGsmHost(href) {
    try {
      const url = new URL(href);
      if (url.protocol === 'file:') return /\/(?:GSM_Overlay|resources\/app\.asar)\/index\.html$/i.test(decodeURIComponent(url.pathname));
      return url.origin === 'http://127.0.0.1:5174' && ['/', '/index.html'].includes(url.pathname);
    } catch { return false; }
  }
  const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

  function install(api, environment = { window, document }) {
    const { window: win, document: doc } = environment;
    if (!isGsmHost(win.location.href)) return null;
    let destroyed = false, navigationActive = doc.documentElement.dataset.gsmGamepadNavigationActive === 'true';
    let lookupRevision = 0;
    let knownPopups = new Map();
    const level = () => api.state().levels.findLast(item => item.popup && !item.popup.hidden && !item.retired);
    const popup = win.GsmHachidoriPopup.create(api, { window: win, document: doc });
    const emit = (type, detail) => win.dispatchEvent(new win.CustomEvent(type, { detail }));

    function refresh() {
      if (destroyed) return;
      popup.refresh();
      const next = new Map(api.state().levels.filter(item => item.popup && !item.popup.hidden && !item.retired)
        .map(item => [`hachidori-${item.depth}`, item]));
      for (const [popupId, item] of next) {
        if (knownPopups.get(popupId) !== item) emit('gsm-hachidori-popup-shown', { popupId, depth: item.depth });
      }
      for (const popupId of knownPopups.keys()) {
        if (!next.has(popupId)) emit('gsm-hachidori-popup-hidden', { popupId });
      }
      knownPopups = next;
    }

    async function control(body) {
      const action = body.action;
      if (action === 'navigation-active') {
        navigationActive = body.active === true;
        if (navigationActive) api.cancelHover();
        else popup.control('clear-action-selection');
        return true;
      }
      if (action === 'hide-popup') {
        ++lookupRevision;
        api.hide(); popup.control('clear-action-selection'); refresh();
        return true;
      }
      if (action === 'lookup-point') {
        const revision = ++lookupRevision;
        // Resolve the DOM marker before waiting; rapid movement must not reuse a later marker.
        let candidate;
        if (typeof body.targetId === 'string') {
          if (!/^[a-zA-Z0-9-]{1,100}$/.test(body.targetId)) throw failure('Invalid lookup target');
          const element = doc.querySelector(`[${targetAttribute}="${body.targetId}"]`);
          element?.removeAttribute(targetAttribute);
          if (!element?.isConnected) return false;
          const walker = doc.createTreeWalker(element, 4, { acceptNode: node =>
            node.parentElement?.closest('rt, rp') ? 2 : 1 });
          const node = walker.nextNode();
          candidate = node ? api.resolveCandidateAt(node, 0) : null;
        } else if (Number.isFinite(body.x) && Number.isFinite(body.y)) {
          candidate = api.resolveCandidate(body.x, body.y);
        } else throw failure('Lookup requires a targetId or finite coordinates');
        await api.ready();
        if (destroyed || revision !== lookupRevision) return false;
        if (!candidate || (candidate.anchor && !candidate.anchor.isConnected)) { api.hide(); return false; }
        // Match native hover's pending/visible lookup reuse. Canceling a candidate
        // scan here hides and clears an inert popup while its replacement is still
        // loading, and repeated controller input restarts the same engine request.
        // A new lookup already invalidates older replies through the native token.
        api.cancelHover({ preserveLookup: true });
        const { levels, pendingCandidateLookup: pending } = api.state();
        const root = levels[0];
        const signature = api.candidateSignature(candidate);
        if (pending && pending.token === root?.lookupToken && pending.signature === signature
          && api.sameAnchorNode(candidate, pending.candidate)) return true;
        if (root?.popup && !root.popup.hidden && !root.popup.inert && root.activeSignature === signature
          && api.sameAnchorNode(candidate, root.activeCandidate)) return true;
        api.lookupCandidate(candidate, signature);
        return true;
      }
      if (popupControls.has(action)) { const handled = popup.control(action, body); refresh(); return handled; }
      if (action === 'mine') return api.command('addNote', '');
      if (action === 'command') {
        if (!commands.has(body.command)) throw failure('Unsupported reader command', 404);
        return api.command(body.command, body.argument ?? '1');
      }
      throw failure(`Unsupported control action: ${action}`, 404);
    }

    async function invoke(action, body) {
      if (destroyed || api.state().disposed) throw failure('Hachidori bridge is unavailable', 503);
      if (action === 'capabilities') return { reader: 'hachidori', version: protocolVersion,
        actions: ['capabilities', 'state', 'options', 'selection', 'control', ...Object.keys(routes)],
        controls: ['lookup-point', 'hide-popup', 'navigation-active', 'mine', 'command', ...popupControls],
        commands: [...commands] };
      if (action === 'control') return control(body);
      await api.ready();
      if (destroyed) throw failure('Hachidori bridge destroyed', 503);
      if (action === 'options') return api.readOptions();
      if (action === 'state') return { navigationActive, popupCount: knownPopups.size,
        popups: [...knownPopups.keys()].map(popupId => ({ popupId })),
        dictionaries: api.state().dictionaries, selection: selection() };
      if (action === 'selection') return selection();
      if (!Object.hasOwn(routes, action)) throw failure(`Unsupported bridge action: ${action}`, 404);
      const [type, target] = routes[action];
      const { target: ignoredTarget, type: ignoredType, requestId: ignoredId, ...payload } = body;
      if (action === 'terms' || action === 'termsInDictionary') {
        if (typeof payload.text !== 'string' || payload.text.length > 100000) throw failure('Lookup text must be a string of at most 100000 characters');
        const options = api.state().options;
        payload.scanLength ??= options.scanLength;
        payload.maxResults ??= options.maxResults;
        payload.options ??= Object.fromEntries(['frequencyDictionary', 'frequencyOrder'].filter(key => options[key] !== undefined).map(key => [key, options[key]]));
      }
      return api.sendRequest(type, payload, target);
    }

    function selection() {
      const current = level();
      if (!current) return null;
      const index = current.view?.currentEntryIndex() ?? 0;
      return { depth: current.depth, index, kind: current.currentViewRequest?.kind,
        sentence: current.activeCandidate?.sentence, matchOffset: current.activeCandidate?.matchOffset,
        result: win.GsmHachidoriPopup.currentResult(current) };
    }

    async function onMessage(event) {
      const request = event.data;
      if (destroyed || event.source !== win || request?.type !== 'gsm-hachidori-api-request') return;
      if (typeof request.requestId !== 'string' || request.requestId.length > 200) return;
      const response = { type: 'gsm-hachidori-api-response', requestId: request.requestId };
      try {
        if (typeof request.action !== 'string' || !request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw failure('Invalid bridge request');
        response.data = await invoke(request.action, request.body);
        response.responseStatusCode = 200;
      } catch (error) {
        response.error = error.message || String(error);
        response.responseStatusCode = error.statusCode || 500;
      }
      if (!destroyed) win.postMessage(response, '*');
    }
    win.addEventListener('message', onMessage);
    if (navigationActive) api.cancelHover();
    return {
      get navigationActive() { return navigationActive; },
      refresh,
      requestCompleted(type, reply) {
        if (type === 'hd_anki_submit' && ['added', 'updated'].includes(reply.state)) {
          emit('gsm-anki-note-added', { reader: 'hachidori', noteId: reply.noteId });
        }
      },
      destroy() {
        destroyed = true; navigationActive = false; ++lookupRevision;
        win.removeEventListener('message', onMessage);
        popup.destroy();
        for (const popupId of knownPopups.keys()) emit('gsm-hachidori-popup-hidden', { popupId });
        knownPopups.clear();
      },
    };
  }
  const api = { install, isGsmHost };
  if (typeof window !== 'undefined') window.GsmHachidoriIntegration = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
