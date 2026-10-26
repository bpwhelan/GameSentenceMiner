import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { WorkspaceIcon, WorkspaceNavigation } from "../Workspace";
import "./SpeechRecognitionTab.css";

import { useTranslation } from "../../i18n";
import { invokeIpc, onIpc } from "../../lib/ipc";
import { useBufferedState } from "../../lib/useBufferedState";
import { DEBUG_LOG_HISTORY_LIMIT, DEBUG_TEXT_HISTORY_LIMIT } from "../../lib/debugHistory";
import type { ObsScene } from "../../types/models";

interface WindowsSpeechSettings {
  backend: "embedded" | "sapi";
  language: "ja" | "en";
  modelPath: string;
  runtimePath: string;
  licenseFile: string;
}

interface WindowsSpeechSnapshot {
  success: boolean;
  exists: boolean;
  scene: ObsScene;
  settings: WindowsSpeechSettings;
  error?: string;
}

interface CommandResult {
  success: boolean;
  error?: string;
}

type RuntimeState = "idle" | "starting" | "running" | "stopping" | "error";

interface WindowsSpeechStatus {
  state: RuntimeState;
  sceneId: string;
  sceneName: string;
  backend: string;
  language: string;
  error: string;
  reason: string;
}

interface SpeechLogLine {
  id: number;
  level: string;
  message: string;
  timestamp: number;
}

const DEFAULT_SETTINGS: WindowsSpeechSettings = {
  backend: "embedded",
  language: "ja",
  modelPath: "",
  runtimePath: "",
  licenseFile: "",
};

const DEFAULT_STATUS: WindowsSpeechStatus = {
  state: "idle",
  sceneId: "",
  sceneName: "",
  backend: "",
  language: "",
  error: "",
  reason: "",
};

type SpeechView = "capture" | "advanced" | "activity";
const SPEECH_VIEWS = [
  {
    id: "capture",
    labelKey: "speechRecognition.workspace.capture",
  },
  {
    id: "advanced",
    labelKey: "speechRecognition.workspace.advanced",
  },
  {
    id: "activity",
    labelKey: "speechRecognition.workspace.activity",
  },
] as const;

function toObsScenes(value: unknown): ObsScene[] {
  if (!Array.isArray(value)) return [];
  return value.filter((scene): scene is ObsScene =>
    Boolean(
      scene &&
        typeof scene === "object" &&
        typeof (scene as ObsScene).id === "string" &&
        typeof (scene as ObsScene).name === "string",
    ),
  );
}

function normalizeStatus(value: unknown): WindowsSpeechStatus {
  if (!value || typeof value !== "object") return DEFAULT_STATUS;
  const payload = value as Partial<WindowsSpeechStatus>;
  const states = new Set<RuntimeState>(["idle", "starting", "running", "stopping", "error"]);
  return {
    state: states.has(payload.state as RuntimeState) ? (payload.state as RuntimeState) : "idle",
    sceneId: String(payload.sceneId ?? ""),
    sceneName: String(payload.sceneName ?? ""),
    backend: String(payload.backend ?? ""),
    language: String(payload.language ?? ""),
    error: String(payload.error ?? ""),
    reason: String(payload.reason ?? ""),
  };
}

export function SpeechRecognitionTab({ active }: { active: boolean }) {
  const t = useTranslation();
  const [workspaceView, setWorkspaceView] = useState<SpeechView>("capture");
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [scenes, setScenes] = useState<ObsScene[]>([]);
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [status, setStatus] = useState(DEFAULT_STATUS);
  const [logs, setLogs] = useBufferedState<SpeechLogLine[]>([], active);
  const [loaded, setLoaded] = useState(false);
  const [loadingScene, setLoadingScene] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "start" | "stop">("");
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const settingsRef = useRef(settings);
  const logIdRef = useRef(0);
  const consoleRef = useRef<HTMLDivElement>(null);

  const selectedScene = useMemo(
    () => scenes.find((scene) => scene.id === selectedSceneId) ?? null,
    [scenes, selectedSceneId],
  );

  const loadScene = useCallback(
    async (scene: ObsScene) => {
      setLoadingScene(true);
      try {
        const snapshot = await invokeIpc<WindowsSpeechSnapshot>("speech-recognition.loadScene", {
          scene,
        });
        if (!snapshot.success) {
          setNotice({ type: "error", text: snapshot.error || t("speechRecognition.loadFailed") });
          return;
        }
        settingsRef.current = snapshot.settings;
        setSettings(snapshot.settings);
        setDirty(false);
        setNotice(null);
      } catch {
        setNotice({ type: "error", text: t("speechRecognition.loadFailed") });
      } finally {
        setLoadingScene(false);
      }
    },
    [t],
  );

  const refreshScenes = useCallback(async () => {
    try {
      const [sceneResponse, activeScene] = await Promise.all([
        invokeIpc<unknown>("obs.getScenes"),
        invokeIpc<ObsScene | null>("obs.getActiveScene"),
      ]);
      const nextScenes = toObsScenes(sceneResponse);
      const nextScene =
        (activeScene && nextScenes.find((scene) => scene.id === activeScene.id)) ??
        nextScenes[0] ??
        null;
      setScenes(nextScenes);
      setSelectedSceneId(nextScene?.id ?? "");
      if (nextScene) {
        await loadScene(nextScene);
      }
    } catch {
      setScenes([]);
      setSelectedSceneId("");
      setNotice({ type: "error", text: t("speechRecognition.scenesLoadFailed") });
    } finally {
      setLoaded(true);
    }
  }, [loadScene, t]);

  useEffect(() => {
    const offStatus = onIpc("speech-recognition.status", (_event, payload) => {
      setStatus(normalizeStatus(payload));
    });
    const offLog = onIpc("speech-recognition.log", (_event, payload) => {
      if (!payload || typeof payload !== "object") return;
      const event = payload as { level?: unknown; message?: unknown; timestamp?: unknown };
      if (typeof event.message !== "string") return;
      const line: SpeechLogLine = {
        id: ++logIdRef.current,
        level: String(event.level ?? "info").toLowerCase(),
        message: event.message,
        timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
      };
      setLogs((current) => [...current, line].slice(-DEBUG_LOG_HISTORY_LIMIT));
    });
    return () => {
      offStatus();
      offLog();
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    void refreshScenes();
    void invokeIpc("speech-recognition.getStatus");
  }, [active, refreshScenes]);

  useEffect(() => {
    const consoleElement = consoleRef.current;
    if (!consoleElement) return;
    consoleElement.scrollTop = consoleElement.scrollHeight;
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [logs, workspaceView, active]);

  const updateSettings = useCallback((patch: Partial<WindowsSpeechSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      settingsRef.current = next;
      return next;
    });
    setDirty(true);
    setNotice(null);
  }, []);

  const persistScene = useCallback(
    async (scene: ObsScene, nextSettings: WindowsSpeechSettings, showNotice: boolean) => {
      const result = await invokeIpc<CommandResult>("speech-recognition.saveScene", {
        scene,
        settings: nextSettings,
      });
      if (!result.success) {
        setNotice({ type: "error", text: result.error || t("speechRecognition.saveFailed") });
        return false;
      }
      setDirty(false);
      if (showNotice) {
        setNotice({
          type: "success",
          text: t("speechRecognition.savedForScene", { scene: scene.name }),
        });
      }
      return true;
    },
    [t],
  );

  const save = useCallback(async () => {
    if (!selectedScene) return;
    setBusy("save");
    try {
      await persistScene(selectedScene, settingsRef.current, true);
    } catch {
      setNotice({ type: "error", text: t("speechRecognition.saveFailed") });
    } finally {
      setBusy("");
    }
  }, [persistScene, selectedScene, t]);

  const switchScene = useCallback(
    async (sceneId: string) => {
      const nextScene = scenes.find((scene) => scene.id === sceneId);
      if (!nextScene) return;
      setBusy("save");
      try {
        if (dirty && selectedScene) {
          const saved = await persistScene(selectedScene, settingsRef.current, false);
          if (!saved) return;
        }
        setSelectedSceneId(sceneId);
        await invokeIpc("obs.switchScene.id", sceneId);
        await loadScene(nextScene);
      } catch {
        setNotice({ type: "error", text: t("speechRecognition.sceneSwitchFailed") });
      } finally {
        setBusy("");
      }
    },
    [dirty, loadScene, persistScene, scenes, selectedScene, t],
  );

  const start = useCallback(async () => {
    if (!selectedScene) return;
    setBusy("start");
    setNotice(null);
    setStatus((current) => ({ ...current, state: "starting", error: "" }));
    try {
      const result = await invokeIpc<CommandResult>("speech-recognition.start", {
        scene: selectedScene,
        settings: settingsRef.current,
      });
      if (!result.success) {
        const message = result.error || t("speechRecognition.startFailed");
        setStatus((current) => ({ ...current, state: "error", error: message }));
        setNotice({ type: "error", text: message });
        return;
      }
      setDirty(false);
    } catch {
      setStatus((current) => ({
        ...current,
        state: "error",
        error: t("speechRecognition.startFailed"),
      }));
      setNotice({ type: "error", text: t("speechRecognition.startFailed") });
    } finally {
      setBusy("");
    }
  }, [selectedScene, t]);

  const stop = useCallback(async () => {
    setBusy("stop");
    setStatus((current) => ({ ...current, state: "stopping" }));
    try {
      const result = await invokeIpc<CommandResult>("speech-recognition.stop");
      if (!result.success) {
        setNotice({ type: "error", text: result.error || t("speechRecognition.stopFailed") });
      }
    } catch {
      setNotice({ type: "error", text: t("speechRecognition.stopFailed") });
    } finally {
      setBusy("");
    }
  }, [t]);

  const statusLabel = t(`speechRecognition.status.${status.state}`);
  const isRunning = status.state === "running" || status.state === "starting";
  const controlsDisabled = Boolean(busy) || loadingScene || !selectedScene;

  const currentView = SPEECH_VIEWS.find((view) => view.id === workspaceView)!;
  const transcriptLines = useMemo(() => {
    const lines: Array<SpeechLogLine & { text: string; partial: boolean }> = [];
    for (const line of logs) {
      if (line.level !== "result") continue;
      const entry = {
        ...line,
        text: line.message.replace(/^\[(?:final|partial)\]\s*/i, ""),
        partial: /^\[partial\]/i.test(line.message),
      };
      if (lines[lines.length - 1]?.partial) lines[lines.length - 1] = entry;
      else lines.push(entry);
    }
    return lines.slice(-DEBUG_TEXT_HISTORY_LIMIT);
  }, [logs]);

  if (!active) return null;
  if (!loaded)
    return (
      <div className="tab-panel active">
        <div className="speech-recognition-loading">{t("speechRecognition.loading")}</div>
      </div>
    );

  return (
    <div className="tab-panel active">
      <div className="gsm-workspace speech-desk">
        <aside className="ws-sidebar">
          <div className="ws-brand">
            <span className="ws-brand-mark">
              <WorkspaceIcon name="speech" />
            </span>
            <div>
              <strong>{t("speechRecognition.workspace.title")}</strong>
              <span>{t("speechRecognition.workspace.brandHint")}</span>
            </div>
          </div>
          <span className="speech-experimental">{t("speechRecognition.experimental")}</span>
          <div className="speech-scene-picker">
            <div className="speech-scene-heading">
              <label htmlFor="speech-scene">{t("speechRecognition.scene.label")}</label>
              <button
                type="button"
                disabled={Boolean(busy)}
                aria-label={t("speechRecognition.scene.refresh")}
                onClick={() => void refreshScenes()}
              >
                <WorkspaceIcon name="updates" />
              </button>
            </div>
            <select
              id="speech-scene"
              value={selectedSceneId}
              disabled={Boolean(busy) || scenes.length === 0}
              onChange={(event) => void switchScene(event.target.value)}
            >
              {scenes.length === 0 ? (
                <option value="">{t("speechRecognition.scene.none")}</option>
              ) : (
                scenes.map((scene) => (
                  <option
                    key={scene.id}
                    value={scene.id}
                  >
                    {scene.name}
                  </option>
                ))
              )}
            </select>
            <p>
              {selectedScene
                ? t("speechRecognition.scene.savedPerScene", { scene: selectedScene.name })
                : t("speechRecognition.scene.connectObs")}
            </p>
          </div>
          <WorkspaceNavigation
            prefix="speech"
            items={SPEECH_VIEWS.map((view) => ({ id: view.id, label: t(view.labelKey) }))}
            value={workspaceView}
            onChange={setWorkspaceView}
            label={t("speechRecognition.workspace.navigation")}
          />
          <section
            className="ws-sidebar-footer speech-session"
            aria-label={t("speechRecognition.workspace.session")}
          >
            <div
              className={
                "ws-state " +
                (isRunning
                  ? "is-running"
                  : status.state === "error"
                    ? "is-error"
                    : status.state === "stopping"
                      ? "is-pending"
                      : "")
              }
              role="status"
            >
              <i aria-hidden="true" />
              {statusLabel}
            </div>
            <strong>
              {status.sceneName || selectedScene?.name || t("speechRecognition.footer.noScene")}
            </strong>
            <p>
              {status.error ||
                t(
                  isRunning
                    ? "speechRecognition.footer.runningHint"
                    : "speechRecognition.footer.idleHint",
                )}
            </p>
            {isRunning || status.state === "stopping" ? (
              <button
                type="button"
                className="danger"
                disabled={Boolean(busy)}
                onClick={() => void stop()}
              >
                <WorkspaceIcon name="stop" />
                {t("speechRecognition.stop")}
              </button>
            ) : (
              <button
                type="button"
                className="ws-primary"
                disabled={controlsDisabled}
                onClick={() => void start()}
              >
                <WorkspaceIcon name="play" />
                {t("speechRecognition.start")}
              </button>
            )}
          </section>
        </aside>
        <main className="ws-main">
          <header className="ws-page-header">
            <div>
              <h1>{t(currentView.labelKey)}</h1>
              {notice ? (
                <div
                  className={"ws-notice " + (notice.type === "error" ? "is-error" : "")}
                  role="status"
                >
                  {notice.text}
                </div>
              ) : null}
            </div>
            <div className="ws-header-actions">
              {dirty ? (
                <span className="ws-state is-pending">
                  {t("speechRecognition.workspace.unsaved")}
                </span>
              ) : null}
              <button
                type="button"
                className={dirty ? "ws-primary" : ""}
                disabled={!dirty || controlsDisabled}
                onClick={() => void save()}
              >
                {t(busy === "save" ? "speechRecognition.saving" : "speechRecognition.save")}
              </button>
            </div>
          </header>
          <div className="ws-pages">
            <section
              id="speech-view-capture"
              className="ws-view speech-capture-view"
              role="tabpanel"
              aria-labelledby="speech-nav-capture"
              hidden={workspaceView !== "capture"}
              tabIndex={0}
            >
              <div className="speech-engine-bar">
                <div className="speech-engine-fields">
                  <div className="input-group">
                    <label htmlFor="speech-backend">{t("speechRecognition.backend")}</label>
                    <select
                      id="speech-backend"
                      value={settings.backend}
                      disabled={loadingScene || Boolean(busy)}
                      onChange={(event) =>
                        updateSettings({
                          backend: event.target.value === "sapi" ? "sapi" : "embedded",
                        })
                      }
                    >
                      <option value="embedded">{t("speechRecognition.backendEmbedded")}</option>
                      <option value="sapi">{t("speechRecognition.backendSapi")}</option>
                    </select>
                  </div>
                  <div className="input-group">
                    <label htmlFor="speech-language">{t("speechRecognition.language")}</label>
                    <select
                      id="speech-language"
                      value={settings.language}
                      disabled={loadingScene || Boolean(busy)}
                      onChange={(event) =>
                        updateSettings({ language: event.target.value === "en" ? "en" : "ja" })
                      }
                    >
                      <option value="ja">{t("speechRecognition.languageJapanese")}</option>
                      <option value="en">{t("speechRecognition.languageEnglish")}</option>
                    </select>
                  </div>
                </div>
                {settings.backend === "embedded" ? (
                  <p className="speech-download-note">
                    {t("speechRecognition.engine.downloadHint")}
                  </p>
                ) : null}
              </div>
              <section
                className="speech-transcript-section"
                aria-labelledby="speech-transcript-title"
              >
                <div className="speech-transcript-heading">
                  <h2 id="speech-transcript-title">
                    {t("speechRecognition.workspace.transcript")}
                  </h2>
                  <button
                    type="button"
                    disabled={transcriptLines.length === 0}
                    onClick={() =>
                      setLogs((current) => current.filter((line) => line.level !== "result"))
                    }
                  >
                    {t("speechRecognition.workspace.clearText")}
                  </button>
                </div>
                <div
                  className="speech-transcript"
                  ref={transcriptRef}
                  role="log"
                  aria-live="polite"
                  aria-label={t("speechRecognition.workspace.transcript")}
                  tabIndex={0}
                >
                  {transcriptLines.length ? (
                    transcriptLines.map((line) => (
                      <article
                        key={line.id}
                        className={"speech-transcript-line" + (line.partial ? " is-partial" : "")}
                      >
                        <div>
                          <time>{new Date(line.timestamp).toLocaleTimeString()}</time>
                          {line.partial ? (
                            <span>{t("speechRecognition.workspace.interim")}</span>
                          ) : null}
                        </div>
                        <p>{line.text}</p>
                      </article>
                    ))
                  ) : (
                    <div className="speech-empty">
                      <WorkspaceIcon name="speech" />
                      <p>
                        {t(
                          isRunning
                            ? "speechRecognition.workspace.waiting"
                            : "speechRecognition.workspace.empty",
                        )}
                      </p>
                    </div>
                  )}
                </div>
              </section>
              <p className="speech-forwarding-note">
                {t("speechRecognition.workspace.forwarding")}
              </p>
            </section>
            <section
              id="speech-view-advanced"
              className="ws-view"
              role="tabpanel"
              aria-labelledby="speech-nav-advanced"
              hidden={workspaceView !== "advanced"}
              tabIndex={0}
            >
              <div className="speech-advanced-form">
                <div className="input-group">
                  <label htmlFor="speech-model-path">{t("speechRecognition.modelPath")}</label>
                  <input
                    id="speech-model-path"
                    type="text"
                    value={settings.modelPath}
                    disabled={loadingScene || Boolean(busy)}
                    placeholder={t("speechRecognition.automatic")}
                    onChange={(event) => updateSettings({ modelPath: event.target.value })}
                  />
                </div>
                <div className="input-group">
                  <label htmlFor="speech-runtime-path">{t("speechRecognition.runtimePath")}</label>
                  <input
                    id="speech-runtime-path"
                    type="text"
                    value={settings.runtimePath}
                    disabled={loadingScene || Boolean(busy)}
                    placeholder={t("speechRecognition.automatic")}
                    onChange={(event) => updateSettings({ runtimePath: event.target.value })}
                  />
                </div>
                <div className="input-group">
                  <label htmlFor="speech-license-path">{t("speechRecognition.licenseFile")}</label>
                  <input
                    id="speech-license-path"
                    type="text"
                    value={settings.licenseFile}
                    disabled={loadingScene || Boolean(busy)}
                    placeholder={t("speechRecognition.optional")}
                    onChange={(event) => updateSettings({ licenseFile: event.target.value })}
                  />
                </div>
              </div>
            </section>
            <section
              id="speech-view-activity"
              className="ws-view speech-activity-view"
              role="tabpanel"
              aria-labelledby="speech-nav-activity"
              hidden={workspaceView !== "activity"}
              tabIndex={0}
            >
              <div className="speech-activity-toolbar">
                <span className="ws-state">{statusLabel}</span>
                <button
                  type="button"
                  onClick={() => setLogs([])}
                >
                  {t("speechRecognition.console.clear")}
                </button>
              </div>
              <div
                ref={consoleRef}
                className="speech-recognition-console"
                role="log"
                aria-live="polite"
                aria-label={t("speechRecognition.console.title")}
                tabIndex={0}
              >
                {logs.length === 0 ? (
                  <div className="speech-empty">
                    <p>{t("speechRecognition.console.empty")}</p>
                  </div>
                ) : (
                  logs.map((line) => (
                    <div
                      key={line.id}
                      className={`speech-recognition-log speech-recognition-log--${line.level}`}
                    >
                      <time>{new Date(line.timestamp).toLocaleTimeString()}</time>
                      <span>{line.message}</span>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
