const DICTIONARY_READER_YOMITAN = 'yomitan';
const DICTIONARY_READER_HACHIDORI = 'hachidori';

// Mirrors resolveHachidoriEnabledFromConfigData in electron-src/main/gsm_config.ts:
// Hachidori needs both the master experimental toggle and its own opt-in.
function resolveHachidoriEnabledFromConfigData(configData) {
  if (!configData || typeof configData !== 'object') {
    return false;
  }
  const experimental = configData.experimental;
  if (!experimental || typeof experimental !== 'object') {
    return false;
  }
  return experimental.enable_experimental_features === true && experimental.enable_hachidori === true;
}

function resolveDictionaryReaderFromConfigData(configData) {
  return resolveHachidoriEnabledFromConfigData(configData)
    ? DICTIONARY_READER_HACHIDORI
    : DICTIONARY_READER_YOMITAN;
}

module.exports = {
  DICTIONARY_READER_HACHIDORI,
  DICTIONARY_READER_YOMITAN,
  resolveDictionaryReaderFromConfigData,
  resolveHachidoriEnabledFromConfigData,
};
