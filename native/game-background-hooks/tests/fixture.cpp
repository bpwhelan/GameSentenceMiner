#include <windows.h>
#include <xinput.h>
#include <iostream>
#include <string>

bool active = false;
unsigned ticks = 0, deactivations = 0;
LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wp, LPARAM lp) {
    if (message == WM_ACTIVATEAPP) { active = wp != 0; if (!wp) ++deactivations; }
    if (message == WM_ACTIVATE && LOWORD(wp) == WA_INACTIVE) active = false;
    if (message == WM_KILLFOCUS) active = false;
    return DefWindowProcW(window, message, wp, lp);
}
int wmain() {
    WNDCLASSW cls{};
    cls.hInstance = GetModuleHandleW(nullptr);
    cls.lpfnWndProc = window_proc;
    cls.lpszClassName = L"GsmBackgroundFixture";
    RegisterClassW(&cls);
    HWND window = CreateWindowW(cls.lpszClassName, L"GSM background hook test", WS_OVERLAPPEDWINDOW,
                                0, 0, 100, 100, nullptr, nullptr, cls.hInstance, nullptr);
    // A hidden test window is guaranteed to start in the background.
    std::cout << "{\"pid\":" << GetCurrentProcessId() << ",\"hwnd\":\"" << reinterpret_cast<uintptr_t>(window) << "\"}" << std::endl;
    HMODULE input = nullptr;
    using GetState = DWORD(WINAPI*)(DWORD, XINPUT_STATE*);
    using GetKey = DWORD(WINAPI*)(DWORD, DWORD, XINPUT_KEYSTROKE*);
    GetState getState = nullptr; GetKey getKey = nullptr;
    std::string commands;
    for (;;) {
        MSG message;
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) DispatchMessageW(&message);
        DWORD count = 0;
        if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &count, nullptr)) break;
        if (count) {
            char buffer[128]; DWORD read = 0;
            ReadFile(GetStdHandle(STD_INPUT_HANDLE), buffer, std::min<DWORD>(count, 128), &read, nullptr);
            commands.append(buffer, read);
            size_t end;
            while ((end = commands.find('\n')) != std::string::npos) {
                const auto command = commands.substr(0, end); commands.erase(0, end + 1);
                if (command == "quit") { DestroyWindow(window); return 0; }
                if (command == "load") {
                    wchar_t location[32768]; GetModuleFileNameW(nullptr, location, 32768);
                    std::wstring path(location); path = path.substr(0, path.find_last_of(L"\\") + 1) + L"xinput1_3.dll";
                    input = LoadLibraryW(path.c_str());
                    getState = reinterpret_cast<GetState>(GetProcAddress(input, "XInputGetState"));
                    getKey = reinterpret_cast<GetKey>(GetProcAddress(input, "XInputGetKeystroke"));
                }
                if (command == "deactivate") {
                    SendMessageW(window, WM_ACTIVATEAPP, FALSE, 0);
                    SendMessageW(window, WM_ACTIVATE, WA_INACTIVE, 0);
                    SendMessageW(window, WM_KILLFOCUS, 0, 0);
                }
                if (command == "foreground") { ShowWindow(window, SW_SHOWNORMAL); SetForegroundWindow(window); }
                if (command == "background") ShowWindow(window, SW_HIDE);
            }
        }
        if (active) ++ticks;
        XINPUT_STATE result{}; XINPUT_KEYSTROKE stroke{};
        const DWORD code = getState ? getState(0, &result) : ERROR_PROC_NOT_FOUND;
        const DWORD absent = getState ? getState(1, &result) : ERROR_PROC_NOT_FOUND;
        const DWORD keyCode = getKey ? getKey(0, 0, &stroke) : ERROR_PROC_NOT_FOUND;
        std::cout << "{\"active\":" << (active ? "true" : "false") << ",\"ticks\":" << ticks
                  << ",\"deactivations\":" << deactivations << ",\"foreground\":" << (GetForegroundWindow() == window ? "true" : "false")
                  << ",\"code\":" << code << ",\"absent\":" << absent << ",\"buttons\":" << result.Gamepad.wButtons
                  << ",\"trigger\":" << static_cast<int>(result.Gamepad.bLeftTrigger) << ",\"axis\":" << result.Gamepad.sThumbLX
                  << ",\"packet\":" << result.dwPacketNumber << ",\"keyCode\":" << keyCode << '}' << std::endl;
        Sleep(100);
    }
}
