import frida from 'frida';

function parseTarget(value) {
    if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
    return value;
}

const target = process.argv[2];
if (!target) {
    console.error('Usage: node scripts/engine-hooks/probe-runtime.mjs <pid-or-process-name> [--imports]');
    process.exitCode = 2;
} else {
    const session = await frida.attach(parseTarget(target));
    try {
        const includeImports = process.argv.includes('--imports');
        const includeRanges = process.argv.includes('--ranges');
        const script = await session.createScript(`
            const mainModule = Process.mainModule;
            send({
                arch: Process.arch,
                platform: Process.platform,
                pointerSize: Process.pointerSize,
                modules: Process.enumerateModules().map((module) => ({
                    name: module.name,
                    base: module.base.toString(),
                    size: module.size,
                    path: module.path,
                })),
                imports: ${includeImports}
                    ? mainModule.enumerateImports().map((entry) => ({
                          name: entry.name,
                          module: entry.module,
                          address: entry.address?.toString(),
                          slot: entry.slot?.toString(),
                          type: entry.type,
                      }))
                    : undefined,
                ranges: ${includeRanges}
                    ? ['r--', 'rw-', 'r-x'].flatMap((protection) =>
                          Process.enumerateRanges({ protection, coalesce: true })
                              .filter((range) => {
                                  const end = range.base.add(range.size);
                                  const mainEnd = mainModule.base.add(mainModule.size);
                                  return range.base.compare(mainEnd) < 0 && end.compare(mainModule.base) > 0;
                              })
                              .map((range) => ({
                                  base: range.base.toString(),
                                  size: range.size,
                                  protection,
                              })),
                      )
                    : undefined,
            });
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
