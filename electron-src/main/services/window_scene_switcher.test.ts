import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ forward: vi.fn(), on: vi.fn(() => vi.fn()) }));
vi.mock('../ui/obs.js', () => ({ forwardOBSForeground: mocks.forward, onNativeOBSSceneChanged: mocks.on }));
import { configureWindowSceneSwitcherRuntime, handleForegroundWindowSnapshot, shutdownWindowSceneSwitcher } from './window_scene_switcher.js';
describe('native scene switching application notifications', () => {
  it('forwards foreground input and subscribes application reactions only', () => {
    const changed = vi.fn(); configureWindowSceneSwitcherRuntime({ onSceneChanged: changed });
    const snapshot = { hwnd: '123', pid: 10, title: 'Game', capturedAt: 100, sequence: 1 };
    handleForegroundWindowSnapshot(snapshot); expect(mocks.forward).toHaveBeenCalledWith(snapshot);
    const callback = mocks.on.mock.calls[0][0] as (() => void); callback(); expect(changed).toHaveBeenCalledTimes(1);
    shutdownWindowSceneSwitcher(); expect(mocks.on.mock.results[0].value).toHaveBeenCalled();
  });
});
