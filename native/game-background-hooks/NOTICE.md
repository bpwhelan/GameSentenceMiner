# GSM game background hooks

The GSM helper and hooks are an original implementation under the repository's
LGPL-3.0-only license. No Special K implementation code is included.

Research references:

- [Special K window management](https://github.com/SpecialKO/SpecialK/blob/main/src/window.cpp)
- [Special K XInput management](https://github.com/SpecialKO/SpecialK/blob/main/src/input/xinput_core.cpp)
- [Microsoft XInputGetState documentation](https://learn.microsoft.com/en-us/windows/win32/api/xinput/nf-xinput-xinputgetstate)

`third_party/minhook` contains the unmodified include and src directories and
license from [MinHook v1.3.4](https://github.com/TsudaKageyu/minhook/tree/v1.3.4).
MinHook uses the BSD 2-Clause license; its bundled disassemblers have their own
BSD notices. Full notices are in `third_party/minhook/LICENSE.txt` and the source.
Upstream archive SHA-256:
`172708123daa0c98d20d3a980b16a50be14af243dc95dee6f79c24193ad010e4`.
