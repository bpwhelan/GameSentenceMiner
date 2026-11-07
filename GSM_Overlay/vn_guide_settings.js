(() => {
  const { ipcRenderer } = require('electron');
  const el = id => document.getElementById(id);
  let routeSignature = '';
  let catalogueGuides = [];
  let catalogueGeneration = 0;
  let catalogueLoading = false;
  let catalogueMessage = '';
  let sourceUrl = '';

  function renderCatalogue() {
    const search = el('vn-guide-search').value.trim().toLocaleLowerCase();
    const guides = catalogueGuides.filter(game => [game.title, game.alttitle, game.slug, game.target]
      .some(value => (value || '').toLocaleLowerCase().includes(search)))
      .sort((a, b) => a.title.localeCompare(b.title));
    const select = el('vn-guide-catalogue');
    select.replaceChildren(new Option(catalogueLoading ? 'Loading catalogue…' : 'Choose a guide…', ''));
    for (const game of guides) select.add(new Option(`${game.title}${game.alttitle && game.alttitle !== game.title ? ` · ${game.alttitle}` : ''}${game.target ? ` — ${game.target}` : ''}`, game.url));
    select.value = guides.some(game => game.url === sourceUrl) ? sourceUrl : '';
    select.disabled = catalogueLoading || !guides.length;
    el('vn-guide-catalogue-refresh').disabled = catalogueLoading;
    el('vn-guide-catalogue-status').textContent = catalogueLoading ? 'Loading guide catalogue…'
      : [catalogueMessage, catalogueGuides.length ? `${guides.length} of ${catalogueGuides.length} guides available.` : 'No guides available.'].filter(Boolean).join(' ');
  }

  async function loadCatalogue(options = {}) {
    const generation = ++catalogueGeneration;
    catalogueLoading = true;
    renderCatalogue();
    try {
      const result = await ipcRenderer.invoke('vn-guide-catalogue', { refresh: true, ...options });
      if (generation !== catalogueGeneration) return;
      if (result?.cancelled) return;
      catalogueGuides = result?.guides || [];
      catalogueMessage = result?.error || result?.warning || '';
      if (result?.source && document.activeElement !== el('vnGuideCatalogueSource')) el('vnGuideCatalogueSource').value = result.source;
    } catch {
      if (generation !== catalogueGeneration) return;
      catalogueGuides = []; catalogueMessage = 'Could not load the guide catalogue. Try refreshing it.';
    }
    finally {
      if (generation === catalogueGeneration) { catalogueLoading = false; renderCatalogue(); }
    }
  }

  function render(state) {
    if (!state) return;
    if (typeof state.sourceUrl === 'string') sourceUrl = state.sourceUrl;
    el('vn-guide-catalogue').value = catalogueGuides.some(game => game.url === sourceUrl) ? sourceUrl : '';
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
    const startIndex = state.startIndex ?? state.index;
    const position = startIndex < state.index ? `Steps ${startIndex + 1}–${state.index + 1}` : `Step ${state.index + 1}`;
    el('vn-guide-status').textContent = state.error || (state.loading ? 'Loading VN-Guide…' : state.total
      ? `${state.title} · ${state.routeTitle} · ${state.complete ? 'Complete' : `${position} of ${state.total}`}${state.target ? ` · ${state.target}` : ''}${state.reviewed ? '' : ' · Route not yet reviewed upstream'}${state.changed ? ' · Guide content changed; check your position before continuing.' : ''}${state.recoveredFrom != null ? ` · Caught up from step ${state.recoveredFrom + 1}; Back undoes this.` : ''}`
      : 'Enable the helper and choose a game guide.');
    el('vn-guide-current').textContent = state.complete ? 'おつかれさま！' : state.text || '';
    const updateStatus = [];
    if (state.updateAvailable) updateStatus.push('A guide update is available. Reload to apply it; changed instructions may reset your position.');
    if (state.checkingUpdates) updateStatus.push('Checking for guide updates…');
    else if (state.updateError) updateStatus.push(`Could not check for updates: ${state.updateError}. Your cached guide is still available.`);
    else if (state.lastCheckedAt != null) updateStatus.push(`${state.updateAvailable ? 'Last checked' : 'Guide is up to date. Last checked'}: ${new Date(state.lastCheckedAt).toLocaleString()}.`);
    el('vn-guide-update-status').textContent = updateStatus.join(' ');
    const saves = state.saveInstructions || [];
    el('vn-guide-save').hidden = !saves.length;
    el('vn-guide-save').textContent = saves.length ? `Save before choosing: ${saves.join(' · ')}` : '';
    const active = state.enabled && state.total > 0 && !state.loading;
    for (const name of ['back', 'next', 'toggle', 'jump']) el(`vn-guide-${name}`).disabled = !active;
    el('vn-guide-back').disabled = !active || startIndex === 0;
    el('vn-guide-next').disabled = !active || (state.complete && !state.nextRoute);
    el('vn-guide-next').textContent = state.complete && state.nextRoute ? `Continue to ${state.nextRoute.title}` : 'Next / Done';
    el('vn-guide-refresh').disabled = !state.enabled || state.loading || state.checkingUpdates;
    el('vn-guide-refresh').textContent = state.updateAvailable ? 'Update guide from source' : 'Reload guide from source';
    el('vn-guide-check-updates').disabled = !active || state.checkingUpdates;
    const step = el('vn-guide-step');
    step.disabled = !active;
    step.max = String(state.total || 1);
    if (document.activeElement !== step) step.value = String(Math.min((state.index || 0) + 1, state.total || 1));
  }
  async function command(action, value) {
    try { render(await ipcRenderer.invoke('vn-guide-command', { action, value })); }
    catch { el('vn-guide-status').textContent = 'Could not reach the guide helper. Try again after reopening Overlay Settings.'; }
  }
  for (const action of ['back', 'next', 'toggle', 'refresh', 'check-updates']) el(`vn-guide-${action}`).addEventListener('click', () => command(action));
  el('vn-guide-jump').addEventListener('click', () => command('jump', Number(el('vn-guide-step').value) - 1));
  el('vn-guide-import').addEventListener('click', () => command('use-custom-page'));
  el('vn-guide-folder').addEventListener('click', () => command('choose-local'));
  el('vnGuideCatalogueSource').addEventListener('change', () => loadCatalogue({ source: el('vnGuideCatalogueSource').value }));
  el('vn-guide-catalogue-default').addEventListener('click', () => loadCatalogue({ source: '' }));
  el('vn-guide-catalogue-folder').addEventListener('click', () => loadCatalogue({ chooseFolder: true }));
  el('vn-guide-catalogue-refresh').addEventListener('click', () => loadCatalogue({ source: el('vnGuideCatalogueSource').value }));
  el('vn-guide-search').addEventListener('input', renderCatalogue);
  el('vn-guide-catalogue').addEventListener('change', () => {
    const url = el('vn-guide-catalogue').value;
    if (url) void command('select-guide', url);
  });
  ipcRenderer.on('vn-guide-state', (_event, state) => render(state));
  ipcRenderer.on('settings-updated', () => { void ipcRenderer.invoke('vn-guide-state').then(render).catch(() => {}); });
  void ipcRenderer.invoke('vn-guide-state').then(render).catch(() => {});
  void loadCatalogue();
})();
