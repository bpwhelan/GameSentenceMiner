window.vnGuide.onState(state => {
  const el = id => document.getElementById(id);
  document.querySelector('.card').dataset.kind = state.kind;
  el('status').textContent = state.complete ? 'Route complete' : state.kind === 'save' ? 'Save your game' : state.kind === 'load' ? 'Load your save' : state.detected ? 'Choice detected' : 'Next guide step';
  el('progress').textContent = `${Math.min(state.index + 1, state.total)} / ${state.total}`;
  el('route').textContent = state.routeTitle;
  el('instruction').textContent = state.complete ? 'おつかれさま！' : state.text;
  el('note').textContent = state.error || (state.tentative ? 'Advanced after the menu cleared. Back undoes this if needed.' : state.complete ? 'Choose another route in Overlay Settings → VN Guide.' : state.kind === 'save' || state.kind === 'load' ? 'Do this in the game, then press Done.' : state.detected ? 'Choose this option in the game.' : 'Waiting for a choice screen. You can advance manually.');
  el('shortcut').textContent = state.nextHotkey;
  el('back').disabled = state.index === 0;
  el('next').disabled = state.complete;
  el('next').textContent = state.kind === 'save' || state.kind === 'load' ? 'Done' : 'Next';
});
for (const action of ['back', 'next', 'hide']) document.getElementById(action).addEventListener('click', () => window.vnGuide.command(action));
