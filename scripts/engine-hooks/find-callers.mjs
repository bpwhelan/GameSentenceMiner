import frida from 'frida';

const [, , targetValue, functionAddressValue] = process.argv;
if (!targetValue || !functionAddressValue) {
    console.error(
        'Usage: node scripts/engine-hooks/find-callers.mjs <pid-or-name> <address-or-main+offset>',
    );
    process.exitCode = 2;
} else {
    const target = /^\d+$/.test(targetValue) ? Number.parseInt(targetValue, 10) : targetValue;
    const session = await frida.attach(target);
    try {
        const script = await session.createScript(`
            const mainModule = Process.mainModule;
            const targetValue = ${JSON.stringify(functionAddressValue)};
            const target = targetValue.startsWith('+')
                ? mainModule.base.add(targetValue.slice(1))
                : ptr(targetValue);
            const callers = [];
            for (const range of Process.enumerateRanges({ protection: 'r-x', coalesce: true })) {
                const rangeEnd = range.base.add(range.size);
                const moduleEnd = mainModule.base.add(mainModule.size);
                if (range.base.compare(moduleEnd) >= 0 || rangeEnd.compare(mainModule.base) <= 0) continue;
                const bytes = new Uint8Array(range.base.readByteArray(range.size));
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                for (let offset = 0; offset <= bytes.length - 5; offset += 1) {
                    if (bytes[offset] !== 0xe8) continue;
                    const destination = (
                        range.base.toUInt32() + offset + 5 + view.getInt32(offset + 1, true)
                    ) >>> 0;
                    if (destination === target.toUInt32()) {
                        const address = range.base.add(offset);
                        callers.push({
                            address: address.toString(),
                            moduleOffset: address.sub(mainModule.base).toString(),
                        });
                    }
                }
            }
            send(callers);
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
