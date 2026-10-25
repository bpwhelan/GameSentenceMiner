#pragma once
#include "protocol.h"

namespace gsm {
struct DirectInputRuntime {
    SharedState* state;
    uint32_t (*getFlags)();
    bool (*isForeground)();
    bool (*installHook)(void*, void*, void**);
    void (*pinModule)(void*);
};
void scan_direct_input(const DirectInputRuntime& runtime);
}
