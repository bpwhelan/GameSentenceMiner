#include "protocol.hpp"
#include "session.hpp"

#include <hoshidicts/importer.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <psapi.h>
#elif defined(__APPLE__)
#include <sys/resource.h>
#elif defined(__linux__)
#include <unistd.h>
#endif

namespace {

using namespace gsm::hoshidicts;
using Clock = std::chrono::steady_clock;

class TemporaryDirectory {
 public:
  TemporaryDirectory() {
    const auto suffix = Clock::now().time_since_epoch().count();
    path_ = std::filesystem::temp_directory_path() /
            ("gsm-hoshidicts-benchmark-" + std::to_string(suffix));
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

double milliseconds(Clock::duration duration) {
  return std::chrono::duration<double, std::milli>(duration).count();
}

double percentile(std::vector<double> values, double quantile) {
  if (values.empty()) {
    return 0;
  }
  std::ranges::sort(values);
  const auto rank = static_cast<std::size_t>(
      std::ceil(quantile * static_cast<double>(values.size())));
  return values[std::min(values.size() - 1, std::max<std::size_t>(1, rank) - 1)];
}

std::uint64_t residentBytes() {
#if defined(_WIN32)
  PROCESS_MEMORY_COUNTERS counters{};
  if (GetProcessMemoryInfo(
          GetCurrentProcess(), &counters, static_cast<DWORD>(sizeof(counters))) != 0) {
    return counters.WorkingSetSize;
  }
#elif defined(__APPLE__)
  rusage usage{};
  if (getrusage(RUSAGE_SELF, &usage) == 0) {
    return static_cast<std::uint64_t>(usage.ru_maxrss);
  }
#elif defined(__linux__)
  std::ifstream statm("/proc/self/statm");
  std::uint64_t totalPages{};
  std::uint64_t residentPages{};
  if (statm >> totalPages >> residentPages) {
    const auto pageSize = sysconf(_SC_PAGESIZE);
    if (pageSize > 0) {
      return residentPages * static_cast<std::uint64_t>(pageSize);
    }
  }
#endif
  return 0;
}

void require(bool condition, const std::string& message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

}  // namespace

int main(int argc, char* argv[]) {
  if (argc != 2) {
    std::cerr << "expected generated fixture ZIP path\n";
    return 2;
  }

  try {
    TemporaryDirectory output;
    const auto importStarted = Clock::now();
    const auto imported = dictionary_importer::import(
        std::filesystem::absolute(argv[1]).string(), output.path().string(), true);
    const auto importMs = milliseconds(Clock::now() - importStarted);
    require(imported.success, "fixture import failed");

    std::vector<double> protocolHandshakeSamples;
    protocolHandshakeSamples.reserve(200);
    for (int index = 0; index < 200; ++index) {
      Session handshakeSession;
      ProtocolHandler protocol(handshakeSession);
      const auto started = Clock::now();
      const auto response = protocol.handleLine(
          R"({"id":"benchmark","method":"hello","params":{"protocol":{"major":1,"minor":0},"client":"benchmark","clientVersion":"1"}})");
      protocolHandshakeSamples.push_back(milliseconds(Clock::now() - started));
      require(response.find(R"("ok":true)") != std::string::npos, "protocol handshake failed");
    }

    Session session;
    std::vector<double> catalogSamples;
    catalogSamples.reserve(50);
    for (std::int64_t generation = 1; generation <= 50; ++generation) {
      const auto catalogStarted = Clock::now();
      session.configureCatalog({
          .generation = generation,
          .dictionaries =
              {{
                  .id = "fixture",
                  .path = (output.path() / imported.title).string(),
                  .types = {"term", "frequency", "pitch", "kanji"},
                  .priority = 0,
              }},
      });
      catalogSamples.push_back(milliseconds(Clock::now() - catalogStarted));
    }

    const LookupTermParams lookupParams{
        .catalogGeneration = 50,
        .requestGeneration = 1,
        .text = "食べました",
        .scanLength = 16,
        .maxResults = 16,
    };
    require(!session.lookupTerm(lookupParams).results.empty(), "warmup lookup failed");

    std::vector<double> lookupSamples;
    lookupSamples.reserve(500);
    for (int index = 0; index < 500; ++index) {
      const auto started = Clock::now();
      const auto result = session.lookupTerm(lookupParams);
      lookupSamples.push_back(milliseconds(Clock::now() - started));
      require(!result.results.empty(), "benchmark lookup failed");
    }

    const auto handshakeP95 = percentile(protocolHandshakeSamples, 0.95);
    const auto catalogP50 = percentile(catalogSamples, 0.50);
    const auto catalogP95 = percentile(catalogSamples, 0.95);
    const auto lookupP50 = percentile(lookupSamples, 0.50);
    const auto lookupP95 = percentile(lookupSamples, 0.95);
    const auto memoryBytes = residentBytes();

    std::cout << std::fixed << std::setprecision(3)
              << "{\"fixtureImportMs\":" << importMs
              << ",\"protocolHandshakeP95Ms\":" << handshakeP95
              << ",\"catalogActivationP50Ms\":" << catalogP50
              << ",\"catalogActivationP95Ms\":" << catalogP95
              << ",\"lookupP50Ms\":" << lookupP50
              << ",\"lookupP95Ms\":" << lookupP95
              << ",\"residentBytes\":" << memoryBytes << "}\n";

    require(catalogP95 <= 2000, "fixture catalog activation p95 exceeded 2 seconds");
    require(lookupP50 <= 30, "fixture lookup p50 exceeded 30 milliseconds");
    require(lookupP95 <= 100, "fixture lookup p95 exceeded 100 milliseconds");
    require(
        memoryBytes == 0 || memoryBytes <= 1536ULL * 1024ULL * 1024ULL,
        "fixture resident memory exceeded 1.5 GiB");
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "hoshidicts host benchmark failed: " << error.what() << '\n';
    return 1;
  }
}
