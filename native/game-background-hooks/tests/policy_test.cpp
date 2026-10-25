#include "policy.h"
#include <cstdlib>
#include <iostream>

static void require(bool value) { if (!value) std::abort(); }

int main() {
    using namespace gsm;
    require(effective_flags(KeepActive | BlockGamepad, 100, 200, true) == 3);
    require(effective_flags(3, 100, 4100, true) == 0);
    require(effective_flags(3, 100, 200, false) == 0);
    require(effective_flags(3, 0xfffffff0u, 16, true) == 3); // Tick wraparound.
    require(suppress_focus_message(0x001c, 0)); // WM_ACTIVATEAPP FALSE
    require(suppress_focus_message(0x0006, 0)); // WM_ACTIVATE WA_INACTIVE
    require(suppress_focus_message(0x0008, 123)); // WM_KILLFOCUS
    require(!suppress_focus_message(0x001c, 1));
    require(!suppress_focus_message(0x0006, 2));
    require(!suppress_focus_message(0x0005, 1)); // Minimization remains real.
    require(!suppress_focus_message(0x0010, 0)); // Closing remains real.
    require(block_gamepad(BlockGamepad, false));
    require(!block_gamepad(BlockGamepad, true));
    require(!block_gamepad(KeepActive, false));
    std::cout << "Policy tests passed\n";
}
