#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace gsm::hoshidicts {

class HostError : public std::runtime_error {
 public:
  HostError(std::string code, std::string message);

  const std::string& code() const noexcept;

 private:
  std::string code_;
};

struct DictionarySpec {
  std::string id;
  std::string title;
  std::string path;
  std::vector<std::string> types;
  int priority{};
};

struct CatalogConfigureParams {
  std::int64_t generation{};
  std::vector<DictionarySpec> dictionaries;
};

struct CatalogConfigureResult {
  std::int64_t generation{};
  std::size_t loaded{};
  std::size_t styles{};
  std::int64_t elapsedMs{};
};

struct LookupTermParams {
  std::int64_t catalogGeneration{};
  std::int64_t requestGeneration{};
  std::string text;
  std::size_t scanLength{16};
  int maxResults{16};
};

struct GlossaryResult {
  std::string dictionary;
  std::string glossary;
  std::string definitionTags;
  std::string termTags;
};

struct FrequencyValue {
  int value{};
  std::string displayValue;
};

struct FrequencyResult {
  std::string dictionary;
  std::vector<FrequencyValue> values;
};

struct PitchResult {
  std::string dictionary;
  std::vector<int> positions;
};

struct TermResultData {
  std::string expression;
  std::string reading;
  std::string rules;
  std::vector<GlossaryResult> glossaries;
  std::vector<FrequencyResult> frequencies;
  std::vector<PitchResult> pitches;
};

struct LookupResultData {
  std::string matched;
  std::string deinflected;
  std::vector<std::string> process;
  int preprocessorSteps{};
  TermResultData term;
};

struct LookupTermResult {
  std::int64_t catalogGeneration{};
  std::int64_t requestGeneration{};
  std::size_t matchedLength{};
  std::vector<LookupResultData> results;
  std::int64_t elapsedMs{};
};

struct LookupKanjiParams {
  std::int64_t catalogGeneration{};
  std::int64_t requestGeneration{};
  std::string text;
};

struct KanjiEntryResult {
  std::string dictionary;
  std::string onyomi;
  std::string kunyomi;
  std::string tags;
  std::vector<std::string> definitions;
  std::map<std::string, std::string> stats;
};

struct LookupKanjiResult {
  std::int64_t catalogGeneration{};
  std::int64_t requestGeneration{};
  std::string character;
  std::vector<KanjiEntryResult> entries;
  std::int64_t elapsedMs{};
};

struct CatalogGenerationParams {
  std::int64_t catalogGeneration{};
};

struct DictionaryStyleResult {
  std::string dictionary;
  std::string css;
};

struct StylesListResult {
  std::int64_t catalogGeneration{};
  std::vector<DictionaryStyleResult> styles;
};

struct MediaGetParams {
  std::int64_t catalogGeneration{};
  std::string dictionary;
  std::string path;
};

struct MediaGetResult {
  std::int64_t catalogGeneration{};
  std::string dictionary;
  std::string path;
  std::string encoding{"base64"};
  std::size_t size{};
  std::string data;
};

struct DictionaryImportParams {
  std::string jobId;
  std::string zipPath;
  std::string outputPath;
  bool lowRam{true};
};

struct DictionaryImportResult {
  std::string jobId;
  std::string title;
  std::vector<std::string> types;
  int formatRevision{};
  std::string outputPath;
  std::size_t termCount{};
  std::size_t metadataCount{};
  std::size_t kanjiCount{};
  std::size_t mediaCount{};
  std::string probeTerm;
  std::string probeKanji;
};

struct DictionaryProbeParams {
  std::string path;
  std::vector<std::string> types;
  std::string probeTerm;
  std::string probeKanji;
};

struct DictionaryProbeResult {
  bool loaded{};
  bool termProbeMatched{};
  bool kanjiProbeMatched{};
};

class Session {
 public:
  Session();
  ~Session();

  Session(const Session&) = delete;
  Session& operator=(const Session&) = delete;

  CatalogConfigureResult configureCatalog(const CatalogConfigureParams& params);
  LookupTermResult lookupTerm(const LookupTermParams& params) const;
  LookupKanjiResult lookupKanji(const LookupKanjiParams& params) const;
  StylesListResult listStyles(const CatalogGenerationParams& params) const;
  MediaGetResult getMedia(const MediaGetParams& params) const;
  DictionaryImportResult importDictionary(const DictionaryImportParams& params);
  DictionaryProbeResult probeDictionary(const DictionaryProbeParams& params) const;

  std::int64_t catalogGeneration() const noexcept;

 private:
  struct Catalog;
  const Catalog& requireCatalog(std::int64_t generation) const;

  std::unique_ptr<Catalog> catalog_;
};

}  // namespace gsm::hoshidicts
