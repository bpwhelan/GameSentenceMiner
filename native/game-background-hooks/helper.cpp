#include "protocol.h"
#include <tlhelp32.h>
#include <algorithm>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <vector>

using namespace gsm;
struct Handle {
    HANDLE value = nullptr;
    explicit Handle(HANDLE h = nullptr) : value(h) {}
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    operator HANDLE() const { return value; }
};
std::string utf8(const std::wstring& text) {
    if (text.empty()) return {};
    const int size = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    std::string out(size, 0);
    WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), size, nullptr, nullptr);
    return out;
}
std::string json(const std::wstring& text) {
    std::string out = "\"";
    for (unsigned char c : utf8(text)) {
        if (c == '"' || c == '\\') { out += '\\'; out += c; }
        else if (c < 32) { char escape[7]; sprintf_s(escape, "\\u%04x", c); out += escape; }
        else out += c;
    }
    return out + '"';
}
std::wstring lower(std::wstring text) { std::transform(text.begin(), text.end(), text.begin(), towlower); return text; }
std::wstring filename(const std::wstring& text) { return text.substr(text.find_last_of(L"\\/") + 1); }
std::wstring process_path(HANDLE process) {
    std::wstring path(32768, 0);
    DWORD size = static_cast<DWORD>(path.size());
    if (!QueryFullProcessImageNameW(process, 0, path.data(), &size)) throw std::runtime_error("Cannot read the target executable path");
    path.resize(size);
    return path;
}
std::string architecture(HANDLE process) {
    using Query = BOOL(WINAPI*)(HANDLE, USHORT*, USHORT*);
    auto query = reinterpret_cast<Query>(GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "IsWow64Process2"));
    USHORT machine = 0, native = 0;
    if (!query || !query(process, &machine, &native)) throw std::runtime_error("Cannot determine target architecture (Windows 10 or newer required)");
    const auto effective = machine ? machine : native;
    if (effective == IMAGE_FILE_MACHINE_I386) return "x86";
    if (effective == IMAGE_FILE_MACHINE_AMD64) return "x64";
    return "unsupported";
}
std::vector<MODULEENTRY32W> modules(DWORD pid) {
    HANDLE raw = INVALID_HANDLE_VALUE;
    for (int retry = 0; retry < 5; ++retry) {
        raw = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
        if (raw != INVALID_HANDLE_VALUE || GetLastError() != ERROR_BAD_LENGTH) break;
        Sleep(10);
    }
    Handle snapshot(raw);
    if (raw == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot inspect target modules");
    MODULEENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    std::vector<MODULEENTRY32W> out;
    if (!Module32FirstW(snapshot, &entry)) throw std::runtime_error("Cannot inspect target modules");
    do { out.push_back(entry); } while (Module32NextW(snapshot, &entry));
    return out;
}
bool special_k(const std::vector<MODULEENTRY32W>& loaded) {
    for (const auto& module : loaded) {
        const auto name = lower(module.szModule);
        if (name.find(L"specialk") != std::wstring::npos) return true;
        // Special K can be renamed to dxgi.dll, dinput8.dll, and other proxies.
        if (name != L"dxgi.dll" && name != L"d3d11.dll" && name != L"d3d9.dll" && name != L"d3d8.dll" &&
            name != L"ddraw.dll" && name != L"dinput8.dll" && name != L"opengl32.dll" && name.find(L"xinput") != 0) continue;
        DWORD ignored = 0;
        const DWORD size = GetFileVersionInfoSizeW(module.szExePath, &ignored);
        if (!size || size > 1024 * 1024) continue;
        std::vector<BYTE> info(size);
        if (!GetFileVersionInfoW(module.szExePath, 0, size, info.data())) continue;
        struct Language { WORD language, codepage; };
        Language* languages = nullptr;
        UINT bytes = 0;
        if (!VerQueryValueW(info.data(), L"\\VarFileInfo\\Translation", reinterpret_cast<void**>(&languages), &bytes)) continue;
        for (UINT i = 0; i < bytes / sizeof(Language); ++i) for (const auto* field : {L"ProductName", L"FileDescription"}) {
            wchar_t key[128];
            swprintf_s(key, L"\\StringFileInfo\\%04x%04x\\%s", languages[i].language, languages[i].codepage, field);
            wchar_t* value = nullptr;
            UINT length = 0;
            if (VerQueryValueW(info.data(), key, reinterpret_cast<void**>(&value), &length) && value &&
                lower(value).find(L"special k") != std::wstring::npos) return true;
        }
    }
    return false;
}

struct Probe { std::wstring executable; bool first = true; };
BOOL CALLBACK probe_window(HWND window, LPARAM parameter) {
    auto& probe = *reinterpret_cast<Probe*>(parameter);
    if (!IsWindowVisible(window) || GetWindow(window, GW_OWNER)) return TRUE;
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
    if (!process.value) return TRUE;
    try {
        const auto path = process_path(process);
        if (lower(filename(path)) != lower(probe.executable)) return TRUE;
        wchar_t title[2048]{};
        GetWindowTextW(window, title, 2048);
        const auto arch = architecture(process);
        const bool conflict = special_k(modules(pid));
        if (!probe.first) std::cout << ',';
        probe.first = false;
        std::cout << "{\"pid\":" << pid << ",\"hwnd\":\"" << reinterpret_cast<uintptr_t>(window)
                  << "\",\"path\":" << json(path) << ",\"title\":" << json(title)
                  << ",\"arch\":\"" << arch << "\",\"specialK\":" << (conflict ? "true" : "false") << '}';
    } catch (...) { /* Inaccessible windows are not eligible targets. */ }
    return TRUE;
}
std::wstring arg(int argc, wchar_t** argv, const wchar_t* key) {
    for (int i = 1; i + 1 < argc; ++i) if (wcscmp(argv[i], key) == 0) return argv[i + 1];
    throw std::runtime_error("Missing required argument");
}
DWORD number(const std::wstring& text) {
    size_t used = 0;
    unsigned long long result = std::stoull(text, &used, 10);
    if (used != text.size() || result > MAXDWORD || !result) throw std::runtime_error("Invalid process or window identifier");
    return static_cast<DWORD>(result);
}
void inject(HANDLE process, DWORD pid, const std::vector<MODULEENTRY32W>& loaded) {
    wchar_t self[32768];
    const DWORD length = GetModuleFileNameW(nullptr, self, 32768);
    if (!length || length >= 32768) throw std::runtime_error("Cannot resolve helper location");
    std::wstring dll(self, length);
    dll = dll.substr(0, dll.find_last_of(L"\\/") + 1) + L"gsm-game-background.dll";
    for (const auto& module : loaded) if (lower(module.szModule) == L"gsm-game-background.dll") {
        if (lower(module.szExePath) != lower(dll)) throw std::runtime_error("Another GSM hook build is loaded; restart the game first");
        return;
    }
    if (GetFileAttributesW(dll.c_str()) == INVALID_FILE_ATTRIBUTES) throw std::runtime_error("The matching GSM hook DLL is missing");
    auto load = GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW");
    HMODULE owner = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           reinterpret_cast<LPCWSTR>(load), &owner)) throw std::runtime_error("Cannot locate Windows loader");
    wchar_t ownerPath[32768];
    GetModuleFileNameW(owner, ownerPath, 32768);
    uintptr_t remoteLoader = 0;
    for (const auto& module : loaded) if (lower(module.szModule) == lower(filename(ownerPath)))
        remoteLoader = reinterpret_cast<uintptr_t>(module.modBaseAddr) + reinterpret_cast<uintptr_t>(load) - reinterpret_cast<uintptr_t>(owner);
    if (!remoteLoader) throw std::runtime_error("Cannot locate the loader in the target process");
    const size_t bytes = (dll.size() + 1) * sizeof(wchar_t);
    void* remote = VirtualAllocEx(process, nullptr, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote) throw std::runtime_error("Could not allocate the DLL path in the target");
    SIZE_T written = 0;
    if (!WriteProcessMemory(process, remote, dll.c_str(), bytes, &written) || written != bytes) {
        VirtualFreeEx(process, remote, 0, MEM_RELEASE);
        throw std::runtime_error("Could not send the DLL path to the target");
    }
    Handle thread(CreateRemoteThread(process, nullptr, 0, reinterpret_cast<LPTHREAD_START_ROUTINE>(remoteLoader), remote, 0, nullptr));
    if (!thread.value) {
        VirtualFreeEx(process, remote, 0, MEM_RELEASE);
        throw std::runtime_error("Windows refused injection into the target");
    }
    if (WaitForSingleObject(thread, 10000) != WAIT_OBJECT_0) {
        // The loader might still read this allocation; do not free it on timeout.
        throw std::runtime_error("The game did not finish loading the helper within 10 seconds");
    }
    VirtualFreeEx(process, remote, 0, MEM_RELEASE);
    // A 64-bit HMODULE is truncated by GetExitCodeThread, so verify the module list.
    for (const auto& module : modules(pid)) if (lower(module.szExePath) == lower(dll)) return;
    throw std::runtime_error("The game did not load the hook DLL");
}
void status(SharedState* state, const char* type) {
    std::cout << "{\"type\":\"" << type << "\",\"effective\":" << read(state->effective)
              << ",\"focusHooks\":" << read(state->focusHooks) << ",\"windowHooks\":" << read(state->windowHooks)
              << ",\"inputHooks\":" << read(state->inputHooks) << ",\"errors\":" << read(state->errors)
              << ",\"focusEvents\":" << read(state->focusEvents) << ",\"inputCalls\":" << read(state->inputCalls)
              << ",\"blockedCalls\":" << read(state->blockedCalls) << ",\"foreground\":" << (read(state->foreground) ? "true" : "false")
              << "}" << std::endl;
}
int attach(int argc, wchar_t** argv) {
    DWORD pid = number(arg(argc, argv, L"--pid"));
    HWND window = reinterpret_cast<HWND>(static_cast<uintptr_t>(number(arg(argc, argv, L"--hwnd"))));
    DWORD windowPid = 0;
    GetWindowThreadProcessId(window, &windowPid);
    if (pid == GetCurrentProcessId() || windowPid != pid) throw std::runtime_error("Target window no longer belongs to the selected process");
    Handle process(OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_CREATE_THREAD |
                               PROCESS_VM_WRITE | PROCESS_VM_OPERATION | SYNCHRONIZE, FALSE, pid));
    if (!process.value) throw std::runtime_error("Cannot open this game for injection; check that GSM and the game run at the same privilege level");
    if (lower(process_path(process)) != lower(arg(argc, argv, L"--path"))) throw std::runtime_error("Target executable changed; select the game again");
    const std::string requiredArch = sizeof(void*) == 8 ? "x64" : "x86";
    if (architecture(process) != requiredArch) throw std::runtime_error("Helper and game architectures do not match");
    auto loaded = modules(pid);
    if (special_k(loaded)) throw std::runtime_error("Special K is already loaded; restart the game without Special K for this experiment");
    const auto name = mapping_name(pid);
    Handle mutex(CreateMutexW(nullptr, FALSE, (name + L".Controller").c_str()));
    const DWORD acquired = mutex.value ? WaitForSingleObject(mutex, 0) : WAIT_FAILED;
    if (acquired != WAIT_OBJECT_0 && acquired != WAIT_ABANDONED) throw std::runtime_error("Another GSM controller owns this game");
    Handle mapping(CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(SharedState), name.c_str()));
    const bool existed = GetLastError() == ERROR_ALREADY_EXISTS;
    if (!mapping.value) throw std::runtime_error("Cannot create game control state");
    auto state = static_cast<SharedState*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(SharedState)));
    if (!state) throw std::runtime_error("Cannot map game control state");
    struct Cleanup {
        SharedState* state;
        ~Cleanup() { InterlockedExchange(&state->requested, 0); UnmapViewOfFile(state); }
    } cleanup{state};
    if (existed && (state->version != ProtocolVersion || state->processId != static_cast<LONG>(pid)))
        throw std::runtime_error("Incompatible game hook protocol; restart the game");
    state->version = ProtocolVersion;
    state->processId = pid;
    InterlockedExchange(&state->requested, 0);
    InterlockedExchange(&state->windowHandle, static_cast<LONG>(reinterpret_cast<uintptr_t>(window)));
    InterlockedExchange(&state->heartbeat, GetTickCount());
    inject(process, pid, loaded);
    const DWORD started = GetTickCount();
    while (!read(state->ready) && GetTickCount() - started < 5000) Sleep(20);
    if (!read(state->ready)) throw std::runtime_error("The injected DLL did not become ready");
    const auto keep = arg(argc, argv, L"--keep-active"), block = arg(argc, argv, L"--block-gamepad");
    if ((keep != L"0" && keep != L"1") || (block != L"0" && block != L"1")) throw std::runtime_error("Invalid hook options");
    InterlockedExchange(&state->requested, (keep == L"1" ? KeepActive : 0) | (block == L"1" ? BlockGamepad : 0));
    std::string input;
    DWORD reported = 0, inspected = GetTickCount();
    bool stop = false;
    status(state, "ready");
    while (!stop && WaitForSingleObject(process, 0) == WAIT_TIMEOUT && IsWindow(window)) {
        InterlockedExchange(&state->heartbeat, GetTickCount());
        DWORD available = 0;
        if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr)) break;
        if (available) {
            char buffer[256]; DWORD count = 0;
            if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), buffer, std::min<DWORD>(available, sizeof(buffer)), &count, nullptr) || !count) break;
            input.append(buffer, count);
            if (input.size() > 4096) throw std::runtime_error("Invalid controller command");
            size_t end;
            while ((end = input.find('\n')) != std::string::npos) {
                const auto command = input.substr(0, end);
                input.erase(0, end + 1);
                if (command == "stop" || command == "stop\r") { stop = true; break; }
                std::istringstream parser(command);
                std::string verb, extra; int active = -1, blockInput = -1;
                if (!(parser >> verb >> active >> blockInput) || verb != "configure" || (parser >> extra) ||
                    (active != 0 && active != 1) || (blockInput != 0 && blockInput != 1)) throw std::runtime_error("Invalid controller command");
                InterlockedExchange(&state->requested, (active ? KeepActive : 0) | (blockInput ? BlockGamepad : 0));
            }
        }
        if (GetTickCount() - reported >= 1000) { status(state, "status"); reported = GetTickCount(); }
        if (GetTickCount() - inspected >= 5000) {
            inspected = GetTickCount();
            if (special_k(modules(pid))) throw std::runtime_error("Special K loaded after GSM; GSM hooks have been disabled");
        }
        Sleep(50);
    }
    InterlockedExchange(&state->requested, 0);
    for (int i = 0; i < 30 && read(state->effective); ++i) Sleep(50);
    status(state, "stopped");
    return 0;
}
int wmain(int argc, wchar_t** argv) {
    try {
        if (argc > 1 && wcscmp(argv[1], L"--probe") == 0) {
            Probe probe{arg(argc, argv, L"--exe")};
            std::cout << '[';
            EnumWindows(probe_window, reinterpret_cast<LPARAM>(&probe));
            std::cout << "]" << std::endl;
            return 0;
        }
        if (argc > 1 && wcscmp(argv[1], L"--status") == 0) {
            const DWORD pid = number(arg(argc, argv, L"--pid"));
            Handle mapping(OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, mapping_name(pid).c_str()));
            if (!mapping.value) throw std::runtime_error("No GSM background hook is loaded in this process");
            auto state = static_cast<SharedState*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(SharedState)));
            if (!state) throw std::runtime_error("Cannot read game control state");
            status(state, "status");
            UnmapViewOfFile(state);
            return 0;
        }
        if (argc > 1 && wcscmp(argv[1], L"--attach") == 0) return attach(argc, argv);
        throw std::runtime_error("Usage: --probe --exe NAME or --attach --pid PID --hwnd HWND --path EXE --keep-active 0|1 --block-gamepad 0|1");
    } catch (const std::exception& error) {
        const auto message = std::string(error.what());
        std::cout << "{\"type\":\"error\",\"message\":" << json(std::wstring(message.begin(), message.end())) << "}" << std::endl;
        return 1;
    }
}
