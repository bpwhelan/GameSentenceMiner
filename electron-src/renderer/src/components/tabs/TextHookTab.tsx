import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invokeIpc, onIpc } from "../../lib/ipc";
import { useTranslation } from "../../i18n";
import { AgentScriptSearchDialog } from "../AgentScriptSearchDialog";
import {
  buildAgentScriptCandidateList,
  getAgentScriptFileName,
  type AgentScriptCandidate,
} from "../../../../shared/agent_scripts";

type TextHookEngine = "luna" | "textractor" | "agent";

interface ListAgentScriptsResponse {
  status?: string;
  path?: string;
  scripts?: string[];
  message?: string;
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
  copyToClipboard?: boolean;
  agentScriptPath?: string;
  agentHasUi?: boolean;
}

interface RuntimeStatusStopped {
  running: false;
}

type RuntimeStatus = RuntimeStatusRunning | RuntimeStatusStopped;

interface ActiveCapture {
  sceneName: string;
  sceneId: string;
  exeName: string | null;
  error?: string;
}

interface SavedProfile {
  exeName: string;
  engine: TextHookEngine;
  autoHook: boolean;
  flushDelayMs?: number;
  hookId?: string | null;
  hookFunction?: string | null;
  manualHookCode?: string | null;
  agentScriptPath?: string | null;
  copyToClipboard?: boolean;
  lastUsed: number;
}

interface TextLine {
  ts: number;
  text: string;
  hookId: string;
}

interface LogLine {
  ts: number;
  level: "info" | "warn" | "error";
  message: string;
}

interface NoticeState {
  type: "info" | "success" | "error";
  message: string;
}

const MAX_LOG_LINES = 200;
const MAX_TEXT_LINES = 300;
const DEFAULT_FLUSH_DELAY_MS = 100;
const MAX_FLUSH_DELAY_MS = 5000;
const AGENT_RELEASES_URL = "https://github.com/0xDC00/agent/releases/latest";
const LUNA_TRANSLATOR_RELEASES_URL = "https://github.com/HIllya51/LunaTranslator/releases";
const TEXTRACTOR_RELEASES_URL = "https://github.com/Chenx221/Textractor/releases";

function hasHookText(hook: HookEntry): boolean {
  if (hook.preview.trim().length > 0) return true;
  return hook.samples.some((sample) => sample.trim().length > 0);
}

function normalizeFlushDelayMs(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_FLUSH_DELAY_MS;
  return Math.min(MAX_FLUSH_DELAY_MS, Math.max(0, Math.round(parsed)));
}

interface TextHookTabProps {
  active: boolean;
}

export function TextHookTab({ active }: TextHookTabProps) {
  const t = useTranslation();
  const [status, setStatus] = useState<RuntimeStatus>({ running: false });
  const [capture, setCapture] = useState<ActiveCapture | null>(null);
  const [hooks, setHooks] = useState<HookEntry[]>([]);
  const [selectedHookId, setSelectedHookId] = useState<string | null>(null);
  const [engine, setEngine] = useState<TextHookEngine>("luna");
  const [autoHook, setAutoHook] = useState(true);
  const [flushDelayMs, setFlushDelayMs] = useState(DEFAULT_FLUSH_DELAY_MS);
  const [flushDelayInput, setFlushDelayInput] = useState(String(DEFAULT_FLUSH_DELAY_MS));
  const [manualHookCode, setManualHookCode] = useState("");
  const [agentScriptPath, setAgentScriptPath] = useState("");
  const [agentScriptDialog, setAgentScriptDialog] = useState<{
    candidates: AgentScriptCandidate[];
    query: string;
  } | null>(null);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [textLines, setTextLines] = useState<TextLine[]>([]);
  const [savedProfile, setSavedProfile] = useState<SavedProfile | null>(null);
  const [copyToClipboard, setCopyToClipboard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textScrollRef = useRef<HTMLDivElement | null>(null);
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const statusRunningRef = useRef(false);
  const flushDelayInputFocusedRef = useRef(false);

  useEffect(() => {
    statusRunningRef.current = status.running;
  }, [status.running]);

  const syncFlushDelayState = useCallback((value: unknown, forceInput = false) => {
    const next = normalizeFlushDelayMs(value);
    setFlushDelayMs(next);
    if (forceInput || !flushDelayInputFocusedRef.current) {
      setFlushDelayInput(String(next));
    }
    return next;
  }, []);

  const showNotice = useCallback((message: string, type: NoticeState["type"] = "info") => {
    setNotice({ type, message });
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 5000);
  }, []);

  const refreshStatus = useCallback(async () => {
    const next = await invokeIpc<RuntimeStatus>("texthook.getStatus");
    setStatus(next);
    if (next.running) {
      setSelectedHookId(next.selectedHookId);
      setEngine(next.engine);
      syncFlushDelayState(next.flushDelayMs);
      setCopyToClipboard(next.copyToClipboard ?? false);
      if (next.engine === "agent" && next.agentScriptPath) {
        setAgentScriptPath(next.agentScriptPath);
      }
    }
  }, [syncFlushDelayState]);

  const refreshHooks = useCallback(async () => {
    const data = await invokeIpc<{ hooks: HookEntry[]; selectedHookId: string | null }>(
      "texthook.listHooks"
    );
    setHooks(data.hooks ?? []);
    setSelectedHookId(data.selectedHookId ?? null);
  }, []);

  const refreshActiveCapture = useCallback(async () => {
    const info = await invokeIpc<ActiveCapture>("texthook.getActiveCapture");
    setCapture(info);
    if (info?.exeName) {
      const profile = await invokeIpc<SavedProfile | null>(
        "texthook.getProfile",
        info.exeName
      );
      setSavedProfile(profile ?? null);
      if (profile && !statusRunningRef.current) {
        setEngine(profile.engine);
        setAutoHook(profile.autoHook);
        syncFlushDelayState(profile.flushDelayMs);
        setCopyToClipboard(profile.copyToClipboard ?? false);
        if (profile.manualHookCode) {
          setManualHookCode(profile.manualHookCode);
        }
        if (profile.agentScriptPath) {
          setAgentScriptPath(profile.agentScriptPath);
        }
      }
    } else {
      setSavedProfile(null);
      if (!statusRunningRef.current) {
        syncFlushDelayState(DEFAULT_FLUSH_DELAY_MS);
      }
    }
  }, [syncFlushDelayState]);

  // Auto-scroll text and log windows when content changes.
  useEffect(() => {
    if (textScrollRef.current) {
      textScrollRef.current.scrollTop = textScrollRef.current.scrollHeight;
    }
  }, [textLines]);
  useEffect(() => {
    if (logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
    }
  }, [logLines]);

  // Initial / on-active refresh.
  useEffect(() => {
    if (!active) return;
    void refreshStatus();
    void refreshHooks();
    void refreshActiveCapture();
  }, [active, refreshStatus, refreshHooks, refreshActiveCapture]);

  // IPC subscriptions.
  useEffect(() => {
    const offStatus = onIpc("texthook.status", () => {
      void refreshStatus();
    });
    const offHooks = onIpc("texthook.hooks", (_e, payload: any) => {
      if (payload && Array.isArray(payload.hooks)) {
        setHooks(payload.hooks as HookEntry[]);
      }
      if (payload && "selectedHookId" in payload) {
        setSelectedHookId(payload.selectedHookId ?? null);
      }
    });
    const offText = onIpc("texthook.text", (_e, payload: any) => {
      if (!payload || typeof payload.text !== "string") return;
      setTextLines((current) => {
        const next: TextLine[] = [
          ...current,
          {
            ts: typeof payload.ts === "number" ? payload.ts : Date.now(),
            text: payload.text,
            hookId: String(payload.hookId ?? ""),
          },
        ];
        if (next.length > MAX_TEXT_LINES) {
          next.splice(0, next.length - MAX_TEXT_LINES);
        }
        return next;
      });
    });
    const offLog = onIpc("texthook.log", (_e, payload: any) => {
      if (!payload || typeof payload.message !== "string") return;
      setLogLines((current) => {
        const next: LogLine[] = [
          ...current,
          {
            ts: typeof payload.ts === "number" ? payload.ts : Date.now(),
            level: payload.level === "warn" || payload.level === "error" ? payload.level : "info",
            message: payload.message,
          },
        ];
        if (next.length > MAX_LOG_LINES) {
          next.splice(0, next.length - MAX_LOG_LINES);
        }
        return next;
      });
    });
    return () => {
      offStatus();
      offHooks();
      offText();
      offLog();
    };
  }, [refreshStatus]);

  // Periodic capture refresh while tab is active.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      void refreshActiveCapture();
    }, 4000);
    return () => clearInterval(id);
  }, [active, refreshActiveCapture]);

  const startSession = useCallback(async () => {
    setBusy(true);
    try {
      const result = await invokeIpc<{ success: boolean; error?: string; pid?: number; exeName?: string }>(
        "texthook.start",
        {
          engine,
          exeName: capture?.exeName ?? undefined,
          flushDelayMs,
          copyToClipboard,
          agentScriptPath: engine === "agent" ? agentScriptPath.trim() : undefined,
        }
      );
      if (!result.success) {
        showNotice(result.error ?? t("texthook.errors.startFailed"), "error");
      } else {
        showNotice(
          t("texthook.notices.started", {
            exe: result.exeName ?? "",
            pid: String(result.pid ?? ""),
          }),
          "success"
        );
        setTextLines([]);
      }
      await refreshStatus();
      await refreshHooks();
    } finally {
      setBusy(false);
    }
  }, [agentScriptPath, capture?.exeName, copyToClipboard, engine, flushDelayMs, refreshHooks, refreshStatus, showNotice, t]);

  const stopSession = useCallback(async () => {
    setBusy(true);
    try {
      await invokeIpc("texthook.stop");
      await refreshStatus();
      await refreshHooks();
    } finally {
      setBusy(false);
    }
  }, [refreshHooks, refreshStatus]);

  const selectHook = useCallback(
    async (hookId: string) => {
      const ok = await invokeIpc<{ success: boolean }>("texthook.selectHook", hookId);
      if (ok?.success) {
        setSelectedHookId(hookId);
        setTextLines([]);
        showNotice(t("texthook.notices.selected", { id: hookId }), "success");
      }
    },
    [showNotice, t]
  );

  const attachManual = useCallback(async () => {
    if (!manualHookCode.trim()) return;
    const result = await invokeIpc<{ success: boolean; error?: string }>(
      "texthook.attachManualHook",
      manualHookCode.trim()
    );
    if (result?.success) {
      showNotice(t("texthook.notices.manualAttached"), "success");
    } else {
      showNotice(result?.error ?? t("texthook.errors.manualFailed"), "error");
    }
  }, [manualHookCode, showNotice, t]);

  const updateFlushDelay = useCallback(
    (value: string) => {
      setFlushDelayInput(value);
      if (value.trim() === "") return;
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return;
      const next = normalizeFlushDelayMs(parsed);
      setFlushDelayMs(next);
      if (status.running) {
        void invokeIpc("texthook.setFlushDelay", next);
      }
    },
    [status.running]
  );

  const commitFlushDelayInput = useCallback(() => {
    flushDelayInputFocusedRef.current = false;
    const next = syncFlushDelayState(flushDelayInput, true);
    if (status.running) {
      void invokeIpc("texthook.setFlushDelay", next);
    }
  }, [flushDelayInput, status.running, syncFlushDelayState]);

  const toggleCopyToClipboard = useCallback(
    (checked: boolean) => {
      setCopyToClipboard(checked);
      if (status.running) {
        void invokeIpc("texthook.setCopyToClipboard", checked);
      }
    },
    [status.running]
  );

  const saveProfile = useCallback(async () => {
    const exeName = status.running ? status.exeName : capture?.exeName;
    if (!exeName) {
      showNotice(t("texthook.errors.noExe"), "error");
      return;
    }
    const targetHook = hooks.find((h) => h.id === (selectedHookId ?? ""));
    const result = await invokeIpc<{ success: boolean; profile?: SavedProfile }>(
      "texthook.saveProfile",
      {
        exeName,
        engine,
        autoHook,
        flushDelayMs,
        copyToClipboard,
        hookId: selectedHookId,
        hookFunction: targetHook?.function ?? null,
        manualHookCode: manualHookCode.trim() || null,
        agentScriptPath: agentScriptPath.trim() || null,
      }
    );
    if (result?.success && result.profile) {
      setSavedProfile(result.profile);
      showNotice(t("texthook.notices.profileSaved"), "success");
    } else {
      showNotice(t("texthook.errors.profileSaveFailed"), "error");
    }
  }, [
    autoHook,
    capture?.exeName,
    copyToClipboard,
    engine,
    flushDelayMs,
    agentScriptPath,
    hooks,
    manualHookCode,
    selectedHookId,
    showNotice,
    status,
    t,
  ]);

  const deleteProfile = useCallback(async () => {
    if (!savedProfile) return;
    await invokeIpc("texthook.deleteProfile", savedProfile.exeName);
    setSavedProfile(null);
    showNotice(t("texthook.notices.profileDeleted"), "info");
  }, [savedProfile, showNotice, t]);

  const browseAgentScript = useCallback(async () => {
    const response = await invokeIpc<{ status?: string; path?: string }>(
      "settings.selectAgentScriptPath",
      { path: agentScriptPath }
    );
    if (response?.status === "success" && response.path) {
      setAgentScriptPath(response.path);
    }
  }, [agentScriptPath]);

  const openAgentScriptSearch = useCallback(async () => {
    const response = await invokeIpc<ListAgentScriptsResponse>("settings.listAgentScripts", {
      path: agentScriptPath,
    });
    const scripts = Array.isArray(response?.scripts) ? response.scripts : [];
    if (scripts.length === 0) {
      showNotice(response?.message ?? t("texthook.agent.noScripts"), "error");
      return;
    }
    const exeName = status.running ? status.exeName : capture?.exeName ?? "";
    const initialQuery = getAgentScriptFileName(agentScriptPath || exeName).replace(/\.[^/.]+$/u, "");
    const candidates = buildAgentScriptCandidateList({
      query: initialQuery,
      scripts,
    });
    setAgentScriptDialog({ candidates, query: initialQuery });
  }, [agentScriptPath, capture?.exeName, showNotice, status, t]);

  const pickAgentScriptCandidate = useCallback((scriptPath: string) => {
    setAgentScriptPath(scriptPath);
    setAgentScriptDialog(null);
  }, []);

  const showAgentScriptUi = useCallback(async () => {
    const result = await invokeIpc<{ success: boolean; error?: string }>("texthook.showAgentUi");
    if (!result?.success) {
      showNotice(result?.error ?? t("texthook.errors.agentUiFailed"), "error");
    }
  }, [showNotice, t]);

  const exeNameDisplay = status.running
    ? status.exeName
    : capture?.exeName ?? t("texthook.capture.unknown");
  const sceneDisplay = capture?.sceneName || t("texthook.capture.noScene");

  const visibleHooks = useMemo(
    () =>
      engine === "agent"
        ? hooks
        : hooks.filter((hook) => hook.id === selectedHookId || hasHookText(hook)),
    [engine, hooks, selectedHookId]
  );
  const startDisabled =
    busy || !capture?.exeName || (engine === "agent" && agentScriptPath.trim().length === 0);
  const searchHooksDisabled = status.running || startDisabled;
  const statusBadgeClass = status.running
    ? "ocr-area-badge--ok"
    : capture?.exeName
      ? "ocr-area-badge--ok"
      : "ocr-area-badge--empty";

  const statusBadgeText = status.running
    ? t("texthook.status.attached")
    : capture?.exeName
      ? t("texthook.status.ready")
      : t("texthook.status.noTarget");

  const footerState = status.running ? "running" : capture?.exeName ? "ready" : "warning";
  const openExternal = useCallback((url: string) => void invokeIpc("open-external-link", url), []);

  const engineDisplayName =
    engine === "luna"
      ? t("texthook.engine.luna")
      : engine === "textractor"
        ? t("texthook.engine.textractor")
        : t("texthook.engine.agent");

  return (
    <div className={`tab-panel ${active ? "active" : ""}`}>
      <div className="modern-tab texthook-workspace">
        {notice ? (
          <div className={`ocr-toast ocr-toast--${notice.type}`} role="status" aria-live="polite">
            <span>{notice.message}</span>
          </div>
        ) : null}

        <section
          className="card legacy-card ocr-card texthook-experimental-card"
          aria-labelledby="texthook-experimental-title"
        >
          <div className="texthook-experimental-icon" aria-hidden="true">
            !
          </div>
          <div>
            <h2 id="texthook-experimental-title">{t("texthook.experimental.title")}</h2>
            <p>{t("texthook.experimental.description")}</p>
          </div>
        </section>

        <div className="ocr-dashboard">
          {/* ── Left column: guided configuration stepper ── */}
          <div className="ocr-col ocr-col--settings">
            <div className="texthook-stepper">
              {/* ─── Step 1: Target ─── */}
              <div
                className={`texthook-step ${capture?.exeName ? "texthook-step--complete" : ""}`}
              >
                <div className="texthook-step-indicator">
                  <span className="texthook-step-number">
                    {capture?.exeName ? "✓" : "1"}
                  </span>
                  <div className="texthook-step-line" />
                </div>
                <div className="texthook-step-content">
                  <section className="card legacy-card ocr-card texthook-capture-card">
                    <div className="ocr-card-header-row">
                      <div>
                        <h2>{t("texthook.capture.title")}</h2>
                        <p className="texthook-step-desc">
                          {t("texthook.steps.targetDesc")}
                        </p>
                      </div>
                      <span className={`ocr-area-badge ${statusBadgeClass}`}>
                        {statusBadgeText}
                      </span>
                    </div>
                    <div className="form-group ocr-form-group">
                      <div className="input-group">
                        <label>{t("texthook.capture.scene")}</label>
                        <span>{sceneDisplay}</span>
                      </div>
                      <div className="input-group">
                        <label>{t("texthook.capture.executable")}</label>
                        <span>{exeNameDisplay}</span>
                      </div>
                      {status.running ? (
                        <div className="input-group">
                          <label>{t("texthook.capture.pid")}</label>
                          <span>
                            {status.pid} ({status.arch})
                          </span>
                        </div>
                      ) : null}
                      <div className="link-row">
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            void refreshActiveCapture();
                          }}
                        >
                          {t("texthook.capture.refresh")}
                        </button>
                      </div>
                    </div>
                  </section>
                </div>
              </div>

              {/* ─── Step 2: Engine & Configuration ─── */}
              <div
                className={`texthook-step ${
                  status.running
                    ? "texthook-step--complete"
                    : capture?.exeName
                      ? "texthook-step--active"
                      : ""
                }`}
              >
                <div className="texthook-step-indicator">
                  <span className="texthook-step-number">
                    {status.running ? "✓" : "2"}
                  </span>
                  <div className="texthook-step-line" />
                </div>
                <div className="texthook-step-content">
                  <section className="card legacy-card ocr-card">
                    <div className="ocr-card-header-row">
                      <div>
                        <h2>{t("texthook.steps.engineConfig")}</h2>
                        <p className="texthook-step-desc">
                          {t("texthook.steps.engineDesc")}
                        </p>
                      </div>
                    </div>
                    <div className="form-group ocr-form-group">
                      <div className="input-group">
                        <label htmlFor="texthook-engine-select">
                          {t("texthook.engine.label")}
                        </label>
                        <select
                          id="texthook-engine-select"
                          value={engine}
                          onChange={(e) => setEngine(e.target.value as TextHookEngine)}
                          disabled={status.running}
                        >
                          <option value="luna">{t("texthook.engine.luna")}</option>
                          <option value="textractor">{t("texthook.engine.textractor")}</option>
                          <option value="agent">{t("texthook.engine.agent")}</option>
                        </select>
                      </div>

                      {/* Agent-specific configuration */}
                      {engine === "agent" ? (
                        <div className="texthook-subsection">
                          <div className="texthook-subsection-label">
                            {t("texthook.agent.title")}
                          </div>
                          <div className="input-group">
                            <label htmlFor="texthook-agent-script-input">
                              {t("texthook.agent.scriptPath")}
                            </label>
                            <input
                              id="texthook-agent-script-input"
                              type="text"
                              value={agentScriptPath}
                              disabled={status.running}
                              placeholder={t("texthook.agent.scriptPlaceholder")}
                              onChange={(e) => setAgentScriptPath(e.target.value)}
                            />
                          </div>
                          <div className="link-row">
                            <button
                              type="button"
                              className="secondary"
                              disabled={status.running}
                              onClick={() => void openAgentScriptSearch()}
                            >
                              {t("texthook.agent.search")}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              disabled={status.running}
                              onClick={() => void browseAgentScript()}
                            >
                              {t("texthook.agent.browse")}
                            </button>
                            {status.running &&
                            status.engine === "agent" &&
                            status.agentHasUi ? (
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => void showAgentScriptUi()}
                              >
                                {t("texthook.agent.showScriptUi")}
                              </button>
                            ) : null}
                          </div>
                        </div>
                      ) : null}

                      {/* Manual hook code (Luna / Textractor only) */}
                      {engine !== "agent" ? (
                        <>
                          <div className="link-row texthook-hook-search-row">
                            <button
                              type="button"
                              disabled={searchHooksDisabled}
                              onClick={() => void startSession()}
                            >
                              {t("texthook.actions.searchHooks")}
                            </button>
                          </div>

                          <div className="texthook-subsection">
                            <div className="texthook-subsection-label">
                              {t("texthook.steps.manualHookLabel")}
                            </div>
                            <div className="input-group">
                              <label
                                htmlFor="texthook-manual-input"
                                title={t("texthook.profile.manualHookHint")}
                              >
                                {t("texthook.profile.manualHook")}
                              </label>
                              <input
                                id="texthook-manual-input"
                                type="text"
                                value={manualHookCode}
                                placeholder="HB4@0"
                                onChange={(e) => setManualHookCode(e.target.value)}
                              />
                            </div>
                            <div className="link-row">
                              <button
                                type="button"
                                disabled={
                                  !status.running || !manualHookCode.trim()
                                }
                                onClick={() => void attachManual()}
                              >
                                {t("texthook.profile.attachManual")}
                              </button>
                            </div>
                          </div>
                        </>
                      ) : null}
                    </div>
                  </section>
                </div>
              </div>

              {/* ─── Step 3: Options & Profile ─── */}
              <div
                className={`texthook-step ${savedProfile ? "texthook-step--complete" : ""}`}
              >
                <div className="texthook-step-indicator">
                  <span className="texthook-step-number">3</span>
                </div>
                <div className="texthook-step-content">
                  <section className="card legacy-card ocr-card">
                    <div className="ocr-card-header-row">
                      <div>
                        <h2>{t("texthook.steps.options")}</h2>
                        <p className="texthook-step-desc">
                          {t("texthook.steps.optionsDesc")}
                        </p>
                      </div>
                      {savedProfile ? (
                        <span className="ocr-area-badge ocr-area-badge--ok">
                          {t("texthook.profile.saved")}
                        </span>
                      ) : null}
                    </div>
                    <div className="form-group ocr-form-group">
                      <div className="input-group">
                        <label>
                          <input
                            type="checkbox"
                            checked={autoHook}
                            onChange={(e) => setAutoHook(e.target.checked)}
                          />{" "}
                          {t("texthook.profile.autoHook")}
                        </label>
                      </div>
                      <div className="input-group">
                        <label>
                          <input
                            type="checkbox"
                            checked={copyToClipboard}
                            onChange={(e) => toggleCopyToClipboard(e.target.checked)}
                          />{" "}
                          {t("texthook.profile.copyToClipboard")}
                        </label>
                      </div>
                      <div className="input-group">
                        <label htmlFor="texthook-flush-delay-input">
                          {t("texthook.profile.flushDelay")}
                        </label>
                        <input
                          id="texthook-flush-delay-input"
                          type="number"
                          min="0"
                          max={String(MAX_FLUSH_DELAY_MS)}
                          step="10"
                          value={flushDelayInput}
                          onChange={(e) => updateFlushDelay(e.target.value)}
                          onFocus={() => {
                            flushDelayInputFocusedRef.current = true;
                          }}
                          onBlur={commitFlushDelayInput}
                        />
                      </div>
                      <div className="link-row">
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => void saveProfile()}
                        >
                          {t("texthook.profile.save")}
                        </button>
                        <button
                          type="button"
                          className="danger"
                          disabled={!savedProfile}
                          onClick={() => void deleteProfile()}
                        >
                          {t("texthook.profile.delete")}
                        </button>
                      </div>
                    </div>
                  </section>
                </div>
              </div>
            </div>
          </div>

          {/* ── Right column: hooks, output, log ── */}
          <div className="ocr-col ocr-col--workspace">
            <section className="card legacy-card ocr-card texthook-hook-list">
              <div className="ocr-card-header-row">
                <div>
                  <h2>{t("texthook.hooks.title")}</h2>
                  <p className="texthook-card-hint">{t("texthook.hooks.selectHint")}</p>
                </div>
                <div className="texthook-hook-summary">
                  {selectedHookId ? (
                    <span className="ocr-area-badge ocr-area-badge--ok">
                      {t("texthook.hooks.selected", { id: selectedHookId })}
                    </span>
                  ) : null}
                  <span className="ocr-area-badge ocr-area-badge--ok">
                    {t("texthook.hooks.count", { count: String(visibleHooks.length) })}
                  </span>
                </div>
              </div>
              <div className="texthook-hooks">
                {visibleHooks.length === 0 ? (
                  <div className="texthook-empty">
                    {status.running
                      ? t("texthook.hooks.waiting")
                      : t("texthook.hooks.notRunning")}
                  </div>
                ) : (
                  <ul className="texthook-hook-rows">
                    {visibleHooks.map((hook) => {
                      const isSelected = hook.id === selectedHookId;
                      return (
                        <li
                          key={hook.id}
                          className={`texthook-hook-row ${isSelected ? "selected" : ""}`}
                        >
                          <button
                            type="button"
                            className="texthook-hook-button"
                            onClick={() => void selectHook(hook.id)}
                            title={hook.preview || ""}
                            aria-pressed={isSelected}
                            aria-label={t("texthook.hooks.rowLabel", {
                              id: hook.id,
                              name: hook.function,
                            })}
                          >
                            <span className="texthook-hook-id">#{hook.id}</span>
                            <span className="texthook-hook-fn">{hook.function}</span>
                            <span className="texthook-hook-preview">
                              {hook.preview || t("texthook.hooks.noTextYet")}
                            </span>
                            <span className="texthook-hook-radio" aria-hidden="true">
                              <span className="texthook-hook-radio-dot" />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>

            <section className="card legacy-card ocr-card">
              <div className="ocr-card-header-row">
                <h2>{t("texthook.output.title")}</h2>
              </div>
              <div className="texthook-output" ref={textScrollRef}>
                {textLines.length > 0 ? (
                  <ul className="texthook-output-list">
                    {textLines.map((line, idx) => (
                      <li
                        key={`${line.ts}-${line.hookId}-${idx}`}
                        className="texthook-output-line"
                      >
                        <pre className="texthook-output-pre">{line.text}</pre>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="texthook-empty">
                    {selectedHookId
                      ? t("texthook.output.waiting")
                      : t("texthook.output.selectHook")}
                  </div>
                )}
              </div>
            </section>

            <section className="card legacy-card ocr-card">
              <div className="ocr-card-header-row">
                <h2>{t("texthook.log.title")}</h2>
              </div>
              <div className="texthook-log" ref={logScrollRef}>
                {logLines.length === 0 ? (
                  <div className="texthook-empty">{t("texthook.log.empty")}</div>
                ) : (
                  <ul className="texthook-log-list">
                    {logLines.map((line, idx) => (
                      <li
                        key={`${line.ts}-${idx}`}
                        className={`texthook-log-line texthook-log-line--${line.level}`}
                      >
                        {line.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>
        </div>

        {/* ── Sticky footer: status + primary action ── */}
        <div
          className={`ocr-sticky-footer texthook-sticky-footer texthook-sticky-footer--${footerState}`}
        >
          <div className="ocr-sticky-footer-status">
            <span className={`ocr-area-badge ${statusBadgeClass}`}>{statusBadgeText}</span>
            <div className="ocr-sticky-footer-copy">
              <strong>{exeNameDisplay}</strong>
              <p>
                {sceneDisplay} &bull; {engineDisplayName}
              </p>
            </div>
          </div>
          <div className="ocr-sticky-footer-actions">
            {status.running ? (
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void stopSession()}
              >
                {t("texthook.actions.stop")}
              </button>
            ) : (
              <button
                type="button"
                disabled={startDisabled}
                onClick={() => void startSession()}
              >
                {t("texthook.actions.start")}
              </button>
            )}
          </div>
        </div>

        <footer className="home-support texthook-credits">
          <span className="texthook-credits__mark" aria-hidden="true">!</span>
          <span className="home-support__text">{t("texthook.credits.text")}</span>
          <a
            href={AGENT_RELEASES_URL}
            className="home-support__link"
            onClick={(e) => {
              e.preventDefault();
              openExternal(AGENT_RELEASES_URL);
            }}
          >
            {t("texthook.credits.agent")}
          </a>
          <a
            href={TEXTRACTOR_RELEASES_URL}
            className="home-support__link"
            onClick={(e) => {
              e.preventDefault();
              openExternal(TEXTRACTOR_RELEASES_URL);
            }}
          >
            {t("texthook.credits.textractor")}
          </a>
          <a
            href={LUNA_TRANSLATOR_RELEASES_URL}
            className="home-support__link"
            onClick={(e) => {
              e.preventDefault();
              openExternal(LUNA_TRANSLATOR_RELEASES_URL);
            }}
          >
            {t("texthook.credits.luna")}
          </a>
        </footer>

        {/* ── Agent script picker modal ── */}
        {agentScriptDialog ? (
          <AgentScriptSearchDialog
            candidates={agentScriptDialog.candidates}
            query={agentScriptDialog.query}
            title={t("texthook.agent.pickerTitle")}
            closeLabel={t("texthook.agent.pickerClose")}
            searchPlaceholder={t("texthook.agent.searchPlaceholder")}
            noResultsLabel={t("texthook.agent.pickerNoResults")}
            onClose={() => setAgentScriptDialog(null)}
            onQueryChange={(query) =>
              setAgentScriptDialog((current) =>
                current ? { ...current, query } : current
              )
            }
            onSelect={pickAgentScriptCandidate}
            getCandidateMeta={() => t("texthook.agent.scriptCandidate")}
          />
        ) : null}
      </div>
    </div>
  );
}

export default TextHookTab;
