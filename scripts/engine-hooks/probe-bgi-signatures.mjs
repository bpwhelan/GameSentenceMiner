#!/usr/bin/env node

// Check that every BGI/Ethornell signature the payload relies on resolves uniquely
// in a running build, and print the addresses they land on.
//
// Nothing here needs dialogue on screen, so it can be run against a title screen,
// which makes adding a new build to the tested set cheap.

import process from 'node:process';

import frida from 'frida';

const pid = Number.parseInt(process.argv[2] ?? '', 10);
if (!Number.isInteger(pid) || pid <= 0) {
    console.error('Usage: node scripts/engine-hooks/probe-bgi-signatures.mjs <pid>');
    process.exit(2);
}

const session = await frida.attach(pid);
const script = await session.createScript(
    `
const main = Process.mainModule;
const mainEnd = main.base.add(main.size);
function off(a) { return '0x' + a.sub(main.base).toString(16); }

const patterns = {
    'glyph draw': '55 8b ec 83 e4 f0 83 ec 38 56 57 8b f9 8d 44 24 10 50 0f 10 87 94 01 00 00',
    'BGI4 text': '55 8B EC 53 56 57 33 FF E8 ?? ?? ?? ?? 8B F0',
    'copy dispatcher': '51 8b 42 10 83 e8 00 74 ?? 83 e8 01 74 ?? 83 e8 01 75',
    'block copy loop': '0f 6f 01 8d 04 0f 0f 18 81 00 10 00 00',
    'surface lock': '55 8b ec 83 ec 0c 56 8b f1 8b 4e 48 85 c9 74 ?? 83 7e 4c 00 75 ?? 8b 01 8d 55 f8 68 00 80 00 00 6a 00 52 6a 00 51 ff 50 4c',
};

const out = { module: main.name, size: main.size, hits: {}, variants: [] };
for (const [label, pattern] of Object.entries(patterns)) {
    const hits = [];
    for (const range of Process.enumerateRanges({ protection: 'r-x', coalesce: false })) {
        if (range.base.compare(main.base) < 0 || range.base.compare(mainEnd) >= 0) continue;
        for (const m of Memory.scanSync(range.base, range.size, pattern)) hits.push(off(m.address));
    }
    out.hits[label] = hits;
}

// The copy variants are read out of the dispatcher's own call targets, so they are
// discovered per build rather than matched.
if (out.hits['copy dispatcher'].length === 1) {
    let cursor = main.base.add(out.hits['copy dispatcher'][0]);
    const end = cursor.add(0x60);
    while (cursor.compare(end) < 0) {
        let instruction;
        try { instruction = Instruction.parse(cursor); } catch (e) { break; }
        if (instruction.mnemonic === 'call') {
            const target = ptr(instruction.opStr);
            if (target.compare(main.base) >= 0 && target.compare(mainEnd) < 0 && !out.variants.includes(off(target))) {
                out.variants.push(off(target));
            }
        }
        cursor = instruction.next;
    }
}
send(out);
`,
    { runtime: 'qjs' },
);

const result = new Promise((resolve, reject) => {
    script.message.connect((m) =>
        m.type === 'send' ? resolve(m.payload) : reject(new Error(m.description ?? JSON.stringify(m))),
    );
});
await script.load();
const payload = await result;

console.log(`module ${payload.module} size 0x${payload.size.toString(16)}`);
let unique = true;
for (const [label, hits] of Object.entries(payload.hits)) {
    if (hits.length !== 1) unique = false;
    console.log(
        `  ${label.padEnd(18)} ${hits.length === 1 ? 'unique  ' + hits[0] : hits.length + ' matches  ' + JSON.stringify(hits)}`,
    );
}
console.log(`  ${'copy variants'.padEnd(18)} ${JSON.stringify(payload.variants)}`);
console.log(unique ? '\nall signatures unique' : '\nSOME SIGNATURES ARE NOT UNIQUE');

await script.unload();
await session.detach();
