import { useCallback, useEffect, useRef, useState } from "react";
import { invokeIpc, onIpc } from "../../lib/ipc";
import { useTranslation } from "../../i18n";
import type { GsmStatus, ObsScene, ObsWindow } from "../../types/models";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface HomeTabProps {
  active: boolean;
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

const OVERLAY_DOCS_URL =
  "https://docs.gamesentenceminer.com/docs/features/overlay";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const platform = (window.gsmEnv?.platform ?? "win32") as string;
const isWindows = platform === "win32";
const isLinux = platform === "linux";
const canEnumerateWindows = isWindows || isLinux;

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

/* ------------------------------------------------------------------ */
/*  Status Bar                                                         */
/* ------------------------------------------------------------------ */

interface StatusPillProps {
  icon: string;
  label: string;
  text: string;
  variant: "ok" | "bad" | "neutral";
  tooltip?: string;
  onClick?: () => void;
  clickable?: boolean;
}

function StatusPill({ icon, label, text, variant, tooltip, onClick, clickable }: StatusPillProps) {
  return (
    <button
      className={`home-status-pill home-status-pill--${variant}${clickable ? " home-status-pill--clickable" : ""}`}
      title={tooltip}
      onClick={onClick}
      type="button"
      tabIndex={clickable ? 0 : -1}
    >
      <span className="home-status-pill__icon">{icon}</span>
      <span className="home-status-pill__label">{label}</span>
      <span className="home-status-pill__dot" />
      <span className="home-status-pill__text">{text}</span>
    </button>
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
      <div className="home-modal" role="dialog" aria-modal="true">
        <h3>{t("home.rename.title")}</h3>
        <p className="home-modal__desc">{t("home.rename.description")}</p>
        <input
          ref={inputRef}
          className="home-input"
          type="text"
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

export function HomeTab({ active }: HomeTabProps) {
  const t = useTranslation();

  /* ---- Status ---------------------------------------------------- */
  const [status, setStatus] = useState<GsmStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [overlayRunning, setOverlayRunning] = useState(false);
  const [runOverlayOnStartup, setRunOverlayOnStartup] = useState(false);

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
    if (!active) return;
    let cancelled = false;

    void invokeIpc<{ runOverlayOnStartup?: boolean }>("settings.getSettings")
      .then((settings) => {
        if (!cancelled) {
          setRunOverlayOnStartup(settings?.runOverlayOnStartup === true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRunOverlayOnStartup(false);
        }
      });

    return () => { cancelled = true; };
  }, [active]);

  /* ---- Scenes ---------------------------------------------------- */
  const [scenes, setScenes] = useState<ObsScene[]>([]);
  const [selectedSceneId, setSelectedSceneId] = useState<string>("");
  const [renameTarget, setRenameTarget] = useState<ObsScene | null>(null);
  const [captureCardEverShown, setCaptureCardEverShown] = useState(false);

  /* ---- Windows --------------------------------------------------- */
  const [windows, setWindows] = useState<ObsWindow[]>([]);
  const [selectedWindowValue, setSelectedWindowValue] = useState<string>("");
  const [overrideSceneName, setOverrideSceneName] = useState("");
  const [captureCardEnabled, setCaptureCardEnabled] = useState(false);

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
          const stillThere = res.some((w) => w.value === prev);
          return stillThere ? prev : "";
        });
      }
    } catch { /* swallow */ }
    setWindowsLoading(false);
  }, []);

  const refreshAll = useCallback(
    async (quick = false) => {
      await loadScenes();
      await loadWindows(quick);
    },
    [loadScenes, loadWindows],
  );

  const handleWindowSelectionChange = useCallback((value: string) => {
    setSelectedWindowValue(value);
    const win = windows.find((candidate) => candidate.value === value);
    setOverrideSceneName(win?.title ?? "");
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

  /* ---- Scene actions --------------------------------------------- */
  const selectedScene = scenes.find((s) => s.id === selectedSceneId) ?? null;
  const isHelperScene = selectedScene ? HELPER_SCENE_NAMES.has(selectedScene.name) : true;
  const hasUserScenes = scenes.some((s) => !HELPER_SCENE_NAMES.has(s.name));
  if (hasUserScenes && !captureCardEverShown) setCaptureCardEverShown(true);

  const handleSceneChange = useCallback((id: string) => {
    setSelectedSceneId(id);
    if (id) void invokeIpc("obs.switchScene.id", id);
  }, []);

  const handleRemoveScene = useCallback(async () => {
    if (!selectedSceneId) return;
    await invokeIpc("obs.removeScene", selectedSceneId);
    await refreshAll();
  }, [selectedSceneId, refreshAll]);

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

  const handleCreateScene = useCallback(() => {
    const win = windows.find((w) => w.value === selectedWindowValue);
    if (!win) return;
    const payload = {
      title: win.title,
      value: win.value,
      sceneName: overrideSceneName.trim() || win.title,
      targetKind: win.targetKind ?? "window",
      captureValues: win.captureValues ?? {},
      videoDeviceId: win.videoDeviceId,
      audioDeviceId: win.audioDeviceId,
      wasapiInputDeviceId: win.wasapiInputDeviceId,
    };
    void invokeIpc("obs.createScene", payload);
  }, [windows, selectedWindowValue, overrideSceneName]);

  const handleCaptureCardToggle = useCallback(async (enabled: boolean) => {
    try {
      const result = await invokeIpc<boolean>("obs.setCaptureCardProbeEnabled", enabled);
      setCaptureCardEnabled(Boolean(result));
      await loadWindows();
    } catch {
      setCaptureCardEnabled(!enabled);
    }
  }, [loadWindows]);

  /* ---- Actions --------------------------------------------------- */
  const openGSMSettings = useCallback(() => void invokeIpc("settings.openGSMSettings"), []);
  const openTexthooker = useCallback(() => void invokeIpc("openTexthooker"), []);
  const runOverlay = useCallback(() => void invokeIpc("runOverlay"), []);
  const openOverlaySettings = useCallback(() => void invokeIpc("settings.openOverlaySettings"), []);
  const openOBS = useCallback(() => void invokeIpc("openOBS"), []);
  const openExternal = useCallback((url: string) => void invokeIpc("open-external-link", url), []);
  const handleRunOverlayOnStartupChange = useCallback(async (enabled: boolean) => {
    setRunOverlayOnStartup(enabled);
    try {
      const result = await invokeIpc<{
        settings?: { runOverlayOnStartup?: boolean };
      }>("settings.saveSettings", { runOverlayOnStartup: enabled });
      if (typeof result?.settings?.runOverlayOnStartup === "boolean") {
        setRunOverlayOnStartup(result.settings.runOverlayOnStartup);
      }
    } catch {
      setRunOverlayOnStartup(!enabled);
    }
  }, []);

  /* ---- Derived status values ------------------------------------- */
  const gsmReady = status?.ready ?? false;
  const obsOk = status?.obs_connected ?? false;
  const ankiOk = status?.anki_connected ?? false;
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

  /* ---- Window groupings ------------------------------------------ */
  const windowTargets = windows.filter((w) => w.targetKind !== "capture_card");
  const captureCardTargets = windows.filter((w) => w.targetKind === "capture_card");

  /* ---- Render ---------------------------------------------------- */
  return (
    <div className={`tab-panel ${active ? "active" : ""}`}>
      <div className="modern-tab home-tab">
        <div className="home-layout">

          {/* ===== ACTIVE CAPTURE ===== */}
          {captureCardEverShown && <section className="card home-obs-card home-capture-card">
            <div className="card-header">
              {t("home.obs.title")}
              <span className="home-obs-card__badge">{t("home.obs.required")}</span>
            </div>
            <div className="card-body">
              {/* Scene selector */}
              <div className="home-row">
                <label className="home-row__label" htmlFor="home-scene-select">
                  {t("home.obs.gameLabel")}
                </label>
                <div className="home-row__controls">
                  <select
                    id="home-scene-select"
                    className="home-select"
                    value={selectedSceneId}
                    onChange={(e) => handleSceneChange(e.target.value)}
                  >
                    {scenesLoading && scenes.length === 0 && (
                      <option>{t("home.obs.loading")}</option>
                    )}
                    {scenes.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="home-icon-btn"
                    onClick={() => void refreshAll()}
                    title={t("home.obs.refreshScenes")}
                    aria-label={t("home.obs.refreshScenes")}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
                  </button>
                </div>
              </div>

              {/* Scene actions */}
              <div className="home-row">
                <span className="home-row__label">{/* spacer */}</span>
                <div className="home-row__controls home-capture-actions">
                  <button
                    type="button"
                    className="home-text-btn"
                    disabled={isHelperScene}
                    onClick={() => { if (selectedScene) setRenameTarget(selectedScene); }}
                  >
                    {t("home.obs.rename")}
                  </button>
                  <button
                    type="button"
                    className="home-text-btn home-text-btn--danger"
                    disabled={isHelperScene}
                    onClick={() => void handleRemoveScene()}
                  >
                    {t("home.obs.remove")}
                  </button>
                  {/* 
                  // TODO: Switch profile per-scene
                  <button type="button" className="home-text-btn" disabled>
                    {t("home.obs.switchProfile")}
                  </button>
                  // TODO: Open OBS preview for current capture
                  <button type="button" className="home-text-btn" disabled>
                    {t("home.obs.preview")}
                  </button>
                   */}
                </div>
              </div>
            </div>
          </section>}

          {/* ===== NEW CAPTURE SETUP ===== */}
          <section className="card home-setup-card">
            <div className="card-header">
              {t("home.obs.setupNewScene")}
            </div>
            <div className="card-body">
              {/* Window selector */}
              <div className="home-row">
                <label className="home-row__label" htmlFor="home-window-select">
                  {t("home.obs.sectionWindows")}
                </label>
                <div className="home-row__controls">
                  <select
                    id="home-window-select"
                    className="home-select"
                    value={selectedWindowValue}
                    disabled={!canEnumerateWindows}
                    title={!canEnumerateWindows ? t("home.obs.notSupportedTooltip") : undefined}
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
                            {w.targetKind === "capture_card" ? t("home.obs.captureCardPrefix", { title: w.title }) : w.title}
                          </option>
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
                    disabled={!canEnumerateWindows}
                    onClick={() => void loadWindows()}
                    title={t("home.obs.refreshWindows")}
                    aria-label={t("home.obs.refreshWindows")}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
                  </button>
                </div>
              </div>

              {/* Override scene name — only shown once a window is selected */}
              {selectedWindowValue && <div className="home-row home-row--scene-name-override">
                <label className="home-row__label" htmlFor="home-scene-name-override">
                  {t("home.obs.overrideSceneName")}
                </label>
                <div className="home-row__controls">
                  <input
                    id="home-scene-name-override"
                    className="home-input"
                    type="text"
                    disabled={!canEnumerateWindows}
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
                    title={t("home.obs.captureCardTooltip")}
                  >
                    <input
                      id="home-capture-card-toggle"
                      type="checkbox"
                      disabled={!canEnumerateWindows}
                      checked={captureCardEnabled}
                      onChange={(e) => void handleCaptureCardToggle(e.target.checked)}
                    />
                    <span>{t("home.obs.captureCardToggle")}</span>
                  </label>
                </div>
              </div>

              {/* Create button */}
              <div className="home-row">
                <span className="home-row__label">{/* spacer */}</span>
                <div className="home-row__controls">
                  <button
                    type="button"
                    disabled={!canEnumerateWindows || windows.length === 0}
                    onClick={handleCreateScene}
                    title={t("home.obs.setupCaptureTooltip")}
                  >
                    {t("home.obs.setupCapture")}
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* ===== OVERLAY ===== */}
          <section className="card home-overlay-card">
            <div className="card-header">
              {t("home.overlay.title")}
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
            <div className="card-body">
              <div className="home-overlay-card__controls">
                <div className="home-overlay-card__actions">
                  <button
                    type="button"
                    className="home-overlay-primary-btn"
                    onClick={overlayRunning ? openOverlaySettings : runOverlay}
                    title={
                      overlayRunning
                        ? t("home.actions.overlaySettingsTooltip")
                        : t("home.actions.overlayTooltip")
                    }
                  >
                    {overlayRunning ? t("home.actions.overlaySettings") : t("home.actions.overlay")}
                  </button>
                  <button
                    type="button"
                    className="home-quick-btn home-overlay-guide-btn"
                    onClick={() => openExternal(OVERLAY_DOCS_URL)}
                    title={t("home.actions.overlayWiki")}
                  >
                    {t("home.overlay.guide")}
                  </button>
                </div>
                <label
                  className="home-toggle home-overlay-card__startup"
                  htmlFor="home-overlay-startup-toggle"
                  title={t("home.overlay.runOnStartupTooltip")}
                >
                  <input
                    id="home-overlay-startup-toggle"
                    type="checkbox"
                    checked={runOverlayOnStartup}
                    onChange={(e) => void handleRunOverlayOnStartupChange(e.target.checked)}
                  />
                  <span>{t("home.overlay.runOnStartup")}</span>
                </label>
              </div>
              {!isWindows && (
                <span className="home-overlay-card__warning">
                  {t("home.actions.overlayPlatformWarning")}
                </span>
              )}
            </div>
          </section>

          {/* ===== UTILITIES ===== */}
          <section className="home-quick-actions">
            <span className="home-quick-actions__title">{t("home.actions.title")}</span>
            <div className="home-quick-actions__row">
              <button
                type="button"
                className="home-quick-btn"
                onClick={openGSMSettings}
                title={t("home.actions.gsmSettingsTooltip")}
              >
                {t("home.actions.gsmSettings")}
              </button>
              <button
                type="button"
                className="home-quick-btn"
                onClick={openTexthooker}
                title={t("home.actions.texthookerTooltip")}
              >
                {t("home.actions.texthooker")}
              </button>
            </div>
          </section>

          {/* ===== STATUS ===== */}
          <section className="card home-status-card">
            <div className="card-header">{t("home.status.title")}</div>
            <div className="card-body home-status-grid">
              {/* Fixed core statuses */}
              <StatusPill
                icon="⛏"
                label={t("home.status.gsm")}
                text={gsmText}
                variant={gsmVariant}
                tooltip={gsmTooltip}
              />
              <StatusPill
                icon="📹"
                label={t("home.status.obs")}
                text={obsOk ? t("home.status.connected") : t("home.status.disconnected")}
                variant={obsOk ? "ok" : "bad"}
                tooltip={obsOk ? t("home.status.tooltipObsConnected") : t("home.status.tooltipObsDisconnected")}
                onClick={openOBS}
                clickable
              />
              <StatusPill
                icon="📘"
                label={t("home.status.anki")}
                text={ankiOk ? t("home.status.connected") : t("home.status.disconnected")}
                variant={ankiOk ? "ok" : "bad"}
                tooltip={ankiOk ? t("home.status.tooltipAnkiConnected") : t("home.status.tooltipAnkiDisconnected")}
              />
              <StatusPill
                icon="📋"
                label={t("home.status.clipboard")}
                text={clipText}
                variant={clipEnabled ? "ok" : "neutral"}
                tooltip={clipTooltip}
              />
              {/* Dynamic input sources */}
              {wsEntries.map(([url, name]) => (
                <StatusPill
                  key={url}
                  icon="🔗"
                  label={name}
                  text={t("home.status.connected")}
                  variant="ok"
                  tooltip={t("home.status.tooltipWsConnected", { name })}
                />
              ))}
            </div>
          </section>

          {/* ===== SUPPORT FOOTER ===== */}
          <footer className="home-support">
            <span className="home-support__heart">♥</span>
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
          </footer>
        </div>

        {/* Rename modal */}
        {renameTarget && (
          <RenameModal
            scene={renameTarget}
            onClose={() => setRenameTarget(null)}
            onConfirm={(name) => void handleRenameConfirm(name)}
          />
        )}
      </div>
    </div>
  );
}
