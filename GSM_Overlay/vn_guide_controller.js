const { GuideTracker } = require('./vn_guide');

function createVnGuideController({ library, hud, onChange = () => {}, now = Date.now }) {
  let settings = {};
  let loaded = null;
  let tracker = null;
  let loading = false;
  let error = '';
  let epoch = 0;
  let disposed = false;
  let available = false;
  let peek = null;
  let dismissed = false;
  let sourceKey = '';
  let game = null;
  let tentativeUntil = 0;
  let saveNoticeUntil = 0;
  let suspendedAt = null;
  let lastVisible = false;

  function snapshot() {
    const mode = ['auto', 'always', 'hotkey'].includes(settings.vnGuideMode) ? settings.vnGuideMode : 'auto';
    const saveInstructions = tracker?.saveInstructions || [];
    const saveNotice = saveInstructions.length > 0 && mode === 'auto' && peek !== true && !tracker.detected && saveNoticeUntil > now();
    const automatic = tracker && (mode === 'always' || mode === 'auto' && (tracker.detected || tracker.current?.kind !== 'choice' || saveNotice || !saveInstructions.length && tracker.tentative && now() < tentativeUntil));
    return {
      enabled: settings.vnGuideEnabled === true, loading, error, mode,
      visible: !disposed && available && settings.vnGuideEnabled === true && !!tracker && !dismissed && (peek ?? !!automatic),
      title: loaded?.guide.title || '', target: loaded?.guide.target || '',
      routes: loaded?.guide.routes || [], routeId: loaded?.route.id || '', routeTitle: loaded?.route.title || '',
      reviewed: loaded?.route.reviewed === true, changed: loaded?.changed === true,
      index: tracker?.index ?? 0, startIndex: tracker?.startIndex ?? 0, total: tracker?.steps.length ?? 0,
      text: tracker?.current?.text || '', kind: tracker?.current?.kind || '',
      saveInstructions, saveNotice,
      detected: tracker?.detected === true && !tracker.rememberedChoice, rememberedChoice: tracker?.rememberedChoice === true,
      tentative: tracker?.tentative === true, complete: tracker?.complete === true,
      toggleHotkey: settings.vnGuideToggleHotkey || '', nextHotkey: settings.vnGuideNextHotkey || '',
    };
  }
  function publish() {
    if (disposed) return;
    const state = snapshot();
    lastVisible = state.visible;
    hud.update(state);
    onChange(state);
  }
  function persist() {
    try { library.save(loaded, tracker.index); }
    catch { error = 'Could not save guide progress. Check that the GSM data folder is writable.'; }
  }
  function enterStep() {
    dismissed = false;
    // Defer the brief notice until there is a game capture to display it on.
    saveNoticeUntil = tracker.saveInstructions.length ? available ? now() + 8000 : null : 0;
  }
  async function configure(nextSettings, { refresh = false } = {}) {
    if (nextSettings.vnGuideMode !== settings.vnGuideMode) { peek = null; dismissed = false; }
    settings = { ...nextSettings };
    const key = JSON.stringify([settings.vnGuideEnabled === true, settings.vnGuideUrl || '', settings.vnGuideRoute || '']);
    if (!refresh && key === sourceKey) { publish(); return snapshot(); }
    sourceKey = key;
    const generation = ++epoch;
    if (!refresh) { loaded = null; tracker = null; }
    error = '';
    peek = null;
    dismissed = false;
    loading = settings.vnGuideEnabled === true && !!settings.vnGuideUrl?.trim();
    publish();
    if (!loading || disposed) return snapshot();
    try {
      const result = await library.load(settings.vnGuideUrl, settings.vnGuideRoute, refresh);
      if (disposed || epoch !== generation) return snapshot();
      loaded = result;
      tracker = new GuideTracker(result.steps, result.index);
      enterStep();
      persist();
    } catch (exception) {
      if (!disposed && epoch === generation) error = exception.message || 'Could not load VN-Guide.';
    } finally {
      if (!disposed && epoch === generation) { loading = false; publish(); }
    }
    return snapshot();
  }
  function setAvailable(value, currentGame) {
    const next = value === true;
    const changedGame = currentGame != null && game !== null && currentGame !== game;
    if (currentGame != null) game = currentGame;
    if (!next && available) {
      suspendedAt = now();
      tracker?.suspendDetection();
    }
    if (next && !available && suspendedAt !== null) {
      const hiddenFor = now() - suspendedAt;
      if (saveNoticeUntil > suspendedAt) saveNoticeUntil += hiddenFor;
      if (tentativeUntil > suspendedAt) tentativeUntil += hiddenFor;
      suspendedAt = null;
    }
    if (changedGame) { tracker?.resetDetection(); peek = null; }
    if (next && saveNoticeUntil === null) saveNoticeUntil = now() + 8000;
    if (next !== available || changedGame || snapshot().visible !== lastVisible) {
      available = next;
      publish();
    }
  }
  function observe(message) {
    if (disposed || !tracker || settings.vnGuideEnabled !== true) return;
    if (typeof message === 'string') { try { message = JSON.parse(message); } catch { return; } }
    if (message?.type === 'window_state') { setAvailable(available, message.game); return; }
    if (!available) return;
    const before = JSON.stringify([tracker.index, tracker.detected, tracker.rememberedChoice, tracker.tentative]);
    const previousIndex = tracker.index;
    tracker.observe(message, now(), settings.vnGuideAutoAdvance !== false);
    if (tracker.index !== previousIndex) { tentativeUntil = now() + 6000; enterStep(); persist(); }
    if (tracker.detected) saveNoticeUntil = 0;
    if (before !== JSON.stringify([tracker.index, tracker.detected, tracker.rememberedChoice, tracker.tentative])) publish();
  }
  function command(action, value) {
    if (disposed) return snapshot();
    if (action === 'refresh') return configure(settings, { refresh: true });
    if (!tracker) return snapshot();
    if (action === 'toggle') { dismissed = false; peek = !snapshot().visible; }
    else if (action === 'hide') {
      // Closing the heads-up must not suppress the save reminder at the choice.
      if (snapshot().saveNotice) saveNoticeUntil = 0;
      else dismissed = true;
    }
    else if (['next', 'back', 'jump'].includes(action)) {
      if (action === 'jump') tracker.jump(value);
      else tracker[action]();
      enterStep();
      loaded.changed = false;
      persist();
    }
    publish();
    return snapshot();
  }
  function dispose() { disposed = true; epoch += 1; hud.dispose(); }
  return { configure, snapshot, command, observe, setAvailable, dispose, syncBounds: () => hud.syncBounds() };
}

module.exports = { createVnGuideController };
