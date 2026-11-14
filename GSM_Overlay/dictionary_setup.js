// GSM onboarding uses each reader's public settings/import APIs. Vendor files
// and the user's browser extension storage are never rewritten directly.
const fs = require('node:fs');
const path = require('node:path');

function recommendedDictionary(catalogue, language) {
  const terms = catalogue[language]?.terms || [];
  return (language === 'ja' ? terms.find(item => /jitendex/i.test(item.name)) : null) || terms[0] || null;
}

function matchesRecommendation(dictionary, recommendation, language) {
  if (!recommendation) return false;
  return dictionary.downloadUrl === recommendation.downloadUrl
    || dictionary.title === recommendation.name
    || dictionary.title.startsWith(`${recommendation.name} [`)
    || (language === 'ja' && /^Jitendex(?:\.org)?(?:\s|$)/i.test(dictionary.title));
}

// This function runs inside an extension document, where its modules and
// IndexedDB belong. It is serialized below; keep its dependencies local.
async function yomitanAction(action, language, recommendation, matches) {
  const { API } = await import('./js/comm/api.js');
  const { WebExtension } = await import('./js/extension/web-extension.js');
  const api = new API(new WebExtension());
  let options = await api.optionsGetFull();
  let dictionaries = await api.getDictionaryInfo();
  const stored = await chrome.storage.local.get('gsmOnboardingDictionaries');
  const known = stored.gsmOnboardingDictionaries || {};
  if (action === 'install') {
    if (!recommendation) throw new Error('No starter dictionary is available for this language. Import one from dictionary settings.');
    let summary = dictionaries.find(item => (matches(item, recommendation, language)
      || item.title === known[recommendation.downloadUrl]) && item.importSuccess !== false);
    if (!summary) {
      window.__gsmDictionaryStage = 'downloading';
      const response = await fetch(recommendation.downloadUrl, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`Dictionary download failed (${response.status}). Retry or import it from settings.`);
      const limit = 256 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > limit) throw new Error('Dictionary download exceeds 256 MiB. Import it from settings.');
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) { await reader.cancel(); throw new Error('Dictionary download exceeds 256 MiB. Import it from settings.'); }
        chunks.push(value);
      }
      window.__gsmDictionaryStage = 'importing';
      const { DictionaryWorker } = await import('./js/dictionary/dictionary-worker.js');
      const archive = await new Blob(chunks).arrayBuffer();
      const result = await new DictionaryWorker().importDictionary(archive, {
        prefixWildcardsSupported: options.global.database.prefixWildcardsSupported,
        yomitanVersion: chrome.runtime.getManifest().version,
      }, () => {});
      if (!result.result || result.errors?.length) {
        throw new Error(result.errors?.[0]?.message || 'Dictionary import did not finish. Check dictionary settings before retrying.');
      }
      summary = result.result;
    }
    // Invalidate any open Settings page's cached inventory before publishing
    // the new options. Otherwise its reconciliation can remove the new entry.
    await api.triggerDatabaseUpdated('dictionary', 'import');
    // Re-read after a potentially long import; preserve edits made in Settings.
    options = await api.optionsGetFull();
    const index = options.profileCurrent;
    const profile = options.profiles[index];
    const { DictionaryController } = await import('./js/pages/settings/dictionary-controller.js');
    const dictionaryIndex = profile.options.dictionaries.findIndex(item => item.name === summary.title);
    const targets = [
      { action: 'set', path: `profiles[${index}].options.general.language`, value: language },
      { action: 'set', path: `profiles[${index}].options.general.enable`, value: true },
      dictionaryIndex < 0
        ? { action: 'push', path: `profiles[${index}].options.dictionaries`, items: [DictionaryController.createDefaultDictionarySettings(summary.title, true, summary.styles)] }
        : { action: 'set', path: `profiles[${index}].options.dictionaries[${dictionaryIndex}].enabled`, value: true },
    ];
    if (summary.sequenced && !profile.options.general.mainDictionary) {
      targets.push({ action: 'set', path: `profiles[${index}].options.general.mainDictionary`, value: summary.title });
    }
    const results = await api.modifySettings(targets.map(target => ({ ...target, scope: 'global' })), 'gsm-onboarding');
    if (results.some(result => result.error)) throw new Error('The dictionary was imported but could not be enabled. Open dictionary settings and retry.');
    options = await api.optionsGetFull();
    dictionaries = await api.getDictionaryInfo();
    const current = options.profiles[options.profileCurrent].options;
    if (current.general.language !== language || !current.dictionaries.some(item => item.name === summary.title && item.enabled)
        || !dictionaries.some(item => item.title === summary.title && item.importSuccess !== false)) {
      throw new Error('The dictionary could not be verified. Open dictionary settings and retry.');
    }
    known[recommendation.downloadUrl] = summary.title;
    await chrome.storage.local.set({ gsmOnboardingDictionaries: known });
  }
  const current = options.profiles[options.profileCurrent].options;
  const enabled = new Set(current.dictionaries.filter(item => item.enabled).map(item => item.name));
  return {
    installed: current.general.enable && current.general.language === language
      ? dictionaries.filter(item => enabled.has(item.title) && item.importSuccess !== false
        && item.counts?.terms?.total > 0 && (!item.sourceLanguage || item.sourceLanguage === language
          // The catalogue also maps aliases such as Norwegian (no) to Bokmål
          // (nb). Its recommendation remains valid despite that metadata alias.
          || (recommendation && (known[recommendation.downloadUrl] === item.title || matches(item, recommendation, language))))).map(item => item.title) : [],
    stage: window.__gsmDictionaryStage,
  };
}

async function hachidoriStatus(language, enableExisting = false) {
  await import('./reader-options.js');
  const api = globalThis.HDReaderOptions;
  const [run, state, stored] = await Promise.all([
    chrome.runtime.sendMessage({ target: 'hachidori-setup', type: 'hd_setup_install', sourceIds: [] }),
    chrome.runtime.sendMessage({ target: 'hoshidicts-worker', type: 'hd_state_read' }),
    chrome.storage.local.get(['options', api.LANGUAGE_SELECTION_KEY]),
  ]);
  if (!run?.ok || !state?.ok) throw new Error(run?.error || state?.error || 'Hachidori is not ready. Retry in a moment.');
  const profileId = api.activeProfileId(stored.options, stored[api.LANGUAGE_SELECTION_KEY]);
  const profile = api.profiles(stored.options).find(item => item.id === profileId);
  let dictionaries = api.projectDictionaryState(state.state, profileId)?.dictionaries || [];
  if (enableExisting) {
    if (profile?.language !== language) throw new Error('Select your learning language in Hachidori settings before installing its dictionary.');
    const existing = dictionaries.find(item => item.termCount > 0 && /^Jitendex(?:\.org)?(?:\s|$)/i.test(item.title));
    if (existing?.enabled === false && run.finished !== false) {
      // Use the reader's revision-checked API so concurrent Settings edits are
      // preserved and the engine reloads its now-enabled dictionary.
      const reply = await chrome.runtime.sendMessage({
        target: 'hoshidicts-offscreen', type: 'hd_apply_state', requestId: crypto.randomUUID(),
        baseRevision: state.state.revision, profileId,
        dictionaries: dictionaries.map(item => item.id === existing.id ? { ...item, enabled: true } : item),
      });
      if (!reply?.ok) throw new Error(reply?.error || 'The dictionary could not be enabled. Retry from dictionary settings.');
      dictionaries = api.projectDictionaryState(reply.state, profileId)?.dictionaries || [];
    }
  }
  const installed = profile?.language === language ? dictionaries.filter(item => item.enabled !== false && item.termCount > 0).map(item => item.title) : [];
  return {
    installed,
    busy: run.finished === false,
    error: installed.some(title => /^Jitendex(?:\.org)?(?:\s|$)/i.test(title)) ? undefined : (run.entries || []).find(item => item.error)?.error,
  };
}

function createDictionarySetup({ BrowserWindow, getReader, getExtension, openSettings, selectReader, send, root = __dirname, getResourceRoot = () => root }) {
  let catalogue = null;
  let pagePromise = null;
  let pageId = null;
  let job = null;
  const requests = new Map();

  function recommendationFor(language) {
    // Packaged readers live beside app.asar; the shared runtime chooses that
    // resource directory during startup, after this handler is registered.
    catalogue ??= JSON.parse(fs.readFileSync(path.join(getResourceRoot(), 'yomitan/data/recommended-dictionaries.json'), 'utf8'));
    return recommendedDictionary(catalogue, language);
  }

  async function page() {
    const extension = getExtension();
    if (!extension?.id) throw new Error('The dictionary reader is still starting. Retry in a moment.');
    if (!pagePromise || pageId !== extension.id) {
      pageId = extension.id;
      pagePromise = (async () => {
        const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
        try {
          // Yomitan's Settings controller reconciles its cached inventory on
          // every options event. Running imports beside that controller can
          // disable a just-added dictionary. Use its inert template document.
          const document = getReader() === 'yomitan' ? 'templates-display.html' : 'settings.html';
          await window.loadURL(`chrome-extension://${extension.id}/${document}`);
          window.on('closed', () => { pagePromise = null; });
          return window;
        } catch (error) { window.destroy(); pagePromise = null; throw error; }
      })();
    }
    return pagePromise;
  }

  async function status(language, enableExisting = false) {
    const reader = getReader();
    const recommendation = recommendationFor(language);
    const window = await page();
    if (reader === 'hachidori') {
      // Hachidori owns installation and progress; attaching with no source IDs
      // observes the current run without starting a download.
      const snapshot = await window.webContents.executeJavaScript(`(${hachidoriStatus.toString()})(${JSON.stringify(language)}, ${enableExisting})`);
      return {
        reader, recommended: language === 'ja' ? { name: 'Jitendex', homepage: 'https://jitendex.org' } : null,
        ...snapshot,
      };
    }
    const wasBusy = job?.busy === true;
    const state = await window.webContents.executeJavaScript(`(${yomitanAction.toString()})('status', ${JSON.stringify(language)}, ${JSON.stringify(recommendation)}, (${matchesRecommendation.toString()}))`);
    // A scan that began during an import may have read the old inventory.
    if (wasBusy && !job?.busy) return status(language);
    return { reader, recommended: recommendation && { name: recommendation.name, homepage: recommendation.homepage },
      ...state, busy: job?.busy === true, ...(job?.language === language ? { stage: job.busy ? state.stage || job.stage : job.stage, error: job.error } : {}) };
  }

  async function perform(input) {
    const { action, language } = input || {};
    if (!['status', 'install', 'open', 'select'].includes(action) || typeof language !== 'string') throw new Error('Invalid dictionary setup request.');
    if (action === 'select') {
      if (!['yomitan', 'hachidori'].includes(input.reader)) throw new Error('Invalid dictionary reader.');
      if ((await status(language)).busy) throw new Error('Wait for dictionary installation to finish before switching readers.');
      await selectReader(input.reader);
      return { reader: getReader(), restarting: input.reader !== getReader(), installed: [], busy: false, recommended: null };
    }
    if (action === 'open') { openSettings(); return status(language); }
    if (action === 'install') {
      const window = await page();
      if (getReader() === 'hachidori') {
        if (language !== 'ja') throw new Error('Open Hachidori settings to choose a language pack and dictionary.');
        const current = await status(language, true);
        if (current.installed.some(title => /^Jitendex(?:\.org)?(?:\s|$)/i.test(title))) return current;
        const reply = await window.webContents.executeJavaScript(`chrome.runtime.sendMessage({target:'hachidori-setup',type:'hd_setup_install',sourceIds:['jitendex']})`);
        if (!reply?.ok) throw new Error(reply?.error || 'Hachidori could not start the dictionary download.');
      } else if (!job?.busy) {
        job = { language, busy: true, stage: 'downloading' };
        const currentJob = job;
        const recommendation = recommendationFor(language);
        // A short acknowledged start keeps IPC responsive throughout big imports.
        void window.webContents.executeJavaScript(`(${yomitanAction.toString()})('install', ${JSON.stringify(language)}, ${JSON.stringify(recommendation)}, (${matchesRecommendation.toString()}))`)
          .then(() => { currentJob.stage = 'complete'; })
          .catch(error => { currentJob.stage = 'failed'; currentJob.error = error.message || String(error); })
          .finally(() => { currentJob.busy = false; });
      }
    }
    return status(language);
  }

  return async message => {
    if (message?.type !== 'dictionary-setup' || typeof message.request_id !== 'string') return;
    const id = message.request_id;
    if (!requests.has(id)) {
      const operation = Promise.resolve().then(async () => {
        try {
          if (!Number.isFinite(message.deadline) || message.deadline <= Date.now()) throw new Error('Setup request expired. Retry.');
          return { type: 'dictionary-setup-result', request_id: id, success: true, status: await perform(message.data) };
        } catch (error) {
          return { type: 'dictionary-setup-result', request_id: id, success: false, error: error.message || String(error) };
        }
      });
      requests.set(id, operation);
      if (requests.size > 64) requests.delete(requests.keys().next().value);
      const response = await operation;
      send(response);
    } else send(await requests.get(id));
  };
}

module.exports = { recommendedDictionary, matchesRecommendation, createDictionarySetup };
