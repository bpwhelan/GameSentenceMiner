// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { loadCaptureTargets, loadCapturePreviews } from './captureTargets';

afterEach(() => vi.unstubAllGlobals());
const game = { id: 'window:42:7', title: '月姫: #1', processPath: 'C:\\Games\\game.exe', pid: 7, windowClass: 'Game', minimized: false };
function bridge(invoke: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('window', { gsmEnv: { shell: 'tauri', platform: 'win32' }, ipcRenderer: { invoke } });
}
it('lists native windows even when OBS device enumeration fails', async () => {
  const invoke = vi.fn(async (channel) => {
    if (channel === 'capture.listWindows') return [game];
    throw Error('OBS unavailable');
  });
  bridge(invoke);
  const result = await loadCaptureTargets({ quick: true, refresh: true });
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ title: game.title, captureSource: game, captureValues: { window_capture: '月姫#3A #221:Game:game.exe' } });
  expect(invoke).not.toHaveBeenCalledWith('obs.getWindows', expect.anything());
});
it('preserves device choices and passes only explicit window identities for previews', async () => {
  const card = { title: 'Card', value: 'card', targetKind: 'capture_card' };
  const invoke = vi.fn(async channel => channel === 'capture.listWindows' ? [game] : channel === 'obs.getCaptureDevices' ? [card] : []);
  bridge(invoke);
  const result = await loadCaptureTargets({ quick: false });
  expect(result).toContainEqual(card);
  await loadCapturePreviews(result);
  expect(invoke).toHaveBeenLastCalledWith('capture.getWindowPreviews', [{ value: result[0].value, source: game }]);
});
it('keeps the existing portal/device path on Linux', async () => {
  const invoke = vi.fn().mockResolvedValue([]);
  vi.stubGlobal('window', { gsmEnv: { shell: 'tauri', platform: 'linux' }, ipcRenderer: { invoke } });
  await loadCaptureTargets({ quick: true });
  expect(invoke).toHaveBeenCalledWith('obs.getWindows', { quick: true });
});

it('does not promise a particular window when OBS cannot distinguish duplicate titles', async () => {
  bridge(vi.fn(async channel => channel === 'capture.listWindows' ? [game, { ...game, id:'window:43:7' }] : []));
  const result = await loadCaptureTargets({});
  expect(result).toHaveLength(1);
  expect(result[0].captureSource).toBeUndefined();
});
