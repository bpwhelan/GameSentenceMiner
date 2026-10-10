(() => {
  const { ipcRenderer } = require('electron');
  const el = id => document.getElementById(id);
  let routeSignature = '';
  function render(state) {
    if (!state) return;
    const routeSelect = el('vnGuideRoute');
    const routes = state.routes || [];
    const signature = JSON.stringify(routes);
    if (signature !== routeSignature) {
      routeSignature = signature;
      routeSelect.replaceChildren(new Option('From URL or first route', ''));
      for (const route of routes) routeSelect.add(new Option(`${route.title}${route.reviewed ? '' : ' (not reviewed upstream)'}`, route.id));
    }
    routeSelect.dataset.currentRoute = state.routeId || '';
    routeSelect.value = state.routeId || '';
    routeSelect.disabled = state.loading || !routes.length;
    el('vn-guide-status').textContent = state.error || (state.loading ? 'Loading VN-Guide…' : state.total
      ? `${state.title} · ${state.routeTitle} · ${state.complete ? 'Complete' : `Step ${state.index + 1} of ${state.total}`}${state.target ? ` · ${state.target}` : ''}${state.reviewed ? '' : ' · Route not yet reviewed upstream'}${state.changed ? ' · Guide content changed; check your position before continuing.' : ''}`
      : 'Enable the helper and choose a game guide.');
    el('vn-guide-current').textContent = state.text || '';
    const active = state.enabled && state.total > 0 && !state.loading;
    for (const name of ['back', 'next', 'toggle', 'jump']) el(`vn-guide-${name}`).disabled = !active;
    el('vn-guide-back').disabled = !active || state.index === 0;
    el('vn-guide-next').disabled = !active || state.complete;
    el('vn-guide-refresh').disabled = !state.enabled || state.loading;
    const step = el('vn-guide-step');
    step.disabled = !active;
    step.max = String(state.total || 1);
    if (document.activeElement !== step) step.value = String(Math.min((state.index || 0) + 1, state.total || 1));
  }
  async function command(action, value) {
    try { render(await ipcRenderer.invoke('vn-guide-command', { action, value })); }
    catch { el('vn-guide-status').textContent = 'Could not reach the guide helper. Try again after reopening Overlay Settings.'; }
  }
  for (const action of ['back', 'next', 'toggle', 'refresh']) el(`vn-guide-${action}`).addEventListener('click', () => command(action));
  el('vn-guide-jump').addEventListener('click', () => command('jump', Number(el('vn-guide-step').value) - 1));
  el('vn-guide-import').addEventListener('click', () => command('use-custom-page'));
  ipcRenderer.on('vn-guide-state', (_event, state) => render(state));
  void ipcRenderer.invoke('vn-guide-state').then(render).catch(() => {});
})();
