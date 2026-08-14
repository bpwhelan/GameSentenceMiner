import frida, { MessageType, ScriptRuntime } from 'frida';
import type { Message, Script, Session } from 'frida';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getAssetsDir } from '../util.js';
import type { TextGeometryV1 } from '../ui/text_geometry.js';
import { decodeMagesLayout } from './mages_decoder.js';
import { sanitizeEngineHookMessage } from './protocol.js';
import {
    createInjectedPayloadSource,
    resolveEngineHookSupport,
    type EngineHookSupport,
} from './support.js';

export type EngineHookLogLevel = 'info' | 'warn' | 'error';
export type EngineHookStartSource = 'user' | 'auto-launcher';

export interface EngineHookTextPayload {
    text: string;
    hookId: string;
    hookFunction: string;
    engine: 'mages';
    exeName: string;
    copyToClipboard: boolean;
    capturedAt: number;
    sourceSequence: number;
    revisionWindowMs: number;
    mergeFragments: false;
    textGeometry: TextGeometryV1;
}

export interface StartEngineHookOptions {
    pid: number;
    exeName: string;
    executablePath?: string | null;
    arch: 'x86' | 'x64';
    source: EngineHookStartSource;
    flushDelayMs: number;
    copyToClipboard: boolean;
    onText: (payload: EngineHookTextPayload) => void;
    onLog: (message: string, level: EngineHookLogLevel) => void;
    onStateChanged: () => void;
}

export interface EngineHookStartResult {
    success: boolean;
    error?: string;
    pid?: number;
    exeName?: string;
    arch?: 'x86' | 'x64';
}

export interface EngineHookEntry {
    id: string;
    function: string;
    preview: string;
    samples: string[];
}

interface ActiveEngineHookSession {
    fridaSession: Session;
    script: Script;
    support: EngineHookSupport;
    pid: number;
    exeName: string;
    arch: 'x86' | 'x64';
    source: EngineHookStartSource;
    flushDelayMs: number;
    copyToClipboard: boolean;
    preview: string;
    options: StartEngineHookOptions;
    stopping: boolean;
}

const READY_TIMEOUT_MS = 5000;

let activeSession: ActiveEngineHookSession | null = null;
let starting = false;

function catalogDirectory(): string {
    return path.join(getAssetsDir(), 'engine_hooks');
}

async function executableSha256(executablePath: string | null | undefined): Promise<string | undefined> {
    if (!executablePath || !fs.existsSync(executablePath)) return undefined;
    const contents = await fs.promises.readFile(executablePath);
    return createHash('sha256').update(contents).digest('hex');
}

function geometryBounds(lines: TextGeometryV1['lines']): TextGeometryV1['bounds'] {
    const left = Math.min(...lines.map((line) => line.bounds.x));
    const top = Math.min(...lines.map((line) => line.bounds.y));
    const right = Math.max(...lines.map((line) => line.bounds.x + line.bounds.width));
    const bottom = Math.max(...lines.map((line) => line.bounds.y + line.bounds.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
}

function hookEntry(current: ActiveEngineHookSession): EngineHookEntry {
    return {
        id: current.support.manifest.id,
        function: current.support.manifest.name,
        preview: current.preview,
        samples: current.preview ? [current.preview] : [],
    };
}

function clearActiveSession(current: ActiveEngineHookSession): void {
    if (activeSession !== current) return;
    activeSession = null;
    current.options.onStateChanged();
}

function handleTextLayout(
    current: ActiveEngineHookSession,
    message: ReturnType<typeof sanitizeEngineHookMessage> & { type: 'text-layout' },
): void {
    if (message.integrationId !== current.support.manifest.id) {
        current.options.onLog(
            `Ignored layout from unexpected integration ${message.integrationId}.`,
            'warn',
        );
        return;
    }
    try {
        const decoded = decodeMagesLayout(
            message.positionedCodes,
            current.support.charset,
            current.support.compoundCharacters,
        );
        if (!decoded.text.trim() || decoded.lines.length === 0 || decoded.glyphs.length === 0) return;

        const lines = decoded.lines.map((line) => ({ ...line, bounds: { ...line.bounds } }));
        const textGeometry: TextGeometryV1 = {
            schema: 'gsm_text_geometry_v1',
            coordinateSpace: { ...message.coordinateSpace },
            bounds: geometryBounds(lines),
            lines,
            glyphs: decoded.glyphs.map((glyph) => ({ ...glyph })),
            producer: {
                kind: 'engine-hook',
                version: 1,
                integrationId: current.support.manifest.id,
            },
        };

        current.preview = decoded.text;
        current.options.onText({
            text: decoded.text,
            hookId: current.support.manifest.id,
            hookFunction: current.support.manifest.name,
            engine: 'mages',
            exeName: current.exeName,
            copyToClipboard: current.copyToClipboard,
            capturedAt: message.capturedAt,
            sourceSequence: message.sequence,
            revisionWindowMs: current.flushDelayMs,
            mergeFragments: false,
            textGeometry,
        });
        current.options.onStateChanged();
    } catch (error) {
        current.options.onLog(`Could not decode MAGES text layout: ${(error as Error).message}`, 'error');
    }
}

export async function startEngineHookSession(
    options: StartEngineHookOptions,
): Promise<EngineHookStartResult> {
    if (activeSession || starting) {
        return { success: false, error: 'An engine-hook session is already running.' };
    }
    if (process.platform !== 'win32') {
        return { success: false, error: 'Built-in engine hooks are currently Windows-only.' };
    }

    starting = true;
    let fridaSession: Session | null = null;
    let script: Script | null = null;
    try {
        const support = resolveEngineHookSupport(catalogDirectory(), {
            exeName: options.exeName,
            arch: options.arch,
            executableSha256: await executableSha256(options.executablePath),
        });

        fridaSession = await frida.attach(options.pid);
        script = await fridaSession.createScript(createInjectedPayloadSource(support), {
            name: support.manifest.id,
            runtime: ScriptRuntime.QJS,
        });
        const candidate: ActiveEngineHookSession = {
            fridaSession,
            script,
            support,
            pid: options.pid,
            exeName: options.exeName,
            arch: options.arch,
            source: options.source,
            flushDelayMs: options.flushDelayMs,
            copyToClipboard: options.copyToClipboard,
            preview: '',
            options,
            stopping: false,
        };

        let resolveReady: (() => void) | null = null;
        let rejectReady: ((error: Error) => void) | null = null;
        const ready = new Promise<void>((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });
        const timeout = setTimeout(() => {
            rejectReady?.(new Error(`Engine hook did not become ready within ${READY_TIMEOUT_MS} ms.`));
        }, READY_TIMEOUT_MS);

        script.message.connect((fridaMessage: Message) => {
            if (fridaMessage.type === MessageType.Error) {
                const details = fridaMessage.stack || fridaMessage.description;
                options.onLog(`Injected engine hook error: ${details}`, 'error');
                rejectReady?.(new Error(fridaMessage.description));
                return;
            }
            const message = sanitizeEngineHookMessage(fridaMessage.payload);
            if (!message) {
                options.onLog('Ignored malformed message from the injected engine hook.', 'warn');
                return;
            }
            if (message.type === 'ready') {
                if (message.integrationId !== support.manifest.id) {
                    rejectReady?.(new Error(`Unexpected engine-hook integration ${message.integrationId}.`));
                    return;
                }
                options.onLog(
                    `Ready: ${support.manifest.name} (${JSON.stringify(message.diagnostics)}).`,
                    'info',
                );
                resolveReady?.();
                return;
            }
            if (message.type === 'diagnostic') {
                options.onLog(message.message, message.level);
                return;
            }
            handleTextLayout(candidate, message);
        });
        fridaSession.detached.connect((reason) => {
            if (!candidate.stopping) {
                options.onLog(`Engine-hook target detached (${reason}).`, 'warn');
            }
            clearActiveSession(candidate);
        });

        try {
            await script.load();
            await ready;
        } finally {
            clearTimeout(timeout);
        }
        activeSession = candidate;
        options.onStateChanged();
        options.onLog(
            `Attached ${support.manifest.name} to ${options.exeName} (PID ${options.pid}).`,
            'info',
        );
        return {
            success: true,
            pid: options.pid,
            exeName: options.exeName,
            arch: options.arch,
        };
    } catch (error) {
        try {
            if (script && !script.isDestroyed) await script.unload();
        } catch {
            // The target may already be gone.
        }
        try {
            if (fridaSession && !fridaSession.isDetached()) await fridaSession.detach();
        } catch {
            // The target may already be gone.
        }
        return { success: false, error: `Failed to start built-in engine hook: ${(error as Error).message}` };
    } finally {
        starting = false;
    }
}

export function stopEngineHookSession(): void {
    const current = activeSession;
    if (!current) return;
    current.stopping = true;
    activeSession = null;
    current.options.onStateChanged();
    void (async () => {
        try {
            if (!current.script.isDestroyed) await current.script.unload();
        } catch {
            // The target may already be gone.
        }
        try {
            if (!current.fridaSession.isDetached()) await current.fridaSession.detach();
        } catch {
            // The target may already be gone.
        }
    })();
}

export async function advanceEngineHookSession(): Promise<{ success: boolean; error?: string }> {
    const current = activeSession;
    if (!current) return { success: false, error: 'No active built-in engine-hook session.' };
    try {
        await current.script.exports.advance();
        return { success: true };
    } catch (error) {
        return { success: false, error: `Could not advance game text: ${(error as Error).message}` };
    }
}

export function isEngineHookRunning(): boolean {
    return activeSession !== null;
}

export function listEngineHooks(): { hooks: EngineHookEntry[]; selectedHookId: string | null } {
    const current = activeSession;
    if (!current) return { hooks: [], selectedHookId: null };
    const entry = hookEntry(current);
    return { hooks: [entry], selectedHookId: entry.id };
}

export function getEngineHookRuntimeStatus() {
    const current = activeSession;
    if (!current) return null;
    return {
        running: true as const,
        engine: 'mages' as const,
        arch: current.arch,
        pid: current.pid,
        exeName: current.exeName,
        source: current.source,
        selectedHookId: current.support.manifest.id,
        hookCount: 1,
        flushDelayMs: current.flushDelayMs,
        copyToClipboard: current.copyToClipboard,
    };
}

export function setEngineHookFlushDelayMs(value: number): { success: true; flushDelayMs: number } | null {
    const current = activeSession;
    if (!current) return null;
    current.flushDelayMs = value;
    current.options.onStateChanged();
    return { success: true, flushDelayMs: value };
}

export function setEngineHookCopyToClipboard(
    value: boolean,
): { success: true; copyToClipboard: boolean } | null {
    const current = activeSession;
    if (!current) return null;
    current.copyToClipboard = value;
    current.options.onStateChanged();
    return { success: true, copyToClipboard: value };
}
