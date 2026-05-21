import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invokeIpc, sendIpc } from "../lib/ipc";
import { useTranslation } from "../i18n";
import type { ObsCaptureMode, ObsScene, SceneOcrMode, SceneTextHookMode } from "../types/models";
import { AgentScriptDisplay } from "./AgentScriptDisplay";
import { AgentScriptSearchDialog } from "./AgentScriptSearchDialog";
import {
  buildAgentScriptCandidateList,
  normalizeAgentScriptPathForCompare,
  type AgentScriptCandidate,
} from "../../../shared/agent_scripts";

type TextHookEngine = "luna" | "textractor" | "agent";
type WizardStep = "preview" | "agent" | "hook" | "ocr" | "profile" | "finish";
type WizardTextSource = "none" | TextHookEngine | "ocr";
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

const CAPTURE_WIZARD_STEPS: Array<{ id: WizardStep; labelKey: string }> = [
  { id: "preview", labelKey: "captureWizard.steps.preview" },
  { id: "agent", labelKey: "captureWizard.steps.agent" },
  { id: "hook", labelKey: "captureWizard.steps.hook" },
  { id: "ocr", labelKey: "captureWizard.steps.ocr" },
  { id: "profile", labelKey: "captureWizard.steps.profile" },
  { id: "finish", labelKey: "captureWizard.steps.finish" }
];

const DEFAULT_FLUSH_DELAY_MS = 100;

function hasHookText(hook: HookEntry): boolean {
  if (hook.preview.trim().length > 0) return true;
  return hook.samples.some((sample) => sample.trim().length > 0);
}

function toSceneLaunchTextHookMode(source: WizardTextSource, launchTextHook: boolean): SceneTextHookMode {
  if (!launchTextHook) return "none";
  if (source === "agent" || source === "luna" || source === "textractor") return source;
  return "none";
}

function normalizeCaptureMode(value: unknown): ObsCaptureMode | null {
  return value === "window_capture" || value === "game_capture" ? value : null;
}

export function TextCaptureWizard({
  initialScene,
  onClose,
  onNavigateTab
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
  const [agentResolution, setAgentResolution] = useState<ResolveAgentScriptResponse | null>(null);
  const [selectedAgentScript, setSelectedAgentScript] = useState("");
  const [agentSearchDialog, setAgentSearchDialog] = useState<AgentScriptSearchDialogState | null>(null);
  const [hookEngine, setHookEngine] = useState<Exclude<TextHookEngine, "agent">>("luna");
  const [hookStatus, setHookStatus] = useState<RuntimeStatus>({ running: false });
  const [hooks, setHooks] = useState<HookEntry[]>([]);
  const [selectedHookId, setSelectedHookId] = useState<string | null>(null);
  const [textSource, setTextSource] = useState<WizardTextSource>("none");
  const [saveAutomation, setSaveAutomation] = useState(true);
  const [launchTextHook, setLaunchTextHook] = useState(true);
  const [ocrMode, setOcrMode] = useState<SceneOcrMode>("none");
  const [launchOverlay, setLaunchOverlay] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const previewInFlightRef = useRef(false);

  const activeScene = useMemo(() => {
    if (scene) return scene;
    if (capture?.sceneId && capture.sceneName) {
      return { id: capture.sceneId, name: capture.sceneName };
    }
    return null;
  }, [capture, scene]);

  const exeName = hookStatus.running ? hookStatus.exeName : capture?.exeName ?? null;
  const selectedHook = hooks.find((hook) => hook.id === selectedHookId) ?? null;
  const stepIndex = CAPTURE_WIZARD_STEPS.findIndex((entry) => entry.id === step);
  const isFirstStep = stepIndex <= 0;

  const visibleHooks = useMemo(
    () => hooks.filter(hasHookText),
    [hooks]
  );

  const sourceLabel = useMemo(() => {
    if (textSource === "agent") return t("captureWizard.profile.sourceAgent");
    if (textSource === "luna") return t("captureWizard.profile.sourceLuna");
    if (textSource === "textractor") return t("captureWizard.profile.sourceTextractor");
    if (textSource === "ocr") return t("captureWizard.profile.sourceOcr");
    return t("captureWizard.profile.sourceNone");
  }, [textSource, t]);

  const refreshContext = useCallback(async () => {
    try {
      const [activeSceneResult, activeCapture] = await Promise.all([
        invokeIpc<ObsScene | null>("obs.getActiveScene"),
        invokeIpc<ActiveCapture | null>("texthook.getActiveCapture")
      ]);
      if (activeSceneResult?.id && activeSceneResult.name) {
        setScene(activeSceneResult);
      }
      if (activeCapture) {
        setCapture(activeCapture);
      }
    } catch {
      setPreviewError(t("captureWizard.errors.contextFailed"));
    }
  }, [t]);

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
    setAgentLoading(true);
    setStatusMessage(null);
    try {
      const [resolved, listed] = await Promise.all([
        invokeIpc<ResolveAgentScriptResponse>("settings.resolveAgentScriptForScene", {
          scene: activeScene
        }),
        invokeIpc<ListAgentScriptsResponse>("settings.listAgentScripts", {})
      ]);

      setAgentResolution(resolved);
      const candidates = buildAgentScriptCandidateList({
        query: activeScene.name,
        scripts: Array.isArray(listed?.scripts) ? listed.scripts : [],
        resolvedCandidates: Array.isArray(resolved?.candidates) ? resolved.candidates : [],
        resolvedPath: resolved?.status === "success" ? resolved.path : null,
        resolvedReason: resolved?.reason,
        limit: 16,
      });

      setAgentCandidates(candidates);
      setSelectedAgentScript((current) => current || candidates[0]?.path || "");
      if (candidates.length === 0) {
        setStatusMessage(listed?.message ?? t("captureWizard.agent.noMatches"));
      }
    } catch {
      setStatusMessage(t("captureWizard.agent.searchFailed"));
    } finally {
      setAgentLoading(false);
    }
  }, [activeScene, t]);

  const openAgentScriptSearch = useCallback(async () => {
    if (!activeScene) return;
    setAgentLoading(true);
    setStatusMessage(null);
    try {
      const [resolved, listed] = await Promise.all([
        invokeIpc<ResolveAgentScriptResponse>("settings.resolveAgentScriptForScene", {
          scene: activeScene
        }),
        invokeIpc<ListAgentScriptsResponse>("settings.listAgentScripts", {})
      ]);
      const scripts = Array.isArray(listed?.scripts) ? listed.scripts : [];
      const candidates = buildAgentScriptCandidateList({
        query: activeScene.name,
        scripts,
        resolvedCandidates: Array.isArray(resolved?.candidates) ? resolved.candidates : [],
        resolvedPath: resolved?.status === "success" ? resolved.path : null,
        resolvedReason: resolved?.reason,
      });

      if (candidates.length === 0) {
        setStatusMessage(listed?.message ?? t("captureWizard.agent.noMatches"));
        return;
      }

      setAgentResolution(resolved);
      setAgentSearchDialog({
        candidates,
        query: activeScene.name,
      });
    } catch {
      setStatusMessage(t("captureWizard.agent.searchFailed"));
    } finally {
      setAgentLoading(false);
    }
  }, [activeScene, t]);

  useEffect(() => {
    if (step === "agent" && activeScene) {
      void loadAgentCandidates();
    }
  }, [activeScene, loadAgentCandidates, step]);

  const refreshHookRuntime = useCallback(async () => {
    try {
      const [status, hookList] = await Promise.all([
        invokeIpc<RuntimeStatus>("texthook.getStatus"),
        invokeIpc<{ hooks: HookEntry[]; selectedHookId: string | null }>("texthook.listHooks")
      ]);
      setHookStatus(status);
      setHooks(Array.isArray(hookList?.hooks) ? hookList.hooks : []);
      setSelectedHookId(hookList?.selectedHookId ?? (status.running ? status.selectedHookId : null));
      if (status.running && (status.engine === "luna" || status.engine === "textractor")) {
        setHookEngine(status.engine);
      }
    } catch {
      setStatusMessage(t("captureWizard.hook.refreshFailed"));
    }
  }, [t]);

  useEffect(() => {
    if (step !== "hook") return undefined;
    void refreshHookRuntime();
    const interval = window.setInterval(() => {
      void refreshHookRuntime();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [refreshHookRuntime, step]);

  const startHookEngine = useCallback(async () => {
    setStatusMessage(null);
    const result = await invokeIpc<{ success: boolean; error?: string }>("texthook.start", {
      engine: hookEngine,
      exeName: exeName ?? undefined,
      flushDelayMs: DEFAULT_FLUSH_DELAY_MS
    });
    if (!result?.success) {
      setStatusMessage(result?.error ?? t("captureWizard.hook.startFailed"));
      return;
    }
    await refreshHookRuntime();
  }, [exeName, hookEngine, refreshHookRuntime, t]);

  const selectHook = useCallback(
    async (hookId: string) => {
      const result = await invokeIpc<{ success: boolean }>("texthook.selectHook", hookId);
      if (result?.success) {
        setSelectedHookId(hookId);
      }
    },
    []
  );

  const acceptAgentScript = useCallback((scriptPath: string) => {
    setSelectedAgentScript(scriptPath);
    setTextSource("agent");
    setLaunchTextHook(true);
    setOcrMode("none");
    setStep("profile");
  }, []);

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
    if (!selectedHook) return;
    setTextSource(hookEngine);
    setLaunchTextHook(true);
    setOcrMode("none");
    setStep("profile");
  }, [hookEngine, selectedHook]);

  const openAreaSelector = useCallback(() => {
    sendIpc("ocr.run-screen-selector");
    setTextSource("ocr");
    setLaunchTextHook(false);
    setOcrMode("manual");
    setStatusMessage(t("captureWizard.ocr.areaSelectorStarted"));
  }, [t]);

  const saveProfileChoices = useCallback(async () => {
    setSaving(true);
    setStatusMessage(null);
    try {
      const sceneForSave = activeScene;
      if (saveAutomation && sceneForSave) {
        await invokeIpc("settings.saveSceneLaunchProfile", {
          scene: sceneForSave,
          textHookMode: toSceneLaunchTextHookMode(textSource, launchTextHook),
          ocrMode,
          launchOverlay,
          agentScriptPath: textSource === "agent" ? selectedAgentScript : "",
          launchDelaySeconds: 0
        });
      }

      if (exeName && (textSource === "agent" || textSource === "luna" || textSource === "textractor")) {
        await invokeIpc("texthook.saveProfile", {
          exeName,
          engine: textSource,
          autoHook: true,
          flushDelayMs: DEFAULT_FLUSH_DELAY_MS,
          hookId: textSource === "agent" ? null : selectedHook?.id ?? null,
          hookFunction: textSource === "agent" ? null : selectedHook?.function ?? null,
          manualHookCode: null,
          agentScriptPath: textSource === "agent" ? selectedAgentScript : null
        });
      }

      setStatusMessage(t("captureWizard.profile.saved"));
      setStep("finish");
    } catch {
      setStatusMessage(t("captureWizard.profile.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [
    activeScene,
    exeName,
    launchOverlay,
    launchTextHook,
    ocrMode,
    saveAutomation,
    selectedAgentScript,
    selectedHook,
    textSource,
    t
  ]);

  const closeWizard = useCallback(async () => {
    try {
      if (dontAskAgain) {
        await invokeIpc("settings.saveSettings", {
          textCaptureWizardEnabled: false
        });
      }
    } catch {
      // Closing should not be blocked by a settings persistence failure.
    } finally {
      onClose();
    }
  }, [dontAskAgain, onClose]);

  const goBack = useCallback(() => {
    if (isFirstStep) return;
    setStep(CAPTURE_WIZARD_STEPS[stepIndex - 1].id);
  }, [isFirstStep, stepIndex]);

  return (
    <div className="capture-wizard-overlay" role="dialog" aria-modal="true">
      <div className="capture-wizard-card">
        <div className="capture-wizard-header">
          <div>
            <h2>{t("captureWizard.title")}</h2>
            <p>{t("captureWizard.subtitle")}</p>
          </div>
          <button type="button" className="secondary" onClick={() => void closeWizard()}>
            {t("captureWizard.actions.deny")}
          </button>
        </div>

        <div className="capture-wizard-breadcrumbs" aria-label={t("captureWizard.breadcrumbLabel")}>
          {CAPTURE_WIZARD_STEPS.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              className={`capture-wizard-crumb ${entry.id === step ? "capture-wizard-crumb--active" : ""}`}
              onClick={() => setStep(entry.id)}
            >
              <span>{String(index + 1)}</span>
              {t(entry.labelKey)}
            </button>
          ))}
        </div>

        <div className="capture-wizard-body">
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
                    {previewLoading ? t("captureWizard.preview.loading") : previewError ?? t("captureWizard.preview.noPreview")}
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
                <button type="button" className="secondary" onClick={() => void refreshPreview()}>
                  {t("captureWizard.preview.refresh")}
                </button>
                {previewCaptureMode ? (
                  <button type="button" className="secondary" onClick={() => void switchCaptureMode()}>
                    {previewCaptureMode === "window_capture"
                      ? t("captureWizard.preview.switchToGame")
                      : t("captureWizard.preview.switchToWindow")}
                  </button>
                ) : null}
                <button type="button" onClick={() => setStep("agent")}>
                  {t("captureWizard.preview.looksCorrect")}
                </button>
              </div>
            </section>
          ) : null}

          {step === "agent" ? (
            <section className="capture-wizard-step-panel">
              <div className="capture-wizard-copy">
                <h3>{t("captureWizard.agent.title")}</h3>
                <p>{t("captureWizard.agent.description")}</p>
              </div>
              <div className="capture-wizard-note">
                {agentResolution?.isSwitchTarget
                  ? t("captureWizard.agent.switchDetected")
                  : t("captureWizard.agent.nsHint")}
              </div>
              {agentLoading ? (
                <div className="capture-wizard-empty">{t("captureWizard.agent.loading")}</div>
              ) : agentCandidates.length === 0 ? (
                <div className="capture-wizard-empty">{statusMessage ?? t("captureWizard.agent.noMatches")}</div>
              ) : (
                <div className="capture-wizard-script-list">
                  {agentCandidates.map((candidate) => {
                    const selected =
                      normalizeAgentScriptPathForCompare(candidate.path) ===
                      normalizeAgentScriptPathForCompare(selectedAgentScript);
                    return (
                      <button
                        key={candidate.path}
                        type="button"
                        className={`capture-wizard-script ${selected ? "capture-wizard-script--selected" : ""}`}
                        aria-pressed={selected}
                        onClick={() => setSelectedAgentScript(candidate.path)}
                      >
                        <span className="capture-wizard-choice-body">
                          <AgentScriptDisplay scriptPath={candidate.path} />
                        </span>
                        <span className="capture-wizard-choice-check" aria-hidden="true">
                          {selected ? "✓" : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="capture-wizard-action-row">
                <button type="button" className="secondary" onClick={() => void loadAgentCandidates()}>
                  {t("captureWizard.agent.searchAgain")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={agentLoading}
                  onClick={() => void openAgentScriptSearch()}
                >
                  {t("captureWizard.agent.manualSearch")}
                </button>
                <button type="button" className="secondary" onClick={() => setStep("hook")}>
                  {t("captureWizard.agent.tryHooks")}
                </button>
                <button
                  type="button"
                  disabled={!selectedAgentScript}
                  onClick={() => acceptAgentScript(selectedAgentScript)}
                >
                  {t("captureWizard.agent.useScript")}
                </button>
              </div>
            </section>
          ) : null}

          {step === "hook" ? (
            <section className="capture-wizard-step-panel">
              <div className="capture-wizard-copy">
                <h3>{t("captureWizard.hook.title")}</h3>
                <p>{t("captureWizard.hook.description")}</p>
              </div>
              <div className="capture-wizard-hook-toolbar">
                <label htmlFor="capture-wizard-hook-engine">{t("captureWizard.hook.engine")}</label>
                <select
                  id="capture-wizard-hook-engine"
                  value={hookEngine}
                  disabled={hookStatus.running}
                  onChange={(event) => setHookEngine(event.target.value as Exclude<TextHookEngine, "agent">)}
                >
                  <option value="luna">{t("captureWizard.hook.luna")}</option>
                  <option value="textractor">{t("captureWizard.hook.textractor")}</option>
                </select>
                <button
                  type="button"
                  disabled={hookStatus.running}
                  onClick={() => void startHookEngine()}
                >
                  {t("captureWizard.hook.start")}
                </button>
              </div>
              <div className="capture-wizard-note">
                {hookStatus.running
                  ? t("captureWizard.hook.running", { count: String(visibleHooks.length) })
                  : t("captureWizard.hook.notRunning")}
              </div>
              {visibleHooks.length === 0 ? (
                <div className="capture-wizard-empty">
                  {hookStatus.running
                    ? t("captureWizard.hook.waiting")
                    : t("captureWizard.hook.startFirst")}
                </div>
              ) : (
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
                        <span className="capture-wizard-hook-id">#{hook.id}</span>
                        <span className="capture-wizard-choice-body">
                          <strong>{hook.function}</strong>
                          <em>{hook.preview || hook.samples[0] || t("captureWizard.hook.noPreview")}</em>
                        </span>
                        <span className="capture-wizard-choice-check" aria-hidden="true">
                          {selected ? "✓" : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="capture-wizard-action-row">
                <button type="button" className="secondary" onClick={() => setStep("ocr")}>
                  {t("captureWizard.hook.useOcrInstead")}
                </button>
                <button type="button" disabled={!selectedHook} onClick={acceptHook}>
                  {t("captureWizard.hook.useHook")}
                </button>
              </div>
            </section>
          ) : null}

          {step === "ocr" ? (
            <section className="capture-wizard-step-panel">
              <div className="capture-wizard-copy">
                <h3>{t("captureWizard.ocr.title")}</h3>
                <p>{t("captureWizard.ocr.description")}</p>
              </div>
              <ul className="capture-wizard-reasons">
                <li>{t("captureWizard.ocr.reasonStable")}</li>
                <li>{t("captureWizard.ocr.reasonNoise")}</li>
                <li>{t("captureWizard.ocr.reasonFallback")}</li>
              </ul>
              {statusMessage ? <div className="capture-wizard-note">{statusMessage}</div> : null}
              <div className="capture-wizard-action-row">
                <button type="button" onClick={openAreaSelector}>
                  {t("captureWizard.ocr.openAreaSelector")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    onNavigateTab?.("ocr");
                    void closeWizard();
                  }}
                >
                  {t("captureWizard.ocr.openOcrTab")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setTextSource("ocr");
                    setLaunchTextHook(false);
                    setOcrMode("manual");
                    setStep("profile");
                  }}
                >
                  {t("captureWizard.ocr.continue")}
                </button>
              </div>
            </section>
          ) : null}

          {step === "profile" ? (
            <section className="capture-wizard-step-panel">
              <div className="capture-wizard-copy">
                <h3>{t("captureWizard.profile.title")}</h3>
                <p>{t("captureWizard.profile.description")}</p>
              </div>
              <div className="capture-wizard-summary">
                <span>{t("captureWizard.profile.source")}</span>
                <strong>{sourceLabel}</strong>
              </div>
              <div className="capture-wizard-form">
                <label>
                  <input
                    type="checkbox"
                    checked={saveAutomation}
                    onChange={(event) => setSaveAutomation(event.target.checked)}
                  />
                  {t("captureWizard.profile.saveAutomation")}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={launchTextHook}
                    disabled={textSource === "ocr" || textSource === "none"}
                    onChange={(event) => setLaunchTextHook(event.target.checked)}
                  />
                  {t("captureWizard.profile.launchTextHook")}
                </label>
                <label htmlFor="capture-wizard-ocr-mode">{t("captureWizard.profile.ocrMode")}</label>
                <select
                  id="capture-wizard-ocr-mode"
                  value={ocrMode}
                  onChange={(event) => setOcrMode(event.target.value as SceneOcrMode)}
                >
                  <option value="none">{t("captureWizard.profile.ocrNone")}</option>
                  <option value="manual">{t("captureWizard.profile.ocrManual")}</option>
                  <option value="auto">{t("captureWizard.profile.ocrAuto")}</option>
                </select>
                <label>
                  <input
                    type="checkbox"
                    checked={launchOverlay}
                    onChange={(event) => setLaunchOverlay(event.target.checked)}
                  />
                  {t("captureWizard.profile.launchOverlay")}
                </label>
              </div>
              {statusMessage ? <div className="capture-wizard-note">{statusMessage}</div> : null}
              <div className="capture-wizard-action-row">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void invokeIpc("settings.openGSMSettings", { rootTabKey: "profiles" })}
                >
                  {t("captureWizard.profile.openProfiles")}
                </button>
                <button type="button" disabled={saving} onClick={() => void saveProfileChoices()}>
                  {saving ? t("captureWizard.profile.saving") : t("captureWizard.profile.save")}
                </button>
              </div>
            </section>
          ) : null}

          {step === "finish" ? (
            <section className="capture-wizard-step-panel">
              <div className="capture-wizard-copy">
                <h3>{t("captureWizard.finish.title")}</h3>
                <p>{t("captureWizard.finish.description")}</p>
              </div>
              <div className="capture-wizard-summary">
                <span>{t("captureWizard.profile.source")}</span>
                <strong>{sourceLabel}</strong>
              </div>
              <div className="capture-wizard-action-row">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    onNavigateTab?.("texthook");
                    void closeWizard();
                  }}
                >
                  {t("captureWizard.finish.openTextHook")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    onNavigateTab?.("launcher");
                    void closeWizard();
                  }}
                >
                  {t("captureWizard.finish.openAutomation")}
                </button>
              </div>
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
            <button type="button" className="secondary" disabled={isFirstStep} onClick={goBack}>
              {t("captureWizard.actions.back")}
            </button>
            {step !== "finish" ? (
              <button
                type="button"
                className="secondary"
                onClick={() => setStep(CAPTURE_WIZARD_STEPS[Math.min(stepIndex + 1, CAPTURE_WIZARD_STEPS.length - 1)].id)}
              >
                {t("captureWizard.actions.next")}
              </button>
            ) : (
              <button type="button" onClick={() => void closeWizard()}>
                {t("captureWizard.finish.done")}
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
