#pragma once
#include <cstdint>

namespace gsm {
constexpr uint32_t KeepActive = 1;
constexpr uint32_t BlockGamepad = 2;
constexpr uint32_t LeaseMilliseconds = 3000;

inline uint32_t effective_flags(uint32_t requested, uint32_t heartbeat, uint32_t now, bool valid_window) {
    return valid_window && uint32_t(now - heartbeat) < LeaseMilliseconds ? requested & 3u : 0;
}
inline bool suppress_focus_message(uint32_t message, uintptr_t parameter) {
    return (message == 0x001c && !parameter) || (message == 0x0006 && !(parameter & 0xffff)) || message == 0x0008;
}
inline bool block_gamepad(uint32_t flags, bool foreground) {
    return (flags & BlockGamepad) && !foreground;
}
}
