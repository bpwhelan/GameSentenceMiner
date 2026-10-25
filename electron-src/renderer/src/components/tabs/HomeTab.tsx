import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { invokeIpc } from "../../lib/ipc";
import { useTranslation } from "../../i18n";
import { TextCaptureWizard } from "../TextCaptureWizard";
import { GameBackgroundSettings } from "../GameBackgroundSettings";
import { WorkspaceIcon } from "../Workspace";
import { HomeGameMenu } from "./HomeGameMenu";
import type { GsmStatus, ObsCaptureMode, ObsScene, ObsWindow } from "../../types/models";
import "./HomeTab.css";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface HomeTabProps {
  active: boolean;
  onNavigateTab?: (tab: "ocr" | "texthook" | "launcher" | "settings") => void;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const HELPER_SCENE_NAMES = new Set([
  "GSM HELPER",
  "GSM HELPER - DONT TOUCH",
  "GSM Helper",
  "GSM Helper - DONT TOUCH",
]);

const STATUS_POLL_MS = 1000;
const SCENE_POLL_MS = 3000;
const ANKI_BEACON_NUDGE_DELAY_MS = 15_000;

const DEFAULT_PROFILE_NAME = "Default";
const NEW_PROFILE_VALUE = "__new__";

interface GsmProfileList {
  profiles?: string[];
  currentProfile?: string;
  profileScenes?: Record<string, string[]>;
}

const OVERLAY_DOCS_URL =
  "https://docs.gamesentenceminer.com/docs/features/overlay";
const ANKI_BEACON_ANKIWEB_CODE = "1577021707";
const ANKI_BEACON_ANKIWEB_URL = `https://ankiweb.net/shared/info/${ANKI_BEACON_ANKIWEB_CODE}`;
const ANKI_BEACON_GITHUB_URL = "https://github.com/bpwhelan/AnkiBeacon";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const platform = (window.gsmEnv?.platform ?? "win32") as string;
const isWindows = platform === "win32";
const isLinux = platform === "linux";
const canEnumerateWindows = isWindows || isLinux;

function getDefaultCaptureMode(windowOption: ObsWindow | undefined | null): ObsCaptureMode {
  if (windowOption?.captureValues?.window_capture) return "window_capture";
  return "game_capture";
}

function isCaptureModeAvailable(
  windowOption: ObsWindow | undefined | null,
  mode: ObsCaptureMode,
): boolean {
  if (!windowOption || (windowOption.targetKind && windowOption.targetKind !== "window")) return false;
  return typeof windowOption.captureValues?.[mode] === "string";
}

function relativeTime(
  isoString: string | undefined | null,
  t: ReturnType<typeof useTranslation>,
): string {
  if (!isoString) return t("home.status.lastLineNotReceived");
  const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (Number.isNaN(diff)) return t("home.status.lastLineNotReceived");
  if (diff < 60) return t("home.status.timeSeconds", { n: diff });
  if (diff < 3600) return t("home.status.timeMinutes", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("home.status.timeHours", { n: Math.floor(diff / 3600) });
  return t("home.status.timeDays", { n: Math.floor(diff / 86400) });
}

function AddGameDialog({ children, busy, returnFocus, onClose }: {
  children: ReactNode;
  busy: boolean;
  returnFocus: HTMLElement | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = returnFocus ?? document.activeElement;
    const focusStart = () => {
      const control = dialog.querySelector<HTMLElement>("select:not(:disabled)") ?? dialog.querySelector<HTMLElement>("button:not(:disabled)");
      (control ?? dialog).focus();
    };
    const containFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) focusStart();
    };
    focusStart();
    document.addEventListener("focusin", containFocus);
    return () => {
      document.removeEventListener("focusin", containFocus);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected &&
          (document.activeElement === document.body || dialog.contains(document.activeElement))) previousFocus.focus();
    };
  }, [returnFocus]);

  return (
    <div
      ref={dialogRef}
      id="home-new-capture"
      className="capture-wizard-overlay home-add-game-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="home-new-game-heading"
      aria-describedby="home-new-game-hint"
      tabIndex={-1}
      onClick={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) onClose();
        } else if (event.key === "Tab") {
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), select:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]',
          ));
          const lastControl = controls[controls.length - 1];
          const destination = event.shiftKey && document.activeElement === controls[0] ? lastControl
            : !event.shiftKey && document.activeElement === lastControl ? controls[0] : null;
          if (destination) { event.preventDefault(); destination.focus(); }
        }
      }}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Status Bar                                                         */
/* ------------------------------------------------------------------ */

interface StatusPillProps {
  icon: string;
  label: string;
  text: string;
  variant: "ok" | "bad" | "neutral" | "warning";
  tooltip?: string;
  onClick?: () => void;
  clickable?: boolean;
}

function StatusPill({ icon, label, text, variant, tooltip, onClick, clickable }: StatusPillProps) {
  const content = (
    <>
      <span className="home-status-pill__icon"><WorkspaceIcon name={icon} /></span>
      <span className="home-status-pill__copy">
        <span className="home-status-pill__label">{label}</span>
        <span className="home-status-pill__text">{text}</span>
      </span>
      <span className="home-status-pill__dot" aria-hidden="true" />
      {clickable && <span className="home-status-pill__action" aria-hidden="true">›</span>}
    </>
  );
  const className = `home-status-pill home-status-pill--${variant}${clickable ? " home-status-pill--clickable" : ""}`;
  if (!clickable) {
    return <div className={className} data-tip={tooltip}>{content}</div>;
  }
  return (
    <button
      className={className}
      data-tip={tooltip}
      onClick={onClick}
      type="button"
    >
      {content}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  AnkiBeacon Modal                                                   */
/* ------------------------------------------------------------------ */

interface AnkiBeaconInstallResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

interface AnkiBeaconModalProps {
  onClose: () => void;
  beaconConnected: boolean;
}

function AnkiBeaconModal({ onClose, beaconConnected }: AnkiBeaconModalProps) {
  const t = useTranslation();
  const [installState, setInstallState] = useState<"idle" | "installing" | "success" | "detected" | "error">("idle");
  const [copied, setCopied] = useState(false);
  const installHasStarted = installState !== "idle";
  const showInstallButton = installState !== "success" && installState !== "detected";

  useEffect(() => {
    if (!beaconConnected) return undefined;
    setInstallState("detected");
    const id = window.setTimeout(onClose, 900);
    return () => window.clearTimeout(id);
  }, [beaconConnected, onClose]);

  const installNow = async () => {
    setInstallState("installing");
    setCopied(false);
    try {
      const result = await invokeIpc<AnkiBeaconInstallResult>("ankiBeacon.install");
      setInstallState(result?.success ? "success" : "error");
    } catch {
      setInstallState("error");
    }
  };

  const copyAnkiWebCode = () => {
    window.clipboard.writeText(ANKI_BEACON_ANKIWEB_CODE);
    setCopied(true);
  };

  const openExternalLink = (url: string) => {
    void invokeIpc("open-external-link", url);
  };

  return (
    <div
      className="home-modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
    >
      <div className="home-modal home-anki-beacon-modal" role="dialog" aria-modal="true" aria-labelledby="home-anki-beacon-title">
        <h3 id="home-anki-beacon-title">{t("home.ankiBeacon.title")}</h3>
        <p className="home-modal__desc">{t("home.ankiBeacon.description")}</p>
        <p className="home-modal__desc">{t("home.ankiBeacon.benefit")}</p>
        <div className="home-anki-beacon-links">
          <a
            href={ANKI_BEACON_ANKIWEB_URL}
            onClick={(e) => {
              e.preventDefault();
              openExternalLink(ANKI_BEACON_ANKIWEB_URL);
            }}
          >
            {t("home.ankiBeacon.ankiWebPage")}
          </a>
          <a
            href={ANKI_BEACON_GITHUB_URL}
            onClick={(e) => {
              e.preventDefault();
              openExternalLink(ANKI_BEACON_GITHUB_URL);
            }}
          >
            {t("home.ankiBeacon.githubPage")}
          </a>
        </div>

        {installState === "success" && (
          <div className="home-modal__notice home-modal__notice--success">
            <p>{t("home.ankiBeacon.installStarted")}</p>
            <div className="home-anki-beacon-waiting">
              <span className="home-anki-beacon-waiting__dot" aria-hidden="true" />
              <span>{t("home.ankiBeacon.waitingSignal")}</span>
            </div>
          </div>
        )}

        {installState === "detected" && (
          <div className="home-modal__notice home-modal__notice--success">
            {t("home.ankiBeacon.signalDetected")}
          </div>
        )}

        {installState === "error" && (
          <div className="home-modal__notice home-modal__notice--warning">
            <p>{t("home.ankiBeacon.installFailed")}</p>
            <p>{t("home.ankiBeacon.manualInstall")}</p>
            <button type="button" className="home-copy-code-btn" onClick={copyAnkiWebCode}>
              {copied
                ? t("home.ankiBeacon.codeCopied", { code: ANKI_BEACON_ANKIWEB_CODE })
                : t("home.ankiBeacon.copyCode", { code: ANKI_BEACON_ANKIWEB_CODE })}
            </button>
          </div>
        )}

        <div className="home-modal__actions">
          <button type="button" className="secondary" onClick={onClose} autoFocus>
            {t(installHasStarted ? "home.ankiBeacon.close" : "home.ankiBeacon.later")}
          </button>
          {showInstallButton && (
            <button
              type="button"
              onClick={() => void installNow()}
              disabled={installState === "installing"}
            >
              {installState === "installing"
                ? t("home.ankiBeacon.installing")
                : t("home.ankiBeacon.installNow")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Rename Modal                                                       */
/* ------------------------------------------------------------------ */

interface RenameModalProps {
  scene: ObsScene | null;
  onClose: () => void;
  onConfirm: (newName: string) => void;
}

function RenameModal({ scene, onClose, onConfirm }: RenameModalProps) {
  const t = useTranslation();
  const [name, setName] = useState(scene?.name ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(scene?.name ?? "");
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, [scene]);

  if (!scene) return null;

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== scene.name) {
      onConfirm(trimmed);
    } else {
      onClose();
    }
  };

  return (
    <div
      className="home-modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="home-modal" role="dialog" aria-modal="true" aria-labelledby="home-rename-title">
        <h3 id="home-rename-title">{t("home.rename.title")}</h3>
        <p className="home-modal__desc">{t("home.rename.description")}</p>
        <input
          ref={inputRef}
          className="home-input"
          type="text"
          aria-label={t("home.rename.title")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submit(); }
            if (e.key === "Escape") { e.preventDefault(); onClose(); }
          }}
          autoComplete="off"
        />
        <div className="home-modal__actions">
          <button type="button" className="secondary" onClick={onClose}>
            {t("home.rename.cancel")}
          </button>
          <button type="button" onClick={submit}>
            {t("home.rename.confirm")}
          </button>
        </div>
      </div>
      </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main HomeTab                                                       */
/* ------------------------------------------------------------------ */

export function HomeTab({ active, onNavigateTab }: HomeTabProps) {
  const t = useTranslation();

  /* ---- Status ---------------------------------------------------- */
  const [status, setStatus] = useState<GsmStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [overlayRunning, setOverlayRunning] = useState(false);
  const [runOverlayOnStartup, setRunOverlayOnStartup] = useState(false);
  const [runOverlayWithActiveGame, setRunOverlayWithActiveGame] = useState(false);
  const [overlaySettingsSaving, setOverlaySettingsSaving] = useState(false);
  const [overlaySettingsLoaded, setOverlaySettingsLoaded] = useState(false);
  const [overlaySettingsError, setOverlaySettingsError] = useState(false);
  const [ankiBeaconModalOpen, setAnkiBeaconModalOpen] = useState(false);
  const [ankiBeaconNudgeReady, setAnkiBeaconNudgeReady] = useState(false);
  const ankiApiConnected = status?.anki_connected === true;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const s = await invokeIpc<GsmStatus | null>("get_gsm_status");
        if (!cancelled) { setStatus(s); setStatusError(false); }
      } catch {
        if (!cancelled) { setStatus(null); setStatusError(true); }
      }
      try {
        const o = await invokeIpc<{ isRunning: boolean }>("getOverlayStatus");
        if (!cancelled) setOverlayRunning(Boolean(o?.isRunning));
      } catch { /* swallow */ }
    };

    void poll();
    const id = setInterval(() => void poll(), STATUS_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [active]);

  useEffect(() => {
    setAnkiBeaconNudgeReady(false);
    if (!active || !ankiApiConnected) return undefined;
    const id = window.setTimeout(() => setAnkiBeaconNudgeReady(true), ANKI_BEACON_NUDGE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [active, ankiApiConnected]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    setOverlaySettingsLoaded(false);
    void invokeIpc<{ runOverlayOnStartup?: boolean; runOverlayWithActiveGame?: boolean }>("settings.getSettings")
      .then((settings) => {
        if (!cancelled) {
          setRunOverlayOnStartup(settings?.runOverlayOnStartup === true);
          setRunOverlayWithActiveGame(settings?.runOverlayWithActiveGame === true);
          setOverlaySettingsLoaded(true);
          setOverlaySettingsError(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRunOverlayOnStartup(false);
          setOverlaySettingsError(true);
        }
      });

    return () => { cancelled = true; };
  }, [active]);

  /* ---- Scenes ---------------------------------------------------- */
  const [scenes, setScenes] = useState<ObsScene[]>([]);
  const [selectedSceneId, setSelectedSceneId] = useState<string>("");
  const [renameTarget, setRenameTarget] = useState<ObsScene | null>(null);
  const [selectedSceneCaptureMode, setSelectedSceneCaptureMode] = useState<ObsCaptureMode | null>(null);
  const [newCaptureOpen, setNewCaptureOpen] = useState(false);
  const [sceneCreating, setSceneCreating] = useState(false);
  const [sceneCreateError, setSceneCreateError] = useState(false);
  const addGameTriggerRef = useRef<HTMLButtonElement | null>(null);
  const openNewCapture = useCallback((trigger: HTMLButtonElement) => {
    addGameTriggerRef.current = trigger;
    setNewCaptureOpen(true);
  }, []);
  const [gameSearch, setGameSearch] = useState("");
  const selectedGameRef = useRef<HTMLButtonElement>(null);
  const [gameMenu, setGameMenu] = useState<{ scene: ObsScene; anchor: HTMLButtonElement } | null>(null);
  const closeGameMenu = useCallback(() => setGameMenu(null), []);

  useEffect(() => {
    if (!active || (gameMenu && !scenes.some(scene => scene.id === gameMenu.scene.id))) setGameMenu(null);
  }, [active, scenes, gameMenu]);

  /* ---- Windows --------------------------------------------------- */
  const [windows, setWindows] = useState<ObsWindow[]>([]);
  const [selectedWindowValue, setSelectedWindowValue] = useState<string>("");
  const [selectedCaptureMode, setSelectedCaptureMode] = useState<ObsCaptureMode>("window_capture");
  const [overrideSceneName, setOverrideSceneName] = useState("");
  const [captureCardEnabled, setCaptureCardEnabled] = useState(false);
  const [captureWizardOpen, setCaptureWizardOpen] = useState(false);
  const [captureWizardScene, setCaptureWizardScene] = useState<ObsScene | null>(null);

  /* ---- Game executable (Linux Wine/Proton target, per-scene) ----- */
  const [gameExePath, setGameExePath] = useState("");
  const [windowsDetectedExe, setWindowsDetectedExe] = useState("");
  const [gameExeDetecting, setGameExeDetecting] = useState(false);

  /* ---- GSM profiles ---------------------------------------------- */
  const [gsmProfiles, setGsmProfiles] = useState<string[]>([]);
  const [profileScenes, setProfileScenes] = useState<Record<string, string[]>>({});
  const [profileAssigning, setProfileAssigning] = useState(false);
  const [newProfileMode, setNewProfileMode] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");

  /* ---- Loaders --------------------------------------------------- */
  const [scenesLoading, setScenesLoading] = useState(true);
  const [windowsLoading, setWindowsLoading] = useState(true);

  const loadScenes = useCallback(async () => {
    setScenesLoading(true);
    try {
      const obsScenes = await invokeIpc<ObsScene[]>("obs.getScenes");
      setScenes(obsScenes ?? []);
      const activeScene = await invokeIpc<ObsScene | null>("obs.getActiveScene");
      if (activeScene) setSelectedSceneId(activeScene.id);
    } catch { /* swallow */ }
    setScenesLoading(false);
  }, []);

  const loadWindows = useCallback(async (quick = false) => {
    if (!canEnumerateWindows) return;
    setWindowsLoading(true);
    try {
      const res = await invokeIpc<ObsWindow[]>("obs.getWindows", { quick });
      setWindows(res ?? []);
      if (res?.length) {
        setSelectedWindowValue((prev) => {
          const currentWindow = res.find((w) => w.value === prev);
          if (currentWindow) {
            setSelectedCaptureMode((prevMode) =>
              isCaptureModeAvailable(currentWindow, prevMode)
                ? prevMode
                : getDefaultCaptureMode(currentWindow),
            );
            return prev;
          }
          setSelectedCaptureMode("window_capture");
          return "";
        });
      }
    } catch { /* swallow */ }
    setWindowsLoading(false);
  }, []);

  const loadGsmProfiles = useCallback(async () => {
    try {
      const result = await invokeIpc<GsmProfileList | null>("settings.listGSMProfiles");
      setGsmProfiles(Array.isArray(result?.profiles) ? result.profiles : []);
      setProfileScenes(
        result?.profileScenes && typeof result.profileScenes === "object"
          ? result.profileScenes
          : {},
      );
    } catch { /* swallow */ }
  }, []);

  const refreshAll = useCallback(
    async (quick = false) => {
      await loadScenes();
      await loadWindows(quick);
      await loadGsmProfiles();
    },
    [loadScenes, loadWindows, loadGsmProfiles],
  );

  const handleWindowSelectionChange = useCallback((value: string) => {
    setSelectedWindowValue(value);
    const win = windows.find((candidate) => candidate.value === value);
    setSelectedCaptureMode(getDefaultCaptureMode(win));
    setOverrideSceneName(win?.suggestedSceneName || win?.title || "");
  }, [windows]);

  // Initial fetch + polling
  useEffect(() => {
    if (!active) return;
    void refreshAll(true);
    const id = setInterval(() => void refreshAll(true), SCENE_POLL_MS);
    return () => clearInterval(id);
  }, [active, refreshAll]);

  // Capture card probe state
  useEffect(() => {
    if (!active) return;
    invokeIpc<boolean>("obs.getCaptureCardProbeEnabled")
      .then((v) => setCaptureCardEnabled(Boolean(v)))
      .catch(() => setCaptureCardEnabled(false));
  }, [active]);

  // Clear stale override state if the selection disappears during a refresh.
  useEffect(() => {
    if (!selectedWindowValue) {
      setOverrideSceneName("");
    }
  }, [selectedWindowValue]);

  // Leave "new profile" entry mode whenever the active scene changes.
  useEffect(() => {
    setNewProfileMode(false);
    setNewProfileName("");
  }, [selectedSceneId]);

  /* ---- Scene actions --------------------------------------------- */
  const selectedScene = scenes.find((s) => s.id === selectedSceneId) ?? null;
  const isHelperScene = selectedScene ? HELPER_SCENE_NAMES.has(selectedScene.name) : true;
  const userScenes = scenes.filter((s) => !HELPER_SCENE_NAMES.has(s.name));
  const hasUserScenes = userScenes.length > 0;
  const filteredScenes = userScenes.filter((scene) =>
    scene.name.toLocaleLowerCase().includes(gameSearch.trim().toLocaleLowerCase()),
  );

  useEffect(() => {
    if (active && !newCaptureOpen) selectedGameRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [active, selectedSceneId, newCaptureOpen, gameSearch]);

  /* ---- Scene profile mapping ------------------------------------- */
  const otherProfilesExist = gsmProfiles.some((p) => p !== DEFAULT_PROFILE_NAME);
  // A scene that isn't explicitly assigned to any profile effectively runs under Default.
  const sceneProfile = selectedScene
    ? gsmProfiles.find((p) => (profileScenes[p] ?? []).includes(selectedScene.name)) ?? DEFAULT_PROFILE_NAME
    : DEFAULT_PROFILE_NAME;
  const showSceneProfileRow = Boolean(otherProfilesExist && selectedScene && !isHelperScene);

  const selectedWindow = windows.find((w) => w.value === selectedWindowValue) ?? null;
  const isCaptureCardSelection = selectedWindow?.targetKind === "capture_card";
  const isMonitorSelection = selectedWindow?.targetKind === "monitor";
  const isWaylandPipewireSelection = selectedWindow?.targetKind === "wayland_pipewire";
  const canUseWindowCapture = isCaptureModeAvailable(selectedWindow, "window_capture");
  const canUseGameCapture = isCaptureModeAvailable(selectedWindow, "game_capture");
  const canSelectCaptureMode = Boolean(
    selectedWindow && isWindows && (selectedWindow.targetKind ?? "window") === "window",
  );
  const canCreateScene = Boolean(
    canEnumerateWindows &&
      selectedWindow &&
      (isCaptureCardSelection || isMonitorSelection || isLinux ||
        isCaptureModeAvailable(selectedWindow, selectedCaptureMode)),
  );

  useEffect(() => {
    if (!active || !selectedSceneId) {
      setSelectedSceneCaptureMode(null);
      return;
    }

    let cancelled = false;
    invokeIpc<ObsCaptureMode | null>("obs.getSceneCaptureMode", selectedSceneId)
      .then((mode) => {
        if (!cancelled) {
          setSelectedSceneCaptureMode(mode === "window_capture" || mode === "game_capture" ? mode : null);
        }
      })
      .catch(() => {
        if (!cancelled) setSelectedSceneCaptureMode(null);
      });

    return () => { cancelled = true; };
  }, [active, selectedSceneId]);

  // Load the per-scene game executable path (Linux) when the selected scene changes.
  useEffect(() => {
    const name = selectedScene?.name;
    if (!active || !isLinux || !name || isHelperScene) {
      setGameExePath("");
      return;
    }
    let cancelled = false;
    invokeIpc<string>("texthook.getGameExePath", name)
      .then((p) => { if (!cancelled) setGameExePath(typeof p === "string" ? p : ""); })
      .catch(() => { if (!cancelled) setGameExePath(""); });
    return () => { cancelled = true; };
  }, [active, selectedSceneId, isHelperScene, selectedScene?.name]);

  // On Windows the executable is informational only — read it from the OBS capture.
  useEffect(() => {
    if (!active || !isWindows) {
      setWindowsDetectedExe("");
      return;
    }
    let cancelled = false;
    invokeIpc<{ exeName?: string | null }>("texthook.getActiveCapture")
      .then((c) => { if (!cancelled) setWindowsDetectedExe(c?.exeName ?? ""); })
      .catch(() => { if (!cancelled) setWindowsDetectedExe(""); });
    return () => { cancelled = true; };
  }, [active, selectedSceneId]);

  const persistGameExePath = useCallback(async (value: string) => {
    const name = selectedScene?.name;
    if (!name) return;
    try {
      await invokeIpc("texthook.setGameExePath", { sceneName: name, path: value });
    } catch { /* swallow */ }
  }, [selectedScene?.name]);

  const handleBrowseGameExe = useCallback(async () => {
    try {
      const res = await invokeIpc<{ canceled: boolean; path: string }>("texthook.browseGameExe");
      if (res && !res.canceled && res.path) {
        setGameExePath(res.path);
        await persistGameExePath(res.path);
      }
    } catch { /* swallow */ }
  }, [persistGameExePath]);

  const handleAutoDetectGameExe = useCallback(async () => {
    setGameExeDetecting(true);
    try {
      const res = await invokeIpc<{ path: string; error?: string }>("texthook.autoDetectGameExe");
      if (res?.path) {
        setGameExePath(res.path);
        await persistGameExePath(res.path);
      }
    } catch { /* swallow */ } finally {
      setGameExeDetecting(false);
    }
  }, [persistGameExePath]);

  const handleSceneChange = useCallback((id: string) => {
    setSelectedSceneId(id);
    setNewCaptureOpen(false);
    if (id) void invokeIpc("obs.switchScene.id", id);
  }, []);

  const handleSceneProfileChange = useCallback(
    async (value: string) => {
      const sceneName = selectedScene?.name;
      if (!sceneName) return;
      if (value === NEW_PROFILE_VALUE) {
        setNewProfileName("");
        setNewProfileMode(true);
        return;
      }
      // Optimistically move the scene to the chosen profile (exclusive).
      setProfileScenes((prev) => {
        const next: Record<string, string[]> = {};
        for (const [profile, sceneList] of Object.entries(prev)) {
          next[profile] = sceneList.filter((s) => s !== sceneName);
        }
        next[value] = [...(next[value] ?? []), sceneName];
        return next;
      });
      setProfileAssigning(true);
      try {
        await invokeIpc("settings.relateSceneToProfile", {
          sceneName,
          profileName: value,
          createNew: false,
        });
      } catch { /* swallow */ } finally {
        setProfileAssigning(false);
      }
    },
    [selectedScene],
  );

  const handleCreateProfileForScene = useCallback(async () => {
    const sceneName = selectedScene?.name;
    const name = newProfileName.trim();
    if (!sceneName || !name) return;
    setProfileAssigning(true);
    try {
      await invokeIpc("settings.relateSceneToProfile", {
        sceneName,
        profileName: name,
        createNew: true,
      });
      // Optimistically reflect the new profile + assignment.
      setGsmProfiles((prev) => (prev.includes(name) ? prev : [...prev, name]));
      setProfileScenes((prev) => {
        const next: Record<string, string[]> = {};
        for (const [profile, sceneList] of Object.entries(prev)) {
          next[profile] = sceneList.filter((s) => s !== sceneName);
        }
        next[name] = [...(next[name] ?? []), sceneName];
        return next;
      });
      setNewProfileMode(false);
      setNewProfileName("");
    } catch { /* swallow */ } finally {
      setProfileAssigning(false);
    }
  }, [newProfileName, selectedScene]);

  const handleRemoveScene = useCallback(async (scene: ObsScene) => {
    await invokeIpc("obs.removeScene", scene.id);
    await refreshAll();
  }, [refreshAll]);

  const handleRenameConfirm = useCallback(
    async (newName: string) => {
      if (!renameTarget) return;
      await invokeIpc("obs.renameScene", {
        sceneUuid: renameTarget.id,
        newSceneName: newName,
      });
      setRenameTarget(null);
      await refreshAll();
    },
    [renameTarget, refreshAll],
  );

  const handleSwitchCaptureMode = useCallback(async (scene: ObsScene, mode: ObsCaptureMode) => {
    const targetMode: ObsCaptureMode =
      mode === "window_capture" ? "game_capture" : "window_capture";
    const result = await invokeIpc<ObsCaptureMode | null>("obs.switchSceneCaptureMode", {
      sceneUuid: scene.id,
      targetMode,
    });
    if (scene.id === selectedSceneId) setSelectedSceneCaptureMode(result === "window_capture" || result === "game_capture" ? result : null);
    await refreshAll();
  }, [selectedSceneId, refreshAll]);

  const handleOpenCaptureWizard = useCallback(() => {
    if (!selectedScene || isHelperScene) return;
    setCaptureWizardScene(selectedScene);
    setCaptureWizardOpen(true);
  }, [isHelperScene, selectedScene]);

  const handleCreateScene = useCallback(async () => {
    const win = selectedWindow;
    if (!win || sceneCreating) return;
    setSceneCreating(true);
    setSceneCreateError(false);
    try {
      const payload = {
        title: win.title,
        value: win.value,
        sceneName: overrideSceneName.trim() || win.title,
        targetKind: win.targetKind ?? "window",
        captureMode: canSelectCaptureMode ? selectedCaptureMode : undefined,
        captureValues: win.captureValues ?? {},
        videoDeviceId: win.videoDeviceId,
        audioDeviceId: win.audioDeviceId,
        wasapiInputDeviceId: win.wasapiInputDeviceId,
        monitorId: win.monitorId,
        pipewireInputKind: win.pipewireInputKind,
      };
      await invokeIpc("obs.createScene", payload);
      await refreshAll();
      setNewCaptureOpen(false);
      setGameSearch("");

      try {
        const [settings, activeScene] = await Promise.all([
          invokeIpc<{ textCaptureWizardEnabled?: boolean }>("settings.getSettings"),
          invokeIpc<ObsScene | null>("obs.getActiveScene")
        ]);
        if (settings?.textCaptureWizardEnabled === false) return;
        setCaptureWizardScene(activeScene ?? null);
        setCaptureWizardOpen(true);
      } catch {
        setCaptureWizardScene(null);
        setCaptureWizardOpen(true);
      }
    } catch {
      setSceneCreateError(true);
    } finally {
      setSceneCreating(false);
    }
  }, [selectedWindow, overrideSceneName, selectedCaptureMode, canSelectCaptureMode, refreshAll, sceneCreating]);

  const handleCaptureCardToggle = useCallback(async (enabled: boolean) => {
    try {
      const result = await invokeIpc<boolean>("obs.setCaptureCardProbeEnabled", enabled);
      setCaptureCardEnabled(Boolean(result));
      await loadWindows();
    } catch {
      setCaptureCardEnabled(!enabled);
    }
  }, [loadWindows]);

  const handleCaptureWizardClose = useCallback(() => {
    setCaptureWizardOpen(false);
    setCaptureWizardScene(null);
    void refreshAll();
  }, [refreshAll]);

  /* ---- Actions --------------------------------------------------- */
  const openGSMSettings = useCallback(() => void invokeIpc("settings.openGSMSettings"), []);
  const openTexthooker = useCallback(() => void invokeIpc("openTexthooker"), []);
  const runOverlay = useCallback(() => void invokeIpc("runOverlay"), []);
  const openOverlaySettings = useCallback(() => void invokeIpc("settings.openOverlaySettings"), []);
  const openOBS = useCallback(() => void invokeIpc("openOBS"), []);
  const openAnkiBeaconModal = useCallback(() => setAnkiBeaconModalOpen(true), []);
  const closeAnkiBeaconModal = useCallback(() => setAnkiBeaconModalOpen(false), []);
  const openExternal = useCallback((url: string) => void invokeIpc("open-external-link", url), []);
  const handleOverlayAutomationChange = useCallback(async (
    key: "runOverlayOnStartup" | "runOverlayWithActiveGame", enabled: boolean,
  ) => {
    const previousStartup = runOverlayOnStartup;
    const previousActiveGame = runOverlayWithActiveGame;
    setOverlaySettingsSaving(true);
    setOverlaySettingsError(false);
    if (key === "runOverlayOnStartup") {
      setRunOverlayOnStartup(enabled);
      if (enabled) setRunOverlayWithActiveGame(false);
    } else {
      setRunOverlayWithActiveGame(enabled);
      if (enabled) setRunOverlayOnStartup(false);
    }
    try {
      const result = await invokeIpc<{
        success: boolean;
        settings?: { runOverlayOnStartup?: boolean; runOverlayWithActiveGame?: boolean };
      }>("settings.saveSettings", { [key]: enabled });
      if (!result?.success) throw new Error("Overlay settings could not be saved");
      if (typeof result?.settings?.runOverlayOnStartup === "boolean") {
        setRunOverlayOnStartup(result.settings.runOverlayOnStartup);
      }
      if (typeof result?.settings?.runOverlayWithActiveGame === "boolean") {
        setRunOverlayWithActiveGame(result.settings.runOverlayWithActiveGame);
      }
    } catch {
      setRunOverlayOnStartup(previousStartup);
      setRunOverlayWithActiveGame(previousActiveGame);
      setOverlaySettingsError(true);
    } finally {
      setOverlaySettingsSaving(false);
    }
  }, [runOverlayOnStartup, runOverlayWithActiveGame]);

  /* ---- Derived status values ------------------------------------- */
  const gsmReady = status?.ready ?? false;
  const obsOk = status?.obs_connected ?? false;
  const ankiApiOk = ankiApiConnected;
  const ankiBeaconOk = status?.anki_beacon_connected ?? false;
  const ankiOk = ankiApiOk || ankiBeaconOk;
  const clipEnabled = status?.clipboard_enabled ?? false;
  const wsConnected = status?.websockets_connected ?? {};
  const wsEntries = Object.entries(wsConnected);
  const anyWs = wsEntries.length > 0;

  const wordsProcessing = Array.isArray(status?.words_being_processed)
    ? status.words_being_processed
    : status?.words_being_processed
      ? [status.words_being_processed]
      : [];

  let gsmText: string;
  if (statusError || status === null) {
    gsmText = status === null && !statusError
      ? t("home.status.installing")
      : t("home.status.error");
  } else if (wordsProcessing.length > 0) {
    gsmText = t("home.status.processing", { words: wordsProcessing.join(", ") });
  } else {
    gsmText = gsmReady ? (status.status || t("home.status.running")) : t("home.status.notRunning");
  }

  const showAnkiBeaconNudge = ankiBeaconNudgeReady && ankiOk && !ankiBeaconOk;
  const ankiText = ankiOk
    ? showAnkiBeaconNudge
      ? t("home.ankiBeacon.statusMissing")
      : t("home.status.connected")
    : t("home.status.disconnected");
  const ankiVariant: StatusPillProps["variant"] = ankiOk
    ? showAnkiBeaconNudge
      ? "warning"
      : "ok"
    : "bad";
  const ankiTooltip = ankiBeaconOk
    ? t("home.ankiBeacon.tooltipConnected")
    : showAnkiBeaconNudge
      ? t("home.ankiBeacon.tooltipMissing")
      : ankiOk
        ? t("home.status.tooltipAnkiConnected")
        : t("home.status.tooltipAnkiDisconnected");

  const gsmVariant: StatusPillProps["variant"] =
    statusError ? "bad" : gsmReady ? "ok" : "neutral";

  const lastLineStr = relativeTime(status?.last_line_received, t);

  const gsmTooltip = gsmReady
    ? t("home.status.tooltipGsm", {
        status: status?.status ?? "",
        websockets: wsEntries.length ? wsEntries.map(([, n]) => n).join(", ") : "None",
        obs: obsOk ? t("home.status.connected") : t("home.status.disconnected"),
        anki: ankiOk ? t("home.status.connected") : t("home.status.disconnected"),
        lastLine: lastLineStr,
      })
    : t("home.status.tooltipGsmStopped");

  let clipText: string;
  let clipTooltip: string;
  if (clipEnabled) {
    clipText = t("home.status.enabled");
    clipTooltip = t("home.status.tooltipClipboardEnabled");
  } else if (anyWs) {
    clipText = t("home.status.disabledWebSocket");
    clipTooltip = t("home.status.tooltipClipboardDisabledWs");
  } else {
    clipText = t("home.status.disabled");
    clipTooltip = t("home.status.tooltipClipboardDisabled");
  }

  /* ---- Capture target groupings ---------------------------------- */
  const windowTargets = windows.filter(
    (w) => w.targetKind !== "capture_card" && w.targetKind !== "monitor",
  );
  const captureCardTargets = windows.filter((w) => w.targetKind === "capture_card");
  const monitorTargets = windows.filter((w) => w.targetKind === "monitor");

  const overlaySection = (
    <section className="home-overlay-card" aria-labelledby="home-overlay-heading">
      <div className="home-section-heading">
        <h2 id="home-overlay-heading"><WorkspaceIcon name="layout" />{t("home.overlay.title")}</h2>
        <span
          className={`home-overlay-card__status ${
            overlayRunning
              ? "home-overlay-card__status--running"
              : "home-overlay-card__status--stopped"
          }`}
        >
          {overlayRunning
            ? t("home.overlay.statusRunning")
            : t("home.overlay.statusStopped")}
        </span>
      </div>
      <p className="home-section-hint">{t("home.workspace.overlayHint")}</p>
      <div className="home-section-body">
        <div className="home-overlay-card__controls">
          <div className="home-overlay-card__actions">
            <button
              type="button"
              className="home-overlay-primary-btn"
              onClick={overlayRunning ? openOverlaySettings : runOverlay}
              data-tip={
                overlayRunning
                  ? t("home.actions.overlaySettingsTooltip")
                  : t("home.actions.overlayTooltip")
              }
            >
              <WorkspaceIcon name={overlayRunning ? "settings" : "play"} />
              {overlayRunning ? t("home.actions.overlaySettings") : t("home.actions.overlay")}
            </button>
            <button
              type="button"
              className="home-quick-btn home-overlay-guide-btn"
              onClick={() => openExternal(OVERLAY_DOCS_URL)}
              data-tip={t("home.actions.overlayWiki")}
            >
              {t("home.overlay.guide")}
            </button>
          </div>
          <div className="home-overlay-card__automation">
            <label
              className="home-toggle home-overlay-card__startup"
              htmlFor="home-overlay-active-game-toggle"
              data-tip={t("home.overlay.runWithActiveGameTooltip")}
            >
              <input
                id="home-overlay-active-game-toggle"
                type="checkbox"
                checked={runOverlayWithActiveGame}
                disabled={!overlaySettingsLoaded || overlaySettingsSaving}
                onChange={(e) => void handleOverlayAutomationChange("runOverlayWithActiveGame", e.target.checked)}
              />
              <span>{t("home.overlay.runWithActiveGame")}</span>
              <span className="home-overlay-card__recommended">{t("home.overlay.recommended")}</span>
            </label>
            <label
              className="home-toggle home-overlay-card__startup"
              htmlFor="home-overlay-startup-toggle"
              data-tip={t("home.overlay.runOnStartupTooltip")}
            >
              <input
                id="home-overlay-startup-toggle"
                type="checkbox"
                checked={runOverlayOnStartup}
                disabled={!overlaySettingsLoaded || overlaySettingsSaving}
                onChange={(e) => void handleOverlayAutomationChange("runOverlayOnStartup", e.target.checked)}
              />
              <span>{t("home.overlay.runOnStartup")}</span>
            </label>
            {overlaySettingsError ? <p role="alert">{t("home.overlay.settingsError")}</p> : null}
          </div>
        </div>
        {!isWindows && (
          <span className="home-overlay-card__warning">
            {t("home.actions.overlayPlatformWarning")}
          </span>
        )}
      </div>
    </section>
  );

  const setupSection = (
    <form className="capture-wizard-card home-add-game-card" aria-busy={sceneCreating}
      onSubmit={(event) => { event.preventDefault(); if (canCreateScene) void handleCreateScene(); }}>
      <div className="capture-wizard-header">
        <div>
          <h2 id="home-new-game-heading">{t("home.workspace.addGame")}</h2>
          <p id="home-new-game-hint">{t(hasUserScenes ? "home.workspace.addGameHint" : "home.workspace.firstGameHint")}</p>
        </div>
        <button type="button" className="secondary home-add-game-close" disabled={sceneCreating}
          aria-label={t("home.rename.cancel")} onClick={() => setNewCaptureOpen(false)}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div className="capture-wizard-body home-section-body">
        {/* Capture target selector */}
        <div className="home-row">
          <label className="home-row__label" htmlFor="home-window-select">
            {t("home.obs.captureTargetLabel")}
          </label>
          <div className="home-row__controls">
            <select
              id="home-window-select"
              className="home-select"
              value={selectedWindowValue}
              disabled={!canEnumerateWindows || sceneCreating}
              data-tip={!canEnumerateWindows ? t("home.obs.notSupportedTooltip") : undefined}
              onChange={(e) => handleWindowSelectionChange(e.target.value)}
            >
              {!canEnumerateWindows && (
                <option>{t("home.obs.notSupportedOS")}</option>
              )}
              {canEnumerateWindows && windows.length > 0 && (
                <option value="" disabled>{t("home.obs.selectWindow")}</option>
              )}
              {windowsLoading && windows.length === 0 && canEnumerateWindows && (
                <option>{t("home.obs.loading")}</option>
              )}
              {windows.length === 0 && !windowsLoading && canEnumerateWindows && (
                <option value="">{t("home.obs.noCaptureTargets")}</option>
              )}
              {windowTargets.length > 0 && (
                <optgroup label={t("home.obs.sectionWindows")}>
                  {windowTargets.map((w) => (
                    <option key={w.value} value={w.value}>
                      {w.targetKind === "wayland_pipewire"
                        ? t("home.obs.waylandPipewireOption")
                        : w.title}
                    </option>
                  ))}
                </optgroup>
              )}
              {monitorTargets.length > 0 && (
                <optgroup label={t("home.obs.sectionMonitors")}>
                  {monitorTargets.map((w) => (
                    <option key={w.value} value={w.value}>{w.title}</option>
                  ))}
                </optgroup>
              )}
              {captureCardTargets.length > 0 && (
                <optgroup label={t("home.obs.sectionCaptureCards")}>
                  {captureCardTargets.map((w) => (
                    <option key={w.value} value={w.value}>
                      {t("home.obs.captureCardPrefix", { title: w.title })}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <button
              type="button"
              className="home-icon-btn"
              disabled={!canEnumerateWindows || sceneCreating}
              onClick={() => void loadWindows()}
              data-tip={t("home.obs.refreshWindows")}
              aria-label={t("home.obs.refreshWindows")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
            </button>
          </div>
        </div>

        {/* Capture mode selector */}
        {canSelectCaptureMode && <div className="home-row home-row--capture-mode">
          <label className="home-row__label" htmlFor="home-capture-mode-window">
            {t("home.obs.captureModeLabel")}
          </label>
          <div className="home-row__controls home-capture-mode">
            <label className="home-capture-mode__option">
              <input
                id="home-capture-mode-window"
                type="radio"
                name="home-capture-mode"
                value="window_capture"
                checked={selectedCaptureMode === "window_capture"}
                disabled={!canUseWindowCapture || sceneCreating}
                onChange={() => setSelectedCaptureMode("window_capture")}
              />
              <span>{t("home.obs.captureModeWindow")}</span>
            </label>
            <label className="home-capture-mode__option">
              <input
                type="radio"
                name="home-capture-mode"
                value="game_capture"
                checked={selectedCaptureMode === "game_capture"}
                disabled={!canUseGameCapture || sceneCreating}
                onChange={() => setSelectedCaptureMode("game_capture")}
              />
              <span>{t("home.obs.captureModeGame")}</span>
            </label>
          </div>
        </div>}

        {/* Override scene name — only shown once a target is selected */}
        {selectedWindowValue && <div className="home-row home-row--scene-name-override">
          <label className="home-row__label" htmlFor="home-scene-name-override">
            {t("home.obs.overrideSceneName")}
          </label>
          <div className="home-row__controls">
            <input
              id="home-scene-name-override"
              className="home-input"
              type="text"
              disabled={!canEnumerateWindows || sceneCreating}
              value={overrideSceneName}
              onChange={(e) => setOverrideSceneName(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>}

        {/* Capture card toggle */}
        <div className="home-row home-row--toggle">
          <span className="home-row__label" aria-hidden="true" />
          <div className="home-row__controls">
            <label
              className="home-toggle"
              htmlFor="home-capture-card-toggle"
              data-tip={t("home.obs.captureCardTooltip")}
            >
              <input
                id="home-capture-card-toggle"
                type="checkbox"
                disabled={!canEnumerateWindows || sceneCreating}
                checked={captureCardEnabled}
                onChange={(e) => void handleCaptureCardToggle(e.target.checked)}
              />
              <span>{t("home.obs.captureCardToggle")}</span>
            </label>
          </div>
        </div>

        {sceneCreateError && <p role="alert">{t("home.workspace.addGameError")}</p>}
      </div>
      <div className="capture-wizard-footer">
        <div className="capture-wizard-footer-actions">
          <button type="button" className="secondary" disabled={sceneCreating} onClick={() => setNewCaptureOpen(false)}>
            {t("home.rename.cancel")}
          </button>
          <button
            type="submit"
            className="ws-primary"
            disabled={!canCreateScene || sceneCreating}
            data-tip={t(
              isWaylandPipewireSelection
                ? "home.obs.waylandPipewireTooltip"
                : isMonitorSelection
                  ? "home.obs.monitorCaptureTooltip"
                  : "home.obs.setupCaptureTooltip",
            )}
          >
            {t(sceneCreating ? "home.workspace.addingGame" : "home.obs.setupCapture")}
          </button>
        </div>
      </div>
    </form>
  );

  /* ---- Render ---------------------------------------------------- */
  return (
    <div className={`tab-panel home-panel ${active ? "active" : ""}`}>
      <div className="gsm-workspace home-desk">
        <aside className="home-library" aria-label={t("home.workspace.library")} inert={newCaptureOpen}>
          <div className="home-library-brand">
            <span className="home-library-mark"><WorkspaceIcon name="general" /></span>
            <div>
              <strong>{t("app.tabs.home")}</strong>
              <span>{t("home.workspace.library")}</span>
            </div>
          </div>
          <button
            type="button"
            className="ws-primary home-add-game"
            aria-haspopup="dialog"
            aria-controls="home-new-capture"
            onClick={(event) => openNewCapture(event.currentTarget)}
          >
            <span aria-hidden="true">+</span>
            {t("home.workspace.addGame")}
          </button>
          <div className="home-library-heading">
            <h2>{t("home.workspace.savedGames")}</h2>
            <button
              type="button"
              className="home-icon-btn"
              onClick={() => void refreshAll()}
              aria-label={t("home.obs.refreshScenes")}
              data-tip={t("home.obs.refreshScenes")}
            >
              <WorkspaceIcon name="updates" />
            </button>
          </div>
          {hasUserScenes && <div className="home-library-search">
            <WorkspaceIcon name="search" />
            <input
              type="search"
              value={gameSearch}
              placeholder={t("home.workspace.searchGames")}
              aria-label={t("home.workspace.searchGames")}
              onChange={(event) => setGameSearch(event.target.value)}
            />
          </div>}
          <ul className="home-game-list">
            {filteredScenes.map((scene) => (
              <li key={scene.id} className="home-game-entry">
                <button
                  type="button"
                  className="home-game-button"
                  data-tip={scene.name}
                  data-tip-if-truncated="span"
                  ref={selectedSceneId === scene.id ? selectedGameRef : null}
                  data-scene-id={scene.id}
                  aria-current={selectedSceneId === scene.id ? "true" : undefined}
                  onClick={() => handleSceneChange(scene.id)}
                >
                  <WorkspaceIcon name="general" />
                  <span>{scene.name}</span>
                </button>
                <button type="button" className="home-game-menu-trigger" data-game-menu-id={scene.id}
                  aria-label={t("home.workspace.gameActions", { name: scene.name })}
                  aria-haspopup="menu" aria-expanded={gameMenu?.scene.id === scene.id}
                  aria-controls={gameMenu?.scene.id === scene.id ? "home-game-menu" : undefined}
                  onClick={(event) => setGameMenu(gameMenu?.scene.id === scene.id ? null : { scene, anchor: event.currentTarget })}>
                  <span aria-hidden="true">⋯</span>
                </button>
              </li>
            ))}
          </ul>
          {!hasUserScenes && <p className="home-library-empty">{t(scenesLoading ? "home.obs.loading" : "home.workspace.noGames")}</p>}
          {hasUserScenes && filteredScenes.length === 0 && <p className="home-library-empty" role="status">{t("home.workspace.noMatchingGames")}</p>}
          <section className="home-status-card" aria-label={t("home.workspace.connections")}>
            <div className="home-status-grid">
              {/* Fixed core statuses */}
              <StatusPill
                icon="capture"
                label={t("home.status.gsm")}
                text={gsmText}
                variant={gsmVariant}
                tooltip={gsmTooltip}
              />
              <StatusPill
                icon="general"
                label={t("home.status.obs")}
                text={obsOk ? t("home.status.connected") : t("home.status.disconnected")}
                variant={obsOk ? "ok" : "bad"}
                tooltip={obsOk ? t("home.status.tooltipObsConnected") : t("home.status.tooltipObsDisconnected")}
                onClick={openOBS}
                clickable
              />
              <StatusPill
                icon="backups"
                label={t("home.status.anki")}
                text={ankiText}
                variant={ankiVariant}
                tooltip={ankiTooltip}
                onClick={showAnkiBeaconNudge ? openAnkiBeaconModal : undefined}
                clickable={showAnkiBeaconNudge}
              />
              <StatusPill
                icon="layout"
                label={t("home.status.clipboard")}
                text={clipText}
                variant={clipEnabled ? "ok" : "neutral"}
                tooltip={clipTooltip}
              />
              {/* Dynamic input sources */}
              {wsEntries.map(([url, name]) => (
                <StatusPill
                  key={url}
                  icon="activity"
                  label={name}
                  text={t("home.status.connected")}
                  variant="ok"
                  tooltip={t("home.status.tooltipWsConnected", { name })}
                />
              ))}
            </div>
          </section>
        </aside>

        <div className="home-session" inert={newCaptureOpen}>
          <div className="home-session-scroll">
            {!hasUserScenes && <section className="home-empty-game" aria-labelledby="home-empty-game-heading">
              <span className="home-empty-game__icon" aria-hidden="true"><WorkspaceIcon name="general" /></span>
              <h1 id="home-empty-game-heading">{t("home.workspace.noGames")}</h1>
              <p className="home-section-hint">{t("home.workspace.emptyGameHint")}</p>
              <button type="button" className="ws-primary" aria-haspopup="dialog" aria-controls="home-new-capture" onClick={(event) => openNewCapture(event.currentTarget)}>
                {t("home.workspace.addGame")}
              </button>
            </section>}
            <section className="home-current-game" hidden={!hasUserScenes} aria-labelledby="home-current-game-heading">
              <header className="home-section-heading home-game-header">
                <div className="home-game-title">
                  <span className="ws-eyebrow">{t("home.workspace.gameContext")}</span>
                  <h1 id="home-current-game-heading">{isHelperScene ? t("home.workspace.chooseGame") : selectedScene?.name}</h1>
                  <div className="home-game-meta">
                    {selectedSceneCaptureMode && <span>{t(selectedSceneCaptureMode === "window_capture" ? "home.obs.captureModeWindow" : "home.obs.captureModeGame")}</span>}
                    {isWindows && windowsDetectedExe && !isHelperScene && <span className="home-game-executable">{windowsDetectedExe}</span>}
                    {isHelperScene && <span>{t("home.workspace.chooseGameHint")}</span>}
                  </div>
                </div>
              </header>
              {/* Scene profile selector — only when more than the Default profile exists */}
              {showSceneProfileRow && (
                <div className="home-row">
                  <div className="home-row__label home-profile-label">
                    <label htmlFor="home-scene-profile-select">{t("home.obs.profileLabel")}</label>
                    <button
                      type="button"
                      className="home-profile-help-btn"
                      data-tip={t("home.obs.profileTooltip")}
                      aria-label={t("home.obs.profileTooltip")}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="10"/>
                        <path d="M12 16v-4"/>
                        <path d="M12 8h.01"/>
                      </svg>
                    </button>
                  </div>
                  <div className="home-row__controls">
                    {newProfileMode ? (
                      <>
                        <input
                          id="home-scene-profile-new"
                          className="home-input"
                          type="text"
                          value={newProfileName}
                          placeholder={t("home.obs.profileNewPlaceholder")}
                          autoComplete="off"
                          autoFocus
                          onChange={(e) => setNewProfileName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); void handleCreateProfileForScene(); }
                            if (e.key === "Escape") { e.preventDefault(); setNewProfileMode(false); setNewProfileName(""); }
                          }}
                        />
                        <button
                          type="button"
                          className="home-text-btn"
                          disabled={profileAssigning || !newProfileName.trim()}
                          onClick={() => void handleCreateProfileForScene()}
                        >
                          {t("home.obs.profileCreate")}
                        </button>
                        <button
                          type="button"
                          className="home-text-btn"
                          disabled={profileAssigning}
                          onClick={() => { setNewProfileMode(false); setNewProfileName(""); }}
                        >
                          {t("home.obs.profileCancel")}
                        </button>
                      </>
                    ) : (
                      <select
                        id="home-scene-profile-select"
                        className="home-select"
                        value={sceneProfile}
                        disabled={profileAssigning}
                        onChange={(e) => void handleSceneProfileChange(e.target.value)}
                      >
                        {gsmProfiles.map((name) => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                        <option value={NEW_PROFILE_VALUE}>{t("home.obs.profileNewOption")}</option>
                      </select>
                    )}
                  </div>
                </div>
              )}
            </section>

            <div className="home-tools">
              {overlaySection}
              <section className="home-quick-actions" aria-labelledby="home-text-feed-heading">
                <div className="home-section-heading">
                  <h2 id="home-text-feed-heading"><WorkspaceIcon name="activity" />{t("home.workspace.textFeed")}</h2>
                </div>
                <p className="home-section-hint">{t("home.workspace.textFeedHint")}</p>
                <div className="home-tool-actions">
                  <button type="button" className="home-feed-button" onClick={openTexthooker} data-tip={t("home.actions.texthookerTooltip")}>
                    {t("home.actions.texthooker")}
                    <WorkspaceIcon name="arrow" />
                  </button>
                </div>
                <button type="button" className="home-settings-link" onClick={openGSMSettings} data-tip={t("home.actions.gsmSettingsTooltip")}>
                  <WorkspaceIcon name="settings" />
                  {t("home.actions.gsmSettings")}
                  <WorkspaceIcon name="arrow" />
                </button>
              </section>
            </div>

            <section className="home-game-details" hidden={isHelperScene} aria-labelledby="home-game-options-heading">
              <div className="home-section-heading">
                <h2 id="home-game-options-heading"><WorkspaceIcon name="settings" />{t("home.workspace.gameOptions")}</h2>
              </div>
              <div className="home-section-body">
                {/* Game executable — Linux Wine/Proton hook target (read-only on Windows) */}
                {selectedScene && !isHelperScene && (
                  <div className="home-row">
                    <label className="home-row__label" htmlFor="home-game-exe">
                      {t("home.obs.gameExeLabel")}
                    </label>
                    <div className="home-row__controls">
                      {isWindows ? (
                        <input
                          id="home-game-exe"
                          className="home-input"
                          type="text"
                          value={windowsDetectedExe}
                          readOnly
                          disabled
                          data-tip={t("home.obs.gameExeWindowsTooltip")}
                          autoComplete="off"
                        />
                      ) : (
                        <>
                          <input
                            id="home-game-exe"
                            className="home-input"
                            type="text"
                            value={gameExePath}
                            placeholder={t("home.obs.gameExePlaceholder")}
                            autoComplete="off"
                            onChange={(e) => setGameExePath(e.target.value)}
                            onBlur={(e) => void persistGameExePath(e.target.value.trim())}
                          />
                          <button
                            type="button"
                            className="home-text-btn"
                            onClick={() => void handleBrowseGameExe()}
                          >
                            {t("home.obs.gameExeBrowse")}
                          </button>
                          <button
                            type="button"
                            className="home-text-btn"
                            disabled={gameExeDetecting}
                            onClick={() => void handleAutoDetectGameExe()}
                          >
                            {gameExeDetecting
                              ? t("home.obs.gameExeDetecting")
                              : t("home.obs.gameExeAutoDetect")}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {isWindows && selectedScene && !isHelperScene && (
                  <GameBackgroundSettings sceneId={selectedScene.id} active={active} />
                )}
              </div>
            </section>
          </div>

        </div>
        <footer className="home-support" inert={newCaptureOpen}>
          <span className="home-support__heart" aria-hidden="true">♥</span>
          <span className="home-support__text">{t("home.support.text")}</span>
          <a
            href="#"
            className="home-support__link"
            onClick={(e) => { e.preventDefault(); openExternal("https://github.com/sponsors/bpwhelan"); }}
          >
            {t("home.support.githubSponsors")}
          </a>
          <a
            href="#"
            className="home-support__link"
            onClick={(e) => { e.preventDefault(); openExternal("https://ko-fi.com/beangate"); }}
          >
            {t("home.support.kofi")}
          </a>
          <a
            href="#"
            className="home-support__link"
            onClick={(e) => { e.preventDefault(); openExternal("https://github.com/bpwhelan/GameSentenceMiner"); }}
          >
            {t("home.support.githubStar")}
          </a>
        </footer>
        {active && newCaptureOpen && <AddGameDialog busy={sceneCreating} returnFocus={addGameTriggerRef.current} onClose={() => setNewCaptureOpen(false)}>{setupSection}</AddGameDialog>}
      </div>

      {gameMenu && <HomeGameMenu key={gameMenu.scene.id} scene={gameMenu.scene} anchor={gameMenu.anchor} current={gameMenu.scene.id === selectedSceneId}
        onClose={closeGameMenu} onRename={setRenameTarget} onRemove={handleRemoveScene}
        onSwitchCaptureMode={handleSwitchCaptureMode} onCaptureWizard={handleOpenCaptureWizard} />}

      {/* Rename modal */}
      {renameTarget && (
        <RenameModal
          scene={renameTarget}
          onClose={() => setRenameTarget(null)}
          onConfirm={(name) => void handleRenameConfirm(name)}
        />
      )}
      {ankiBeaconModalOpen && (
        <AnkiBeaconModal
          beaconConnected={ankiBeaconOk}
          onClose={closeAnkiBeaconModal}
        />
      )}
      {captureWizardOpen ? (
        <TextCaptureWizard
          initialScene={captureWizardScene}
          onNavigateTab={onNavigateTab}
          onClose={handleCaptureWizardClose}
        />
      ) : null}
    </div>
  );
}
