export interface ObsScene {
  name: string;
  id: string;
}

export type ObsCaptureMode = "window_capture" | "game_capture";
export type ObsSetupTargetKind = "window" | "capture_card";

export interface ObsWindow {
  title: string;
  value: string;
  /** Cleaned game name parsed from the raw window title, used as the default scene name. */
  suggestedSceneName?: string;
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
  forceManualOcrAllProfiles: boolean;
  ignoreActiveSceneForOcr: boolean;
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
  quitOnWindowClose: boolean;
  textCaptureWizardEnabled: boolean;
  visibleTabs: ControlledTab[];
  statsEndpoint: string;
  databaseBackupEnabled: boolean;
  databaseBackupDirectory: string;
  databaseBackupRetentionCount: number;
  singlePort: number;
  locale: string;
  theme: string;
}

export interface GsmStatus {
  ready: boolean;
  status: string;
  websockets_connected: Record<string, string>;
  obs_connected: boolean;
  anki_connected: boolean;
  anki_beacon_connected?: boolean;
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
  channel?: "latest" | "beta";
}

export interface UpdateStatusSnapshot {
  backend: UpdateTargetStatus;
  app: UpdateTargetStatus;
  anyUpdateInProgress: boolean;
}

export type HoshidictsSchedule = "off" | "daily" | "weekly" | "monthly";
export type HoshidictsDuplicatePolicy = "prevent" | "allow";
export type HoshidictsRecommendedDictionaryId = "jmdict" | "jmnedict";

export interface HoshidictsMiningProfile {
  version: 1;
  enabled: boolean;
  deck: string;
  model: string;
  fields: {
    expression: string;
    reading: string;
    definition: string;
    sentence: string;
    frequency: string;
    pitch: string;
  };
  tags: string[];
  duplicatePolicy: HoshidictsDuplicatePolicy;
}

export interface HoshidictsDictionaryState {
  id: string;
  title: string;
  revision: string;
  isUpdatable: boolean;
  indexUrl: string | null;
  downloadUrl: string | null;
  language: string | null;
  termCount: number;
  installedAt: string;
}

export interface HoshidictsProgress {
  phase:
    | "idle"
    | "importing"
    | "checking"
    | "downloading"
    | "reloading"
    | "removing"
    | "saving";
  title?: string;
  completed?: number;
  total?: number;
}

export interface HoshidictsState {
  dictionaries: HoshidictsDictionaryState[];
  recommendedDictionaries: Array<{
    id: HoshidictsRecommendedDictionaryId;
    installed: boolean;
  }>;
  miningProfile: HoshidictsMiningProfile;
  schedule: HoshidictsSchedule;
  lastCheck: string | null;
  nextCheck: string | null;
  lastError: string | null;
  busy: boolean;
  progress: HoshidictsProgress;
  effectiveEnabled: boolean;
}
