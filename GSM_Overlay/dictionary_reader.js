const DICTIONARY_READER_YOMITAN = 'yomitan';
const DICTIONARY_READER_HACHIDORI = 'hachidori';

function resolveDictionaryReader(overlaySettings) {
  return overlaySettings?.dictionaryReaderSelection === DICTIONARY_READER_HACHIDORI
    ? DICTIONARY_READER_HACHIDORI
    : DICTIONARY_READER_YOMITAN;
}

module.exports = {
  DICTIONARY_READER_HACHIDORI,
  DICTIONARY_READER_YOMITAN,
  resolveDictionaryReader,
};
