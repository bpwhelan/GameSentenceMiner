// GSM integration only: use Yomitan's settings API without editing vendor files.

function profileHasSetup(profile, input) {
  const anki = profile?.options?.anki;
  if (!anki?.enable || anki.server !== input.server || anki.fieldTemplates !== null
      || profile.options.general?.resultOutputMode !== 'group' || profile.conditionGroups?.length !== 0
      || !Array.isArray(anki.tags) || !(input.tags || []).every((tag) => anki.tags.includes(tag))
      || !Array.isArray(anki.cardFormats) || 'terms' in anki) return false;
  const formats = anki.cardFormats.filter((format) => format.type === 'term');
  return formats.length > 0 && formats.every((format) =>
    format.model === input.model && format.deck === input.deck && format.fields
    && Object.keys(format.fields).length === Object.keys(input.fields).length
    && Object.entries(input.fields).every(([key, value]) =>
      format.fields[key]?.value === value && format.fields[key]?.overwriteMode === 'coalesce'));
}

function configureProfile(options, input) {
  const names = { lapis: 'Lapis', kiku: 'Kiku', senren: 'Senren' };
  const name = names[input?.preset];
  if (!name || typeof input.model !== 'string' || input.model.toLowerCase() !== name.toLowerCase()
      || typeof input.deck !== 'string' || !input.deck.trim()
      || typeof input.server !== 'string' || !/^https?:\/\//.test(input.server)
      || !input.fields || typeof input.fields !== 'object' || Array.isArray(input.fields)
      || (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== 'string')))
      || Object.keys(input.fields).length === 0 || Object.keys(input.fields).length > 128
      || Object.entries(input.fields).some(([key, value]) => !key || typeof value !== 'string' || value.length > 20000)) {
    throw new Error('Invalid recommended Anki setup. Run setup again from GSM settings.');
  }
  const next = structuredClone(options);
  const active = next.profiles?.[next.profileCurrent];
  if (!active?.options?.anki || !active.options.general) {
    throw new Error('Yomitan settings are not ready. Open its settings once and retry.');
  }
  if (!Array.isArray(active.options.anki.cardFormats)) {
    throw new Error('Unsupported Yomitan settings format. Update the GSM overlay and retry.');
  }
  const baseName = `GSM - ${name}`;
  const existing = next.profiles.findIndex((profile) =>
    (profile.name === baseName || profile.name.startsWith(`${baseName} (`))
    && profileHasSetup(profile, input));
  if (existing >= 0) {
    next.profileCurrent = existing;
    return { options: next, profileName: next.profiles[existing].name };
  }
  const profile = structuredClone(active);
  profile.name = baseName;
  for (let suffix = 2; next.profiles.some((item) => item.name === profile.name); suffix++) {
    profile.name = `${baseName} (${suffix})`;
  }
  profile.conditionGroups = [];
  profile.options.anki.enable = true;
  profile.options.anki.server = input.server;
  profile.options.anki.fieldTemplates = null;
  profile.options.anki.tags = [...new Set([...(profile.options.anki.tags || []), ...(input.tags || [])])];
  // Current Yomitan stores every mining button in cardFormats, with structured fields.
  // Keep format order/icons so existing shortcuts still target the same buttons.
  const formats = profile.options.anki.cardFormats;
  if (!formats.some((format) => format.type === 'term')) {
    formats.push({ name: 'Expression', icon: 'big-circle', type: 'term' });
  }
  for (const format of formats) {
    if (format.type !== 'term') continue;
    format.model = input.model;
    format.deck = input.deck;
    format.fields = Object.fromEntries(Object.entries(input.fields).map(([key, value]) => [
      key, { value, overwriteMode: 'coalesce' },
    ]));
  }
  // Earlier GSM setup wrote this unused legacy key. Do not carry it into the new profile.
  delete profile.options.anki.terms;
  profile.options.general.resultOutputMode = 'group';
  next.profileCurrent = next.profiles.length;
  next.profiles.push(profile);
  return { options: next, profileName: profile.name };
}

async function configureYomitan(BrowserWindow, extension, input, deadline) {
  if (!extension?.id) {
    throw new Error('Start the GSM overlay with Yomitan selected, then retry.');
  }
  const remaining = Math.min(20000, deadline - Date.now());
  if (remaining <= 0) throw new Error('Setup request expired. Retry from GSM settings.');
  const window = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  let timer;
  try {
    return await Promise.race([
      (async () => {
        await window.loadURL(`chrome-extension://${extension.id}/settings.html`);
        return await window.webContents.executeJavaScript(`(async () => {
          const {API} = await import('./js/comm/api.js');
          const {WebExtension} = await import('./js/extension/web-extension.js');
          const api = new API(new WebExtension());
          const options = await api.optionsGetFull();
          const input = ${JSON.stringify(input)};
          const profileHasSetup = (${profileHasSetup.toString()});
          const result = (${configureProfile.toString()})(options, input);
          if (Date.now() >= ${Number(deadline)}) throw new Error('Setup request expired. Retry from GSM settings.');
          await api.setAllSettings(result.options, 'gsm-anki-setup');
          const saved = await api.optionsGetFull();
          const current = saved.profiles[saved.profileCurrent];
          if (current?.name !== result.profileName || !profileHasSetup(current, input)) {
            throw new Error('Yomitan did not keep the selected deck, note type and fields. Retry setup.');
          }
          return {profileName: result.profileName};
        })()`);
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Yomitan setup timed out. Open its settings and retry.')), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (!window.isDestroyed()) window.destroy();
  }
}

function createSetupHandler(configure, send) {
  // The overlay has two connections to the same backend. Share duplicate requests.
  const requests = new Map();
  return async (message) => {
    if (message?.type !== 'anki-setup-yomitan' || typeof message.request_id !== 'string') return;
    const id = message.request_id;
    if (!requests.has(id)) {
      const operation = Promise.resolve().then(async () => {
        try {
          if (!Number.isFinite(message.deadline) || message.deadline <= Date.now()) {
            throw new Error('Setup request expired. Retry from GSM settings.');
          }
          const result = await configure(message.data, message.deadline);
          return { type: 'anki-setup-yomitan-result', request_id: id, success: true, ...result };
        } catch (error) {
          return { type: 'anki-setup-yomitan-result', request_id: id, success: false, error: error.message || String(error) };
        }
      });
      requests.set(id, operation);
      if (requests.size > 32) requests.delete(requests.keys().next().value);
    }
    send(await requests.get(id));
  };
}

module.exports = { configureProfile, configureYomitan, createSetupHandler };
