#include "protocol.hpp"
#include "session.hpp"

#include <hoshidicts/importer.hpp>

#include <chrono>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>

namespace {

using namespace gsm::hoshidicts;

class TemporaryDirectory {
 public:
  TemporaryDirectory() {
    const auto suffix =
        std::chrono::steady_clock::now().time_since_epoch().count();
    path_ = std::filesystem::temp_directory_path() /
            ("gsm-hoshidicts-test-" + std::to_string(suffix));
    std::filesystem::create_directories(path_);
  }

  ~TemporaryDirectory() {
    std::error_code error;
    std::filesystem::remove_all(path_, error);
  }

  const std::filesystem::path& path() const {
    return path_;
  }

 private:
  std::filesystem::path path_;
};

void check(bool condition, std::string_view message) {
  if (!condition) {
    throw std::runtime_error(std::string(message));
  }
}

template <typename Callable>
void checkHostError(
    Callable&& callable, std::string_view expectedCode, std::string_view message) {
  try {
    callable();
  } catch (const HostError& error) {
    check(error.code() == expectedCode, message);
    return;
  }
  throw std::runtime_error(std::string(message));
}

void testSession(const std::filesystem::path& fixtureZip) {
  TemporaryDirectory output;
  const auto dictionaryPath = output.path() / "opaque-index";
  const auto imported = dictionary_importer::import_to_path(
      fixtureZip.string(), dictionaryPath.string(), true);
  check(imported.success, "fixture import failed");
  check(imported.title == "GSM Hoshi Fixture", "fixture title changed");
  check(imported.format_revision == 3, "fixture format revision changed");
  check(imported.types.size() == 4, "fixture dictionary types changed");
  check(imported.probe_term == "食べる", "fixture term probe changed");
  check(imported.probe_kanji == "食", "fixture kanji probe changed");
  check(
      std::filesystem::path(imported.output_path) == dictionaryPath,
      "direct import changed its opaque output path");
  check(imported.term_count == 3, "fixture term count changed");
  check(imported.meta_count == 2, "fixture metadata count changed");
  check(imported.kanji_count == 1, "fixture kanji count changed");
  check(imported.media_count == 1, "fixture media count changed");

  Session session;
  const auto configured = session.configureCatalog({
      .generation = 1,
      .dictionaries =
          {{
              .id = "fixture-primary",
              .title = imported.title,
              .path = dictionaryPath.string(),
              .types = {"term", "frequency", "pitch", "kanji"},
              .priority = 0,
          },
           {
              .id = "fixture-duplicate-title",
              .title = imported.title,
              .path = dictionaryPath.string(),
              .types = {"term", "frequency", "pitch", "kanji"},
              .priority = 1,
          }},
  });
  check(configured.generation == 1, "catalog generation was not applied");
  check(configured.loaded == 2, "catalog did not load both fixtures");
  check(configured.styles == 2, "fixture stylesheets were not loaded");

  const auto lookup = session.lookupTerm({
      .catalogGeneration = 1,
      .requestGeneration = 7,
      .text = "食べました",
      .scanLength = 16,
      .maxResults = 16,
  });
  check(lookup.catalogGeneration == 1, "lookup catalog generation changed");
  check(lookup.requestGeneration == 7, "lookup request generation changed");
  check(!lookup.results.empty(), "inflected fixture lookup returned no results");
  check(lookup.results.front().term.expression == "食べる", "inflection did not resolve to 食べる");
  check(!lookup.results.front().term.glossaries.empty(), "term glossary is missing");
  check(
      lookup.results.front().term.glossaries.size() == 2,
      "duplicate-title dictionary glossaries were not kept distinct");
  check(
      lookup.results.front().term.glossaries[0].dictionary == "fixture-primary" &&
          lookup.results.front().term.glossaries[1].dictionary ==
              "fixture-duplicate-title",
      "term glossaries did not use opaque dictionary IDs");
  check(
      lookup.results.front().term.glossaries.front().glossary.find("to eat") !=
          std::string::npos,
      "term glossary content changed");
  check(!lookup.results.front().term.frequencies.empty(), "frequency metadata is missing");
  check(
      lookup.results.front().term.frequencies[0].dictionary == "fixture-primary" &&
          lookup.results.front().term.frequencies[1].dictionary ==
              "fixture-duplicate-title",
      "frequency metadata did not use opaque dictionary IDs");
  check(
      lookup.results.front().term.frequencies.front().values.front().value == 100,
      "frequency metadata changed");
  check(!lookup.results.front().term.pitches.empty(), "pitch metadata is missing");
  check(
      lookup.results.front().term.pitches[0].dictionary == "fixture-primary" &&
          lookup.results.front().term.pitches[1].dictionary ==
              "fixture-duplicate-title",
      "pitch metadata did not use opaque dictionary IDs");
  check(
      lookup.results.front().term.pitches.front().positions.front() == 2,
      "pitch metadata changed");

  const auto structured = session.lookupTerm({
      .catalogGeneration = 1,
      .requestGeneration = 8,
      .text = "走る",
      .scanLength = 4,
      .maxResults = 4,
  });
  check(!structured.results.empty(), "structured glossary lookup returned no results");
  check(
      structured.results.front().term.glossaries.front().glossary.find(
          "structured-content") != std::string::npos,
      "structured glossary JSON was not preserved");

  const auto nonJapanese = session.lookupTerm({
      .catalogGeneration = 1,
      .requestGeneration = 9,
      .text = "not-japanese",
      .scanLength = 16,
      .maxResults = 4,
  });
  check(nonJapanese.results.empty(), "non-Japanese text produced a dictionary result");

  const auto kanji = session.lookupKanji({
      .catalogGeneration = 1,
      .requestGeneration = 10,
      .text = "食",
  });
  check(kanji.character == "食", "kanji lookup character changed");
  check(kanji.entries.size() == 2, "duplicate-title kanji entries are missing");
  check(
      kanji.entries[0].dictionary == "fixture-primary" &&
          kanji.entries[1].dictionary == "fixture-duplicate-title",
      "kanji entries did not use opaque dictionary IDs");
  check(kanji.entries.front().onyomi == "ショク", "kanji onyomi changed");

  const auto styles = session.listStyles({.catalogGeneration = 1});
  check(styles.styles.size() == 2, "styles.list omitted a duplicate-title fixture");
  check(
      styles.styles[0].dictionary == "fixture-primary" &&
          styles.styles[1].dictionary == "fixture-duplicate-title",
      "dictionary styles did not use opaque dictionary IDs");
  check(
      styles.styles.front().css.find(".gsm-fixture-definition") != std::string::npos,
      "fixture CSS changed");

  const auto media = session.getMedia({
      .catalogGeneration = 1,
      .dictionary = "fixture-primary",
      .path = "media/sample.txt",
  });
  check(media.dictionary == "fixture-primary", "media owner changed to a title");
  check(media.size == 24, "media size changed");
  check(
      media.data == "Z2VuZXJhdGVkIGZpeHR1cmUgbWVkaWEK",
      "media content changed");

  const auto probed = session.probeDictionary({
      .path = dictionaryPath.string(),
      .types = imported.types,
      .probeTerm = imported.probe_term,
      .probeKanji = imported.probe_kanji,
  });
  check(probed.loaded, "probe catalog did not load");
  check(probed.termProbeMatched, "term probe lookup failed");
  check(probed.kanjiProbeMatched, "kanji probe lookup failed");

  checkHostError(
      [&] {
        session.getMedia({
            .catalogGeneration = 1,
            .dictionary = "fixture-primary",
            .path = "../index.json",
        });
      },
      "INVALID_PARAMS", "media traversal path was accepted");

  checkHostError(
      [&] {
        session.configureCatalog({
            .generation = 2,
            .dictionaries =
                {{
                    .id = "missing",
                    .title = "Missing",
                    .path = (output.path() / "missing").string(),
                    .types = {"term"},
                    .priority = 0,
                }},
        });
      },
      "INVALID_CATALOG", "invalid replacement catalog was accepted");

  const auto afterFailure = session.lookupTerm({
      .catalogGeneration = 1,
      .requestGeneration = 11,
      .text = "猫",
      .scanLength = 4,
      .maxResults = 4,
  });
  check(!afterFailure.results.empty(), "failed replacement discarded the active catalog");

  checkHostError(
      [&] {
        session.configureCatalog({
            .generation = 1,
            .dictionaries = {},
        });
      },
      "STALE_CATALOG", "stale catalog generation was accepted");
}

void testImportWorker(const std::filesystem::path& fixtureZip) {
  TemporaryDirectory staging;
  const auto sourcePath = staging.path() / "source.zip";
  const auto outputPath = staging.path() / "index";
  std::filesystem::copy_file(fixtureZip, sourcePath);

  Session session;
  const auto imported = session.importDictionary({
      .jobId = "01234567-89ab-4def-8123-456789abcdef",
      .zipPath = sourcePath.string(),
      .outputPath = outputPath.string(),
      .lowRam = true,
  });
  check(imported.jobId == "01234567-89ab-4def-8123-456789abcdef", "import job id changed");
  check(imported.title == "GSM Hoshi Fixture", "worker import title changed");
  check(imported.outputPath == outputPath.string(), "worker escaped the requested output path");
  check(imported.termCount == 3, "worker term count changed");
  check(imported.probeTerm == "食べる", "worker term probe changed");
  check(imported.probeKanji == "食", "worker kanji probe changed");

  const auto probe = session.probeDictionary({
      .path = imported.outputPath,
      .types = imported.types,
      .probeTerm = imported.probeTerm,
      .probeKanji = imported.probeKanji,
  });
  check(probe.loaded, "worker probe did not load the imported index");
  check(probe.termProbeMatched, "worker term probe did not match");
  check(probe.kanjiProbeMatched, "worker kanji probe did not match");

  checkHostError(
      [&] {
        session.importDictionary({
            .jobId = "other",
            .zipPath = fixtureZip.string(),
            .outputPath = (staging.path() / "other-index").string(),
            .lowRam = true,
        });
      },
      "PATH_OUTSIDE_STORE", "worker accepted paths outside one staging job");
}

void testProtocol() {
  Session session;
  ProtocolHandler protocol(session);

  const auto malformed = protocol.handleLine("{");
  check(malformed.find("INVALID_REQUEST") != std::string::npos, "malformed JSON was accepted");

  const auto missingFields =
      protocol.handleLine(R"({"id":"missing","method":"health"})");
  check(
      missingFields.find("INVALID_REQUEST") != std::string::npos,
      "request with missing fields was accepted");

  const auto tooLarge =
      protocol.handleLine(std::string(kMaxRequestLineBytes + 1, 'x'));
  check(
      tooLarge.find("REQUEST_TOO_LARGE") != std::string::npos,
      "oversized request was accepted");

  const auto beforeHello =
      protocol.handleLine(R"({"id":"before","method":"health","params":{}})");
  check(
      beforeHello.find("HANDSHAKE_REQUIRED") != std::string::npos,
      "request before hello was accepted");

  const auto mismatch = protocol.handleLine(
      R"({"id":"mismatch","method":"hello","params":{"protocol":{"major":2,"minor":0},"client":"test","clientVersion":"1"}})");
  check(
      mismatch.find("PROTOCOL_MISMATCH") != std::string::npos,
      "incompatible protocol was accepted");

  const auto hello = protocol.handleLine(
      R"({"id":"hello","method":"hello","params":{"protocol":{"major":1,"minor":0},"client":"test","clientVersion":"1","futureField":true},"futureField":true})");
  check(hello.find(R"("ok":true)") != std::string::npos, "valid hello failed");
  check(
      hello.find(GSM_HOSHIDICTS_COMMIT) != std::string::npos,
      "hello omitted the selected source commit");
  check(hello.find(R"("kanji")") != std::string::npos, "hello omitted kanji capability");
  check(hello.find(R"("import")") != std::string::npos, "hello omitted import capability");
  check(hello.find(R"("probe")") != std::string::npos, "hello omitted probe capability");

  const auto duplicate =
      protocol.handleLine(R"({"id":"hello","method":"health","params":{}})");
  check(
      duplicate.find("DUPLICATE_REQUEST_ID") != std::string::npos,
      "duplicate request id was accepted");

  const auto health =
      protocol.handleLine(R"({"id":"health","method":"health","params":{}})");
  check(health.find(R"("status":"ok")") != std::string::npos, "health failed");

  const auto unknown =
      protocol.handleLine(R"({"id":"unknown","method":"missing","params":{}})");
  check(
      unknown.find("METHOD_NOT_FOUND") != std::string::npos,
      "unknown method was accepted");

  const auto cancel = protocol.handleLine(
      R"({"id":"cancel","method":"cancel","params":{"requestId":"future"}})");
  check(cancel.find(R"("accepted":true)") != std::string::npos, "cancel failed");
  const auto cancelled =
      protocol.handleLine(R"({"id":"future","method":"health","params":{}})");
  check(cancelled.find(R"("CANCELLED")") != std::string::npos, "cancelled request ran");

  const auto shutdown =
      protocol.handleLine(R"({"id":"shutdown","method":"shutdown","params":{}})");
  check(shutdown.find(R"("accepted":true)") != std::string::npos, "shutdown failed");
  check(protocol.shutdownRequested(), "shutdown state was not retained");
}

}  // namespace

int main(int argc, char* argv[]) {
  if (argc != 2) {
    std::cerr << "expected generated fixture ZIP path\n";
    return 2;
  }

  try {
    testProtocol();
    const auto fixtureZip = std::filesystem::absolute(argv[1]);
    testSession(fixtureZip);
    testImportWorker(fixtureZip);
    std::cout << "hoshidicts host tests passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "hoshidicts host tests failed: " << error.what() << '\n';
    return 1;
  }
}
