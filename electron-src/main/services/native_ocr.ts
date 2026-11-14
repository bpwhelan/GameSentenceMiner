import { randomUUID } from 'node:crypto';

type Config = Record<string, any>;
type NativeEvent = { session: string; event: string; data: any };
interface Dependencies {
    call(action: Config): Promise<any>;
    context(): Promise<Config>;
    configuration(context?: Config): Promise<Config>;
    ingest(data: Config): Promise<any>;
    emit(event: string, data: any): void;
    state(running: boolean): void;
    addArea(): Promise<unknown>;
}

export function createNativeOcrService(deps: Dependencies) {
    let session = '';
    let mode: 'auto' | 'manual' = 'auto';
    let running = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let pending = Promise.resolve();
    let config: Config = {};
    let ingesting = false;
    let accepting = false;
    let refreshError = '';
    let autoActivity: string | null = null;
    const deliveries: NativeEvent[] = [];
    const report = (error: unknown) => deps.emit('error', { error: error instanceof Error ? error.message : String(error) });
    const publishStatus = (state: Config, force = true) => {
        const activity = state?.auto_activity ?? null;
        const changed = activity !== autoActivity;
        autoActivity = activity;
        if (changed || force) deps.emit('status', state);
    };
    const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
        const result = pending.then(job);
        pending = result.then(() => undefined, () => undefined);
        return result;
    };
    const refresh = async (expected: string) => {
        if (!accepting || !running || session !== expected) return;
        let receivedContext = false;
        try {
            const context = await deps.context();
            receivedContext = true;
            if (!accepting || !running || session !== expected) return;
            const next = { ...config, ...context };
            // A scene change must never reuse another game's saved areas.
            if (next.scene !== config.scene) Object.assign(next, await deps.configuration(context));
            if (!accepting || !running || session !== expected) return;
            const state = await deps.call({ action: 'configure', session, config: next });
            if (!accepting || !running || session !== expected) return;
            config = next;
            refreshError = '';
            publishStatus(state, false);
        } catch (error) {
            if (!accepting || !running || session !== expected) return;
            const message = String(error);
            if (message !== refreshError) {
                refreshError = message;
                if (receivedContext) report(error);
                else deps.emit('log', { message: `[OCR] Capture context refresh failed. Retrying. ${message}` });
            }
        }
        finally {
            if (accepting && running && session === expected) { poll = setTimeout(() => void enqueue(() => refresh(expected)), 1000); poll.unref?.(); }
        }
    };
    const deliver = async () => {
        if (ingesting) return;
        ingesting = true;
        try {
            while (deliveries.length) {
                const event = deliveries.shift()!;
                if (!accepting || !running || event.session !== session) continue;
                try {
                    const ack = await deps.ingest(event.data);
                    if (accepting && running && event.session === session) {
                        const excluded = ack?.reason?.includes('excluded');
                        if (ack?.status === 'rejected' && !excluded) { report(ack.reason || 'OCR text was rejected'); continue; }
                        deps.emit(event.event, { ...event.data, ...(excluded ? { excluded: true } : {}) });
                    }
                } catch (error) { report(error); } // Never replay old captures after reconnect.
            }
        } finally { ingesting = false; }
    };
    const service = {
        get running() { return running; },
        start(nextMode: 'auto' | 'manual') {
            return enqueue(async () => {
                if (running) await service.stopNow();
                mode = nextMode;
                session = randomUUID();
                const context = await deps.context();
                config = { ...await deps.configuration(context), ...context, mode };
                const state = await deps.call({ action: 'start', session, config });
                running = true;
                accepting = true;
                refreshError = '';
                deps.state(true);
                deps.emit('started', null);
                publishStatus(state);
                const expected = session;
                poll = setTimeout(() => void enqueue(() => refresh(expected)), 1000); poll.unref?.();
            });
        },
        async stopNow() {
            if (!running) return;
            accepting = false;
            clearTimeout(poll); deliveries.length = 0;
            await deps.call({ action: 'stop', session });
            running = false; deps.state(false); deps.emit('stopped', null);
        },
        stop() { accepting = false; clearTimeout(poll); return enqueue(() => service.stopNow()); },
        reload() {
            return enqueue(async () => {
                if (!running) return;
                const context = await deps.context();
                const next: Config = { ...await deps.configuration(context), ...context, mode };
                const state = await deps.call({ action: 'configure', session, config: next });
                config = next;
                refreshError = '';
                deps.emit('config_reloaded', null);
                publishStatus(state);
            });
        },
        async command(action: string, data: Config = {}) {
            if (!running) return;
            if (action === 'reload_config') return service.reload();
            if (action === 'add_ocr_area') { await deps.addArea(); return service.reload(); }
            const expected = session;
            if (action === 'manual_ocr' && !config.settings.manualOcrDelayGamepadOnly) {
                const delay = Math.min(10000, Math.max(0, Number(config.settings.manualOcrDelayMs) || 0));
                if (delay) await new Promise(resolve => setTimeout(resolve, delay));
                if (!running || session !== expected) return;
            }
            const state = await deps.call({ ...data, action: action === 'get_status' ? 'status' : action, session });
            if (!accepting || !running || session !== expected) return;
            publishStatus(state);
            if (['pause', 'unpause', 'toggle_pause'].includes(action)) deps.emit(state.paused ? 'paused' : 'unpaused', { paused: state.paused });
            if (['set_force_stable', 'toggle_force_stable'].includes(action)) {
                config.settings.force_stable = state.force_stable;
                deps.emit('force_stable_changed', { force_stable: state.force_stable });
            }
        },
        preview() { return running ? deps.call({ action: 'preview', session }) : Promise.resolve(null); },
        async capturePreview(request: any) {
            const context = await deps.context();
            if (context.scene !== request.sceneName) return null;
            const options = running ? config : await deps.configuration(context);
            return deps.call({ action: 'capture_preview', config: { ...options, ...context }, request });
        },
        receive(event: NativeEvent) {
            if (!accepting || !running || event.session !== session) return;
            if (event.event === 'force_stable_changed') config.settings.force_stable = Boolean(event.data?.force_stable);
            if (event.event === 'add_ocr_area') { void deps.addArea().then(() => service.reload()).catch(report); return; }
            if (event.event !== 'ocr_result') { deps.emit(event.event, event.data); return; }
            if (deliveries.length >= 16) { report('OCR text delivery queue is full'); return; }
            deliveries.push(event); void deliver();
        },
    };
    return service;
}
