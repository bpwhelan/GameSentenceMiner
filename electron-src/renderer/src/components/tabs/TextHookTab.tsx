import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import "./TextHookTab.css";
import { invokeIpc, onIpc } from "../../lib/ipc";
import { useLocale, useTranslation } from "../../i18n";
import { AgentScriptSearchDialog } from "../AgentScriptSearchDialog";
import type { EngineUpdateState } from "../../../../shared/texthook_updates";
import { createHookRanker, type HookQualityReason } from "../../../../shared/texthook_quality";
import {
  buildAgentScriptCandidateList,
  type AgentScriptCandidate,
} from "../../../../shared/agent_scripts";

type TextHookEngine = "luna" | "textractor" | "agent" | "mages";

interface ListAgentScriptsResponse {
  status?: string;
  path?: string;
  scripts?: string[];
  message?: string;
}

interface ResolveAgentScriptResponse {
  status?: string;
  path?: string;
  reason?: string;
  candidates?: AgentScriptCandidate[];
}

interface HookEntry {
  id: string;
  function: string;
  preview: string;
  samples: string[];
}

/**
 * A support package from the built-in engine-hook catalog. An entry is a single
 * game build or a whole engine, depending on what the package identifies its
 * target by; `details` is the package's own locale map.
 */
interface BuiltInHookTarget {
  id: string;
  name: string;
  details: Record<string, string>;
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
  agentDetached?: boolean;
  sessionId?: string;
  agentPhase?: "starting" | "waiting" | "receiving";
}

interface RuntimeStatusStopped {
  running: false;
}

type RuntimeStatus = RuntimeStatusRunning | RuntimeStatusStopped;

interface ActiveCapture {
  sceneName: string;
  sceneId: string;
  exeName: string | null;
  windowTitle?: string | null;
  pid?: number | null;
  arch?: "x86" | "x64" | null;
  error?: string;
}

interface SavedProfile {
  sceneId?: string;
  exeName: string;
  engine: TextHookEngine;
  autoHook: boolean;
  flushDelayMs?: number;
  hookId?: string | null;
  hookFunction?: string | null;
  manualHookCode?: string | null;
  agentScriptPath?: string | null;
  agentDetached?: boolean;
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
const DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE = 3000;
const MAX_TEXT_HOOK_MAX_BUFFER_SIZE = 100_000;
const AGENT_PHASE_LABEL_KEYS = {
  starting: "texthook.status.starting",
  waiting: "texthook.status.waitingForText",
  receiving: "texthook.status.receiving",
} as const;
const MAX_JAPANESE_QUOTE_PAIRS = 10;
// Set to true when the large-payload test button is needed during development.
const SHOW_DEV_LARGE_PAYLOAD_TEST = false;
const DEV_LARGE_PAYLOAD_LENGTH = 120_000;
const DEV_JAPANESE_PAYLOAD_FRAGMENTS = [
  "これはテキストフックの負荷試験用ランダム文字列です。",
  "静かな夜の街を歩きながら、遠くの灯りを眺めていた。",
  "同じ文章が何度も現れても、これは開発中の確認データです。",
  "風がページをめくり、時計の音だけが部屋に響いている。",
  "ゲームから受け取った長い文章を安全に処理できるか確認します。",
];
const AGENT_RELEASES_URL = "https://github.com/0xDC00/agent/releases/latest";
const LUNA_TRANSLATOR_RELEASES_URL = "https://github.com/HIllya51/LunaTranslator/releases";
const TEXTRACTOR_RELEASES_URL = "https://github.com/Chenx221/Textractor/releases";

const HOOK_QUALITY_LABEL_KEYS: Record<HookQualityReason, string> = {
  targetLanguage: "texthook.hooks.quality.targetLanguage",
  possibleLanguage: "texthook.hooks.quality.possibleLanguage",
  readable: "texthook.hooks.quality.readable",
  mixed: "texthook.hooks.quality.mixed",
  paths: "texthook.hooks.quality.paths",
  garbled: "texthook.hooks.quality.garbled",
  repetitive: "texthook.hooks.quality.repetitive",
  symbols: "texthook.hooks.quality.symbols",
  noText: "texthook.hooks.noTextYet",
};

function normalizeFlushDelayMs(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_FLUSH_DELAY_MS;
  return Math.min(MAX_FLUSH_DELAY_MS, Math.max(0, Math.round(parsed)));
}

function normalizeTextHookMaxBufferSize(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE;
  return Math.min(MAX_TEXT_HOOK_MAX_BUFFER_SIZE, Math.round(parsed));
}

function sanitizeTextHookText(text: string, maxBufferSize: number): string | null {
  let openingQuotes = 0;
  let closingQuotes = 0;
  for (const character of text) {
    if (character === "「") openingQuotes += 1;
    if (character === "」") closingQuotes += 1;
    if (openingQuotes > MAX_JAPANESE_QUOTE_PAIRS && closingQuotes > MAX_JAPANESE_QUOTE_PAIRS) {
      return null;
    }
  }
  return text.slice(0, normalizeTextHookMaxBufferSize(maxBufferSize));
}

function createDevJapanesePayload(length: number): string {
  let payload = "";
  while (payload.length < length) {
    const fragment =
      DEV_JAPANESE_PAYLOAD_FRAGMENTS[
        Math.floor(Math.random() * DEV_JAPANESE_PAYLOAD_FRAGMENTS.length)
      ];
    payload += fragment;
  }
  return payload.slice(0, length);
}

type HookWorkspaceView = "live" | "output" | "tools";

const HOOK_WORKSPACE_VIEWS = [
  { id: "live", labelKey: "texthook.workspace.live" },
  { id: "output", labelKey: "texthook.workspace.output" },
  { id: "tools", labelKey: "texthook.workspace.tools" },
] as const;

function HookWorkspaceIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    live: "M4 4h16v12H8l-4 4V4Zm4 4h8M8 12h5",
    output: "M4 7h10m4 0h2M4 17h2m4 0h10M14 4v6M10 14v6",
    tools: "M14 5a5 5 0 0 0-6 6L3 16l5 5 5-5a5 5 0 0 0 6-6l-4 3-4-4 3-4Z",
    log: "m5 6 5 5-5 5m8 0h6",
    close: "m6 6 12 12M6 18 18 6",
    refresh: "M20 7v5h-5M4 17v-5h5m-4-4a8 8 0 0 1 13-3l2 2M4 17l2 2a8 8 0 0 0 13-3",
    play: "m8 4 12 8-12 8V4Z",
    stop: "M6 6h12v12H6z",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.live} />
    </svg>
  );
}

interface TextHookTabProps {
  active: boolean;
  onNavigateTab?: (tab: "textprocessing") => void;
}

export function TextHookTab({ active, onNavigateTab }: TextHookTabProps) {
  const t = useTranslation();
  const [locale] = useLocale();
  const [workspaceView, setWorkspaceView] = useState<HookWorkspaceView>("live");
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [status, setStatus] = useState<RuntimeStatus>({ running: false });
  const [capture, setCapture] = useState<ActiveCapture | null>(null);
  const [hooks, setHooks] = useState<HookEntry[]>([]);
  const [targetLanguage, setTargetLanguage] = useState("");
  const [showLikelyNoise, setShowLikelyNoise] = useState(false);
  const rankHookCandidates = useMemo(() => createHookRanker(), []);
  const [selectedHookId, setSelectedHookId] = useState<string | null>(null);
  const [engine, setEngine] = useState<TextHookEngine>("luna");
  const [builtInHookTargets, setBuiltInHookTargets] = useState<BuiltInHookTarget[]>([]);
  const [autoHook, setAutoHook] = useState(true);
  const [flushDelayMs, setFlushDelayMs] = useState(DEFAULT_FLUSH_DELAY_MS);
  const [flushDelayInput, setFlushDelayInput] = useState(String(DEFAULT_FLUSH_DELAY_MS));
  const [maxBufferSize, setMaxBufferSize] = useState(DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE);
  const [maxBufferSizeInput, setMaxBufferSizeInput] = useState(
    String(DEFAULT_TEXT_HOOK_MAX_BUFFER_SIZE),
  );
  const [manualHookCode, setManualHookCode] = useState("");
  const [agentScriptPath, setAgentScriptPath] = useState("");
  const [agentDetached, setAgentDetached] = useState(true);
  const [agentScriptDialog, setAgentScriptDialog] = useState<{
    candidates: AgentScriptCandidate[];
    query: string;
  } | null>(null);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [textLines, setTextLines] = useState<TextLine[]>([]);
  const [savedProfile, setSavedProfile] = useState<SavedProfile | null>(null);
  const [copyToClipboard, setCopyToClipboard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [engineActionNotice, setEngineActionNotice] = useState<NoticeState | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineUpdateState | null>(null);
  const [selectedEngineVersion, setSelectedEngineVersion] = useState("");
  const engineVersions = engineStatus?.availableVersions ?? [];
  const engineVersionChoice = selectedEngineVersion ||
    (engineVersions.some(({ version }) => version === engineStatus?.version)
      ? engineStatus?.version : engineStatus?.remoteVersion) || "";
  const selectedEnginePackage = engineVersions.find(({ version }) => version === engineVersionChoice);
  const [checkingEngines, setCheckingEngines] = useState(false);
  const [engineCheckFailed, setEngineCheckFailed] = useState(false);
  const [updatingEngines, setUpdatingEngines] = useState(false);
  const [preparingCapture, setPreparingCapture] = useState(false);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const engineStatusRequestRef = useRef(0);
  const updatingEnginesRef = useRef(false);
  const textScrollRef = useRef<HTMLDivElement | null>(null);
  const logScrollRef = useRef<HTMLDivElement | null>(null);
  const statusRunningRef = useRef(false);
  const statusRequestRef = useRef(0);
  const activeSessionKeyRef = useRef<string | null>(null);
  const activeAgentSessionIdRef = useRef<string | null>(null);
  const startCancelledRef = useRef(false);
  const flushDelayInputFocusedRef = useRef(false);
  const maxBufferSizeInputFocusedRef = useRef(false);
  const lastAppliedProfileKeyRef = useRef<string | null>(null);

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

  const syncMaxBufferSizeState = useCallback((value: unknown, forceInput = false) => {
    const next = normalizeTextHookMaxBufferSize(value);
    setMaxBufferSize(next);
    if (forceInput || !maxBufferSizeInputFocusedRef.current) {
      setMaxBufferSizeInput(String(next));
    }
    return next;
  }, []);

  const refreshTextHookSettings = useCallback(async () => {
    const settings = await invokeIpc<{ maxBufferSize?: number; targetLanguage?: string }>(
      "texthook.getSettings",
    );
    syncMaxBufferSizeState(settings?.maxBufferSize);
    setTargetLanguage(settings?.targetLanguage ?? "");
  }, [syncMaxBufferSizeState]);

  const showNotice = useCallback((message: string, type: NoticeState["type"] = "info") => {
    setNotice({ type, message });
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 5000);
  }, []);

  const refreshEngineStatus = useCallback(async (checkForUpdates = false) => {
    const request = ++engineStatusRequestRef.current;
    setCheckingEngines(true);
    setEngineCheckFailed(false);
    try {
      const next = await invokeIpc<EngineUpdateState | null>(
        checkForUpdates ? "texthook.checkEngineUpdates" : "texthook.getEngineStatus",
      );
      if (request !== engineStatusRequestRef.current) return;
      if (next) setEngineStatus(next);
      setEngineCheckFailed(!next);
    } catch {
      if (request === engineStatusRequestRef.current) setEngineCheckFailed(true);
    } finally {
      if (request === engineStatusRequestRef.current) setCheckingEngines(false);
    }
  }, []);

  const downloadEngines = useCallback(async (version?: string) => {
    if (busy || preparingCapture || updatingEnginesRef.current) return;
    updatingEnginesRef.current = true;
    setUpdatingEngines(true);
    setEngineActionNotice(null);
    try {
      const result = version
        ? await invokeIpc<{ success: boolean; deferred?: boolean; error?: string }>("texthook.installEngineVersion", version)
        : await invokeIpc<{ success: boolean; deferred?: boolean; error?: string }>("texthook.downloadEngines");
      if (!result?.success) {
        setEngineActionNotice({
          message: result?.error ?? t("texthook.updates.downloadFailed"),
          type: "error",
        });
      } else if (!result.deferred) {
        setEngineActionNotice({ message: t("texthook.updates.ready"), type: "success" });
      }
    } catch (error) {
      setEngineActionNotice({
        message: error instanceof Error ? error.message : t("texthook.updates.downloadFailed"),
        type: "error",
      });
    } finally {
      updatingEnginesRef.current = false;
      setUpdatingEngines(false);
      void refreshEngineStatus();
    }
  }, [busy, preparingCapture, refreshEngineStatus, t]);

  const setAutomaticEngineUpdates = useCallback(
    async (enabled: boolean) => {
      try {
        const next = await invokeIpc<EngineUpdateState>(
          "texthook.setAutomaticEngineUpdates",
          enabled,
        );
        if (next) setEngineStatus(next);
      } catch {
        setEngineActionNotice({ message: t("texthook.updates.preferenceFailed"), type: "error" });
      }
    },
    [t],
  );

  const applyRuntimeStatus = useCallback((next: RuntimeStatus) => {
    statusRunningRef.current = next.running;
    setStatus(next);
    if (next.running) {
      const sessionKey = next.sessionId ?? JSON.stringify([next.engine, next.pid, next.agentScriptPath]);
      if (activeSessionKeyRef.current !== sessionKey) {
        setTextLines([]);
      }
      activeSessionKeyRef.current = sessionKey;
      activeAgentSessionIdRef.current = next.sessionId ?? null;
      setSelectedHookId(next.selectedHookId);
      setEngine(next.engine);
      syncFlushDelayState(next.flushDelayMs);
      setCopyToClipboard(next.copyToClipboard ?? false);
      if (next.engine === "agent" && next.agentScriptPath) {
        setAgentScriptPath(next.agentScriptPath);
      }
      if (next.engine === "agent") {
        setAgentDetached(next.agentDetached !== false);
      }
    } else {
      activeSessionKeyRef.current = null;
      activeAgentSessionIdRef.current = null;
    }
  }, [syncFlushDelayState]);

  const refreshStatus = useCallback(async () => {
    const request = ++statusRequestRef.current;
    const next = await invokeIpc<RuntimeStatus>("texthook.getStatus");
    if (request === statusRequestRef.current) applyRuntimeStatus(next);
  }, [applyRuntimeStatus]);

  const refreshHooks = useCallback(async () => {
    const data = await invokeIpc<{ hooks: HookEntry[]; selectedHookId: string | null }>(
      "texthook.listHooks",
    );
    setHooks(data.hooks ?? []);
    setSelectedHookId(data.selectedHookId ?? null);
  }, []);

  const refreshActiveCapture = useCallback(async () => {
    const info = await invokeIpc<ActiveCapture>("texthook.getActiveCapture");
    setCapture(info);
    if (info?.exeName) {
      const profile = await invokeIpc<SavedProfile | null>("texthook.getProfile", {
        exeName: info.exeName,
        sceneId: info.sceneId,
      });
      setSavedProfile(profile ?? null);
      if (!statusRunningRef.current && info.sceneId !== lastAppliedProfileKeyRef.current) {
        lastAppliedProfileKeyRef.current = info.sceneId;
        if (profile) {
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
        setAgentDetached(profile?.engine === "agent" ? profile.agentDetached !== false : true);
      }
    } else {
      setSavedProfile(null);
      lastAppliedProfileKeyRef.current = null;
      if (!statusRunningRef.current) {
        syncFlushDelayState(DEFAULT_FLUSH_DELAY_MS);
        setAgentDetached(true);
      }
    }
  }, [syncFlushDelayState]);

  // Auto-scroll text and log windows when content changes.
  useEffect(() => {
    if (textScrollRef.current) {
      textScrollRef.current.scrollTop = textScrollRef.current.scrollHeight;
    }
  }, [textLines, workspaceView, consoleOpen, active]);
  useEffect(() => {
    if (logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
    }
  }, [logLines, consoleOpen, active]);

  // Initial / on-active refresh.
  useEffect(() => {
    if (!active) return;
    void refreshStatus();
    void refreshHooks();
    void refreshActiveCapture();
    void refreshTextHookSettings();
  }, [active, refreshStatus, refreshHooks, refreshActiveCapture, refreshTextHookSettings]);

  useEffect(() => {
    if (active) void refreshEngineStatus();
  }, [active, refreshEngineStatus]);

  // The supported-target list is the on-disk support catalog, so it is read from
  // the main process rather than duplicated in the renderer.
  useEffect(() => {
    if (!active || engine !== "mages") return;
    let cancelled = false;
    void (async () => {
      try {
        const targets = await invokeIpc<BuiltInHookTarget[]>("texthook.builtInHookTargets");
        if (!cancelled && Array.isArray(targets)) setBuiltInHookTargets(targets);
      } catch {
        if (!cancelled) setBuiltInHookTargets([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, engine]);

  // IPC subscriptions.
  useEffect(() => {
    const offStatus = onIpc("texthook.status", (_e, payload: any) => {
      if (payload && typeof payload.running === "boolean" &&
          (!payload.running || (typeof payload.engine === "string" && typeof payload.pid === "number"))) {
        // Apply session boundaries before any following text events. A status
        // request already in flight must not replace this newer snapshot.
        ++statusRequestRef.current;
        applyRuntimeStatus(payload as RuntimeStatus);
      } else void refreshStatus();
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
      if (typeof payload.sessionId === "string" && payload.sessionId !== activeAgentSessionIdRef.current) return;
      const text = sanitizeTextHookText(payload.text, maxBufferSize);
      if (text === null) return;
      setTextLines((current) => {
        const next: TextLine[] = [
          ...current,
          {
            ts: typeof payload.ts === "number" ? payload.ts : Date.now(),
            text,
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
    const offAgentError = onIpc("texthook.agentError", (_e, payload: any) => {
      if (!payload || typeof payload.error !== "string") return;
      if (payload.sessionId && activeAgentSessionIdRef.current && payload.sessionId !== activeAgentSessionIdRef.current) return;
      showNotice(payload.error, "error");
      setConsoleOpen(true);
    });
    const offDownloadStarted = onIpc("texthook.engineDownloadStarted", () => {
      setPreparingCapture(true);
    });
    const offDownloadComplete = onIpc("texthook.engineDownloadComplete", () => {
      setPreparingCapture(false);
      if (!updatingEnginesRef.current) void refreshEngineStatus();
    });
    const offEngineUpdate = onIpc("texthook.engineUpdateState", (_event, payload) => {
      if (!payload || typeof payload !== "object") return;
      engineStatusRequestRef.current += 1;
      setEngineStatus(payload as EngineUpdateState);
      setEngineCheckFailed(false);
      setCheckingEngines(false);
    });
    return () => {
      offStatus();
      offHooks();
      offText();
      offLog();
      offAgentError();
      offDownloadStarted();
      offDownloadComplete();
      offEngineUpdate();
    };
  }, [maxBufferSize, applyRuntimeStatus, refreshStatus, refreshEngineStatus, showNotice]);

  // Periodic capture refresh while tab is active.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      void refreshActiveCapture();
      void refreshTextHookSettings();
    }, 4000);
    return () => clearInterval(id);
  }, [active, refreshActiveCapture, refreshTextHookSettings]);

  const startSession = useCallback(async () => {
    startCancelledRef.current = false;
    setBusy(true);
    try {
      const result = await invokeIpc<{
        success: boolean;
        error?: string;
        pid?: number;
        exeName?: string;
      }>("texthook.start", {
        engine,
        exeName: capture?.exeName ?? undefined,
        sceneId: capture?.sceneId ?? undefined,
        flushDelayMs,
        copyToClipboard,
        agentScriptPath: engine === "agent" ? agentScriptPath.trim() : undefined,
        agentDetached: engine === "agent" ? agentDetached : undefined,
      });
      if (startCancelledRef.current) return;
      if (!result.success) {
        showNotice(result.error ?? t("texthook.errors.startFailed"), "error");
      } else {
        showNotice(
          t("texthook.notices.started", {
            exe: result.exeName ?? "",
            pid: String(result.pid ?? ""),
          }),
          "success",
        );
        setWorkspaceView("live");
        setConsoleOpen(false);
      }
      await refreshStatus();
      await refreshHooks();
    } finally {
      setBusy(false);
    }
  }, [
    agentDetached,
    agentScriptPath,
    capture?.exeName,
    copyToClipboard,
    engine,
    flushDelayMs,
    refreshHooks,
    refreshStatus,
    showNotice,
    t,
  ]);

  const stopSession = useCallback(async () => {
    startCancelledRef.current = true;
    setStopping(true);
    setBusy(true);
    try {
      const result = await invokeIpc<{ success: boolean; error?: string }>("texthook.stop");
      if (!result?.success) {
        showNotice(result?.error ?? t("texthook.errors.stopFailed"), "error");
      }
      await refreshStatus();
      await refreshHooks();
    } finally {
      setStopping(false);
      setBusy(false);
    }
  }, [refreshHooks, refreshStatus, showNotice, t]);

  const advanceText = useCallback(async () => {
    setBusy(true);
    try {
      const result = await invokeIpc<{ success: boolean; error?: string }>("texthook.advance");
      if (!result?.success) {
        showNotice(result?.error ?? t("texthook.mages.advanceFailed"), "error");
      }
    } finally {
      setBusy(false);
    }
  }, [showNotice, t]);

  const selectHook = useCallback(
    async (hookId: string) => {
      const ok = await invokeIpc<{ success: boolean }>("texthook.selectHook", hookId);
      if (ok?.success) {
        setSelectedHookId(hookId);
        setTextLines([]);
        showNotice(t("texthook.notices.selected", { id: hookId }), "success");
      }
    },
    [showNotice, t],
  );

  const attachManual = useCallback(async () => {
    if (!manualHookCode.trim()) return;
    const result = await invokeIpc<{ success: boolean; error?: string }>(
      "texthook.attachManualHook",
      manualHookCode.trim(),
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
    [status.running],
  );

  const commitFlushDelayInput = useCallback(() => {
    flushDelayInputFocusedRef.current = false;
    const next = syncFlushDelayState(flushDelayInput, true);
    if (status.running) {
      void invokeIpc("texthook.setFlushDelay", next);
    }
  }, [flushDelayInput, status.running, syncFlushDelayState]);

  const updateMaxBufferSize = useCallback((value: string) => {
    setMaxBufferSizeInput(value);
  }, []);

  const commitMaxBufferSizeInput = useCallback(async () => {
    maxBufferSizeInputFocusedRef.current = false;
    const next = syncMaxBufferSizeState(maxBufferSizeInput, true);
    const result = await invokeIpc<{ success: boolean; maxBufferSize?: number; error?: string }>(
      "texthook.setMaxBufferSize",
      next,
    );
    if (result?.success) {
      syncMaxBufferSizeState(result.maxBufferSize ?? next, true);
    } else {
      showNotice(result?.error ?? t("texthook.errors.maxBufferSizeSaveFailed"), "error");
      void refreshTextHookSettings();
    }
  }, [maxBufferSizeInput, refreshTextHookSettings, showNotice, syncMaxBufferSizeState, t]);

  const toggleCopyToClipboard = useCallback(
    (checked: boolean) => {
      setCopyToClipboard(checked);
      if (status.running) {
        void invokeIpc("texthook.setCopyToClipboard", checked);
      }
    },
    [status.running],
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
        sceneId: capture?.sceneId,
        engine,
        autoHook,
        flushDelayMs,
        copyToClipboard,
        hookId: selectedHookId,
        hookFunction: targetHook?.function ?? null,
        manualHookCode:
          engine === "luna" || engine === "textractor" ? manualHookCode.trim() || null : null,
        agentScriptPath: engine === "agent" ? agentScriptPath.trim() || null : null,
        agentDetached: engine === "agent" ? agentDetached : false,
      },
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
    agentDetached,
    hooks,
    manualHookCode,
    selectedHookId,
    showNotice,
    status,
    t,
  ]);

  const deleteProfile = useCallback(async () => {
    if (!savedProfile) return;
    await invokeIpc("texthook.deleteProfile", {
      exeName: savedProfile.exeName,
      sceneId: savedProfile.sceneId ?? capture?.sceneId,
    });
    setSavedProfile(null);
    setAgentDetached(true);
    showNotice(t("texthook.notices.profileDeleted"), "info");
  }, [capture?.sceneId, savedProfile, showNotice, t]);

  const browseAgentScript = useCallback(async () => {
    const response = await invokeIpc<{ status?: string; path?: string }>(
      "settings.selectAgentScriptPath",
      { path: agentScriptPath },
    );
    if (response?.status === "success" && response.path) {
      setAgentScriptPath(response.path);
    }
  }, [agentScriptPath]);

  const openAgentScriptSearch = useCallback(async () => {
    const [listed, resolved] = await Promise.allSettled([
      invokeIpc<ListAgentScriptsResponse>("settings.listAgentScripts", { path: agentScriptPath }),
      capture?.sceneId
        ? invokeIpc<ResolveAgentScriptResponse>("settings.resolveAgentScriptForScene", {
            scene: { id: capture.sceneId, name: capture.sceneName },
          })
        : Promise.resolve(null),
    ]);
    const response = listed.status === "fulfilled" ? listed.value : null;
    const resolution = resolved.status === "fulfilled" ? resolved.value : null;
    const scripts = Array.isArray(response?.scripts) ? response.scripts : [];
    if (scripts.length === 0) {
      showNotice(response?.message ?? t("texthook.agent.noScripts"), "error");
      return;
    }
    const fallbackExeName = capture?.exeName || (status.running ? status.exeName : "");
    const candidates = buildAgentScriptCandidateList({
      searchContext: {
        sceneName: capture?.sceneName,
        windowTitle: capture?.windowTitle,
        processName: fallbackExeName,
      },
      scripts,
      resolvedCandidates: resolution?.candidates,
      resolvedPath: agentScriptPath || (resolution?.status === "success" ? resolution.path : null),
      resolvedReason: agentScriptPath ? "matched_explicit_path" : resolution?.reason,
      resolvedScore: agentScriptPath ? 0 : undefined,
    });
    setAgentScriptDialog({ candidates, query: "" });
  }, [
    agentScriptPath,
    capture?.exeName,
    capture?.sceneId,
    capture?.sceneName,
    capture?.windowTitle,
    showNotice,
    status,
    t,
  ]);

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

  const sendDevLargePayload = useCallback(async () => {
    const payload = createDevJapanesePayload(DEV_LARGE_PAYLOAD_LENGTH);
    const result = await invokeIpc<{
      success: boolean;
      length?: number;
      originalLength?: number;
      truncated?: boolean;
      blockedByHardLimit?: boolean;
      limit?: number;
    }>("texthook.devSendLargePayload", payload);
    if (result?.success) {
      showNotice(
        result.truncated
          ? t("texthook.dev.largePayloadTruncated", {
              size: String(result.length ?? payload.length),
              originalSize: String(result.originalLength ?? payload.length),
            })
          : t("texthook.dev.largePayloadSent", {
              size: String(result.length ?? payload.length),
            }),
        "success",
      );
    } else {
      showNotice(
        result?.blockedByHardLimit
          ? t("texthook.errors.textExceededLimit", {
              limit: String(result.limit ?? 10_000),
            })
          : t("texthook.dev.largePayloadFailed"),
        "error",
      );
    }
  }, [showNotice, t]);

  const exeNameDisplay = status.running
    ? status.exeName
    : (capture?.exeName ?? t("texthook.capture.unknown"));
  const sceneDisplay = capture?.sceneName || t("texthook.capture.noScene");

  const rankHooks = engine === "luna" || engine === "textractor";
  const selectedHook = hooks.find((hook) => hook.id === selectedHookId);
  const saveRecommended = Boolean(
    selectedHookId &&
      (savedProfile?.engine !== engine ||
        savedProfile?.hookId !== selectedHookId ||
        (savedProfile?.hookFunction ?? null) !== (selectedHook?.function ?? null)),
  );
  const rankedHooks = useMemo(
    () =>
      rankHooks
        ? rankHookCandidates(hooks, targetLanguage, selectedHookId).filter(
            ({ hook, quality }) => hook.id === selectedHookId || quality.hasText,
          )
        : hooks.map((hook) => ({ hook, quality: null })),
    [rankHooks, hooks, targetLanguage, selectedHookId, rankHookCandidates],
  );
  const likelyNoiseCount = rankedHooks.filter(
    ({ hook, quality }) => quality?.likelyNoise && hook.id !== selectedHookId,
  ).length;
  const visibleHooks = rankedHooks.filter(
    ({ hook, quality }) => showLikelyNoise || !quality?.likelyNoise || hook.id === selectedHookId,
  );
  const startDisabled =
    busy ||
    stopping ||
    preparingCapture ||
    engineStatus?.phase === "installing" ||
    (engineStatus?.installed === false &&
      ["downloading", "verifying"].includes(engineStatus.phase)) ||
    !capture?.exeName ||
    (engine === "agent" && agentScriptPath.trim().length === 0);
  const statusBadgeText = status.running
    ? t(status.engine === "agent" && status.agentPhase
        ? AGENT_PHASE_LABEL_KEYS[status.agentPhase]
        : "texthook.status.attached")
    : capture?.exeName
      ? t("texthook.status.ready")
      : t("texthook.status.noTarget");

  const openExternal = useCallback((url: string) => void invokeIpc("open-external-link", url), []);

  const engineUpdateInProgress =
    updatingEngines ||
    ["downloading", "verifying", "waiting", "installing"].includes(engineStatus?.phase ?? "");
  const engineVersionChangeBlocked =
    updatingEngines || ["downloading", "verifying", "installing"].includes(engineStatus?.phase ?? "");
  const engineUpdateLabel =
    checkingEngines || engineStatus?.phase === "checking"
      ? t("texthook.updates.checking")
      : engineCheckFailed
        ? t("texthook.updates.checkFailed")
        : engineStatus?.phase === "error"
          ? t("texthook.updates.failed")
          : engineStatus?.phase === "waiting"
            ? t("texthook.updates.waiting")
            : engineStatus?.phase === "installing"
              ? t("texthook.updates.installing")
              : engineStatus?.phase === "verifying"
                ? t("texthook.updates.verifying")
                : engineStatus?.phase === "downloading" || updatingEngines
                  ? t("texthook.updates.downloading")
                  : engineStatus?.installed === false
                    ? t("texthook.updates.notInstalled")
                    : engineStatus?.updateAvailable
                      ? t("texthook.updates.updateAvailable")
                      : engineStatus?.remoteVersion &&
                          engineStatus.version === engineStatus.remoteVersion
                        ? t("texthook.updates.upToDate")
                        : engineStatus?.version
                          ? t("texthook.updates.installed", { version: engineStatus.version })
                          : "";

  const currentView = HOOK_WORKSPACE_VIEWS.find((view) => view.id === workspaceView)!;
  const engineLabel = t("texthook.engine." + engine);
  const navigateWorkspace = (view: HookWorkspaceView) => {
    setWorkspaceView(view);
    setConsoleOpen(false);
  };
  const navigateWorkspaceTabs = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowDown") next = (index + 1) % HOOK_WORKSPACE_VIEWS.length;
    else if (event.key === "ArrowUp")
      next = (index - 1 + HOOK_WORKSPACE_VIEWS.length) % HOOK_WORKSPACE_VIEWS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = HOOK_WORKSPACE_VIEWS.length - 1;
    else return;
    event.preventDefault();
    const view = HOOK_WORKSPACE_VIEWS[next];
    navigateWorkspace(view.id);
    document.getElementById("texthook-nav-" + view.id)?.focus();
  };

  return (
    <div className={`tab-panel ${active ? "active" : ""}`}>
      <div
        id="texthook-workspace"
        className="texthook-desk"
        onKeyDown={(event) => {
          if (event.key === "Escape" && consoleOpen) {
            event.preventDefault();
            setConsoleOpen(false);
            document.getElementById("texthook-log-toggle")?.focus();
          }
        }}
      >
        {notice ? (
          <div
            className={`ocr-toast ocr-toast--${notice.type}`}
            role="status"
            aria-live="polite"
          >
            <span>{notice.message}</span>
          </div>
        ) : null}

        <aside className="th-sidebar">
          <div className="th-brand">
            <span className="th-brand-mark">
              <HookWorkspaceIcon name="live" />
            </span>
            <div>
              <strong>{t("texthook.workspace.title")}</strong>
              <span>{t("texthook.workspace.brandHint")}</span>
            </div>
          </div>
          <section
            className="th-target"
            aria-labelledby="texthook-capture-title"
          >
            <div className="th-target-label">
              <h2 id="texthook-capture-title">{t("texthook.workspace.currentGame")}</h2>
              <button
                type="button"
                className="th-icon-button"
                aria-label={t("texthook.capture.refresh")}
                onClick={() => void refreshActiveCapture()}
              >
                <HookWorkspaceIcon name="refresh" />
              </button>
            </div>
            <strong>{sceneDisplay}</strong>
            <span className="th-target-executable">{exeNameDisplay}</span>
            {status.running || capture?.pid ? (
              <span className="th-target-process">
                {t("texthook.capture.pid")} {status.running ? status.pid : capture?.pid}
                {" · "}
                {status.running ? status.arch : capture?.arch}
              </span>
            ) : null}
          </section>
          <nav
            className="th-navigation"
            role="tablist"
            aria-orientation="vertical"
            aria-label={t("texthook.workspace.navigation")}
          >
            {HOOK_WORKSPACE_VIEWS.map((view, index) => (
              <button
                type="button"
                role="tab"
                key={view.id}
                id={"texthook-nav-" + view.id}
                aria-selected={!consoleOpen && workspaceView === view.id}
                aria-controls={"texthook-view-" + view.id}
                tabIndex={workspaceView === view.id ? 0 : -1}
                onClick={() => navigateWorkspace(view.id)}
                onKeyDown={(event) => navigateWorkspaceTabs(event, index)}
              >
                <HookWorkspaceIcon name={view.id} />
                <span>{t(view.labelKey)}</span>
              </button>
            ))}
          </nav>
          <section
            className={"th-session texthook-session-card" + (status.running ? " is-attached" : "")}
            aria-label={t("texthook.capture.title")}
          >
            <div
              className="th-session-state"
              role="status"
            >
              <i aria-hidden="true" />
              {statusBadgeText}
            </div>
            <strong>{engineLabel}</strong>
            <span>
              {selectedHookId
                ? t("texthook.hooks.selected", { id: selectedHookId })
                : t("texthook.workspace.noHookSelected")}
            </span>
            <div className="th-session-actions">
              {SHOW_DEV_LARGE_PAYLOAD_TEST ? (
                <button
                  type="button"
                  onClick={() => void sendDevLargePayload()}
                >
                  {t("texthook.dev.sendLargePayload", { size: String(DEV_LARGE_PAYLOAD_LENGTH) })}
                </button>
              ) : null}
              {status.running ? (
                <>
                  {status.engine === "mages" ? (
                    <button
                      type="button"
                      className="th-primary"
                      disabled={busy}
                      onClick={() => void advanceText()}
                    >
                      {t("texthook.mages.advance")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="danger"
                    disabled={stopping || (busy && !(status.engine === "agent" && status.agentPhase === "starting"))}
                    onClick={() => void stopSession()}
                  >
                    <HookWorkspaceIcon name="stop" />
                    {t("texthook.actions.stop")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="th-primary"
                  disabled={startDisabled}
                  onClick={() => void startSession()}
                >
                  <HookWorkspaceIcon name="play" />
                  {t(rankHooks ? "texthook.actions.searchHooks" : "texthook.actions.start")}
                </button>
              )}
              {!status.running && engine === "agent" && !agentScriptPath.trim() ? (
                <button
                  type="button"
                  className="th-text-button"
                  onClick={() => navigateWorkspace("live")}
                >
                  {t("texthook.agent.pickerTitle")}
                </button>
              ) : null}
            </div>
            {preparingCapture ? (
              <p
                className="texthook-card-hint"
                role="status"
              >
                {t("texthook.actions.preparing")}
              </p>
            ) : null}
          </section>
        </aside>

        <main className="th-main">
          <header className="th-page-header">
            <div>
              <h1>{t(consoleOpen ? "texthook.log.title" : currentView.labelKey)}</h1>
            </div>
            <button
              id="texthook-log-toggle"
              type="button"
              className="th-log-toggle"
              aria-expanded={consoleOpen}
              aria-controls="texthook-view-console"
              onClick={() => setConsoleOpen((open) => !open)}
            >
              <HookWorkspaceIcon name={consoleOpen ? "close" : "log"} />
              <span>{t(consoleOpen ? "texthook.workspace.closeLog" : "texthook.log.title")}</span>
            </button>
          </header>
          <div className="th-pages">
            <section
              id="texthook-view-live"
              className="th-view th-live-view"
              role="tabpanel"
              aria-labelledby="texthook-nav-live"
              hidden={consoleOpen || workspaceView !== "live"}
              tabIndex={0}
            >
              <div
                className="th-live-setup"
                role="group"
                aria-label={t("texthook.workspace.engine")}
              >
                <div className="th-engine-picker">
                  <div className="input-group">
                    <label htmlFor="texthook-engine-select">{t("texthook.engine.label")}</label>
                    <select
                      id="texthook-engine-select"
                      value={engine}
                      onChange={(e) => setEngine(e.target.value as TextHookEngine)}
                      disabled={status.running}
                    >
                      <option value="luna">{t("texthook.engine.luna")}</option>
                      <option value="textractor">{t("texthook.engine.textractor")}</option>
                      <option value="agent">{t("texthook.engine.agent")}</option>
                      <option value="mages">{t("texthook.engine.mages")}</option>
                    </select>
                  </div>
                </div>
                <div className="texthook-engine-extras">
                  {/* Agent-specific configuration */}
                  {engine === "agent" ? (
                    <div className="texthook-agent-config">
                      <div className="input-group texthook-agent-script-field">
                        <label htmlFor="texthook-agent-script-input">
                          {t("texthook.agent.scriptPath")}
                        </label>
                        <div className="texthook-agent-script-picker">
                          <input
                            id="texthook-agent-script-input"
                            type="text"
                            value={agentScriptPath}
                            disabled={status.running}
                            placeholder={t("texthook.agent.scriptPlaceholder")}
                            onChange={(e) => setAgentScriptPath(e.target.value)}
                          />
                          <div className="link-row texthook-agent-script-actions">
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
                            {status.running && status.engine === "agent" && status.agentHasUi ? (
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
                      </div>
                      <div className="input-group texthook-agent-detached">
                        <label htmlFor="texthook-agent-detached-input">
                          <input
                            id="texthook-agent-detached-input"
                            type="checkbox"
                            checked={agentDetached}
                            disabled={status.running}
                            onChange={(e) => setAgentDetached(e.target.checked)}
                          />
                          {t("texthook.agent.runDetached")}
                        </label>
                        <span className="texthook-card-hint">
                          {t("texthook.agent.runDetachedHint")}
                        </span>
                      </div>
                    </div>
                  ) : null}

                  {engine === "mages" ? (
                    <div
                      className="texthook-subsection texthook-mages-notice"
                      role="note"
                      aria-labelledby="texthook-mages-title"
                    >
                      <div className="texthook-mages-heading">
                        <div
                          id="texthook-mages-title"
                          className="texthook-subsection-label"
                        >
                          {t("texthook.mages.title")}
                        </div>
                        <span className="texthook-mages-badge">
                          {t("texthook.mages.experimentalBadge")}
                        </span>
                      </div>
                      <p className="texthook-mages-availability">
                        {t("texthook.mages.availability")}
                      </p>
                      <div className="texthook-supported-games">
                        <div className="texthook-supported-games__label">
                          {t("texthook.mages.support.title")}
                        </div>
                        <ul>
                          {builtInHookTargets.map((target) => (
                            <li key={target.id}>
                              <strong>{target.name}</strong>
                              <span>{target.details[locale] ?? target.details.en ?? ""}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <p className="texthook-card-hint">{t("texthook.mages.description")}</p>
                    </div>
                  ) : null}
                </div>

                {rankHooks ? (
                  <section className="texthook-section texthook-manual-hook" aria-labelledby="texthook-manual-title">
                    <h2 id="texthook-manual-title">{t("texthook.steps.manualHookLabel")}</h2>
                    <div className="texthook-manual-body">
                      <div className="input-group">
                        <label
                          htmlFor="texthook-manual-input"
                          data-tip={t("texthook.profile.manualHookHint")}
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
                          disabled={!status.running || !manualHookCode.trim()}
                          onClick={() => void attachManual()}
                        >
                          {t("texthook.profile.attachManual")}
                        </button>
                      </div>
                    </div>
                  </section>
                ) : null}
              </div>

              <div className="texthook-live-grid">
                <section className="texthook-hook-list">
                  <div className="th-section-heading">
                    <div>
                      <h2 className="texthook-section-title">{t("texthook.hooks.title")}</h2>
                      <p className="texthook-card-hint">{t("texthook.hooks.selectHint")}</p>
                    </div>
                    <div className="texthook-hook-summary">
                      <span className="texthook-hook-count">
                        {t("texthook.hooks.count", { count: String(visibleHooks.length) })}
                      </span>
                    </div>
                  </div>
                  <div className="texthook-hooks">
                    {visibleHooks.length === 0 ? (
                      <div className="texthook-empty">
                        {likelyNoiseCount > 0
                          ? t("texthook.hooks.onlyNoise")
                          : status.running
                            ? t("texthook.hooks.waiting")
                            : t("texthook.hooks.notRunning")}
                      </div>
                    ) : (
                      <ul className="texthook-hook-rows">
                        {visibleHooks.map(({ hook, quality }) => {
                          const isSelected = hook.id === selectedHookId;
                          return (
                            <li
                              key={hook.id}
                              className={`texthook-hook-row ${isSelected ? "selected" : ""} ${quality?.likelyNoise ? "texthook-hook-row--noise" : ""}`}
                            >
                              <button
                                type="button"
                                className="texthook-hook-button"
                                onClick={() => void selectHook(hook.id)}
                                aria-pressed={isSelected}
                                aria-label={t("texthook.hooks.rowLabel", {
                                  id: hook.id,
                                  name: hook.function,
                                })}
                              >
                                <span className="texthook-hook-id">#{hook.id}</span>
                                <span className="texthook-hook-fn">
                                  <span className="texthook-hook-name">{hook.function}</span>
                                  {quality?.hasText ? (
                                    <span
                                      className={`texthook-hook-quality ${quality.score >= 3 ? "texthook-hook-quality--match" : ""}`}
                                      title={t(HOOK_QUALITY_LABEL_KEYS[quality.reason])}
                                    >
                                      {t(HOOK_QUALITY_LABEL_KEYS[quality.reason])}
                                    </span>
                                  ) : null}
                                </span>
                                <span className="texthook-hook-preview">
                                  {hook.preview || t("texthook.hooks.noTextYet")}
                                </span>
                                <span
                                  className="texthook-hook-radio"
                                  aria-hidden="true"
                                >
                                  <span className="texthook-hook-radio-dot" />
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                  {rankHooks ? (
                    <div className="texthook-hook-filters">
                      <label
                        className="texthook-noise-toggle"
                        htmlFor="texthook-show-noise"
                        data-tip={
                          targetLanguage
                            ? t("texthook.hooks.rankingHint", {
                                language: targetLanguage.toUpperCase(),
                              })
                            : t("texthook.hooks.readabilityHint")
                        }
                      >
                        <input
                          id="texthook-show-noise"
                          type="checkbox"
                          checked={showLikelyNoise}
                          onChange={(event) => setShowLikelyNoise(event.target.checked)}
                        />
                        {t("texthook.hooks.showNoise", { count: likelyNoiseCount })}
                      </label>
                    </div>
                  ) : null}
                </section>

                <section className="texthook-output-card">
                  <div className="th-section-heading">
                    <div>
                      <h2 className="texthook-section-title">{t("texthook.output.title")}</h2>
                      <p className="texthook-card-hint">{t("texthook.output.checkHint")}</p>
                    </div>
                    {selectedHookId ? (
                      <span className="th-badge">
                        {t("texthook.hooks.selected", { id: selectedHookId })}
                      </span>
                    ) : null}
                  </div>
                  <div
                    className="texthook-output"
                    ref={textScrollRef}
                    tabIndex={0}
                    role="region"
                    aria-label={t("texthook.output.title")}
                  >
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
                  <label
                    className="th-clipboard-toggle"
                    htmlFor="texthook-copy-to-clipboard"
                  >
                    <input
                      id="texthook-copy-to-clipboard"
                      type="checkbox"
                      checked={copyToClipboard}
                      onChange={(e) => toggleCopyToClipboard(e.target.checked)}
                    />
                    {t("texthook.profile.copyToClipboard")}
                  </label>
                </section>
              </div>

              <section
                className={`texthook-profile-card ${saveRecommended ? "texthook-profile-card--recommended" : ""}`}
              >
                <div className="texthook-profile-row">
                  <div className="texthook-profile-summary">
                    <div className="texthook-profile-heading">
                      <h2 className="texthook-section-title">{t("texthook.profile.title")}</h2>
                      <span
                        className="texthook-profile-state"
                        role="status"
                        aria-live="polite"
                        aria-label={t("texthook.profile.save")}
                      >
                        {saveRecommended ? (
                          <span className="texthook-save-recommendation">
                            {t("texthook.profile.recommended")}
                          </span>
                        ) : savedProfile ? (
                          <span className="th-badge">{t("texthook.profile.saved")}</span>
                        ) : null}
                      </span>
                    </div>
                    <p
                      id="texthook-save-hint"
                      className="texthook-card-hint"
                    >
                      {t("texthook.profile.saveHint")}
                    </p>
                    <label className="texthook-profile-auto">
                      <input
                        type="checkbox"
                        checked={autoHook}
                        onChange={(event) => setAutoHook(event.target.checked)}
                      />
                      {t("texthook.profile.autoHook")}
                    </label>
                  </div>
                  <div className="link-row texthook-profile-actions">
                    <button
                      type="button"
                      className={`secondary texthook-save-hook ${saveRecommended ? "texthook-save-hook--recommended" : ""}`}
                      aria-describedby="texthook-save-hint"
                      onClick={() => void saveProfile()}
                    >
                      {t("texthook.profile.save")}
                    </button>
                    <button
                      type="button"
                      className="danger texthook-quiet-action"
                      disabled={!savedProfile}
                      onClick={() => void deleteProfile()}
                    >
                      {t("texthook.profile.delete")}
                    </button>
                  </div>
                </div>
              </section>
            </section>

            <section
              id="texthook-view-output"
              className="th-view texthook-capture-options"
              role="tabpanel"
              aria-labelledby="texthook-nav-output"
              hidden={consoleOpen || workspaceView !== "output"}
              tabIndex={0}
            >
              <div className="texthook-options-body">
                <div className="form-group ocr-form-group">
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
                  <div className="input-group">
                    <label
                      htmlFor="texthook-max-buffer-size-input"
                      data-tip={t("texthook.global.maxBufferSizeHint")}
                    >
                      {t("texthook.global.maxBufferSize")}
                    </label>
                    <input
                      id="texthook-max-buffer-size-input"
                      type="number"
                      min="1"
                      max={String(MAX_TEXT_HOOK_MAX_BUFFER_SIZE)}
                      step="100"
                      value={maxBufferSizeInput}
                      onChange={(e) => updateMaxBufferSize(e.target.value)}
                      onFocus={() => {
                        maxBufferSizeInputFocusedRef.current = true;
                      }}
                      onBlur={() => void commitMaxBufferSizeInput()}
                    />
                  </div>
                </div>
              </div>
            </section>

            <section
              id="texthook-view-console"
              className="th-view th-console-view"
              role="region"
              aria-label={t("texthook.log.title")}
              hidden={!consoleOpen}
              tabIndex={0}
            >
              <div className="th-console-toolbar">
                <span className="th-console-state">
                  <i aria-hidden="true" />
                  {statusBadgeText}
                </span>
                <button
                  type="button"
                  onClick={() => setLogLines([])}
                >
                  {t("texthook.workspace.clearLog")}
                </button>
              </div>
              <div
                className="texthook-log"
                ref={logScrollRef}
                tabIndex={0}
                role="region"
                aria-label={t("texthook.log.title")}
              >
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

            <section
              id="texthook-view-tools"
              className="th-view"
              role="tabpanel"
              aria-labelledby="texthook-nav-tools"
              hidden={consoleOpen || workspaceView !== "tools"}
              tabIndex={0}
            >
              <div className="th-tools-content">
                <section
                  className="texthook-section texthook-engine-maintenance"
                  aria-labelledby="texthook-engine-updates-title"
                >
                  <div className="texthook-section-body texthook-maintenance-body">
                    <div className="th-section-heading">
                      <h2 id="texthook-engine-updates-title">{t("texthook.updates.title")}</h2>
                      <span
                        role="status"
                        aria-live="polite"
                      >
                        {engineUpdateLabel}
                      </span>
                    </div>
                    <p>{t("texthook.updates.description")}</p>
                    <label className="texthook-maintenance-toggle">
                      <input
                        type="checkbox"
                        checked={engineStatus?.automatic ?? true}
                        disabled={!engineStatus || engineStatus.phase === "installing"}
                        onChange={(event) => void setAutomaticEngineUpdates(event.target.checked)}
                      />
                      {t("texthook.updates.automatic")}
                    </label>
                    <p>{t("texthook.updates.verificationHint")}</p>
                    {engineStatus?.installed ? (
                      <p>
                        {t("texthook.updates.installed", {
                          version: engineStatus.version ?? t("texthook.updates.unknownVersion"),
                        })}
                      </p>
                    ) : null}
                    {engineStatus?.remoteVersion ? (
                      <p>
                        {t("texthook.updates.available", { version: engineStatus.remoteVersion })}
                      </p>
                    ) : null}
                    {engineVersions.length ? (
                      <>
                        <label className="texthook-maintenance-version">
                          <span>{t("texthook.updates.versionChoice")}</span>
                          <select
                            value={engineVersionChoice}
                            disabled={engineVersionChangeBlocked || preparingCapture}
                            onChange={(event) => setSelectedEngineVersion(event.target.value)}
                          >
                            {engineVersions.map(({ version }, index) => (
                              <option key={version} value={version}>
                                {version}
                                {version === engineStatus?.remoteVersion ? ` · ${t("texthook.updates.recommended")}` : ""}
                                {index === 0 ? ` · ${t("texthook.updates.latest")}` : ""}
                              </option>
                            ))}
                          </select>
                        </label>
                        {selectedEnginePackage?.engineVersions ? (
                          <p>{t("texthook.updates.buildVersions", selectedEnginePackage.engineVersions)}</p>
                        ) : null}
                        {selectedEnginePackage?.notes ? <p>{selectedEnginePackage.notes}</p> : null}
                        <p>{t("texthook.updates.pinHint")}</p>
                      </>
                    ) : null}
                    {engineStatus?.progress ? (
                      <p>
                        {t("texthook.updates.progress", {
                          current: String(engineStatus.progress.fileIndex + 1),
                          total: String(engineStatus.progress.totalFiles),
                          file: engineStatus.progress.file,
                        })}
                      </p>
                    ) : null}
                    {engineStatus?.error ? (
                      <p className="texthook-maintenance-error">{engineStatus.error}</p>
                    ) : null}
                    {engineActionNotice ? (
                      <p
                        className={
                          "texthook-maintenance-feedback texthook-maintenance-feedback--" +
                          engineActionNotice.type
                        }
                        role="status"
                      >
                        {engineActionNotice.message}
                      </p>
                    ) : null}
                    <div className="link-row">
                      <button
                        type="button"
                        className="secondary"
                        disabled={
                          checkingEngines ||
                          engineStatus?.phase === "checking" ||
                          engineUpdateInProgress ||
                          preparingCapture
                        }
                        onClick={() => void refreshEngineStatus(true)}
                      >
                        {t("texthook.updates.check")}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={
                          busy || (engineVersions.length ? engineVersionChangeBlocked : engineUpdateInProgress) || preparingCapture || !engineStatus
                        }
                        onClick={() => void downloadEngines(engineVersions.length ? engineVersionChoice : undefined)}
                      >
                        {t(
                          engineVersions.length
                            ? engineVersionChoice === engineStatus?.version
                              ? "texthook.updates.repair"
                              : "texthook.updates.installSelected"
                            : !engineStatus?.installed
                            ? "texthook.updates.install"
                            : engineStatus.updateAvailable
                              ? "texthook.updates.updateNow"
                              : "texthook.updates.repair",
                        )}
                      </button>
                      {engineVersions.length ? (
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy || engineVersionChangeBlocked || preparingCapture || engineVersions[0].version === engineStatus?.version}
                          onClick={() => void downloadEngines(engineVersions[0].version)}
                        >
                          {t("texthook.updates.updateLatest")}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </section>
                <section
                  className="texthook-section texthook-help"
                  aria-labelledby="texthook-notice-title"
                >
                  <h2 id="texthook-notice-title">{t("texthook.notice.title")}</h2>
                  <div className="texthook-section-body texthook-notice-card">
                    <p>{t("texthook.notice.description")}</p>
                    <p>{t("texthook.notice.engineGuide")}</p>
                    <p>
                      {t("texthook.notice.processingPrefix")}
                      <button
                        type="button"
                        className="texthook-notice-link"
                        onClick={() => onNavigateTab?.("textprocessing")}
                      >
                        {t("app.tabs.textProcessing")}
                      </button>
                      {t("texthook.notice.processingSuffix")}
                    </p>
                  </div>
                </section>
                <footer className="home-support texthook-credits">
                  <span
                    className="texthook-credits__mark"
                    aria-hidden="true"
                  >
                    !
                  </span>
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
              </div>
            </section>
          </div>
        </main>
        {agentScriptDialog ? (
          <AgentScriptSearchDialog
            candidates={agentScriptDialog.candidates}
            query={agentScriptDialog.query}
            selectedPath={agentScriptPath}
            title={t("texthook.agent.pickerTitle")}
            closeLabel={t("texthook.agent.pickerClose")}
            searchPlaceholder={t("texthook.agent.searchPlaceholder")}
            noResultsLabel={t("texthook.agent.pickerNoResults")}
            onClose={() => setAgentScriptDialog(null)}
            onQueryChange={(query) =>
              setAgentScriptDialog((current) => (current ? { ...current, query } : current))
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
