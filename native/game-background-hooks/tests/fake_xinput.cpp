#include <windows.h>
#include <xinput.h>

extern "C" DWORD WINAPI XInputGetState(DWORD player, XINPUT_STATE* state) noexcept {
    if (player != 0) return ERROR_DEVICE_NOT_CONNECTED;
    if (!state) return ERROR_BAD_ARGUMENTS;
    *state = {};
    state->dwPacketNumber = 7;
    state->Gamepad.wButtons = XINPUT_GAMEPAD_A;
    state->Gamepad.bLeftTrigger = 180;
    state->Gamepad.sThumbLX = 12000;
    return ERROR_SUCCESS;
}
extern "C" DWORD WINAPI XInputGetKeystroke(DWORD, DWORD, XINPUT_KEYSTROKE* stroke) noexcept {
    if (!stroke) return ERROR_BAD_ARGUMENTS;
    *stroke = {};
    stroke->VirtualKey = VK_PAD_A;
    stroke->Flags = XINPUT_KEYSTROKE_KEYDOWN;
    return ERROR_SUCCESS;
}
