import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invokeIpc, onIpc, sendIpc } from "../lib/ipc";
import { useTranslation } from "../i18n";
import type { ObsCaptureMode, ObsScene, SceneLaunchProfile, SceneOcrMode } from "../types/models";
import { AgentScriptDisplay } from "./AgentScriptDisplay";
import { AgentScriptSearchDialog } from "./AgentScriptSearchDialog";
import {
  buildAgentScriptCandidateList,
  getHighConfidenceAgentScriptCandidate,
  normalizeAgentScriptPathForCompare,
  type AgentScriptCandidate,
} from "../../../shared/agent_scripts";

type TextHookEngine = "luna" | "textractor" | "agent";
type WizardStep = "preview" | "hook" | "ocr" | "finish";
type WizardTextSource = "none" | TextHookEngine | "ocr";
type OcrInitialScanState =
  | "idle"
  | "selecting"
  | "starting"
  | "scanning"
  | "noText"
  | "complete"
  | "error";
type NavigateTab = "ocr" | "texthook" | "launcher" | "settings";

interface TextCaptureWizardProps {
  initialScene?: ObsScene | null;
  onClose: () => void;
  onNavigateTab?: (tab: NavigateTab) => void;
}

interface ActiveCapture {
  sceneName: string;
  sceneId: string;
  exeName: string | null;
  windowTitle?: string | null;
  error?: string;
}

interface ObsScenePreviewSnapshot {
  sceneName: string;
  sceneId: string;
  sourceName: string | null;
  captureMode: ObsCaptureMode | null;
  imageData: string | null;
}

interface ResolveAgentScriptResponse {
  status?: string;
  path?: string;
  reason?: string;
  isSwitchTarget?: boolean;
  titleId?: string | null;
  candidates?: AgentScriptCandidate[];
  processName?: string | null;
  windowTitle?: string | null;
}

interface ListAgentScriptsResponse {
  status?: string;
  path?: string;
  scripts?: string[];
  message?: string;
}

interface AgentScriptSearchDialogState {
  candidates: AgentScriptCandidate[];
  query: string;
}

interface HookEntry {
  id: string;
  function: string;
  preview: string;
  samples: string[];
}

interface RuntimeStatusRunning {
  running: true;
  engine: TextHookEngine;
  arch: "x86" | "x64";
  pid: number;
  exeName: string;
  selectedHookId: string | null;
  hookCount: number;
  flushDelayMs?: number;
  agentScriptPath?: string;
}

interface RuntimeStatusStopped {
  running: false;
}

type RuntimeStatus = RuntimeStatusRunning | RuntimeStatusStopped;

interface SavedHookProfile {
  engine: TextHookEngine;
  autoHook: boolean;
  flushDelayMs?: number;
  copyToClipboard?: boolean;
  hookId?: string | null;
  hookFunction?: string | null;
  manualHookCode?: string | null;
  agentScriptPath?: string | null;
  agentDetached?: boolean;
}

const CAPTURE_WIZARD_STEPS: Array<{ id: WizardStep; labelKey: string }> = [
  { id: "preview", labelKey: "captureWizard.steps.preview" },
  { id: "hook", labelKey: "captureWizard.steps.hook" },
  { id: "ocr", labelKey: "captureWizard.steps.ocr" },
  { id: "finish", labelKey: "captureWizard.steps.finish" }
];

const OCR_AUTOMATION_OPTIONS: Array<{
  value: SceneOcrMode;
  labelKey: string;
  descriptionKey: string;
}> = [
  {
    value: "none",
    labelKey: "captureWizard.ocr.automationOff",
    descriptionKey: "captureWizard.ocr.automationOffDescription"
  },
  {
    value: "auto",
    labelKey: "captureWizard.ocr.automationAuto",
    descriptionKey: "captureWizard.ocr.automationAutoDescription"
  },
  {
    value: "manual",
    labelKey: "captureWizard.ocr.automationManual",
    descriptionKey: "captureWizard.ocr.automationManualDescription"
  }
];

const DEFAULT_FLUSH_DELAY_MS = 100;
const NEW_PROFILE_VALUE = "__new__";

interface GsmProfileList {
  profiles?: string[];
  currentProfile?: string;
}

interface OcrRunningState {
  isRunning?: boolean;
}

interface OcrIpcMessage {
  event?: string;
  data?: {
    text?: unknown;
    sentence?: unknown;
  };
}

function hasHookText(hook: HookEntry): boolean {
  if (hook.preview.trim().length > 0) return true;
  return hook.samples.some((sample) => sample.trim().length > 0);
}

function normalizeCaptureMode(value: unknown): ObsCaptureMode | null {
  return value === "window_capture" || value === "game_capture" ? value : null;
}

export function TextCaptureWizard({
  initialScene,
  onClose,
}: TextCaptureWizardProps) {
  const t = useTranslation();
  const [step, setStep] = useState<WizardStep>("preview");
  const [scene, setScene] = useState<ObsScene | null>(initialScene ?? null);
  const [capture, setCapture] = useState<ActiveCapture | null>(null);
  const [preview, setPreview] = useState<ObsScenePreviewSnapshot | null>(null);
  const [previewCaptureMode, setPreviewCaptureMode] = useState<ObsCaptureMode | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentCandidates, setAgentCandidates] = useState<AgentScriptCandidate[]>([]);
  const [agentSamples, setAgentSamples] = useState<string[]>([]);
  const [isSwitchTarget, setIsSwitchTarget] = useState<boolean | undefined>();
  const [selectedAgentScript, setSelectedAgentScript] = useState("");
  const [agentSearchDialog, setAgentSearchDialog] = useState<AgentScriptSearchDialogState | null>(null);
  const [hookEngine, setHookEngine] = useState<Exclude<TextHookEngine, "agent">>("luna");
  const [hookStatus, setHookStatus] = useState<RuntimeStatus>({ running: false });
  const [hooks, setHooks] = useState<HookEntry[]>([]);
  const [selectedHookId, setSelectedHookId] = useState<string | null>(null);
  const [textSource, setTextSource] = useState<WizardTextSource>("none");
  const [textSourceChanged, setTextSourceChanged] = useState(false);
  const [saveAutomation, setSaveAutomation] = useState(true);
  const [launchTextHook, setLaunchTextHook] = useState(true);
  const [ocrMode, setOcrMode] = useState<SceneOcrMode>("none");
  const [ocrSamples, setOcrSamples] = useState<string[]>([]);
  const [ocrInitialScanState, setOcrInitialScanState] = useState<OcrInitialScanState>("idle");
  const [launchOverlay, setLaunchOverlay] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [gsmProfiles, setGsmProfiles] = useState<string[]>([]);
  const [currentGsmProfile, setCurrentGsmProfile] = useState("");
  const [selectedProfile, setSelectedProfile] = useState("");
  const [newProfileName, setNewProfileName] = useState("");
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [assigningProfile, setAssigningProfile] = useState(false);
  const [hookBusy, setHookBusy] = useState(false);
  const [contextLoading, setContextLoading] = useState(true);
  const [contextFailed, setContextFailed] = useState(false);
  const [savedHookProfile, setSavedHookProfile] = useState<SavedHookProfile | null>(null);
  const [savedSceneProfile, setSavedSceneProfile] = useState<SceneLaunchProfile | null>(null);
  const [acceptedHook, setAcceptedHook] = useState<{ id: string | null; function: string | null } | null>(null);
  const loadedSceneRef = useRef<string | null>(null);
  const previewInFlightRef = useRef(false);
  const ocrSelectorRequestedRef = useRef(false);
  const pendingInitialOcrStartRef = useRef(false);
  const awaitingInitialOcrResultRef = useRef(false);
  const initialOcrTimeoutRef = useRef<number | null>(null);

  const activeScene = useMemo(() => {
    if (scene) return scene;
    if (capture?.sceneId && capture.sceneName) {
      return { id: capture.sceneId, name: capture.sceneName };
    }
    return null;
  }, [capture, scene]);

  const exeName = capture?.exeName ?? null;
  const selectedHook = hooks.find((hook) => hook.id === selectedHookId) ?? null;
  const stepIndex = CAPTURE_WIZARD_STEPS.findIndex((entry) => entry.id === step);
  const isFirstStep = stepIndex <= 0;
  const hasTextHook = textSource === "agent" || textSource === "luna" || textSource === "textractor";
  const preserveLegacyHook = !textSourceChanged && !savedHookProfile && !!savedSceneProfile && savedSceneProfile.textHookMode !== "none";
  const runtimeMatchesCapture = hookStatus.running && !!exeName &&
    hookStatus.exeName.toLowerCase() === exeName.toLowerCase();
  const recommendedAgent = useMemo(
    () => getHighConfidenceAgentScriptCandidate(agentCandidates, { isSwitchTarget }),
    [agentCandidates, isSwitchTarget]
  );
  const displayedAgentScript = selectedAgentScript || recommendedAgent?.path || "";

  const visibleHooks = useMemo(
    () => runtimeMatchesCapture ? hooks.filter(hasHookText) : [],
    [hooks, runtimeMatchesCapture]
  );

  const sourceLabel = useMemo(() => {
    const source = preserveLegacyHook ? savedSceneProfile?.textHookMode : textSource;
    if (source === "agent") return t("captureWizard.profile.sourceAgent");
    if (source === "luna") return t("captureWizard.profile.sourceLuna");
    if (source === "textractor") return t("captureWizard.profile.sourceTextractor");
    if (source === "ocr") return t("captureWizard.profile.sourceOcr");
    return t("captureWizard.profile.sourceNone");
  }, [preserveLegacyHook, savedSceneProfile?.textHookMode, textSource, t]);

  const refreshContext = useCallback(async () => {
    setContextLoading(true);
    try {
      const [activeSceneResult, activeCapture] = await Promise.all([
        invokeIpc<ObsScene | null>("obs.getActiveScene"),
        invokeIpc<ActiveCapture | null>("texthook.getActiveCapture")
      ]);
      const targetScene = activeSceneResult ?? (loadedSceneRef.current === null ? initialScene : null);
      setScene(targetScene ?? null);
      setCapture(activeCapture);
      const targetKey = `${targetScene?.id ?? ""}:${activeCapture?.exeName ?? ""}`;
      if (loadedSceneRef.current !== targetKey) {
        loadedSceneRef.current = targetKey;
        setTextSource("none");
        setTextSourceChanged(false);
        setSelectedAgentScript("");
        setAgentCandidates([]);
        setAgentSamples([]);
        setIsSwitchTarget(undefined);
        setAgentSearchDialog(null);
        setAcceptedHook(null);
        setHooks([]);
        setSelectedHookId(null);
        setHookStatus({ running: false });
        setHookEngine("luna");
        setOcrMode("none");
        setOcrSamples([]);
        setOcrInitialScanState("idle");
        ocrSelectorRequestedRef.current = false;
        pendingInitialOcrStartRef.current = false;
        awaitingInitialOcrResultRef.current = false;
        if (initialOcrTimeoutRef.current !== null) window.clearTimeout(initialOcrTimeoutRef.current);
        setLaunchOverlay(false);
        setLaunchTextHook(true);
        setSaveAutomation(true);
        setSavedSceneProfile(null);
        setSavedHookProfile(null);
        setStatusMessage(null);
        setPreview(null);
        setPreviewCaptureMode(null);
        if (!targetScene?.id) return;
        const [automationResult, hookResult] = await Promise.allSettled([
          invokeIpc<SceneLaunchProfile | null>("settings.getSceneLaunchProfile", targetScene),
          activeCapture?.exeName
            ? invokeIpc<SavedHookProfile | null>("texthook.getProfile", {
                exeName: activeCapture.exeName, sceneId: targetScene.id
              })
            : Promise.resolve(null)
        ]);
        if (automationResult.status === "rejected" || hookResult.status === "rejected") {
          throw new Error("Failed to load saved capture settings");
        }
        const automation = automationResult.status === "fulfilled" ? automationResult.value : null;
        const profile = hookResult.status === "fulfilled" ? hookResult.value : null;
        setSavedSceneProfile(automation);
        setSavedHookProfile(profile);
        if (automation) {
          setOcrMode(automation.ocrMode ?? "none");
          setLaunchOverlay(automation.launchOverlay ?? false);
          if (automation.ocrMode !== "none") setTextSource("ocr");
        }
        if (profile && ["luna", "textractor", "agent"].includes(profile.engine)) {
          setTextSource(profile.engine);
          setLaunchTextHook(profile.autoHook);
          setAcceptedHook({ id: profile.hookId ?? null, function: profile.hookFunction ?? null });
          if (profile.engine === "agent") setSelectedAgentScript(profile.agentScriptPath ?? "");
          else setHookEngine(profile.engine);
        }
      }
      setContextFailed(false);
    } catch {
      loadedSceneRef.current = null;
      setContextFailed(true);
      setPreviewError(t("captureWizard.errors.contextFailed"));
      setStatusMessage(t("captureWizard.errors.contextFailed"));
    } finally {
      setContextLoading(false);
      setPreviewLoading(false);
    }
  }, [initialScene, t]);

  useEffect(() => {
    void refreshContext();
  }, [refreshContext]);

  const refreshPreview = useCallback(async () => {
    if (previewInFlightRef.current || !activeScene?.id) return;
    previewInFlightRef.current = true;
    try {
      const [snapshotResult, captureModeResult] = await Promise.allSettled([
        invokeIpc<ObsScenePreviewSnapshot | null>(
          "obs.getScenePreviewSnapshot",
          activeScene.id
        ),
        invokeIpc<ObsCaptureMode | null>("obs.getSceneCaptureMode", activeScene.id)
      ]);
      const snapshot = snapshotResult.status === "fulfilled" ? snapshotResult.value : null;
      const captureMode =
        normalizeCaptureMode(snapshot?.captureMode) ??
        (captureModeResult.status === "fulfilled"
          ? normalizeCaptureMode(captureModeResult.value)
          : null);
      setPreview(snapshot);
      setPreviewCaptureMode(captureMode);
      setPreviewError(snapshot ? null : t("captureWizard.preview.noPreview"));
    } catch {
      setPreviewError(t("captureWizard.preview.noPreview"));
    } finally {
      setPreviewLoading(false);
      previewInFlightRef.current = false;
    }
  }, [activeScene?.id, t]);

  useEffect(() => {
    if (step !== "preview" || !activeScene?.id) return undefined;
    setPreviewLoading(true);
    void refreshPreview();
    const interval = window.setInterval(() => {
      void refreshPreview();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [activeScene?.id, refreshPreview, step]);

  const switchCaptureMode = useCallback(async () => {
    if (!activeScene?.id || !previewCaptureMode) return;
    const targetMode: ObsCaptureMode =
      previewCaptureMode === "window_capture" ? "game_capture" : "window_capture";
    setPreviewLoading(true);
    try {
      const result = await invokeIpc<ObsCaptureMode | null>("obs.switchSceneCaptureMode", {
        sceneUuid: activeScene.id,
        targetMode
      });
      setPreviewCaptureMode(normalizeCaptureMode(result) ?? targetMode);
      await refreshPreview();
    } catch {
      setPreviewError(t("captureWizard.preview.switchFailed"));
    } finally {
      setPreviewLoading(false);
    }
  }, [activeScene?.id, previewCaptureMode, refreshPreview, t]);

  const loadAgentCandidates = useCallback(async () => {
    if (!activeScene) return;
    const contextKey = loadedSceneRef.current;
    setAgentLoading(true);
    setStatusMessage(null);
    try {
      const [resolved, listed] = await Promise.all([
        invokeIpc<ResolveAgentScriptResponse>("settings.resolveAgentScriptForScene", {
          scene: activeScene
        }),
        invokeIpc<ListAgentScriptsResponse>("settings.listAgentScripts", {})
      ]);

      if (loadedSceneRef.current !== contextKey) return;
      setIsSwitchTarget(resolved?.isSwitchTarget);
      const candidates = buildAgentScriptCandidateList({
        searchContext: {
          sceneName: activeScene.name,
          windowTitle: resolved?.windowTitle ?? capture?.windowTitle,
          processName: resolved?.processName ?? capture?.exeName
        },
        scripts: Array.isArray(listed?.scripts) ? listed.scripts : [],
        resolvedCandidates: Array.isArray(resolved?.candidates) ? resolved.candidates : [],
        resolvedPath: resolved?.status === "success" ? resolved.path : null,
        resolvedReason: resolved?.reason,
      });

      setAgentCandidates(candidates);
    } catch {
      setStatusMessage(t("captureWizard.agent.searchFailed"));
    } finally {
      setAgentLoading(false);
    }
  }, [activeScene, capture?.exeName, capture?.windowTitle, t]);

  const openAgentScriptSearch = useCallback(async () => {
    if (!activeScene) return;
    const contextKey = loadedSceneRef.current;
    setAgentLoading(true);
    setStatusMessage(null);
    try {
      const [resolved, listed] = await Promise.all([
        invokeIpc<ResolveAgentScriptResponse>("settings.resolveAgentScriptForScene", {
          scene: activeScene
        }),
        invokeIpc<ListAgentScriptsResponse>("settings.listAgentScripts", {})
      ]);
      if (loadedSceneRef.current !== contextKey) return;
      const scripts = Array.isArray(listed?.scripts) ? listed.scripts : [];
      const candidates = buildAgentScriptCandidateList({
        searchContext: {
          sceneName: activeScene.name,
          windowTitle: resolved?.windowTitle ?? capture?.windowTitle,
          processName: resolved?.processName ?? capture?.exeName
        },
        scripts,
        resolvedCandidates: Array.isArray(resolved?.candidates) ? resolved.candidates : [],
        resolvedPath: resolved?.status === "success" ? resolved.path : null,
        resolvedReason: resolved?.reason,
      });

      if (candidates.length === 0) {
        setStatusMessage(listed?.message ?? t("captureWizard.agent.noMatches"));
        return;
      }

      setAgentSearchDialog({
        candidates,
        query: "",
      });
    } catch {
      setStatusMessage(t("captureWizard.agent.searchFailed"));
    } finally {
      setAgentLoading(false);
    }
  }, [activeScene, capture?.exeName, capture?.windowTitle, t]);

  useEffect(() => {
    if (step === "hook" && activeScene && !contextLoading) {
      void loadAgentCandidates();
    }
  }, [activeScene, contextLoading, loadAgentCandidates, step]);

  const refreshHookRuntime = useCallback(async () => {
    const contextKey = loadedSceneRef.current;
    try {
      const [status, hookList] = await Promise.all([
        invokeIpc<RuntimeStatus>("texthook.getStatus"),
        invokeIpc<{ hooks: HookEntry[]; selectedHookId: string | null }>("texthook.listHooks")
      ]);
      if (loadedSceneRef.current !== contextKey) return;
      setHookStatus(status ?? { running: false });
      setHooks(Array.isArray(hookList?.hooks) ? hookList.hooks : []);
      setSelectedHookId(hookList?.selectedHookId ?? (status?.running ? status.selectedHookId : null));
      if (status?.running && (status.engine === "luna" || status.engine === "textractor")) {
        setHookEngine(status.engine);
      }
      if (status?.running && status.engine === "agent" && status.agentScriptPath &&
          status.exeName.toLowerCase() === capture?.exeName?.toLowerCase()) {
        setSelectedAgentScript((current) => current || status.agentScriptPath || "");
      }
    } catch {
      setStatusMessage(t("captureWizard.hook.refreshFailed"));
    }
  }, [capture?.exeName, t]);

  useEffect(() => {
    if (step !== "hook") return undefined;
    void refreshHookRuntime();
    const interval = window.setInterval(() => {
      void refreshHookRuntime();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [refreshHookRuntime, step]);

  useEffect(() => {
    if (step !== "hook" || !runtimeMatchesCapture || !hookStatus.running || hookStatus.engine !== "agent") return;
    return onIpc("texthook.text", (_event, payload) => {
      const value = (payload as { text?: unknown } | null)?.text;
      if (typeof value !== "string" || !value.trim()) return;
      setAgentSamples((current) => [value.trim(), ...current].slice(0, 3));
    });
  }, [hookStatus, runtimeMatchesCapture, step]);

  const startHookEngine = useCallback(async (engine: TextHookEngine = hookEngine, scriptPath?: string) => {
    if (hookBusy || !exeName) return;
    setHookBusy(true);
    setAgentSamples([]);
    setStatusMessage(null);
    try {
      const result = await invokeIpc<{ success: boolean; error?: string }>("texthook.start", {
        engine,
        exeName,
        sceneId: activeScene?.id,
        flushDelayMs: savedHookProfile?.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS,
        copyToClipboard: savedHookProfile?.copyToClipboard ?? false,
        agentScriptPath: engine === "agent" ? scriptPath : undefined,
        agentDetached: engine === "agent" ? savedHookProfile?.agentDetached ?? true : undefined
      });
      if (!result?.success) {
        setStatusMessage(result?.error ?? t("captureWizard.hook.startFailed"));
        return;
      }
      if (engine === "agent" && scriptPath) {
        setSelectedAgentScript(scriptPath);
        setTextSource("agent");
        setTextSourceChanged(true);
        if (!hasTextHook) setLaunchTextHook(true);
      }
      await refreshHookRuntime();
    } catch {
      setStatusMessage(t("captureWizard.hook.startFailed"));
    } finally {
      setHookBusy(false);
    }
  }, [activeScene?.id, exeName, hasTextHook, hookBusy, hookEngine, refreshHookRuntime, savedHookProfile, t]);

  const stopHookEngine = useCallback(async () => {
    setHookBusy(true);
    setStatusMessage(null);
    try {
      const result = await invokeIpc<{ success?: boolean }>("texthook.stop");
      if (!result?.success) throw new Error("Stop failed");
      setHookStatus({ running: false });
      setHooks([]);
      setSelectedHookId(null);
    } catch {
      setStatusMessage(t("captureWizard.guided.stoppingFailed"));
    } finally {
      setHookBusy(false);
    }
  }, [t]);

  const selectHook = useCallback(
    async (hookId: string) => {
      if (!runtimeMatchesCapture) return;
      try {
        const result = await invokeIpc<{ success: boolean }>("texthook.selectHook", hookId);
        if (!result?.success) throw new Error("Select failed");
        setSelectedHookId(hookId);
        const hook = hooks.find((entry) => entry.id === hookId);
        if (hook && hookStatus.running && hookStatus.engine !== "agent") {
          setAcceptedHook({ id: hook.id, function: hook.function });
          setTextSource(hookStatus.engine);
          setTextSourceChanged(true);
          if (!hasTextHook) setLaunchTextHook(true);
        }
      } catch {
        setStatusMessage(t("captureWizard.hook.refreshFailed"));
      }
    },
    [hasTextHook, hooks, hookStatus, runtimeMatchesCapture, t]
  );

  const acceptAgentScript = useCallback((scriptPath: string) => {
    setSelectedAgentScript(scriptPath);
    setTextSource("agent");
    setTextSourceChanged(true);
    if (!hasTextHook) setLaunchTextHook(true);
    setStep("ocr");
  }, [hasTextHook]);

  const selectAgentScript = useCallback((scriptPath: string) => {
    setSelectedAgentScript(scriptPath);
    setAgentSearchDialog(null);
    setAgentCandidates((current) => {
      const normalizedScriptPath = normalizeAgentScriptPathForCompare(scriptPath);
      if (
        current.some(
          (candidate) => normalizeAgentScriptPathForCompare(candidate.path) === normalizedScriptPath
        )
      ) {
        return current;
      }
      return [{ path: scriptPath, score: 0 }, ...current];
    });
  }, []);

  const acceptHook = useCallback(() => {
    if (!selectedHook || !runtimeMatchesCapture || !hookStatus.running || hookStatus.engine === "agent") return;
    setTextSource(hookStatus.engine);
    setTextSourceChanged(true);
    setAcceptedHook({ id: selectedHook.id, function: selectedHook.function });
    if (!hasTextHook) setLaunchTextHook(true);
    setStep("ocr");
  }, [hasTextHook, hookStatus, runtimeMatchesCapture, selectedHook]);

  const clearInitialOcrTimeout = useCallback(() => {
    if (initialOcrTimeoutRef.current !== null) {
      window.clearTimeout(initialOcrTimeoutRef.current);
      initialOcrTimeoutRef.current = null;
    }
  }, []);

  const waitForInitialOcrResult = useCallback(() => {
    clearInitialOcrTimeout();
    awaitingInitialOcrResultRef.current = true;
    setOcrInitialScanState("scanning");
    initialOcrTimeoutRef.current = window.setTimeout(() => {
      if (!awaitingInitialOcrResultRef.current) return;
      awaitingInitialOcrResultRef.current = false;
      setOcrInitialScanState("noText");
    }, 15_000);
  }, [clearInitialOcrTimeout]);

  const runInitialOcrScan = useCallback(async () => {
    clearInitialOcrTimeout();
    pendingInitialOcrStartRef.current = false;
    awaitingInitialOcrResultRef.current = false;
    setOcrInitialScanState("starting");
    try {
      const runningState = await invokeIpc<OcrRunningState | null>("ocr.get-running-state");
      if (runningState?.isRunning) {
        sendIpc("ocr.manual-ocr");
        waitForInitialOcrResult();
        return;
      }

      pendingInitialOcrStartRef.current = true;
      sendIpc("ocr.start-ocr-ss-only");
    } catch {
      setOcrInitialScanState("error");
    }
  }, [clearInitialOcrTimeout, waitForInitialOcrResult]);

  useEffect(() => {
    const offSelectorFinished = onIpc("ocr-screen-selector-finished", (_event, payload) => {
      if (!ocrSelectorRequestedRef.current) return;
      ocrSelectorRequestedRef.current = false;
      const result = payload as { success?: boolean } | null;
      if (result?.success === false) {
        setOcrInitialScanState("error");
        return;
      }
      void runInitialOcrScan();
    });

    const offOcrStarted = onIpc("ocr-ipc-started", () => {
      if (!pendingInitialOcrStartRef.current) return;
      pendingInitialOcrStartRef.current = false;
      sendIpc("ocr.manual-ocr");
      waitForInitialOcrResult();
    });

    const offOcrMessage = onIpc("ocr-ipc-message", (_event, payload) => {
      if (!awaitingInitialOcrResultRef.current) return;
      const message = payload as OcrIpcMessage | null;
      if (message?.event !== "ocr_result") return;
      const rawText = message.data?.text ?? message.data?.sentence;
      const text = typeof rawText === "string" ? rawText.trim() : "";
      if (!text) return;

      awaitingInitialOcrResultRef.current = false;
      clearInitialOcrTimeout();
      setOcrSamples((current) => [text, ...current.filter((sample) => sample !== text)].slice(0, 3));
      setOcrInitialScanState("complete");
    });

    const offOcrError = onIpc("ocr-ipc-error", () => {
      if (!pendingInitialOcrStartRef.current && !awaitingInitialOcrResultRef.current) return;
      pendingInitialOcrStartRef.current = false;
      awaitingInitialOcrResultRef.current = false;
      clearInitialOcrTimeout();
      setOcrInitialScanState("error");
    });

    return () => {
      offSelectorFinished();
      offOcrStarted();
      offOcrMessage();
      offOcrError();
      clearInitialOcrTimeout();
    };
  }, [clearInitialOcrTimeout, runInitialOcrScan, waitForInitialOcrResult]);

  const openAreaSelector = useCallback(() => {
    clearInitialOcrTimeout();
    ocrSelectorRequestedRef.current = true;
    pendingInitialOcrStartRef.current = false;
    awaitingInitialOcrResultRef.current = false;
    setOcrSamples([]);
    setOcrInitialScanState("selecting");
    setStatusMessage(null);
    sendIpc("ocr.run-screen-selector");
    if (!hasTextHook) {
      setTextSource("ocr");
      setLaunchTextHook(false);
    }
  }, [clearInitialOcrTimeout, hasTextHook]);

  const closeWizard = useCallback(async () => {
    try {
      if (dontAskAgain) {
        await invokeIpc("settings.saveSettings", { textCaptureWizardEnabled: false });
      }
    } catch {
      // Closing should not be blocked by a settings persistence failure.
    } finally {
      onClose();
    }
  }, [dontAskAgain, onClose]);

  const saveProfileChoices = useCallback(async () => {
    setSaving(true);
    setStatusMessage(null);
    try {
      const sceneForSave = activeScene;
      if (contextFailed || !sceneForSave || (hasTextHook && !exeName) || (textSource === "agent" && !selectedAgentScript.trim())) {
        throw new Error("Missing capture target or script");
      }
      if (saveAutomation && sceneForSave) {
        const automationResult = await invokeIpc<{ success?: boolean }>("settings.saveSceneLaunchProfile", {
          scene: sceneForSave,
          // Agent, Luna, and Textractor are all handled by the integrated
          // text-hook profile below. Keep the legacy external launchers off.
          textHookMode: preserveLegacyHook ? savedSceneProfile?.textHookMode ?? "none" : "none",
          ocrMode,
          launchOverlay,
          agentScriptPath: preserveLegacyHook ? savedSceneProfile?.agentScriptPath ?? "" : "",
          launchDelaySeconds: savedSceneProfile?.launchDelaySeconds ?? 0
        });
        if (!automationResult?.success) {
          throw new Error("Failed to save scene automation");
        }
      }

      if (textSource === "agent" || textSource === "luna" || textSource === "textractor") {
        if (!exeName) {
          throw new Error("No game executable is available for the text-hook profile");
        }
        const profileResult = await invokeIpc<{ success?: boolean }>("texthook.saveProfile", {
          exeName,
          sceneId: sceneForSave?.id ?? capture?.sceneId,
          engine: textSource,
          autoHook: launchTextHook,
          flushDelayMs: savedHookProfile?.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS,
          copyToClipboard: savedHookProfile?.copyToClipboard ?? false,
          hookId: textSource === "agent" ? null : acceptedHook?.id ?? null,
          hookFunction: textSource === "agent" ? null : acceptedHook?.function ?? null,
          manualHookCode: savedHookProfile?.engine === textSource ? savedHookProfile.manualHookCode ?? null : null,
          agentScriptPath: textSource === "agent" ? selectedAgentScript.trim() : null,
          ...(savedHookProfile?.agentDetached !== undefined ? { agentDetached: savedHookProfile.agentDetached } : {})
        });
        if (!profileResult?.success) {
          throw new Error("Failed to save integrated text-hook profile");
        }
      } else if (textSourceChanged && textSource === "ocr" && savedHookProfile && exeName) {
        const result = await invokeIpc<{ success?: boolean }>("texthook.saveProfile", {
          ...savedHookProfile, exeName, sceneId: sceneForSave.id, autoHook: false
        });
        if (!result?.success) throw new Error("Failed to disable previous text hook automation");
      }
      await closeWizard();
    } catch {
      setStatusMessage(t("captureWizard.profile.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [
    activeScene,
    acceptedHook,
    capture?.sceneId,
    exeName,
    closeWizard,
    contextFailed,
    hasTextHook,
    launchOverlay,
    launchTextHook,
    ocrMode,
    saveAutomation,
    selectedAgentScript,
    savedHookProfile,
    savedSceneProfile,
    preserveLegacyHook,
    textSourceChanged,
    textSource,
    t
  ]);

  const loadGsmProfiles = useCallback(async () => {
    setProfilesLoading(true);
    try {
      const result = await invokeIpc<GsmProfileList | null>("settings.listGSMProfiles");
      const profiles = Array.isArray(result?.profiles) ? result.profiles : [];
      const current = typeof result?.currentProfile === "string" ? result.currentProfile : "";
      setGsmProfiles(profiles);
      setCurrentGsmProfile(current);
      setSelectedProfile((existing) => existing || current || profiles[0] || "");
    } catch {
      // Profile assignment is optional; ignore failures to keep the wizard usable.
    } finally {
      setProfilesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (step === "finish") void loadGsmProfiles();
  }, [loadGsmProfiles, step]);

  const assignSceneToProfile = useCallback(async () => {
    const sceneName = activeScene?.name?.trim();
    if (!sceneName) {
      setStatusMessage(t("captureWizard.profile.assignNoScene"));
      return;
    }
    const isNew = selectedProfile === NEW_PROFILE_VALUE;
    const profileName = isNew ? newProfileName.trim() : selectedProfile.trim();
    if (!profileName) {
      setStatusMessage(t("captureWizard.profile.assignNoProfile"));
      return;
    }
    setAssigningProfile(true);
    setStatusMessage(null);
    try {
      const result = await invokeIpc<{ success?: boolean }>("settings.relateSceneToProfile", {
        sceneName,
        profileName,
        createNew: isNew
      });
      if (result?.success === false) {
        setStatusMessage(t("captureWizard.profile.assignFailed"));
        return;
      }
      if (isNew) {
        setGsmProfiles((current) =>
          current.includes(profileName) ? current : [...current, profileName]
        );
        setNewProfileName("");
      }
      setSelectedProfile(profileName);
      setStatusMessage(
        t("captureWizard.profile.assignSuccess", { scene: sceneName, profile: profileName })
      );
    } catch {
      setStatusMessage(t("captureWizard.profile.assignFailed"));
    } finally {
      setAssigningProfile(false);
    }
  }, [activeScene?.name, newProfileName, selectedProfile, t]);

  const goBack = useCallback(() => {
    if (isFirstStep) return;
    setStep(CAPTURE_WIZARD_STEPS[stepIndex - 1].id);
  }, [isFirstStep, stepIndex]);

  return (
    <div className="capture-wizard-overlay" role="dialog" aria-modal="true" aria-labelledby="capture-wizard-title">
      <div className="capture-wizard-card">
        <div className="capture-wizard-header">
          <div>
            <h2 id="capture-wizard-title">{t("captureWizard.title")}</h2>
            <p>{t("captureWizard.subtitle")}</p>
          </div>
          <button type="button" className="secondary" disabled={saving} onClick={() => void closeWizard()}>
            {t("captureWizard.actions.deny")}
          </button>
        </div>

        <div className="capture-wizard-breadcrumbs" aria-label={t("captureWizard.breadcrumbLabel")}>
          {CAPTURE_WIZARD_STEPS.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              className={`capture-wizard-crumb ${entry.id === step ? "capture-wizard-crumb--active" : ""}`}
              aria-current={entry.id === step ? "step" : undefined}
              disabled={saving || hookBusy || contextLoading}
              onClick={() => { setStatusMessage(null); setStep(entry.id); }}
            >
              <span>{String(index + 1)}</span>
              {t(entry.labelKey)}
            </button>
          ))}
        </div>

        <div className="capture-wizard-body">
          {contextFailed || statusMessage ? <div className="capture-wizard-note" role="status">{contextFailed ? t("captureWizard.errors.contextFailed") : statusMessage}</div> : null}
          {step === "preview" ? (
            <section className="capture-wizard-step-panel capture-wizard-step-panel--preview">
              <div className="capture-wizard-copy">
                <h3>{t("captureWizard.preview.title")}</h3>
                <p>{t("captureWizard.preview.description")}</p>
              </div>
              <div className="capture-wizard-preview-shell">
                {preview?.imageData ? (
                  <img
                    src={preview.imageData}
                    alt={t("captureWizard.preview.imageAlt")}
                    className="capture-wizard-preview-image"
                  />
                ) : (
                  <div className="capture-wizard-preview-empty">
                    {previewLoading ? t("captureWizard.preview.loading") : !activeScene ? t("captureWizard.guided.noScene") : previewError ?? t("captureWizard.preview.noPreview")}
                  </div>
                )}
              </div>
              <div className="capture-wizard-meta-grid">
                <div>
                  <span>{t("captureWizard.preview.scene")}</span>
                  <strong>{activeScene?.name ?? t("captureWizard.preview.unknown")}</strong>
                </div>
                <div>
                  <span>{t("captureWizard.preview.executable")}</span>
                  <strong>{exeName ?? t("captureWizard.preview.unknown")}</strong>
                </div>
                <div>
                  <span>{t("captureWizard.preview.captureType")}</span>
                  <strong>
                    {previewCaptureMode === "game_capture"
                      ? t("captureWizard.preview.gameCapture")
                      : previewCaptureMode === "window_capture"
                        ? t("captureWizard.preview.windowCapture")
                        : t("captureWizard.preview.unknown")}
                  </strong>
                </div>
              </div>
              <div className="capture-wizard-action-row">
                <button type="button" className="secondary" disabled={previewLoading || contextLoading} onClick={() => { void refreshContext(); void refreshPreview(); }}>
                  {t("captureWizard.preview.refresh")}
                </button>
                {previewCaptureMode ? (
                  <button type="button" className="secondary" onClick={() => void switchCaptureMode()}>
                    {previewCaptureMode === "window_capture"
                      ? t("captureWizard.preview.switchToGame")
                      : t("captureWizard.preview.switchToWindow")}
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          {step === "hook" ? (
            <section className="capture-wizard-step-panel">
              <div className="capture-wizard-copy">
                <h3>{t("captureWizard.hook.title")}</h3>
                <p>{t("captureWizard.hook.description")}</p>
              </div>
              <div className="capture-wizard-methods">
              <div className="capture-wizard-method">
                <h4>{t("captureWizard.guided.vnTitle")}</h4>
                <p className="capture-wizard-instruction">{t("captureWizard.guided.hookGuide")}</p>
                <div className="capture-wizard-hook-toolbar">
                  <label htmlFor="capture-wizard-hook-engine">{t("captureWizard.hook.engine")}</label>
                  <select
                    id="capture-wizard-hook-engine"
                    value={hookEngine}
                    disabled={hookStatus.running || hookBusy || contextLoading}
                    onChange={(event) => setHookEngine(event.target.value as Exclude<TextHookEngine, "agent">)}
                  >
                    <option value="luna">{t("captureWizard.hook.luna")}</option>
                    <option value="textractor">{t("captureWizard.hook.textractor")}</option>
                  </select>
                  {hookStatus.running ? (
                    <button type="button" className="secondary" disabled={hookBusy} onClick={() => void stopHookEngine()}>
                      {t("captureWizard.guided.stopHook")}
                    </button>
                  ) : (
                    <button type="button" disabled={hookBusy || contextLoading || !exeName} onClick={() => void startHookEngine()}>
                      {t(hookBusy ? "captureWizard.guided.engineBusy" : "captureWizard.hook.start")}
                    </button>
                  )}
                </div>
                {!exeName ? <p className="capture-wizard-instruction">{t("captureWizard.guided.noScene")}</p> : null}
                {hookStatus.running && !runtimeMatchesCapture ? (
                  <p className="capture-wizard-instruction">{t("captureWizard.guided.otherGameRunning", { exe: hookStatus.exeName })}</p>
                ) : hookStatus.running && hookStatus.engine === "agent" ? (
                  <p className="capture-wizard-instruction">{t("captureWizard.guided.agentRunning")}</p>
                ) : hookStatus.running && visibleHooks.length === 0 ? (
                  <p className="capture-wizard-instruction">
                    {t(hookStatus.running ? "captureWizard.hook.waiting" : "captureWizard.hook.startFirst")}
                  </p>
                ) : null}
                {visibleHooks.length > 0 ? (
                  <div className="capture-wizard-hook-list">
                    {visibleHooks.map((hook) => {
                      const selected = hook.id === selectedHookId;
                      return (
                        <button
                          key={hook.id}
                          type="button"
                          className={`capture-wizard-hook ${selected ? "capture-wizard-hook--selected" : ""}`}
                          aria-pressed={selected}
                          onClick={() => void selectHook(hook.id)}
                        >
                          <span className="capture-wizard-choice-body">
                            <strong>{hook.preview || hook.samples[0] || t("captureWizard.hook.noPreview")}</strong>
                            <small>{hook.function}</small>
                          </span>
                          <span className="capture-wizard-choice-check" aria-hidden="true">{selected ? "✓" : ""}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                {hookStatus.running && runtimeMatchesCapture && hookStatus.engine !== "agent" ? (
                  <div className="capture-wizard-action-row">
                    <button type="button" disabled={!selectedHook || hookBusy} onClick={acceptHook}>
                      {t("captureWizard.hook.useHook")}
                    </button>
                  </div>
                ) : null}
              </div>
              <div className={`capture-wizard-method ${recommendedAgent ? "capture-wizard-method--recommended" : ""}`}>
                <h4>{t("captureWizard.guided.agentTitle")}</h4>
                <p className="capture-wizard-instruction">{t("captureWizard.guided.agentDescription")}</p>
                {runtimeMatchesCapture && hookStatus.running && hookStatus.engine === "agent" && agentSamples.length > 0 ? (
                  <div className="capture-wizard-ocr-samples" role="log" aria-label={t("texthook.output.title")}>
                    {agentSamples.map((sample, index) => <div className="capture-wizard-ocr-sample" key={index}>{sample}</div>)}
                  </div>
                ) : null}
                {agentLoading ? <p role="status">{t("captureWizard.agent.loading")}</p> : null}
                {displayedAgentScript ? (
                  <>
                    {recommendedAgent?.path === displayedAgentScript ? (
                      <div className="capture-wizard-recommendation">
                        <strong>{t("captureWizard.guided.agentRecommended")}</strong>
                        <p>{t("captureWizard.guided.agentMatchHint")}</p>
                      </div>
                    ) : null}
                    <div className="capture-wizard-script capture-wizard-script--selected">
                      <span className="capture-wizard-choice-body" title={displayedAgentScript}>
                        <AgentScriptDisplay scriptPath={displayedAgentScript} showPath={false} />
                      </span>
                    </div>
                    <div className="capture-wizard-action-row">
                      <button type="button" className="secondary" disabled={hookBusy || hookStatus.running || !exeName || contextLoading}
                        onClick={() => void startHookEngine("agent", displayedAgentScript)}>
                        {t("captureWizard.guided.agentStart")}
                      </button>
                      <button type="button" disabled={!exeName || hookBusy || contextLoading} onClick={() => acceptAgentScript(displayedAgentScript)}>
                        {t("captureWizard.guided.useAgent")}
                      </button>
                    </div>
                  </>
                ) : !agentLoading ? <p className="capture-wizard-instruction">{t("captureWizard.guided.agentNoMatch")}</p> : null}
                <div className="capture-wizard-action-row">
                  <button type="button" className="secondary" disabled={agentLoading || contextLoading || !activeScene}
                    onClick={() => void openAgentScriptSearch()}>
                    {t("captureWizard.agent.manualSearch")}
                  </button>
                </div>
              </div>
              </div>
              {hasTextHook ? <div className="capture-wizard-note">{t("captureWizard.guided.selectedSource", { source: sourceLabel })}</div> : null}
            </section>
          ) : null}

          {step === "ocr" ? (
            <section className="capture-wizard-step-panel">
              <div className="capture-wizard-copy">
                <h3>{t("captureWizard.ocr.title")}</h3>
                <p>{t("captureWizard.ocr.description")}</p>
              </div>
              {hasTextHook ? (
                <div className="capture-wizard-note">
                  <p>{t("captureWizard.guided.ocrOptional")}</p>
                  <button type="button" className="secondary" onClick={() => { setOcrMode("none"); setStep("finish"); }}>
                    {t("captureWizard.guided.skipOcr")}
                  </button>
                </div>
              ) : null}
              <div className="capture-wizard-action-row">
                <button type="button" disabled={ocrInitialScanState === "selecting" || ocrInitialScanState === "starting" || ocrInitialScanState === "scanning"}
                  onClick={openAreaSelector}>
                  {t("captureWizard.ocr.openAreaSelector")}
                </button>
                {ocrInitialScanState !== "idle" && ocrInitialScanState !== "selecting" ? (
                  <button type="button" className="secondary"
                    disabled={ocrInitialScanState === "starting" || ocrInitialScanState === "scanning"}
                    onClick={() => void runInitialOcrScan()}>
                    {t("captureWizard.ocr.scanAgain")}
                  </button>
                ) : null}
              </div>
              <div className="capture-wizard-ocr-preview">
                <div className="capture-wizard-ocr-preview-header">
                  <strong>{t("captureWizard.ocr.sampleTitle")}</strong>
                  <span>{t("captureWizard.ocr.sampleHint")}</span>
                </div>
                {ocrSamples.length > 0 ? (
                  <div className="capture-wizard-ocr-samples">
                    {ocrSamples.map((sample) => (
                      <div key={sample} className="capture-wizard-ocr-sample">
                        {sample}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="capture-wizard-ocr-placeholder">
                    {ocrInitialScanState === "selecting"
                      ? t("captureWizard.ocr.selecting")
                      : ocrInitialScanState === "starting"
                        ? t("captureWizard.ocr.starting")
                        : ocrInitialScanState === "scanning"
                          ? t("captureWizard.ocr.scanning")
                          : ocrInitialScanState === "noText"
                            ? t("captureWizard.ocr.noText")
                            : ocrInitialScanState === "error"
                              ? t("captureWizard.ocr.scanFailed")
                              : t("captureWizard.ocr.noSampleYet")}
                  </div>
                )}
              </div>
              <fieldset className="capture-wizard-ocr-automation">
                <legend>{t("captureWizard.ocr.automationTitle")}</legend>
                <p>{t("captureWizard.ocr.automationDescription")}</p>
                <div className="capture-wizard-ocr-automation-options">
                  {OCR_AUTOMATION_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      className={ocrMode === option.value ? "capture-wizard-ocr-automation-option--selected" : ""}
                    >
                      <input
                        type="radio"
                        name="capture-wizard-ocr-automation"
                        value={option.value}
                        checked={ocrMode === option.value}
                        onChange={() => {
                          if (!hasTextHook) {
                            setTextSource("ocr");
                            setLaunchTextHook(false);
                          }
                          setOcrMode(option.value);
                        }}
                      />
                      <span>
                        <strong>{t(option.labelKey)}</strong>
                        <small>{t(option.descriptionKey)}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {hasTextHook ? <div className="capture-wizard-action-row">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setTextSource("ocr");
                    setTextSourceChanged(true);
                    setLaunchTextHook(false);
                    setStep("finish");
                  }}
                >
                  {t("captureWizard.guided.useOcr")}
                </button>
              </div> : null}
            </section>
          ) : null}

          {step === "finish" ? (
            <section className="capture-wizard-step-panel">
              <div className="capture-wizard-copy">
                <h3>{t("captureWizard.profile.title")}</h3>
                <p>{t("captureWizard.profile.description")}</p>
              </div>
              <div className="capture-wizard-summary">
                <span>{t("captureWizard.preview.scene")}</span>
                <strong>{activeScene?.name ?? t("captureWizard.preview.unknown")}</strong>
                <span>{t("captureWizard.profile.source")}</span>
                <strong>{sourceLabel}</strong>
                {textSource === "agent" && selectedAgentScript ? <AgentScriptDisplay scriptPath={selectedAgentScript} showPath={false} /> : null}
              </div>
              {!textSourceChanged && (savedHookProfile || savedSceneProfile) ? <p className="capture-wizard-instruction">{t("captureWizard.guided.usingSaved")}</p> : null}
              {textSource === "none" && !preserveLegacyHook ? <p className="capture-wizard-instruction">{t("captureWizard.guided.noSource")}</p> : null}
              <div className="capture-wizard-form">
                {hasTextHook ? <label>
                  <input
                    type="checkbox"
                    checked={launchTextHook}
                    onChange={(event) => setLaunchTextHook(event.target.checked)}
                  />
                  {t("captureWizard.profile.launchTextHook")}
                </label> : null}
                <label htmlFor="capture-wizard-ocr-mode">{t("captureWizard.profile.ocrMode")}</label>
                <select
                  id="capture-wizard-ocr-mode"
                  value={ocrMode}
                  onChange={(event) => {
                    setOcrMode(event.target.value as SceneOcrMode);
                    if (!hasTextHook && event.target.value !== "none") setTextSource("ocr");
                  }}
                >
                  <option value="none">{t("captureWizard.profile.ocrNone")}</option>
                  <option value="manual">{t("captureWizard.profile.ocrManual")}</option>
                  <option value="auto">{t("captureWizard.profile.ocrAuto")}</option>
                </select>
              </div>
              <details className="capture-wizard-options">
                <summary>{t("captureWizard.guided.optionalSettings")}</summary>
                <div className="capture-wizard-form">
                <label>
                  <input type="checkbox" checked={saveAutomation} onChange={(event) => setSaveAutomation(event.target.checked)} />
                  {t("captureWizard.profile.saveAutomation")}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={launchOverlay}
                    onChange={(event) => setLaunchOverlay(event.target.checked)}
                  />
                  {t("captureWizard.profile.launchOverlay")}
                </label>
              </div>
              <div className="capture-wizard-profile-assign">
                <label htmlFor="capture-wizard-gsm-profile">
                  {t("captureWizard.profile.assignLabel")}
                </label>
                <p className="capture-wizard-profile-assign-hint">
                  {t("captureWizard.profile.assignHint", { scene: activeScene?.name ?? "" })}
                </p>
                <div className="capture-wizard-profile-assign-row">
                  <select
                    id="capture-wizard-gsm-profile"
                    value={selectedProfile}
                    disabled={profilesLoading || assigningProfile}
                    onChange={(event) => setSelectedProfile(event.target.value)}
                  >
                    {gsmProfiles.map((name) => (
                      <option key={name} value={name}>
                        {name === currentGsmProfile
                          ? t("captureWizard.profile.assignCurrentProfile", { profile: name })
                          : name}
                      </option>
                    ))}
                    <option value={NEW_PROFILE_VALUE}>
                      {t("captureWizard.profile.assignNewOption")}
                    </option>
                  </select>
                  {selectedProfile === NEW_PROFILE_VALUE ? (
                    <input
                      type="text"
                      value={newProfileName}
                      placeholder={t("captureWizard.profile.assignNewPlaceholder")}
                      onChange={(event) => setNewProfileName(event.target.value)}
                    />
                  ) : null}
                  <button
                    type="button"
                    className="secondary"
                    disabled={
                      assigningProfile ||
                      profilesLoading ||
                      !selectedProfile ||
                      (selectedProfile === NEW_PROFILE_VALUE && !newProfileName.trim())
                    }
                    onClick={() => void assignSceneToProfile()}
                  >
                    {assigningProfile
                      ? t("captureWizard.profile.assigning")
                      : t("captureWizard.profile.assignButton")}
                  </button>
                </div>
              </div>
              </details>
            </section>
          ) : null}

        </div>

        <div className="capture-wizard-footer">
          <label className="capture-wizard-checkbox">
            <input
              type="checkbox"
              checked={dontAskAgain}
              onChange={(event) => setDontAskAgain(event.target.checked)}
            />
            {t("captureWizard.actions.dontAskAgain")}
          </label>
          <div className="capture-wizard-footer-actions">
            <button type="button" className="secondary" disabled={isFirstStep || saving || hookBusy} onClick={goBack}>
              {t("captureWizard.actions.back")}
            </button>
            {step !== "finish" ? (
              <button
                type="button"
                disabled={contextLoading || hookBusy || (step === "preview" && !activeScene)}
                onClick={() => {
                  setStatusMessage(null);
                  if (step === "ocr" && !hasTextHook) {
                    setTextSource("ocr");
                    setTextSourceChanged(true);
                    setLaunchTextHook(false);
                  }
                  setStep(CAPTURE_WIZARD_STEPS[stepIndex + 1].id);
                }}
              >
                {t(step === "preview" ? "captureWizard.guided.captureNext" : step === "hook" ? "captureWizard.guided.hookNext" : hasTextHook ? "captureWizard.guided.keepHook" : "captureWizard.guided.useOcr")}
              </button>
            ) : (
              <button type="button" disabled={saving || assigningProfile || contextLoading || contextFailed || !activeScene} onClick={() => void saveProfileChoices()}>
                {t(saving ? "captureWizard.profile.saving" : "captureWizard.guided.saveAndClose")}
              </button>
            )}
          </div>
        </div>
        {agentSearchDialog ? (
          <AgentScriptSearchDialog
            candidates={agentSearchDialog.candidates}
            query={agentSearchDialog.query}
            title={t("captureWizard.agent.pickerTitle")}
            closeLabel={t("captureWizard.agent.pickerClose")}
            searchPlaceholder={t("captureWizard.agent.searchPlaceholder")}
            noResultsLabel={t("captureWizard.agent.pickerNoResults")}
            selectedPath={selectedAgentScript}
            onClose={() => setAgentSearchDialog(null)}
            onQueryChange={(query) =>
              setAgentSearchDialog((current) =>
                current ? { ...current, query } : current
              )
            }
            onSelect={selectAgentScript}
          />
        ) : null}
      </div>
    </div>
  );
}

export default TextCaptureWizard;
