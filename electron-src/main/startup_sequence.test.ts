import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

function loadStartup() {
    const source = fs.readFileSync('electron-src/main/main.ts', 'utf8');
    const parsed = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
    const names = new Set(['startDesktopDependencies', 'processArgsAndStartSettings']);
    const functions = parsed.statements
        .filter((node) => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text))
        .map((node) => node.getText(parsed)).join('\n');
    const context = vm.createContext({
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
        markStartup: vi.fn(),
        startInputServer: vi.fn(async () => true),
        startBus: vi.fn(async () => {}),
        wireBackendBus: vi.fn(), setLaunchBlockedCheck: vi.fn(), initializeAgentControl: vi.fn(),
        isQuitting: false, isPythonLaunchBlockedByUpdate: () => false,
        process: { argv: ['electron', 'gsm', '--game', '123', '--ocr'] },
        launchSteamGameID: vi.fn(async () => {}), startOCR: vi.fn(async () => {}),
        getRunOverlayOnStartup: () => true, runOverlayWithSource: vi.fn(async () => true),
        getRunWindowTransparencyToolOnStartup: () => false,
    });
    vm.runInContext(ts.transpile(functions, { target: ts.ScriptTarget.ES2022 }), context);
    return context;
}

it('starts input and bus concurrently but holds child startup until both finish', async () => {
    const context = loadStartup();
    let ready!: () => void;
    context.startInputServer.mockImplementation(() => new Promise<void>((resolve) => { ready = resolve; }));
    const finished = vi.fn();
    const startup = context.startDesktopDependencies().then(finished);
    await Promise.resolve();
    expect(context.startBus).toHaveBeenCalledOnce();
    expect(context.wireBackendBus).toHaveBeenCalledOnce();
    expect(finished).not.toHaveBeenCalled();
    ready();
    await startup;
    expect(finished).toHaveBeenCalledOnce();
});

it('still starts input when the optional bus startup fails', async () => {
    const context = loadStartup();
    context.startBus.mockRejectedValueOnce(new Error('port unavailable'));
    await context.startDesktopDependencies();
    expect(context.startInputServer).toHaveBeenCalledOnce();
    expect(context.initializeAgentControl).not.toHaveBeenCalled();
    expect(context.console.error).toHaveBeenCalled();
});

it('starts the overlay without waiting for a game launcher or OCR', async () => {
    const context = loadStartup();
    let gameStarted!: () => void;
    context.launchSteamGameID.mockImplementation(() => new Promise<void>((resolve) => { gameStarted = resolve; }));
    const startup = context.processArgsAndStartSettings();
    await Promise.resolve();
    expect(context.runOverlayWithSource).toHaveBeenCalledWith('startup');
    expect(context.startOCR).not.toHaveBeenCalled();
    gameStarted();
    await startup;
    expect(context.startOCR).toHaveBeenCalledOnce();
});
