import { useCallback, useEffect, useState } from "react";
import {
  getChromeStoreBoolean,
  setChromeStoreBoolean
} from "../../lib/chrome_store";
import { invokeIpc, onIpc } from "../../lib/ipc";
import type {
  GameSettings,
  ObsScene,
  SceneLaunchProfile,
  SceneOcrMode,
  SceneTextHookMode
} from "../../types/models";

interface LauncherTabProps {
  active: boolean;
}

type SharedGameSettings = Omit<GameSettings, "sceneProfiles">;

interface AgentScriptCandidate {
  path: string;
  reason?: string;
  score?: number;
}

interface ResolveAgentScriptResponse {
  status?: string;
  path?: string;
  reason?: string;
  isExactYuzuIdMatch?: boolean;
  isSwitchTarget?: boolean;
  titleId?: string | null;
  candidates?: AgentScriptCandidate[];
}

interface ListAgentScriptsResponse {
  status?: string;
  path?: string;
  scripts?: string[];
  message?: string;
}

type CandidateDialogMode = "auto-detect" | "search";
type DownloadableTool = "agent" | "textractor";
type ToolName = DownloadableTool | "luna";

interface DownloadToolPaths {
  agentPath?: string;
  agentScriptsPath?: string;
  textractorPath64?: string;
  textractorPath32?: string;
  lunaTranslatorPath?: string;
}

interface DownloadToolResponse {
  status?: string;
  message?: string;
  tool?: ToolName;
  destinationPath?: string;
  releaseTag?: string;
  assetName?: string;
  releasePageUrl?: string;
  paths?: DownloadToolPaths;
}

const DEFAULT_SHARED_SETTINGS: SharedGameSettings = {
  agentPath: "",
  agentScriptsPath: "",
  textractorPath64: "",
  textractorPath32: "",
  lunaTranslatorPath: "",
  launchAgentMinimized: false,
  launchTextractorMinimized: false,
  launchLunaTranslatorMinimized: false
};

const SHARED_TOOL_SETTINGS_EXPANDED_KEY = "launcher.sharedToolSettingsExpanded";

const TAB_OVERVIEW_TOOLTIP =
  "Configure shared text-hook tool paths and per-scene automation. Pick one text hook mode (None/Agent/Textractor/Luna) and one OCR mode (None/Auto/Manual) for each OBS scene.";

const TOOLTIPS = {
  sharedToolSettings:
    "Shared paths used by Game Settings across all OBS scenes in this profile.",
  sceneAutomation:
    "Scene-specific startup behavior. Each scene can use different text hook and OCR settings.",
  agentPath:
    "Path to Agent executable used when Text Hook Launcher is set to Agent.",
  agentScriptsPath:
    "Folder containing Agent script files (.js). Used for Auto Detect and Browse defaults.",
  textractor64:
    "Path to 64-bit Textractor executable. Used when scene launcher is set to Textractor.",
  textractor32:
    "Path to 32-bit Textractor executable. Used for 32-bit game targets when available.",
  lunaPath:
    "Path to LunaTranslator executable. Used when scene launcher is set to LunaTranslator.",
  launchAgentMinimized:
    "Launch Agent minimized/hidden on Windows.",
  launchTextractorMinimized:
    "Launch Textractor minimized/hidden on Windows.",
  launchLunaTranslatorMinimized:
    "Launch LunaTranslator minimized/hidden on Windows.",
  activeScene:
    "Current OBS program scene currently active. Configuration changes apply to the selected Configure Scene value.",
  configureScene:
    "Choose which OBS scene profile you are editing in this tab.",
  refreshScenes:
    "Refresh OBS scene list from current OBS connection.",
  textHookMode:
    "Select one text hook launcher mode for this scene.",
  textHookNone:
    "Do not auto-launch a text hook tool for this scene.",
  textHookAgent:
    "Launch Agent for this scene and use the configured Agent Script.",
  textHookTextractor:
    "Auto-launch Textractor when this scene becomes active.",
  textHookLuna:
    "Auto-launch LunaTranslator when this scene becomes active.",
  launchDelay:
    "Delay before starting the selected text hook launcher for this scene.",
  agentScript:
    "Agent script path for this scene. You can set manually, browse, or auto-detect.",
  autoDetect:
    "Find likely script matches and choose one. High-confidence matches (85%+) may apply automatically.",
  browseScript:
    "Open file picker and choose an Agent script for this scene.",
  searchScript:
    "Search all scripts under Agent Scripts Path and choose one.",
  downloadAgent:
    "Download latest Agent from official GitHub releases. Choose install folder (default: ~/Documents/Agent).",
  downloadTextractor:
    "Download latest Textractor from official GitHub releases. Choose install folder (default: ~/Documents/Textractor). Sets both x64 and x86 paths.",
  downloadLuna:
    "Open the LunaTranslator official GitHub releases page.",
  ocrMode:
    "Select one OCR mode for this scene.",
  ocrNone:
    "Do not start OCR for this scene.",
  ocrAuto:
    "Start continuous Auto OCR when this scene is active.",
  ocrManual:
    "Do not auto-start OCR for this scene. Use manual OCR controls or hotkeys.",
  status:
    "Latest save/detect status from Game Settings actions.",
  candidatePicker:
    "Choose the best matching Agent script candidate for this scene.",
  noScene:
    "No scene profile is loaded. Select a scene first."
};

function isTextHookMode(value: unknown): value is SceneTextHookMode {
  return value === "none" || value === "agent" || value === "textractor" || value === "luna";
}

function isOcrMode(value: unknown): value is SceneOcrMode {
  return value === "none" || value === "auto" || value === "manual";
}

function normalizeLaunchDelaySeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  const clamped = Math.max(0, Math.min(300, value));
  return Math.round(clamped * 10) / 10;
}

function toObsScene(value: unknown): ObsScene | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const scene = value as Partial<ObsScene>;
  if (typeof scene.id !== "string" || typeof scene.name !== "string") {
    return null;
  }

  return { id: scene.id, name: scene.name };
}

function toObsScenes(value: unknown): ObsScene[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => toObsScene(entry))
    .filter((scene): scene is ObsScene => scene !== null);
}

function defaultSceneProfile(scene: ObsScene): SceneLaunchProfile {
  return {
    sceneId: scene.id,
    sceneName: scene.name,
    textHookMode: "none",
    ocrMode: "none",
    agentScriptPath: "",
    launchDelaySeconds: 0
  };
}

function normalizeSceneProfile(
  value: Partial<SceneLaunchProfile> | null | undefined,
  scene: ObsScene
): SceneLaunchProfile {
  return {
    sceneId: scene.id,
    sceneName: scene.name,
    textHookMode: isTextHookMode(value?.textHookMode) ? value.textHookMode : "none",
    ocrMode: isOcrMode(value?.ocrMode) ? value.ocrMode : "none",
    agentScriptPath:
      typeof value?.agentScriptPath === "string" ? value.agentScriptPath : "",
    launchDelaySeconds: normalizeLaunchDelaySeconds(value?.launchDelaySeconds)
  };
}

function normalizeSharedSettings(
  value: Partial<GameSettings> | null | undefined
): SharedGameSettings {
  return {
    agentPath: typeof value?.agentPath === "string" ? value.agentPath : "",
    agentScriptsPath:
      typeof value?.agentScriptsPath === "string" ? value.agentScriptsPath : "",
    textractorPath64:
      typeof value?.textractorPath64 === "string" ? value.textractorPath64 : "",
    textractorPath32:
      typeof value?.textractorPath32 === "string" ? value.textractorPath32 : "",
    lunaTranslatorPath:
      typeof value?.lunaTranslatorPath === "string" ? value.lunaTranslatorPath : "",
    launchAgentMinimized: Boolean(value?.launchAgentMinimized),
    launchTextractorMinimized: Boolean(value?.launchTextractorMinimized),
    launchLunaTranslatorMinimized: Boolean(value?.launchLunaTranslatorMinimized)
  };
}

function fileNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments[segments.length - 1] || filePath;
}

function formatCandidateReason(reason?: string): string {
  if (reason === "matched_explicit_id") {
    return "Explicit ID";
  }
  if (reason === "matched_title_id") {
    return "Title ID";
  }
  if (reason === "matched_name") {
    return "Name Match";
  }
  if (reason === "matched_fuzzy_name") {
    return "Fuzzy Match";
  }
  return "Possible Match";
}

function scoreToConfidence(score?: number): number | null {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return null;
  }
  return Math.max(0, Math.min(1, 1 - score));
}

function formatCandidateConfidence(score?: number): string {
  const confidence = scoreToConfidence(score);
  if (confidence === null) {
    return "";
  }
  const percentage = Math.round(confidence * 100);
  return `${percentage}% match`;
}

export function LauncherTab({ active }: LauncherTabProps) {
  const [sharedSettings, setSharedSettings] = useState<SharedGameSettings>(
    DEFAULT_SHARED_SETTINGS
  );
  const [obsScenes, setObsScenes] = useState<ObsScene[]>([]);
  const [activeScene, setActiveScene] = useState<ObsScene | null>(null);
  const [configuredSceneId, setConfiguredSceneId] = useState("");
  const [sceneProfile, setSceneProfile] = useState<SceneLaunchProfile | null>(null);
  const [candidateDialog, setCandidateDialog] = useState<{
    sceneId: string;
    candidates: AgentScriptCandidate[];
    mode: CandidateDialogMode;
    query: string;
  } | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [downloadingTool, setDownloadingTool] = useState<DownloadableTool | null>(null);
  const [isSharedToolSettingsExpanded, setIsSharedToolSettingsExpanded] =
    useState<boolean>(() =>
      getChromeStoreBoolean(SHARED_TOOL_SETTINGS_EXPANDED_KEY, true)
    );

  const toggleSharedToolSettingsExpanded = useCallback(() => {
    setIsSharedToolSettingsExpanded((current) => {
      const next = !current;
      setChromeStoreBoolean(SHARED_TOOL_SETTINGS_EXPANDED_KEY, next);
      return next;
    });
  }, []);

  const getToolLabel = useCallback((tool: DownloadableTool): string => {
    if (tool === "agent") {
      return "Agent";
    }
    return "Textractor";
  }, []);

  const openToolReleasesPage = useCallback(async (tool: ToolName) => {
    try {
      const response = await invokeIpc<{ status?: string }>(
        "settings.openToolReleasesPage",
        { tool }
      );
      if (response?.status === "success") {
        const label = tool === "luna" ? "LunaTranslator" : tool === "agent" ? "Agent" : "Textractor";
        setStatusMessage(`Opened ${label} releases page.`);
        return;
      }
      setStatusMessage("Failed to open releases page.");
    } catch (error) {
      console.error("Failed to open releases page:", error);
      setStatusMessage("Failed to open releases page.");
    }
  }, []);

  const loadSharedSettings = useCallback(async () => {
    try {
      const fetched = await invokeIpc<Partial<GameSettings>>("settings.getGameSettings");
      setSharedSettings(normalizeSharedSettings(fetched));
    } catch (error) {
      console.error("Failed to load game settings:", error);
    }
  }, []);

  const refreshActiveScene = useCallback(async () => {
    try {
      const fetchedScene = await invokeIpc<ObsScene | null>("obs.getActiveScene");
      const nextScene = toObsScene(fetchedScene);
      setActiveScene((current) => {
        if (
          current &&
          nextScene &&
          current.id === nextScene.id &&
          current.name === nextScene.name
        ) {
          return current;
        }
        return nextScene;
      });
    } catch (error) {
      console.error("Failed to fetch active OBS scene:", error);
    }
  }, []);

  const loadObsScenes = useCallback(async () => {
    try {
      const fetchedScenes = await invokeIpc<unknown>("obs.getScenes");
      const nextScenes = toObsScenes(fetchedScenes);
      setObsScenes(nextScenes);
      setConfiguredSceneId((current) => {
        if (current && nextScenes.some((scene) => scene.id === current)) {
          return current;
        }
        return nextScenes[0]?.id ?? "";
      });
    } catch (error) {
      console.error("Failed to fetch OBS scenes:", error);
    }
  }, []);

  useEffect(() => {
    if (!active) {
      return;
    }

    void loadSharedSettings();
    void loadObsScenes();
    void refreshActiveScene();

    const scenesTimer = setInterval(() => {
      void loadObsScenes();
    }, 5000);

    return () => {
      clearInterval(scenesTimer);
    };
  }, [active, loadObsScenes, loadSharedSettings, refreshActiveScene]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const removeStateListener = onIpc("state-changed", (_event, payload) => {
      const statePayload = payload as {
        key?: string;
        value?: unknown;
      };

      if (statePayload?.key !== "obs.activeScene") {
        return;
      }

      const nextScene = toObsScene(statePayload.value);
      if (!nextScene) {
        return;
      }

      setActiveScene((current) => {
        if (current && current.id === nextScene.id && current.name === nextScene.name) {
          return current;
        }
        return nextScene;
      });
    });

    const sceneTimer = setInterval(() => {
      void refreshActiveScene();
    }, 1000);

    return () => {
      removeStateListener();
      clearInterval(sceneTimer);
    };
  }, [active, refreshActiveScene]);

  useEffect(() => {
    if (!activeScene) {
      return;
    }
    setConfiguredSceneId(activeScene.id);
  }, [activeScene]);

  const configuredScene =
    obsScenes.find((scene) => scene.id === configuredSceneId) ?? activeScene;

  useEffect(() => {
    setCandidateDialog(null);
  }, [configuredSceneId]);

  useEffect(() => {
    if (!configuredScene) {
      setSceneProfile(null);
      return;
    }

    const loadSceneProfile = async () => {
      try {
        const fetched = await invokeIpc<Partial<SceneLaunchProfile> | null>(
          "settings.getSceneLaunchProfile",
          configuredScene
        );
        setSceneProfile(normalizeSceneProfile(fetched, configuredScene));
      } catch (error) {
        console.error("Failed to load scene launch profile:", error);
        setSceneProfile(defaultSceneProfile(configuredScene));
      }
    };

    void loadSceneProfile();
  }, [configuredScene]);

  const saveSharedField = useCallback(
    async (
      field: "agentPath" | "agentScriptsPath" | "textractorPath64" | "textractorPath32" | "lunaTranslatorPath",
      rawValue: string
    ) => {
      const trimmedValue = rawValue.trim();
      setSharedSettings((current) => ({
        ...current,
        [field]: trimmedValue
      }));

      const payload = { [field]: trimmedValue } as Partial<SharedGameSettings>;
      await invokeIpc("settings.saveGameSettings", payload);
      setStatusMessage("Saved shared game settings.");
    },
    []
  );

  const saveSharedToggle = useCallback(
    async (
      field:
        | "launchAgentMinimized"
        | "launchTextractorMinimized"
        | "launchLunaTranslatorMinimized",
      value: boolean
    ) => {
      setSharedSettings((current) => ({
        ...current,
        [field]: value
      }));

      await invokeIpc("settings.saveGameSettings", { [field]: value });
      setStatusMessage("Saved shared game settings.");
    },
    []
  );

  const pickPath = useCallback(
    async (channel: string, field: keyof SharedGameSettings) => {
      const result = await invokeIpc<{ status?: string; path?: string }>(channel);
      if (result?.status !== "success" || typeof result.path !== "string") {
        return;
      }

      setSharedSettings((current) => ({
        ...current,
        [field]: result.path ?? ""
      }));
      setStatusMessage("Updated shared path setting.");
    },
    []
  );

  const patchSceneProfile = useCallback(
    async (
      patch: Partial<
        Pick<
          SceneLaunchProfile,
          "textHookMode" | "ocrMode" | "agentScriptPath" | "launchDelaySeconds"
        >
      >
    ) => {
      if (!configuredScene) {
        return;
      }

      const current = sceneProfile ?? defaultSceneProfile(configuredScene);
      const next: SceneLaunchProfile = {
        ...current,
        ...patch,
        sceneId: configuredScene.id,
        sceneName: configuredScene.name,
        agentScriptPath:
          typeof patch.agentScriptPath === "string"
            ? patch.agentScriptPath.trim()
            : current.agentScriptPath,
        launchDelaySeconds:
          typeof patch.launchDelaySeconds === "number"
            ? normalizeLaunchDelaySeconds(patch.launchDelaySeconds)
            : current.launchDelaySeconds
      };

      setSceneProfile(next);
      await invokeIpc("settings.saveSceneLaunchProfile", {
        scene: configuredScene,
        textHookMode: next.textHookMode,
        ocrMode: next.ocrMode,
        agentScriptPath: next.agentScriptPath,
        launchDelaySeconds: next.launchDelaySeconds
      });
      setStatusMessage(`Saved automation for scene: ${configuredScene.name}`);
    },
    [configuredScene, sceneProfile]
  );

  const pickSceneAgentScript = useCallback(async () => {
    if (!configuredScene || !sceneProfile) {
      return;
    }

    const result = await invokeIpc<{ status?: string; path?: string }>(
      "settings.selectAgentScriptPath",
      {
        path: sceneProfile.agentScriptPath || sharedSettings.agentScriptsPath
      }
    );
    if (result?.status !== "success" || typeof result.path !== "string") {
      return;
    }

    await patchSceneProfile({ agentScriptPath: result.path });
    setStatusMessage(`Updated agent script for scene: ${configuredScene.name}`);
  }, [configuredScene, patchSceneProfile, sceneProfile, sharedSettings.agentScriptsPath]);

  const autoResolveSceneAgentScript = useCallback(async () => {
    if (!configuredScene) {
      return;
    }

    const result = await invokeIpc<ResolveAgentScriptResponse>(
      "settings.resolveAgentScriptForScene",
      { scene: configuredScene }
    );

    if (
      result?.isExactYuzuIdMatch === true &&
      result.status === "success" &&
      typeof result.path === "string"
    ) {
      await patchSceneProfile({ agentScriptPath: result.path });
      setStatusMessage(`Auto-detected exact Yuzu script for scene: ${configuredScene.name}`);
      return;
    }

    const candidates = Array.isArray(result?.candidates)
      ? result.candidates.filter(
          (candidate): candidate is AgentScriptCandidate =>
            Boolean(candidate && typeof candidate.path === "string" && candidate.path.trim())
        )
      : [];

    const dialogCandidates =
      candidates.length > 0
        ? candidates
        : result?.status === "success" && typeof result.path === "string"
          ? [{ path: result.path, reason: result.reason }]
          : [];

    const bestHighConfidenceCandidate = candidates
      .filter((candidate) => {
        const confidence = scoreToConfidence(candidate.score);
        return confidence !== null && confidence >= 0.85;
      })
      .sort((left, right) => {
        const leftConfidence = scoreToConfidence(left.score) ?? 0;
        const rightConfidence = scoreToConfidence(right.score) ?? 0;
        return rightConfidence - leftConfidence;
      })[0];

    if (bestHighConfidenceCandidate) {
      const confidenceLabel = formatCandidateConfidence(bestHighConfidenceCandidate.score);
      await patchSceneProfile({ agentScriptPath: bestHighConfidenceCandidate.path });
      setStatusMessage(
        `Auto-selected ${confidenceLabel || "high-confidence"} script for scene: ${configuredScene.name}`
      );
      return;
    }

    if (dialogCandidates.length > 0) {
      setCandidateDialog({
        sceneId: configuredScene.id,
        mode: "auto-detect",
        query: "",
        candidates: dialogCandidates
      });
      return;
    }

    setStatusMessage(`No agent script candidates found for scene: ${configuredScene.name}`);
  }, [configuredScene, patchSceneProfile]);

  const openScriptSearchDialog = useCallback(async () => {
    if (!configuredScene || !sceneProfile) {
      return;
    }

    const fallbackPath =
      sharedSettings.agentScriptsPath.trim() || sceneProfile.agentScriptPath.trim();
    const result = await invokeIpc<ListAgentScriptsResponse>("settings.listAgentScripts", {
      path: fallbackPath
    });

    const scripts = Array.isArray(result?.scripts)
      ? result.scripts.filter(
          (scriptPath): scriptPath is string =>
            typeof scriptPath === "string" && scriptPath.trim().length > 0
        )
      : [];

    if (scripts.length === 0) {
      setStatusMessage(
        result?.message ?? `No scripts found for scene: ${configuredScene.name}`
      );
      return;
    }

    setCandidateDialog({
      sceneId: configuredScene.id,
      mode: "search",
      query: sceneProfile.agentScriptPath.trim(),
      candidates: scripts.map((scriptPath) => ({ path: scriptPath }))
    });
  }, [configuredScene, sceneProfile, sharedSettings.agentScriptsPath]);

  const pickCandidateScript = useCallback(
    async (candidatePath: string) => {
      if (!configuredScene || !candidatePath.trim()) {
        return;
      }
      await patchSceneProfile({ agentScriptPath: candidatePath });
      setCandidateDialog(null);
      setStatusMessage(`Selected agent script for scene: ${configuredScene.name}`);
    },
    [configuredScene, patchSceneProfile]
  );

  const handleDownloadTool = useCallback(
    async (tool: DownloadableTool) => {
      if (downloadingTool) {
        return;
      }

      const toolLabel = getToolLabel(tool);
      setDownloadingTool(tool);
      setStatusMessage(`Downloading and installing ${toolLabel}...`);

      try {
        const result = await invokeIpc<DownloadToolResponse>(
          "settings.downloadAndInstallTool",
          { tool }
        );

        if (result?.status === "success") {
          const nextPaths = result.paths ?? {};
          setSharedSettings((current) => ({
            ...current,
            agentPath:
              typeof nextPaths.agentPath === "string"
                ? nextPaths.agentPath
                : current.agentPath,
            agentScriptsPath:
              typeof nextPaths.agentScriptsPath === "string"
                ? nextPaths.agentScriptsPath
                : current.agentScriptsPath,
            textractorPath64:
              typeof nextPaths.textractorPath64 === "string"
                ? nextPaths.textractorPath64
                : current.textractorPath64,
            textractorPath32:
              typeof nextPaths.textractorPath32 === "string"
                ? nextPaths.textractorPath32
                : current.textractorPath32,
            lunaTranslatorPath:
              typeof nextPaths.lunaTranslatorPath === "string"
                ? nextPaths.lunaTranslatorPath
                : current.lunaTranslatorPath
          }));

          const versionLabel =
            typeof result.releaseTag === "string" && result.releaseTag.trim().length > 0
              ? ` (${result.releaseTag})`
              : "";
          setStatusMessage(`Installed ${toolLabel}${versionLabel}.`);
          return;
        }

        if (result?.status === "asset_not_found") {
          setStatusMessage(
            result.message ??
              `No matching ${toolLabel} download was found in the latest release. Opened releases page.`
          );
          return;
        }

        if (result?.status === "canceled") {
          setStatusMessage(`Download canceled for ${toolLabel}.`);
          return;
        }

        setStatusMessage(result?.message ?? `Failed to install ${toolLabel}.`);
      } catch (error) {
        console.error(`Failed to download/install ${toolLabel}:`, error);
        setStatusMessage(`Failed to install ${toolLabel}.`);
      } finally {
        setDownloadingTool(null);
      }
    },
    [downloadingTool, getToolLabel]
  );

  const filteredDialogCandidates = candidateDialog
    ? candidateDialog.mode === "search"
      ? candidateDialog.candidates.filter((candidate) => {
          const query = candidateDialog.query.trim().toLowerCase();
          if (!query) {
            return true;
          }
          const normalizedPath = candidate.path.toLowerCase();
          const normalizedName = fileNameFromPath(candidate.path).toLowerCase();
          return normalizedPath.includes(query) || normalizedName.includes(query);
        })
      : candidateDialog.candidates
    : [];

  return (
    <div className={`tab-panel ${active ? "active" : ""}`}>
      <div className="modern-tab">
        <div className="launcher-tab-header">
          <h1 title={TAB_OVERVIEW_TOOLTIP}>Game Settings</h1>
          <button
            type="button"
            className="launcher-info-icon"
            title={TAB_OVERVIEW_TOOLTIP}
            aria-label="Game Settings Overview"
          >
            i
          </button>
        </div>
        <div className="launcher-stack">
          <section className="card legacy-card">
            <div className="launcher-card-header">
              <h2 className="launcher-card-title" title={TOOLTIPS.sharedToolSettings}>
                Shared Tool Settings
              </h2>
              <button
                type="button"
                className="launcher-card-toggle"
                title={
                  isSharedToolSettingsExpanded
                    ? "Collapse shared tool settings."
                    : "Expand shared tool settings."
                }
                aria-label={
                  isSharedToolSettingsExpanded
                    ? "Collapse shared tool settings"
                    : "Expand shared tool settings"
                }
                aria-expanded={isSharedToolSettingsExpanded}
                aria-controls="shared-tool-settings-panel"
                onClick={toggleSharedToolSettingsExpanded}
              >
                <span aria-hidden="true">
                  {isSharedToolSettingsExpanded ? "▲" : "▼"}
                </span>
              </button>
            </div>
            {isSharedToolSettingsExpanded ? (
              <div id="shared-tool-settings-panel" className="form-group">
              <div className="input-group">
                <label htmlFor="agent-path-input" title={TOOLTIPS.agentPath}>
                  Agent Path:
                </label>
                <input
                  id="agent-path-input"
                  type="text"
                  title={TOOLTIPS.agentPath}
                  value={sharedSettings.agentPath}
                  onChange={(event) => {
                    setSharedSettings((current) => ({
                      ...current,
                      agentPath: event.target.value
                    }));
                  }}
                  onBlur={(event) => void saveSharedField("agentPath", event.target.value)}
                />
                <button
                  type="button"
                  title={TOOLTIPS.agentPath}
                  onClick={() => void pickPath("settings.selectAgentPath", "agentPath")}
                >
                  Browse
                </button>
                <button
                  type="button"
                  className="secondary"
                  title={TOOLTIPS.downloadAgent}
                  disabled={downloadingTool !== null}
                  onClick={() => {
                    void handleDownloadTool("agent");
                  }}
                >
                  {downloadingTool === "agent" ? "Downloading..." : "Download"}
                </button>
              </div>

              <div className="input-group">
                <label htmlFor="agent-scripts-path-input" title={TOOLTIPS.agentScriptsPath}>
                  Agent Scripts Path:
                </label>
                <input
                  id="agent-scripts-path-input"
                  type="text"
                  title={TOOLTIPS.agentScriptsPath}
                  value={sharedSettings.agentScriptsPath}
                  onChange={(event) => {
                    setSharedSettings((current) => ({
                      ...current,
                      agentScriptsPath: event.target.value
                    }));
                  }}
                  onBlur={(event) =>
                    void saveSharedField("agentScriptsPath", event.target.value)
                  }
                />
                <button
                  type="button"
                  title={TOOLTIPS.agentScriptsPath}
                  onClick={() =>
                    void pickPath("settings.selectAgentScriptsPath", "agentScriptsPath")
                  }
                >
                  Browse
                </button>
              </div>

              <div className="input-group">
                <label htmlFor="textractor-64-path-input" title={TOOLTIPS.textractor64}>
                  Textractor 64-bit Path:
                </label>
                <input
                  id="textractor-64-path-input"
                  type="text"
                  title={TOOLTIPS.textractor64}
                  value={sharedSettings.textractorPath64}
                  onChange={(event) => {
                    setSharedSettings((current) => ({
                      ...current,
                      textractorPath64: event.target.value
                    }));
                  }}
                  onBlur={(event) =>
                    void saveSharedField("textractorPath64", event.target.value)
                  }
                />
                <button
                  type="button"
                  title={TOOLTIPS.textractor64}
                  onClick={() =>
                    void pickPath("settings.selectTextractorPath64", "textractorPath64")
                  }
                >
                  Browse
                </button>
                <button
                  type="button"
                  className="secondary"
                  title={TOOLTIPS.downloadTextractor}
                  disabled={downloadingTool !== null}
                  onClick={() => {
                    void handleDownloadTool("textractor");
                  }}
                >
                  {downloadingTool === "textractor" ? "Downloading..." : "Download"}
                </button>
              </div>

              <div className="input-group">
                <label htmlFor="textractor-32-path-input" title={TOOLTIPS.textractor32}>
                  Textractor 32-bit Path:
                </label>
                <input
                  id="textractor-32-path-input"
                  type="text"
                  title={TOOLTIPS.textractor32}
                  value={sharedSettings.textractorPath32}
                  onChange={(event) => {
                    setSharedSettings((current) => ({
                      ...current,
                      textractorPath32: event.target.value
                    }));
                  }}
                  onBlur={(event) =>
                    void saveSharedField("textractorPath32", event.target.value)
                  }
                />
                <button
                  type="button"
                  title={TOOLTIPS.textractor32}
                  onClick={() =>
                    void pickPath("settings.selectTextractorPath32", "textractorPath32")
                  }
                >
                  Browse
                </button>
              </div>

              <div className="input-group">
                <label htmlFor="luna-path-input" title={TOOLTIPS.lunaPath}>
                  LunaTranslator Path:
                </label>
                <input
                  id="luna-path-input"
                  type="text"
                  title={TOOLTIPS.lunaPath}
                  value={sharedSettings.lunaTranslatorPath}
                  onChange={(event) => {
                    setSharedSettings((current) => ({
                      ...current,
                      lunaTranslatorPath: event.target.value
                    }));
                  }}
                  onBlur={(event) =>
                    void saveSharedField("lunaTranslatorPath", event.target.value)
                  }
                />
                <button
                  type="button"
                  title={TOOLTIPS.lunaPath}
                  onClick={() =>
                    void pickPath("settings.selectLunaTranslatorPath", "lunaTranslatorPath")
                  }
                >
                  Browse
                </button>
                <button
                  type="button"
                  className="secondary"
                  title={TOOLTIPS.downloadLuna}
                  disabled={downloadingTool !== null}
                  onClick={() => {
                    void openToolReleasesPage("luna");
                  }}
                >
                  Download
                </button>
              </div>

              <p className="muted" title={TOOLTIPS.sharedToolSettings}>
                Downloads come from official upstream GitHub releases. Please review each
                project&apos;s license and terms before use.
              </p>

              <div className="input-group">
                <label htmlFor="launch-agent-minimized" title={TOOLTIPS.launchAgentMinimized}>
                  Launch Agent Minimized:
                </label>
                <input
                  id="launch-agent-minimized"
                  type="checkbox"
                  title={TOOLTIPS.launchAgentMinimized}
                  checked={sharedSettings.launchAgentMinimized}
                  onChange={(event) => {
                    void saveSharedToggle("launchAgentMinimized", event.target.checked);
                  }}
                />
              </div>

              {/* <div className="input-group">
                <label
                  htmlFor="launch-textractor-minimized"
                  title={TOOLTIPS.launchTextractorMinimized}
                >
                  Launch Textractor Minimized:
                </label>
                <input
                  id="launch-textractor-minimized"
                  type="checkbox"
                  title={TOOLTIPS.launchTextractorMinimized}
                  checked={sharedSettings.launchTextractorMinimized}
                  onChange={(event) => {
                    void saveSharedToggle("launchTextractorMinimized", event.target.checked);
                  }}
                />
              </div>

              <div className="input-group">
                <label
                  htmlFor="launch-luna-minimized"
                  title={TOOLTIPS.launchLunaTranslatorMinimized}
                >
                  Launch LunaTranslator Minimized:
                </label>
                <input
                  id="launch-luna-minimized"
                  type="checkbox"
                  title={TOOLTIPS.launchLunaTranslatorMinimized}
                  checked={sharedSettings.launchLunaTranslatorMinimized}
                  onChange={(event) => {
                    void saveSharedToggle("launchLunaTranslatorMinimized", event.target.checked);
                  }}
                />
              </div> */}
              </div>
            ) : null}
          </section>

          <section className="card legacy-card">
            <h2 title={TOOLTIPS.sceneAutomation}>Scene Automation</h2>
            <div className="form-group">
              <div className="input-group">
                <label title={TOOLTIPS.activeScene}>Active OBS Scene:</label>
                <span className="mono-text" title={TOOLTIPS.activeScene}>
                  {activeScene?.name ?? "Not Selected"}
                </span>
              </div>

              <div className="input-group">
                <label htmlFor="launcher-scene-selector" title={TOOLTIPS.configureScene}>
                  Configure Scene:
                </label>
                <select
                  id="launcher-scene-selector"
                  title={TOOLTIPS.configureScene}
                  value={configuredSceneId}
                  onChange={(event) => setConfiguredSceneId(event.target.value)}
                >
                  {obsScenes.length === 0 ? (
                    <option value="" title={TOOLTIPS.configureScene}>
                      No scenes found
                    </option>
                  ) : null}
                  {obsScenes.map((scene) => (
                    <option key={scene.id} value={scene.id} title={scene.name}>
                      {scene.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="secondary"
                  title={TOOLTIPS.refreshScenes}
                  onClick={() => {
                    void loadObsScenes();
                  }}
                >
                  Refresh
                </button>
              </div>

              {configuredScene && sceneProfile ? (
                <>
                  <div className="input-group">
                    <label title={TOOLTIPS.textHookMode}>Text Hook Launcher:</label>
                  </div>
                  <div className="launcher-mode-grid">
                    <label className="launcher-mode-item" title={TOOLTIPS.textHookNone}>
                      <input
                        type="radio"
                        name={`text-hook-${configuredScene.id}`}
                        title={TOOLTIPS.textHookNone}
                        checked={sceneProfile.textHookMode === "none"}
                        onChange={() => void patchSceneProfile({ textHookMode: "none" })}
                      />
                      None
                    </label>
                    <label className="launcher-mode-item" title={TOOLTIPS.textHookAgent}>
                      <input
                        type="radio"
                        name={`text-hook-${configuredScene.id}`}
                        title={TOOLTIPS.textHookAgent}
                        checked={sceneProfile.textHookMode === "agent"}
                        onChange={() => void patchSceneProfile({ textHookMode: "agent" })}
                      />
                      Agent
                    </label>
                    <label className="launcher-mode-item" title={TOOLTIPS.textHookTextractor}>
                      <input
                        type="radio"
                        name={`text-hook-${configuredScene.id}`}
                        title={TOOLTIPS.textHookTextractor}
                        checked={sceneProfile.textHookMode === "textractor"}
                        onChange={() =>
                          void patchSceneProfile({ textHookMode: "textractor" })
                        }
                      />
                      Textractor
                    </label>
                    <label className="launcher-mode-item" title={TOOLTIPS.textHookLuna}>
                      <input
                        type="radio"
                        name={`text-hook-${configuredScene.id}`}
                        title={TOOLTIPS.textHookLuna}
                        checked={sceneProfile.textHookMode === "luna"}
                        onChange={() => void patchSceneProfile({ textHookMode: "luna" })}
                      />
                      LunaTranslator
                    </label>
                  </div>

                  <div className="input-group">
                    <label
                      htmlFor={`scene-launch-delay-${configuredScene.id}`}
                      title={TOOLTIPS.launchDelay}
                    >
                      Tool Launch Delay (seconds):
                    </label>
                    <input
                      id={`scene-launch-delay-${configuredScene.id}`}
                      type="number"
                      min={0}
                      max={300}
                      step={0.1}
                      title={TOOLTIPS.launchDelay}
                      value={sceneProfile.launchDelaySeconds}
                      onChange={(event) => {
                        const next = Number.parseFloat(event.target.value);
                        setSceneProfile((current) =>
                          current
                            ? {
                                ...current,
                                launchDelaySeconds: Number.isFinite(next)
                                  ? normalizeLaunchDelaySeconds(next)
                                  : 0
                              }
                            : current
                        );
                      }}
                      onBlur={(event) => {
                        const next = Number.parseFloat(event.target.value);
                        void patchSceneProfile({
                          launchDelaySeconds: Number.isFinite(next)
                            ? normalizeLaunchDelaySeconds(next)
                            : 0
                        });
                      }}
                    />
                  </div>

                  {sceneProfile.textHookMode === "agent" ? (
                    <div className="form-group">
                      <div className="input-group">
                        <label
                          htmlFor={`scene-agent-script-${configuredScene.id}`}
                          title={TOOLTIPS.agentScript}
                        >
                          Agent Script:
                        </label>
                        <input
                          id={`scene-agent-script-${configuredScene.id}`}
                          type="text"
                          title={TOOLTIPS.agentScript}
                          value={sceneProfile.agentScriptPath}
                          onChange={(event) => {
                            const nextPath = event.target.value;
                            setSceneProfile((current) =>
                              current ? { ...current, agentScriptPath: nextPath } : current
                            );
                          }}
                          onBlur={(event) =>
                            void patchSceneProfile({
                              agentScriptPath: event.target.value
                            })
                          }
                        />
                        <button
                          type="button"
                          className="secondary"
                          title={TOOLTIPS.autoDetect}
                          onClick={() => {
                            void autoResolveSceneAgentScript();
                          }}
                        >
                          Auto-Detect
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          title={TOOLTIPS.searchScript}
                          onClick={() => {
                            void openScriptSearchDialog();
                          }}
                        >
                          Search
                        </button>
                        <button
                          type="button"
                          title={TOOLTIPS.browseScript}
                          onClick={() => {
                            void pickSceneAgentScript();
                          }}
                        >
                          Browse
                        </button>
                      </div>
                      <p className="muted" title={TOOLTIPS.autoDetect}>
                        Auto Detect suggests matches and auto-selects strong (85%+) matches.
                      </p>
                    </div>
                  ) : null}

                  <div className="input-group">
                    <label title={TOOLTIPS.ocrMode}>OCR Mode:</label>
                  </div>
                  <div className="launcher-mode-grid">
                    <label className="launcher-mode-item" title={TOOLTIPS.ocrNone}>
                      <input
                        type="radio"
                        name={`ocr-mode-${configuredScene.id}`}
                        title={TOOLTIPS.ocrNone}
                        checked={sceneProfile.ocrMode === "none"}
                        onChange={() => void patchSceneProfile({ ocrMode: "none" })}
                      />
                      None
                    </label>
                    <label className="launcher-mode-item" title={TOOLTIPS.ocrAuto}>
                      <input
                        type="radio"
                        name={`ocr-mode-${configuredScene.id}`}
                        title={TOOLTIPS.ocrAuto}
                        checked={sceneProfile.ocrMode === "auto"}
                        onChange={() => void patchSceneProfile({ ocrMode: "auto" })}
                      />
                      Auto OCR
                    </label>
                    <label className="launcher-mode-item" title={TOOLTIPS.ocrManual}>
                      <input
                        type="radio"
                        name={`ocr-mode-${configuredScene.id}`}
                        title={TOOLTIPS.ocrManual}
                        checked={sceneProfile.ocrMode === "manual"}
                        onChange={() => void patchSceneProfile({ ocrMode: "manual" })}
                      />
                      Manual OCR
                    </label>
                  </div>
                </>
              ) : (
                <p className="muted" title={TOOLTIPS.noScene}>
                  Select or switch to an OBS scene to configure automation.
                </p>
              )}
            </div>
          </section>

          <p className="muted launcher-status-text" title={TOOLTIPS.status}>
            {statusMessage}
          </p>
        </div>
      </div>

      {candidateDialog && configuredScene && candidateDialog.sceneId === configuredScene.id ? (
        <div className="launcher-config-modal" role="dialog" aria-modal="true">
          <div className="launcher-config-modal-header">
            <strong title={TOOLTIPS.candidatePicker}>
              {candidateDialog.mode === "search"
                ? `Search Agent Script (${filteredDialogCandidates.length}/${candidateDialog.candidates.length})`
                : `Select Agent Script (${candidateDialog.candidates.length})`}
            </strong>
            <button
              type="button"
              className="secondary"
              title="Close script selection dialog."
              onClick={() => setCandidateDialog(null)}
            >
              Close
            </button>
          </div>
          {candidateDialog.mode === "search" ? (
            <div className="launcher-script-search-row">
              <input
                type="text"
                className="launcher-script-search-input"
                value={candidateDialog.query}
                placeholder="Search scripts by name or path..."
                onChange={(event) => {
                  const nextQuery = event.target.value;
                  setCandidateDialog((current) =>
                    current ? { ...current, query: nextQuery } : current
                  );
                }}
              />
            </div>
          ) : null}
          <div className="launcher-script-picker">
            {filteredDialogCandidates.length === 0 ? (
              <p className="muted">No scripts match your search.</p>
            ) : null}
            {filteredDialogCandidates.map((candidate, index) => (
              <button
                key={`${candidate.path}-${index}`}
                type="button"
                className="launcher-script-option"
                title={`${formatCandidateReason(candidate.reason)} | ${candidate.path}`}
                onClick={() => {
                  void pickCandidateScript(candidate.path);
                }}
              >
                <span className="launcher-script-option-name">
                  {fileNameFromPath(candidate.path)}
                </span>
                <span className="launcher-script-option-meta">
                  {candidateDialog.mode === "search"
                    ? "Search Result"
                    : formatCandidateReason(candidate.reason)}
                  {formatCandidateConfidence(candidate.score)
                    ? ` | ${formatCandidateConfidence(candidate.score)}`
                    : ""}
                </span>
                <span className="launcher-script-option-path mono-text">{candidate.path}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
