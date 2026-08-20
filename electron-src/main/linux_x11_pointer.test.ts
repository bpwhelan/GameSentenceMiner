import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
    createLinuxX11PointerController,
    createLinuxX11PointerProtocolState,
    resolveLinuxX11PointerRead,
    createLinuxX11PointerFallbackWarningLogger,
    createLinuxX11PointerFallbackDeadline,
    shouldRequireLinuxX11PointerServer,
    toDipPointer,
} = require(path.resolve(process.cwd(), 'GSM_Overlay/linux_x11_pointer.js')) as Record<string, any>;

describe('Linux X11 pointer protocol helpers', () => {
    it('never requires the pointer server when the capability gate is false', () => {
        expect(shouldRequireLinuxX11PointerServer({
            capabilityEnabled: false,
            pointerQueryNeeded: true,
            hasSocket: true,
            hasUrl: true,
        })).toBe(false);
        expect(shouldRequireLinuxX11PointerServer({
            capabilityEnabled: true,
            pointerQueryNeeded: true,
        })).toBe(true);
    });

    it('clears timed-out work and invalidates stale data', () => {
        vi.useFakeTimers();
        let now = 0;
        const timedOut = vi.fn();
        const controller = createLinuxX11PointerController({ now: () => now, requestTimeoutMs: 100, cacheTtlMs: 50, onTimeout: timedOut });
        expect(controller.request(true, vi.fn())).toBe(true);
        vi.advanceTimersByTime(100);
        expect(controller.inFlight).toBe(false);
        expect(timedOut).toHaveBeenCalledOnce();
        controller.request(true, vi.fn());
        controller.handleMessage('{"type":"pointer_position","x":1,"y":2,"ok":true,"requestId":1}');
        expect(controller.getFreshPosition()).toEqual({ x: 1, y: 2 });
        now = 51;
        expect(controller.getFreshPosition()).toBeNull();
        vi.useRealTimers();
    });

    it('rejects a late response after a newer request', () => {
        vi.useFakeTimers();
        const sent: number[] = [];
        const controller = createLinuxX11PointerController({ requestTimeoutMs: 10 });
        controller.request(true, (id: number) => sent.push(id));
        vi.advanceTimersByTime(10);
        controller.request(true, (id: number) => sent.push(id));
        expect(controller.handleMessage('{"type":"pointer_position","x":10,"y":20,"ok":true,"requestId":0}')).toMatchObject({ accepted: false });
        expect(controller.handleMessage('{"type":"pointer_position","x":30,"y":40,"ok":true,"requestId":1}')).toMatchObject({ accepted: true });
        expect(controller.getFreshPosition()).toEqual({ x: 30, y: 40 });
        expect(sent).toEqual([0, 1]);
        vi.useRealTimers();
    });

    it('rejects id-less and late failures without clearing the current request or last-good sample', () => {
        vi.useFakeTimers();
        let now = 0;
        const controller = createLinuxX11PointerController({ now: () => now, requestTimeoutMs: 10, cacheTtlMs: 100 });
        controller.request(true, vi.fn());
        controller.handleMessage('{"type":"pointer_position","x":10,"y":20,"ok":true,"requestId":0}');
        expect(controller.getFreshPosition()).toEqual({ x: 10, y: 20 });
        now = 1;
        controller.request(true, vi.fn());
        expect(controller.handleMessage('{"type":"pointer_position","ok":false}')).toMatchObject({ accepted: false });
        expect(controller.inFlight).toBe(true);
        expect(controller.handleMessage('{"type":"pointer_position","ok":false,"requestId":0}')).toMatchObject({ accepted: false });
        expect(controller.inFlight).toBe(true);
        expect(controller.handleMessage('{"type":"pointer_position","ok":false,"requestId":1}')).toMatchObject({ accepted: true });
        expect(controller.inFlight).toBe(false);
        expect(controller.getFreshPosition()).toEqual({ x: 10, y: 20 });
        vi.useRealTimers();
    });

    it('keeps endpoint support across a same-URL reconnect', () => {
        const protocol = createLinuxX11PointerProtocolState();
        expect(protocol.connect('ws://127.0.0.1:7394')).toBeNull();
        expect(protocol.reportServiceInfo(3)).toBe(true);
        expect(protocol.disconnect()).toBe(true);
        expect(protocol.connect('ws://127.0.0.1:7394')).toBe(true);
        expect(protocol.connect('ws://127.0.0.1:7600')).toBeNull();
    });

    it('uses Electron until the first success, then suppresses only until a monotonic deadline', () => {
        expect(resolveLinuxX11PointerRead({ protocolSupported: null })).toEqual({ source: 'fallback', fallbackReason: 'starting' });
        expect(resolveLinuxX11PointerRead({ protocolSupported: false, hasSuccessfulQuery: true })).toEqual({ source: 'fallback', fallbackReason: 'unsupported' });
        expect(resolveLinuxX11PointerRead({ protocolSupported: true, hasSuccessfulQuery: true })).toEqual({ source: 'suppressed', fallbackReason: null });
        expect(resolveLinuxX11PointerRead({ protocolSupported: true, hasSuccessfulQuery: true, fallbackDeadlineReached: true })).toEqual({ source: 'fallback', fallbackReason: 'down' });
    });

    it('logs fallback transitions only once', () => {
        const warn = vi.fn();
        const logger = createLinuxX11PointerFallbackWarningLogger({ warn });
        expect(logger.update('unsupported', 'old server')).toBe(true);
        expect(logger.update('unsupported', 'old server')).toBe(false);
        expect(logger.update(null)).toBe(false);
        expect(logger.update('down', 'server unavailable')).toBe(true);
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it('never extends the fallback deadline for repeated failure samples', () => {
        let now = 100;
        const deadline = createLinuxX11PointerFallbackDeadline({ now: () => now, delayMs: 50 });
        expect(deadline.beginFailure()).toBe(150);
        now = 140;
        expect(deadline.beginFailure()).toBe(150);
        expect(deadline.hasReached()).toBe(false);
        now = 150;
        expect(deadline.hasReached()).toBe(true);
        deadline.markSuccess();
        expect(deadline.deadlineAt).toBeNull();
        now = 200;
        expect(deadline.beginFailure()).toBe(250);
    });

    it('converts physical X11 coordinates to Electron DIP', () => {
        expect(toDipPointer({ x: 225, y: 150 }, ({ x, y }: any) => ({ x: x / 1.5, y: y / 1.5 }))).toEqual({ x: 150, y: 100 });
    });
});
