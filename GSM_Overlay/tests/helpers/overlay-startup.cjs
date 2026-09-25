const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const readers = require('../../dictionary_reader');

const overlay = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(overlay, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(overlay, 'index.html'), 'utf8');

function between(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, `Missing startup source: ${start}`);
  return source.slice(first, last);
}

// Execute production reader selection and the IPC payload builder together.
// In particular, do not supply dictionaryReader directly to a test handler.
function loadOverlayStartup(configData, userSettings = {}) {
  const context = vm.createContext({
    ...readers, path, __dirname: overlay, app: { isPackaged: false },
    getGSMSettings: () => configData,
    userSettings, liveStatsVisibilityMode: 'visible',
    normalizeLiveStatsVisibilityMode: value => value,
  });
  vm.runInContext(`
    ${between(main, 'let isDev = false;', 'let hachidoriEngineWindow')}
    ${between(main, 'function buildOverlaySettingsPayload()', 'function publishLiveStatsVisibilityMode')}
    function loadReader() {
      ${between(main, '  isDev = !app.isPackaged;', '  let yomitanLowDiskWarningShown = false;')}
      return dictionaryReader;
    }
    globalThis.selectedReader = loadReader();
    globalThis.settingsPayload = buildOverlaySettingsPayload;
  `, context);
  return {
    selectedReader: context.selectedReader,
    settingsPayload: () => JSON.parse(JSON.stringify(context.settingsPayload())),
  };
}

function rendererGamepadConfigSource(settingsPayload, gamepadSettings = {}) {
  return `(() => {
    const newsettings = ${JSON.stringify(settingsPayload)};
    const gamepadSettings = ${JSON.stringify(gamepadSettings)};
    const showFurigana = false;
    const gamepadInputSuppressed = false;
    const pendingManualRevealForBackground = false;
    const isManualInteractionSuppressed = () => false;
    let dictionaryReader = 'yomitan';
    ${between(renderer, '  function normalizeDictionaryReader(', '  function shouldHideOverlayWhenManualInactive(')}
    ${between(renderer, '    dictionaryReader = normalizeDictionaryReader(newsettings.dictionaryReader);', '    applyFloatingWindowFontSize(newsettings.fontSize);')}
    ${between(renderer, '  function shouldUseGamepadHandler()', '  async function ensureGamepadModuleLoaded()')}
    return getGamepadHandlerConfig();
  })()`;
}

module.exports = { loadOverlayStartup, rendererGamepadConfigSource, between };
