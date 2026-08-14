import frida from 'frida';

const [, , targetValue, addressValue, countValue = '64'] = process.argv;
if (!targetValue || !addressValue) {
    console.error(
        'Usage: node scripts/engine-hooks/disassemble.mjs <pid-or-name> <address-or-main+offset> [instruction-count]',
    );
    process.exitCode = 2;
} else {
    const target = /^\d+$/.test(targetValue) ? Number.parseInt(targetValue, 10) : targetValue;
    const count = Number.parseInt(countValue, 10);
    const session = await frida.attach(target);
    try {
        const script = await session.createScript(`
            const value = ${JSON.stringify(addressValue)};
            let cursor = value.startsWith('+')
                ? Process.mainModule.base.add(value.slice(1))
                : ptr(value);
            const instructions = [];
            for (let index = 0; index < ${count}; index += 1) {
                const instruction = Instruction.parse(cursor);
                instructions.push({
                    address: instruction.address.toString(),
                    moduleOffset: instruction.address.sub(Process.mainModule.base).toString(),
                    mnemonic: instruction.mnemonic,
                    operands: instruction.opStr,
                    size: instruction.size,
                    bytes: Array.from(new Uint8Array(instruction.address.readByteArray(instruction.size)))
                        .map((value) => value.toString(16).padStart(2, '0'))
                        .join(' '),
                });
                cursor = instruction.next;
            }
            send(instructions);
        `);
        const result = new Promise((resolve, reject) => {
            script.message.connect((message) => {
                if (message.type === 'send') resolve(message.payload);
                else reject(new Error(message.description ?? JSON.stringify(message)));
            });
        });
        await script.load();
        for (const instruction of await result) {
            console.log(
                `${instruction.address} (${instruction.moduleOffset})  ${instruction.bytes.padEnd(24)}  ${instruction.mnemonic} ${instruction.operands}`,
            );
        }
        await script.unload();
    } finally {
        await session.detach();
    }
}
