#define DIRECTINPUT_VERSION 0x0800
#include <windows.h>
#include <dinput.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <vector>

namespace {
struct Device {
    void** table;
    LONG references = 1;
    DWORD type;
    bool unicode, lost = false;
    DWORD bytes = sizeof(DIJOYSTATE), axisMode = DIPROPAXISMODE_ABS, queued = 1;
    LONG minimum = 0, maximum = 65535;
    std::vector<DIOBJECTDATAFORMAT> objects;
};
struct Input { void** table; LONG references = 1; bool unicode; };
std::array<void*, 32> deviceTable{};
std::array<void*, 12> inputTable{};
GUID device_guid(DWORD type) { return type == DI8DEVTYPE_KEYBOARD ? GUID_SysKeyboard : type == DI8DEVTYPE_MOUSE ? GUID_SysMouse : GUID_Joystick; }
ULONG STDMETHODCALLTYPE device_release(Device* device) {
    const auto refs = InterlockedDecrement(&device->references);
    if (!refs) delete device;
    return refs;
}
ULONG STDMETHODCALLTYPE input_release(Input* input) {
    const auto refs = InterlockedDecrement(&input->references);
    if (!refs) delete input;
    return refs;
}
HRESULT STDMETHODCALLTYPE device_info(Device* device, void* output) {
    if (!output) return E_POINTER;
    const auto size = *static_cast<DWORD*>(output);
    if (size != (device->unicode ? sizeof(DIDEVICEINSTANCEW) : sizeof(DIDEVICEINSTANCEA))) return DIERR_INVALIDPARAM;
    if (device->unicode) {
        auto& info = *static_cast<DIDEVICEINSTANCEW*>(output);
        info.guidInstance = device_guid(device->type); info.dwDevType = device->type;
    } else {
        auto& info = *static_cast<DIDEVICEINSTANCEA*>(output);
        info.guidInstance = device_guid(device->type); info.dwDevType = device->type;
    }
    return DI_OK;
}
HRESULT STDMETHODCALLTYPE object_info(Device* device, void* output, DWORD offset, DWORD how) {
    if (!output || how != DIPH_BYOFFSET) return DIERR_INVALIDPARAM;
    if (*static_cast<DWORD*>(output) != (device->unicode ? sizeof(DIDEVICEOBJECTINSTANCEW) : sizeof(DIDEVICEOBJECTINSTANCEA)))
        return DIERR_INVALIDPARAM;
    for (const auto& object : device->objects) if (object.dwOfs == offset) {
        // Native object offsets need not equal offsets in the game's data format.
        const DWORD nativeOffset = (object.dwType & DIDFT_POV) ? 20 : (object.dwType & DIDFT_BUTTON) ? 24 :
            offset == 0 ? 4 : offset == 4 ? 0 : offset;
        if (device->unicode) {
            auto& info = *static_cast<DIDEVICEOBJECTINSTANCEW*>(output);
            info.dwOfs = nativeOffset; info.dwType = object.dwType; info.dwFlags = object.dwFlags;
        } else {
            auto& info = *static_cast<DIDEVICEOBJECTINSTANCEA*>(output);
            info.dwOfs = nativeOffset; info.dwType = object.dwType; info.dwFlags = object.dwFlags;
        }
        return DI_OK;
    }
    return DIERR_OBJECTNOTFOUND;
}
HRESULT STDMETHODCALLTYPE get_property(Device* device, const GUID* property, DIPROPHEADER* output) {
    if (property == &DIPROP_AXISMODE && output && output->dwSize == sizeof(DIPROPDWORD)) {
        reinterpret_cast<DIPROPDWORD*>(output)->dwData = device->axisMode;
        return DI_OK;
    }
    if (property == &DIPROP_RANGE && output && output->dwSize == sizeof(DIPROPRANGE)) {
        if (output->dwHow != DIPH_BYOFFSET) return DIERR_INVALIDPARAM;
        for (const auto& object : device->objects) if (object.dwOfs == output->dwObj && (object.dwType & DIDFT_AXIS)) {
            auto* range = reinterpret_cast<DIPROPRANGE*>(output);
            range->lMin = device->minimum; range->lMax = device->maximum;
            return DI_OK;
        }
        return DIERR_OBJECTNOTFOUND;
    }
    return DIERR_UNSUPPORTED;
}
HRESULT STDMETHODCALLTYPE set_property(Device* device, const GUID* property, const DIPROPHEADER* input) {
    if (property == &DIPROP_RANGE && input && input->dwSize == sizeof(DIPROPRANGE)) {
        const auto* range = reinterpret_cast<const DIPROPRANGE*>(input);
        device->minimum = range->lMin; device->maximum = range->lMax;
        return DI_OK;
    }
    if (property == &DIPROP_AXISMODE && input && input->dwSize == sizeof(DIPROPDWORD)) {
        device->axisMode = reinterpret_cast<const DIPROPDWORD*>(input)->dwData;
        return DI_OK;
    }
    return DIERR_UNSUPPORTED;
}
HRESULT STDMETHODCALLTYPE set_format(Device* device, const DIDATAFORMAT* format) {
    if (!format || format->dwSize != sizeof(DIDATAFORMAT) || format->dwObjSize != sizeof(DIOBJECTDATAFORMAT)) return DIERR_INVALIDPARAM;
    device->bytes = format->dwDataSize;
    device->objects.assign(format->rgodf, format->rgodf + format->dwNumObjs);
    device->axisMode = format->dwFlags == DIDF_RELAXIS ? DIPROPAXISMODE_REL : DIPROPAXISMODE_ABS;
    return DI_OK;
}
HRESULT STDMETHODCALLTYPE get_state(Device* device, DWORD bytes, void* output) {
    if (device->lost) return DIERR_INPUTLOST;
    if (!output || bytes != device->bytes) return DIERR_INVALIDPARAM;
    std::memset(output, 0, bytes);
    auto* data = static_cast<BYTE*>(output);
    if (device->type == DI8DEVTYPE_KEYBOARD) data[13] = 0x80;
    else if (device->type == DI8DEVTYPE_MOUSE) { reinterpret_cast<DIMOUSESTATE2*>(output)->lX = 11; data[12] = 0x80; }
    else {
        if (bytes == sizeof(DIJOYSTATE)) for (auto& pov : reinterpret_cast<DIJOYSTATE*>(output)->rgdwPOV) pov = MAXDWORD;
        for (const auto& object : device->objects) {
            const DWORD type = DIDFT_GETTYPE(object.dwType);
            if (type & DIDFT_AXIS) {
                const LONG value = DIDFT_GETINSTANCE(object.dwType) % 2 ? device->minimum : device->maximum;
                std::memcpy(data + object.dwOfs, &value, sizeof(value));
            } else if (type & DIDFT_POV) { const DWORD value = 9000; std::memcpy(data + object.dwOfs, &value, sizeof(value)); }
            else if (type & DIDFT_BUTTON) data[object.dwOfs] = 0x80;
        }
    }
    return DI_OK;
}
HRESULT STDMETHODCALLTYPE get_data(Device* device, DWORD stride, void* output, DWORD* count, DWORD flags) {
    if (device->lost) return DIERR_INPUTLOST;
    if (!count || stride < sizeof(DIDEVICEOBJECTDATA_DX3)) return DIERR_INVALIDPARAM;
    const DWORD amount = std::min(*count, device->queued);
    if (output && amount) {
        std::memset(output, 0, stride);
        auto* event = static_cast<DIDEVICEOBJECTDATA_DX3*>(output);
        event->dwOfs = 48; event->dwData = 0x80;
    }
    *count = amount;
    if (!(flags & DIGDD_PEEK)) device->queued -= amount;
    return DI_OK;
}
HRESULT STDMETHODCALLTYPE create_device(Input* input, const GUID* guid, void** output, void*) {
    if (!guid || !output) return E_POINTER;
    auto* device = new Device{};
    device->table = deviceTable.data(); device->unicode = input->unicode;
    device->type = IsEqualGUID(*guid, GUID_SysKeyboard) ? DI8DEVTYPE_KEYBOARD : IsEqualGUID(*guid, GUID_SysMouse) ? DI8DEVTYPE_MOUSE : DI8DEVTYPE_GAMEPAD;
    if (device->type == DI8DEVTYPE_KEYBOARD) device->bytes = 256;
    else if (device->type == DI8DEVTYPE_MOUSE) device->bytes = sizeof(DIMOUSESTATE2);
    else device->objects = {{&GUID_XAxis, 0, DIDFT_ABSAXIS, DIDOI_ASPECTPOSITION},
        {&GUID_YAxis, 4, DIDFT_ABSAXIS | DIDFT_MAKEINSTANCE(1), DIDOI_ASPECTPOSITION},
        {&GUID_POV, 32, DIDFT_POV, 0}, {&GUID_Button, 48, DIDFT_PSHBUTTON, 0}};
    *output = device;
    return DI_OK;
}
HRESULT STDMETHODCALLTYPE enum_devices(Input* input, DWORD, void* callback, void* context, DWORD) {
    if (input->unicode) {
        DIDEVICEINSTANCEW info{}; info.dwSize = sizeof(info); info.guidInstance = GUID_Joystick; info.dwDevType = DI8DEVTYPE_GAMEPAD;
        reinterpret_cast<LPDIENUMDEVICESCALLBACKW>(callback)(&info, context);
    } else {
        DIDEVICEINSTANCEA info{}; info.dwSize = sizeof(info); info.guidInstance = GUID_Joystick; info.dwDevType = DI8DEVTYPE_GAMEPAD;
        reinterpret_cast<LPDIENUMDEVICESCALLBACKA>(callback)(&info, context);
    }
    return DI_OK;
}
}
extern "C" HRESULT WINAPI DirectInput8Create(HINSTANCE, DWORD, REFIID iid, void** output, IUnknown*) {
    if (!output) return E_POINTER;
    deviceTable[2] = reinterpret_cast<void*>(device_release);
    deviceTable[5] = reinterpret_cast<void*>(get_property); deviceTable[6] = reinterpret_cast<void*>(set_property);
    deviceTable[9] = reinterpret_cast<void*>(get_state); deviceTable[10] = reinterpret_cast<void*>(get_data);
    deviceTable[11] = reinterpret_cast<void*>(set_format); deviceTable[14] = reinterpret_cast<void*>(object_info);
    deviceTable[15] = reinterpret_cast<void*>(device_info);
    inputTable[2] = reinterpret_cast<void*>(input_release); inputTable[3] = reinterpret_cast<void*>(create_device);
    inputTable[4] = reinterpret_cast<void*>(enum_devices);
    auto* input = new Input{}; input->table = inputTable.data(); input->unicode = IsEqualGUID(iid, IID_IDirectInput8W);
    *output = input;
    return DI_OK;
}
extern "C" void WINAPI GsmTestInputLost(void* object, BOOL lost) { static_cast<Device*>(object)->lost = lost != FALSE; }
extern "C" void WINAPI GsmTestQueueInput(void* object) { static_cast<Device*>(object)->queued = 1; }
