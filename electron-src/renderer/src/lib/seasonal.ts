import { getSeasonalEvent } from '../../../shared/seasonal';

let effectsDisabled = false;

function refreshSeasonalEffects(): void {
  const event = getSeasonalEvent(effectsDisabled);
  if (event) {
    if (document.documentElement.dataset.season !== event) document.documentElement.dataset.season = event;
  } else if (document.documentElement.dataset.season) delete document.documentElement.dataset.season;
}

export function setSeasonalEffectsDisabled(disabled: boolean): void {
  effectsDisabled = disabled;
  refreshSeasonalEffects();
}

/** Keep long-running and resumed windows in sync with the date and blanket opt out. */
export function startSeasonalEffects(disabled: boolean): () => void {
  setSeasonalEffectsDisabled(disabled);
  const off = window.ipcRenderer.on('settings.seasonalEffectsChanged', (_event, value) => {
    if (typeof value === 'boolean') setSeasonalEffectsDisabled(value);
  });
  let timer: ReturnType<typeof setTimeout>;
  const refresh = () => {
    clearTimeout(timer);
    refreshSeasonalEffects();
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    timer = setTimeout(refresh, midnight.getTime() - now.getTime());
  };
  refresh();
  window.addEventListener('focus', refresh);
  return () => {
    off();
    clearTimeout(timer);
    window.removeEventListener('focus', refresh);
  };
}
