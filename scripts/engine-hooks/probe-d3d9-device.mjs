#!/usr/bin/env node

import frida, { ScriptRuntime } from 'frida';

const targetValue = process.argv[2];
if (!targetValue) {
    process.stderr.write('Usage: node scripts/engine-hooks/probe-d3d9-device.mjs <pid-or-name>\n');
    process.exitCode = 2;
} else {
    const target = /^\d+$/u.test(targetValue) ? Number.parseInt(targetValue, 10) : targetValue;
    const session = await frida.attach(target);
    try {
        const script = await session.createScript(
            String.raw`
                const mainModule = Process.mainModule;
                const d3d9 = Process.getModuleByName('d3d9.dll');
                const d3d9End = d3d9.base.add(d3d9.size);
                const dataSections = [mainModule, d3d9].flatMap((module) =>
                    module.enumerateSections()
                        .filter((section) => section.name.toLowerCase().includes('data'))
                        .map((section) => ({ module, section })),
                );

                function isD3d9Address(address) {
                    return address.compare(d3d9.base) >= 0 && address.compare(d3d9End) < 0;
                }

                function inspectCandidate(globalAddress, objectAddress) {
                    try {
                        const vtable = objectAddress.readPointer();
                        const queryInterface = vtable.readPointer();
                        const present = vtable.add(17 * Process.pointerSize).readPointer();
                        const getViewport = vtable.add(48 * Process.pointerSize).readPointer();
                        if (
                            !isD3d9Address(vtable) ||
                            !isD3d9Address(queryInterface) ||
                            !isD3d9Address(present) ||
                            !isD3d9Address(getViewport)
                        ) {
                            return null;
                        }
                        return {
                            globalAddress: globalAddress.toString(),
                            globalOffset: globalAddress.sub(mainModule.base).toString(),
                            objectAddress: objectAddress.toString(),
                            vtable: vtable.toString(),
                            queryInterface: queryInterface.toString(),
                            present: present.toString(),
                            getViewport: getViewport.toString(),
                        };
                    } catch {
                        return null;
                    }
                }

                const candidates = [];
                const seenObjects = new Set();
                const chunkSize = 1024 * 1024;
                for (const { module, section } of dataSections) {
                    for (let offset = 0; offset < section.size; offset += chunkSize) {
                        const size = Math.min(chunkSize, section.size - offset);
                        const chunkBase = section.address.add(offset);
                        const words = new Uint32Array(chunkBase.readByteArray(size));
                        for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
                            const value = words[wordIndex];
                            if (value < 0x10000 || value >= 0x7fff0000 || (value & 3) !== 0) continue;
                            const objectKey = value.toString(16);
                            if (seenObjects.has(objectKey)) continue;
                            seenObjects.add(objectKey);
                            const candidate = inspectCandidate(
                                chunkBase.add(wordIndex * Process.pointerSize),
                                ptr(value),
                            );
                            if (candidate) {
                                candidate.ownerModule = module.name;
                                candidate.ownerSection = section.name;
                                candidates.push(candidate);
                            }
                        }
                    }
                }
                send({
                    mainModule: mainModule.name,
                    dataSections: dataSections.map(({ module, section }) => ({
                        module: module.name,
                        name: section.name,
                        address: section.address.toString(),
                        size: section.size,
                    })),
                    d3d9: { base: d3d9.base.toString(), size: d3d9.size },
                    candidates,
                });
            `,
            { runtime: ScriptRuntime.QJS },
        );
        const result = new Promise((resolve, reject) => {
            script.message.connect((message) => {
                if (message.type === 'send') resolve(message.payload);
                else reject(new Error(message.stack || message.description));
            });
        });
        await script.load();
        process.stdout.write(`${JSON.stringify(await result, null, 2)}\n`);
        await script.unload();
    } finally {
        await session.detach();
    }
}
