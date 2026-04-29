import { useCallback, useEffect, useState } from "react";
import {
  getChromeStoreBoolean,
  setChromeStoreBoolean
} from "../../lib/chrome_store";
import { invokeIpc, onIpc } from "../../lib/ipc";
import { DOCS_URLS } from "../../../../shared/docs";
import type {
  GameSettings,
  ObsScene,
  SceneLaunchProfile,
  SceneOcrMode,
  SceneTextHookMode
} from "../../types/models";
import { useTranslation } from "../../i18n";

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

type DownloadableTool = "agent" | "textractor";
type ToolName = DownloadableTool | "luna";
type DownloadStage =
  | "preparing"
  | "fetch_release"
  | "download_archive"
  | "extract_archive"
  | "download_data"
  | "install_plugins"
  | "finalize";

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

interface DownloadProgressPayload {
  tool?: string;
  stage?: string;
  message?: string;
  progress?: number | null;
}

interface DownloadUiState {
  message: string;
  progress: number | null;
  stage: DownloadStage | "";
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
const TOOL_DOWNLOAD_PROGRESS_CHANNEL = "settings-tool-download-progress";

const TOOLTIPS = {
  overviewTooltip: "launcher.overviewTooltip",
  sharedToolSettings: "launcher.tooltips.sharedToolSettings",
  sceneAutomation: "launcher.tooltips.sceneAutomation",
  agentPath: "launcher.tooltips.agentPath",
  agentScriptsPath: "launcher.tooltips.agentScriptsPath",
  textractor64: "launcher.tooltips.textractor64",
  textractor32: "launcher.tooltips.textractor32",
  lunaPath: "launcher.tooltips.lunaPath",
  launchAgentMinimized: "launcher.tooltips.launchAgentMinimized",
  launchTextractorMinimized: "launcher.tooltips.launchTextractorMinimized",
  launchLunaTranslatorMinimized: "launcher.tooltips.launchLunaTranslatorMinimized",
  activeScene: "launcher.tooltips.activeScene",
  configureScene: "launcher.tooltips.configureScene",
  refreshScenes: "launcher.tooltips.refreshScenes",
  textHookMode: "launcher.tooltips.textHookMode",
  textHookNone: "launcher.tooltips.textHookNone",
  textHookAgent: "launcher.tooltips.textHookAgent",
  textHookTextractor: "launcher.tooltips.textHookTextractor",
  textHookLuna: "launcher.tooltips.textHookLuna",
  launchDelay: "launcher.tooltips.launchDelay",
  agentScript: "launcher.tooltips.agentScript",
  launchOverlay: "launcher.tooltips.launchOverlay",
  browseScript: "launcher.tooltips.browseScript",
  searchScript: "launcher.tooltips.searchScript",
  downloadAgent: "launcher.tooltips.downloadAgent",
  downloadTextractor: "launcher.tooltips.downloadTextractor",
  downloadLuna: "launcher.tooltips.downloadLuna",
  ocrMode: "launcher.tooltips.ocrMode",
  ocrNone: "launcher.tooltips.ocrNone",
  ocrAuto: "launcher.tooltips.ocrAuto",
  ocrManual: "launcher.tooltips.ocrManual",
  status: "launcher.tooltips.status",
  candidatePicker: "launcher.tooltips.candidatePicker",
  noScene: "launcher.tooltips.noScene"
} as const;

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
    launchOverlay: false,
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
    launchOverlay: Boolean(value?.launchOverlay),
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

function formatCandidateReasonKey(reason?: string): string {
  if (reason === "matched_explicit_id") {
    return "launcher.scriptPicker.explicitId";
  }
  if (reason === "matched_title_id") {
    return "launcher.scriptPicker.titleId";
  }
  if (reason === "matched_name") {
    return "launcher.scriptPicker.nameMatch";
  }
  if (reason === "matched_fuzzy_name") {
    return "launcher.scriptPicker.fuzzyMatch";
  }
  return "launcher.scriptPicker.possibleMatch";
}

function scoreToConfidence(score?: number): number | null {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return null;
  }
  return Math.max(0, Math.min(1, 1 - score));
}

function formatCandidateConfidencePercent(score?: number): string | null {
  const confidence = scoreToConfidence(score);
  if (confidence === null) {
    return null;
  }
  return String(Math.round(confidence * 100));
}

function normalizePathForCompare(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

function tokenizeForSimilarity(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function toScriptStem(filePath: string): string {
  const fileName = fileNameFromPath(filePath);
  return fileName.replace(/\.[^/.]+$/u, "");
}

function getHeuristicScriptScore(sceneName: string, scriptPath: string): number {
  const sceneTokens = Array.from(new Set(tokenizeForSimilarity(sceneName)));
  if (sceneTokens.length === 0) {
    return 1;
  }

  const scriptStem = toScriptStem(scriptPath);
  const scriptTokens = Array.from(new Set(tokenizeForSimilarity(scriptStem)));
  if (scriptTokens.length === 0) {
    return 1;
  }

  let exactMatches = 0;
  let partialMatches = 0;
  for (const sceneToken of sceneTokens) {
    if (scriptTokens.includes(sceneToken)) {
      exactMatches += 1;
      continue;
    }

    if (sceneToken.length < 3) {
      continue;
    }

    const hasPartial = scriptTokens.some(
      (scriptToken) =>
        scriptToken.includes(sceneToken) || sceneToken.includes(scriptToken)
    );
    if (hasPartial) {
      partialMatches += 1;
    }
  }

  const normalizedScene = sceneTokens.join("");
  const normalizedScript = scriptTokens.join("");
  const phraseBonus =
    normalizedScene.length >= 4 && normalizedScript.includes(normalizedScene) ? 0.5 : 0;
  const matchedUnits = exactMatches + partialMatches * 0.6 + phraseBonus;
  const coverage = Math.max(0, Math.min(1, matchedUnits / sceneTokens.length));
  return Math.max(0, Math.min(1, 1 - coverage));
}

function normalizeCandidateScore(score: unknown): number | null {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return null;
  }
  return Math.max(0, Math.min(1, score));
}

function isDownloadableTool(value: unknown): value is DownloadableTool {
  return value === "agent" || value === "textractor";
}

function normalizeProgress(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(1, value));
}

function toDownloadStage(value: unknown): DownloadStage | "" {
  if (
    value === "preparing" ||
    value === "fetch_release" ||
    value === "download_archive" ||
    value === "extract_archive" ||
    value === "download_data" ||
    value === "install_plugins" ||
    value === "finalize"
  ) {
    return value;
  }
  return "";
}

function formatDownloadSummary(
  toolLabel: string,
  message: string,
  progress: number | null
): string {
  const normalizedMessage = message.trim();
  const progressLabel =
    typeof progress === "number" ? `${Math.round(progress * 100)}%` : "";

  if (normalizedMessage && progressLabel) {
    return `${toolLabel}: ${normalizedMessage} (${progressLabel})`;
  }
  if (normalizedMessage) {
    return `${toolLabel}: ${normalizedMessage}`;
  }
  if (progressLabel) {
    return `${toolLabel}: ${progressLabel}`;
  }
  return `${toolLabel}: Downloading...`;
}

export function LauncherTab({ active }: LauncherTabProps) {
  const t = useTranslation();
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
    query: string;
  } | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [downloadingTool, setDownloadingTool] = useState<DownloadableTool | null>(null);
  const [downloadUiByTool, setDownloadUiByTool] = useState<
    Partial<Record<DownloadableTool, DownloadUiState>>
  >({});
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
        setStatusMessage(t("launcher.status.openedReleases", { label }));
        return;
      }
      setStatusMessage(t("launcher.status.failedOpenReleases"));
    } catch (error) {
      console.error("Failed to open releases page:", error);
      setStatusMessage(t("launcher.status.failedOpenReleases"));
    }
  }, [t]);

  const openDocumentation = useCallback(async () => {
    try {
      const response = await invokeIpc<{ success?: boolean; error?: string }>(
        "docs.openWindow",
        { url: DOCS_URLS.autolauncher }
      );
      if (response?.success) {
        return;
      }
      setStatusMessage(response?.error ?? t("launcher.status.failedOpenDocs"));
    } catch (error) {
      console.error("Failed to open documentation:", error);
      setStatusMessage(t("launcher.status.failedOpenDocs"));
    }
  }, [t]);

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

  useEffect(() => {
    const removeDownloadProgressListener = onIpc(
      TOOL_DOWNLOAD_PROGRESS_CHANNEL,
      (_event, payload) => {
        const progressPayload = payload as DownloadProgressPayload;
        if (!isDownloadableTool(progressPayload?.tool)) {
          return;
        }

        const tool = progressPayload.tool;
        const nextMessage =
          typeof progressPayload.message === "string" ? progressPayload.message : "";
        const nextProgress = normalizeProgress(progressPayload.progress);
        const nextStage = toDownloadStage(progressPayload.stage);

        setDownloadUiByTool((current) => ({
          ...current,
          [tool]: {
            message: nextMessage,
            progress: nextProgress,
            stage: nextStage
          }
        }));

        if (downloadingTool === tool) {
          const toolLabel = getToolLabel(tool);
          setStatusMessage(formatDownloadSummary(toolLabel, nextMessage, nextProgress));
        }
      }
    );

    return () => {
      removeDownloadProgressListener();
    };
  }, [downloadingTool, getToolLabel]);

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
      setStatusMessage(t("launcher.status.savedShared"));
    },
    [t]
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
      setStatusMessage(t("launcher.status.savedShared"));
    },
    [t]
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
      setStatusMessage(t("launcher.status.updatedPath"));
    },
    [t]
  );

  const patchSceneProfile = useCallback(
    async (
      patch: Partial<
        Pick<
          SceneLaunchProfile,
          "textHookMode" | "ocrMode" | "launchOverlay" | "agentScriptPath" | "launchDelaySeconds"
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
        launchOverlay: next.launchOverlay,
        agentScriptPath: next.agentScriptPath,
        launchDelaySeconds: next.launchDelaySeconds
      });
      setStatusMessage(t("launcher.status.savedScene", { scene: configuredScene.name }));
    },
    [configuredScene, sceneProfile, t]
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
    setStatusMessage(t("launcher.status.updatedScript", { scene: configuredScene.name }));
  }, [configuredScene, patchSceneProfile, sceneProfile, sharedSettings.agentScriptsPath, t]);

  const openSceneAgentScriptSearchDialog = useCallback(async () => {
    if (!configuredScene || !sceneProfile) {
      return;
    }

    const fallbackPath =
      sharedSettings.agentScriptsPath.trim() || sceneProfile.agentScriptPath.trim();
    const [resolvedResultSettled, listResultSettled] = await Promise.allSettled([
      invokeIpc<ResolveAgentScriptResponse>("settings.resolveAgentScriptForScene", {
        scene: configuredScene
      }),
      invokeIpc<ListAgentScriptsResponse>("settings.listAgentScripts", {
        path: fallbackPath
      })
    ]);

    let resolvedResult: ResolveAgentScriptResponse | null = null;
    if (resolvedResultSettled.status === "fulfilled") {
      resolvedResult = resolvedResultSettled.value;
    } else {
      console.warn("Failed to resolve ranked script suggestions:", resolvedResultSettled.reason);
    }

    if (listResultSettled.status !== "fulfilled") {
      console.error("Failed to list agent scripts:", listResultSettled.reason);
      setStatusMessage(t("launcher.status.failedListScripts", { scene: configuredScene.name }));
      return;
    }

    const listedScripts = Array.isArray(listResultSettled.value?.scripts)
      ? listResultSettled.value.scripts.filter(
          (scriptPath): scriptPath is string =>
            typeof scriptPath === "string" && scriptPath.trim().length > 0
        )
      : [];

    if (listedScripts.length === 0) {
      setStatusMessage(
        listResultSettled.value?.message ??
          t("launcher.status.noScriptsFound", { scene: configuredScene.name })
      );
      return;
    }

    const normalizedSceneName = configuredScene.name.trim();
    const candidateMap = new Map<string, AgentScriptCandidate>();
    const addCandidate = (
      candidatePath: string,
      reason?: string,
      score?: number
    ) => {
      const normalizedPath = candidatePath.trim();
      if (!normalizedPath) {
        return;
      }

      const compareKey = normalizePathForCompare(normalizedPath);
      const heuristicScore = getHeuristicScriptScore(normalizedSceneName, normalizedPath);
      const explicitScore = normalizeCandidateScore(score);
      const combinedScore =
        explicitScore !== null ? Math.min(explicitScore, heuristicScore) : heuristicScore;

      const existing = candidateMap.get(compareKey);
      if (!existing) {
        candidateMap.set(compareKey, {
          path: normalizedPath,
          reason,
          score: combinedScore
        });
        return;
      }

      const existingScore = normalizeCandidateScore(existing.score);
      if (existingScore === null || combinedScore < existingScore) {
        candidateMap.set(compareKey, {
          path: normalizedPath,
          reason: reason ?? existing.reason,
          score: combinedScore
        });
      }
    };

    const resolvedCandidates = Array.isArray(resolvedResult?.candidates)
      ? resolvedResult.candidates.filter(
          (candidate): candidate is AgentScriptCandidate =>
            Boolean(candidate && typeof candidate.path === "string" && candidate.path.trim())
        )
      : [];
    resolvedCandidates.forEach((candidate) =>
      addCandidate(candidate.path, candidate.reason, candidate.score)
    );

    if (
      resolvedResult?.status === "success" &&
      typeof resolvedResult.path === "string" &&
      resolvedResult.path.trim()
    ) {
      addCandidate(resolvedResult.path, resolvedResult.reason);
    }

    listedScripts.forEach((scriptPath) => addCandidate(scriptPath));

    const mergedCandidates = Array.from(candidateMap.values()).sort((left, right) => {
      const leftScore = normalizeCandidateScore(left.score) ?? 1;
      const rightScore = normalizeCandidateScore(right.score) ?? 1;
      if (leftScore !== rightScore) {
        return leftScore - rightScore;
      }

      const leftName = fileNameFromPath(left.path).toLowerCase();
      const rightName = fileNameFromPath(right.path).toLowerCase();
      if (leftName !== rightName) {
        return leftName.localeCompare(rightName);
      }

      return left.path.localeCompare(right.path);
    });

    setCandidateDialog({
      sceneId: configuredScene.id,
      query: sceneProfile.agentScriptPath.trim(),
      candidates: mergedCandidates
    });
  }, [configuredScene, sceneProfile, sharedSettings.agentScriptsPath, t]);

  const pickCandidateScript = useCallback(
    async (candidatePath: string) => {
      if (!configuredScene || !candidatePath.trim()) {
        return;
      }
      await patchSceneProfile({ agentScriptPath: candidatePath });
      setCandidateDialog(null);
      setStatusMessage(t("launcher.status.selectedScript", { scene: configuredScene.name }));
    },
    [configuredScene, patchSceneProfile, t]
  );

  const handleDownloadTool = useCallback(
    async (tool: DownloadableTool) => {
      if (downloadingTool) {
        return;
      }

      const toolLabel = getToolLabel(tool);
      setDownloadingTool(tool);
      setDownloadUiByTool((current) => ({
        ...current,
        [tool]: {
          message: `Preparing ${toolLabel} download...`,
          progress: null,
          stage: "preparing"
        }
      }));
      setStatusMessage(t("launcher.status.downloadPreparing", { tool: toolLabel }));

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
          const installMessage =
            typeof result.message === "string" && result.message.trim()
              ? ` ${result.message.trim()}`
              : "";
          setDownloadUiByTool((current) => ({
            ...current,
            [tool]: {
              message: `Installed ${toolLabel}${versionLabel}.`,
              progress: 1,
              stage: "finalize"
            }
          }));
          setStatusMessage(`Installed ${toolLabel}${versionLabel}.${installMessage}`.trim());
          return;
        }

        if (result?.status === "asset_not_found") {
          setDownloadUiByTool((current) => ({
            ...current,
            [tool]: {
              message:
                result.message ??
                `No matching ${toolLabel} download was found in the latest release.`,
              progress: null,
              stage: "finalize"
            }
          }));
          setStatusMessage(
            result.message ??
              `No matching ${toolLabel} download was found in the latest release. Opened releases page.`
          );
          return;
        }

        if (result?.status === "canceled") {
          setDownloadUiByTool((current) => ({
            ...current,
            [tool]: {
              message: `Download canceled for ${toolLabel}.`,
              progress: null,
              stage: "finalize"
            }
          }));
          setStatusMessage(`Download canceled for ${toolLabel}.`);
          return;
        }

        setDownloadUiByTool((current) => ({
          ...current,
          [tool]: {
            message: result?.message ?? `Failed to install ${toolLabel}.`,
            progress: null,
            stage: "finalize"
          }
        }));
        setStatusMessage(result?.message ?? `Failed to install ${toolLabel}.`);
      } catch (error) {
        console.error(`Failed to download/install ${toolLabel}:`, error);
        setDownloadUiByTool((current) => ({
          ...current,
          [tool]: {
            message: `Failed to install ${toolLabel}.`,
            progress: null,
            stage: "finalize"
          }
        }));
        setStatusMessage(`Failed to install ${toolLabel}.`);
      } finally {
        setDownloadingTool(null);
      }
    },
    [downloadingTool, getToolLabel, t]
  );

  const getDownloadButtonLabel = useCallback(
    (tool: DownloadableTool): string => {
      if (downloadingTool !== tool) {
        return t("launcher.shared.download");
      }
      const progress = downloadUiByTool[tool]?.progress ?? null;
      if (typeof progress === "number") {
        return t("launcher.shared.downloadingPercent", { percent: String(Math.round(progress * 100)) });
      }
      return t("launcher.shared.downloading");
    },
    [downloadingTool, downloadUiByTool, t]
  );

  const getDownloadButtonStyle = useCallback(
    (tool: DownloadableTool): Record<string, string> | undefined => {
      if (downloadingTool !== tool) {
        return undefined;
      }
      const progress = downloadUiByTool[tool]?.progress ?? null;
      if (typeof progress !== "number") {
        return undefined;
      }
      const progressPercent = Math.round(progress * 100);
      return {
        backgroundImage: `linear-gradient(90deg, #2f8f49 ${progressPercent}%, #4a4a4a ${progressPercent}%)`
      };
    },
    [downloadingTool, downloadUiByTool]
  );

  const activeDownloadSummary =
    downloadingTool && downloadUiByTool[downloadingTool]
      ? formatDownloadSummary(
          getToolLabel(downloadingTool),
          downloadUiByTool[downloadingTool]?.message ?? "",
          downloadUiByTool[downloadingTool]?.progress ?? null
        )
      : "";

  const filteredDialogCandidates = candidateDialog
    ? candidateDialog.candidates.filter((candidate) => {
        const query = candidateDialog.query.trim().toLowerCase();
        if (!query) {
          return true;
        }
        const normalizedPath = candidate.path.toLowerCase();
        const normalizedName = fileNameFromPath(candidate.path).toLowerCase();
        return normalizedPath.includes(query) || normalizedName.includes(query);
      })
    : [];

  return (
    <div className={`tab-panel ${active ? "active" : ""}`}>
      <div className="modern-tab">
        <div className="launcher-tab-header">
          <h1 title={t(TOOLTIPS.overviewTooltip)}>{t("launcher.title")}</h1>
          <div className="launcher-header-actions">
            <button
              type="button"
              className="secondary launcher-docs-button"
              title={t("launcher.docsButtonTooltip")}
              onClick={() => {
                void openDocumentation();
              }}
            >
              {t("launcher.docsButton")}
            </button>
            <button
              type="button"
              className="launcher-info-icon"
              title={t(TOOLTIPS.overviewTooltip)}
              aria-label={t("launcher.infoLabel")}
            >
              i
            </button>
          </div>
        </div>
        <div className="launcher-stack">
          <section className="card legacy-card">
            <div className="launcher-card-header">
              <h2 className="launcher-card-title" title={t(TOOLTIPS.sharedToolSettings)}>
                {t("launcher.shared.title")}
              </h2>
              <button
                type="button"
                className="launcher-card-toggle"
                title={
                  isSharedToolSettingsExpanded
                    ? t("launcher.shared.collapse")
                    : t("launcher.shared.expand")
                }
                aria-label={
                  isSharedToolSettingsExpanded
                    ? t("launcher.shared.collapse")
                    : t("launcher.shared.expand")
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
                <label htmlFor="agent-path-input" title={t(TOOLTIPS.agentPath)}>
                  {t("launcher.shared.agentPath")}
                </label>
                <input
                  id="agent-path-input"
                  type="text"
                  title={t(TOOLTIPS.agentPath)}
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
                  title={t(TOOLTIPS.agentPath)}
                  onClick={() => void pickPath("settings.selectAgentPath", "agentPath")}
                >
                  {t("launcher.shared.browse")}
                </button>
                <button
                  type="button"
                  className="secondary launcher-download-button"
                  title={t(TOOLTIPS.downloadAgent)}
                  disabled={downloadingTool !== null}
                  style={getDownloadButtonStyle("agent")}
                  onClick={() => {
                    void handleDownloadTool("agent");
                  }}
                >
                  {getDownloadButtonLabel("agent")}
                </button>
              </div>

              <div className="input-group">
                <label htmlFor="agent-scripts-path-input" title={t(TOOLTIPS.agentScriptsPath)}>
                  {t("launcher.shared.agentScriptsPath")}
                </label>
                <input
                  id="agent-scripts-path-input"
                  type="text"
                  title={t(TOOLTIPS.agentScriptsPath)}
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
                  title={t(TOOLTIPS.agentScriptsPath)}
                  onClick={() =>
                    void pickPath("settings.selectAgentScriptsPath", "agentScriptsPath")
                  }
                >
                  {t("launcher.shared.browse")}
                </button>
              </div>

              <div className="input-group">
                <label htmlFor="textractor-64-path-input" title={t(TOOLTIPS.textractor64)}>
                  {t("launcher.shared.textractor64")}
                </label>
                <input
                  id="textractor-64-path-input"
                  type="text"
                  title={t(TOOLTIPS.textractor64)}
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
                  title={t(TOOLTIPS.textractor64)}
                  onClick={() =>
                    void pickPath("settings.selectTextractorPath64", "textractorPath64")
                  }
                >
                  {t("launcher.shared.browse")}
                </button>
                <button
                  type="button"
                  className="secondary launcher-download-button"
                  title={t(TOOLTIPS.downloadTextractor)}
                  disabled={downloadingTool !== null}
                  style={getDownloadButtonStyle("textractor")}
                  onClick={() => {
                    void handleDownloadTool("textractor");
                  }}
                >
                  {getDownloadButtonLabel("textractor")}
                </button>
              </div>

              <div className="input-group">
                <label htmlFor="textractor-32-path-input" title={t(TOOLTIPS.textractor32)}>
                  {t("launcher.shared.textractor32")}
                </label>
                <input
                  id="textractor-32-path-input"
                  type="text"
                  title={t(TOOLTIPS.textractor32)}
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
                  title={t(TOOLTIPS.textractor32)}
                  onClick={() =>
                    void pickPath("settings.selectTextractorPath32", "textractorPath32")
                  }
                >
                  {t("launcher.shared.browse")}
                </button>
              </div>

              <div className="input-group">
                <label htmlFor="luna-path-input" title={t(TOOLTIPS.lunaPath)}>
                  {t("launcher.shared.lunaPath")}
                </label>
                <input
                  id="luna-path-input"
                  type="text"
                  title={t(TOOLTIPS.lunaPath)}
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
                  title={t(TOOLTIPS.lunaPath)}
                  onClick={() =>
                    void pickPath("settings.selectLunaTranslatorPath", "lunaTranslatorPath")
                  }
                >
                  {t("launcher.shared.browse")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  title={t(TOOLTIPS.downloadLuna)}
                  disabled={downloadingTool !== null}
                  onClick={() => {
                    void openToolReleasesPage("luna");
                  }}
                >
                  {t("launcher.shared.download")}
                </button>
              </div>

              <p className="muted" title={t(TOOLTIPS.sharedToolSettings)}>
                {t("launcher.shared.disclaimer")}
              </p>
              {activeDownloadSummary ? (
                <p className="muted launcher-download-status" aria-live="polite">
                  {activeDownloadSummary}
                </p>
              ) : null}

              <div className="input-group">
                <label htmlFor="launch-agent-minimized" title={t(TOOLTIPS.launchAgentMinimized)}>
                  {t("launcher.shared.launchAgentMinimized")}
                </label>
                <input
                  id="launch-agent-minimized"
                  type="checkbox"
                  title={t(TOOLTIPS.launchAgentMinimized)}
                  checked={sharedSettings.launchAgentMinimized}
                  onChange={(event) => {
                    void saveSharedToggle("launchAgentMinimized", event.target.checked);
                  }}
                />
              </div>

              {/* <div className="input-group">
                <label
                  htmlFor="launch-textractor-minimized"
                  title={t(TOOLTIPS.launchTextractorMinimized)}
                >
                  Launch Textractor Minimized:
                </label>
                <input
                  id="launch-textractor-minimized"
                  type="checkbox"
                  title={t(TOOLTIPS.launchTextractorMinimized)}
                  checked={sharedSettings.launchTextractorMinimized}
                  onChange={(event) => {
                    void saveSharedToggle("launchTextractorMinimized", event.target.checked);
                  }}
                />
              </div>

              <div className="input-group">
                <label
                  htmlFor="launch-luna-minimized"
                  title={t(TOOLTIPS.launchLunaTranslatorMinimized)}
                >
                  Launch LunaTranslator Minimized:
                </label>
                <input
                  id="launch-luna-minimized"
                  type="checkbox"
                  title={t(TOOLTIPS.launchLunaTranslatorMinimized)}
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
            <h2 title={t(TOOLTIPS.sceneAutomation)}>{t("launcher.scene.title")}</h2>
            <div className="form-group">
              <div className="input-group">
                <label title={t(TOOLTIPS.activeScene)}>{t("launcher.scene.activeScene")}</label>
                <span className="mono-text" title={t(TOOLTIPS.activeScene)}>
                  {activeScene?.name ?? t("launcher.scene.notSelected")}
                </span>
              </div>

              <div className="input-group">
                <label htmlFor="launcher-scene-selector" title={t(TOOLTIPS.configureScene)}>
                  {t("launcher.scene.configureScene")}
                </label>
                <select
                  id="launcher-scene-selector"
                  title={t(TOOLTIPS.configureScene)}
                  value={configuredSceneId}
                  onChange={(event) => setConfiguredSceneId(event.target.value)}
                >
                  {obsScenes.length === 0 ? (
                    <option value="" title={t(TOOLTIPS.configureScene)}>
                      {t("launcher.scene.noScenesFound")}
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
                  title={t(TOOLTIPS.refreshScenes)}
                  onClick={() => {
                    void loadObsScenes();
                  }}
                >
                  {t("launcher.scene.refresh")}
                </button>
              </div>

              {configuredScene && sceneProfile ? (
                <>
                  <div className="input-group">
                    <label title={t(TOOLTIPS.textHookMode)}>{t("launcher.scene.textHookLauncher")}</label>
                  </div>
                  <div className="launcher-mode-grid">
                    <label className="launcher-mode-item" title={t(TOOLTIPS.textHookNone)}>
                      <input
                        type="radio"
                        name={`text-hook-${configuredScene.id}`}
                        title={t(TOOLTIPS.textHookNone)}
                        checked={sceneProfile.textHookMode === "none"}
                        onChange={() => void patchSceneProfile({ textHookMode: "none" })}
                      />
                      {t("launcher.scene.modeNone")}
                    </label>
                    <label className="launcher-mode-item" title={t(TOOLTIPS.textHookAgent)}>
                      <input
                        type="radio"
                        name={`text-hook-${configuredScene.id}`}
                        title={t(TOOLTIPS.textHookAgent)}
                        checked={sceneProfile.textHookMode === "agent"}
                        onChange={() => void patchSceneProfile({ textHookMode: "agent" })}
                      />
                      {t("launcher.scene.modeAgent")}
                    </label>
                    <label className="launcher-mode-item" title={t(TOOLTIPS.textHookTextractor)}>
                      <input
                        type="radio"
                        name={`text-hook-${configuredScene.id}`}
                        title={t(TOOLTIPS.textHookTextractor)}
                        checked={sceneProfile.textHookMode === "textractor"}
                        onChange={() =>
                          void patchSceneProfile({ textHookMode: "textractor" })
                        }
                      />
                      {t("launcher.scene.modeTextractor")}
                    </label>
                    <label className="launcher-mode-item" title={t(TOOLTIPS.textHookLuna)}>
                      <input
                        type="radio"
                        name={`text-hook-${configuredScene.id}`}
                        title={t(TOOLTIPS.textHookLuna)}
                        checked={sceneProfile.textHookMode === "luna"}
                        onChange={() => void patchSceneProfile({ textHookMode: "luna" })}
                      />
                      {t("launcher.scene.modeLuna")}
                    </label>
                  </div>

                  <div className="input-group">
                    <label
                      htmlFor={`scene-launch-delay-${configuredScene.id}`}
                      title={t(TOOLTIPS.launchDelay)}
                    >
                      {t("launcher.scene.launchDelay")}
                    </label>
                    <input
                      id={`scene-launch-delay-${configuredScene.id}`}
                      type="number"
                      min={0}
                      max={300}
                      step={0.1}
                      title={t(TOOLTIPS.launchDelay)}
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
                          title={t(TOOLTIPS.agentScript)}
                        >
                          {t("launcher.scene.agentScript")}
                        </label>
                        <input
                          id={`scene-agent-script-${configuredScene.id}`}
                          type="text"
                          title={t(TOOLTIPS.agentScript)}
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
                          title={t(TOOLTIPS.searchScript)}
                          onClick={() => {
                            void openSceneAgentScriptSearchDialog();
                          }}
                        >
                          {t("launcher.scene.search")}
                        </button>
                        <button
                          type="button"
                          title={t(TOOLTIPS.browseScript)}
                          onClick={() => {
                            void pickSceneAgentScript();
                          }}
                        >
                          {t("launcher.shared.browse")}
                        </button>
                      </div>
                      <p className="muted" title={t(TOOLTIPS.searchScript)}>
                        {t("launcher.scene.searchHint")}
                      </p>
                    </div>
                  ) : null}

                  <div className="input-group">
                    <label title={t(TOOLTIPS.ocrMode)}>{t("launcher.scene.ocrMode")}</label>
                  </div>
                  <div className="launcher-mode-grid">
                    <label className="launcher-mode-item" title={t(TOOLTIPS.ocrNone)}>
                      <input
                        type="radio"
                        name={`ocr-mode-${configuredScene.id}`}
                        title={t(TOOLTIPS.ocrNone)}
                        checked={sceneProfile.ocrMode === "none"}
                        onChange={() => void patchSceneProfile({ ocrMode: "none" })}
                      />
                      {t("launcher.scene.ocrNone")}
                    </label>
                    <label className="launcher-mode-item" title={t(TOOLTIPS.ocrAuto)}>
                      <input
                        type="radio"
                        name={`ocr-mode-${configuredScene.id}`}
                        title={t(TOOLTIPS.ocrAuto)}
                        checked={sceneProfile.ocrMode === "auto"}
                        onChange={() => void patchSceneProfile({ ocrMode: "auto" })}
                      />
                      {t("launcher.scene.ocrAuto")}
                    </label>
                    <label className="launcher-mode-item" title={t(TOOLTIPS.ocrManual)}>
                      <input
                        type="radio"
                        name={`ocr-mode-${configuredScene.id}`}
                        title={t(TOOLTIPS.ocrManual)}
                        checked={sceneProfile.ocrMode === "manual"}
                        onChange={() => void patchSceneProfile({ ocrMode: "manual" })}
                      />
                      {t("launcher.scene.ocrManual")}
                    </label>
                  </div>

                  <div className="input-group">
                    <label
                      htmlFor={`scene-launch-overlay-${configuredScene.id}`}
                      title={t(TOOLTIPS.launchOverlay)}
                    >
                      {t("launcher.scene.launchOverlay")}
                    </label>
                    <input
                      id={`scene-launch-overlay-${configuredScene.id}`}
                      type="checkbox"
                      title={t(TOOLTIPS.launchOverlay)}
                      checked={sceneProfile.launchOverlay}
                      onChange={(event) =>
                        void patchSceneProfile({ launchOverlay: event.target.checked })
                      }
                    />
                  </div>
                </>
              ) : (
                <p className="muted" title={t(TOOLTIPS.noScene)}>
                  {t("launcher.scene.noSceneHint")}
                </p>
              )}
            </div>
          </section>

          <p className="muted launcher-status-text" title={t(TOOLTIPS.status)}>
            {statusMessage}
          </p>
        </div>
      </div>

      {candidateDialog && configuredScene && candidateDialog.sceneId === configuredScene.id ? (
        <div className="launcher-config-modal" role="dialog" aria-modal="true">
          <div className="launcher-config-modal-header">
            <strong title={t(TOOLTIPS.candidatePicker)}>
              {t("launcher.scriptPicker.title", { filtered: String(filteredDialogCandidates.length), total: String(candidateDialog.candidates.length) })}
            </strong>
            <button
              type="button"
              className="secondary"
              title={t("launcher.scriptPicker.closeTooltip")}
              onClick={() => setCandidateDialog(null)}
            >
              {t("launcher.scriptPicker.close")}
            </button>
          </div>
          <div className="launcher-script-search-row">
            <input
              type="text"
              className="launcher-script-search-input"
              value={candidateDialog.query}
              placeholder={t("launcher.scriptPicker.searchPlaceholder")}
              onChange={(event) => {
                const nextQuery = event.target.value;
                setCandidateDialog((current) =>
                  current ? { ...current, query: nextQuery } : current
                );
              }}
            />
          </div>
          <div className="launcher-script-picker">
            {filteredDialogCandidates.length === 0 ? (
              <p className="muted">{t("launcher.scriptPicker.noResults")}</p>
            ) : null}
            {filteredDialogCandidates.map((candidate, index) => (
              <button
                key={`${candidate.path}-${index}`}
                type="button"
                className="launcher-script-option"
                title={`${t(formatCandidateReasonKey(candidate.reason))} | ${candidate.path}`}
                onClick={() => {
                  void pickCandidateScript(candidate.path);
                }}
              >
                <span className="launcher-script-option-name">
                  {fileNameFromPath(candidate.path)}
                </span>
                <span className="launcher-script-option-meta">
                  {t(formatCandidateReasonKey(candidate.reason))}
                  {formatCandidateConfidencePercent(candidate.score)
                    ? ` | ${t("launcher.scriptPicker.matchPercent", { percent: formatCandidateConfidencePercent(candidate.score)! })}`
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
