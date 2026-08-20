import frida from 'frida';

function parseIntegerOption(name, fallback) {
    const prefix = `--${name}=`;
    const value = process.argv.find((argument) => argument.startsWith(prefix));
    return value ? Number.parseInt(value.slice(prefix.length), 10) : fallback;
}

const targetValue = process.argv[2];
if (!targetValue) {
    console.error(
        'Usage: node scripts/engine-hooks/trace-text-conversion.mjs <pid-or-name> [--duration=10000] [--advance=1]',
    );
    process.exitCode = 2;
} else {
    const target = /^\d+$/.test(targetValue) ? Number.parseInt(targetValue, 10) : targetValue;
    const durationMs = parseIntegerOption('duration', 10_000);
    const advanceCount = parseIntegerOption('advance', 0);
    const session = await frida.attach(target);
    try {
        const script = await session.createScript(`
            const mainModule = Process.mainModule;
            const mainEnd = mainModule.base.add(mainModule.size);

            function moduleLocation(address) {
                if (address.compare(mainModule.base) >= 0 && address.compare(mainEnd) < 0) {
                    return {
                        module: mainModule.name,
                        offset: address.sub(mainModule.base).toString(),
                    };
                }
                const module = Process.findModuleByAddress(address);
                return module
                    ? { module: module.name, offset: address.sub(module.base).toString() }
                    : {};
            }

            function findMainWindow() {
                const enumWindows = new NativeFunction(
                    Module.getGlobalExportByName('EnumWindows'),
                    'bool',
                    ['pointer', 'pointer'],
                );
                const getWindowThreadProcessId = new NativeFunction(
                    Module.getGlobalExportByName('GetWindowThreadProcessId'),
                    'uint32',
                    ['pointer', 'pointer'],
                );
                const isWindowVisible = new NativeFunction(
                    Module.getGlobalExportByName('IsWindowVisible'),
                    'bool',
                    ['pointer'],
                );
                const processId = Process.id;
                const processIdBuffer = Memory.alloc(4);
                let result = NULL;
                const callback = new NativeCallback((window, _parameter) => {
                    getWindowThreadProcessId(window, processIdBuffer);
                    if (processIdBuffer.readU32() === processId && isWindowVisible(window)) {
                        result = window;
                        return 0;
                    }
                    return 1;
                }, 'bool', ['pointer', 'pointer']);
                enumWindows(callback, NULL);
                return result;
            }

            function advance() {
                const window = findMainWindow();
                if (window.isNull()) throw new Error('No visible game window was found.');
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
                setForegroundWindow(window);
                keybdEvent(0x0d, 0x1c, 0, NULL);
                keybdEvent(0x0d, 0x1c, 2, NULL);
                return window.toString();
            }

            const multiByteToWideChar = Module.getGlobalExportByName('MultiByteToWideChar');
            Interceptor.attach(multiByteToWideChar, {
                onEnter(args) {
                    this.codePage = args[0].toUInt32();
                    this.input = args[2];
                    this.inputLength = args[3].toInt32();
                    this.output = args[4];
                    this.outputCapacity = args[5].toInt32();
                    this.caller = this.returnAddress;
                },
                onLeave(result) {
                    const written = result.toInt32();
                    if (this.output.isNull() || written <= 1 || this.outputCapacity <= 0) return;
                    try {
                        const text = this.output.readUtf16String(Math.min(written, this.outputCapacity));
                        if (!text || !/[\u3000-\u30ff\u3400-\u9fff]/u.test(text)) return;
                        send({
                            type: 'conversion',
                            codePage: this.codePage,
                            text,
                            input: this.input.toString(),
                            inputLength: this.inputLength,
                            caller: this.caller.toString(),
                            ...moduleLocation(this.caller),
                        });
                    } catch (error) {
                        // The source or destination buffer may have been released by the caller.
                    }
                },
            });

            rpc.exports = { advance };
            send({ type: 'ready', address: multiByteToWideChar.toString() });
        `);
        script.message.connect((message) => {
            if (message.type === 'send') console.log(JSON.stringify(message.payload));
            else console.error(JSON.stringify(message));
        });
        await script.load();
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        for (let index = 0; index < advanceCount; index += 1) {
            console.log(JSON.stringify({ type: 'advance', window: await script.exports.advance() }));
            await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        await new Promise((resolve) => setTimeout(resolve, durationMs));
        await script.unload();
    } finally {
        await session.detach();
    }
}
