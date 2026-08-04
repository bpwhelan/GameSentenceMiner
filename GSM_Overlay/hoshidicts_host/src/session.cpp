#include "session.hpp"

#include <glaze/base64/base64.hpp>
#include <hoshidicts/deconjugator.hpp>
#include <hoshidicts/lookup.hpp>
#include <hoshidicts/query.hpp>
#include <utf8.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <filesystem>
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

TermResultData convertTerm(const TermResult& source) {
  TermResultData result{
      .expression = source.expression,
      .reading = source.reading,
      .rules = source.rules,
      .glossaries = {},
      .frequencies = {},
      .pitches = {},
  };

  result.glossaries.reserve(source.glossaries.size());
  for (const auto& glossary : source.glossaries) {
    result.glossaries.push_back({
        .dictionary = glossary.dict_name,
        .glossary = glossary.glossary,
        .definitionTags = glossary.definition_tags,
        .termTags = glossary.term_tags,
    });
  }

  result.frequencies.reserve(source.frequencies.size());
  for (const auto& frequency : source.frequencies) {
    FrequencyResult converted{
        .dictionary = frequency.dict_name,
        .values = {},
    };
    converted.values.reserve(frequency.frequencies.size());
    for (const auto& value : frequency.frequencies) {
      converted.values.push_back({
          .value = value.value,
          .displayValue = value.display_value,
      });
    }
    result.frequencies.push_back(std::move(converted));
  }

  result.pitches.reserve(source.pitches.size());
  for (const auto& pitch : source.pitches) {
    result.pitches.push_back({
        .dictionary = pitch.dict_name,
        .positions = pitch.pitch_positions,
    });
  }

  return result;
}

}  // namespace

struct Session::Catalog {
  std::int64_t generation{};
  DictionaryQuery query;
  Deconjugator deconjugator;
  Lookup lookup;

  explicit Catalog(std::int64_t value)
      : generation(value), lookup(query, deconjugator) {}
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
  for (const auto& dictionary : dictionaries) {
    for (const auto& type : dictionary.types) {
      if (type == "term") {
        replacement->query.add_term_dict(dictionary.path);
      } else if (type == "frequency") {
        replacement->query.add_freq_dict(dictionary.path);
      } else if (type == "pitch") {
        replacement->query.add_pitch_dict(dictionary.path);
      } else if (type == "kanji") {
        replacement->query.add_kanji_dict(dictionary.path);
      }
    }
  }

  const auto styleCount = replacement->query.get_styles().size();
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
  const auto nativeResults =
      catalog.lookup.lookup(params.text, params.maxResults, params.scanLength);
  LookupTermResult result{
      .catalogGeneration = catalog.generation,
      .requestGeneration = params.requestGeneration,
      .matchedLength = 0,
      .results = {},
      .elapsedMs = 0,
  };
  result.results.reserve(nativeResults.size());
  for (const auto& nativeResult : nativeResults) {
    result.results.push_back({
        .matched = nativeResult.matched,
        .deinflected = nativeResult.deinflected,
        .process = nativeResult.process,
        .preprocessorSteps = nativeResult.preprocessor_steps,
        .term = convertTerm(nativeResult.term),
    });
  }
  if (!nativeResults.empty()) {
    result.matchedLength = static_cast<std::size_t>(
        utf8::distance(nativeResults.front().matched.begin(), nativeResults.front().matched.end()));
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
  const auto nativeResult = catalog.query.query_kanji(params.text);
  LookupKanjiResult result{
      .catalogGeneration = catalog.generation,
      .requestGeneration = params.requestGeneration,
      .character = nativeResult.character,
      .entries = {},
      .elapsedMs = 0,
  };
  result.entries.reserve(nativeResult.entries.size());
  for (const auto& entry : nativeResult.entries) {
    result.entries.push_back({
        .dictionary = entry.dict_name,
        .onyomi = entry.onyomi,
        .kunyomi = entry.kunyomi,
        .tags = entry.tags,
        .definitions = entry.definitions,
        .stats = {entry.stats.begin(), entry.stats.end()},
    });
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
  for (const auto& style : catalog.query.get_styles()) {
    if (style.styles.size() > kMaxStyleBytes) {
      throw HostError("RESPONSE_TOO_LARGE", "dictionary stylesheet exceeds the supported size");
    }
    result.styles.push_back({
        .dictionary = style.dict_name,
        .css = style.styles,
    });
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

  const auto media = catalog.query.get_media_file_view(params.dictionary, params.path);
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

std::int64_t Session::catalogGeneration() const noexcept {
  return catalog_ ? catalog_->generation : 0;
}

}  // namespace gsm::hoshidicts
