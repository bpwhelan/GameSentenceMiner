#pragma once

#include "session.hpp"

#include <chrono>
#include <cstddef>
#include <deque>
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
  explicit ProtocolHandler(Session& session);

  std::string handleLine(std::string_view line);
  std::string oversizedLineError() const;
  bool shutdownRequested() const noexcept;

 private:
  bool rememberRequestId(const std::string& id);
  void rememberCancelledId(const std::string& id);

  Session& session_;
  bool handshakeComplete_{};
  bool shutdownRequested_{};
  std::chrono::steady_clock::time_point started_;
  std::deque<std::string> recentRequestIds_;
  std::unordered_set<std::string> recentRequestIdSet_;
  std::deque<std::string> cancelledRequestIds_;
  std::unordered_set<std::string> cancelledRequestIdSet_;
};

}  // namespace gsm::hoshidicts
