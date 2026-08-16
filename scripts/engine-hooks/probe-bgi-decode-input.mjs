#!/usr/bin/env node

// Capture exactly what a BGI/Ethornell decoder will be handed.
//
// The BGI4 hook yields a UTF-16 string and the glyph draw yields one position per
// displayed character. A decoder has to pair the two, so what matters is whether
// the string is already the displayed text: whether it carries control codes or
// markup, and whether its length matches the drawn glyph count.
//
// Every code unit is reported, not the printable rendering, so anything below
// U+0020 is visible rather than swallowed by the console.

import fs from 'node:fs';
import process from 'node:process';

import frida from 'frida';

function option(name, fallback = null) {
    const prefix = `--${name}=`;
    const match = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
    return match?.slice(prefix.length) ?? fallback;
}

const pid = Number.parseInt(option('pid') ?? '', 10);
const seconds = Number.parseInt(option('seconds') ?? '40', 10);
const windowMs = Number.parseInt(option('window') ?? '3000', 10);
if (!Number.isInteger(pid) || pid <= 0) {
    console.error('Usage: node scripts/engine-hooks/probe-bgi-decode-input.mjs --pid=<pid>');
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
    if (hits.length !== 1) throw new Error(label + ': ' + hits.length + ' matches');
    return hits[0];
}

const drawFn = scanUnique('glyph draw', '55 8b ec 83 e4 f0 83 ec 38 56 57 8b f9 8d 44 24 10 50 0f 10 87 94 01 00 00');
const textFn = scanUnique('BGI4 text', '55 8B EC 53 56 57 33 FF E8 ?? ?? ?? ?? 8B F0');

let recording = false;
let generation = 0;

Interceptor.attach(textFn, {
    onEnter() {
        const eax = this.context.eax;
        if ((eax.toUInt32() >>> 0) < 0x10000) return;
        // Read the raw units up to the terminator rather than letting the string
        // reader decide where the text ends.
        const units = [];
        try {
            for (let i = 0; i < 400; i++) {
                const unit = eax.add(i * 2).readU16();
                if (unit === 0) break;
                units.push(unit);
            }
        } catch (e) {}
        if (!units.length) return;
        generation++;
        recording = true;
        send({ kind: 'message', generation, units, caller: off(this.returnAddress) });
        setTimeout(() => { recording = false; }, ${windowMs});
    },
});

Interceptor.attach(drawFn, {
    onEnter(args) {
        if (!recording) return;
        send({ kind: 'glyph', generation, x: args[1].toInt32(), y: args[2].toInt32() });
    },
});

send({ kind: 'ready', draw: off(drawFn), text: off(textFn) });
`;

const session = await frida.attach(pid);
const script = await session.createScript(source, { runtime: 'qjs' });
const messages = new Map();

script.message.connect((m) => {
    if (m.type === 'error') {
        console.error('SCRIPT ERROR:', m.stack || m.description);
        return;
    }
    const p = m.payload;
    if (!p) return;
    if (p.kind === 'ready') console.log(`resolved: draw=${p.draw} text=${p.text}`);
    if (p.kind === 'message') messages.set(p.generation, { ...p, positions: new Set() });
    if (p.kind === 'glyph') messages.get(p.generation)?.positions.add(`${p.x},${p.y}`);
});

await script.load();
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

try {
    if (!script.isDestroyed) await script.unload();
} finally {
    if (!session.isDetached()) await session.detach();
}

const controlCounts = new Map();
let mismatches = 0;
let compared = 0;

for (const entry of messages.values()) {
    const text = String.fromCharCode(...entry.units);
    const controls = entry.units.filter((unit) => unit < 0x20);
    for (const unit of controls) controlCounts.set(unit, (controlCounts.get(unit) ?? 0) + 1);
    const drawn = entry.positions.size;
    const matched = drawn === entry.units.length;
    if (drawn > 0) {
        compared++;
        if (!matched) mismatches++;
    }
    console.log(
        `\n#${entry.generation} caller=${entry.caller} units=${entry.units.length} drawn=${drawn}` +
            (drawn === 0 ? ' (no draws)' : matched ? ' match' : ' MISMATCH'),
    );
    console.log(`   ${JSON.stringify(text)}`);
    if (controls.length) {
        console.log(
            `   control units: ${controls.map((unit) => '0x' + unit.toString(16).padStart(2, '0')).join(' ')}`,
        );
        console.log(
            `   at indices: ${entry.units
                .map((unit, index) => (unit < 0x20 ? index : -1))
                .filter((index) => index >= 0)
                .join(' ')}`,
        );
    }
    if (/[<>]/u.test(text)) console.log('   contains angle-bracket markup');
}

console.log(`\nmessages=${messages.size} compared=${compared} mismatches=${mismatches}`);
console.log(
    `control units seen: ${JSON.stringify(
        [...controlCounts.entries()].map(([unit, count]) => [`0x${unit.toString(16)}`, count]),
    )}`,
);

const out = option('out');
if (out) {
    fs.writeFileSync(
        out,
        JSON.stringify(
            [...messages.values()].map((entry) => ({
                generation: entry.generation,
                caller: entry.caller,
                units: entry.units,
                positions: [...entry.positions],
            })),
            null,
            1,
        ),
    );
    console.log(`wrote ${out}`);
}
