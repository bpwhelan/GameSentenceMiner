import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { LauncherTab } from "./components/tabs/LauncherTab";
import { SettingsTab } from "./components/tabs/SettingsTab";
import { SetupWizard } from "./components/SetupWizard";
import type { ControlledTab } from "./types/models";

type TabId =
  | "obs"
  | "ocr"
  | "stats"
  | "launcher"
  | "settings"
  | "python"
  | "console";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "obs", label: "Home" },
  { id: "ocr", label: "OCR" },
  { id: "stats", label: "Stats" },
  { id: "launcher", label: "Game Settings" },
  { id: "settings", label: "Settings" },
  { id: "python", label: "Python" },
  { id: "console", label: "Logs" }
];

const ALWAYS_VISIBLE_TABS = new Set<TabId>(["obs", "ocr", "settings"]);
const CONTROLLABLE_TABS: ControlledTab[] = [
  "launcher",
  "stats",
  "python",
  "console"
];
const DEFAULT_VISIBLE_TABS: ControlledTab[] = [
  "launcher",
  "stats",
  "python",
  "console"
];

function isControlledTab(tab: TabId): tab is ControlledTab {
  return CONTROLLABLE_TABS.includes(tab as ControlledTab);
}

function getLegacyAssetPath(fileName: string): string {
  const base = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  return `${base}legacy/${fileName.replace(/^\/+/, "")}`;
}

function LegacyFrame({
  src,
  active,
  reloadKey = 0
}: {
  src: string;
  active: boolean;
  reloadKey?: number;
}) {
  return (
    <div className={`tab-panel ${active ? "active" : ""}`}>
      <iframe
        key={reloadKey}
        className="legacy-frame"
        src={src}
        title={src}
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}

function StatsPanel({ active }: { active: boolean }) {
  const [iframeSrc, setIframeSrc] = useState<string | null>(null);
  const [loadingMessage, setLoadingMessage] = useState(
    "Waiting for GSM stats to load..."
  );
  const [isLoading, setIsLoading] = useState(true);
  const loadingRef = useRef(false);
  const loadedUrlRef = useRef<string | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current) {
      clearInterval(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const waitForStatsEndpoint = useCallback(async (url: string) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }, []);

  const loadStats = useCallback(async (forceReload = false) => {
    if (loadingRef.current) {
      return;
    }

    loadingRef.current = true;
    try {
      const settings = await window.ipcRenderer.invoke<{ statsEndpoint?: string }>(
        "settings.getSettings"
      );
      const statsEndpoint = settings?.statsEndpoint ?? "overview";
      const statsUrl = `http://localhost:7275/${statsEndpoint}`;

      // If this URL already loaded, don't reset to a permanent loading state.
      if (!forceReload && loadedUrlRef.current === statsUrl) {
        setIsLoading(false);
        setIframeSrc(statsUrl);
        clearRetryTimer();
        return;
      }

      setLoadingMessage("Waiting for GSM stats to load...");
      setIsLoading(true);

      const ready = await waitForStatsEndpoint(statsUrl);
      if (ready) {
        clearRetryTimer();
        setIframeSrc(statsUrl);
        return;
      }

      clearRetryTimer();
      retryTimerRef.current = setInterval(() => {
        void (async () => {
          const isReady = await waitForStatsEndpoint(statsUrl);
          if (!isReady) {
            return;
          }
          clearRetryTimer();
          setIframeSrc(statsUrl);
        })();
      }, 2000);
    } finally {
      loadingRef.current = false;
    }
  }, [clearRetryTimer, waitForStatsEndpoint]);

  useEffect(() => {
    if (active) {
      void loadStats();
      return;
    }
    clearRetryTimer();
  }, [active, clearRetryTimer, loadStats]);

  useEffect(() => {
    const offInitialized = window.ipcRenderer.on("gsm-initialized", () => {
      loadedUrlRef.current = null;
      if (active) {
        void loadStats(true);
      }
    });
    return () => offInitialized();
  }, [active, loadStats]);

  useEffect(() => clearRetryTimer, [clearRetryTimer]);

  return (
    <div className={`tab-panel ${active ? "active" : ""}`}>
      <div className="stats-panel">
        {isLoading ? (
          <div className="stats-loading">
            <div className="spinner" />
            <div>{loadingMessage}</div>
          </div>
        ) : null}
        {iframeSrc ? (
          <iframe
            className="legacy-frame"
            src={iframeSrc}
            title="stats"
            allow="clipboard-read; clipboard-write"
            onLoad={() => {
              loadedUrlRef.current = iframeSrc;
              setIsLoading(false);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function ConsolePanel({
  active,
  onRequestConsole
}: {
  active: boolean;
  onRequestConsole: () => void;
}) {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const termInstanceRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downloadStarted = useRef(false);
  const transcribeStarted = useRef(false);
  const vadStarted = useRef(false);
  const adjustmentStarted = useRef(false);
  const updateProgressStarted = useRef(false);
  const [consoleMode, setConsoleMode] = useState<'simple' | 'advanced'>('simple');

  // Load console mode from settings on mount
  useEffect(() => {
    window.ipcRenderer.invoke('settings.getSettings').then((settings: any) => {
      setConsoleMode(settings.consoleMode || 'simple');
    });
  }, []);

  // Persist console mode changes
  const toggleConsoleMode = useCallback(() => {
    const newMode = consoleMode === 'simple' ? 'advanced' : 'simple';
    setConsoleMode(newMode);
    window.ipcRenderer.invoke('settings.saveSettings', { consoleMode: newMode });
  }, [consoleMode]);

  const openLogsFolder = useCallback(async () => {
    await window.ipcRenderer.invoke("logs.openFolder");
  }, []);

  const exportLogs = useCallback(async () => {
    await window.ipcRenderer.invoke("logs.export");
  }, []);

  const consoleModeRef = useRef(consoleMode);
  useEffect(() => {
    consoleModeRef.current = consoleMode;
  }, [consoleMode]);

  useEffect(() => {
    if (!terminalRef.current || termInstanceRef.current) {
      return;
    }

    const term = new Terminal({
      fontFamily: '"Noto Sans Mono", "IPA Gothic", "Courier New", monospace',
      fontSize: 14,
      cursorBlink: false,
      allowProposedApi: true,
      theme: {
        foreground: "#EEEEEE",
        background: "#1a1a1a",
        cursor: "#CFF5DB"
      }
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();
    termInstanceRef.current = term;
    fitAddonRef.current = fitAddon;

    type TerminalStream = "stdout" | "stderr";
    type TerminalChannel = "basic" | "background";
    type TerminalPayload = {
      message: string;
      stream?: TerminalStream;
      channel?: TerminalChannel;
      level?: string;
      source?: string;
    };

    const stripAnsi = (value: string): string =>
      value.replace(/\u001b\[[0-9;]*m/g, "");

    const parseTerminalPayload = (
      payload: unknown,
      fallbackStream: TerminalStream
    ): TerminalPayload => {
      if (payload && typeof payload === "object" && "message" in (payload as Record<string, unknown>)) {
        const record = payload as Record<string, unknown>;
        return {
          message: String(record.message ?? ""),
          stream:
            record.stream === "stderr"
              ? "stderr"
              : record.stream === "stdout"
                ? "stdout"
                : fallbackStream,
          channel: record.channel === "background" ? "background" : record.channel === "basic" ? "basic" : undefined,
          level: typeof record.level === "string" ? record.level.toUpperCase() : undefined,
          source: typeof record.source === "string" ? record.source : undefined
        };
      }
      return {
        message: String(payload ?? ""),
        stream: fallbackStream
      };
    };

    const parseLevelFromLine = (line: string): string | undefined => {
      const clean = stripAnsi(line);
      const match = clean.match(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+\|\s+[^|]+\|\s+([A-Z_]+)\s+\|/
      );
      return match ? match[1].toUpperCase() : undefined;
    };

    const inferChannel = (
      payload: TerminalPayload,
      level: string | undefined
    ): TerminalChannel => {
      if (payload.channel) {
        return payload.channel;
      }
      const normalized = (level ?? "").toUpperCase();
      if (normalized === "BACKGROUND" || normalized === "DEBUG" || normalized === "TRACE") {
        return "background";
      }
      return "basic";
    };

    const resetInlineStatus = () => {
      const hadInline =
        downloadStarted.current ||
        transcribeStarted.current ||
        vadStarted.current ||
        adjustmentStarted.current ||
        updateProgressStarted.current;
      if (hadInline) {
        term.write("\r\n");
      }
      downloadStarted.current = false;
      transcribeStarted.current = false;
      vadStarted.current = false;
      adjustmentStarted.current = false;
      updateProgressStarted.current = false;
    };

    const printDownloadStatus = (value: string) => {
      const trimmed = value.trimEnd();
      if (!downloadStarted.current) {
        downloadStarted.current = true;
        term.write("\r\n");
      }
      term.write(`\x1b[32m${trimmed}\x1b[0m\r`);
    };

    const printVADStatus = (value: string) => {
      if (value.startsWith("Transcription:")) {
        if (!transcribeStarted.current) {
          term.write("\r\n");
        }
        transcribeStarted.current = true;
        vadStarted.current = false;
        adjustmentStarted.current = false;
      } else if (value.startsWith("VAD:")) {
        if (!vadStarted.current) {
          term.write("\r\n");
        }
        vadStarted.current = true;
        transcribeStarted.current = false;
        adjustmentStarted.current = false;
      } else if (value.startsWith("Adjustment:")) {
        if (!adjustmentStarted.current) {
          term.write("\r\n");
        }
        adjustmentStarted.current = true;
        transcribeStarted.current = false;
        vadStarted.current = false;
      }

      term.write(`\x1b[32m${value.trimEnd()}\x1b[0m\r`);
    };

    const printUpdateProgress = (value: string): boolean => {
      const clean = stripAnsi(value).trim();
      const match = clean.match(/^UpdateProgress:\s*(\d+)\/(\d+)\s*(.*)$/);
      if (!match) {
        return false;
      }
      const current = Number.parseInt(match[1], 10);
      const total = Math.max(1, Number.parseInt(match[2], 10));
      const label = (match[3] || "").trim();
      const ratio = Math.max(0, Math.min(1, current / total));
      const barWidth = 24;
      const filled = Math.round(ratio * barWidth);
      const bar = `${"#".repeat(filled)}${"-".repeat(barWidth - filled)}`;
      const percent = Math.round(ratio * 100);

      if (!updateProgressStarted.current) {
        term.write("\r\n");
      }
      updateProgressStarted.current = true;
      term.write(`\r\x1b[2K\x1b[32mUpdate: [${bar}] ${percent}%${label ? ` ${label}` : ""}\x1b[0m`);

      if (current >= total) {
        term.write("\r\n");
        updateProgressStarted.current = false;
      }
      return true;
    };

    const writeLine = (data: string, level: string | undefined, stream: TerminalStream) => {
      const text = data.endsWith("\n") || data.endsWith("\r") ? data : `${data}\r\n`;
      const normalized = (level ?? "").toUpperCase();

      if (normalized === "ERROR" || stream === "stderr") {
        term.write(`\x1b[91m${text}\x1b[0m`);
        return;
      }
      if (normalized === "WARNING") {
        term.write(`\x1b[33m${text}\x1b[0m`);
        return;
      }
      if (normalized === "SUCCESS") {
        term.write(`\x1b[32m${text}\x1b[0m`);
        return;
      }
      if (normalized === "BACKGROUND") {
        term.write(`\x1b[90m${text}\x1b[0m`);
        return;
      }
      if (normalized === "TEXT_RECEIVED") {
        term.write(`\x1b[36m${text}\x1b[0m`);
        return;
      }
      term.write(`\x1b[37m${text}\x1b[0m`);
    };

    const handleTerminalEvent = (payload: unknown, fallbackStream: TerminalStream) => {
      const event = parseTerminalPayload(payload, fallbackStream);
      const data = event.message ?? "";
      if (!data.trim()) {
        return;
      }

      if (data.includes("Python not found")) {
        onRequestConsole();
      }

      const level = event.level ?? parseLevelFromLine(data);
      const channel = inferChannel(event, level);

      if (consoleModeRef.current === "simple" && channel === "background") {
        return;
      }

      if (
        data.includes("Download:") ||
        data.includes("Downloading:") ||
        data.includes("Downloaded:")
      ) {
        printDownloadStatus(data);
        return;
      }

      if (
        data.startsWith("Transcription:") ||
        data.startsWith("Transcribe:") ||
        data.startsWith("VAD:") ||
        data.startsWith("Adjustment:")
      ) {
        printVADStatus(data);
        return;
      }

      if (printUpdateProgress(data)) {
        return;
      }

      resetInlineStatus();
      writeLine(data, level, event.stream ?? fallbackStream);
    };

    const offStdout = window.ipcRenderer.on(
      "terminal-output",
      (_event, payload) => {
        handleTerminalEvent(payload, "stdout");
      }
    );

    const offStderr = window.ipcRenderer.on(
      "terminal-error",
      (_event, payload) => {
        handleTerminalEvent(payload, "stderr");
      }
    );

    term.attachCustomKeyEventHandler((event) => {
      if (event.ctrlKey && event.code === "KeyC" && event.type === "keydown") {
        const selection = term.getSelection();
        if (selection) {
          window.clipboard.writeText(selection);
          return false;
        }
      }
      return true;
    });

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (term.hasSelection()) {
        window.clipboard.writeText(term.getSelection());
        term.select(0, 0, 0);
        return;
      }
      window.ipcRenderer.send("terminal-data", window.clipboard.readText());
    };

    const handleResize = () => {
      fitAddon.fit();
    };

    terminalRef.current.addEventListener("contextmenu", handleContextMenu);
    window.addEventListener("resize", handleResize);

    return () => {
      offStdout();
      offStderr();
      window.removeEventListener("resize", handleResize);
      terminalRef.current?.removeEventListener("contextmenu", handleContextMenu);
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
      }
      term.dispose();
      termInstanceRef.current = null;
      fitAddonRef.current = null;
    };
  }, [onRequestConsole]);

  useEffect(() => {
    if (!active) {
      return;
    }
    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current);
    }
    resizeTimerRef.current = setTimeout(() => {
      fitAddonRef.current?.fit();
    }, 100);
  }, [active]);

  return (
    <div className={`tab-panel ${active ? "active" : ""}`}>
      <div className="console-header">
        <button
          className="console-action-button"
          onClick={() => void openLogsFolder()}
          title="Open logs folder"
        >
          Open Logs Folder
        </button>
        <button
          className="console-action-button"
          onClick={() => void exportLogs()}
          title="Export logs to a zip archive"
        >
          Export Logs
        </button>
        <button
          className={`console-mode-toggle ${consoleMode}`}
          onClick={toggleConsoleMode}
          title={consoleMode === 'simple' ? 'Switch to Advanced logs (shows basic + background logs)' : 'Switch to Simple logs (hides background logs)'}
        >
          {consoleMode === 'simple' ? 'Mode: Simple' : 'Mode: Advanced'}
        </button>
      </div>
      <div className="console-container" ref={terminalRef} />
    </div>
  );
}

function PythonPanel({ onRequestConsole }: { onRequestConsole: () => void }) {
  const [pythonInfo, setPythonInfo] = useState({
    pythonVersion: "Loading...",
    pythonPath: "Loading...",
    pipVersion: "Loading..."
  });
  const [customPackage, setCustomPackage] = useState("");
  const [status, setStatus] = useState<{ message: string; type: string } | null>(
    null
  );
  const [expandedCards, setExpandedCards] = useState({
    cuda: true,
    gsm: true,
    custom: true,
    info: true
  });

  const showStatus = useCallback((message: string, type = "info") => {
    setStatus({ message, type });
    if (type === "success" || type === "error") {
      setTimeout(() => setStatus(null), 10000);
    }
  }, []);

  const loadPythonInfo = useCallback(async () => {
    const info = await window.ipcRenderer.invoke<{
      success: boolean;
      pythonVersion?: string;
      pythonPath?: string;
      pipVersion?: string;
    }>("python.getPythonInfo");

    if (info.success) {
      setPythonInfo({
        pythonVersion: info.pythonVersion ?? "Unknown",
        pythonPath: info.pythonPath ?? "Unknown",
        pipVersion: info.pipVersion ?? "Unknown"
      });
      return;
    }

    setPythonInfo({
      pythonVersion: "Error loading",
      pythonPath: "Error loading",
      pipVersion: "Error loading"
    });
  }, []);

  useEffect(() => {
    void loadPythonInfo();
  }, [loadPythonInfo]);

  const confirmAction = useCallback(
    async (options: {
      title: string;
      message: string;
      detail: string;
      confirmLabel: string;
    }) => {
      const response = await window.ipcRenderer.invoke<{ response: number }>(
        "show-message-box",
        {
          type: "warning",
          title: options.title,
          message: options.message,
          detail: options.detail,
          buttons: ["Cancel", options.confirmLabel],
          defaultId: 0,
          cancelId: 0
        }
      );
      return response.response === 1;
    },
    []
  );

  const runCudaInstall = useCallback(async () => {
    const confirmed = await confirmAction({
      title: "Install CUDA GPU Support",
      message: "Install CUDA GPU Support?",
      detail:
        "This installs onnxruntime-gpu for faster processing.\n\n- Requires additional storage\n- May not be compatible with all systems\n- Install at your own risk",
      confirmLabel: "Install"
    });

    if (!confirmed) {
      showStatus("CUDA installation cancelled.");
      return;
    }

    showStatus("Installing CUDA GPU support...");
    onRequestConsole();

    const result = await window.ipcRenderer.invoke<{ success: boolean; message: string }>(
      "python.installCudaPackage"
    );
    showStatus(result.message, result.success ? "success" : "error");
  }, [confirmAction, onRequestConsole, showStatus]);

  const runCudaUninstall = useCallback(async () => {
    const confirmed = await confirmAction({
      title: "Uninstall CUDA GPU Support",
      message: "Uninstall CUDA GPU Support?",
      detail:
        "This uninstalls onnxruntime-gpu and can fix GPU-related issues.",
      confirmLabel: "Uninstall"
    });

    if (!confirmed) {
      showStatus("CUDA uninstallation cancelled.");
      return;
    }

    showStatus("Uninstalling CUDA GPU support...");
    onRequestConsole();

    const result = await window.ipcRenderer.invoke<{ success: boolean; message: string }>(
      "python.uninstallCudaPackage"
    );
    showStatus(result.message, result.success ? "success" : "error");
  }, [confirmAction, onRequestConsole, showStatus]);

  const runResetDependencies = useCallback(async () => {
    const confirmed = await confirmAction({
      title: "Reset Python Dependencies",
      message: "Reset Python Dependencies?",
      detail:
        'This runs "uv sync" and restores dependency versions from the lockfile.',
      confirmLabel: "Reset"
    });

    if (!confirmed) {
      showStatus("Dependency reset cancelled.");
      return;
    }

    showStatus("Resetting Python dependencies...");
    onRequestConsole();

    const result = await window.ipcRenderer.invoke<{ success: boolean; message: string }>(
      "python.resetDependencies"
    );
    showStatus(result.message, result.success ? "success" : "error");
  }, [confirmAction, onRequestConsole, showStatus]);

  const installCustomPackage = useCallback(async () => {
    if (!customPackage.trim()) {
      showStatus("Please enter a package name.", "error");
      return;
    }

    showStatus(`Installing package: ${customPackage}...`);
    onRequestConsole();

    const result = await window.ipcRenderer.invoke<{ success: boolean; message: string }>(
      "python.installCustomPackage",
      customPackage.trim()
    );

    showStatus(result.message, result.success ? "success" : "error");
    if (result.success) {
      setCustomPackage("");
    }
  }, [customPackage, onRequestConsole, showStatus]);

  const toggleCard = (key: keyof typeof expandedCards) => {
    setExpandedCards((current) => ({ ...current, [key]: !current[key] }));
  };

  return (
    <div className="python-panel">
      <div className="python-grid">
        <div className="card">
          <button className="card-header" onClick={() => toggleCard("cuda")}>
            CUDA Installation
          </button>
          {expandedCards.cuda ? (
            <div className="card-body">
              <button className="danger" onClick={() => void runCudaInstall()}>
                Install CUDA GPU Support
              </button>
              <button className="danger" onClick={() => void runCudaUninstall()}>
                Uninstall CUDA Support
              </button>
            </div>
          ) : null}
        </div>

        <div className="card">
          <button className="card-header" onClick={() => toggleCard("gsm")}>
            GSM Management
          </button>
          {expandedCards.gsm ? (
            <div className="card-body">
              <button className="secondary" onClick={() => void runResetDependencies()}>
                Reset Python Dependencies
              </button>
            </div>
          ) : null}
        </div>

        <div className="card">
          <button className="card-header" onClick={() => toggleCard("custom")}>
            Custom Package Installation
          </button>
          {expandedCards.custom ? (
            <div className="card-body">
              <label htmlFor="custom-package-input">Package Name</label>
              <input
                id="custom-package-input"
                type="text"
                placeholder="numpy, requests, etc."
                value={customPackage}
                onChange={(event) => setCustomPackage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void installCustomPackage();
                  }
                }}
              />
              <button className="danger" onClick={() => void installCustomPackage()}>
                Install Package
              </button>
            </div>
          ) : null}
        </div>

        <div className="card">
          <button className="card-header" onClick={() => toggleCard("info")}>
            Python Environment Info
          </button>
          {expandedCards.info ? (
            <div className="card-body">
              <p>Python Version: {pythonInfo.pythonVersion}</p>
              <p>Python Path: {pythonInfo.pythonPath}</p>
              <p>Pip Version: {pythonInfo.pipVersion}</p>
              <button className="secondary" onClick={() => void loadPythonInfo()}>
                Refresh Info
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {status ? (
        <div className={`status-card ${status.type}`}>
          <p>{status.message}</p>
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("obs");
  const [showWizard, setShowWizard] = useState(false);
  const [wizardChecked, setWizardChecked] = useState(false);
  const [visibleControlledTabs, setVisibleControlledTabs] = useState<
    Record<ControlledTab, boolean>
  >({
    launcher: true,
    stats: true,
    python: true,
    console: true
  });

  const isTabVisible = useCallback(
    (tab: TabId) => {
      if (ALWAYS_VISIBLE_TABS.has(tab)) {
        return true;
      }
      if (isControlledTab(tab)) {
        return visibleControlledTabs[tab];
      }
      return true;
    },
    [visibleControlledTabs]
  );

  const visibleTabs = useMemo(
    () => TABS.filter((tab) => isTabVisible(tab.id)),
    [isTabVisible]
  );

  const selectTab = useCallback((tab: TabId) => {
    setActiveTab(tab);
    window.ipcRenderer.send("tab-changed", tab);
  }, []);

  const switchToConsole = useCallback(() => {
    setActiveTab("console");
  }, []);

  useEffect(() => {
    const loadSettings = async () => {
      const settings = await window.ipcRenderer.invoke<{
        visibleTabs?: string[];
      }>("settings.getSettings");
      const configured =
        settings?.visibleTabs?.filter((entry): entry is ControlledTab =>
          CONTROLLABLE_TABS.includes(entry as ControlledTab)
        ) ?? DEFAULT_VISIBLE_TABS;

      const next: Record<ControlledTab, boolean> = {
        launcher: false,
        stats: false,
        python: false,
        console: false
      };
      for (const tab of configured) {
        next[tab] = true;
      }
      setVisibleControlledTabs(next);
    };

    void loadSettings();
    const timer = setInterval(() => {
      void loadSettings();
    }, 500);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!isTabVisible(activeTab)) {
      setActiveTab("obs");
    }
  }, [activeTab, isTabVisible]);

  useEffect(() => {
    const offInstalling = window.ipcRenderer.on("installing", () => {
      setActiveTab("console");
    });
    return () => offInstalling();
  }, []);

  useEffect(() => {
    const platform = window.gsmEnv?.platform ?? "win32";
    const info = {
      platform,
      isWindows: platform === "win32",
      isMac: platform === "darwin",
      isLinux: platform === "linux",
      detectedAt: Date.now()
    };
    void window.ipcRenderer.invoke("state.set", "systemInfo", info);
  }, []);

  // Check if setup wizard should show (first launch)
  useEffect(() => {
    window.ipcRenderer
      .invoke<{ hasCompletedSetup?: boolean; setupWizardVersion?: number }>(
        "settings.getSettings"
      )
      .then((settings) => {
        if (!settings?.hasCompletedSetup) {
          setShowWizard(true);
        }
        setWizardChecked(true);
      });
  }, []);

  const handleWizardComplete = useCallback(() => {
    setShowWizard(false);
  }, []);

  return (
    <div className="app-root">
      {wizardChecked && showWizard && (
        <SetupWizard onComplete={handleWizardComplete} />
      )}
      <header className="tab-bar">
        <div className="tab-buttons">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              className={`tab-button ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => selectTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="header-links">
          <button
            className="icon-link"
            title="GitHub"
            aria-label="GitHub"
            onClick={() =>
              void window.ipcRenderer.invoke(
                "open-external",
                "https://github.com/bpwhelan/GameSentenceMiner"
              )
            }
          >
            <svg height="32" width="32" viewBox="0 0 24 24" fill="#888">
              <path d="M12 2C6.477 2 2 6.484 2 12.021c0 4.428 2.865 8.184 6.839 9.504.5.092.682-.217.682-.483 0-.237-.009-.868-.014-1.703-2.782.605-3.369-1.342-3.369-1.342-.454-1.157-1.11-1.465-1.11-1.465-.908-.62.069-.608.069-.608 1.004.07 1.532 1.032 1.532 1.032.892 1.53 2.341 1.088 2.91.832.091-.647.35-1.088.636-1.339-2.221-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.025A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.295 2.748-1.025 2.748-1.025.546 1.378.202 2.397.1 2.65.64.7 1.028 1.595 1.028 2.688 0 3.847-2.337 4.695-4.566 4.944.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.749 0 .268.18.579.688.481C19.138 20.2 22 16.448 22 12.021 22 6.484 17.523 2 12 2z" />
            </svg>
          </button>
          <button
            className="icon-link"
            title="Discord"
            aria-label="Discord"
            onClick={() =>
              void window.ipcRenderer.invoke(
                "open-external",
                "https://discord.gg/yP8Qse6bb8"
              )
            }
          >
            <svg height="32" width="32" viewBox="0 0 24 24" fill="#888">
              <path d="M20.317 4.369A19.791 19.791 0 0 0 16.885 3.2a.074.074 0 0 0-.079.037c-.34.607-.719 1.396-.984 2.013a18.524 18.524 0 0 0-5.614 0 12.51 12.51 0 0 0-.997-2.013.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.684 4.369a.069.069 0 0 0-.032.027C.533 9.09-.32 13.579.099 18.021a.082.082 0 0 0 .031.056c2.128 1.566 4.195 2.518 6.29 3.155a.077.077 0 0 0 .084-.027c.484-.662.917-1.362 1.291-2.104a.076.076 0 0 0-.041-.104c-.693-.263-1.353-.577-1.984-.942a.077.077 0 0 1-.008-.127c.133-.1.266-.203.392-.308a.074.074 0 0 1 .077-.01c4.172 1.905 8.683 1.905 12.813 0a.073.073 0 0 1 .078.009c.127.105.26.208.393.308a.077.077 0 0 1-.006.127 12.298 12.298 0 0 1-1.985.942.076.076 0 0 0-.04.105c.375.74.808 1.44 1.29 2.104a.076.076 0 0 0 .084.028c2.096-.637 4.163-1.589 6.291-3.155a.077.077 0 0 0 .03-.055c.5-5.177-.838-9.637-3.548-13.625a.061.061 0 0 0-.03-.028zM8.02 15.331c-1.183 0-2.156-1.085-2.156-2.419 0-1.333.955-2.418 2.156-2.418 1.21 0 2.175 1.095 2.156 2.418 0 1.334-.955 2.419-2.156 2.419zm7.974 0c-1.183 0-2.156-1.085-2.156-2.419 0-1.333.955-2.418 2.156-2.418 1.21 0 2.175 1.095 2.156 2.418 0 1.334-.946 2.419-2.156 2.419z" />
            </svg>
          </button>
        </div>
      </header>

      <main className="tab-content-area">
        <LegacyFrame src={getLegacyAssetPath("home.html")} active={activeTab === "obs"} />
        <LegacyFrame src={getLegacyAssetPath("ocr.html")} active={activeTab === "ocr"} />
        <StatsPanel active={activeTab === "stats"} />
        <LauncherTab active={activeTab === "launcher"} />
        <SettingsTab active={activeTab === "settings"} />
        <div className={`tab-panel ${activeTab === "python" ? "active" : ""}`}>
          <PythonPanel onRequestConsole={switchToConsole} />
        </div>
        <ConsolePanel
          active={activeTab === "console"}
          onRequestConsole={switchToConsole}
        />
      </main>
    </div>
  );
}

