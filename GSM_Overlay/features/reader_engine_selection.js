const DICTIONARY_READER_ENGINE_HOSHIDICTS = "hoshidicts";
const DICTIONARY_READER_ENGINE_YOMITAN = "yomitan";

function selectDictionaryReaderEngine(environment = process.env) {
  const hoshidictsEnabled = environment.GSM_HOSHIDICTS_ENABLED === "1";
  return {
    engine: hoshidictsEnabled
      ? DICTIONARY_READER_ENGINE_HOSHIDICTS
      : DICTIONARY_READER_ENGINE_YOMITAN,
    hoshidictsEnabled,
    yomitanEnabled: !hoshidictsEnabled,
  };
}

async function startSelectedDictionaryReader({
  environment = process.env,
  startYomitan,
}) {
  const selection = selectDictionaryReaderEngine(environment);
  if (!selection.yomitanEnabled) {
    return {
      engine: selection.engine,
      yomitanExtension: null,
    };
  }

  return {
    engine: selection.engine,
    yomitanExtension: await startYomitan(),
  };
}

module.exports = {
  DICTIONARY_READER_ENGINE_HOSHIDICTS,
  DICTIONARY_READER_ENGINE_YOMITAN,
  selectDictionaryReaderEngine,
  startSelectedDictionaryReader,
};
