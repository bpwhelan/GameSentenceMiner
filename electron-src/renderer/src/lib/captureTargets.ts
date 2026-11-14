import type { CaptureWindow } from '../../../shared/capture';
import { getGameInfoFromWindow, shouldFilterWindow } from '../../../shared/capture_window_policy';
import type { ObsWindow } from '../types/models';
import { invokeIpc } from './ipc';

const nativePicker = () => window.gsmEnv?.shell === 'tauri' && window.gsmEnv.platform === 'win32';
const encode = (part: string) => part.replace(/#/g, '#22').replace(/:/g, '#3A');

/** OBS selectors are an adapter of the catalog, never its identity. */
export function toObsTarget(source: CaptureWindow): ObsWindow | null {
  const exe = source.processPath?.split(/[\\/]/).pop();
  if (!exe || !source.windowClass) return null;
  const selector = [source.title, source.windowClass, exe].map(encode).join(':');
  if (shouldFilterWindow({ itemName: `[${exe}]: ${source.title}`, itemValue: selector })) return null;
  return {
    title: source.title, value: source.id, targetKind: 'window', captureSource: source,
    suggestedSceneName: getGameInfoFromWindow(source.title).sceneName,
    lastFocusedAt: source.lastFocusedAt,
    captureValues: { window_capture: selector, game_capture: selector },
  };
}

export async function loadCaptureTargets(options: { quick?: boolean; refresh?: boolean }): Promise<ObsWindow[]> {
  if (!nativePicker()) {
    const targets = await invokeIpc<ObsWindow[]>('obs.getWindows', options);
    return targets.filter(target => target.targetKind !== 'window' || !shouldFilterWindow({ itemName: target.title, itemValue: target.value }));
  }
  const [sources, devices] = await Promise.all([
    invokeIpc<CaptureWindow[]>('capture.listWindows'),
    invokeIpc<ObsWindow[]>('obs.getCaptureDevices', options).catch(() => []),
  ]);
  const bySelector = new Map<string, ObsWindow>();
  for (const source of sources) {
    const target = toObsTarget(source);
    if (!target) continue;
    const selector = target.captureValues!.window_capture!;
    const existing = bySelector.get(selector);
    if (existing) {
      // OBS identifies windows by title/class/executable, not HWND. Do not show
      // a specific window's picture when OBS cannot distinguish the choices.
      delete existing.captureSource;
      existing.lastFocusedAt = Math.max(existing.lastFocusedAt ?? 0, target.lastFocusedAt ?? 0) || undefined;
    } else bySelector.set(selector, target);
  }
  const windows = [...bySelector.values()];
  windows.sort((a, b) => (b.lastFocusedAt ?? 0) - (a.lastFocusedAt ?? 0) || a.title.localeCompare(b.title));
  return [...windows, ...devices];
}

export function loadCapturePreviews(targets: ObsWindow[]): Promise<{ value: string; imageData: string }[]> {
  if (!nativePicker()) return invokeIpc('obs.getWindowPreviews');
  return invokeIpc('capture.getWindowPreviews', targets.filter(target => target.captureSource)
    .map(target => ({ value: target.value, source: target.captureSource })));
}
