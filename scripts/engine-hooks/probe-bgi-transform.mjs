#!/usr/bin/env node

// Compose the BGI/Ethornell glyph-to-client coordinate transform.
//
// Glyph positions are authored in a dedicated dialogue text bitmap, which reaches
// the screen through a chain of software surface copies ending in the locked
// Direct3D texture. Two routines perform those copies, and both take the same pair
// of descriptors (ecx destination, edx source): the MMX block copy, and an SSE
// alpha blend which is how the text bitmap itself is composited.
//
// Each copy is a rectangle move, so it maps an address in one surface to an address
// in another. Recording every copy and following a glyph's address through them
// until it lands in the locked layer yields client coordinates without assuming the
// shape or length of the chain. Every base, stride and rectangle is read live, and
// the routines are resolved by unique signature.

import fs from 'node:fs';
import process from 'node:process';

import frida from 'frida';

function option(name, fallback = null) {
    const prefix = `--${name}=`;
    const match = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
    return match?.slice(prefix.length) ?? fallback;
}

const pid = Number.parseInt(option('pid') ?? '', 10);
const seconds = Number.parseInt(option('seconds') ?? '30', 10);
const windowMs = Number.parseInt(option('window') ?? '1200', 10);
const lockRva = option('lockrva', '0x63ee0');
const drawRva = option('draw', null);
const textRva = option('text', null);
const dispatcherRva = option('dispatcher', null);
if (!Number.isInteger(pid) || pid <= 0) {
    console.error('Usage: node scripts/engine-hooks/probe-bgi-transform.mjs --pid=<pid>');
    process.exit(2);
}

const source = `
'use strict';
const main = Process.mainModule;
const mainEnd = main.base.add(main.size);

function off(a) {
    return a.compare(main.base) >= 0 && a.compare(mainEnd) < 0
        ? '0x' + a.sub(main.base).toString(16)
        : String(a);
}

function scanUnique(label, pattern) {
    const hits = [];
    for (const range of Process.enumerateRanges({ protection: 'r-x', coalesce: false })) {
        if (range.base.compare(main.base) < 0 || range.base.compare(mainEnd) >= 0) continue;
        for (const m of Memory.scanSync(range.base, range.size, pattern)) hits.push(m.address);
    }
    if (hits.length !== 1) {
        throw new Error(label + ': expected 1 signature match, got ' + hits.length +
            ' [' + hits.map(off).join(', ') + ']');
    }
    return hits[0];
}

const drawFn = ${drawRva ? `main.base.add(${JSON.stringify(drawRva)})` :
    "scanUnique('glyph draw', '55 8b ec 83 e4 f0 83 ec 38 56 57 8b f9 8d 44 24 10 50 0f 10 87 94 01 00 00')"};
const textFn = ${textRva ? `main.base.add(${JSON.stringify(textRva)})` :
    "scanUnique('BGI4 text', '55 8B EC 53 56 57 33 FF E8 ?? ?? ?? ?? 8B F0')"};

// Every surface copy in the engine goes through one family of routines taking the
// same descriptor pair, selected by the pixel format at descriptor +0x10. A small
// dispatcher picks the variant, so its own call targets enumerate the family: the
// variants are read out of the dispatcher rather than each being signature-matched.
const dispatcher = ${dispatcherRva ? `main.base.add(${JSON.stringify(dispatcherRva)})` :
    "scanUnique('copy dispatcher', '51 8b 42 10 83 e8 00 74 ?? 83 e8 01 74 ?? 83 e8 01 75')"};
const copyFns = [];
{
    let cursor = dispatcher;
    const end = dispatcher.add(0x60);
    while (cursor.compare(end) < 0) {
        let instruction;
        try { instruction = Instruction.parse(cursor); } catch (e) { break; }
        if (instruction.mnemonic === 'call') {
            const target = ptr(instruction.opStr);
            if (target.compare(main.base) >= 0 && target.compare(mainEnd) < 0) {
                if (!copyFns.some((f) => f.equals(target))) copyFns.push(target);
            }
        }
        cursor = instruction.next;
    }
}
if (copyFns.length < 2) throw new Error('copy dispatcher: found ' + copyFns.length + ' variants');

const d3d9 = Process.getModuleByName('d3d9.dll');
const lockRect = d3d9.base.add(${JSON.stringify(lockRva)});

// Several textures are locked; each destination has to be attributed to the right
// one, so every distinct lock is reported rather than only the most recent.
const layers = {};
Interceptor.attach(lockRect, {
    onEnter(args) { this._out = args[2]; },
    onLeave() {
        if (this._out === undefined) return;
        try {
            const pitch = this._out.readS32();
            const bits = this._out.add(4).readPointer();
            if (bits.isNull() || pitch <= 0) return;
            const key = bits.toString();
            if (layers[key] === pitch) return;
            layers[key] = pitch;
            send({ kind: 'layer', base: key, pitch });
        } catch (e) {}
    },
});

let recording = false;
let generation = 0;

Interceptor.attach(textFn, {
    onEnter() {
        let text = null;
        try {
            const eax = this.context.eax;
            if ((eax.toUInt32() >>> 0) >= 0x10000) text = eax.readUtf16String(200);
        } catch (e) {}
        if (!text) return;
        generation++;
        recording = true;
        send({
            kind: 'message',
            generation,
            text,
            caller: off(this.returnAddress),
        });
        setTimeout(() => { recording = false; }, ${windowMs});
    },
});

Interceptor.attach(drawFn, {
    onEnter(args) {
        if (!recording) return;
        const cell = [];
        try {
            for (let i = 0; i < 8; i++) cell.push(args[3].add(i * 4).readS32());
        } catch (e) {}
        // The bitmap descriptor is inline in the renderer object; which dword holds
        // the pixel pointer is decided later, by matching it against a blit source.
        const desc = [];
        try {
            for (let i = 0; i < 8; i++) desc.push(this.context.ecx.add(0x194 + i * 4).readU32());
        } catch (e) {}
        send({
            kind: 'glyph',
            generation,
            caller: off(this.returnAddress),
            x: args[1].toInt32(),
            y: args[2].toInt32(),
            mode: args[4].toInt32(),
            cell,
            desc,
        });
    },
});

// Both copy routines share the descriptor pair, so one recorder serves both.
function recordCopy(op) {
    return {
        onEnter() {
            if (!recording) return;
            const c = this.context;
            try {
                send({
                    kind: 'copy',
                    op,
                    generation,
                    caller: off(this.returnAddress),
                    dst: c.ecx.readU32(),
                    dstStride: c.ecx.add(4).readS32(),
                    src: c.edx.readU32(),
                    srcStride: c.edx.add(4).readS32(),
                    width: c.edx.add(8).readS32(),
                    height: c.edx.add(0xc).readS32(),
                    bpp: c.edx.add(0x14).readS32(),
                });
            } catch (e) {}
        },
    };
}

for (const fn of copyFns) Interceptor.attach(fn, recordCopy(off(fn)));

send({
    kind: 'ready',
    draw: off(drawFn),
    text: off(textFn),
    dispatcher: off(dispatcher),
    copies: copyFns.map(off),
});
`;

const session = await frida.attach(pid);
const script = await session.createScript(source, { runtime: 'qjs' });

const messages = new Map();
const glyphs = [];
const copies = [];
const layers = [];
let sequence = 0;

script.message.connect((m) => {
    if (m.type === 'error') {
        console.error('SCRIPT ERROR:', m.stack || m.description);
        return;
    }
    const p = m.payload;
    if (!p) return;
    if (p.kind === 'ready') {
        console.log(
            `resolved: draw=${p.draw} text=${p.text} dispatcher=${p.dispatcher} ` +
                `copy variants=[${p.copies.join(', ')}]`,
        );
        return;
    }
    if (p.kind === 'layer') {
        layers.push({ base: Number(BigInt(p.base)), pitch: p.pitch });
        console.log(`layer base=${p.base} pitch=${p.pitch} width=${p.pitch / 4}`);
        return;
    }
    if (p.kind === 'message') {
        messages.set(p.generation, p);
        console.log(`\n=== #${p.generation} caller=${p.caller} ${JSON.stringify(p.text.slice(0, 48))}`);
        return;
    }
    if (p.kind === 'glyph') glyphs.push({ ...p, seq: sequence++ });
    if (p.kind === 'copy') copies.push({ ...p, seq: sequence++ });
});

await script.load();
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

try {
    if (!script.isDestroyed) await script.unload();
} finally {
    if (!session.isDetached()) await session.detach();
}

// --- composition -----------------------------------------------------------

function mapThroughCopy(address, copy) {
    // A copy is a rectangle move: same (dx,dy) in both surfaces, different strides.
    const delta = address - copy.src;
    if (delta < 0) return null;
    const dy = Math.floor(delta / copy.srcStride);
    const dx = (delta - dy * copy.srcStride) / copy.bpp;
    if (!Number.isInteger(dx) || dx < 0 || dx >= copy.width || dy >= copy.height) return null;
    return copy.dst + dy * copy.dstStride + dx * copy.bpp;
}

// A frame is at most a couple of thousand rows; anything further into a lock is a
// different surface that happens to sit above it in the heap.
const MAX_LAYER_ROWS = 2048;

function locate(address) {
    let best = null;
    for (const l of layers) {
        const offset = address - l.base;
        if (offset < 0 || offset >= l.pitch * MAX_LAYER_ROWS) continue;
        if (best === null || l.base > best.base) best = l;
    }
    if (!best) return null;
    const offset = address - best.base;
    return { layer: best, x: (offset % best.pitch) / 4, y: Math.floor(offset / best.pitch) };
}

// Follow an address through the copies that ran after it was written, until it
// lands in the locked layer. Dead ends exist — the text bitmap is also copied to a
// same-size backup — so alternatives are explored rather than the first match taken.
function follow(address, candidates, depth, path) {
    const located = locate(address);
    if (located) return { located, path };
    if (depth === 0) return null;
    for (const copy of candidates) {
        const next = mapThroughCopy(address, copy);
        if (next === null) continue;
        const found = follow(
            next,
            candidates.filter((c) => c.seq > copy.seq),
            depth - 1,
            [...path, copy],
        );
        if (found) return found;
    }
    return null;
}

const report = [];
for (const [gen, message] of messages) {
    const own = glyphs.filter((g) => g.generation === gen);
    if (!own.length) continue;

    const seen = new Set();
    const unique = own.filter((g) => {
        const key = `${g.x},${g.y}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    const genCopies = copies.filter((c) => c.generation === gen && c.bpp > 0 && c.srcStride > 0);
    const sources = new Set(genCopies.map((c) => c.src));
    // The descriptor dword that is also a copy source is the text bitmap's pixels.
    const descriptor = unique[0].desc;
    const pointerIndex = descriptor.findIndex((value) => sources.has(value));
    if (pointerIndex < 0) {
        report.push({ gen, text: message.text, error: 'text bitmap never copied in window' });
        continue;
    }
    const bitmapPointer = descriptor[pointerIndex];
    const bitmapStride = descriptor[pointerIndex + 1];

    const boxes = [];
    let unmapped = 0;
    let chain = null;
    for (const g of unique) {
        const address = bitmapPointer + g.y * bitmapStride + g.x * 4;
        const after = genCopies.filter((c) => c.seq > g.seq);
        const found = follow(address, after, 6, []);
        if (!found) {
            unmapped++;
            continue;
        }
        chain ??= found.path.map((c) => `${c.op}@${c.caller} ${c.width}x${c.height}`);
        // The copy that moved this glyph out of the text bitmap is its exact extent.
        const extent = found.path[0];
        boxes.push({
            x: found.located.x,
            y: found.located.y,
            w: extent.width,
            h: extent.height,
            src: [g.x, g.y],
        });
    }

    report.push({
        gen,
        text: message.text,
        length: message.text.length,
        draws: own.length,
        unique: unique.length,
        bitmap: { pointer: bitmapPointer, stride: bitmapStride, index: pointerIndex },
        copies: genCopies.length,
        chain,
        unmapped,
        boxes,
    });
}

for (const r of report) {
    console.log(`\n### #${r.gen} ${JSON.stringify((r.text ?? '').slice(0, 48))}`);
    if (r.error) {
        console.log(`    ERROR: ${r.error}`);
        continue;
    }
    console.log(
        `    len=${r.length} draws=${r.draws} unique=${r.unique} copies=${r.copies} ` +
            `bitmapStride=${r.bitmap.stride} unmapped=${r.unmapped}`,
    );
    if (r.chain) console.log(`    chain: ${r.chain.join('  ->  ')}`);
    // A pure translation collapses to one origin; anything else means the chain
    // scales, which a payload would have to carry through.
    const origins = new Map();
    const rows = new Map();
    for (const b of r.boxes) {
        const key = `${b.x - b.src[0]},${b.y - b.src[1]}`;
        origins.set(key, (origins.get(key) ?? 0) + 1);
        rows.set(b.y, (rows.get(b.y) ?? 0) + 1);
    }
    console.log(`    origins: ${JSON.stringify([...origins.entries()])}`);
    console.log(`    rows: ${JSON.stringify([...rows.entries()])}`);
    for (const b of r.boxes.slice(0, 48)) {
        console.log(
            `      (${String(b.x).padStart(4)},${String(b.y).padStart(4)}) ` +
                `${String(b.w).padStart(3)}x${String(b.h).padStart(3)}  from (${b.src[0]},${b.src[1]})`,
        );
    }
}

const out = option('out');
if (out) {
    fs.writeFileSync(
        out,
        JSON.stringify({ layers, report, raw: { messages: [...messages.values()], glyphs, copies } }, null, 1),
    );
    console.log(`\nwrote ${out}`);
}
