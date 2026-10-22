window.vnGuide.onState(state => {
  const el = id => document.getElementById(id);
  const card = document.querySelector('.card');
  const choiceLogged = typeof state.loggedChoice === 'string';
  card.dataset.choiceLogged = String(choiceLogged);
  card.dataset.displayStyle = state.displayStyle === 'text' ? 'text' : 'card';
  card.dataset.kind = choiceLogged ? '' : state.kind;
  card.dataset.saveNotice = String(!choiceLogged && state.saveNotice === true);
  card.dataset.complete = String(!choiceLogged && state.complete === true);
  for (const id of ['progress', 'route', 'note']) el(id).hidden = choiceLogged;
  if (choiceLogged) {
    el('status').textContent = 'VN Guide';
    // Clear all previous content, including hidden controls, so no future
    // instruction or route information is exposed by the confirmation.
    for (const id of ['progress', 'route', 'save-reminder', 'note', 'shortcut', 'next']) el(id).textContent = '';
    el('save-reminder').hidden = true;
    el('instruction').textContent = `Choice ${state.loggedChoice} logged`;
    el('instruction').lang = 'en';
    document.querySelector('footer').hidden = true;
    el('hide').title = 'Hide confirmation';
    el('next').disabled = true;
    el('next').title = '';
    return;
  }
  el('instruction').lang = 'ja';
  const saves = state.saveInstructions || [];
  const startIndex = state.startIndex ?? state.index;
  el('status').textContent = state.saveNotice ? 'Next step: save' : state.complete ? 'Route complete' : state.kind === 'save' ? 'Save your game' : state.kind === 'load' ? 'Load your save' : state.detected ? 'Choice detected' : state.rememberedChoice ? 'Last detected choice' : 'Next guide step';
  el('progress').textContent = `${startIndex < state.index ? `${startIndex + 1}–` : ''}${Math.min(state.index + 1, state.total)} / ${state.total}`;
  el('route').textContent = state.routeTitle;
  el('instruction').textContent = state.saveNotice ? saves.join('\n') : state.complete ? 'おつかれさま！' : state.text;
  el('save-reminder').hidden = state.saveNotice || !saves.length;
  el('save-reminder').textContent = saves.length && !state.saveNotice ? `Save before choosing: ${saves.join(' · ')}` : '';
  let note;
  if (state.saveNotice) note = 'Save at your earliest convenience, ideally at the next choice.';
  else if (state.complete) note = state.nextRoute
    ? `Continue to ${state.nextRoute.title}${state.nextHotkey ? ` · ${state.nextHotkey}` : ''}`
    : 'You have reached the last route in this guide.';
  else if (state.kind === 'save' || state.kind === 'load') note = 'Do this in the game, then press Done.';
  else if (state.recoveredFrom != null) note = `Caught up from step ${state.recoveredFrom + 1}; ${saves.length ? 'save here before choosing. ' : ''}Back undoes this.`;
  else if (state.rememberedChoice) note = 'Waiting for a fresh scan. You can also advance manually.';
  else if (saves.length) note = state.detected ? 'Save here, then choose this option in the game.' : state.tentative ? 'Save at the next choice. Back undoes the last advance if needed.' : 'At the next choice screen, save first, then choose this option.';
  else note = state.tentative ? 'Advanced after the menu cleared. Back undoes this if needed.' : state.detected ? 'Choose this option in the game.' : 'Waiting for a choice screen. You can advance manually.';
  el('note').textContent = state.error || (state.updateAvailable ? 'Guide update available. Reload in Overlay Settings → VN Guide.' : note);
  document.querySelector('footer').hidden = state.saveNotice === true;
  el('hide').title = state.saveNotice ? 'Dismiss this notice; the save reminder returns at the choice' : 'Hide this card; automatic mode shows it again at the next choice';
  el('shortcut').textContent = state.nextHotkey;
  el('back').disabled = state.loading || startIndex === 0;
  el('next').disabled = state.loading || (state.complete && !state.nextRoute) || state.saveNotice;
  el('next').textContent = state.complete && state.nextRoute ? `Continue to ${state.nextRoute.title}` : state.kind === 'save' || state.kind === 'load' ? 'Done' : 'Next';
  el('next').title = el('next').textContent;
});
for (const action of ['back', 'next', 'hide']) document.getElementById(action).addEventListener('click', () => window.vnGuide.command(action));
