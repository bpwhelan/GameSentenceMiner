'use strict';

// Injected half of probe-unity-mono.mjs. Everything is resolved through the Mono
// runtime's own metadata, so nothing here depends on a byte pattern or an RVA.

const DUMP = globalThis.__PROBE_DUMP__ || 'canvas';

const monoModule = Process.getModuleByName('mono-2.0-bdwgc.dll');

function exportByName(name) {
    const address = monoModule.findExportByName(name);
    if (!address) throw new Error('Missing Mono export ' + name);
    return address;
}

function api(name, retType, argTypes) {
    return new NativeFunction(exportByName(name), retType, argTypes);
}

const mono = {
    get_root_domain: api('mono_get_root_domain', 'pointer', []),
    thread_attach: api('mono_thread_attach', 'pointer', ['pointer']),
    assembly_foreach: api('mono_assembly_foreach', 'void', ['pointer', 'pointer']),
    assembly_get_name: api('mono_assembly_get_name', 'pointer', ['pointer']),
    assembly_name_get_name: api('mono_assembly_name_get_name', 'pointer', ['pointer']),
    assembly_get_image: api('mono_assembly_get_image', 'pointer', ['pointer']),
    class_from_name: api('mono_class_from_name', 'pointer', ['pointer', 'pointer', 'pointer']),
    class_get_method_from_name: api('mono_class_get_method_from_name', 'pointer', ['pointer', 'pointer', 'int']),
    class_get_field_from_name: api('mono_class_get_field_from_name', 'pointer', ['pointer', 'pointer']),
    class_get_fields: api('mono_class_get_fields', 'pointer', ['pointer', 'pointer']),
    class_get_name: api('mono_class_get_name', 'pointer', ['pointer']),
    class_array_element_size: api('mono_class_array_element_size', 'int', ['pointer']),
    field_get_name: api('mono_field_get_name', 'pointer', ['pointer']),
    field_get_offset: api('mono_field_get_offset', 'int', ['pointer']),
    compile_method: api('mono_compile_method', 'pointer', ['pointer']),
    object_get_class: api('mono_object_get_class', 'pointer', ['pointer']),
    object_unbox: api('mono_object_unbox', 'pointer', ['pointer']),
    runtime_invoke: api('mono_runtime_invoke', 'pointer', ['pointer', 'pointer', 'pointer', 'pointer']),
};

const rootDomain = mono.get_root_domain();
mono.thread_attach(rootDomain);

const cstrCache = {};
function cstr(text) {
    if (!cstrCache[text]) cstrCache[text] = Memory.allocUtf8String(text);
    return cstrCache[text];
}

function readCString(pointer) {
    return pointer.isNull() ? null : pointer.readUtf8String();
}

// The loaded set is enumerated rather than opened by path: Unity has already loaded
// every assembly the game uses.
const assemblies = {};
(function collectAssemblies() {
    const visit = new NativeCallback(
        (assembly) => {
            const name = readCString(mono.assembly_name_get_name(mono.assembly_get_name(assembly)));
            if (name) assemblies[name] = assembly;
        },
        'void',
        ['pointer', 'pointer'],
    );
    mono.assembly_foreach(visit, NULL);
})();

const imageCache = {};
function image(assemblyName) {
    if (!imageCache[assemblyName]) {
        const assembly = assemblies[assemblyName];
        if (!assembly) throw new Error('Assembly not loaded: ' + assemblyName);
        imageCache[assemblyName] = mono.assembly_get_image(assembly);
    }
    return imageCache[assemblyName];
}

function klass(assemblyName, namespace, name) {
    const found = mono.class_from_name(image(assemblyName), cstr(namespace), cstr(name));
    if (found.isNull()) throw new Error('Class not found: ' + namespace + '.' + name);
    return found;
}

function method(cls, name, argCount) {
    const found = mono.class_get_method_from_name(cls, cstr(name), argCount);
    if (found.isNull()) throw new Error('Method not found: ' + name + '/' + argCount);
    return found;
}

function optionalMethod(cls, name, argCount) {
    const found = mono.class_get_method_from_name(cls, cstr(name), argCount);
    return found.isNull() ? null : found;
}

function fieldOffset(cls, name) {
    const field = mono.class_get_field_from_name(cls, cstr(name));
    if (field.isNull()) throw new Error('Field not found: ' + name);
    return mono.field_get_offset(field);
}

// MonoString on 32-bit: MonoObject (8) + int32 length + UTF-16 payload.
function readMonoString(pointer) {
    if (!pointer || pointer.isNull()) return null;
    const length = pointer.add(8).readS32();
    if (length < 0 || length > 20000) return '<bad length ' + length + '>';
    return pointer.add(12).readUtf16String(length);
}

function classNameOf(object) {
    return !object || object.isNull() ? null : readCString(mono.class_get_name(mono.object_get_class(object)));
}

const exceptionSlot = Memory.alloc(Process.pointerSize);
function invoke(monoMethod, instance, args) {
    exceptionSlot.writePointer(NULL);
    let argv = NULL;
    if (args && args.length > 0) {
        argv = Memory.alloc(Process.pointerSize * args.length);
        for (let i = 0; i < args.length; i += 1) argv.add(Process.pointerSize * i).writePointer(args[i]);
    }
    const result = mono.runtime_invoke(monoMethod, instance || NULL, argv, exceptionSlot);
    const exception = exceptionSlot.readPointer();
    if (!exception.isNull()) throw new Error('Managed exception from ' + classNameOf(exception));
    return result;
}

function invokeInt(monoMethod, instance) {
    const boxed = invoke(monoMethod, instance, []);
    return boxed.isNull() ? null : mono.object_unbox(boxed).readS32();
}

function invokeFloat(monoMethod, instance) {
    const boxed = invoke(monoMethod, instance, []);
    return boxed.isNull() ? null : mono.object_unbox(boxed).readFloat();
}

function invokeObject(monoMethod, instance) {
    const result = invoke(monoMethod, instance, []);
    return result.isNull() ? null : result;
}

function invokeRect(monoMethod, instance) {
    const boxed = invoke(monoMethod, instance, []);
    if (boxed.isNull()) return null;
    const raw = mono.object_unbox(boxed);
    return [raw.readFloat(), raw.add(4).readFloat(), raw.add(8).readFloat(), raw.add(12).readFloat()];
}

function invokeMatrix(monoMethod, instance) {
    const boxed = invoke(monoMethod, instance, []);
    if (boxed.isNull()) return null;
    const raw = mono.object_unbox(boxed);
    const values = [];
    for (let i = 0; i < 16; i += 1) values.push(raw.add(i * 4).readFloat());
    return values;
}

// --- resolved metadata -------------------------------------------------------

const UIAdv = klass('Assembly-CSharp', '', 'UIAdv');
const TMP_Text = klass('Unity.TextMeshPro', 'TMPro', 'TMP_Text');
const TextMeshProUGUI = klass('Unity.TextMeshPro', 'TMPro', 'TextMeshProUGUI');
const TMP_TextInfo = klass('Unity.TextMeshPro', 'TMPro', 'TMP_TextInfo');
const TMP_CharacterInfo = klass('Unity.TextMeshPro', 'TMPro', 'TMP_CharacterInfo');
const TMP_LineInfo = klass('Unity.TextMeshPro', 'TMPro', 'TMP_LineInfo');
const Canvas = klass('UnityEngine.UIModule', 'UnityEngine', 'Canvas');
const Camera = klass('UnityEngine.CoreModule', 'UnityEngine', 'Camera');
const Screen = klass('UnityEngine.CoreModule', 'UnityEngine', 'Screen');
const Transform = klass('UnityEngine.CoreModule', 'UnityEngine', 'Transform');
const Component = klass('UnityEngine.CoreModule', 'UnityEngine', 'Component');
const RenderTexture = klass('UnityEngine.CoreModule', 'UnityEngine', 'RenderTexture');
const UnityObject = klass('UnityEngine.CoreModule', 'UnityEngine', 'Object');

const offsets = {
    advtext: fieldOffset(UIAdv, 'advtext'),
    textInfo: fieldOffset(TMP_Text, 'm_textInfo'),
    rectTransform: fieldOffset(TMP_Text, 'm_rectTransform'),
    text: fieldOffset(TMP_Text, 'm_text'),
    canvas: fieldOffset(TextMeshProUGUI, 'm_canvas'),
    characterCount: fieldOffset(TMP_TextInfo, 'characterCount'),
    lineCount: fieldOffset(TMP_TextInfo, 'lineCount'),
    characterInfo: fieldOffset(TMP_TextInfo, 'characterInfo'),
    lineInfo: fieldOffset(TMP_TextInfo, 'lineInfo'),
    characterInfoStride: mono.class_array_element_size(TMP_CharacterInfo),
    lineInfoStride: mono.class_array_element_size(TMP_LineInfo),
};

// Value-type field offsets include the MonoObject header; array elements are packed.
const HEADER = Process.pointerSize * 2;
const charField = (name) => fieldOffset(TMP_CharacterInfo, name) - HEADER;
const lineField = (name) => fieldOffset(TMP_LineInfo, name) - HEADER;
const charInfo = {
    character: charField('character'),
    index: charField('index'),
    lineNumber: charField('lineNumber'),
    topLeft: charField('topLeft'),
    bottomLeft: charField('bottomLeft'),
    topRight: charField('topRight'),
    bottomRight: charField('bottomRight'),
    origin: charField('origin'),
    xAdvance: charField('xAdvance'),
    ascender: charField('ascender'),
    descender: charField('descender'),
    scale: charField('scale'),
    isVisible: charField('isVisible'),
};
const lineInfoOffsets = {
    firstCharacterIndex: lineField('firstCharacterIndex'),
    lastCharacterIndex: lineField('lastCharacterIndex'),
    characterCount: lineField('characterCount'),
    lineHeight: lineField('lineHeight'),
    ascender: lineField('ascender'),
    baseline: lineField('baseline'),
    descender: lineField('descender'),
};

const methods = {
    canvasRenderMode: method(Canvas, 'get_renderMode', 0),
    canvasWorldCamera: method(Canvas, 'get_worldCamera', 0),
    canvasScaleFactor: method(Canvas, 'get_scaleFactor', 0),
    canvasRootCanvas: method(Canvas, 'get_rootCanvas', 0),
    screenWidth: method(Screen, 'get_width', 0),
    screenHeight: method(Screen, 'get_height', 0),
    localToWorld: method(Transform, 'get_localToWorldMatrix', 0),
    componentTransform: method(Component, 'get_transform', 0),
    objectName: method(UnityObject, 'get_name', 0),
    cameraTargetTexture: method(Camera, 'get_targetTexture', 0),
    cameraWorldToCamera: optionalMethod(Camera, 'get_worldToCameraMatrix', 0),
    cameraProjection: optionalMethod(Camera, 'get_projectionMatrix', 0),
    cameraRect: optionalMethod(Camera, 'get_rect', 0),
    cameraPixelRect: optionalMethod(Camera, 'get_pixelRect', 0),
    cameraWorldToScreenPoint: optionalMethod(Camera, 'WorldToScreenPoint', 1),
    cameraPixelWidth: optionalMethod(Camera, 'get_pixelWidth', 0),
    cameraPixelHeight: optionalMethod(Camera, 'get_pixelHeight', 0),
    renderTextureWidth: method(RenderTexture, 'get_width', 0),
    renderTextureHeight: method(RenderTexture, 'get_height', 0),
};

// The UI canvas is a plane, so world-to-screen is affine over it. Three reference
// points through the engine's own Camera.WorldToScreenPoint pin that map down
// exactly, which is far cheaper than one managed call per glyph corner.
const vectorArg = Memory.alloc(12);
const argvSlot = Memory.alloc(Process.pointerSize);
function worldToScreen(camera, x, y, z) {
    vectorArg.writeFloat(x);
    vectorArg.add(4).writeFloat(y);
    vectorArg.add(8).writeFloat(z);
    argvSlot.writePointer(vectorArg);
    exceptionSlot.writePointer(NULL);
    const boxed = mono.runtime_invoke(methods.cameraWorldToScreenPoint, camera, argvSlot, exceptionSlot);
    if (!exceptionSlot.readPointer().isNull()) throw new Error('WorldToScreenPoint threw.');
    const raw = mono.object_unbox(boxed);
    return [raw.readFloat(), raw.add(4).readFloat()];
}

function localToWorldPoint(matrix, x, y) {
    return [
        matrix[0] * x + matrix[4] * y + matrix[12],
        matrix[1] * x + matrix[5] * y + matrix[13],
        matrix[2] * x + matrix[6] * y + matrix[14],
    ];
}

function deriveScreenTransform(camera, matrix) {
    const origin = localToWorldPoint(matrix, 0, 0);
    const unitX = localToWorldPoint(matrix, 1, 0);
    const unitY = localToWorldPoint(matrix, 0, 1);
    const s0 = worldToScreen(camera, origin[0], origin[1], origin[2]);
    const sx = worldToScreen(camera, unitX[0], unitX[1], unitX[2]);
    const sy = worldToScreen(camera, unitY[0], unitY[1], unitY[2]);
    return {
        originX: s0[0],
        originY: s0[1],
        xAxis: [sx[0] - s0[0], sx[1] - s0[1]],
        yAxis: [sy[0] - s0[0], sy[1] - s0[1]],
    };
}

function applyScreenTransform(transform, x, y) {
    return [
        transform.originX + x * transform.xAxis[0] + y * transform.yAxis[0],
        transform.originY + x * transform.xAxis[1] + y * transform.yAxis[1],
    ];
}

// MonoArray on 32-bit: MonoObject (8) + bounds (4) + max_length (4).
const ARRAY_DATA = 16;
const ARRAY_LENGTH = 12;

function readVector3(base, offset) {
    return [base.add(offset).readFloat(), base.add(offset + 4).readFloat(), base.add(offset + 8).readFloat()];
}

let advtextInstance = null;
let pendingLine = null;

function describeCanvas(canvas) {
    if (!canvas || canvas.isNull()) return null;
    const rootCanvas = invokeObject(methods.canvasRootCanvas, canvas);
    const worldCamera = invokeObject(methods.canvasWorldCamera, canvas);
    let cameraInfo = null;
    if (worldCamera) {
        const targetTexture = invokeObject(methods.cameraTargetTexture, worldCamera);
        cameraInfo = {
            name: readMonoString(invokeObject(methods.objectName, worldCamera)),
            pixelWidth: methods.cameraPixelWidth ? invokeInt(methods.cameraPixelWidth, worldCamera) : null,
            pixelHeight: methods.cameraPixelHeight ? invokeInt(methods.cameraPixelHeight, worldCamera) : null,
            worldToCamera: methods.cameraWorldToCamera ? invokeMatrix(methods.cameraWorldToCamera, worldCamera) : null,
            projection: methods.cameraProjection ? invokeMatrix(methods.cameraProjection, worldCamera) : null,
            rect: methods.cameraRect ? invokeRect(methods.cameraRect, worldCamera) : null,
            pixelRect: methods.cameraPixelRect ? invokeRect(methods.cameraPixelRect, worldCamera) : null,
            hasWorldToScreenPoint: methods.cameraWorldToScreenPoint !== null,
            targetTexture: targetTexture
                ? {
                      width: invokeInt(methods.renderTextureWidth, targetTexture),
                      height: invokeInt(methods.renderTextureHeight, targetTexture),
                  }
                : null,
        };
    }
    return {
        name: readMonoString(invokeObject(methods.objectName, canvas)),
        renderMode: invokeInt(methods.canvasRenderMode, canvas),
        scaleFactor: invokeFloat(methods.canvasScaleFactor, canvas),
        rootName: rootCanvas ? readMonoString(invokeObject(methods.objectName, rootCanvas)) : null,
        rootRenderMode: rootCanvas ? invokeInt(methods.canvasRenderMode, rootCanvas) : null,
        rootScaleFactor: rootCanvas ? invokeFloat(methods.canvasScaleFactor, rootCanvas) : null,
        camera: cameraInfo,
    };
}

function readLayout(tmp, sampleSize) {
    const textInfo = tmp.add(offsets.textInfo).readPointer();
    if (textInfo.isNull()) return null;
    const characterCount = textInfo.add(offsets.characterCount).readS32();
    const lineCount = textInfo.add(offsets.lineCount).readS32();
    const characterInfo = textInfo.add(offsets.characterInfo).readPointer();
    const lineInfo = textInfo.add(offsets.lineInfo).readPointer();
    if (characterInfo.isNull() || characterCount <= 0) return null;
    const capacity = characterInfo.add(ARRAY_LENGTH).readS32();
    const count = Math.min(characterCount, capacity, 2000);
    const characters = [];
    for (let i = 0; i < count; i += 1) {
        const entry = characterInfo.add(ARRAY_DATA + i * offsets.characterInfoStride);
        characters.push({
            i,
            ch: String.fromCharCode(entry.add(charInfo.character).readU16()),
            index: entry.add(charInfo.index).readS32(),
            line: entry.add(charInfo.lineNumber).readS32(),
            visible: entry.add(charInfo.isVisible).readU8() !== 0,
            origin: entry.add(charInfo.origin).readFloat(),
            xAdvance: entry.add(charInfo.xAdvance).readFloat(),
            bl: readVector3(entry, charInfo.bottomLeft),
            tr: readVector3(entry, charInfo.topRight),
            ascender: entry.add(charInfo.ascender).readFloat(),
            descender: entry.add(charInfo.descender).readFloat(),
            scale: entry.add(charInfo.scale).readFloat(),
        });
    }
    const lines = [];
    if (!lineInfo.isNull()) {
        const lineCapacity = lineInfo.add(ARRAY_LENGTH).readS32();
        for (let i = 0; i < Math.min(lineCount, lineCapacity, 64); i += 1) {
            const entry = lineInfo.add(ARRAY_DATA + i * offsets.lineInfoStride);
            lines.push({
                i,
                first: entry.add(lineInfoOffsets.firstCharacterIndex).readS32(),
                last: entry.add(lineInfoOffsets.lastCharacterIndex).readS32(),
                count: entry.add(lineInfoOffsets.characterCount).readS32(),
                ascender: entry.add(lineInfoOffsets.ascender).readFloat(),
                baseline: entry.add(lineInfoOffsets.baseline).readFloat(),
                descender: entry.add(lineInfoOffsets.descender).readFloat(),
            });
        }
    }
    const text = characters.map((entry) => entry.ch).join('');
    return {
        characterCount,
        lineCount,
        text,
        lines,
        characters: sampleSize > 0 ? characters.slice(0, sampleSize).concat(characters.slice(-sampleSize)) : characters,
    };
}

const user32 = {
    getClientRect: new NativeFunction(Module.getGlobalExportByName('GetClientRect'), 'bool', ['pointer', 'pointer']),
    getActiveWindow: new NativeFunction(Module.getGlobalExportByName('GetActiveWindow'), 'pointer', []),
    enumWindows: new NativeFunction(Module.getGlobalExportByName('EnumWindows'), 'bool', ['pointer', 'pointer']),
    getWindowThreadProcessId: new NativeFunction(
        Module.getGlobalExportByName('GetWindowThreadProcessId'),
        'uint32',
        ['pointer', 'pointer'],
    ),
    isWindowVisible: new NativeFunction(Module.getGlobalExportByName('IsWindowVisible'), 'bool', ['pointer']),
};

// The game's own window is the only visible top-level window it owns.
function findMainWindow() {
    let best = NULL;
    let bestArea = 0;
    const pidSlot = Memory.alloc(4);
    const rect = Memory.alloc(16);
    const callback = new NativeCallback(
        (hwnd) => {
            user32.getWindowThreadProcessId(hwnd, pidSlot);
            if (pidSlot.readU32() !== Process.id || !user32.isWindowVisible(hwnd)) return 1;
            user32.getClientRect(hwnd, rect);
            const area = rect.add(8).readS32() * rect.add(12).readS32();
            if (area > bestArea) {
                bestArea = area;
                best = hwnd;
            }
            return 1;
        },
        'int',
        ['pointer', 'pointer'],
    );
    user32.enumWindows(callback, NULL);
    return best;
}

function clientSize() {
    const window = findMainWindow();
    if (window.isNull()) return null;
    const rect = Memory.alloc(16);
    user32.getClientRect(window, rect);
    return { hwnd: window.toString(), width: rect.add(8).readS32(), height: rect.add(12).readS32() };
}

// --- live hooks --------------------------------------------------------------

Interceptor.attach(mono.compile_method(method(UIAdv, 'ShowText', 3)), {
    onEnter(args) {
        advtextInstance = args[0].add(offsets.advtext).readPointer();
        pendingLine = {
            txin: readMonoString(args[1]),
            dispnamein: readMonoString(args[2]),
            updateonly: args[3].toInt32() & 0xff,
        };
        send({ type: 'ShowText', advtext: advtextInstance.toString(), line: pendingLine });
    },
});

Interceptor.attach(mono.compile_method(method(UIAdv, 'EnsureTextFit', 1)), {
    onEnter(args) {
        send({ type: 'EnsureTextFit', tx: readMonoString(args[1]) });
    },
});

Interceptor.attach(mono.compile_method(method(TextMeshProUGUI, 'GenerateTextMesh', 0)), {
    onEnter(args) {
        this.tmp = args[0];
    },
    onLeave() {
        const tmp = this.tmp;
        if (!advtextInstance || !tmp.equals(advtextInstance) || !pendingLine) return;
        const layout = readLayout(tmp, DUMP === 'layout' ? 0 : 3);
        if (!layout) return;
        pendingLine = null;
        const canvas = tmp.add(offsets.canvas).readPointer();
        const transform = invokeObject(methods.componentTransform, tmp);
        const camera = invokeObject(methods.canvasWorldCamera, canvas);
        const matrix = invokeMatrix(methods.localToWorld, transform);
        const screenHeight = invokeInt(methods.screenHeight, null);
        let boxes = null;
        if (camera && matrix) {
            const screenTransform = deriveScreenTransform(camera, matrix);
            boxes = { screenTransform, glyphs: [] };
            const full = readLayout(tmp, 0);
            // Cells come from the pen advance and the line's own ascender/descender, so
            // every glyph on a line shares one vertical band and the cells tile the line.
            for (const glyph of full.characters) {
                const line = full.lines[glyph.line] || { ascender: glyph.ascender, descender: glyph.descender };
                const topLeft = applyScreenTransform(screenTransform, glyph.origin, line.ascender);
                const bottomRight = applyScreenTransform(screenTransform, glyph.xAdvance, line.descender);
                boxes.glyphs.push({
                    ch: glyph.ch,
                    line: glyph.line,
                    code: glyph.ch.charCodeAt(0),
                    x: Math.round(topLeft[0]),
                    y: Math.round(screenHeight - topLeft[1]),
                    width: Math.round(bottomRight[0] - topLeft[0]),
                    height: Math.round(topLeft[1] - bottomRight[1]),
                });
            }
        }
        send({
            boxes,
            type: 'layout',
            currentText: readMonoString(tmp.add(offsets.text).readPointer()),
            screen: { width: invokeInt(methods.screenWidth, null), height: invokeInt(methods.screenHeight, null) },
            client: clientSize(),
            canvas: describeCanvas(canvas),
            localToWorld: invokeMatrix(methods.localToWorld, transform),
            layout,
        });
    },
});

send({ type: 'ready', dump: DUMP, offsets, charInfo, lineInfoOffsets });
