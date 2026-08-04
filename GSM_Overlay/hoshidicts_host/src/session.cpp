#include "session.hpp"

#include <glaze/base64/base64.hpp>
#include <hoshidicts/deconjugator.hpp>
#include <hoshidicts/importer.hpp>
#include <hoshidicts/lookup.hpp>
#include <hoshidicts/query.hpp>
#include <utf8.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <filesystem>
#include <limits>
#include <map>
#include <set>
#include <string_view>
#include <utility>

namespace gsm::hoshidicts {
namespace {

constexpr std::size_t kMaxDictionaries = 64;
constexpr std::size_t kMaxLookupBytes = 4096;
constexpr std::size_t kMaxScanLength = 64;
constexpr int kMaxLookupResults = 64;
constexpr std::size_t kMaxStyleBytes = 2 * 1024 * 1024;
constexpr std::size_t kMaxMediaBytes = 11 * 1024 * 1024;
constexpr int kSupportedDictionaryFormatRevision = 3;

std::int64_t elapsedMilliseconds(const std::chrono::steady_clock::time_point start) {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now() - start)
      .count();
}

void validateUtf8(std::string_view value, std::string_view field) {
  if (!utf8::is_valid(value.begin(), value.end())) {
    throw HostError("INVALID_PARAMS", std::string(field) + " must be valid UTF-8");
  }
}

void validateDictionary(const DictionarySpec& spec) {
  if (spec.id.empty() || spec.id.size() > 128) {
    throw HostError("INVALID_CATALOG", "dictionary id must contain 1-128 bytes");
  }
  validateUtf8(spec.id, "dictionary id");
  if (spec.title.empty() || spec.title.size() > 512) {
    throw HostError("INVALID_CATALOG", "dictionary title must contain 1-512 bytes");
  }
  validateUtf8(spec.title, "dictionary title");

  const std::filesystem::path path(spec.path);
  if (!path.is_absolute()) {
    throw HostError("INVALID_CATALOG", "dictionary path must be absolute");
  }

  std::error_code error;
  if (!std::filesystem::is_directory(path, error) || error) {
    throw HostError("INVALID_CATALOG", "dictionary path is not a readable directory");
  }

  constexpr std::string_view requiredFiles[] = {
      ".hoshidicts_1", "index.json", "hash.table", "blobs.bin"};
  for (const auto name : requiredFiles) {
    const auto candidate = path / name;
    error.clear();
    if (!std::filesystem::is_regular_file(candidate, error) || error) {
      throw HostError("INVALID_CATALOG", "dictionary index is incomplete");
    }
  }

  if (spec.types.empty()) {
    throw HostError("INVALID_CATALOG", "dictionary types must not be empty");
  }

  std::set<std::string> uniqueTypes;
  for (const auto& type : spec.types) {
    if (type != "term" && type != "frequency" && type != "pitch" && type != "kanji") {
      throw HostError("INVALID_CATALOG", "dictionary contains an unsupported type");
    }
    if (!uniqueTypes.insert(type).second) {
      throw HostError("INVALID_CATALOG", "dictionary types must be unique");
    }
  }
}

bool hasType(const std::vector<std::string>& types, std::string_view expected) {
  return std::ranges::find(types, expected) != types.end();
}

void validateImportJobId(std::string_view jobId) {
  if (jobId.empty() || jobId.size() > 128 ||
      !std::ranges::all_of(jobId, [](unsigned char character) {
        return std::isalnum(character) != 0 || character == '-';
      })) {
    throw HostError("INVALID_PARAMS", "import job id is invalid");
  }
}

void validateImportPaths(const DictionaryImportParams& params) {
  const std::filesystem::path zipPath(params.zipPath);
  const std::filesystem::path outputPath(params.outputPath);
  if (!zipPath.is_absolute() || !outputPath.is_absolute() ||
      zipPath.filename() != "source.zip" || outputPath.filename() != "index" ||
      zipPath.parent_path() != outputPath.parent_path()) {
    throw HostError(
        "PATH_OUTSIDE_STORE",
        "import paths must use one store-local staging directory");
  }

  std::error_code error;
  const auto zipStatus = std::filesystem::symlink_status(zipPath, error);
  if (error || !std::filesystem::is_regular_file(zipStatus) ||
      std::filesystem::is_symlink(zipStatus)) {
    throw HostError("INVALID_DICTIONARY_ARCHIVE", "staged dictionary ZIP is invalid");
  }
  const auto parentStatus =
      std::filesystem::symlink_status(outputPath.parent_path(), error);
  if (error || !std::filesystem::is_directory(parentStatus) ||
      std::filesystem::is_symlink(parentStatus)) {
    throw HostError("PATH_OUTSIDE_STORE", "import staging directory is invalid");
  }
  if (std::filesystem::exists(outputPath, error) || error) {
    throw HostError("INVALID_PARAMS", "import output path must not exist");
  }

  const auto canonicalZip = std::filesystem::canonical(zipPath, error);
  if (error) {
    throw HostError("INVALID_DICTIONARY_ARCHIVE", "staged dictionary ZIP is unreadable");
  }
  const auto canonicalParent =
      std::filesystem::canonical(outputPath.parent_path(), error);
  if (error || canonicalZip.parent_path() != canonicalParent) {
    throw HostError("PATH_OUTSIDE_STORE", "import path escaped its staging directory");
  }
}

void mergeRules(std::string& target, const std::string& source) {
  if (source.empty() || target == source) {
    return;
  }
  if (target.empty()) {
    target = source;
    return;
  }
  target += " ";
  target += source;
}

void appendGlossaries(
    TermResultData& target,
    const TermResult& source,
    const std::string& dictionaryId) {
  target.glossaries.reserve(target.glossaries.size() + source.glossaries.size());
  for (const auto& glossary : source.glossaries) {
    target.glossaries.push_back({
        .dictionary = dictionaryId,
        .glossary = glossary.glossary,
        .definitionTags = glossary.definition_tags,
        .termTags = glossary.term_tags,
    });
  }
  mergeRules(target.rules, source.rules);
}

TermResultData convertTerm(
    const TermResult& source,
    const std::string& dictionaryId) {
  TermResultData result{
      .expression = source.expression,
      .reading = source.reading,
      .rules = source.rules,
      .glossaries = {},
      .frequencies = {},
      .pitches = {},
  };
  appendGlossaries(result, source, dictionaryId);
  return result;
}

void appendFrequencies(
    TermResultData& target,
    const TermResult& source,
    const std::string& dictionaryId) {
  target.frequencies.reserve(target.frequencies.size() + source.frequencies.size());
  for (const auto& frequency : source.frequencies) {
    FrequencyResult converted{
        .dictionary = dictionaryId,
        .values = {},
    };
    converted.values.reserve(frequency.frequencies.size());
    for (const auto& value : frequency.frequencies) {
      converted.values.push_back({
          .value = value.value,
          .displayValue = value.display_value,
        });
    }
    target.frequencies.push_back(std::move(converted));
  }
}

void appendPitches(
    TermResultData& target,
    const TermResult& source,
    const std::string& dictionaryId) {
  target.pitches.reserve(target.pitches.size() + source.pitches.size());
  for (const auto& pitch : source.pitches) {
    target.pitches.push_back({
        .dictionary = dictionaryId,
        .positions = pitch.pitch_positions,
    });
  }
}

std::size_t utf8Length(const std::string& value) {
  return static_cast<std::size_t>(
      utf8::distance(value.begin(), value.end()));
}

int frequencyValue(
    const TermResultData& term,
    const std::string& dictionaryId) {
  for (const auto& frequency : term.frequencies) {
    if (frequency.dictionary != dictionaryId) {
      continue;
    }
    int minimum = std::numeric_limits<int>::max();
    for (const auto& value : frequency.values) {
      if (value.value >= 0) {
        minimum = std::min(minimum, value.value);
      }
    }
    return minimum;
  }
  return std::numeric_limits<int>::max();
}

bool rankedBefore(
    const LookupResultData& left,
    const LookupResultData& right,
    const std::vector<std::string>& frequencyOrder) {
  const auto leftLength = utf8Length(left.matched);
  const auto rightLength = utf8Length(right.matched);
  if (leftLength != rightLength) {
    return leftLength > rightLength;
  }
  if (left.preprocessorSteps != right.preprocessorSteps) {
    return left.preprocessorSteps < right.preprocessorSteps;
  }
  if (left.process.size() != right.process.size()) {
    return left.process.size() < right.process.size();
  }
  const bool leftExact = left.term.expression == left.deinflected;
  const bool rightExact = right.term.expression == right.deinflected;
  if (leftExact != rightExact) {
    return leftExact;
  }
  for (const auto& dictionaryId : frequencyOrder) {
    const int leftFrequency = frequencyValue(left.term, dictionaryId);
    const int rightFrequency = frequencyValue(right.term, dictionaryId);
    if (leftFrequency != rightFrequency) {
      return leftFrequency < rightFrequency;
    }
  }
  const bool leftReadingMatch = left.term.expression == left.term.reading;
  const bool rightReadingMatch = right.term.expression == right.term.reading;
  if (leftReadingMatch != rightReadingMatch) {
    return leftReadingMatch;
  }
  if (left.term.expression != right.term.expression) {
    return left.term.expression < right.term.expression;
  }
  return left.term.reading < right.term.reading;
}

}  // namespace

struct Session::Catalog {
  struct Dictionary {
    DictionarySpec spec;
    DictionaryQuery query;
    Deconjugator deconjugator;
    Lookup lookup;

    explicit Dictionary(DictionarySpec value)
        : spec(std::move(value)), lookup(query, deconjugator) {
      for (const auto& type : spec.types) {
        if (type == "term") {
          query.add_term_dict(spec.path);
        } else if (type == "frequency") {
          query.add_freq_dict(spec.path);
        } else if (type == "pitch") {
          query.add_pitch_dict(spec.path);
        } else if (type == "kanji") {
          query.add_kanji_dict(spec.path);
        }
      }
    }
  };

  std::int64_t generation{};
  std::vector<std::unique_ptr<Dictionary>> dictionaries;

  explicit Catalog(std::int64_t value) : generation(value) {}
};

HostError::HostError(std::string code, std::string message)
    : std::runtime_error(message.substr(0, 512)), code_(std::move(code)) {}

const std::string& HostError::code() const noexcept {
  return code_;
}

Session::Session() = default;
Session::~Session() = default;

CatalogConfigureResult Session::configureCatalog(const CatalogConfigureParams& params) {
  const auto started = std::chrono::steady_clock::now();
  if (params.generation <= 0) {
    throw HostError("INVALID_CATALOG", "catalog generation must be positive");
  }
  if (catalog_ && params.generation <= catalog_->generation) {
    throw HostError("STALE_CATALOG", "catalog generation must increase");
  }
  if (params.dictionaries.size() > kMaxDictionaries) {
    throw HostError("INVALID_CATALOG", "catalog contains too many dictionaries");
  }

  std::vector<DictionarySpec> dictionaries = params.dictionaries;
  std::stable_sort(
      dictionaries.begin(), dictionaries.end(),
      [](const DictionarySpec& left, const DictionarySpec& right) {
        return left.priority < right.priority;
      });

  std::set<std::string> dictionaryIds;
  for (const auto& dictionary : dictionaries) {
    validateDictionary(dictionary);
    if (!dictionaryIds.insert(dictionary.id).second) {
      throw HostError("INVALID_CATALOG", "dictionary ids must be unique");
    }
  }

  auto replacement = std::make_unique<Catalog>(params.generation);
  std::size_t styleCount = 0;
  replacement->dictionaries.reserve(dictionaries.size());
  for (auto& dictionary : dictionaries) {
    auto loaded = std::make_unique<Catalog::Dictionary>(std::move(dictionary));
    styleCount += loaded->query.get_styles().size();
    replacement->dictionaries.push_back(std::move(loaded));
  }

  catalog_ = std::move(replacement);
  return {
      .generation = params.generation,
      .loaded = dictionaries.size(),
      .styles = styleCount,
      .elapsedMs = elapsedMilliseconds(started),
  };
}

const Session::Catalog& Session::requireCatalog(std::int64_t generation) const {
  if (!catalog_) {
    throw HostError("CATALOG_NOT_CONFIGURED", "no dictionary catalog is active");
  }
  if (generation != catalog_->generation) {
    throw HostError("STALE_CATALOG", "catalog generation does not match the active catalog");
  }
  return *catalog_;
}

LookupTermResult Session::lookupTerm(const LookupTermParams& params) const {
  const auto& catalog = requireCatalog(params.catalogGeneration);
  if (params.requestGeneration < 0) {
    throw HostError("INVALID_PARAMS", "request generation must not be negative");
  }
  if (params.text.empty() || params.text.size() > kMaxLookupBytes) {
    throw HostError("INVALID_PARAMS", "lookup text length is outside the supported range");
  }
  validateUtf8(params.text, "lookup text");
  if (params.scanLength == 0 || params.scanLength > kMaxScanLength) {
    throw HostError("INVALID_PARAMS", "scan length is outside the supported range");
  }
  if (params.maxResults <= 0 || params.maxResults > kMaxLookupResults) {
    throw HostError("INVALID_PARAMS", "max results is outside the supported range");
  }

  const auto started = std::chrono::steady_clock::now();
  std::map<std::pair<std::string, std::string>, LookupResultData> mergedResults;
  for (const auto& dictionary : catalog.dictionaries) {
    if (!hasType(dictionary->spec.types, "term")) {
      continue;
    }
    const auto nativeResults = dictionary->lookup.lookup(
        params.text, kMaxLookupResults, params.scanLength);
    for (const auto& nativeResult : nativeResults) {
      const auto key =
          std::pair{nativeResult.term.expression, nativeResult.term.reading};
      auto [iterator, inserted] = mergedResults.try_emplace(
          key,
          LookupResultData{
              .matched = nativeResult.matched,
              .deinflected = nativeResult.deinflected,
              .process = nativeResult.process,
              .preprocessorSteps = nativeResult.preprocessor_steps,
              .term = convertTerm(nativeResult.term, dictionary->spec.id),
          });
      if (inserted) {
        continue;
      }
      appendGlossaries(
          iterator->second.term, nativeResult.term, dictionary->spec.id);
      if (utf8Length(nativeResult.matched) >
          utf8Length(iterator->second.matched)) {
        iterator->second.matched = nativeResult.matched;
        iterator->second.deinflected = nativeResult.deinflected;
        iterator->second.process = nativeResult.process;
        iterator->second.preprocessorSteps = nativeResult.preprocessor_steps;
      }
    }
  }

  std::vector<LookupResultData> orderedResults;
  orderedResults.reserve(mergedResults.size());
  for (auto& [key, lookupResult] : mergedResults) {
    static_cast<void>(key);
    orderedResults.push_back(std::move(lookupResult));
  }

  std::vector<std::string> frequencyOrder;
  for (const auto& dictionary : catalog.dictionaries) {
    const bool hasFrequency = hasType(dictionary->spec.types, "frequency");
    const bool hasPitch = hasType(dictionary->spec.types, "pitch");
    if (hasFrequency) {
      frequencyOrder.push_back(dictionary->spec.id);
    }
    if (!hasFrequency && !hasPitch) {
      continue;
    }
    for (auto& lookupResult : orderedResults) {
      TermResult probe;
      probe.expression = lookupResult.term.expression;
      probe.reading = lookupResult.term.reading;
      std::vector<TermResult> probes;
      probes.push_back(std::move(probe));
      if (hasFrequency) {
        dictionary->query.query_freq(probes);
        appendFrequencies(
            lookupResult.term, probes.front(), dictionary->spec.id);
      }
      if (hasPitch) {
        dictionary->query.query_pitch(probes);
        appendPitches(
            lookupResult.term, probes.front(), dictionary->spec.id);
      }
    }
  }
  std::stable_sort(
      orderedResults.begin(), orderedResults.end(),
      [&frequencyOrder](const auto& left, const auto& right) {
        return rankedBefore(left, right, frequencyOrder);
      });
  if (orderedResults.size() > static_cast<std::size_t>(params.maxResults)) {
    orderedResults.resize(static_cast<std::size_t>(params.maxResults));
  }

  LookupTermResult result{
      .catalogGeneration = catalog.generation,
      .requestGeneration = params.requestGeneration,
      .matchedLength = 0,
      .results = std::move(orderedResults),
      .elapsedMs = 0,
  };
  if (!result.results.empty()) {
    result.matchedLength = utf8Length(result.results.front().matched);
  }
  result.elapsedMs = elapsedMilliseconds(started);
  return result;
}

LookupKanjiResult Session::lookupKanji(const LookupKanjiParams& params) const {
  const auto& catalog = requireCatalog(params.catalogGeneration);
  if (params.requestGeneration < 0) {
    throw HostError("INVALID_PARAMS", "request generation must not be negative");
  }
  if (params.text.empty() || params.text.size() > 32) {
    throw HostError("INVALID_PARAMS", "kanji text length is outside the supported range");
  }
  validateUtf8(params.text, "kanji text");

  const auto started = std::chrono::steady_clock::now();
  LookupKanjiResult result{
      .catalogGeneration = catalog.generation,
      .requestGeneration = params.requestGeneration,
      .character = params.text,
      .entries = {},
      .elapsedMs = 0,
  };
  for (const auto& dictionary : catalog.dictionaries) {
    if (!hasType(dictionary->spec.types, "kanji")) {
      continue;
    }
    const auto nativeResult = dictionary->query.query_kanji(params.text);
    for (const auto& entry : nativeResult.entries) {
      result.entries.push_back({
          .dictionary = dictionary->spec.id,
          .onyomi = entry.onyomi,
          .kunyomi = entry.kunyomi,
          .tags = entry.tags,
          .definitions = entry.definitions,
          .stats = {entry.stats.begin(), entry.stats.end()},
      });
    }
  }
  result.elapsedMs = elapsedMilliseconds(started);
  return result;
}

StylesListResult Session::listStyles(const CatalogGenerationParams& params) const {
  const auto& catalog = requireCatalog(params.catalogGeneration);
  StylesListResult result{
      .catalogGeneration = catalog.generation,
      .styles = {},
  };
  for (const auto& dictionary : catalog.dictionaries) {
    for (const auto& style : dictionary->query.get_styles()) {
      if (style.styles.size() > kMaxStyleBytes) {
        throw HostError(
            "RESPONSE_TOO_LARGE",
            "dictionary stylesheet exceeds the supported size");
      }
      result.styles.push_back({
          .dictionary = dictionary->spec.id,
          .css = style.styles,
      });
    }
  }
  return result;
}

MediaGetResult Session::getMedia(const MediaGetParams& params) const {
  const auto& catalog = requireCatalog(params.catalogGeneration);
  if (params.dictionary.empty() || params.dictionary.size() > 256) {
    throw HostError("INVALID_PARAMS", "media dictionary is invalid");
  }
  if (params.path.empty() || params.path.size() > 1024) {
    throw HostError("INVALID_PARAMS", "media path is invalid");
  }
  validateUtf8(params.dictionary, "media dictionary");
  validateUtf8(params.path, "media path");

  const std::filesystem::path logicalPath(params.path);
  const bool hasDrivePrefix =
      params.path.size() >= 2 &&
      std::isalpha(static_cast<unsigned char>(params.path[0])) != 0 &&
      params.path[1] == ':';
  if (logicalPath.is_absolute() || hasDrivePrefix ||
      params.path.starts_with("\\\\") || params.path.contains('\\')) {
    throw HostError("INVALID_PARAMS", "media path must be relative");
  }
  for (const auto& component : logicalPath) {
    if (component == "..") {
      throw HostError("INVALID_PARAMS", "media path must not traverse parent directories");
    }
  }

  const auto dictionary = std::ranges::find_if(
      catalog.dictionaries,
      [&params](const auto& candidate) {
        return candidate->spec.id == params.dictionary;
      });
  if (dictionary == catalog.dictionaries.end() ||
      !hasType((*dictionary)->spec.types, "term")) {
    throw HostError("MEDIA_NOT_FOUND", "dictionary media owner was not found");
  }
  const auto media = (*dictionary)->query.get_media_file_view(
      (*dictionary)->spec.title, params.path);
  if (media.data == nullptr) {
    throw HostError("MEDIA_NOT_FOUND", "dictionary media was not found");
  }
  if (media.size > kMaxMediaBytes) {
    throw HostError("RESPONSE_TOO_LARGE", "dictionary media exceeds the supported size");
  }

  return {
      .catalogGeneration = catalog.generation,
      .dictionary = params.dictionary,
      .path = params.path,
      .encoding = "base64",
      .size = media.size,
      .data = glz::write_base64(std::string_view(media.data, media.size)),
  };
}

DictionaryImportResult Session::importDictionary(
    const DictionaryImportParams& params) {
  validateImportJobId(params.jobId);
  validateUtf8(params.jobId, "import job id");
  validateImportPaths(params);

  const auto imported = dictionary_importer::import_to_path(
      params.zipPath, params.outputPath, params.lowRam);
  if (!imported.success) {
    const auto detail =
        imported.errors.empty() ? "native dictionary import failed" : imported.errors.front();
    throw HostError("INVALID_DICTIONARY_ARCHIVE", detail);
  }
  if (imported.format_revision != kSupportedDictionaryFormatRevision) {
    std::error_code ignored;
    std::filesystem::remove_all(params.outputPath, ignored);
    throw HostError(
        "UNSUPPORTED_DICTIONARY_REVISION",
        "dictionary format revision is unsupported");
  }
  if (imported.title.empty() || imported.title.size() > 512) {
    std::error_code ignored;
    std::filesystem::remove_all(params.outputPath, ignored);
    throw HostError("INVALID_DICTIONARY_ARCHIVE", "dictionary title is invalid");
  }
  validateUtf8(imported.title, "dictionary title");
  if (imported.types.empty()) {
    std::error_code ignored;
    std::filesystem::remove_all(params.outputPath, ignored);
    throw HostError(
        "UNSUPPORTED_DICTIONARY_TYPE",
        "dictionary contains no supported content");
  }

  return {
      .jobId = params.jobId,
      .title = imported.title,
      .types = imported.types,
      .formatRevision = imported.format_revision,
      .outputPath = imported.output_path,
      .termCount = imported.term_count,
      .metadataCount = imported.meta_count,
      .kanjiCount = imported.kanji_count,
      .mediaCount = imported.media_count,
      .probeTerm = imported.probe_term,
      .probeKanji = imported.probe_kanji,
  };
}

DictionaryProbeResult Session::probeDictionary(
    const DictionaryProbeParams& params) const {
  Session probe;
  const auto configured = probe.configureCatalog({
      .generation = 1,
      .dictionaries =
          {{
              .id = "import-probe",
              .title = "Import probe",
              .path = params.path,
              .types = params.types,
              .priority = 0,
          }},
  });

  bool termProbeMatched = false;
  if (hasType(params.types, "term")) {
    if (params.probeTerm.empty()) {
      throw HostError("CATALOG_LOAD_FAILED", "term dictionary has no probe term");
    }
    const auto result = probe.lookupTerm({
        .catalogGeneration = 1,
        .requestGeneration = 1,
        .text = params.probeTerm,
        .scanLength = kMaxScanLength,
        .maxResults = 4,
    });
    termProbeMatched = !result.results.empty();
    if (!termProbeMatched) {
      throw HostError("CATALOG_LOAD_FAILED", "term probe lookup returned no results");
    }
  }

  bool kanjiProbeMatched = false;
  if (hasType(params.types, "kanji")) {
    if (params.probeKanji.empty()) {
      throw HostError("CATALOG_LOAD_FAILED", "kanji dictionary has no probe character");
    }
    const auto result = probe.lookupKanji({
        .catalogGeneration = 1,
        .requestGeneration = 2,
        .text = params.probeKanji,
    });
    kanjiProbeMatched = !result.entries.empty();
    if (!kanjiProbeMatched) {
      throw HostError("CATALOG_LOAD_FAILED", "kanji probe lookup returned no results");
    }
  }

  return {
      .loaded = configured.loaded == 1,
      .termProbeMatched = termProbeMatched,
      .kanjiProbeMatched = kanjiProbeMatched,
  };
}

std::int64_t Session::catalogGeneration() const noexcept {
  return catalog_ ? catalog_->generation : 0;
}

}  // namespace gsm::hoshidicts
