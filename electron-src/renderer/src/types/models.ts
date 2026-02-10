export interface ObsScene {
  name: string;
  id: string;
}

export interface ObsWindow {
  title: string;
  value: string;
  captureMode?: string;
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
  agentScriptPath: string;
}

export interface GameSettings {
  agentPath: string;
  agentScriptsPath: string;
  textractorPath64: string;
  textractorPath32: string;
  lunaTranslatorPath: string;
  sceneProfiles: SceneLaunchProfile[];
}

export type ControlledTab = "launcher" | "stats" | "python" | "console";

export interface AppSettings {
  autoUpdateGSMApp: boolean;
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
}

export interface GsmStatus {
  ready: boolean;
  status: string;
  websockets_connected: string[];
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
