// Original, deliberately narrow GSM implementation. See NOTICE.md for research and dependencies.
#include "protocol.h"
#include "direct_input.h"
#include <xinput.h>
#include <MinHook.h>
#include <array>
#include <cstring>
#include <utility>

namespace {
using namespace gsm;
SharedState* state = nullptr;
using WindowQuery = HWND(WINAPI*)();
WindowQuery originalForeground = nullptr, originalActive = nullptr, originalFocus = nullptr;
using StateQuery = DWORD(WINAPI*)(DWORD, XINPUT_STATE*);
using KeyQuery = DWORD(WINAPI*)(DWORD, DWORD, XINPUT_KEYSTROKE*);
constexpr size_t MaxHooks = 16;
std::array<WNDPROC, MaxHooks> windowOriginals{};
std::array<void*, MaxHooks> windowTargets{};
std::array<StateQuery, MaxHooks> stateOriginals{};
std::array<void*, MaxHooks> stateTargets{};
std::array<KeyQuery, MaxHooks> keyOriginals{};
std::array<void*, MaxHooks> keyTargets{};
size_t windowCount = 0, stateCount = 0, keyCount = 0;
SRWLOCK packetLock = SRWLOCK_INIT;
struct Packet { DWORD number = 0; XINPUT_GAMEPAD gamepad{}; bool initialized = false; };
std::array<Packet, XUSER_MAX_COUNT> packets{};

uint32_t flags() {
    if (!state) return 0;
    HWND window = target_window(state);
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    return effective_flags(read(state->requested), read(state->heartbeat), GetTickCount(),
                           window && pid == GetCurrentProcessId());
}
bool foreground() {
    DWORD pid = 0;
    HWND window = originalForeground ? originalForeground() : GetForegroundWindow();
    GetWindowThreadProcessId(window, &pid);
    return pid == GetCurrentProcessId();
}
bool keep_active() { return (flags() & KeepActive) && !IsIconic(target_window(state)); }
bool on_window_thread() { return GetWindowThreadProcessId(target_window(state), nullptr) == GetCurrentThreadId(); }

HWND WINAPI foreground_hook() { return keep_active() ? target_window(state) : originalForeground(); }
HWND WINAPI active_hook() { return keep_active() && on_window_thread() ? target_window(state) : originalActive(); }
HWND WINAPI focus_hook() { return keep_active() && on_window_thread() ? target_window(state) : originalFocus(); }

template<size_t Index>
LRESULT CALLBACK window_hook(HWND window, UINT message, WPARAM wp, LPARAM lp) {
    if (window == target_window(state) && keep_active() && suppress_focus_message(message, wp)) {
        InterlockedIncrement(&state->focusEvents);
        return 0;
    }
    return windowOriginals[Index](window, message, wp, lp);
}

template<size_t Index>
DWORD WINAPI state_hook(DWORD player, XINPUT_STATE* result) {
    const DWORD code = stateOriginals[Index](player, result);
    InterlockedIncrement(&state->inputCalls);
    const auto options = flags();
    if (code != ERROR_SUCCESS || !result || !(options & BlockGamepad)) return code;
    if (block_gamepad(options, foreground())) {
        ZeroMemory(&result->Gamepad, sizeof(result->Gamepad));
        InterlockedIncrement(&state->blockedCalls);
    }
    // Games often ignore an unchanged packet number. A held button must produce
    // a release when focus leaves, and a fresh state when focus returns.
    if (player < packets.size()) {
        AcquireSRWLockExclusive(&packetLock);
        auto& packet = packets[player];
        if (!packet.initialized) { packet.number = result->dwPacketNumber + 1; packet.initialized = true; }
        if (std::memcmp(&packet.gamepad, &result->Gamepad, sizeof(packet.gamepad)) != 0) ++packet.number;
        packet.gamepad = result->Gamepad;
        result->dwPacketNumber = packet.number;
        ReleaseSRWLockExclusive(&packetLock);
    }
    return code;
}
template<size_t Index>
DWORD WINAPI key_hook(DWORD player, DWORD reserved, XINPUT_KEYSTROKE* result) {
    DWORD code = keyOriginals[Index](player, reserved, result);
    if (code != ERROR_SUCCESS && code != ERROR_EMPTY) return code;
    if (!result || !block_gamepad(flags(), foreground())) return code;
    // Drain queued background button events so they do not replay on refocus.
    for (int i = 0; code == ERROR_SUCCESS && i < 32; ++i)
        code = keyOriginals[Index](player, reserved, result);
    ZeroMemory(result, sizeof(*result));
    InterlockedIncrement(&state->blockedCalls);
    return code == ERROR_DEVICE_NOT_CONNECTED ? code : ERROR_EMPTY;
}
template<size_t... I> auto window_callbacks(std::index_sequence<I...>) { return std::array<WNDPROC, sizeof...(I)>{window_hook<I>...}; }
template<size_t... I> auto state_callbacks(std::index_sequence<I...>) { return std::array<StateQuery, sizeof...(I)>{state_hook<I>...}; }
template<size_t... I> auto key_callbacks(std::index_sequence<I...>) { return std::array<KeyQuery, sizeof...(I)>{key_hook<I>...}; }
const auto windowCallbacks = window_callbacks(std::make_index_sequence<MaxHooks>{});
const auto stateCallbacks = state_callbacks(std::make_index_sequence<MaxHooks>{});
const auto keyCallbacks = key_callbacks(std::make_index_sequence<MaxHooks>{});

bool hook(void* target, void* callback, void** original) {
    if (!target) return false;
    if (MH_CreateHook(target, callback, original) != MH_OK) return false;
    if (MH_EnableHook(target) == MH_OK) return true;
    MH_RemoveHook(target);
    *original = nullptr;
    return false;
}
void pin(void* address) {
    HMODULE module = nullptr;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                      reinterpret_cast<LPCWSTR>(address), &module);
}
void scan_window() {
    HWND window = target_window(state);
    // Query in the window's own encoding. Querying an ANSI procedure through
    // the Unicode API can return an opaque CallWindowProc conversion token,
    // not an executable address (as in Trails in the Sky 1st Chapter).
    auto target = reinterpret_cast<void*>(IsWindowUnicode(window)
        ? GetWindowLongPtrW(window, GWLP_WNDPROC)
        : GetWindowLongPtrA(window, GWLP_WNDPROC));
    for (size_t i = 0; i < windowCount; ++i) if (windowTargets[i] == target) {
        InterlockedAnd(&state->errors, ~2L);
        return;
    }
    if (windowCount >= MaxHooks || !target) { InterlockedOr(&state->errors, 2); return; }
    if (hook(target, reinterpret_cast<void*>(windowCallbacks[windowCount]), reinterpret_cast<void**>(&windowOriginals[windowCount]))) {
        pin(target);
        windowTargets[windowCount++] = target;
        InterlockedExchange(&state->windowHooks, static_cast<LONG>(windowCount));
        InterlockedAnd(&state->errors, ~2L);
    } else InterlockedOr(&state->errors, 2);
}
void scan_input() {
    for (const auto* name : {L"xinput1_4.dll", L"xinput1_3.dll", L"xinput9_1_0.dll", L"xinput1_2.dll", L"xinput1_1.dll", L"xinputuap.dll"}) {
        HMODULE module = GetModuleHandleW(name);
        if (!module) continue; // Do not load an input API the game is not using.
        for (const auto* symbol : {"XInputGetState", reinterpret_cast<const char*>(100)}) {
            auto target = reinterpret_cast<void*>(GetProcAddress(module, symbol));
            if (!target || stateCount >= MaxHooks) continue;
            bool known = false;
            for (size_t i = 0; i < stateCount; ++i) if (stateTargets[i] == target) known = true;
            if (known) continue;
            if (hook(target, reinterpret_cast<void*>(stateCallbacks[stateCount]), reinterpret_cast<void**>(&stateOriginals[stateCount]))) {
                pin(target);
                stateTargets[stateCount++] = target;
                InterlockedIncrement(&state->inputHooks);
            } else InterlockedOr(&state->errors, 4);
        }
        auto target = reinterpret_cast<void*>(GetProcAddress(module, "XInputGetKeystroke"));
        bool known = false;
        for (size_t i = 0; i < keyCount; ++i) if (keyTargets[i] == target) known = true;
        if (!target || known || keyCount >= MaxHooks) continue;
        if (hook(target, reinterpret_cast<void*>(keyCallbacks[keyCount]), reinterpret_cast<void**>(&keyOriginals[keyCount]))) {
            pin(target);
            keyTargets[keyCount++] = target;
        } else InterlockedOr(&state->errors, 4);
    }
    scan_direct_input({state, flags, foreground, hook, pin});
}
void notify_activation(bool active) {
    const HWND window = target_window(state);
    if (!IsWindow(window) || IsIconic(window)) return;
    // Only tell this window about activation; never take real desktop focus.
    // Queue on its owning GUI thread; synchronous sends can time out precisely
    // when a game has throttled its background message loop.
    PostMessageW(window, WM_ACTIVATEAPP, active, 0);
    // Do not synthesize WM_ACTIVATE: DefWindowProc can turn it into SetFocus,
    // which changes actual desktop activation on some Windows versions.
    if (!active) PostMessageW(window, WM_ACTIVATE, WA_INACTIVE, 0);
    PostMessageW(window, active ? WM_SETFOCUS : WM_KILLFOCUS, 0, 0);
}
DWORD WINAPI worker(void*) {
    HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, mapping_name(GetCurrentProcessId()).c_str());
    if (!mapping) return 0;
    state = static_cast<SharedState*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(SharedState)));
    if (!state || state->version != ProtocolVersion || state->processId != static_cast<LONG>(GetCurrentProcessId())) return 0;
    // The DLL and trampolines intentionally remain resident until game exit.
    // Unloading code while a game thread executes it is unsafe. The lease turns
    // all hooks into pass-throughs after controller shutdown or failure.
    if (MH_Initialize() != MH_OK) { InterlockedExchange(&state->errors, 8); return 0; }
    HMODULE user32 = GetModuleHandleW(L"user32.dll");
    for (auto entry : {std::make_pair("GetForegroundWindow", std::make_pair(foreground_hook, &originalForeground)),
                       std::make_pair("GetActiveWindow", std::make_pair(active_hook, &originalActive)),
                       std::make_pair("GetFocus", std::make_pair(focus_hook, &originalFocus))}) {
        if (hook(reinterpret_cast<void*>(GetProcAddress(user32, entry.first)), reinterpret_cast<void*>(entry.second.first),
                 reinterpret_cast<void**>(entry.second.second))) InterlockedIncrement(&state->focusHooks);
        else InterlockedOr(&state->errors, 1);
    }
    scan_window();
    scan_input();
    InterlockedExchange(&state->ready, 1);
    bool wasActive = false;
    for (;;) {
        const auto options = flags();
        const bool active = (options & KeepActive) != 0;
        if (options) { scan_window(); scan_input(); }
        if (active != wasActive && !foreground()) notify_activation(active);
        wasActive = active;
        InterlockedExchange(&state->foreground, foreground());
        InterlockedExchange(&state->effective, options);
        Sleep(100);
    }
}
}
BOOL WINAPI DllMain(HINSTANCE, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        // Keep thread notifications enabled: this DLL uses the static CRT.
        HANDLE thread = CreateThread(nullptr, 0, worker, nullptr, 0, nullptr);
        if (thread) CloseHandle(thread);
    }
    return TRUE;
}
