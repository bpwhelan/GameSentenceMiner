'use strict';

// This payload is loaded directly by GSM's engine-hook service. It deliberately
// has no dependency on Agent or Agent scripts.
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

const targetModule = Process.getModuleByName(config.target.moduleName);
const moduleEnd = targetModule.base.add(targetModule.size);
const activeBuilds = new Map();
const listeners = [];
let sequence = 0;
let lastEmissionFingerprint = '';

function rva(value) {
    return targetModule.base.add(value);
}

function moduleOffset(address) {
    if (address.compare(targetModule.base) < 0 || address.compare(moduleEnd) >= 0) return null;
    return address.sub(targetModule.base).toString();
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

function readLayout() {
    const count = rva(config.memory.codeCountRva).readU32();
    if (count === 0 || count > config.memory.maximumCodes) {
        throw new Error(`Invalid MAGES layout size ${count}.`);
    }
    const codes = rva(config.memory.codesRva);
    const metrics = rva(config.memory.metricsRva);
    const positions = rva(config.memory.positionsRva);
    const entries = [];
    for (let index = 0; index < count; index += 1) {
        const metric = metrics.add(index * config.memory.metricStride);
        const position = positions.add(index * config.memory.positionStride);
        entries.push({
            engineIndex: index,
            code: codes.add(index * 2).readU16(),
            x: position.readS32(),
            y: position.add(4).readS32(),
            width: metric.add(8).readU32(),
            height: metric.add(12).readU32(),
        });
    }
    return entries;
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
    const callback = new NativeCallback((window, _parameter) => {
        processIdBuffer.writeU32(0);
        getWindowThreadProcessId(window, processIdBuffer);
        if (processIdBuffer.readU32() === Process.id && isWindowVisible(window)) {
            result = window;
            return 0;
        }
        return 1;
    }, 'bool', ['pointer', 'pointer']);
    enumWindows(callback, NULL);
    return result;
}

function readCoordinateSpace() {
    const window = findMainWindow();
    if (window.isNull()) throw new Error('No visible target window was found for coordinate scaling.');
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
    const scaleX = rva(config.coordinateSpace.scaleXRva).readFloat();
    const scaleY = rva(config.coordinateSpace.scaleYRva).readFloat();
    if (
        !Number.isFinite(scaleX) ||
        !Number.isFinite(scaleY) ||
        scaleX <= 0 ||
        scaleY <= 0 ||
        scaleX > 16 ||
        scaleY > 16
    ) {
        throw new Error(`Invalid MAGES render scale ${scaleX}x${scaleY}.`);
    }
    return {
        kind: 'scaled-window-client',
        clientWidth: width,
        clientHeight: height,
        scaleX,
        scaleY,
    };
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

const textBuilder = findUniqueSignature('text builder', config.signatures.textBuilder);
const lineLayout = findUniqueSignature('line layout', config.signatures.lineLayout);

listeners.push(
    Interceptor.attach(textBuilder, {
        onEnter(args) {
            const threadId = Process.getCurrentThreadId();
            activeBuilds.delete(threadId);
            const mode = args[1].toUInt32();
            if (!config.capture.acceptedModes.includes(mode)) return;
            const build = {
                sequence: ++sequence,
                threadId,
                source: args[0].toString(),
                mode,
                style: args[2].toUInt32(),
                callerOffset: moduleOffset(this.returnAddress),
            };
            activeBuilds.set(threadId, build);
        },
        onLeave() {
            const build = activeBuilds.get(Process.getCurrentThreadId());
            if (build) build.codeCount = rva(config.memory.codeCountRva).readU32();
        },
    }),
);

listeners.push(
    Interceptor.attach(lineLayout, {
        onEnter(args) {
            this._gsmThreadId = Process.getCurrentThreadId();
            this._gsmBuild = activeBuilds.get(this._gsmThreadId);
            if (!this._gsmBuild) return;
            this._gsmStyle = args[0].toUInt32();
            this._gsmGlyphStart = args[3].toUInt32();
            this._gsmGlyphEnd = args[4].toUInt32();
        },
        onLeave() {
            if (!this._gsmBuild) return;
            const count = rva(config.memory.codeCountRva).readU32();
            if (count === 0 || this._gsmGlyphEnd + 1 < count) return;
            try {
                const positionedCodes = readLayout();
                const fingerprint = positionedCodes
                    .map((entry) => `${entry.code}:${entry.x}:${entry.y}`)
                    .join('|');
                if (fingerprint === lastEmissionFingerprint) return;
                lastEmissionFingerprint = fingerprint;
                send({
                    schema: 'gsm_engine_hook_message_v1',
                    type: 'text-layout',
                    integrationId: config.id,
                    sequence: this._gsmBuild.sequence,
                    capturedAt: Date.now(),
                    callerOffset: this._gsmBuild.callerOffset,
                    mode: this._gsmBuild.mode,
                    style: this._gsmStyle,
                    coordinateSpace: readCoordinateSpace(),
                    positionedCodes,
                });
                activeBuilds.delete(this._gsmThreadId);
            } catch (error) {
                send({
                    schema: 'gsm_engine_hook_message_v1',
                    type: 'diagnostic',
                    level: 'error',
                    message: `Failed to read MAGES layout: ${error.message}`,
                });
            }
        },
    }),
);

rpc.exports = {
    advance,
    diagnostics() {
        return {
            integrationId: config.id,
            module: targetModule.name,
            moduleBase: targetModule.base.toString(),
            moduleSize: targetModule.size,
            textBuilder: textBuilder.toString(),
            textBuilderOffset: moduleOffset(textBuilder),
            lineLayout: lineLayout.toString(),
            lineLayoutOffset: moduleOffset(lineLayout),
            coordinateSpaceProvider: config.coordinateSpace.provider,
            scaleXOffset: config.coordinateSpace.scaleXRva,
            scaleYOffset: config.coordinateSpace.scaleYRva,
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
        textBuilderOffset: moduleOffset(textBuilder),
        lineLayoutOffset: moduleOffset(lineLayout),
        coordinateSpaceProvider: config.coordinateSpace.provider,
        scaleXOffset: config.coordinateSpace.scaleXRva,
        scaleYOffset: config.coordinateSpace.scaleYRva,
    },
});
