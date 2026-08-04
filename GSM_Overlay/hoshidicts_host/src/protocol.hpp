#pragma once

#include "session.hpp"

#include <chrono>
#include <cstddef>
#include <deque>
#include <functional>
#include <string>
#include <string_view>
#include <unordered_set>

namespace gsm::hoshidicts {

inline constexpr int kProtocolMajor = 1;
inline constexpr int kProtocolMinor = 0;
inline constexpr std::size_t kMaxRequestLineBytes = 1024 * 1024;
inline constexpr std::size_t kMaxResponseLineBytes = 8 * 1024 * 1024;
inline constexpr std::size_t kMaxMediaResponseLineBytes = 16 * 1024 * 1024;

class ProtocolHandler {
 public:
  using EventSink = std::function<void(std::string_view)>;

  explicit ProtocolHandler(Session& session, EventSink eventSink = {});

  std::string handleLine(std::string_view line);
  std::string oversizedLineError() const;
  bool shutdownRequested() const noexcept;

 private:
  bool rememberRequestId(const std::string& id);
  void rememberCancelledId(const std::string& id);
  void emitImportProgress(
      const std::string& jobId,
      std::string phase,
      std::size_t completed,
      std::size_t total) const;

  Session& session_;
  EventSink eventSink_;
  bool handshakeComplete_{};
  bool shutdownRequested_{};
  std::chrono::steady_clock::time_point started_;
  std::deque<std::string> recentRequestIds_;
  std::unordered_set<std::string> recentRequestIdSet_;
  std::deque<std::string> cancelledRequestIds_;
  std::unordered_set<std::string> cancelledRequestIdSet_;
};

}  // namespace gsm::hoshidicts
