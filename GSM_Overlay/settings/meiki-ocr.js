window.GSMMeikiModelSettings = (() => {
  const row = document.getElementById('meiki-ocr-model-row');
  const select = document.getElementById('meiki-ocr-model');
  const message = document.getElementById('meiki-ocr-model-status');
  const error = document.getElementById('meiki-ocr-model-error');
  const retry = document.getElementById('meiki-ocr-model-refresh');
  let status = null;
  let changing = false;
  let refreshing = false;
  let generation = 0;
  function render(failure = '') {
    if (!changing) select.value = status?.model || 'large';
    select.disabled = changing || !status?.available || status.busy;
    message.textContent = changing || status?.busy ? 'Downloading and checking model…'
      : status?.available ? `Selected model: ${status.model}. Ready for the next scan.`
      : 'MeikiOCR is unavailable. Check the backend and local installation.';
    const detail = failure || status?.error || '';
    error.textContent = detail;
    error.hidden = !detail;
    retry.hidden = !detail;
    retry.disabled = changing;
  }
  async function refresh() {
    if (row.hidden || changing || refreshing) return;
    refreshing = true;
    const started = generation;
    try {
      const next = await ipcRenderer.invoke('overlay-meiki-model', {});
      if (!changing && started === generation) { status = next; render(); }
    } catch (cause) { if (!changing && started === generation) render(String(cause.message || cause)); }
    finally { refreshing = false; }
  }
  function sync() {
    const wasHidden = row.hidden;
    row.hidden = document.getElementById('engine_v2').value !== 'meikiocr';
    if (wasHidden && !row.hidden) void refresh();
  }
  select.addEventListener('change', async () => {
    generation += 1;
    changing = true;
    const model = select.value;
    render();
    let failure = '';
    try { status = await ipcRenderer.invoke('overlay-meiki-model', { model }); }
    catch (cause) { failure = String(cause.message || cause); }
    finally { changing = false; render(failure); }
  });
  retry.addEventListener('click', () => void refresh());
  window.addEventListener('focus', () => void refresh());
  const timer = setInterval(() => void refresh(), 3000);
  window.addEventListener('beforeunload', () => clearInterval(timer));
  return { sync };
})();
