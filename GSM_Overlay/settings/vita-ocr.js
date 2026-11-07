window.GSMVitaModelSettings = (() => {
  const row = document.getElementById('vita-ocr-model-row');
  const select = document.getElementById('vita-ocr-model');
  const message = document.getElementById('vita-ocr-model-status');
  const error = document.getElementById('vita-ocr-model-error');
  const retry = document.getElementById('vita-ocr-model-refresh');
  let status = null;
  let changing = false;
  let refreshing = false;
  let generation = 0;
  let attemptedSetup = false;
  function render(failure = '') {
    if (!changing) select.value = status?.model || 'normal';
    select.disabled = changing || !status || status.supported === false || status.busy;
    message.textContent = changing || status?.busy ? 'Downloading and checking VOCR runtime and model…'
      : status?.available ? `Selected model: ${status.model}. Ready for the next scan.`
      : 'VOCR will download its runtime and model automatically. An internet connection is needed for the first setup.';
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
      const next = await ipcRenderer.invoke('overlay-vita-model', {});
      if (!changing && started === generation) {
        status = next;
        render();
        if (!status.available && !status.busy && status.supported !== false && !attemptedSetup) {
          attemptedSetup = true;
          await prepare(status.model);
        }
      }
    } catch (cause) { if (!changing && started === generation) render(String(cause.message || cause)); }
    finally { refreshing = false; }
  }
  function sync() {
    const wasHidden = row.hidden;
    row.hidden = document.getElementById('engine_v2').value !== 'vitaocr';
    document.getElementById('vocr-detector-help').hidden = document.getElementById('engine_v2').value !== 'vocr_lens';
    if (wasHidden && !row.hidden) void refresh();
  }
  async function prepare(model) {
    if (changing) return;
    generation += 1;
    changing = true;
    render();
    let failure = '';
    try { status = await ipcRenderer.invoke('overlay-vita-model', { model }); }
    catch (cause) { failure = String(cause.message || cause); }
    finally { changing = false; render(failure); }
  }
  select.addEventListener('change', () => void prepare(select.value));
  retry.addEventListener('click', () => void (status && !status.available && status.supported !== false
    ? prepare(status.model) : refresh()));
  window.addEventListener('focus', () => void refresh());
  const timer = setInterval(() => void refresh(), 3000);
  window.addEventListener('beforeunload', () => clearInterval(timer));
  return { sync };
})();
