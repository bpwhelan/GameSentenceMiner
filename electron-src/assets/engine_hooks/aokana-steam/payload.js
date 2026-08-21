'use strict';

// Built-in engine hook for the Steam builds of Aokana (Unity 2018.2.19f1) and
// Aokana EXTRA2 (Unity 2021.3.15f1) — 32-bit Mono, TextMeshPro, same game code.
//
// Nothing here is a byte pattern. The game is a managed application, so the Mono
// runtime is asked for its own metadata: classes by name, methods by name and
// parameter count, and field offsets from the loaded class layout. That is
// ASLR-safe by construction and survives a rebuild that moves code around.
//
// The dialogue call marks that a line is being shown and names the text component;
// the TextMeshPro layout call is where that line's cells become final. Cells are
// mapped to window-client pixels through the engine's own canvas camera, so no
// resolution is assumed anywhere.
//
// See docs/AOKANA_ENGINE_HOOK.md for how each of these was established.

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

// A pending line is paired with the next layout that carries characters. Anything
// later than this belongs to a redraw the player caused, not to that line.
const PAIRING_WINDOW_MS = 5000;
const MAX_GLYPHS = Math.min(config.capture.maximumGlyphs, 2000);
const MAX_LINES = 64;
const MAX_ABSOLUTE_COORDINATE = 32768;
const MAX_GLYPH_DIMENSION = 4096;
// Mono lays a value type out with an object header in front of it, but packs the
// same type in an array without one.
const OBJECT_HEADER = Process.pointerSize * 2;
// MonoArray: MonoObject, then the bounds pointer, then the length, then the payload.
const ARRAY_LENGTH = Process.pointerSize * 2 + Process.pointerSize;
const ARRAY_DATA = ARRAY_LENGTH + 4;
// MonoString: MonoObject, then the length, then UTF-16 code units.
const STRING_LENGTH = Process.pointerSize * 2;
const STRING_CHARS = STRING_LENGTH + 4;

// Unity ships the Mono runtime under different names by version — `mono.dll` on
// 2019 and earlier, `mono-2.0-bdwgc.dll` since 2020 — and a package covering more
// than one build cannot name both. The runtime is therefore identified by what it
// is rather than by what it is called: the loaded module that exports the Mono
// embedding API. A manifest `moduleName` is honoured first when one is given.
const monoModule = (function findMonoRuntime() {
    const preferred = config.target.moduleName
        ? Process.findModuleByName(config.target.moduleName)
        : null;
    if (preferred && preferred.findExportByName('mono_get_root_domain')) return preferred;
    const hosts = Process.enumerateModules().filter((module) =>
        module.findExportByName('mono_get_root_domain'),
    );
    if (hosts.length !== 1) {
        throw new Error(
            `Expected exactly one loaded Mono runtime, found ${hosts.length}` +
                `${hosts.length ? ` (${hosts.map((module) => module.name).join(', ')})` : ''}.`,
        );
    }
    return hosts[0];
})();

function api(name, retType, argTypes) {
    const address = monoModule.findExportByName(name);
    if (!address) throw new Error(`The Mono runtime does not export ${name}.`);
    return new NativeFunction(address, retType, argTypes);
}

function optionalApi(name, retType, argTypes) {
    const address = monoModule.findExportByName(name);
    return address ? new NativeFunction(address, retType, argTypes) : null;
}

const mono = {
    getRootDomain: api('mono_get_root_domain', 'pointer', []),
    threadAttach: api('mono_thread_attach', 'pointer', ['pointer']),
    assemblyForeach: api('mono_assembly_foreach', 'void', ['pointer', 'pointer']),
    assemblyGetImage: api('mono_assembly_get_image', 'pointer', ['pointer']),
    imageGetName: api('mono_image_get_name', 'pointer', ['pointer']),
    // Present on every runtime seen so far, but the enumeration below is a complete
    // substitute, so a runtime without it is still supported.
    imageLoaded: optionalApi('mono_image_loaded', 'pointer', ['pointer']),
    classFromName: api('mono_class_from_name', 'pointer', ['pointer', 'pointer', 'pointer']),
    classGetMethodFromName: api('mono_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']),
    classGetFieldFromName: api('mono_class_get_field_from_name', 'pointer', ['pointer', 'pointer']),
    classGetName: api('mono_class_get_name', 'pointer', ['pointer']),
    classArrayElementSize: api('mono_class_array_element_size', 'int', ['pointer']),
    fieldGetOffset: api('mono_field_get_offset', 'int', ['pointer']),
    compileMethod: api('mono_compile_method', 'pointer', ['pointer']),
    objectGetClass: api('mono_object_get_class', 'pointer', ['pointer']),
    objectUnbox: api('mono_object_unbox', 'pointer', ['pointer']),
    runtimeInvoke: api('mono_runtime_invoke', 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']),
};

const rootDomain = mono.getRootDomain();
if (rootDomain.isNull()) throw new Error('The Mono root domain is not up yet.');
mono.threadAttach(rootDomain);

const internedStrings = {};
function cstr(text) {
    if (!internedStrings[text]) internedStrings[text] = Memory.allocUtf8String(text);
    return internedStrings[text];
}

function readCString(pointer) {
    return pointer.isNull() ? null : pointer.readUtf8String();
}

// Images are looked up among what the runtime has already loaded rather than opened
// by path: the game has loaded everything it uses, and re-opening an assembly can
// fail or duplicate it.
let loadedImages = null;
function collectImages() {
    if (loadedImages) return loadedImages;
    loadedImages = {};
    const visit = new NativeCallback(
        (assembly) => {
            const image = mono.assemblyGetImage(assembly);
            const name = image.isNull() ? null : readCString(mono.imageGetName(image));
            if (name) loadedImages[name] = image;
        },
        'void',
        ['pointer', 'pointer'],
    );
    mono.assemblyForeach(visit, NULL);
    return loadedImages;
}

const images = {};
function image(assemblyName) {
    if (!images[assemblyName]) {
        const direct = mono.imageLoaded ? mono.imageLoaded(cstr(assemblyName)) : NULL;
        const found = direct.isNull() ? collectImages()[assemblyName] : direct;
        if (!found || found.isNull()) {
            throw new Error(
                `The assembly ${assemblyName} is not loaded; the process is not a supported build.`,
            );
        }
        images[assemblyName] = found;
    }
    return images[assemblyName];
}

function klass(assemblyName, namespace, name) {
    const found = mono.classFromName(image(assemblyName), cstr(namespace), cstr(name));
    if (found.isNull()) {
        throw new Error(`The class ${namespace ? `${namespace}.` : ''}${name} is not in ${assemblyName}.`);
    }
    return found;
}

function method(cls, name, parameterCount) {
    const found = mono.classGetMethodFromName(cls, cstr(name), parameterCount);
    if (found.isNull()) throw new Error(`The method ${name}/${parameterCount} was not found.`);
    return found;
}

function fieldOffset(cls, name) {
    const field = mono.classGetFieldFromName(cls, cstr(name));
    if (field.isNull()) throw new Error(`The field ${name} was not found.`);
    return mono.fieldGetOffset(field);
}

function readMonoString(pointer) {
    if (!pointer || pointer.isNull()) return null;
    const length = pointer.add(STRING_LENGTH).readS32();
    if (length < 0 || length > 20000) return null;
    return pointer.add(STRING_CHARS).readUtf16String(length);
}

const exceptionSlot = Memory.alloc(Process.pointerSize);
const singleArgumentSlot = Memory.alloc(Process.pointerSize);

function invoke(monoMethod, instance, argv) {
    exceptionSlot.writePointer(NULL);
    const result = mono.runtimeInvoke(monoMethod, instance || NULL, argv || NULL, exceptionSlot);
    const exception = exceptionSlot.readPointer();
    if (!exception.isNull()) {
        throw new Error(`The engine threw ${readCString(mono.classGetName(mono.objectGetClass(exception)))}.`);
    }
    return result;
}

function invokeInt(monoMethod, instance) {
    const boxed = invoke(monoMethod, instance, NULL);
    return boxed.isNull() ? null : mono.objectUnbox(boxed).readS32();
}

function invokeObject(monoMethod, instance) {
    const result = invoke(monoMethod, instance, NULL);
    return result.isNull() ? null : result;
}

function invokeMatrix(monoMethod, instance) {
    const boxed = invoke(monoMethod, instance, NULL);
    if (boxed.isNull()) return null;
    const raw = mono.objectUnbox(boxed);
    const values = [];
    for (let index = 0; index < 16; index += 1) values.push(raw.add(index * 4).readFloat());
    return values;
}

function invokeRect(monoMethod, instance) {
    const boxed = invoke(monoMethod, instance, NULL);
    if (boxed.isNull()) return null;
    const raw = mono.objectUnbox(boxed);
    return {
        x: raw.readFloat(),
        y: raw.add(4).readFloat(),
        width: raw.add(8).readFloat(),
        height: raw.add(12).readFloat(),
    };
}

// --- managed members ---------------------------------------------------------

const dialogueConfig = config.mono.dialogue;
const layoutConfig = config.mono.layout;

const dialogueClass = klass(dialogueConfig.assembly, dialogueConfig.namespace, dialogueConfig.class);
const layoutClass = klass(layoutConfig.assembly, layoutConfig.namespace, layoutConfig.class);
// TextMeshPro's own types come from the same assembly as the layout call, so the
// package stays in control of where they are looked up.
const tmpTextClass = klass(layoutConfig.assembly, layoutConfig.namespace, 'TMP_Text');
const tmpTextInfoClass = klass(layoutConfig.assembly, layoutConfig.namespace, 'TMP_TextInfo');
const tmpCharacterInfoClass = klass(layoutConfig.assembly, layoutConfig.namespace, 'TMP_CharacterInfo');
const tmpLineInfoClass = klass(layoutConfig.assembly, layoutConfig.namespace, 'TMP_LineInfo');

const CORE = 'UnityEngine.CoreModule';
const canvasClass = klass('UnityEngine.UIModule', 'UnityEngine', 'Canvas');
const cameraClass = klass(CORE, 'UnityEngine', 'Camera');
const screenClass = klass(CORE, 'UnityEngine', 'Screen');
const transformClass = klass(CORE, 'UnityEngine', 'Transform');
const componentClass = klass(CORE, 'UnityEngine', 'Component');
const graphicClass = klass('UnityEngine.UI', 'UnityEngine.UI', 'Graphic');

const offsets = {
    textComponent: fieldOffset(dialogueClass, dialogueConfig.textComponentField),
    textInfo: fieldOffset(tmpTextClass, 'm_textInfo'),
    characterCount: fieldOffset(tmpTextInfoClass, 'characterCount'),
    lineCount: fieldOffset(tmpTextInfoClass, 'lineCount'),
    characterInfo: fieldOffset(tmpTextInfoClass, 'characterInfo'),
    lineInfo: fieldOffset(tmpTextInfoClass, 'lineInfo'),
    characterStride: mono.classArrayElementSize(tmpCharacterInfoClass),
    lineStride: mono.classArrayElementSize(tmpLineInfoClass),
};

const characterField = (name) => fieldOffset(tmpCharacterInfoClass, name) - OBJECT_HEADER;
const lineField = (name) => fieldOffset(tmpLineInfoClass, name) - OBJECT_HEADER;
const character = {
    character: characterField('character'),
    lineNumber: characterField('lineNumber'),
    origin: characterField('origin'),
    xAdvance: characterField('xAdvance'),
    ascender: characterField('ascender'),
    descender: characterField('descender'),
};
const lineMetrics = {
    ascender: lineField('ascender'),
    descender: lineField('descender'),
};

const methods = {
    dialogue: method(dialogueClass, dialogueConfig.method, dialogueConfig.parameterCount),
    layout: method(layoutClass, layoutConfig.method, layoutConfig.parameterCount),
    transform: method(componentClass, 'get_transform', 0),
    localToWorld: method(transformClass, 'get_localToWorldMatrix', 0),
    graphicCanvas: method(graphicClass, 'get_canvas', 0),
    canvasWorldCamera: method(canvasClass, 'get_worldCamera', 0),
    cameraPixelRect: method(cameraClass, 'get_pixelRect', 0),
    worldToScreenPoint: method(cameraClass, 'WorldToScreenPoint', 1),
    screenWidth: method(screenClass, 'get_width', 0),
    screenHeight: method(screenClass, 'get_height', 0),
};

// --- window ------------------------------------------------------------------

const user32 = {
    enumWindows: new NativeFunction(Module.getGlobalExportByName('EnumWindows'), 'bool', ['pointer', 'pointer']),
    getWindowThreadProcessId: new NativeFunction(
        Module.getGlobalExportByName('GetWindowThreadProcessId'),
        'uint32',
        ['pointer', 'pointer'],
    ),
    isWindowVisible: new NativeFunction(Module.getGlobalExportByName('IsWindowVisible'), 'bool', ['pointer']),
    getClientRect: new NativeFunction(Module.getGlobalExportByName('GetClientRect'), 'bool', ['pointer', 'pointer']),
};

function findMainWindow() {
    const processIdBuffer = Memory.alloc(4);
    let result = NULL;
    const callback = new NativeCallback(
        (window) => {
            processIdBuffer.writeU32(0);
            user32.getWindowThreadProcessId(window, processIdBuffer);
            if (processIdBuffer.readU32() === Process.id && user32.isWindowVisible(window)) {
                result = window;
                return 0;
            }
            return 1;
        },
        'bool',
        ['pointer', 'pointer'],
    );
    user32.enumWindows(callback, NULL);
    return result;
}

function readClientArea() {
    const window = findMainWindow();
    if (window.isNull()) throw new Error('No visible target window was found.');
    const clientRect = Memory.alloc(16);
    if (!user32.getClientRect(window, clientRect)) throw new Error('Could not read the target client area.');
    const width = clientRect.add(8).readS32();
    const height = clientRect.add(12).readS32();
    if (width <= 0 || height <= 0) throw new Error(`Invalid target client area ${width}x${height}.`);
    return { width, height };
}

// --- geometry ----------------------------------------------------------------

const vectorArgument = Memory.alloc(12);

function worldToScreen(camera, point) {
    vectorArgument.writeFloat(point[0]);
    vectorArgument.add(4).writeFloat(point[1]);
    vectorArgument.add(8).writeFloat(point[2]);
    singleArgumentSlot.writePointer(vectorArgument);
    const boxed = invoke(methods.worldToScreenPoint, camera, singleArgumentSlot);
    if (boxed.isNull()) throw new Error('The canvas camera returned no screen point.');
    const raw = mono.objectUnbox(boxed);
    return [raw.readFloat(), raw.add(4).readFloat()];
}

function localToWorld(matrix, x, y) {
    return [
        matrix[0] * x + matrix[4] * y + matrix[12],
        matrix[1] * x + matrix[5] * y + matrix[13],
        matrix[2] * x + matrix[6] * y + matrix[14],
    ];
}

/**
 * Pins down how the text component's local space lands in the window.
 *
 * A UI canvas is a plane, so the map from it to the screen is affine no matter how
 * the canvas is scaled or where the camera sits. Three reference points through the
 * engine's own projection therefore describe it exactly, and cost three managed
 * calls per line instead of two per character.
 */
function measureSurface(textComponent) {
    const transform = invokeObject(methods.transform, textComponent);
    if (!transform) throw new Error('The text component has no transform.');
    const matrix = invokeMatrix(methods.localToWorld, transform);
    if (!matrix || matrix.some((value) => !Number.isFinite(value))) {
        throw new Error('The text component reported an unusable transform.');
    }
    const canvas = invokeObject(methods.graphicCanvas, textComponent);
    const camera = canvas ? invokeObject(methods.canvasWorldCamera, canvas) : null;
    const client = readClientArea();

    let project;
    let viewport;
    if (camera) {
        const pixelRect = invokeRect(methods.cameraPixelRect, camera);
        if (!pixelRect || !(pixelRect.width > 0) || !(pixelRect.height > 0)) {
            throw new Error('The canvas camera reported an empty viewport.');
        }
        viewport = pixelRect;
        const origin = worldToScreen(camera, localToWorld(matrix, 0, 0));
        const unitX = worldToScreen(camera, localToWorld(matrix, 1, 0));
        const unitY = worldToScreen(camera, localToWorld(matrix, 0, 1));
        project = {
            originX: origin[0],
            originY: origin[1],
            xAxis: [unitX[0] - origin[0], unitX[1] - origin[1]],
            yAxis: [unitY[0] - origin[0], unitY[1] - origin[1]],
        };
    } else {
        // A screen-space-overlay canvas is authored directly in screen pixels, so
        // the world position of a cell is already where it is drawn.
        const width = invokeInt(methods.screenWidth, null);
        const height = invokeInt(methods.screenHeight, null);
        if (!width || !height) throw new Error('The engine reported no screen size.');
        viewport = { x: 0, y: 0, width, height };
        const origin = localToWorld(matrix, 0, 0);
        const unitX = localToWorld(matrix, 1, 0);
        const unitY = localToWorld(matrix, 0, 1);
        project = {
            originX: origin[0],
            originY: origin[1],
            xAxis: [unitX[0] - origin[0], unitX[1] - origin[1]],
            yAxis: [unitY[0] - origin[0], unitY[1] - origin[1]],
        };
    }

    // The engine's Y grows upwards from the bottom of the viewport; the overlay's
    // grows downwards from the top of the client area.
    const scaleX = client.width / viewport.width;
    const scaleY = client.height / viewport.height;
    return {
        client,
        viewport,
        toClient(x, y) {
            const screenX = project.originX + x * project.xAxis[0] + y * project.yAxis[0];
            const screenY = project.originY + x * project.xAxis[1] + y * project.yAxis[1];
            return [
                (screenX - viewport.x) * scaleX,
                client.height - (screenY - viewport.y) * scaleY,
            ];
        },
    };
}

// --- layout reading ----------------------------------------------------------

function readCells(textComponent, surface) {
    const textInfo = textComponent.add(offsets.textInfo).readPointer();
    if (textInfo.isNull()) return null;
    const characterInfo = textInfo.add(offsets.characterInfo).readPointer();
    const lineInfo = textInfo.add(offsets.lineInfo).readPointer();
    if (characterInfo.isNull() || lineInfo.isNull()) return null;
    const characterCount = Math.min(
        textInfo.add(offsets.characterCount).readS32(),
        characterInfo.add(ARRAY_LENGTH).readS32(),
        MAX_GLYPHS,
    );
    const lineCount = Math.min(
        textInfo.add(offsets.lineCount).readS32(),
        lineInfo.add(ARRAY_LENGTH).readS32(),
        MAX_LINES,
    );
    if (characterCount <= 0 || lineCount <= 0) return null;

    const bands = [];
    for (let index = 0; index < lineCount; index += 1) {
        const entry = lineInfo.add(ARRAY_DATA + index * offsets.lineStride);
        bands.push({
            ascender: entry.add(lineMetrics.ascender).readFloat(),
            descender: entry.add(lineMetrics.descender).readFloat(),
        });
    }

    const cells = [];
    for (let index = 0; index < characterCount; index += 1) {
        const entry = characterInfo.add(ARRAY_DATA + index * offsets.characterStride);
        const lineNumber = entry.add(character.lineNumber).readS32();
        // Every cell on a line uses that line's band, so a line is one rectangle
        // strip and the overlay never has to guess where a row starts.
        const band = lineNumber >= 0 && lineNumber < bands.length
            ? bands[lineNumber]
            : {
                  ascender: entry.add(character.ascender).readFloat(),
                  descender: entry.add(character.descender).readFloat(),
              };
        const left = entry.add(character.origin).readFloat();
        const right = entry.add(character.xAdvance).readFloat();
        if (![left, right, band.ascender, band.descender].every(Number.isFinite)) return null;
        const topLeft = surface.toClient(left, band.ascender);
        const bottomRight = surface.toClient(right, band.descender);
        const x = Math.round(topLeft[0]);
        const y = Math.round(topLeft[1]);
        const width = Math.round(bottomRight[0] - topLeft[0]);
        const height = Math.round(bottomRight[1] - topLeft[1]);
        if (
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            Math.abs(x) > MAX_ABSOLUTE_COORDINATE ||
            Math.abs(y) > MAX_ABSOLUTE_COORDINATE ||
            width < 0 ||
            height < 0 ||
            width > MAX_GLYPH_DIMENSION ||
            height > MAX_GLYPH_DIMENSION
        ) {
            return null;
        }
        cells.push({ engineIndex: cells.length, code: entry.add(character.character).readU16(), x, y, width, height });
    }
    if (cells.length === 0) return null;

    // TextMeshPro stores one UTF-16 code unit per cell, so an astral character
    // arrives as a surrogate pair that has to be put back together.
    const merged = [];
    for (let index = 0; index < cells.length; index += 1) {
        const cell = cells[index];
        const next = cells[index + 1];
        if (cell.code >= 0xd800 && cell.code <= 0xdbff && next && next.code >= 0xdc00 && next.code <= 0xdfff) {
            merged.push({
                engineIndex: merged.length,
                code: (cell.code - 0xd800) * 0x400 + (next.code - 0xdc00) + 0x10000,
                x: cell.x,
                y: cell.y,
                width: next.x + next.width - cell.x,
                height: cell.height,
            });
            index += 1;
            continue;
        }
        merged.push({ ...cell, engineIndex: merged.length });
    }
    return merged;
}

// --- capture -----------------------------------------------------------------

let textComponentInstance = null;
let pending = null;
let sequence = 0;

function diagnostic(level, message) {
    send({ schema: 'gsm_engine_hook_message_v1', type: 'diagnostic', level, message });
}

Interceptor.attach(mono.compileMethod(methods.dialogue), {
    onEnter(args) {
        try {
            const instance = args[0];
            if (instance.isNull()) return;
            textComponentInstance = instance.add(offsets.textComponent).readPointer();
            if (textComponentInstance.isNull()) {
                textComponentInstance = null;
                return;
            }
            // The engine re-runs this call to re-apply the line already on screen
            // after a font or language change. That is the same text, so it is a
            // different capture mode and the package decides whether to take it.
            const updateOnly = args[dialogueConfig.updateOnlyArgumentIndex].toInt32() & 0xff ? 1 : 0;
            pending = config.capture.acceptedModes.includes(updateOnly)
                ? { mode: updateOnly, at: Date.now() }
                : null;
        } catch (error) {
            pending = null;
            diagnostic('warn', `Could not read the dialogue call: ${error.message}`);
        }
    },
});

Interceptor.attach(mono.compileMethod(methods.layout), {
    onEnter(args) {
        this.textComponent = args[0];
    },
    onLeave() {
        const textComponent = this.textComponent;
        if (
            !pending ||
            !textComponentInstance ||
            textComponent.isNull() ||
            !textComponent.equals(textComponentInstance)
        ) {
            return;
        }
        if (Date.now() - pending.at > PAIRING_WINDOW_MS) {
            pending = null;
            return;
        }
        let cells;
        let surface;
        try {
            surface = measureSurface(textComponent);
            cells = readCells(textComponent, surface);
        } catch (error) {
            pending = null;
            diagnostic('error', `Could not measure the dialogue layout: ${error.message}`);
            return;
        }
        // The engine clears the component before it reveals the line, so an empty
        // layout is that clear and the line is still to come.
        if (!cells) return;
        const mode = pending.mode;
        pending = null;
        sequence += 1;
        send({
            schema: 'gsm_engine_hook_message_v1',
            type: 'text-layout',
            integrationId: config.id,
            sequence,
            capturedAt: Date.now(),
            // Managed code is compiled into runtime-owned memory rather than into a
            // module, so there is no meaningful module offset to report.
            callerOffset: null,
            mode,
            style: 0,
            coordinateSpace: {
                kind: 'scaled-window-client',
                clientWidth: surface.client.width,
                clientHeight: surface.client.height,
                // Cells were resolved to client pixels above, so the logical space
                // is the client area itself.
                scaleX: 1,
                scaleY: 1,
            },
            positionedCodes: cells,
        });
    },
});

// --- advance -----------------------------------------------------------------

function advance() {
    const window = findMainWindow();
    if (window.isNull()) throw new Error('No visible target window was found.');
    const getForegroundWindow = new NativeFunction(
        Module.getGlobalExportByName('GetForegroundWindow'),
        'pointer',
        [],
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
    const showWindow = new NativeFunction(Module.getGlobalExportByName('ShowWindow'), 'bool', ['pointer', 'int32']);
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
    const keybdEvent = new NativeFunction(
        Module.getGlobalExportByName('keybd_event'),
        'void',
        ['uint8', 'uint8', 'uint32', 'pointer'],
    );

    const foregroundWindow = getForegroundWindow();
    const currentThread = getCurrentThreadId();
    const foregroundThread = foregroundWindow.isNull()
        ? 0
        : user32.getWindowThreadProcessId(foregroundWindow, NULL);
    const targetThread = user32.getWindowThreadProcessId(window, NULL);
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
            keybdEvent(config.advance.virtualKey, config.advance.scanCode, 0, NULL);
            // The engine acts on the key release and polls input per frame, so the
            // key is held across a few frames before it is let go.
            setTimeout(() => {
                keybdEvent(config.advance.virtualKey, config.advance.scanCode, 2, NULL);
                if (targetThread && targetThread !== currentThread) {
                    attachThreadInput(currentThread, targetThread, 0);
                }
                if (foregroundThread && foregroundThread !== currentThread) {
                    attachThreadInput(currentThread, foregroundThread, 0);
                }
                resolve({
                    window: window.toString(),
                    sequence,
                    delivery: 'foreground-keyboard',
                    activated,
                    foregroundAtDelivery,
                });
            }, 60);
        }, 50);
    });
}

function describe() {
    return {
        integrationId: config.id,
        module: monoModule.name,
        moduleBase: monoModule.base.toString(),
        moduleSize: monoModule.size,
        resolvedImages: Object.keys(images),
        dialogue: `${dialogueConfig.class}.${dialogueConfig.method}/${dialogueConfig.parameterCount}`,
        layout: `${layoutConfig.class}.${layoutConfig.method}/${layoutConfig.parameterCount}`,
        dialogueEntry: mono.compileMethod(methods.dialogue).toString(),
        layoutEntry: mono.compileMethod(methods.layout).toString(),
        offsets,
        characterFieldOffsets: character,
        lineFieldOffsets: lineMetrics,
        maximumGlyphs: MAX_GLYPHS,
    };
}

rpc.exports = {
    advance,
    diagnostics: describe,
};

send({
    schema: 'gsm_engine_hook_message_v1',
    type: 'ready',
    integrationId: config.id,
    diagnostics: describe(),
});
