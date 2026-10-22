import type { IpcBridge, IpcEventLike } from "../types/global";

const DEV_PREVIEW_PARAMETER = "preview";
const PREVIEW_SCENE = { id: "agent-preview", name: "Agent Preview" };
const PREVIEW_HOOKS = [
  {
    id: "12",
    function: "Dialogue",
    preview: "今日は一緒に帰ろう。",
    samples: ["今日は一緒に帰ろう。"],
  },
  { id: "26", function: "Character name", preview: "葵", samples: ["葵"] },
  { id: "31", function: "File access", preview: "C:\\Game\\data\\scenario.bin", samples: [] },
];

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
        visibleTabs: ["launcher", "stats", "python", "console"],
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
        coordinate_system: "percentage",
        window_geometry: { width: 1920, height: 1080 },
        rectangles: [
          { coordinates: [0.08, 0.7, 0.84, 0.24], is_excluded: false },
          { coordinates: [0.68, 0.15, 0.24, 0.4], is_excluded: false, is_secondary: true },
        ],
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
        scanRate_basic: 0.5,
      };
    case "texthook.getActiveCapture":
      return {
        sceneName: PREVIEW_SCENE.name,
        sceneId: PREVIEW_SCENE.id,
        exeName: "game.exe",
        pid: 1234,
        arch: "x64",
      };
    case "texthook.getSettings":
      return { maxBufferSize: 3000, targetLanguage: "ja" };
    case "texthook.getEngineStatus":
    case "texthook.checkEngineUpdates":
      return { installed: true, version: "Preview", automatic: true, phase: "idle" };
    case "texthook.builtInHookTargets":
      return [];
    case "settings.listAgentScripts":
      return { status: "success", scripts: ["C:\\GSM\\scripts\\PC - Agent Preview.js"] };
    case "settings.resolveAgentScriptForScene":
      return { status: "success", path: "C:\\GSM\\scripts\\PC - Agent Preview.js" };
    case "getOverlayStatus":
      return { isRunning: false };
    case "python.getPythonInfo":
      return {
        success: true,
        pythonVersion: "Preview",
        pythonPath: "Preview",
        pipVersion: "Preview",
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
  let previewMode: "auto" | "manual" | null = null;
  let previewPaused = false;
  let hookRunning = false;
  let hookEngine = "luna";
  let previewSelectedHook: string | null = null;
  let hookProfile: unknown = null;
  const emit = (channel: string, ...args: unknown[]) => {
    for (const listener of listeners.get(channel) ?? []) {
      listener({ sender: null }, ...args);
    }
  };
  const emitStatus = () =>
    emit("ocr-ipc-status", {
      manual: previewMode === "manual",
      paused: previewPaused,
      current_engine: "screenai",
      scan_rate: 0.5,
    });
  const removeListener = (channel: string, listener: IpcListener) => {
    listeners.get(channel)?.delete(listener);
  };
  const addListener = (channel: string, listener: IpcListener) => {
    const channelListeners = listeners.get(channel) ?? new Set<IpcListener>();
    channelListeners.add(listener);
    listeners.set(channel, channelListeners);
  };

  const bridge: IpcBridge = {
    invoke: async <T>(channel: string, ...args: unknown[]) => {
      if (channel === "texthook.getStatus")
        return (
          hookRunning
            ? {
                running: true,
                engine: hookEngine,
                arch: "x64",
                pid: 1234,
                exeName: "game.exe",
                selectedHookId: previewSelectedHook,
                hookCount: PREVIEW_HOOKS.length,
                flushDelayMs: 100,
              }
            : { running: false }
        ) as T;
      if (channel === "texthook.listHooks")
        return {
          hooks: hookRunning ? PREVIEW_HOOKS : [],
          selectedHookId: previewSelectedHook,
        } as T;
      if (channel === "texthook.getProfile") return hookProfile as T;
      if (channel === "texthook.start") {
        hookRunning = true;
        hookEngine = (args[0] as { engine: string }).engine;
        emit("texthook.log", { message: "Preview capture attached to game.exe.", level: "info" });
        return { success: true, pid: 1234, exeName: "game.exe" } as T;
      }
      if (channel === "texthook.stop") {
        hookRunning = false;
        previewSelectedHook = null;
        return { success: true } as T;
      }
      if (channel === "texthook.selectHook") {
        previewSelectedHook = String(args[0]);
        const hookId = previewSelectedHook;
        // The component clears the previous hook's text when selection completes.
        window.setTimeout(
          () =>
            emit("texthook.text", {
              hookId,
              text: PREVIEW_HOOKS.find((hook) => hook.id === hookId)?.preview ?? "",
              ts: Date.now(),
            }),
          100,
        );
        return { success: true } as T;
      }
      if (channel === "texthook.saveProfile") {
        hookProfile = args[0];
        return { success: true, profile: hookProfile } as T;
      }
      if (channel === "texthook.deleteProfile") {
        hookProfile = null;
        return { success: true } as T;
      }
      return (
        channel === "ocr.get-running-state"
          ? { isRunning: previewMode !== null, mode: previewMode, source: "preview" }
          : previewInvokeResult(channel)
      ) as T;
    },
    send: (channel) => {
      if (channel === "ocr.start-ocr" || channel === "ocr.start-ocr-ss-only") {
        previewMode = channel === "ocr.start-ocr" ? "auto" : "manual";
        previewPaused = false;
        emit("ocr-started");
        emitStatus();
      } else if (channel === "ocr.kill-ocr") {
        previewMode = null;
        previewPaused = false;
        emit("ocr-stopped");
      } else if (channel === "ocr.toggle-pause" && previewMode !== null) {
        previewPaused = !previewPaused;
        emitStatus();
      } else if (channel === "ocr.get-status" && previewMode !== null) {
        emitStatus();
      }
    },
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
    removeAllListeners: (channel) => listeners.delete(channel),
  };

  Object.defineProperty(window, "ipcRenderer", {
    configurable: true,
    value: bridge,
  });
  Object.defineProperty(window, "clipboard", {
    configurable: true,
    value: { readText: () => "", writeText: () => undefined },
  });
  Object.defineProperty(window, "gsmEnv", {
    configurable: true,
    value: { platform: "win32" },
  });
}
