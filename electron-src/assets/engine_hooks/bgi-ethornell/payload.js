'use strict';

// Built-in engine hook for BGI / Ethornell (BURIKO General Interpreter).
//
// The engine draws each character into a dialogue text bitmap and then moves that
// bitmap to the screen through a chain of software surface copies, ending in a
// locked Direct3D texture. Nothing about that chain is configured here: the copies
// are recorded as they happen and each glyph's address is followed through them
// until it lands in a locked surface, which yields client pixels.
//
// See docs/BGI_ENGINE_HOOK.md for how each hook was established.

const config = globalThis.__GSM_ENGINE_HOOK_CONFIG__;
if (!config || config.schema !== 'gsm_engine_hook_manifest_v1') {
    throw new Error('The engine-hook manifest was not injected.');
}
if (Process.platform !== config.target.platform || Process.arch !== config.target.architecture) {
    throw new Error(
        `Unsupported target ${Process.platform}/${Process.arch}; expected ` +
            `${config.target.platform}/${config.target.architecture}.`,
    );
}

// Every BGI game renames its executable, so the module is the main image unless a
// package pins a name.
const targetModule = config.target.moduleName
    ? Process.getModuleByName(config.target.moduleName)
    : Process.mainModule;
const moduleEnd = targetModule.base.add(targetModule.size);

// A line is complete once no new glyph position has appeared for this long. Redraws
// of positions already seen do not extend it, because the engine repaints the whole
// line every frame while the typewriter reveal is running.
const LINE_IDLE_MS = 250;
const MAX_GLYPHS = 400;
const MAX_CANDIDATES = 16;
const MAX_CANDIDATE_LENGTH = 400;
const MAX_BITMAP_COPIES = 4096;
const MAX_RECENT_COPIES = 512;
const MAX_CHAIN_DEPTH = 6;
const MAX_SURFACES = 16;
// A frame is at most a couple of thousand rows; further into a lock is a different
// allocation that happens to sit above it in the heap.
const MAX_SURFACE_ROWS = 2048;

const listeners = [];
const surfaces = [];
let candidates = [];
let lastCandidateCaller = null;
let bitmapCopies = [];
const recentCopies = [];
let copySequence = 0;
let run = null;
let sequence = 0;
let lastEmissionFingerprint = '';

function moduleOffset(address) {
    if (address.compare(targetModule.base) < 0 || address.compare(moduleEnd) >= 0) return null;
    return '0x' + address.sub(targetModule.base).toString(16);
}

function findUniqueSignature(label, pattern) {
    const matches = new Map();
    for (const range of Process.enumerateRanges({ protection: 'r-x', coalesce: true })) {
        const rangeEnd = range.base.add(range.size);
        if (range.base.compare(moduleEnd) >= 0 || rangeEnd.compare(targetModule.base) <= 0) continue;
        for (const match of Memory.scanSync(range.base, range.size, pattern)) {
            matches.set(match.address.toString(), match.address);
        }
    }
    if (matches.size !== 1) {
        throw new Error(`${label} signature matched ${matches.size} locations; expected exactly one.`);
    }
    return [...matches.values()][0];
}

// The copy routines share one descriptor ABI and are selected by a dispatcher on the
// pixel format. Reading the dispatcher's call targets discovers the whole family per
// build; their individual prologues are not stable across builds.
function readCopyVariants(dispatcher) {
    const targets = [];
    let cursor = dispatcher;
    const end = dispatcher.add(0x60);
    while (cursor.compare(end) < 0) {
        let instruction;
        try {
            instruction = Instruction.parse(cursor);
        } catch (error) {
            break;
        }
        if (instruction.mnemonic === 'call') {
            const target = ptr(instruction.opStr);
            if (
                target.compare(targetModule.base) >= 0 &&
                target.compare(moduleEnd) < 0 &&
                !targets.some((entry) => entry.equals(target))
            ) {
                targets.push(target);
            }
        }
        cursor = instruction.next;
    }
    if (targets.length < 2) {
        throw new Error(`The copy dispatcher exposed ${targets.length} variants; expected several.`);
    }
    return targets;
}

function readDescriptor(pointer) {
    return {
        pixels: pointer.readU32(),
        stride: pointer.add(4).readS32(),
        width: pointer.add(8).readS32(),
        height: pointer.add(0xc).readS32(),
        bytesPerPixel: pointer.add(0x14).readS32(),
    };
}

function rememberSurface(pixels, pitch) {
    const existing = surfaces.find((surface) => surface.base === pixels);
    if (existing) {
        existing.pitch = pitch;
        return;
    }
    surfaces.push({ base: pixels, pitch });
    if (surfaces.length > MAX_SURFACES) surfaces.shift();
}

function locate(address) {
    let best = null;
    for (const surface of surfaces) {
        const offset = address - surface.base;
        if (offset < 0 || offset >= surface.pitch * MAX_SURFACE_ROWS) continue;
        if (best === null || surface.base > best.base) best = surface;
    }
    if (best === null) return null;
    const offset = address - best.base;
    return { x: (offset % best.pitch) / 4, y: Math.floor(offset / best.pitch) };
}

function mapThroughCopy(address, copy) {
    const delta = address - copy.src;
    if (delta < 0) return null;
    const row = Math.floor(delta / copy.srcStride);
    const column = (delta - row * copy.srcStride) / copy.bytesPerPixel;
    if (!Number.isInteger(column) || column < 0 || column >= copy.width || row >= copy.height) {
        return null;
    }
    return copy.dst + row * copy.dstStride + column * copy.bytesPerPixel;
}

// Dead ends exist — the text bitmap is also copied to a same-size backup — so the
// search explores alternatives instead of taking the first copy that matches.
function follow(address, copies, fromIndex, depth) {
    const located = locate(address);
    if (located) return located;
    if (depth === 0) return null;
    for (let index = fromIndex; index < copies.length; index += 1) {
        const next = mapThroughCopy(address, copies[index]);
        if (next === null) continue;
        const found = follow(next, copies, index + 1, depth - 1);
        if (found) return found;
    }
    return null;
}

function findMainWindow() {
    const enumWindows = new NativeFunction(
        Module.getGlobalExportByName('EnumWindows'),
        'bool',
        ['pointer', 'pointer'],
    );
    const getWindowThreadProcessId = new NativeFunction(
        Module.getGlobalExportByName('GetWindowThreadProcessId'),
        'uint32',
        ['pointer', 'pointer'],
    );
    const isWindowVisible = new NativeFunction(
        Module.getGlobalExportByName('IsWindowVisible'),
        'bool',
        ['pointer'],
    );
    const processIdBuffer = Memory.alloc(4);
    let result = NULL;
    const callback = new NativeCallback(
        (window) => {
            processIdBuffer.writeU32(0);
            getWindowThreadProcessId(window, processIdBuffer);
            if (processIdBuffer.readU32() === Process.id && isWindowVisible(window)) {
                result = window;
                return 0;
            }
            return 1;
        },
        'bool',
        ['pointer', 'pointer'],
    );
    enumWindows(callback, NULL);
    return result;
}

function readClientArea() {
    const window = findMainWindow();
    if (window.isNull()) throw new Error('No visible target window was found.');
    const getClientRect = new NativeFunction(
        Module.getGlobalExportByName('GetClientRect'),
        'bool',
        ['pointer', 'pointer'],
    );
    const clientRect = Memory.alloc(16);
    if (!getClientRect(window, clientRect)) throw new Error('Could not read the target client area.');
    const width = clientRect.add(8).readS32();
    const height = clientRect.add(12).readS32();
    if (width <= 0 || height <= 0) throw new Error(`Invalid target client area ${width}x${height}.`);
    return { kind: 'window-client', clientWidth: width, clientHeight: height };
}

function advance() {
    const window = findMainWindow();
    if (window.isNull()) throw new Error('No visible target window was found.');
    const getForegroundWindow = new NativeFunction(
        Module.getGlobalExportByName('GetForegroundWindow'),
        'pointer',
        [],
    );
    const getWindowThreadProcessId = new NativeFunction(
        Module.getGlobalExportByName('GetWindowThreadProcessId'),
        'uint32',
        ['pointer', 'pointer'],
    );
    const getCurrentThreadId = new NativeFunction(
        Module.getGlobalExportByName('GetCurrentThreadId'),
        'uint32',
        [],
    );
    const attachThreadInput = new NativeFunction(
        Module.getGlobalExportByName('AttachThreadInput'),
        'bool',
        ['uint32', 'uint32', 'bool'],
    );
    const showWindow = new NativeFunction(
        Module.getGlobalExportByName('ShowWindow'),
        'bool',
        ['pointer', 'int32'],
    );
    const bringWindowToTop = new NativeFunction(
        Module.getGlobalExportByName('BringWindowToTop'),
        'bool',
        ['pointer'],
    );
    const setForegroundWindow = new NativeFunction(
        Module.getGlobalExportByName('SetForegroundWindow'),
        'bool',
        ['pointer'],
    );
    const foregroundWindow = getForegroundWindow();
    const currentThread = getCurrentThreadId();
    const foregroundThread = foregroundWindow.isNull()
        ? 0
        : getWindowThreadProcessId(foregroundWindow, NULL);
    const targetThread = getWindowThreadProcessId(window, NULL);
    if (foregroundThread && foregroundThread !== currentThread) {
        attachThreadInput(currentThread, foregroundThread, 1);
    }
    if (targetThread && targetThread !== currentThread) {
        attachThreadInput(currentThread, targetThread, 1);
    }
    showWindow(window, 9);
    bringWindowToTop(window);
    const activated = setForegroundWindow(window);

    return new Promise((resolve) => {
        setTimeout(() => {
            const foregroundAtDelivery = getForegroundWindow().equals(window);
            let delivery;
            let releaseInput;
            if (config.advance.method === 'foreground-click') {
                const getClientRect = new NativeFunction(
                    Module.getGlobalExportByName('GetClientRect'),
                    'bool',
                    ['pointer', 'pointer'],
                );
                const clientToScreen = new NativeFunction(
                    Module.getGlobalExportByName('ClientToScreen'),
                    'bool',
                    ['pointer', 'pointer'],
                );
                const getCursorPos = new NativeFunction(
                    Module.getGlobalExportByName('GetCursorPos'),
                    'bool',
                    ['pointer'],
                );
                const setCursorPos = new NativeFunction(
                    Module.getGlobalExportByName('SetCursorPos'),
                    'bool',
                    ['int32', 'int32'],
                );
                const mouseEvent = new NativeFunction(
                    Module.getGlobalExportByName('mouse_event'),
                    'void',
                    ['uint32', 'uint32', 'uint32', 'uint32', 'pointer'],
                );
                const clientRect = Memory.alloc(16);
                const clickPoint = Memory.alloc(8);
                const previousCursor = Memory.alloc(8);
                getClientRect(window, clientRect);
                const clientWidth = clientRect.add(8).readS32();
                const clientHeight = clientRect.add(12).readS32();
                clickPoint.writeS32(Math.round(clientWidth * config.advance.clientXRatio));
                clickPoint.add(4).writeS32(Math.round(clientHeight * config.advance.clientYRatio));
                clientToScreen(window, clickPoint);
                getCursorPos(previousCursor);
                setCursorPos(clickPoint.readS32(), clickPoint.add(4).readS32());
                mouseEvent(0x0002, 0, 0, 0, NULL);
                releaseInput = () => {
                    mouseEvent(0x0004, 0, 0, 0, NULL);
                    setCursorPos(previousCursor.readS32(), previousCursor.add(4).readS32());
                };
                delivery = 'foreground-click';
            } else {
                const keybdEvent = new NativeFunction(
                    Module.getGlobalExportByName('keybd_event'),
                    'void',
                    ['uint8', 'uint8', 'uint32', 'pointer'],
                );
                keybdEvent(config.advance.virtualKey, config.advance.scanCode, 0, NULL);
                releaseInput = () => {
                    keybdEvent(config.advance.virtualKey, config.advance.scanCode, 2, NULL);
                };
                delivery = 'foreground-keyboard';
            }
            setTimeout(() => {
                releaseInput();
                if (targetThread && targetThread !== currentThread) {
                    attachThreadInput(currentThread, targetThread, 0);
                }
                if (foregroundThread && foregroundThread !== currentThread) {
                    attachThreadInput(currentThread, foregroundThread, 0);
                }
                resolve({
                    window: window.toString(),
                    sequence,
                    delivery,
                    activated,
                    foregroundAtDelivery,
                });
            }, 60);
        }, 50);
    });
}

function startRun(bitmap) {
    run = {
        bitmap: bitmap.pixels,
        stride: bitmap.stride,
        end: bitmap.pixels + bitmap.stride * bitmap.height,
        glyphs: new Map(),
        changedAt: Date.now(),
        resolvedAt: 0,
    };
    bitmapCopies = [];
}

function emitIfSettled() {
    if (run === null || run.glyphs.size === 0) return;
    if (Date.now() - run.changedAt < LINE_IDLE_MS) return;
    // A finished line stays on screen for as long as the reader takes; resolving it
    // again on every tick would burn work for a result that cannot have changed.
    // Only a resolved line is marked, so a line that could not be placed yet — the
    // frame carrying it may not have been composed — is retried.
    if (run.resolvedAt === run.changedAt) return;

    const copies = bitmapCopies.concat(recentCopies).sort((left, right) => left.seq - right.seq);
    const glyphs = [];
    let originX = null;
    let originY = null;
    for (const glyph of run.glyphs.values()) {
        const address = run.bitmap + glyph.y * run.stride + glyph.x * 4;
        const located = follow(address, copies, 0, MAX_CHAIN_DEPTH);
        if (!located) return;
        // Every glyph of a line must resolve through the same frame. A window sliding
        // into place moves the text between frames, and mixing frames would report a
        // line broken across rows that never existed.
        if (originX === null) {
            originX = located.x - glyph.x;
            originY = located.y - glyph.y;
        } else if (located.x - glyph.x !== originX || located.y - glyph.y !== originY) {
            return;
        }
        glyphs.push({
            engineIndex: glyphs.length,
            x: located.x,
            y: located.y,
            width: glyph.width,
            height: glyph.height,
        });
    }

    run.resolvedAt = run.changedAt;
    const fingerprint = glyphs.map((glyph) => `${glyph.x},${glyph.y}`).join('|');
    if (fingerprint === lastEmissionFingerprint) return;

    let coordinateSpace;
    try {
        coordinateSpace = readClientArea();
    } catch (error) {
        send({
            schema: 'gsm_engine_hook_message_v1',
            type: 'diagnostic',
            level: 'error',
            message: `Could not measure the BGI client area: ${error.message}`,
        });
        return;
    }

    lastEmissionFingerprint = fingerprint;
    send({
        schema: 'gsm_engine_hook_message_v1',
        type: 'text-layout',
        integrationId: config.id,
        sequence: ++sequence,
        capturedAt: Date.now(),
        callerOffset: lastCandidateCaller,
        mode: 0,
        style: 0,
        coordinateSpace,
        candidates: candidates.slice(),
        glyphs,
    });
}

const glyphDraw = findUniqueSignature('glyph draw', config.signatures.glyphDraw);
const textCapture = findUniqueSignature('text capture', config.signatures.textCapture);
const copyDispatcher = findUniqueSignature('copy dispatcher', config.signatures.copyDispatcher);
const surfaceLock = findUniqueSignature('surface lock', config.signatures.surfaceLock);
const copyVariants = readCopyVariants(copyDispatcher);

listeners.push(
    Interceptor.attach(surfaceLock, {
        onEnter() {
            this._gsmSurface = this.context.ecx;
        },
        onLeave(result) {
            if (result.toInt32() === 0) return;
            try {
                // The engine stores the locked rectangle in the order Direct3D
                // returns it: pixels first, then pitch.
                const pixels = this._gsmSurface.add(0x18).readU32();
                const pitch = this._gsmSurface.add(0x1c).readS32();
                if (pitch > 0 && pixels !== 0) rememberSurface(pixels, pitch);
            } catch (error) {
                // The surface object can be torn down between entry and exit.
            }
        },
    }),
);

listeners.push(
    Interceptor.attach(textCapture, {
        onEnter() {
            const source = this.context.eax;
            if (source.isNull() || source.toUInt32() < 0x10000) return;
            let text;
            try {
                text = source.readUtf16String(MAX_CANDIDATE_LENGTH);
            } catch (error) {
                return;
            }
            if (!text) return;
            // A new line's strings arrive only after the previous line has finished
            // drawing, so this is also the line boundary.
            if (run !== null && run.glyphs.size > 0) {
                emitIfSettled();
                run = null;
                candidates = [];
            }
            lastCandidateCaller = moduleOffset(this.returnAddress);
            candidates.push(text);
            if (candidates.length > MAX_CANDIDATES) candidates.shift();
        },
    }),
);

listeners.push(
    Interceptor.attach(glyphDraw, {
        onEnter(args) {
            let bitmap;
            let cell;
            try {
                bitmap = readDescriptor(this.context.ecx.add(0x194));
                cell = readDescriptor(args[3]);
            } catch (error) {
                return;
            }
            if (bitmap.pixels === 0 || bitmap.stride <= 0 || bitmap.height <= 0) return;
            if (run === null || run.bitmap !== bitmap.pixels) startRun(bitmap);
            if (run.glyphs.size >= MAX_GLYPHS) return;

            const x = args[1].toInt32();
            const y = args[2].toInt32();
            const key = `${x},${y}`;
            // One glyph is one screen position: the reveal repaints the line every
            // frame, and some builds draw each character twice for outline and fill.
            if (run.glyphs.has(key)) return;
            run.glyphs.set(key, { x, y, width: cell.width, height: cell.height });
            run.changedAt = Date.now();
        },
    }),
);

for (const variant of copyVariants) {
    listeners.push(
        Interceptor.attach(variant, {
            onEnter() {
                let destination;
                let source;
                try {
                    destination = readDescriptor(this.context.ecx);
                    source = readDescriptor(this.context.edx);
                } catch (error) {
                    return;
                }
                if (
                    source.stride <= 0 ||
                    source.bytesPerPixel <= 0 ||
                    source.width <= 0 ||
                    source.height <= 0
                ) {
                    return;
                }
                const copy = {
                    seq: ++copySequence,
                    src: source.pixels,
                    srcStride: source.stride,
                    dst: destination.pixels,
                    dstStride: destination.stride,
                    width: source.width,
                    height: source.height,
                    bytesPerPixel: source.bytesPerPixel,
                };
                // Copies out of the current text bitmap are kept for the whole line:
                // each glyph leaves the bitmap once, when it is revealed, and that
                // copy is what carries it into the chain. Everything else only
                // matters for the frame being composed now.
                if (run !== null && copy.src >= run.bitmap && copy.src < run.end) {
                    if (bitmapCopies.length < MAX_BITMAP_COPIES) bitmapCopies.push(copy);
                    return;
                }
                recentCopies.push(copy);
                if (recentCopies.length > MAX_RECENT_COPIES) recentCopies.shift();
            },
        }),
    );
}

const settleTimer = setInterval(emitIfSettled, 60);

rpc.exports = {
    advance,
    diagnostics() {
        return {
            integrationId: config.id,
            module: targetModule.name,
            moduleBase: targetModule.base.toString(),
            moduleSize: targetModule.size,
            glyphDrawOffset: moduleOffset(glyphDraw),
            textCaptureOffset: moduleOffset(textCapture),
            copyDispatcherOffset: moduleOffset(copyDispatcher),
            surfaceLockOffset: moduleOffset(surfaceLock),
            copyVariantOffsets: copyVariants.map(moduleOffset),
            surfaces: surfaces.length,
            settleTimer: settleTimer !== undefined,
        };
    },
};

send({
    schema: 'gsm_engine_hook_message_v1',
    type: 'ready',
    integrationId: config.id,
    diagnostics: {
        module: targetModule.name,
        moduleBase: targetModule.base.toString(),
        moduleSize: targetModule.size,
        glyphDrawOffset: moduleOffset(glyphDraw),
        textCaptureOffset: moduleOffset(textCapture),
        copyDispatcherOffset: moduleOffset(copyDispatcher),
        surfaceLockOffset: moduleOffset(surfaceLock),
        copyVariantOffsets: copyVariants.map(moduleOffset),
    },
});
