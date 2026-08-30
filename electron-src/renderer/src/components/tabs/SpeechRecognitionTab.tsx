import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTranslation } from "../../i18n";
import { invokeIpc, onIpc } from "../../lib/ipc";
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
  licenseFile: ""
};

const DEFAULT_STATUS: WindowsSpeechStatus = {
  state: "idle",
  sceneId: "",
  sceneName: "",
  backend: "",
  language: "",
  error: "",
  reason: ""
};

const MAX_LOG_LINES = 250;

function toObsScenes(value: unknown): ObsScene[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (scene): scene is ObsScene =>
      Boolean(
        scene &&
          typeof scene === "object" &&
          typeof (scene as ObsScene).id === "string" &&
          typeof (scene as ObsScene).name === "string"
      )
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
    reason: String(payload.reason ?? "")
  };
}

export function SpeechRecognitionTab({ active }: { active: boolean }) {
  const t = useTranslation();
  const [scenes, setScenes] = useState<ObsScene[]>([]);
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [status, setStatus] = useState(DEFAULT_STATUS);
  const [logs, setLogs] = useState<SpeechLogLine[]>([]);
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
    [scenes, selectedSceneId]
  );

  const loadScene = useCallback(
    async (scene: ObsScene) => {
      setLoadingScene(true);
      try {
        const snapshot = await invokeIpc<WindowsSpeechSnapshot>("speech-recognition.loadScene", {
          scene
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
    [t]
  );

  const refreshScenes = useCallback(async () => {
    try {
      const [sceneResponse, activeScene] = await Promise.all([
        invokeIpc<unknown>("obs.getScenes"),
        invokeIpc<ObsScene | null>("obs.getActiveScene")
      ]);
      const nextScenes = toObsScenes(sceneResponse);
      const nextScene =
        (activeScene && nextScenes.find((scene) => scene.id === activeScene.id)) ?? nextScenes[0] ?? null;
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
        timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now()
      };
      setLogs((current) => [...current, line].slice(-MAX_LOG_LINES));
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
  }, [logs]);

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
        settings: nextSettings
      });
      if (!result.success) {
        setNotice({ type: "error", text: result.error || t("speechRecognition.saveFailed") });
        return false;
      }
      setDirty(false);
      if (showNotice) {
        setNotice({ type: "success", text: t("speechRecognition.savedForScene", { scene: scene.name }) });
      }
      return true;
    },
    [t]
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
    [dirty, loadScene, persistScene, scenes, selectedScene, t]
  );

  const start = useCallback(async () => {
    if (!selectedScene) return;
    setBusy("start");
    setNotice(null);
    setStatus((current) => ({ ...current, state: "starting", error: "" }));
    try {
      const result = await invokeIpc<CommandResult>("speech-recognition.start", {
        scene: selectedScene,
        settings: settingsRef.current
      });
      if (!result.success) {
        const message = result.error || t("speechRecognition.startFailed");
        setStatus((current) => ({ ...current, state: "error", error: message }));
        setNotice({ type: "error", text: message });
        return;
      }
      setDirty(false);
    } catch {
      setStatus((current) => ({ ...current, state: "error", error: t("speechRecognition.startFailed") }));
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

  if (!active) return null;

  if (!loaded) {
    return (
      <div className="tab-panel active speech-recognition-panel">
        <div className="speech-recognition-loading">{t("speechRecognition.loading")}</div>
      </div>
    );
  }

  return (
    <div className="tab-panel active speech-recognition-panel">
      <div className="modern-tab speech-recognition-workspace">
        {notice ? (
          <div className={`speech-recognition-notice speech-recognition-notice--${notice.type}`} role="status">
            {notice.text}
          </div>
        ) : null}

        <header className="speech-recognition-header">
          <div>
            <div className="speech-recognition-title-row">
              <h1>{t("speechRecognition.title")}</h1>
              <span>{t("speechRecognition.experimental")}</span>
            </div>
            <p>{t("speechRecognition.subtitle")}</p>
          </div>
        </header>

        <div className="speech-recognition-dashboard">
          <div className="speech-recognition-column">
            <section className="card legacy-card speech-recognition-card">
              <div className="speech-recognition-card-heading">
                <div>
                  <h2>{t("speechRecognition.scene.title")}</h2>
                  <p>{t("speechRecognition.scene.hint")}</p>
                </div>
                <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void refreshScenes()}>
                  {t("speechRecognition.scene.refresh")}
                </button>
              </div>
              <label htmlFor="speech-scene">{t("speechRecognition.scene.label")}</label>
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
                    <option key={scene.id} value={scene.id}>
                      {scene.name}
                    </option>
                  ))
                )}
              </select>
              <div className="speech-recognition-scene-note">
                {selectedScene
                  ? t("speechRecognition.scene.savedPerScene", { scene: selectedScene.name })
                  : t("speechRecognition.scene.connectObs")}
              </div>
            </section>

            <section className="card legacy-card speech-recognition-card">
              <div className="speech-recognition-card-heading">
                <div>
                  <h2>{t("speechRecognition.engine.title")}</h2>
                  <p>{t("speechRecognition.engine.hint")}</p>
                </div>
                <button type="button" className="secondary" disabled={!dirty || Boolean(busy)} onClick={() => void save()}>
                  {busy === "save" ? t("speechRecognition.saving") : t("speechRecognition.save")}
                </button>
              </div>
              <div className="speech-recognition-grid">
                <label htmlFor="speech-backend">
                  <span>{t("speechRecognition.backend")}</span>
                  <select
                    id="speech-backend"
                    value={settings.backend}
                    disabled={loadingScene}
                    onChange={(event) =>
                      updateSettings({ backend: event.target.value === "sapi" ? "sapi" : "embedded" })
                    }
                  >
                    <option value="embedded">{t("speechRecognition.backendEmbedded")}</option>
                    <option value="sapi">{t("speechRecognition.backendSapi")}</option>
                  </select>
                </label>
                <label htmlFor="speech-language">
                  <span>{t("speechRecognition.language")}</span>
                  <select
                    id="speech-language"
                    value={settings.language}
                    disabled={loadingScene}
                    onChange={(event) =>
                      updateSettings({ language: event.target.value === "en" ? "en" : "ja" })
                    }
                  >
                    <option value="ja">{t("speechRecognition.languageJapanese")}</option>
                    <option value="en">{t("speechRecognition.languageEnglish")}</option>
                  </select>
                </label>
              </div>
              <p className="speech-recognition-download-note">{t("speechRecognition.engine.downloadHint")}</p>
            </section>

            <details className="card legacy-card speech-recognition-card speech-recognition-advanced">
              <summary>{t("speechRecognition.advanced")}</summary>
              <p>{t("speechRecognition.advancedHint")}</p>
              <label>
                <span>{t("speechRecognition.modelPath")}</span>
                <input
                  type="text"
                  value={settings.modelPath}
                  placeholder={t("speechRecognition.automatic")}
                  onChange={(event) => updateSettings({ modelPath: event.target.value })}
                />
              </label>
              <label>
                <span>{t("speechRecognition.runtimePath")}</span>
                <input
                  type="text"
                  value={settings.runtimePath}
                  placeholder={t("speechRecognition.automatic")}
                  onChange={(event) => updateSettings({ runtimePath: event.target.value })}
                />
              </label>
              <label>
                <span>{t("speechRecognition.licenseFile")}</span>
                <input
                  type="text"
                  value={settings.licenseFile}
                  placeholder={t("speechRecognition.optional")}
                  onChange={(event) => updateSettings({ licenseFile: event.target.value })}
                />
              </label>
            </details>
          </div>

          <section className="card legacy-card speech-recognition-card speech-recognition-console-card">
            <div className="speech-recognition-card-heading">
              <div>
                <h2>{t("speechRecognition.console.title")}</h2>
                <p>{t("speechRecognition.console.hint")}</p>
              </div>
              <div className="speech-recognition-console-actions">
                <span className={`speech-recognition-status speech-recognition-status--${status.state}`}>
                  {statusLabel}
                </span>
                <button type="button" className="secondary" onClick={() => setLogs([])}>
                  {t("speechRecognition.console.clear")}
                </button>
              </div>
            </div>
            <div ref={consoleRef} className="speech-recognition-console" role="log" aria-live="polite">
              {logs.length === 0 ? (
                <div className="speech-recognition-console-empty">{t("speechRecognition.console.empty")}</div>
              ) : (
                logs.map((line) => (
                  <div key={line.id} className={`speech-recognition-log speech-recognition-log--${line.level}`}>
                    <time>{new Date(line.timestamp).toLocaleTimeString()}</time>
                    <span>{line.message}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <footer className={`speech-recognition-footer speech-recognition-footer--${status.state}`}>
          <div className="speech-recognition-footer-status">
            <span className={`speech-recognition-status speech-recognition-status--${status.state}`}>
              {statusLabel}
            </span>
            <div>
              <strong>
                {status.sceneName || selectedScene?.name || t("speechRecognition.footer.noScene")}
              </strong>
              <p>
                {status.error ||
                  (isRunning
                    ? t("speechRecognition.footer.runningHint")
                    : t("speechRecognition.footer.idleHint"))}
              </p>
            </div>
          </div>
          <div className="speech-recognition-footer-actions">
            {isRunning || status.state === "stopping" ? (
              <button type="button" className="danger" disabled={Boolean(busy)} onClick={() => void stop()}>
                {t("speechRecognition.stop")}
              </button>
            ) : (
              <button type="button" disabled={controlsDisabled} onClick={() => void start()}>
                {t("speechRecognition.start")}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
