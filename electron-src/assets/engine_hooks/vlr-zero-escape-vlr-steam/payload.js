'use strict';

const config = globalThis.__GSM_ENGINE_HOOK_CONFIG__;
const mainModule = Process.mainModule;
const integrationId = config.id;
const NULL_POINTER = ptr(0);
const MAX_RAW_TEXT_LENGTH = 4096;
const MAX_ABSOLUTE_COORDINATE = 32768;
const MAX_GLYPH_DIMENSION = 4096;

let sequence = 0;
let lastFingerprint = null;
let lastFingerprintAt = 0;
let advanceInFlight = false;

function diagnostic(level, message) {
    send({
        schema: 'gsm_engine_hook_message_v1',
        type: 'diagnostic',
        level,
        message,
    });
}

function mainRva(value) {
    return mainModule.base.add(Number.parseInt(value, 16));
}

function executableRanges() {
    const moduleEnd = mainModule.base.add(mainModule.size);
    return Process.enumerateRanges({ protection: 'r-x', coalesce: true }).filter((range) => {
        const rangeEnd = range.base.add(range.size);
        return range.base.compare(mainModule.base) >= 0 && rangeEnd.compare(moduleEnd) <= 0;
    });
}

function scanRange(range, pattern) {
    return new Promise((resolve, reject) => {
        const matches = [];
        Memory.scan(range.base, range.size, pattern, {
            onMatch(address) {
                matches.push(address);
            },
            onError(message) {
                reject(new Error(message));
            },
            onComplete() {
                resolve(matches);
            },
        });
    });
}

async function findUniqueSignature(label, pattern) {
    const matches = [];
    for (const range of executableRanges()) {
        matches.push(...(await scanRange(range, pattern)));
        if (matches.length > 1) break;
    }
    if (matches.length !== 1) {
        throw new Error(`${label} signature matched ${matches.length} locations; refusing to attach.`);
    }
    return matches[0];
}

function readUtf8Bounded(pointer) {
    if (pointer.isNull()) return null;
    try {
        // The Agent reference reads this exact pointer as a NUL-terminated
        // UTF-8 string. Keep the integration bounded at the trust boundary.
        const raw = pointer.readUtf8String();
        return typeof raw === 'string' && raw.length <= MAX_RAW_TEXT_LENGTH ? raw : null;
    } catch {
        return null;
    }
}

function isDialogue(raw) {
    if (typeof raw !== 'string' || !/[\u3040-\u30ff\u3400-\u9fff]/u.test(raw)) return false;
    if (!/<(?:K|P)>$/u.test(raw.trim()) || /<N>/u.test(raw)) return false;
    const text = raw
        .replace(/<[^>]+>/gu, '')
        .trim();
    return text.length > 0 && text !== 'はい' && text !== 'いいえ';
}

function cleanDisplayedText(raw) {
    return raw.replace(/<[^>]+>/gu, '').trim();
}

function readFiniteFloat(pointer, label) {
    const value = pointer.readFloat();
    if (!Number.isFinite(value)) throw new Error(`${label} is not finite.`);
    return value;
}

function readClientSize(window) {
    const getClientRect = new NativeFunction(
        Module.getGlobalExportByName('GetClientRect'),
        'bool',
        ['pointer', 'pointer'],
    );
    const rect = Memory.alloc(16);
    if (!getClientRect(window, rect)) throw new Error('GetClientRect failed.');
    const width = rect.add(8).readS32();
    const height = rect.add(12).readS32();
    if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
        throw new Error(`Invalid client size ${width}x${height}.`);
    }
    return { width, height };
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
    const processId = Memory.alloc(4);
    let result = NULL_POINTER;
    const callback = new NativeCallback((window) => {
        processId.writeU32(0);
        getWindowThreadProcessId(window, processId);
        if (processId.readU32() === Process.id && isWindowVisible(window)) {
            result = window;
            return 0;
        }
        return 1;
    }, 'bool', ['pointer', 'pointer']);
    enumWindows(callback, NULL_POINTER);
    return result;
}

function measureCoordinateSpace() {
    const window = findMainWindow();
    if (window.isNull()) throw new Error('No visible VLR window.');
    const client = readClientSize(window);
    const coordinateConfig = config.coordinateSpace;
    const scaleX =
        coordinateConfig.provider === 'window-client-over-design-space'
            ? client.width / coordinateConfig.designWidth
            : readFiniteFloat(mainRva(coordinateConfig.scaleXRva), 'scaleX');
    const scaleY =
        coordinateConfig.provider === 'window-client-over-design-space'
            ? client.height / coordinateConfig.designHeight
            : readFiniteFloat(mainRva(coordinateConfig.scaleYRva), 'scaleY');
    if (scaleX <= Number.EPSILON || scaleX > 16 || scaleY <= Number.EPSILON || scaleY > 16) {
        throw new Error(`Invalid VLR render scale ${scaleX}x${scaleY}.`);
    }
    return {
        kind: 'scaled-window-client',
        clientWidth: client.width,
        clientHeight: client.height,
        scaleX,
        scaleY,
    };
}

function readLayoutHeightAndBounds(objectAddress) {
    const object = config.memory.textObject;
    const height = readFiniteFloat(
        objectAddress.add(Number.parseInt(object.glyphHeightOffset, 16)),
        'glyph height',
    );
    const maximumX = readFiniteFloat(
        objectAddress.add(Number.parseInt(object.maximumXOffset, 16)),
        'maximum x',
    );
    const maximumY = readFiniteFloat(
        objectAddress.add(Number.parseInt(object.maximumYOffset, 16)),
        'maximum y',
    );
    if (!Number.isInteger(height) || height <= 0 || height > MAX_GLYPH_DIMENSION) {
        throw new Error(`Invalid VLR glyph height ${height}.`);
    }
    if (
        !Number.isInteger(maximumX) ||
        !Number.isInteger(maximumY) ||
        maximumX < 0 ||
        maximumY < 0 ||
        maximumX > MAX_ABSOLUTE_COORDINATE ||
        maximumY > MAX_ABSOLUTE_COORDINATE
    ) {
        throw new Error(`Invalid VLR layout bounds ${maximumX}x${maximumY}.`);
    }
    return height;
}

function readLayoutOrigin(objectAddress) {
    const object = config.memory.textObject;
    const x = readFiniteFloat(
        objectAddress.add(Number.parseInt(object.originXOffset, 16)),
        'layout origin x',
    );
    const y = readFiniteFloat(
        objectAddress.add(Number.parseInt(object.originYOffset, 16)),
        'layout origin y',
    );
    if (Math.abs(x) > MAX_ABSOLUTE_COORDINATE || Math.abs(y) > MAX_ABSOLUTE_COORDINATE) {
        throw new Error(`Invalid VLR layout origin ${x},${y}.`);
    }
    return { x, y };
}

function readGlyphRecord(entry, index, height, origin) {
    const entryConfig = config.memory.entry;
    const offset = (name) => Number.parseInt(entryConfig[name], 16);
    const type = entry.add(offset('typeOffset')).readU32();
    if (type !== entryConfig.visibleType) return null;
    const code = entry.add(offset('codeOffset')).readU16();
    const localX = readFiniteFloat(entry.add(offset('xOffset')), `glyph ${index} x`);
    const localY = readFiniteFloat(entry.add(offset('yOffset')), `glyph ${index} y`);
    const x = localX + origin.x;
    const y = localY + origin.y;
    const width = readFiniteFloat(entry.add(offset('widthOffset')), `glyph ${index} width`);
    const roundedWidth = Math.round(width);
    if (
        !Number.isInteger(code) ||
        Math.abs(x) > MAX_ABSOLUTE_COORDINATE ||
        Math.abs(y) > MAX_ABSOLUTE_COORDINATE ||
        width <= 0 ||
        roundedWidth < 1 ||
        roundedWidth > MAX_GLYPH_DIMENSION
    ) {
        throw new Error(`Invalid VLR glyph record ${index}.`);
    }
    return {
        engineIndex: index,
        code,
        x: Math.round(x),
        y: Math.round(y),
        width: roundedWidth,
        height,
    };
}

function snapshotGlyphs(objectAddress) {
    const object = config.memory.textObject;
    const entryConfig = config.memory.entry;
    const count = objectAddress.add(Number.parseInt(object.countOffset, 16)).readU32();
    if (count === 0 || count > config.memory.maximumEntries) {
        throw new Error(`Invalid VLR layout count ${count}; expected 1-${config.memory.maximumEntries}.`);
    }
    const entries = objectAddress.add(Number.parseInt(object.entriesOffset, 16)).readPointer();
    if (entries.isNull()) throw new Error('VLR layout entry pointer is null.');
    const height = readLayoutHeightAndBounds(objectAddress);
    const origin = readLayoutOrigin(objectAddress);

    const records = [];
    const stride = entryConfig.stride;
    for (let index = 0; index < count; index += 1) {
        const entry = entries.add(index * stride);
        const record = readGlyphRecord(entry, index, height, origin);
        if (record) records.push(record);
    }
    if (records.length === 0) throw new Error('VLR dialogue layout contained no visible glyphs.');
    return records;
}

function emitText(raw, callerOffset) {
    if (!isDialogue(raw)) return;
    const text = cleanDisplayedText(raw);
    const now = Date.now();
    const fingerprint = `text\u0000${text}`;
    if (fingerprint === lastFingerprint && now - lastFingerprintAt < 250) return;
    lastFingerprint = fingerprint;
    lastFingerprintAt = now;
    sequence += 1;
    send({
        schema: 'gsm_engine_hook_message_v1',
        type: 'text',
        integrationId,
        sequence,
        capturedAt: now,
        callerOffset,
        text,
    });
}

function emitLayout(raw, objectAddress, callerOffset, capturedGlyphs = null) {
    if (!isDialogue(raw)) return;
    let coordinateSpace;
    let positionedCodes;
    try {
        coordinateSpace = measureCoordinateSpace();
        readLayoutHeightAndBounds(objectAddress);
        positionedCodes = capturedGlyphs ?? snapshotGlyphs(objectAddress);
        if (positionedCodes.length === 0) {
            throw new Error('VLR dialogue layout contained no visible glyphs.');
        }
    } catch (error) {
        diagnostic('warn', `VLR layout rejected: ${error.message}`);
        emitText(raw, callerOffset);
        return;
    }
    const fingerprint = `${raw}\u0000${JSON.stringify(positionedCodes)}\u0000${JSON.stringify(coordinateSpace)}`;
    const now = Date.now();
    if (fingerprint === lastFingerprint && now - lastFingerprintAt < 250) return;
    lastFingerprint = fingerprint;
    lastFingerprintAt = now;
    sequence += 1;
    send({
        schema: 'gsm_engine_hook_message_v1',
        type: 'text-layout',
        integrationId,
        sequence,
        capturedAt: now,
        callerOffset,
        mode: 0,
        style: 0,
        coordinateSpace,
        positionedCodes,
    });
}

function attachLineLayout(address) {
    Interceptor.attach(address, {
        onEnter(args) {
            this._gsmRaw = readUtf8Bounded(args[0]);
            this._gsmObject = this.context.ecx;
            this._gsmCallerOffset = address.sub(mainModule.base).toString();
        },
        onLeave() {
            if (!this._gsmRaw || !this._gsmObject) return;
            let glyphs;
            try {
                glyphs = snapshotGlyphs(this._gsmObject);
            } catch (error) {
                if (isDialogue(this._gsmRaw)) {
                    diagnostic('warn', `VLR layout rejected: ${error.message}`);
                    emitText(this._gsmRaw, this._gsmCallerOffset);
                }
                return;
            }
            emitLayout(this._gsmRaw, this._gsmObject, this._gsmCallerOffset, glyphs);
        },
    });
}

function heldClick() {
    if (advanceInFlight) throw new Error('VLR advance is already in flight.');
    const window = findMainWindow();
    if (window.isNull()) throw new Error('No visible VLR window.');
    const setForegroundWindow = new NativeFunction(
        Module.getGlobalExportByName('SetForegroundWindow'),
        'bool',
        ['pointer'],
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
    const rect = Memory.alloc(16);
    const point = Memory.alloc(8);
    const previous = Memory.alloc(8);
    const getClientRect = new NativeFunction(
        Module.getGlobalExportByName('GetClientRect'),
        'bool',
        ['pointer', 'pointer'],
    );
    if (!getClientRect(window, rect)) throw new Error('GetClientRect failed.');
    point.writeS32(Math.round(rect.add(8).readS32() * config.advance.clientXRatio));
    point.add(4).writeS32(Math.round(rect.add(12).readS32() * config.advance.clientYRatio));
    if (!clientToScreen(window, point)) throw new Error('ClientToScreen failed.');
    getCursorPos(previous);
    setForegroundWindow(window);
    setCursorPos(point.readS32(), point.add(4).readS32());
    advanceInFlight = true;
    mouseEvent(0x0002, 0, 0, 0, NULL_POINTER);
    setTimeout(() => {
        try {
            mouseEvent(0x0004, 0, 0, 0, NULL_POINTER);
            setCursorPos(previous.readS32(), previous.add(4).readS32());
        } finally {
            advanceInFlight = false;
        }
    }, 80);
    return { accepted: true, clientWidth: rect.add(8).readS32(), clientHeight: rect.add(12).readS32() };
}

async function initialize() {
    try {
        const textAddress = await findUniqueSignature('VLR text-builder', config.signatures.textBuilder);
        const lineLayoutAddress = await findUniqueSignature('VLR line-layout', config.signatures.lineLayout);
        const alternativeLineLayoutAddress = config.signatures.alternativeLineLayout
            ? await findUniqueSignature(
                  'VLR alternative line-layout',
                  config.signatures.alternativeLineLayout,
              )
            : null;
        // Keep the text-builder signatures as part of the fail-closed build
        // identity. The line-layout function owns both the raw source and the
        // finalized records, so intercepting the builders only added noise.
        if (config.signatures.alternativeTextBuilder) {
            await findUniqueSignature(
                'VLR alternative text-builder',
                config.signatures.alternativeTextBuilder,
            );
        }
        attachLineLayout(lineLayoutAddress);
        if (alternativeLineLayoutAddress !== null) attachLineLayout(alternativeLineLayoutAddress);
        rpc.exports = { advance: heldClick };
        send({
            schema: 'gsm_engine_hook_message_v1',
            type: 'ready',
            integrationId,
            diagnostics: {
                module: mainModule.name,
                architecture: Process.arch,
                textBuilderOffset: textAddress.sub(mainModule.base).toString(),
                lineLayoutOffset: lineLayoutAddress.sub(mainModule.base).toString(),
                alternativeLineLayoutOffset:
                    alternativeLineLayoutAddress?.sub(mainModule.base).toString() ?? null,
                captureStrategy: 'post-layout-snapshot',
                coordinateProvider: config.coordinateSpace.provider,
                ...(config.coordinateSpace.provider === 'window-client-over-design-space'
                    ? {
                          designWidth: config.coordinateSpace.designWidth,
                          designHeight: config.coordinateSpace.designHeight,
                      }
                    : {
                          scaleXRva: config.coordinateSpace.scaleXRva,
                          scaleYRva: config.coordinateSpace.scaleYRva,
                      }),
            },
        });
    } catch (error) {
        diagnostic('error', `VLR hook initialization failed closed: ${error.message}`);
    }
}

void initialize();
