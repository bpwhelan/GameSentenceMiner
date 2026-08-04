#include "protocol.hpp"

#include <glaze/glaze.hpp>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace gsm::hoshidicts {
namespace protocol_detail {

constexpr std::size_t kMaxRememberedIds = 4096;

struct RequestEnvelope {
  std::string id;
  std::string method;
  glz::raw_json params;
};

struct ErrorData {
  std::string code;
  std::string message;
};

struct SuccessEnvelope {
  std::string id;
  bool ok{true};
  glz::raw_json result;
};

struct ErrorEnvelope {
  std::string id;
  bool ok{false};
  ErrorData error;
};

struct ProtocolVersion {
  int major{};
  int minor{};
};

struct HelloParams {
  ProtocolVersion protocol;
  std::string client;
  std::string clientVersion;
};

struct HelloResult {
  ProtocolVersion protocol;
  std::string hostVersion;
  std::string hoshidictsCommit;
  std::vector<std::string> capabilities;
};

struct EmptyParams {};

struct HealthResult {
  std::string status{"ok"};
  ProtocolVersion protocol{.major = kProtocolMajor, .minor = kProtocolMinor};
  std::string hostVersion{GSM_HOSHIDICTS_HOST_VERSION};
  std::int64_t catalogGeneration{};
  std::int64_t uptimeMs{};
};

struct CancelParams {
  std::string requestId;
};

struct CancelResult {
  std::string requestId;
  bool accepted{};
};

struct ShutdownResult {
  bool accepted{true};
};

std::string serializeError(
    std::string id, std::string code, std::string message) {
  ErrorEnvelope response{
      .id = std::move(id),
      .error =
          {
              .code = std::move(code),
              .message = message.substr(0, 512),
          },
  };
  return glz::write_json(response).value_or(
      R"({"id":"","ok":false,"error":{"code":"INTERNAL_ERROR","message":"failed to serialize error"}})");
}

template <typename Result>
std::string serializeSuccess(
    const std::string& id, const Result& result, std::size_t maxBytes) {
  const auto resultJson = glz::write_json(result);
  if (!resultJson) {
    return serializeError(id, "INTERNAL_ERROR", "failed to serialize result");
  }

  SuccessEnvelope response{
      .id = id,
      .result = glz::raw_json(resultJson.value()),
  };
  auto responseJson = glz::write_json(response);
  if (!responseJson) {
    return serializeError(id, "INTERNAL_ERROR", "failed to serialize response");
  }
  if (responseJson->size() > maxBytes) {
    return serializeError(id, "RESPONSE_TOO_LARGE", "response exceeds the protocol limit");
  }
  return std::move(responseJson.value());
}

template <typename Params>
Params parseParams(const glz::raw_json& source) {
  Params params;
  const std::string_view json = source.str.empty() ? std::string_view("{}") : source.str;
  const auto error =
      glz::read<glz::opts{
          .error_on_unknown_keys = false,
          .error_on_missing_keys = true,
      }>(params, json);
  if (error) {
    throw HostError("INVALID_PARAMS", "request parameters are invalid");
  }
  return params;
}

bool validRequestId(const std::string& id) {
  if (id.empty() || id.size() > 128) {
    return false;
  }
  return std::ranges::none_of(id, [](unsigned char character) {
    return std::iscntrl(character) != 0;
  });
}

void validateGeneration(std::int64_t generation) {
  if (generation < 0) {
    throw HostError("INVALID_PARAMS", "generation must not be negative");
  }
}

}  // namespace protocol_detail

using namespace protocol_detail;

ProtocolHandler::ProtocolHandler(Session& session)
    : session_(session), started_(std::chrono::steady_clock::now()) {}

bool ProtocolHandler::rememberRequestId(const std::string& id) {
  if (recentRequestIdSet_.contains(id)) {
    return false;
  }
  recentRequestIds_.push_back(id);
  recentRequestIdSet_.insert(id);
  if (recentRequestIds_.size() > kMaxRememberedIds) {
    recentRequestIdSet_.erase(recentRequestIds_.front());
    recentRequestIds_.pop_front();
  }
  return true;
}

void ProtocolHandler::rememberCancelledId(const std::string& id) {
  if (!cancelledRequestIdSet_.insert(id).second) {
    return;
  }
  cancelledRequestIds_.push_back(id);
  if (cancelledRequestIds_.size() > kMaxRememberedIds) {
    cancelledRequestIdSet_.erase(cancelledRequestIds_.front());
    cancelledRequestIds_.pop_front();
  }
}

std::string ProtocolHandler::handleLine(std::string_view line) {
  if (line.size() > kMaxRequestLineBytes) {
    return oversizedLineError();
  }

  RequestEnvelope request;
  const auto parseError =
      glz::read<glz::opts{
          .error_on_unknown_keys = false,
          .error_on_missing_keys = true,
      }>(request, line);
  if (parseError) {
    return serializeError("", "INVALID_REQUEST", "request must be a valid JSON object");
  }
  if (!validRequestId(request.id)) {
    return serializeError("", "INVALID_REQUEST", "request id is invalid");
  }
  if (request.method.empty() || request.method.size() > 128) {
    return serializeError(request.id, "INVALID_REQUEST", "request method is invalid");
  }
  if (!rememberRequestId(request.id)) {
    return serializeError(request.id, "DUPLICATE_REQUEST_ID", "request id was already used");
  }

  if (cancelledRequestIdSet_.erase(request.id) > 0) {
    return serializeError(request.id, "CANCELLED", "request was cancelled");
  }

  try {
    if (request.method == "hello") {
      if (handshakeComplete_) {
        throw HostError("ALREADY_INITIALIZED", "hello may only be called once");
      }
      const auto params = parseParams<HelloParams>(request.params);
      if (params.protocol.major != kProtocolMajor ||
          params.protocol.minor > kProtocolMinor) {
        throw HostError("PROTOCOL_MISMATCH", "requested protocol version is not supported");
      }
      if (params.client.empty() || params.client.size() > 128 ||
          params.clientVersion.empty() || params.clientVersion.size() > 128) {
        throw HostError("INVALID_PARAMS", "client identity is invalid");
      }

      handshakeComplete_ = true;
      return serializeSuccess(
          request.id,
          HelloResult{
              .protocol =
                  {
                      .major = kProtocolMajor,
                      .minor = kProtocolMinor,
                  },
              .hostVersion = GSM_HOSHIDICTS_HOST_VERSION,
              .hoshidictsCommit = GSM_HOSHIDICTS_COMMIT,
              .capabilities =
                  {
                      "term",
                      "frequency",
                      "pitch",
                      "kanji",
                      "styles",
                      "media",
                      "cancel",
                  },
          },
          kMaxResponseLineBytes);
    }

    if (!handshakeComplete_) {
      throw HostError("HANDSHAKE_REQUIRED", "hello must be called before other methods");
    }

    if (request.method == "health") {
      static_cast<void>(parseParams<EmptyParams>(request.params));
      const auto uptime = std::chrono::duration_cast<std::chrono::milliseconds>(
                              std::chrono::steady_clock::now() - started_)
                              .count();
      return serializeSuccess(
          request.id,
          HealthResult{
              .catalogGeneration = session_.catalogGeneration(),
              .uptimeMs = uptime,
          },
          kMaxResponseLineBytes);
    }

    if (request.method == "catalog.configure") {
      const auto params = parseParams<CatalogConfigureParams>(request.params);
      return serializeSuccess(
          request.id, session_.configureCatalog(params), kMaxResponseLineBytes);
    }

    if (request.method == "lookup.term") {
      const auto params = parseParams<LookupTermParams>(request.params);
      validateGeneration(params.requestGeneration);
      return serializeSuccess(
          request.id, session_.lookupTerm(params), kMaxResponseLineBytes);
    }

    if (request.method == "lookup.kanji") {
      const auto params = parseParams<LookupKanjiParams>(request.params);
      validateGeneration(params.requestGeneration);
      return serializeSuccess(
          request.id, session_.lookupKanji(params), kMaxResponseLineBytes);
    }

    if (request.method == "styles.list") {
      const auto params = parseParams<CatalogGenerationParams>(request.params);
      return serializeSuccess(
          request.id, session_.listStyles(params), kMaxResponseLineBytes);
    }

    if (request.method == "media.get") {
      const auto params = parseParams<MediaGetParams>(request.params);
      return serializeSuccess(
          request.id, session_.getMedia(params), kMaxMediaResponseLineBytes);
    }

    if (request.method == "cancel") {
      const auto params = parseParams<CancelParams>(request.params);
      if (!validRequestId(params.requestId)) {
        throw HostError("INVALID_PARAMS", "cancel request id is invalid");
      }
      rememberCancelledId(params.requestId);
      return serializeSuccess(
          request.id,
          CancelResult{
              .requestId = params.requestId,
              .accepted = true,
          },
          kMaxResponseLineBytes);
    }

    if (request.method == "shutdown") {
      static_cast<void>(parseParams<EmptyParams>(request.params));
      shutdownRequested_ = true;
      return serializeSuccess(request.id, ShutdownResult{}, kMaxResponseLineBytes);
    }

    throw HostError("METHOD_NOT_FOUND", "requested method is not supported");
  } catch (const HostError& error) {
    return serializeError(request.id, error.code(), error.what());
  } catch (const std::exception&) {
    return serializeError(request.id, "INTERNAL_ERROR", "request failed");
  }
}

std::string ProtocolHandler::oversizedLineError() const {
  return serializeError("", "REQUEST_TOO_LARGE", "request exceeds the protocol limit");
}

bool ProtocolHandler::shutdownRequested() const noexcept {
  return shutdownRequested_;
}

}  // namespace gsm::hoshidicts
