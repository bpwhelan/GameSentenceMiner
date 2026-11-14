import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { ensureHachidoriEngine, forgetHachidoriEngine } = createRequire(import.meta.url)('../../../GSM_Overlay/shared_dictionary_engine.cjs');
describe('shared dictionary engine ownership', () => {
    it('shares one startup and one filesystem mirror between simultaneous callers', async () => {
        let count = 0;
        class Window extends EventEmitter {
            constructor() { super(); count++; }
            webContents = { executeJavaScript: async () => false };
            async loadURL() { await Promise.resolve(); }
            isDestroyed() { return false; }
            destroy() { this.emit('closed'); }
        }
        const session = { getStoragePath: () => '/concurrent-test' };
        const [reader, overlay] = await Promise.all([ensureHachidoriEngine(Window, session, 'reader'), ensureHachidoriEngine(Window, session, 'reader')]);
        expect(reader).toBe(overlay); expect(count).toBe(1);
        reader.destroy();
        expect(await ensureHachidoriEngine(Window, session, 'reader')).not.toBe(reader);
        expect(count).toBe(2); forgetHachidoriEngine(session, 'reader');
    });
    it('does not create a hosted engine when the extension owns its offscreen document', async () => {
        const urls: string[] = [];
        class Window extends EventEmitter {
            webContents = { executeJavaScript: async () => true };
            async loadURL(url: string) { urls.push(url); }
            isDestroyed() { return false; }
            destroy() { this.emit('closed'); }
        }
        const session = { getStoragePath: () => '/native-test' };
        expect(await ensureHachidoriEngine(Window, session, 'reader')).toBe(null);
        expect(urls).toEqual(['chrome-extension://reader/gsm/engine-host.html']);
        forgetHachidoriEngine(session, 'reader');
    });
});
