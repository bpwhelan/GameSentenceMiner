import type { IpcBridge, IpcEventLike } from "../types/global";

const DEV_PREVIEW_PARAMETER = "preview";
const PREVIEW_SCENE = { id: "agent-preview", name: "Agent Preview" };

type IpcListener = (event: IpcEventLike, ...args: unknown[]) => void;

export function getDevPreviewTab(): string | null {
  if (!import.meta.env.DEV) {
    return null;
  }
  return new URLSearchParams(window.location.search).get(DEV_PREVIEW_PARAMETER);
}

function previewInvokeResult(channel: string): unknown {
  switch (channel) {
    case "settings.getSettings":
      return {
        locale: "en",
        visibleTabs: ["launcher", "stats", "python", "console"]
      };
    case "obs.getScenes":
      return [PREVIEW_SCENE];
    case "obs.getActiveScene":
      return PREVIEW_SCENE;
    case "obs.getWindows":
      return [];
    case "ocr.getActiveOCRConfig":
      return {
        scene: PREVIEW_SCENE.id,
        coordinate_system: "screen",
        rectangles: [{}, {}]
      };
    case "ocr.getActiveSceneSettings":
      return { furigana_filter_sensitivity: 35 };
    case "ocr.get-running-state":
      return { isRunning: false, mode: null, source: "preview" };
    case "ocr.get-ocr-config":
      return {
        advancedMode: false,
        gamepadHotkeysEnabled: false,
        language: "ja",
        manualOcrHotkey: "Ctrl+Shift+M",
        menuOcrHotkey: "Ctrl+Shift+G",
        areaSelectOcrHotkey: "Ctrl+Shift+A",
        wholeWindowOcrHotkey: "Ctrl+Shift+W",
        globalPauseHotkey: "Shift+A",
        manualOcrDelayMs: 200,
        scanRate_basic: 0.5
      };
    case "texthook.getHooks":
      return { hooks: [], selectedHookId: null };
    case "texthook.builtInHookTargets":
      return [];
    case "getOverlayStatus":
      return { isRunning: false };
    case "python.getPythonInfo":
      return {
        success: true,
        pythonVersion: "Preview",
        pythonPath: "Preview",
        pipVersion: "Preview"
      };
    case "data.getCurrentDir":
    case "data.getDefaultDir":
      return "C:\\GSM\\Preview";
    case "install-session.getActive":
    case "changelog.getPendingDesktopUpdate":
    case "get_gsm_status":
      return null;
    default:
      return null;
  }
}

export function installDevPreviewBridge(): void {
  if (!getDevPreviewTab() || window.ipcRenderer) {
    return;
  }

  const listeners = new Map<string, Set<IpcListener>>();
  const removeListener = (channel: string, listener: IpcListener) => {
    listeners.get(channel)?.delete(listener);
  };
  const addListener = (channel: string, listener: IpcListener) => {
    const channelListeners = listeners.get(channel) ?? new Set<IpcListener>();
    channelListeners.add(listener);
    listeners.set(channel, channelListeners);
  };

  const bridge: IpcBridge = {
    invoke: async <T,>(channel: string) => previewInvokeResult(channel) as T,
    send: () => undefined,
    on: (channel, listener) => {
      addListener(channel, listener);
      return () => removeListener(channel, listener);
    },
    once: (channel, listener) => {
      const wrapped: IpcListener = (event, ...args) => {
        removeListener(channel, wrapped);
        listener(event, ...args);
      };
      addListener(channel, wrapped);
    },
    removeListener,
    removeAllListeners: (channel) => listeners.delete(channel)
  };

  Object.defineProperty(window, "ipcRenderer", {
    configurable: true,
    value: bridge
  });
  Object.defineProperty(window, "clipboard", {
    configurable: true,
    value: { readText: () => "", writeText: () => undefined }
  });
  Object.defineProperty(window, "gsmEnv", {
    configurable: true,
    value: { platform: "win32" }
  });
}
