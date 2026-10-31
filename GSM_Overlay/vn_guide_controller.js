const { GuideTracker, normalizeChoice, parseGuideUrl } = require('./vn_guide');
const { prepareTextLines } = require('./block_detection');
const { UPDATE_INTERVAL_MS } = require('./vn_guide_library');

function createVnGuideController({ library, hud, onChange = () => {}, onRouteChange = () => {}, now = Date.now }) {
  let settings = {};
  let loaded = null;
  let tracker = null;
  let loading = false;
  let error = '';
  let epoch = 0;
  let disposed = false;
  let available = false;
  let peek = null;
  let peekLines = 0;
  let dismissed = false;
  let dismissedAtChoice = false;
  let lastActivity = null;
  let sourceKey = '';
  let sourceUrl = '';
  let game = null;
  let loggedChoice = null;
  let loggedUntil = 0;
  let saveNoticeUntil = 0;
  let suspendedAt = null;
  let lastVisible = false;
  let checkingUpdates = false;
  let updateAvailable = false;
  let updateError = '';
  let lastCheckedAt = null;
  let nextUpdateCheckAt = 0;
  let updateCheck = null;

  function nextRoute() {
    if (!tracker?.complete || !loaded) return null;
    const index = loaded.guide.routes.findIndex(route => route.id === loaded.route.id);
    return index >= 0 ? loaded.guide.routes[index + 1] || null : null;
  }
  function snapshot() {
    const mode = ['auto', 'always', 'hotkey'].includes(settings.vnGuideMode) ? settings.vnGuideMode : 'auto';
    const saveInstructions = tracker?.saveInstructions || [];
    const saveNotice = loggedChoice === null && saveInstructions.length > 0 && mode === 'auto' && peek !== true && !tracker.detected && saveNoticeUntil > now();
    const automatic = tracker && (mode === 'always' || mode === 'auto' && (tracker.detected || tracker.current?.kind !== 'choice' || saveNotice));
    // Auto and hotkey modes retain the expired confirmation so the upcoming
    // step stays hidden. Always mode clears it on the availability tick.
    const showing = loggedChoice !== null
      ? mode === 'always' || (mode === 'auto' || peek === true) && now() < loggedUntil
      : peek ?? !!automatic;
    return {
      enabled: settings.vnGuideEnabled === true, loading, error, mode,
      sourceUrl,
      checkingUpdates, updateAvailable, updateError, lastCheckedAt,
      displayStyle: settings.vnGuideDisplayStyle === 'text' ? 'text' : 'card',
      visible: !disposed && available && settings.vnGuideEnabled === true && !!tracker && !dismissed && showing,
      title: loaded?.guide.title || '', target: loaded?.guide.target || '',
      routes: loaded?.guide.routes || [], routeId: loaded?.route.id || '', routeTitle: loaded?.route.title || '',
      nextRoute: nextRoute(),
      reviewed: loaded?.route.reviewed === true, changed: loaded?.changed === true,
      index: tracker?.index ?? 0, startIndex: tracker?.startIndex ?? 0, total: tracker?.steps.length ?? 0,
      text: tracker?.current?.text || '', kind: tracker?.current?.kind || '',
      saveInstructions, saveNotice, loggedChoice,
      detected: tracker?.detected === true && !tracker.rememberedChoice, rememberedChoice: tracker?.rememberedChoice === true,
      tentative: tracker?.tentative === true, complete: tracker?.complete === true,
      recoveredFrom: tracker?.recoveredFrom ?? null,
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
    clearLoggedChoice();
    dismissed = false;
    dismissedAtChoice = false;
    // Defer the brief notice until there is a game capture to display it on.
    saveNoticeUntil = tracker.saveInstructions.length ? available ? now() + 8000 : null : 0;
  }
  function clearLoggedChoice() {
    loggedChoice = null;
    loggedUntil = 0;
  }
  function logChoice(step) {
    if (step?.kind !== 'choice') return;
    loggedChoice = step.text;
    loggedUntil = now() + 4000;
    saveNoticeUntil = 0;
    peekLines = 0;
  }
  function resetVisibility() {
    peek = null;
    peekLines = 0;
    dismissed = false;
    dismissedAtChoice = false;
  }
  function revealStep() {
    resetVisibility();
    clearLoggedChoice();
    peek = true;
  }
  function dismiss(holdChoice = true) {
    peek = null;
    peekLines = 0;
    dismissed = true;
    dismissedAtChoice = holdChoice && (tracker.detected || !!tracker.armed);
  }
  function observeActivity(message, choiceObserved) {
    let text, lineId, presenceId;
    if (message?.type === 'game_text') {
      text = normalizeChoice(message.text);
    } else if (message?.type === 'word_coordinates' && message.is_final === true && !message.supplemental && Array.isArray(message.data) && message.data.length) {
      text = normalizeChoice(message.latest_text || prepareTextLines(message.data).map(line => line.text).join('\n'));
      lineId = message.line_id;
      presenceId = message.presence_id;
    } else return;
    if (!text) return;
    // A text-feed event and its OCR result describe the same line. Final OCR
    // revisions and rescans also must not consume another line of a preview.
    const repeated = lastActivity && (lastActivity.text === text
      || (lineId && lineId === lastActivity.lineId) || (presenceId && presenceId === lastActivity.presenceId)
      // Plaintext has no line ID; growing text is usually a revision of the
      // current line as the game's text animation or OCR finishes.
      || ((!lineId || !lastActivity.lineId) && (text.startsWith(lastActivity.text) || lastActivity.text.startsWith(text))));
    lastActivity = {
      text, lineId: lineId || (repeated ? lastActivity.lineId : null),
      presenceId: presenceId || (repeated ? lastActivity.presenceId : null),
    };
    if (repeated || loggedChoice !== null || peek !== true || settings.vnGuideMode === 'always' || choiceObserved) return;
    if (message.type === 'game_text' && (tracker.armed?.options || [normalizeChoice(tracker.current?.text)]).includes(text)) return;
    if (++peekLines >= 2) dismiss(false);
  }
  async function checkForUpdates(force = false) {
    if (disposed || loading || !loaded || settings.vnGuideEnabled !== true || !library.checkForUpdates) return snapshot();
    if (updateCheck?.generation === epoch) return updateCheck.promise;
    const generation = epoch;
    const current = loaded;
    checkingUpdates = true;
    updateError = '';
    nextUpdateCheckAt = now() + UPDATE_INTERVAL_MS;
    publish();
    const check = { generation };
    updateCheck = check;
    check.promise = (async () => {
      try {
        const latest = await library.checkForUpdates(current, { force });
        if (disposed || epoch !== generation) return snapshot();
        updateAvailable = latest.fingerprint !== current.fingerprint || JSON.stringify(latest.guide) !== JSON.stringify(current.guide);
        lastCheckedAt = now();
      } catch (exception) {
        if (!disposed && epoch === generation) updateError = exception.message || 'Could not check VN-Guide for updates.';
      } finally {
        if (!disposed && epoch === generation) {
          checkingUpdates = false;
          nextUpdateCheckAt = now() + UPDATE_INTERVAL_MS;
          publish();
        }
        if (updateCheck === check) updateCheck = null;
      }
      return snapshot();
    })();
    return check.promise;
  }
  async function configure(nextSettings, { refresh = false } = {}) {
    if (nextSettings.vnGuideMode !== settings.vnGuideMode) resetVisibility();
    settings = { ...nextSettings };
    try { sourceUrl = parseGuideUrl(settings.vnGuideUrl).baseUrl; } catch { sourceUrl = ''; }
    const key = JSON.stringify([settings.vnGuideEnabled === true, settings.vnGuideUrl || '', settings.vnGuideRoute || '']);
    if (!refresh && key === sourceKey) { publish(); return snapshot(); }
    sourceKey = key;
    const generation = ++epoch;
    checkingUpdates = false;
    if (!refresh) { updateAvailable = false; lastCheckedAt = null; }
    updateError = '';
    if (!refresh) { loaded = null; tracker = null; }
    error = '';
    resetVisibility();
    clearLoggedChoice();
    lastActivity = null;
    loading = settings.vnGuideEnabled === true && !!settings.vnGuideUrl?.trim();
    publish();
    if (!loading || disposed) return snapshot();
    try {
      const result = await library.load(settings.vnGuideUrl, settings.vnGuideRoute, refresh);
      if (disposed || epoch !== generation) return snapshot();
      loaded = result;
      updateAvailable = false;
      tracker = new GuideTracker(result.steps, result.index);
      enterStep();
      persist();
    } catch (exception) {
      if (!disposed && epoch === generation) error = exception.message || 'Could not load VN-Guide.';
    } finally {
      if (!disposed && epoch === generation) { loading = false; publish(); }
    }
    if (!disposed && epoch === generation && loaded && !error) void checkForUpdates();
    return snapshot();
  }
  async function continueRoute() {
    const route = nextRoute();
    if (!route || settings.vnGuideEnabled !== true) return snapshot();
    const generation = ++epoch;
    loading = true;
    checkingUpdates = false;
    error = '';
    publish();
    try {
      // Keep the completed route available if the next route cannot be loaded.
      const result = await library.load(settings.vnGuideUrl, route.id);
      if (disposed || epoch !== generation) return snapshot();
      onRouteChange(result.route.id);
      settings = { ...settings, vnGuideRoute: result.route.id };
      sourceKey = JSON.stringify([settings.vnGuideEnabled === true, settings.vnGuideUrl || '', settings.vnGuideRoute]);
      loaded = result;
      tracker = new GuideTracker(result.steps, result.index);
      updateAvailable = false;
      updateError = '';
      lastCheckedAt = null;
      resetVisibility();
      lastActivity = null;
      enterStep();
      persist();
    } catch (exception) {
      if (!disposed && epoch === generation) error = exception.message || 'Could not load the next route. Try again.';
    } finally {
      if (!disposed && epoch === generation) { loading = false; publish(); }
    }
    if (!disposed && epoch === generation && !error) void checkForUpdates();
    return snapshot();
  }
  function setAvailable(value, currentGame) {
    // The overlay calls this on its existing availability tick, even without a
    // capture. Keep WIP checks running without adding a separate timer.
    if (now() >= nextUpdateCheckAt) void checkForUpdates();
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
      if (loggedUntil > suspendedAt) loggedUntil += hiddenFor;
      suspendedAt = null;
    }
    if (changedGame) { tracker?.resetDetection(); resetVisibility(); clearLoggedChoice(); lastActivity = null; }
    if (next && saveNoticeUntil === null) saveNoticeUntil = now() + 8000;
    const showNextStep = next && settings.vnGuideMode === 'always' && loggedChoice !== null && now() >= loggedUntil;
    if (showNextStep) clearLoggedChoice();
    // Publish the replacement even though Always mode keeps the HUD visible.
    if (next !== available || changedGame || showNextStep || snapshot().visible !== lastVisible) {
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
    const previousStep = tracker.current;
    const previousArmed = tracker.armed;
    tracker.observe(message, now(), settings.vnGuideAutoAdvance !== false);
    if (tracker.index !== previousIndex) {
      enterStep();
      if (!tracker.detected) logChoice(previousStep);
      persist();
    }
    if (tracker.detected) { saveNoticeUntil = 0; clearLoggedChoice(); }
    const choiceObserved = tracker.detected && tracker.armed !== previousArmed;
    if (choiceObserved && ['word_coordinates', 'game_text'].includes(message?.type) && !dismissedAtChoice) dismissed = false;
    observeActivity(message, choiceObserved);
    if (before !== JSON.stringify([tracker.index, tracker.detected, tracker.rememberedChoice, tracker.tentative]) || snapshot().visible !== lastVisible) publish();
  }
  function command(action, value) {
    if (disposed) return snapshot();
    if (action === 'check-updates') return checkForUpdates(true);
    if (action === 'refresh') return configure(settings, { refresh: true });
    if (!tracker || loading) return snapshot();
    if (action === 'next' && loggedChoice !== null) {
      // Automatic progress already moved the tracker. Right opens that pending
      // instruction first, including after the confirmation has faded away.
      revealStep();
      publish();
      return snapshot();
    }
    if (action === 'next' && tracker.complete) return continueRoute();
    if (action === 'toggle') {
      if (snapshot().visible) dismiss();
      else revealStep();
    }
    else if (action === 'hide') {
      // Closing the heads-up must not suppress the save reminder at the choice.
      if (snapshot().saveNotice) saveNoticeUntil = 0;
      else dismiss();
    }
    else if (['next', 'back', 'jump'].includes(action)) {
      if (action === 'jump') tracker.jump(value);
      else tracker[action]();
      enterStep();
      if (action !== 'jump') revealStep();
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
