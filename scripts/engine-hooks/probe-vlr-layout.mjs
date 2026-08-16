#!/usr/bin/env node

// Discovery probe for the built-in VLR hook. The dialog signature and UTF-8
// EAX read are derived from the installed GSM Agent script:
// %APPDATA%/GameSentenceMiner/agent-scripts/scripts/
// PC_Steam_Zero_Escape_The_Nonary_Games_Virtue's_Last_Reward.js
// This file is only for bounded live discovery and is not loaded by GSM.

import frida, { ScriptRuntime } from 'frida';

const [, , targetValue, ...arguments_] = process.argv;
if (!targetValue) {
    process.stderr.write(
        'Usage: node scripts/engine-hooks/probe-vlr-layout.mjs <pid-or-process-name> [--advance]\n',
    );
    process.exitCode = 2;
} else {
    const target = /^\d+$/u.test(targetValue) ? Number.parseInt(targetValue, 10) : targetValue;
    const shouldAdvance = arguments_.includes('--advance');
    const traceGeometry = arguments_.includes('--trace-geometry');
    const traceMetrics = arguments_.includes('--trace-metrics');
    const traceGl = arguments_.includes('--trace-gl');
    const compactOutput = arguments_.includes('--compact');
    const layoutOnly = arguments_.includes('--layout-only');
    const durationArgument = arguments_.find((argument) => argument.startsWith('--duration='));
    const durationMs = Number.parseInt(durationArgument?.slice('--duration='.length) ?? '2500', 10);
    const session = await frida.attach(target);
    try {
        const script = await session.createScript(
            String.raw`
                'use strict';

                const mainModule = Process.mainModule;
                const dialogPattern = '80 ?? ?? 74 ?? 8D ?? ?? 46 80 ?? ?? 75 ?? 8B ?? ?? 03';
                const matches = Memory.scanSync(mainModule.base, mainModule.size, dialogPattern);
                if (matches.length !== 1) {
                    throw new Error('VLR dialog signature matched ' + matches.length + ' locations.');
                }
                const alternativeDialogPattern = '01 77 08 5E 5F 5B 5D C2 04 00 CC';
                const alternativeDialogMatches = Memory.scanSync(
                    mainModule.base,
                    mainModule.size,
                    alternativeDialogPattern,
                );
                if (alternativeDialogMatches.length !== 1) {
                    throw new Error(
                        'VLR alternative dialog signature matched ' + alternativeDialogMatches.length + ' locations.',
                    );
                }

                const layoutPattern =
                    '55 8B EC 6A FF 68 ?? ?? ?? ?? 64 A1 00 00 00 00 50 81 EC D4 00 00 00 ' +
                    'A1 ?? ?? ?? ?? 33 C5 89 45 F0 53 56 57 50 8D 45 F4 64 A3 00 00 00 00 ' +
                    '8B F1 89 B5 68 FF FF FF 8B 45 08 8D 8E F8 01 00 00';
                const layoutMatches = Memory.scanSync(mainModule.base, mainModule.size, layoutPattern);
                if (layoutMatches.length !== 1) {
                    throw new Error('VLR line-layout signature matched ' + layoutMatches.length + ' locations.');
                }

                const seen = new Set();
                let hitCount = 0;
                let latestDisplayedRaw = null;
                let latestDisplayedAt = 0;
                const dialogAddress = matches[0].address;
                const alternativeDialogAddress = alternativeDialogMatches[0].address;
                const layoutAddress = layoutMatches[0].address;
                const boundedString = (pointer) => {
                    try {
                        return pointer.readUtf8String(1024);
                    } catch {
                        return null;
                    }
                };
                const registerValue = (context, name) => context[name]?.toString() ?? null;
                const bytesAt = (pointer, length) => {
                    try {
                        return Array.from(new Uint8Array(pointer.readByteArray(length)))
                            .map((value) => value.toString(16).padStart(2, '0'))
                            .join(' ');
                    } catch {
                        return null;
                    }
                };
                if (${layoutOnly ? 'false' : 'true'}) {
                Interceptor.attach(dialogAddress, {
                    onEnter(args) {
                        hitCount += 1;
                        if (hitCount <= 8) {
                            send({
                                type: 'hit',
                                hitCount,
                                eax: registerValue(this.context, 'eax'),
                                returnOffset: this.returnAddress.sub(mainModule.base).toString(),
                            });
                        }
                        let raw = null;
                        let readError = null;
                        try {
                            // Match the installed Agent's read semantics: an omitted
                            // length stops at the first NUL terminator.
                            raw = this.context.eax.readUtf8String();
                        } catch (error) {
                            readError = error.message;
                        }
                        if (raw && /[\u3040-\u30ff\u4e00-\u9faf]/u.test(raw) && /<(?:K|P)>/u.test(raw)) {
                            latestDisplayedRaw = raw;
                            latestDisplayedAt = Date.now();
                        }
                        if (hitCount <= 8) {
                            send({ type: 'raw-read', raw, readError, bytes: bytesAt(this.context.eax, 64) });
                        }
                        if (!raw || seen.has(raw)) return;
                        seen.add(raw);
                        const stack = [];
                        for (let offset = 0; offset < 0x30; offset += 4) {
                            try {
                                stack.push(this.context.esp.add(offset).readU32().toString(16));
                            } catch {
                                stack.push(null);
                            }
                        }
                        send({
                            type: 'dialog',
                            address: dialogAddress.toString(),
                            moduleOffset: dialogAddress.sub(mainModule.base).toString(),
                            raw,
                            registers: Object.fromEntries(
                                ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp']
                                    .map((name) => [name, registerValue(this.context, name)]),
                            ),
                            returnAddress: this.returnAddress.toString(),
                            returnOffset: this.returnAddress.sub(mainModule.base).toString(),
                            stack,
                            backtrace: Thread.backtrace(this.context, Backtracer.ACCURATE).map((entry) =>
                                entry.toString(),
                            ),
                        });
                    },
                });
                Interceptor.attach(alternativeDialogAddress, {
                    onEnter() {
                        try {
                            const raw = this.context.ecx.readUtf8String();
                            if (
                                raw &&
                                /[\u3040-\u30ff\u4e00-\u9faf]/u.test(raw) &&
                                /<(?:K|P)>$/u.test(raw)
                            ) {
                                latestDisplayedRaw = raw;
                                latestDisplayedAt = Date.now();
                                send({
                                    type: 'alternative-dialog',
                                    raw,
                                    address: alternativeDialogAddress.toString(),
                                    moduleOffset: alternativeDialogAddress.sub(mainModule.base).toString(),
                                });
                            }
                        } catch {
                            // Invalid transient pointers are ignored by this discovery hook.
                        }
                    },
                });
                }

                const safeReadLayout = (objectAddress) => {
                    try {
                        const count = objectAddress.add(0x184).readU32();
                        const entries = objectAddress.add(0x17c).readPointer();
                        if (count === 0 || count > 512 || entries.isNull()) return null;
                        const fields = {};
                        const pointerBytes = {};
                        const pointerWords = {};
                        for (const offset of [...Array.from({ length: 32 }, (_, index) => index * 4), 0x17c, 0x180, 0x184, 0x188, 0x18c, 0x190, 0x194, 0x198, 0x19c, 0x1a0, 0x1a4, 0x1a8, 0x1ac, 0x1b0, 0x1b4, 0x1b8, 0x1bc, 0x1c0, 0x1c4, 0x1c8, 0x1cc, 0x1d0, 0x1d4, 0x1d8, 0x1dc, 0x1e0, 0x1e4, 0x1e8, 0x1ec, 0x1f0, 0x1f4, 0x1f8, 0x1fc, 0x200, 0x204, 0x208, 0x20c, 0x210, 0x214, 0x218, 0x21c, 0x220, 0x224, 0x228, 0x22c, 0x230, 0x234, 0x238, 0x23c, 0x240, 0x244, 0x248, 0x24c, 0x250, 0x254, 0x258, 0x25c, 0x260, 0x264, 0x268, 0x26c, 0x270, 0x274, 0x278]) {
                            try {
                                fields['0x' + offset.toString(16)] = {
                                    u32: objectAddress.add(offset).readU32(),
                                    f32: objectAddress.add(offset).readFloat(),
                                };
                            } catch {
                                fields['0x' + offset.toString(16)] = null;
                            }
                        }
                        for (const offset of [0x1e0, 0x1e4, 0x1e8, 0x1f8, 0x204, 0x208, 0x20c, 0x210, 0x214, 0x218, 0x21c, 0x220, 0x224, 0x228]) {
                            try {
                                const pointer = objectAddress.add(offset).readPointer();
                                pointerBytes['0x' + offset.toString(16)] = pointer.isNull()
                                    ? null
                                    : bytesAt(pointer, 192);
                                if (!pointer.isNull()) {
                                    pointerWords['0x' + offset.toString(16)] = Array.from({ length: 32 }, (_, index) => {
                                        try {
                                            return pointer.add(index * 4).readU32();
                                        } catch {
                                            return null;
                                        }
                                    });
                                }
                            } catch {
                                pointerBytes['0x' + offset.toString(16)] = null;
                            }
                        }
                        const records = [];
                        let relatedPointer = NULL;
                        let textPointer = NULL;
                        try {
                            textPointer = objectAddress.add(0x1f8).readPointer();
                        } catch {
                            textPointer = NULL;
                        }
                        for (let index = 0; index < count; index += 1) {
                            const entry = entries.add(index * 0x20);
                            if (index === 0) {
                                try {
                                    relatedPointer = entry.add(4).readPointer();
                                } catch {
                                    relatedPointer = NULL;
                                }
                            }
                            records.push({
                                index,
                                bytes: bytesAt(entry, 0x20),
                                type: entry.readU32(),
                                field4: entry.add(4).readU32(),
                                x: entry.add(8).readFloat(),
                                y: entry.add(12).readFloat(),
                                metric: entry.add(16).readFloat(),
                                code: entry.add(0x14).readU16(),
                                field18: entry.add(0x18).readU32(),
                                flags: entry.add(0x1c).readU32(),
                            });
                        }
                        return {
                            fields,
                            pointerBytes,
                            pointerWords,
                            relatedPointer: relatedPointer.toString(),
                            relatedBytes: relatedPointer.isNull() ? null : bytesAt(relatedPointer, 256),
                            textPointer: textPointer.toString(),
                            textBytes: textPointer.isNull() ? null : bytesAt(textPointer, 256),
                            count,
                            cursorX: objectAddress.add(0x1a8).readFloat(),
                            cursorY: objectAddress.add(0x1ac).readFloat(),
                            maxX: objectAddress.add(0x270).readFloat(),
                            maxY: objectAddress.add(0x274).readFloat(),
                            records,
                        };
                    } catch (error) {
                        return { error: error.message };
                    }
                };
                let layoutCount = 0;
                let geometryCount = 0;
                const activeLayouts = new Map();
                const alternativeLayoutAddress = mainModule.base.add(0x2c7600);
                const onLayoutEnter = function (args) {
                    this._gsmObject = this.context.ecx;
                    activeLayouts.set(this.threadId, this);
                    try {
                        this._gsmRaw = args[0].readUtf8String();
                    } catch {
                        this._gsmRaw = null;
                    }
                };
                const onLayoutLeave = function () {
                    activeLayouts.delete(this.threadId);
                    if (!this._gsmRaw || !/[\u3040-\u30ff\u4e00-\u9faf]/u.test(this._gsmRaw)) return;
                    layoutCount += 1;
                    if (layoutCount > 20) return;
                    const data = safeReadLayout(this._gsmObject);
                    const glyphs = data?.records?.filter((record) => record.type === 1) ?? [];
                    const summary = {
                        layoutAddress: this._gsmLayoutAddress,
                        raw: this._gsmRaw,
                        object: this._gsmObject.toString(),
                        coordinateSpace: { maxX: data.maxX, maxY: data.maxY },
                        count: data.count,
                        glyphCount: glyphs.length,
                        firstGlyph: glyphs[0] ?? null,
                        lastGlyph: glyphs.at(-1) ?? null,
                        types: data.records.map((record) => record.type),
                    };
                    send(compactOutput ? { type: 'layout-summary', ...summary } : { type: 'layout', ...summary, data });
                };
                const attachLayout = (address) => {
                    Interceptor.attach(address, {
                        onEnter(args) {
                            onLayoutEnter.call(this, args);
                            this._gsmLayoutAddress = address.sub(mainModule.base).toString();
                        },
                        onLeave: onLayoutLeave,
                    });
                };
                attachLayout(layoutAddress);
                Interceptor.attach(alternativeLayoutAddress, {
                    onEnter(args) {
                        onLayoutEnter.call(this, args);
                        this._gsmLayoutAddress = alternativeLayoutAddress.sub(mainModule.base).toString();
                    },
                    onLeave: onLayoutLeave,
                });

                if (${traceGeometry ? 'true' : 'false'}) {
                    // This instruction follows the font-metric call and stores
                    // the current layout record's effective width. It is a
                    // bounded discovery hook, not part of the shipped payload.
                    const geometryAddresses = [
                        mainModule.base.add(0x2c953b),
                        mainModule.base.add(0x2c9582),
                        mainModule.base.add(0x2c819f),
                    ];
                    for (const geometryAddress of geometryAddresses) {
                        send({ type: 'geometry-hook', address: geometryAddress.toString() });
                        Interceptor.attach(geometryAddress, {
                            onEnter() {
                                const layout = activeLayouts.get(this.threadId);
                                if (geometryCount >= 300) return;
                                try {
                                    const isAlternative = geometryAddress.equals(alternativeLayoutAddress.add(0x59f));
                                    const entry = isAlternative ? this.context.ebx : this.context.edi;
                                    const objectAddress = this.context.esi;
                                    const code = entry.add(0x14).readU16();
                                    const record = {
                                        type: entry.readU32(),
                                        code,
                                        x: entry.add(8).readFloat(),
                                        y: entry.add(12).readFloat(),
                                        width: entry.add(0x10).readFloat(),
                                        object: objectAddress.toString(),
                                        raw: layout?._gsmRaw ?? null,
                                        cursorX: objectAddress.add(0x1a8).readFloat(),
                                        cursorY: objectAddress.add(0x1ac).readFloat(),
                                    };
                                    geometryCount += 1;
                                    send({ type: 'geometry-record', count: geometryCount, record });
                                } catch (error) {
                                    send({ type: 'geometry-error', message: error.message });
                                }
                            },
                        });
                    }
                }

                if (${traceMetrics ? 'true' : 'false'}) {
                    const metricAddress = mainModule.base.add(0x242ab0);
                    let metricCount = 0;
                    Interceptor.attach(metricAddress, {
                        onEnter(args) {
                            const layout = activeLayouts.get(this.threadId);
                            if (metricCount >= 60) return;
                            this._gsmLayout = layout;
                            this._gsmCode = args[1].toUInt32();
                            this._gsmMetricOutput = args[0];
                        },
                        onLeave(result) {
                            if (metricCount >= 60 || !this._gsmMetricOutput) return;
                            try {
                                metricCount += 1;
                                send({
                                    type: 'metric',
                                    count: metricCount,
                                    raw: this._gsmLayout?._gsmRaw ?? null,
                                    code: this._gsmCode,
                                    result: result.toInt32(),
                                    output: [
                                        this._gsmMetricOutput.readS32(),
                                        this._gsmMetricOutput.add(4).readS32(),
                                    ],
                                });
                            } catch (error) {
                                send({ type: 'metric-error', message: error.message });
                            }
                        },
                    });
                }

                if (${traceGl ? 'true' : 'false'}) {
                    const glBegin = Module.getGlobalExportByName('glBegin');
                    const glEnd = Module.getGlobalExportByName('glEnd');
                    const glVertex2f = Module.getGlobalExportByName('glVertex2f');
                    const glTexCoord2f = Module.getGlobalExportByName('glTexCoord2f');
                    const glBindTexture = Module.getGlobalExportByName('glBindTexture');
                    const glDrawArrays = Module.getGlobalExportByName('glDrawArrays');
                    const glDrawElements = Module.getGlobalExportByName('glDrawElements');
                    const glViewport = Module.getGlobalExportByName('glViewport');
                    let primitiveMode = null;
                    let primitiveVertices = [];
                    let textureCoordinates = [];
                    let texture = null;
                    let glBatchCount = 0;
                    const glActive = () => latestDisplayedRaw && Date.now() - latestDisplayedAt < 1200;
                    Interceptor.attach(glBindTexture, {
                        onEnter(args) {
                            if (glActive()) texture = args[1].toUInt32();
                        },
                    });
                    Interceptor.attach(glBegin, {
                        onEnter(args) {
                            if (!glActive()) {
                                primitiveMode = null;
                                return;
                            }
                            primitiveMode = args[0].toUInt32();
                            primitiveVertices = [];
                            textureCoordinates = [];
                        },
                    });
                    Interceptor.attach(glTexCoord2f, {
                        onEnter(args) {
                            if (primitiveMode === null || primitiveVertices.length >= 64) return;
                            textureCoordinates.push({ u: args[0].toFloat(), v: args[1].toFloat() });
                        },
                    });
                    Interceptor.attach(glVertex2f, {
                        onEnter(args) {
                            if (primitiveMode === null || primitiveVertices.length >= 64) return;
                            primitiveVertices.push({ x: args[0].toFloat(), y: args[1].toFloat() });
                        },
                    });
                    Interceptor.attach(glEnd, {
                        onEnter() {
                            if (primitiveMode === null || primitiveVertices.length < 4 || glBatchCount >= 40) {
                                primitiveMode = null;
                                return;
                            }
                            glBatchCount += 1;
                            send({
                                type: 'gl-batch',
                                count: glBatchCount,
                                raw: latestDisplayedRaw,
                                ageMs: Date.now() - latestDisplayedAt,
                                mode: primitiveMode,
                                texture,
                                vertices: primitiveVertices,
                                textureCoordinates,
                            });
                            primitiveMode = null;
                        },
                    });
                    Interceptor.attach(glDrawArrays, {
                        onEnter(args) {
                            if (!glActive() || glBatchCount >= 40) return;
                            glBatchCount += 1;
                            send({
                                type: 'gl-draw-arrays',
                                count: glBatchCount,
                                raw: latestDisplayedRaw,
                                ageMs: Date.now() - latestDisplayedAt,
                                mode: args[0].toUInt32(),
                                first: args[1].toInt32(),
                                vertexCount: args[2].toInt32(),
                                texture,
                            });
                        },
                    });
                    Interceptor.attach(glDrawElements, {
                        onEnter(args) {
                            if (!glActive() || glBatchCount >= 40) return;
                            glBatchCount += 1;
                            send({
                                type: 'gl-draw-elements',
                                count: glBatchCount,
                                raw: latestDisplayedRaw,
                                ageMs: Date.now() - latestDisplayedAt,
                                mode: args[0].toUInt32(),
                                indexCount: args[1].toInt32(),
                                indexType: args[2].toUInt32(),
                                indices: args[3].toString(),
                                texture,
                            });
                        },
                    });
                    Interceptor.attach(glViewport, {
                        onEnter(args) {
                            if (glBatchCount < 4) {
                                send({
                                    type: 'gl-viewport',
                                    x: args[0].toInt32(),
                                    y: args[1].toInt32(),
                                    width: args[2].toInt32(),
                                    height: args[3].toInt32(),
                                });
                            }
                        },
                    });
                }

                function findMainWindow() {
                    const enumWindows = new NativeFunction(
                        Module.getGlobalExportByName('EnumWindows'), 'bool', ['pointer', 'pointer'],
                    );
                    const getWindowThreadProcessId = new NativeFunction(
                        Module.getGlobalExportByName('GetWindowThreadProcessId'), 'uint32', ['pointer', 'pointer'],
                    );
                    const isWindowVisible = new NativeFunction(
                        Module.getGlobalExportByName('IsWindowVisible'), 'bool', ['pointer'],
                    );
                    const pid = Memory.alloc(4);
                    let result = NULL;
                    const callback = new NativeCallback((window) => {
                        pid.writeU32(0);
                        getWindowThreadProcessId(window, pid);
                        if (pid.readU32() === Process.id && isWindowVisible(window)) {
                            result = window;
                            return 0;
                        }
                        return 1;
                    }, 'bool', ['pointer', 'pointer']);
                    enumWindows(callback, NULL);
                    return result;
                }

                function heldClick() {
                    const window = findMainWindow();
                    if (window.isNull()) throw new Error('No visible VLR window.');
                    const getForegroundWindow = new NativeFunction(
                        Module.getGlobalExportByName('GetForegroundWindow'), 'pointer', [],
                    );
                    const setForegroundWindow = new NativeFunction(
                        Module.getGlobalExportByName('SetForegroundWindow'), 'bool', ['pointer'],
                    );
                    const getClientRect = new NativeFunction(
                        Module.getGlobalExportByName('GetClientRect'), 'bool', ['pointer', 'pointer'],
                    );
                    const clientToScreen = new NativeFunction(
                        Module.getGlobalExportByName('ClientToScreen'), 'bool', ['pointer', 'pointer'],
                    );
                    const getCursorPos = new NativeFunction(
                        Module.getGlobalExportByName('GetCursorPos'), 'bool', ['pointer'],
                    );
                    const setCursorPos = new NativeFunction(
                        Module.getGlobalExportByName('SetCursorPos'), 'bool', ['int32', 'int32'],
                    );
                    const mouseEvent = new NativeFunction(
                        Module.getGlobalExportByName('mouse_event'), 'void',
                        ['uint32', 'uint32', 'uint32', 'uint32', 'pointer'],
                    );
                    setForegroundWindow(window);
                    const rect = Memory.alloc(16);
                    const point = Memory.alloc(8);
                    const previous = Memory.alloc(8);
                    if (!getClientRect(window, rect)) throw new Error('GetClientRect failed.');
                    point.writeS32(Math.round(rect.add(8).readS32() * 0.5));
                    point.add(4).writeS32(Math.round(rect.add(12).readS32() * 0.8));
                    if (!clientToScreen(window, point)) throw new Error('ClientToScreen failed.');
                    getCursorPos(previous);
                    setCursorPos(point.readS32(), point.add(4).readS32());
                    mouseEvent(0x0002, 0, 0, 0, NULL);
                    setTimeout(() => {
                        mouseEvent(0x0004, 0, 0, 0, NULL);
                        setCursorPos(previous.readS32(), previous.add(4).readS32());
                    }, 80);
                    return {
                        window: window.toString(),
                        foregroundBefore: getForegroundWindow().toString(),
                        clientWidth: rect.add(8).readS32(),
                        clientHeight: rect.add(12).readS32(),
                    };
                }

                rpc.exports = { advance: heldClick };
                const scaleCandidates = {};
                for (const rva of [0x463020, 0x463040, 0x463050, 0x463058, 0x4c67f0, 0x4c6880, 0x4c69d4, 0x4c69dc]) {
                    try {
                        scaleCandidates['0x' + rva.toString(16)] = mainModule.base.add(rva).readFloat();
                    } catch {
                        scaleCandidates['0x' + rva.toString(16)] = null;
                    }
                }
                send({
                    type: 'ready',
                    dialogAddress: dialogAddress.toString(),
                    dialogOffset: dialogAddress.sub(mainModule.base).toString(),
                    layoutAddress: layoutAddress.toString(),
                    layoutOffset: layoutAddress.sub(mainModule.base).toString(),
                    scaleCandidates,
                });
            `,
            { runtime: ScriptRuntime.QJS },
        );
        const ready = new Promise((resolve, reject) => {
            script.message.connect((message) => {
                if (message.type === 'error') reject(new Error(message.stack || message.description));
                else if (message.type === 'send') {
                    process.stdout.write(`${JSON.stringify(message.payload)}\n`);
                    if (message.payload?.type === 'ready') resolve();
                }
            });
        });
        await script.load();
        await ready;
        if (shouldAdvance) {
            process.stdout.write(`${JSON.stringify({ type: 'advance', ...(await script.exports.advance()) })}\n`);
        }
        await new Promise((resolve) => setTimeout(resolve, durationMs));
        await script.unload();
    } finally {
        await session.detach();
    }
}
