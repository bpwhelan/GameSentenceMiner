export interface ObsScene {
  name: string;
  id: string;
}

export type ObsCaptureMode = "window_capture" | "game_capture";
export type ObsSetupTargetKind = "window" | "capture_card";

export interface ObsWindow {
  title: string;
  value: string;
  targetKind?: ObsSetupTargetKind;
  captureValues?: Partial<Record<ObsCaptureMode, string>>;
  captureMode?: ObsCaptureMode;
  videoDeviceId?: string;
  audioDeviceId?: string;
  wasapiInputDeviceId?: string;
}

export type HookableGameType = "steam" | "yuzu" | "vn" | "none";

export interface LaunchableGame {
  name: string;
  id: string;
  type: HookableGameType;
  isHeader?: boolean;
  scene?: ObsScene;
  agentDelay?: number;
}

export interface OCRGameConfig {
  scene: ObsScene;
  configPath: string;
}

export interface FrontPageState {
  agentEnabled?: boolean;
  ocrEnabled?: boolean;
  selectedGame?: LaunchableGame;
  launchableGames?: LaunchableGame[];
}

export type SceneTextHookMode = "none" | "agent" | "textractor" | "luna";
export type SceneOcrMode = "none" | "auto" | "manual";

export interface SceneLaunchProfile {
  sceneId?: string;
  sceneName: string;
  textHookMode: SceneTextHookMode;
  ocrMode: SceneOcrMode;
  launchOverlay: boolean;
  agentScriptPath: string;
  launchDelaySeconds: number;
}

export interface GameSettings {
  agentPath: string;
  agentScriptsPath: string;
  textractorPath64: string;
  textractorPath32: string;
  lunaTranslatorPath: string;
  launchAgentMinimized: boolean;
  launchTextractorMinimized: boolean;
  launchLunaTranslatorMinimized: boolean;
  sceneProfiles: SceneLaunchProfile[];
}

export type ControlledTab = "launcher" | "stats" | "python" | "console";

export interface AppSettings {
  autoUpdateGSMApp: boolean;
  pullPreReleases: boolean;
  iconStyle: string;
  startConsoleMinimized: boolean;
  customPythonPackage: string;
  showYuzuTab: boolean;
  windowTransparencyToolHotkey: string;
  windowTransparencyTarget: string;
  runWindowTransparencyToolOnStartup: boolean;
  runOverlayOnStartup: boolean;
  visibleTabs: ControlledTab[];
  statsEndpoint: string;
  locale: string;
}

export interface GsmStatus {
  ready: boolean;
  status: string;
  websockets_connected: Record<string, string>;
  obs_connected: boolean;
  anki_connected: boolean;
  last_line_received?: string;
  words_being_processed?: string | string[];
  clipboard_enabled: boolean;
}

export interface LaunchResponse {
  status: string;
  message: string;
}

export interface UpdateTargetStatus {
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  error: string | null;
  checking: boolean;
  source?: "pypi" | "prerelease-branch";
  branch?: string | null;
  channel?: "latest" | "beta";
}

export interface UpdateStatusSnapshot {
  backend: UpdateTargetStatus;
  app: UpdateTargetStatus;
  anyUpdateInProgress: boolean;
}
