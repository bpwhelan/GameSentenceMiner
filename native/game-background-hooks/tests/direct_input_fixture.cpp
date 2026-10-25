#define DIRECTINPUT_VERSION 0x0800
#include "direct_input_fixture.h"
#include <windows.h>
#include <dinput.h>
#include <iostream>
#include <cstring>

namespace {
void* input = nullptr;
void *controller = nullptr, *keyboard = nullptr, *mouse = nullptr;
HMODULE module = nullptr;
DWORD bytes = sizeof(DIJOYSTATE);
template<typename Fn> Fn method(void* object, size_t index) { return reinterpret_cast<Fn>((*static_cast<void***>(object))[index]); }
using Create = HRESULT(WINAPI*)(HINSTANCE, DWORD, REFIID, void**, IUnknown*);
using CreateDevice = HRESULT(STDMETHODCALLTYPE*)(void*, REFGUID, void**, void*);
using State = HRESULT(STDMETHODCALLTYPE*)(void*, DWORD, void*);
using Data = HRESULT(STDMETHODCALLTYPE*)(void*, DWORD, void*, DWORD*, DWORD);
using Format = HRESULT(STDMETHODCALLTYPE*)(void*, const DIDATAFORMAT*);
using Property = HRESULT(STDMETHODCALLTYPE*)(void*, REFGUID, const DIPROPHEADER*);
}
void direct_input_fixture_command(const std::string& command) {
    if (command == "load-directinput-ansi" || command == "load-directinput-unicode") {
        wchar_t location[32768]; GetModuleFileNameW(nullptr, location, 32768);
        std::wstring path(location); path = path.substr(0, path.find_last_of(L"\\") + 1) + L"dinput8.dll";
        module = LoadLibraryW(path.c_str());
        if (!module) return;
        auto create = reinterpret_cast<Create>(GetProcAddress(module, "DirectInput8Create"));
        if (FAILED(create(GetModuleHandleW(nullptr), 0x0800, command == "load-directinput-ansi" ? IID_IDirectInput8A : IID_IDirectInput8W, &input, nullptr))) return;
        const auto createDevice = method<CreateDevice>(input, 3);
        createDevice(input, GUID_Joystick, &controller, nullptr);
        createDevice(input, GUID_SysKeyboard, &keyboard, nullptr);
        createDevice(input, GUID_SysMouse, &mouse, nullptr);
    }
    if (!controller) return;
    if (command == "di-custom") {
        DIOBJECTDATAFORMAT objects[]{{&GUID_XAxis, 0, DIDFT_ABSAXIS, DIDOI_ASPECTPOSITION},
            {&GUID_Button, 4, DIDFT_PSHBUTTON, 0}, {&GUID_POV, 8, DIDFT_POV, 0}};
        DIDATAFORMAT format{sizeof(DIDATAFORMAT), sizeof(DIOBJECTDATAFORMAT), DIDF_ABSAXIS, 12, 3, objects};
        if (SUCCEEDED(method<Format>(controller, 11)(controller, &format))) bytes = 12;
        DIPROPRANGE range{};
        range.diph = {sizeof(range), sizeof(DIPROPHEADER), 0, DIPH_BYOFFSET}; range.lMin = -100; range.lMax = 100;
        method<Property>(controller, 6)(controller, DIPROP_RANGE, &range.diph);
    }
    if (command == "di-range" || command == "di-signedrange") {
        DIPROPRANGE range{};
        range.diph = {sizeof(range), sizeof(DIPROPHEADER), 0, DIPH_BYOFFSET};
        range.lMin = command == "di-signedrange" ? -32768 : 10;
        range.lMax = command == "di-signedrange" ? 32767 : 110;
        method<Property>(controller, 6)(controller, DIPROP_RANGE, &range.diph);
    }
    if (command == "di-relative") {
        DIPROPDWORD mode{}; mode.diph = {sizeof(mode), sizeof(DIPROPHEADER), 0, DIPH_DEVICE}; mode.dwData = DIPROPAXISMODE_REL;
        method<Property>(controller, 6)(controller, DIPROP_AXISMODE, &mode.diph);
    }
    if (command == "di-lost" || command == "di-restored")
        reinterpret_cast<void(WINAPI*)(void*, BOOL)>(GetProcAddress(module, "GsmTestInputLost"))(controller, command == "di-lost");
    if (command == "di-queue") reinterpret_cast<void(WINAPI*)(void*)>(GetProcAddress(module, "GsmTestQueueInput"))(controller);
}
void print_direct_input_fixture() {
    if (!controller || !keyboard || !mouse) return;
    BYTE state[sizeof(DIJOYSTATE2)]{};
    const HRESULT code = method<State>(controller, 9)(controller, bytes, state);
    LONG x = 0, y = 0; DWORD pov = 0;
    std::memcpy(&x, state, 4); if (bytes == 80) std::memcpy(&y, state + 4, 4);
    std::memcpy(&pov, state + (bytes == 80 ? 32 : 8), 4);
    const BYTE button = state[bytes == 80 ? 48 : 4];
    DWORD unusedPov = MAXDWORD; if (bytes == 80) std::memcpy(&unusedPov, state + 36, 4);
    BYTE keys[256]{}; DIMOUSESTATE2 mouseState{};
    method<State>(keyboard, 9)(keyboard, sizeof(keys), keys);
    method<State>(mouse, 9)(mouse, sizeof(mouseState), &mouseState);
    DIDEVICEOBJECTDATA event{}; DWORD count = 1;
    const HRESULT dataCode = method<Data>(controller, 10)(controller, sizeof(event), &event, &count, DIGDD_PEEK);
    DIDEVICEOBJECTDATA keyboardEvent{}, mouseEvent{}; DWORD keyboardCount = 1, mouseCount = 1;
    method<Data>(keyboard, 10)(keyboard, sizeof(keyboardEvent), &keyboardEvent, &keyboardCount, DIGDD_PEEK);
    method<Data>(mouse, 10)(mouse, sizeof(mouseEvent), &mouseEvent, &mouseCount, DIGDD_PEEK);
    std::cout << "{\"type\":\"directinput\",\"code\":" << code << ",\"bytes\":" << bytes << ",\"x\":" << x
              << ",\"y\":" << y << ",\"pov\":" << pov << ",\"unusedPov\":" << unusedPov << ",\"button\":" << static_cast<int>(button)
              << ",\"keyboard\":" << static_cast<int>(keys[13]) << ",\"mouseX\":" << mouseState.lX
              << ",\"mouseButton\":" << static_cast<int>(mouseState.rgbButtons[0]) << ",\"events\":" << count
              << ",\"dataCode\":" << dataCode << ",\"keyboardEvents\":" << keyboardCount
              << ",\"mouseEvents\":" << mouseCount << "}" << std::endl;
}
void close_direct_input_fixture() {
    using Release = ULONG(STDMETHODCALLTYPE*)(void*);
    for (void* object : {controller, keyboard, mouse, input}) if (object) method<Release>(object, 2)(object);
    controller = keyboard = mouse = input = nullptr;
}
