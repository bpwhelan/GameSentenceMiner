import { getSeasonalEvent } from '../../../shared/seasonal';

let effectsDisabled = false;

function refreshSeasonalEffects(): void {
  const event = getSeasonalEvent(effectsDisabled);
  if (event) document.documentElement.dataset.season = event;
  else delete document.documentElement.dataset.season;
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
  const timer = window.setInterval(refreshSeasonalEffects, 60_000);
  window.addEventListener('focus', refreshSeasonalEffects);
  return () => {
    off();
    window.clearInterval(timer);
    window.removeEventListener('focus', refreshSeasonalEffects);
  };
}
