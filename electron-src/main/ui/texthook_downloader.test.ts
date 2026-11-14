import {beforeEach, describe, expect, it, vi} from 'vitest';
const native = vi.hoisted(() => ({call: vi.fn(), sync: vi.fn(), events: vi.fn(), unsubscribe: vi.fn()}));
vi.mock('../runtime/native_packages.js', () => ({packagesCall: native.call, packagesSync: native.sync, packageEvents: native.events}));
vi.mock('../data_dir.js', () => ({getSharedBaseDir: () => 'fixture'}));
import {prepareTexthookUpdate, downloadTexthookEngines, getLocalEngineStatus, getTexthookRuntimeDir} from './texthook_downloader.js';
// Filesystem, HTTP, archive validation and preservation are exercised against
// real native code in native/gsm-packages/tests/packages.rs.
describe('native hook package facade', () => {
    beforeEach(() => { vi.resetAllMocks(); native.events.mockReturnValue(native.unsubscribe); });
    it('forwards progress for this operation and releases the subscription', async () => {
        const progress = vi.fn(), verifying = vi.fn();
        native.call.mockImplementation(async (action, args) => {
            expect(action).toBe('engines.prepare'); expect(args.version).toBe('1.0.0');
            expect(args.operation).toBe(native.events.mock.calls[0][0]);
            native.events.mock.calls[0][1]('progress', {bytesDownloaded: 42});
            native.events.mock.calls[0][1]('verifying', null);
            return {token: 'owned-token', manifest: {version: '1.0.0'}};
        });
        expect((await prepareTexthookUpdate(progress, verifying, '1.0.0')).token).toBe('owned-token');
        expect(progress).toHaveBeenCalledWith({bytesDownloaded: 42}); expect(verifying).toHaveBeenCalledOnce(); expect(native.unsubscribe).toHaveBeenCalledOnce();
    });
    it('releases failed preparation subscriptions and never attempts activation', async () => {
        native.call.mockRejectedValue(Error('SHA-256 mismatch'));
        await expect(downloadTexthookEngines()).rejects.toThrow('SHA-256 mismatch');
        expect(native.call).toHaveBeenCalledOnce(); expect(native.unsubscribe).toHaveBeenCalledOnce();
    });
    it('passes only an owned token to activation and discards a failed preparation', async () => {
        native.call.mockImplementation(async action => { if (action === 'engines.prepare') return {token: 'owned', directory: 'private'}; if (action === 'engines.activate') throw Error('activation failed'); });
        await expect(downloadTexthookEngines()).rejects.toThrow('activation failed');
        expect(native.call).toHaveBeenCalledWith('engines.activate', {token: 'owned'});
        expect(native.call).toHaveBeenCalledWith('engines.discard', {token: 'owned'});
    });
    it('reads native installation state without inspecting files in Node', () => {
        native.sync.mockReturnValueOnce({installed: true}).mockReturnValueOnce('native-path');
        expect(getLocalEngineStatus()).toEqual({installed: true}); expect(getTexthookRuntimeDir()).toBe('native-path');
    });
});
