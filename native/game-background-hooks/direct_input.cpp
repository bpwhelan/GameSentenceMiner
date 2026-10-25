#define DIRECTINPUT_VERSION 0x0800
#include "direct_input.h"
#include <dinput.h>
#include <array>
#include <cstring>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {
using namespace gsm;
DirectInputRuntime runtime{};
constexpr size_t MaxMethods = 16;
constexpr LONG FormatError = 16;
using StateMethod = HRESULT(STDMETHODCALLTYPE*)(void*, DWORD, void*);
using DataMethod = HRESULT(STDMETHODCALLTYPE*)(void*, DWORD, void*, DWORD*, DWORD);
using FormatMethod = HRESULT(STDMETHODCALLTYPE*)(void*, const DIDATAFORMAT*);
using PropertyMethod = HRESULT(STDMETHODCALLTYPE*)(void*, const GUID*, const DIPROPHEADER*);
using GetPropertyMethod = HRESULT(STDMETHODCALLTYPE*)(void*, const GUID*, DIPROPHEADER*);
using InfoMethod = HRESULT(STDMETHODCALLTYPE*)(void*, void*);
using ObjectMethod = HRESULT(STDMETHODCALLTYPE*)(void*, void*, DWORD, DWORD);
using ReleaseMethod = ULONG(STDMETHODCALLTYPE*)(void*);
template<typename Fn> Fn method(void* object, size_t index) { return reinterpret_cast<Fn>((*static_cast<void***>(object))[index]); }

struct Object { DWORD offset, type, flags, value; };
struct Profile { DWORD bytes = 0; std::vector<Object> objects; bool valid = false; };
struct Cache { uint64_t revision = 0; Profile profile; std::vector<Object> format; };
std::unordered_map<void*, Cache> caches;
SRWLOCK cacheLock = SRWLOCK_INIT;
struct ExclusiveLock { ExclusiveLock() { AcquireSRWLockExclusive(&cacheLock); } ~ExclusiveLock() { ReleaseSRWLockExclusive(&cacheLock); } };

bool controller(void* device, bool& unicode) {
    DIDEVICEINSTANCEA ansi{}; ansi.dwSize = sizeof(ansi);
    DWORD type;
    const auto query = method<InfoMethod>(device, 15);
    if (SUCCEEDED(query(device, &ansi))) { type = GET_DIDEVICE_TYPE(ansi.dwDevType); unicode = false; }
    else {
        DIDEVICEINSTANCEW wide{}; wide.dwSize = sizeof(wide);
        if (FAILED(query(device, &wide))) return false;
        type = GET_DIDEVICE_TYPE(wide.dwDevType); unicode = true;
    }
    // Keyboard and mouse share these implementations with controllers.
    constexpr DWORD LegacyJoystickType = 4;
    return type == DI8DEVTYPE_JOYSTICK || type == DI8DEVTYPE_GAMEPAD || type == LegacyJoystickType;
}

Profile neutral_profile(void* device, bool unicode, DWORD bytes) {
    if (!bytes || bytes > 4096) return {};
    uint64_t revision;
    std::vector<Object> format;
    {
        ExclusiveLock lock;
        auto& cache = caches[device];
        if (cache.profile.valid && cache.profile.bytes == bytes) return cache.profile;
        revision = cache.revision; format = cache.format;
    }
    Profile profile; profile.bytes = bytes;
    const auto property = method<GetPropertyMethod>(device, 5);
    const auto info = method<ObjectMethod>(device, 14);
    DIPROPDWORD mode{}; mode.diph = {sizeof(mode), sizeof(DIPROPHEADER), 0, DIPH_DEVICE};
    const bool relative = SUCCEEDED(property(device, &DIPROP_AXISMODE, &mode.diph)) && mode.dwData == DIPROPAXISMODE_REL;
    for (DWORD offset = 0; offset < bytes; ++offset) {
        DWORD type, flags;
        if (unicode) {
            DIDEVICEOBJECTINSTANCEW object{}; object.dwSize = sizeof(object);
            if (FAILED(info(device, &object, offset, DIPH_BYOFFSET))) continue;
            type = DIDFT_GETTYPE(object.dwType); flags = object.dwFlags;
        } else {
            DIDEVICEOBJECTINSTANCEA object{}; object.dwSize = sizeof(object);
            if (FAILED(info(device, &object, offset, DIPH_BYOFFSET))) continue;
            type = DIDFT_GETTYPE(object.dwType); flags = object.dwFlags;
        }
        for (const auto& annotation : format) if (annotation.offset == offset) { flags = annotation.flags; break; }
        // GetObjectInfo's dwOfs can refer to the native device format. Use the
        // queried DIPH_BYOFFSET position in the game's current format instead.
        Object object{offset, type, flags, 0};
        if (type & DIDFT_AXIS) {
            if (bytes < sizeof(LONG) || offset > bytes - sizeof(LONG)) return {};
            const auto aspect = flags & DIDOI_ASPECTMASK;
            const bool relativeAspect = relative || (type & DIDFT_RELAXIS) ||
                (aspect && aspect != DIDOI_ASPECTPOSITION);
            if (!relativeAspect) {
                DIPROPRANGE range{}; range.diph = {sizeof(range), sizeof(DIPROPHEADER), offset, DIPH_BYOFFSET};
                if (FAILED(property(device, &DIPROP_RANGE, &range.diph)) || range.lMin > range.lMax) return {};
                const auto center = (static_cast<int64_t>(range.lMin) + range.lMax) / 2;
                object.value = static_cast<DWORD>(center);
            }
        } else if (type & DIDFT_POV) {
            if (bytes < sizeof(DWORD) || offset > bytes - sizeof(DWORD)) return {};
            object.value = MAXDWORD; // Zero means "up", not a released D-pad.
        } else if (!(type & DIDFT_BUTTON)) continue;
        profile.objects.push_back(object);
    }
    profile.valid = !profile.objects.empty();
    if (profile.valid) {
        ExclusiveLock lock;
        auto& cache = caches[device];
        if (cache.revision != revision) return {};
        cache.profile = profile;
    }
    return profile;
}

template<typename Fn> struct Hooks {
    std::array<Fn, MaxMethods> originals{};
    std::array<void*, MaxMethods> targets{};
    size_t count = 0;
};
Hooks<StateMethod> states;
Hooks<DataMethod> data;
Hooks<FormatMethod> formats;
Hooks<PropertyMethod> properties;
Hooks<ReleaseMethod> releases;

template<size_t Index> HRESULT STDMETHODCALLTYPE state_hook(void* device, DWORD bytes, void* output) {
    const HRESULT code = states.originals[Index](device, bytes, output);
    bool unicode = false;
    if (!controller(device, unicode)) return code;
    InterlockedIncrement(&runtime.state->inputCalls);
    if (FAILED(code) || !output || !block_gamepad(runtime.getFlags(), runtime.isForeground())) return code;
    const auto profile = neutral_profile(device, unicode, bytes);
    if (!profile.valid) { InterlockedOr(&runtime.state->errors, FormatError); return code; }
    auto* buffer = static_cast<BYTE*>(output);
    for (const auto& object : profile.objects) {
        if (object.type & DIDFT_BUTTON) buffer[object.offset] = 0;
        else std::memcpy(buffer + object.offset, &object.value, sizeof(object.value));
    }
    // Leave unmapped bytes intact. Unused POV slots are often already -1 and
    // clearing the whole DIJOYSTATE buffer would manufacture a pressed direction.
    InterlockedIncrement(&runtime.state->blockedCalls);
    return code;
}
template<size_t Index> HRESULT STDMETHODCALLTYPE data_hook(void* device, DWORD stride, void* output, DWORD* count, DWORD flags) {
    const DWORD requested = count ? *count : 0;
    const HRESULT code = data.originals[Index](device, stride, output, count, flags);
    bool unicode = false;
    if (!controller(device, unicode)) return code;
    InterlockedIncrement(&runtime.state->inputCalls);
    if (FAILED(code) || !count || !block_gamepad(runtime.getFlags(), runtime.isForeground())) return code;
    if (output && stride >= sizeof(DIDEVICEOBJECTDATA_DX3) && *count <= requested)
        std::memset(output, 0, static_cast<size_t>(stride) * *count);
    // Also drain DIGDD_PEEK and count-only reads, so background events do not
    // remain queued and replay when the game regains focus.
    DWORD discard = INFINITE;
    data.originals[Index](device, stride, nullptr, &discard, 0);
    *count = 0;
    InterlockedIncrement(&runtime.state->blockedCalls);
    return code;
}
template<size_t Index> HRESULT STDMETHODCALLTYPE format_hook(void* device, const DIDATAFORMAT* format) {
    const HRESULT code = formats.originals[Index](device, format);
    if (SUCCEEDED(code)) {
        ExclusiveLock lock;
        auto& cache = caches[device]; ++cache.revision; cache.profile = {}; cache.format.clear();
        if (format && format->rgodf && format->dwObjSize >= sizeof(DIOBJECTDATAFORMAT) && format->dwNumObjs <= 1024) {
            for (DWORD i = 0; i < format->dwNumObjs; ++i) {
                const auto* object = reinterpret_cast<const DIOBJECTDATAFORMAT*>(
                    reinterpret_cast<const BYTE*>(format->rgodf) + static_cast<size_t>(i) * format->dwObjSize);
                cache.format.push_back({object->dwOfs, DIDFT_GETTYPE(object->dwType), object->dwFlags, 0});
            }
        }
    }
    return code;
}
template<size_t Index> HRESULT STDMETHODCALLTYPE property_hook(void* device, const GUID* property, const DIPROPHEADER* input) {
    const HRESULT code = properties.originals[Index](device, property, input);
    if (SUCCEEDED(code)) { ExclusiveLock lock; auto& cache = caches[device]; ++cache.revision; cache.profile = {}; }
    return code;
}
template<size_t Index> ULONG STDMETHODCALLTYPE release_hook(void* device) {
    const ULONG remaining = releases.originals[Index](device);
    if (!remaining) { ExclusiveLock lock; caches.erase(device); }
    return remaining;
}
template<size_t... I> auto state_callbacks(std::index_sequence<I...>) { return std::array<StateMethod, sizeof...(I)>{state_hook<I>...}; }
template<size_t... I> auto data_callbacks(std::index_sequence<I...>) { return std::array<DataMethod, sizeof...(I)>{data_hook<I>...}; }
template<size_t... I> auto format_callbacks(std::index_sequence<I...>) { return std::array<FormatMethod, sizeof...(I)>{format_hook<I>...}; }
template<size_t... I> auto property_callbacks(std::index_sequence<I...>) { return std::array<PropertyMethod, sizeof...(I)>{property_hook<I>...}; }
template<size_t... I> auto release_callbacks(std::index_sequence<I...>) { return std::array<ReleaseMethod, sizeof...(I)>{release_hook<I>...}; }
const auto stateCallbacks = state_callbacks(std::make_index_sequence<MaxMethods>{});
const auto dataCallbacks = data_callbacks(std::make_index_sequence<MaxMethods>{});
const auto formatCallbacks = format_callbacks(std::make_index_sequence<MaxMethods>{});
const auto propertyCallbacks = property_callbacks(std::make_index_sequence<MaxMethods>{});
const auto releaseCallbacks = release_callbacks(std::make_index_sequence<MaxMethods>{});

template<typename Fn> void install(void* target, Hooks<Fn>& hooks, const std::array<Fn, MaxMethods>& callbacks, bool inputMethod = false) {
    for (size_t i = 0; i < hooks.count; ++i) if (hooks.targets[i] == target) return;
    if (!target || hooks.count >= MaxMethods || !runtime.installHook(target, reinterpret_cast<void*>(callbacks[hooks.count]),
            reinterpret_cast<void**>(&hooks.originals[hooks.count]))) {
        InterlockedOr(&runtime.state->errors, 4); return;
    }
    runtime.pinModule(target); hooks.targets[hooks.count++] = target;
    if (inputMethod) InterlockedIncrement(&runtime.state->inputHooks);
}
void inspect_device(void* device) {
    auto** table = *static_cast<void***>(device);
    install(table[9], states, stateCallbacks, true);
    install(table[10], data, dataCallbacks, true);
    install(table[11], formats, formatCallbacks);
    install(table[6], properties, propertyCallbacks);
    install(table[2], releases, releaseCallbacks);
}
struct Probe { void* input; };
using CreateDevice = HRESULT(STDMETHODCALLTYPE*)(void*, REFGUID, void**, IUnknown*);
void probe_device(Probe& probe, REFGUID guid) {
    void* device = nullptr;
    if (SUCCEEDED(method<CreateDevice>(probe.input, 3)(probe.input, guid, &device, nullptr)) && device) {
        inspect_device(device);
        method<ReleaseMethod>(device, 2)(device);
    }
}
BOOL CALLBACK enum_ansi(const DIDEVICEINSTANCEA* instance, void* context) {
    probe_device(*static_cast<Probe*>(context), instance->guidInstance); return DIENUM_CONTINUE;
}
BOOL CALLBACK enum_unicode(const DIDEVICEINSTANCEW* instance, void* context) {
    probe_device(*static_cast<Probe*>(context), instance->guidInstance); return DIENUM_CONTINUE;
}
}

void gsm::scan_direct_input(const DirectInputRuntime& context) {
    if (!runtime.state) runtime = context;
    HMODULE module = GetModuleHandleW(L"dinput8.dll");
    if (!module) return;
    static DWORD lastScan = GetTickCount() - 2000;
    if (GetTickCount() - lastScan < 2000) return;
    lastScan = GetTickCount();
    using Create = HRESULT(WINAPI*)(HINSTANCE, DWORD, REFIID, void**, IUnknown*);
    using Enumerate = HRESULT(STDMETHODCALLTYPE*)(void*, DWORD, void*, void*, DWORD);
    const auto create = reinterpret_cast<Create>(GetProcAddress(module, "DirectInput8Create"));
    if (!create) return;
    for (bool unicode : {false, true}) {
        Probe probe{};
        if (FAILED(create(GetModuleHandleW(nullptr), DIRECTINPUT_VERSION,
                unicode ? IID_IDirectInput8W : IID_IDirectInput8A, &probe.input, nullptr)) || !probe.input) continue;
        const auto callback = unicode ? reinterpret_cast<void*>(enum_unicode) : reinterpret_cast<void*>(enum_ansi);
        method<Enumerate>(probe.input, 4)(probe.input, DI8DEVCLASS_GAMECTRL, callback, &probe, DIEDFL_ATTACHEDONLY);
        // These methods are shared with already-created game devices. Probing
        // them also works before the first controller is connected. No probe
        // device is acquired, assigned a cooperative window, or asked for input.
        probe_device(probe, GUID_SysKeyboard);
        probe_device(probe, GUID_SysMouse);
        method<ReleaseMethod>(probe.input, 2)(probe.input);
    }
}
