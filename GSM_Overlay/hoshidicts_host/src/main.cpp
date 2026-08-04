#include "protocol.hpp"
#include "session.hpp"

#include <iostream>
#include <string>
#include <string_view>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#endif

namespace {

using gsm::hoshidicts::ProtocolHandler;
using gsm::hoshidicts::Session;
using gsm::hoshidicts::kMaxRequestLineBytes;
using gsm::hoshidicts::kProtocolMajor;
using gsm::hoshidicts::kProtocolMinor;

int runSelfTest() {
  Session session;
  ProtocolHandler protocol(session);
  const auto hello = protocol.handleLine(
      R"({"id":"self-hello","method":"hello","params":{"protocol":{"major":1,"minor":0},"client":"self-test","clientVersion":"0"}})");
  const auto health =
      protocol.handleLine(R"({"id":"self-health","method":"health","params":{}})");
  if (hello.find(R"("ok":true)") == std::string::npos ||
      hello.find(GSM_HOSHIDICTS_COMMIT) == std::string::npos ||
      health.find(R"("status":"ok")") == std::string::npos) {
    std::cerr << "hoshidicts-host self-test failed\n";
    return 1;
  }
  std::cout << "hoshidicts-host self-test ok\n";
  return 0;
}

int runProtocol() {
#if defined(_WIN32)
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif

  Session session;
  ProtocolHandler protocol(session);
  std::string line;
  line.reserve(4096);
  bool oversized = false;

  std::cerr << R"({"level":"info","event":"host.started","protocol":"1.0"})"
            << '\n';

  char character = '\0';
  while (std::cin.get(character)) {
    if (character == '\n') {
      if (oversized) {
        std::cout << protocol.oversizedLineError() << '\n' << std::flush;
      } else if (!line.empty()) {
        if (line.back() == '\r') {
          line.pop_back();
        }
        std::cout << protocol.handleLine(line) << '\n' << std::flush;
      }
      line.clear();
      oversized = false;
      if (protocol.shutdownRequested()) {
        return 0;
      }
      continue;
    }

    if (!oversized) {
      if (line.size() >= kMaxRequestLineBytes) {
        line.clear();
        oversized = true;
      } else {
        line.push_back(character);
      }
    }
  }

  if (oversized) {
    std::cout << protocol.oversizedLineError() << '\n' << std::flush;
  } else if (!line.empty()) {
    if (line.back() == '\r') {
      line.pop_back();
    }
    std::cout << protocol.handleLine(line) << '\n' << std::flush;
  }
  return 0;
}

void printUsage(std::string_view executable) {
  std::cerr << "Usage: " << executable
            << " [--version|--protocol-version|--self-test]\n";
}

}  // namespace

int main(int argc, char* argv[]) {
  if (argc == 1) {
    return runProtocol();
  }
  if (argc != 2) {
    printUsage(argv[0]);
    return 2;
  }

  const std::string_view command(argv[1]);
  if (command == "--version") {
    std::cout << "hoshidicts-host " << GSM_HOSHIDICTS_HOST_VERSION
              << " hoshidicts " << GSM_HOSHIDICTS_COMMIT << '\n';
    return 0;
  }
  if (command == "--protocol-version") {
    std::cout << kProtocolMajor << '.' << kProtocolMinor << '\n';
    return 0;
  }
  if (command == "--self-test") {
    return runSelfTest();
  }

  printUsage(argv[0]);
  return 2;
}
