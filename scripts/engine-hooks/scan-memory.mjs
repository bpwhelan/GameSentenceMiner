import frida from 'frida';

function usage() {
    console.error(
        'Usage: node scripts/engine-hooks/scan-memory.mjs <pid-or-name> <hex-pattern> [--scope=main|writable|all]',
    );
}

const [, , targetValue, ...rawPatternParts] = process.argv;
const scopeArgument = rawPatternParts.find((part) => part.startsWith('--scope='));
const scope = scopeArgument?.slice('--scope='.length) ?? 'all';
const patternParts = rawPatternParts.filter((part) => !part.startsWith('--scope='));
const pattern = patternParts.join(' ').trim();
if (!targetValue || !pattern || !['main', 'writable', 'all'].includes(scope)) {
    usage();
    process.exitCode = 2;
} else {
    const target = /^\d+$/.test(targetValue) ? Number.parseInt(targetValue, 10) : targetValue;
    const session = await frida.attach(target);
    try {
        const script = await session.createScript(`
            const pattern = ${JSON.stringify(pattern)};
            const scope = ${JSON.stringify(scope)};
            const moduleMap = new ModuleMap();
            const matches = [];
            const ranges = [];
            const mainModule = Process.mainModule;
            const mainEnd = mainModule.base.add(mainModule.size);
            const protections = scope === 'writable' ? ['rw-'] : ['r--', 'rw-', 'r-x'];
            for (const protection of protections) {
                for (const range of Process.enumerateRanges({ protection, coalesce: true })) {
                    if (
                        scope === 'main' &&
                        (range.base.compare(mainEnd) >= 0 || range.base.add(range.size).compare(mainModule.base) <= 0)
                    ) {
                        continue;
                    }
                    const owner = moduleMap.find(range.base);
                    if (scope === 'writable' && owner && owner.name !== mainModule.name) continue;
                    const chunkSize = 16 * 1024 * 1024;
                    for (let offset = 0; offset < range.size; offset += chunkSize) {
                        ranges.push({
                            base: range.base.add(offset),
                            size: Math.min(chunkSize, range.size - offset),
                            protection,
                            rangeBase: range.base,
                            rangeSize: range.size,
                        });
                    }
                }
            }

            function scanNext() {
                const range = ranges.shift();
                if (!range) {
                    send(matches);
                    return;
                }
                Memory.scan(range.base, range.size, pattern, {
                    onMatch(address, size) {
                        const module = moduleMap.find(address);
                        matches.push({
                            address: address.toString(),
                            size,
                            protection: range.protection,
                            rangeBase: range.rangeBase.toString(),
                            rangeSize: range.rangeSize,
                            module: module?.name,
                            moduleOffset: module ? address.sub(module.base).toString() : undefined,
                        });
                    },
                    onError() {
                        // A range can disappear between enumeration and scanning.
                    },
                    onComplete() {
                        setImmediate(scanNext);
                    },
                });
            }
            setImmediate(scanNext);
        `);
        const result = new Promise((resolve, reject) => {
            script.message.connect((message) => {
                if (message.type === 'send') resolve(message.payload);
                else reject(new Error(message.description ?? JSON.stringify(message)));
            });
        });
        await script.load();
        console.log(JSON.stringify(await result, null, 2));
        await script.unload();
    } finally {
        await session.detach();
    }
}
