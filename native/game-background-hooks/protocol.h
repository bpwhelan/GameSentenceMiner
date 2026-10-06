#pragma once
#include <windows.h>
#include <string>
#include "policy.h"

namespace gsm {
constexpr LONG ProtocolVersion = 1;
// Fixed-width fields keep the layout identical in 32-bit and 64-bit processes.
struct SharedState {
    LONG version;
    LONG processId;
    volatile LONG requested;
    volatile LONG heartbeat;
    volatile LONG ready;
    volatile LONG effective;
    volatile LONG errors;
    volatile LONG inputHooks;
    volatile LONG focusHooks;
    volatile LONG windowHooks;
    volatile LONG focusEvents;
    volatile LONG inputCalls;
    volatile LONG blockedCalls;
    volatile LONG foreground;
    volatile LONG windowHandle; // USER handles are 32-bit values on both Windows ABIs.
};
inline LONG read(volatile LONG& value) { return InterlockedCompareExchange(&value, 0, 0); }
inline std::wstring mapping_name(DWORD pid) { return L"Local\\GSM.GameBackground.v1." + std::to_wstring(pid); }
inline HWND target_window(SharedState* state) {
    return reinterpret_cast<HWND>(static_cast<uintptr_t>(static_cast<uint32_t>(read(state->windowHandle))));
}
}
