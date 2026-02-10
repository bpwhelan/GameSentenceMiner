import { useCallback, useEffect, useMemo, useState } from "react";
import { invokeIpc } from "../../lib/ipc";
import type { GsmStatus, ObsScene, ObsWindow } from "../../types/models";

const HELPER_SCENE_NAMES = new Set([
  "GSM HELPER",
  "GSM HELPER - DONT TOUCH",
  "GSM Helper",
  "GSM Helper - DONT TOUCH"
]);

function toObsScenes(value: unknown): ObsScene[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const scene = entry as Partial<ObsScene>;
      if (typeof scene.id !== "string" || typeof scene.name !== "string") {
        return null;
      }
      return { id: scene.id, name: scene.name };
    })
    .filter((scene): scene is ObsScene => scene !== null);
}

function toObsWindows(value: unknown): ObsWindow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const windowEntry = entry as Partial<ObsWindow>;
      if (typeof windowEntry.value !== "string") {
        return null;
      }
      return {
        title:
          typeof windowEntry.title === "string"
            ? windowEntry.title
            : windowEntry.value,
        value: windowEntry.value,
        captureMode:
          typeof windowEntry.captureMode === "string"
            ? windowEntry.captureMode
            : undefined
      };
    })
    .filter((windowEntry): windowEntry is ObsWindow => windowEntry !== null);
}

function getRelativeTime(lastLineReceived?: string): string {
  if (!lastLineReceived) {
    return "Not received yet";
  }

  const elapsedSeconds = Math.floor(
    (Date.now() - new Date(lastLineReceived).getTime()) / 1000
  );

  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
    return "Not received yet";
  }
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds} seconds ago`;
  }
  if (elapsedSeconds < 3600) {
    return `${Math.floor(elapsedSeconds / 60)} minutes ago`;
  }
  if (elapsedSeconds < 86400) {
    return `${Math.floor(elapsedSeconds / 3600)} hours ago`;
  }
  return `${Math.floor(elapsedSeconds / 86400)} days ago`;
}

function toWordsProcessingLabel(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (typeof value === "string") {
    return value;
  }
  return "";
}

interface HomeTabProps {
  active: boolean;
}

export function HomeTab({ active }: HomeTabProps) {
  const platform = window.gsmEnv?.platform ?? "win32";
  const isWindows = platform === "win32";

  const [scenes, setScenes] = useState<ObsScene[]>([]);
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [windows, setWindows] = useState<ObsWindow[]>([]);
  const [selectedWindowValue, setSelectedWindowValue] = useState("");
  const [loadingScenes, setLoadingScenes] = useState(true);
  const [loadingWindows, setLoadingWindows] = useState(isWindows);

  const [gsmStatus, setGsmStatus] = useState<GsmStatus | null>(null);
  const [statusError, setStatusError] = useState(false);

  const selectedScene = useMemo(
    () => scenes.find((scene) => scene.id === selectedSceneId),
    [scenes, selectedSceneId]
  );
  const removeSceneDisabled =
    !selectedScene || HELPER_SCENE_NAMES.has(selectedScene.name);

  const selectedWindow = useMemo(
    () => windows.find((windowEntry) => windowEntry.value === selectedWindowValue),
    [windows, selectedWindowValue]
  );

  const refreshWindows = useCallback(async () => {
    if (!isWindows) {
      setWindows([]);
      setSelectedWindowValue("");
      setLoadingWindows(false);
      return;
    }

    setLoadingWindows(true);
    const previousSelection = selectedWindowValue;

    try {
      const response = await invokeIpc<unknown>("obs.getWindows");
      const nextWindows = toObsWindows(response);
      setWindows(nextWindows);

      const resolvedSelection =
        (previousSelection &&
          nextWindows.some((windowEntry) => windowEntry.value === previousSelection) &&
          previousSelection) ||
        nextWindows[0]?.value ||
        "";

      setSelectedWindowValue(resolvedSelection);
    } catch (error) {
      console.error("Failed to load OBS windows:", error);
      setWindows([]);
      setSelectedWindowValue("");
    } finally {
      setLoadingWindows(false);
    }
  }, [isWindows, selectedWindowValue]);

  const refreshScenesAndWindows = useCallback(async () => {
    setLoadingScenes(true);
    const previousSceneSelection = selectedSceneId;

    try {
      const response = await invokeIpc<unknown>("obs.getScenes");
      const nextScenes = toObsScenes(response);

      let nextSelectedSceneId =
        previousSceneSelection &&
        nextScenes.some((scene) => scene.id === previousSceneSelection)
          ? previousSceneSelection
          : nextScenes[0]?.id || "";

      try {
        const activeScene = await invokeIpc<ObsScene | null>("obs.getActiveScene");
        if (
          activeScene &&
          typeof activeScene.id === "string" &&
          nextScenes.some((scene) => scene.id === activeScene.id)
        ) {
          nextSelectedSceneId = activeScene.id;
        }
      } catch (activeSceneError) {
        console.warn("Failed to fetch active OBS scene:", activeSceneError);
      }

      setScenes(nextScenes);
      setSelectedSceneId(nextSelectedSceneId);
    } catch (error) {
      console.error("Failed to load OBS scenes:", error);
      setScenes([]);
      setSelectedSceneId("");
    } finally {
      setLoadingScenes(false);
    }

    await refreshWindows();
  }, [refreshWindows, selectedSceneId]);

  const pollGsmStatus = useCallback(async () => {
    try {
      const response = await invokeIpc<GsmStatus | null>("get_gsm_status");
      setGsmStatus(response);
      setStatusError(false);
    } catch (error) {
      console.error("Error fetching GSM status:", error);
      setStatusError(true);
    }
  }, []);

  useEffect(() => {
    if (!active) {
      return;
    }
    void refreshScenesAndWindows();
    const timer = setInterval(() => {
      void refreshScenesAndWindows();
    }, 5000);
    return () => clearInterval(timer);
  }, [active, refreshScenesAndWindows]);

  useEffect(() => {
    if (!active) {
      return;
    }
    void pollGsmStatus();
    const timer = setInterval(() => {
      void pollGsmStatus();
    }, 200);
    return () => clearInterval(timer);
  }, [active, pollGsmStatus]);

  const openObs = async () => {
    await invokeIpc("openOBS");
  };

  const openGsmSettings = async () => {
    await invokeIpc("settings.openGSMSettings");
  };

  const runOverlay = async () => {
    await invokeIpc("runOverlay");
  };

  const switchScene = async (sceneId: string) => {
    setSelectedSceneId(sceneId);
    await invokeIpc("obs.switchScene.id", sceneId);
  };

  const removeScene = async () => {
    if (!selectedSceneId) {
      return;
    }
    await invokeIpc("obs.removeScene", selectedSceneId);
    await refreshScenesAndWindows();
  };

  const createScene = async (captureType: "window" | "game") => {
    if (!selectedWindow) {
      return;
    }

    const payload = {
      title: selectedWindow.title,
      value: selectedWindow.value,
      sceneName: selectedWindow.title,
      captureSource: selectedWindow.captureMode ?? "window_capture"
    };

    if (captureType === "window") {
      await invokeIpc("obs.createScene", payload);
    } else {
      await invokeIpc("obs.createScene.Game", payload);
    }

    await refreshScenesAndWindows();
  };

  const openExternalLink = async (url: string) => {
    await invokeIpc("open-external-link", url);
  };

  const ready = Boolean(gsmStatus?.ready);
  const websockets = gsmStatus?.websockets_connected ?? [];
  const anyWebsocketsConnected = websockets.length > 0;
  const clipboardEnabled = Boolean(gsmStatus?.clipboard_enabled);
  const obsConnected = Boolean(gsmStatus?.obs_connected);
  const ankiConnected = Boolean(gsmStatus?.anki_connected);
  const wordsBeingProcessed = toWordsProcessingLabel(
    gsmStatus?.words_being_processed
  );

  const gsmStatusLabel = statusError
    ? "Error"
    : !gsmStatus
      ? "Installing/Initializing"
      : wordsBeingProcessed
        ? `Processing: ${wordsBeingProcessed}`
        : ready
          ? gsmStatus.status
          : "GSM is not running";

  const clipboardStatusLabel = anyWebsocketsConnected
    ? clipboardEnabled
      ? "Enabled"
      : "Disabled (Using WebSocket)"
    : clipboardEnabled
      ? "Enabled"
      : "Disabled";

  return (
    <div className={`tab-panel ${active ? "active" : ""}`}>
      <div className="modern-tab">
        <div className="legacy-grid home-layout">
          <section className="card legacy-card">
            <h2>Game Capture (Required)</h2>
            <div className="form-group">
              <div className="home-control-row home-scene-row">
                <label htmlFor="obs-scene-select">Game:</label>
                <select
                  id="obs-scene-select"
                  value={selectedSceneId}
                  onChange={(event) => {
                    void switchScene(event.target.value);
                  }}
                >
                  {loadingScenes ? (
                    <option value="">Loading...</option>
                  ) : (
                    scenes.map((scene) => (
                      <option key={scene.id} value={scene.id}>
                        {scene.name}
                      </option>
                    ))
                  )}
                </select>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    void refreshScenesAndWindows();
                  }}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={removeSceneDisabled}
                  onClick={() => {
                    void removeScene();
                  }}
                >
                  Remove Game
                </button>
              </div>

              <div className="home-control-row home-window-row">
                <label htmlFor="obs-window-select">Setup New Game:</label>
                <select
                  id="obs-window-select"
                  value={selectedWindowValue}
                  disabled={!isWindows}
                  onChange={(event) => {
                    setSelectedWindowValue(event.target.value);
                  }}
                >
                  {!isWindows ? (
                    <option value="">Need to set scenes in OBS on this OS.</option>
                  ) : loadingWindows ? (
                    <option value="">Loading...</option>
                  ) : (
                    windows.map((windowEntry) => (
                      <option key={windowEntry.value} value={windowEntry.value}>
                        {windowEntry.title}
                      </option>
                    ))
                  )}
                </select>
                <button
                  type="button"
                  className="secondary"
                  disabled={!isWindows}
                  onClick={() => {
                    void refreshWindows();
                  }}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  disabled={!isWindows || !selectedWindow}
                  onClick={() => {
                    void createScene("window");
                  }}
                >
                  Window Capture
                </button>
                <button
                  type="button"
                  disabled={!isWindows || !selectedWindow}
                  onClick={() => {
                    void createScene("game");
                  }}
                >
                  Game Capture
                </button>
              </div>
            </div>
          </section>

          <section className="card legacy-card">
            <h2>Quick Actions</h2>
            <div className="form-group">
              <div className="home-actions-row">
                <button type="button" onClick={() => void openGsmSettings()}>
                  Open GSM Settings
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void runOverlay();
                  }}
                >
                  Run Overlay
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void openExternalLink(
                      "https://github.com/bpwhelan/GameSentenceMiner/wiki/Overlay-%E2%80%90-Overview"
                    )
                  }
                >
                  Overlay Wiki
                </button>
              </div>
            </div>
          </section>

          <section className="card legacy-card">
            <h2>Status</h2>
            <div className="status-grid home-status-grid">
              <button
                type="button"
                className={`status-button ${
                  ready ? "green" : statusError ? "red" : "red"
                }`}
                title={
                  ready && gsmStatus
                    ? `Status: ${gsmStatus.status}\nWebSockets: ${websockets.join(
                        ", "
                      ) || "None"}\nOBS: ${obsConnected ? "Started" : "Stopped"}\nAnki: ${
                        ankiConnected ? "Connected" : "Disconnected"
                      }\nLast Line Received: ${getRelativeTime(
                        gsmStatus.last_line_received
                      )}`
                    : "GSM is stopped."
                }
              >
                <span>GSM</span>
                <span>{gsmStatusLabel}</span>
              </button>

              <button
                type="button"
                className={`status-button ${
                  clipboardEnabled ? "green" : "neutral"
                }`}
                title={
                  clipboardEnabled
                    ? "Clipboard monitoring is enabled."
                    : anyWebsocketsConnected
                      ? "Clipboard monitoring is disabled because text is being received via WebSocket."
                      : "Clipboard monitoring is disabled."
                }
              >
                <span>Clipboard</span>
                <span>{clipboardStatusLabel}</span>
              </button>

              {websockets.map((websocketName) => (
                <button
                  key={websocketName}
                  type="button"
                  className="status-button green"
                  title={`${websocketName} is connected.`}
                >
                  <span>{websocketName}</span>
                  <span>Connected</span>
                </button>
              ))}

              <button
                type="button"
                className={`status-button ${obsConnected ? "green" : "red"}`}
                title={obsConnected ? "OBS is connected." : "OBS is disconnected."}
                onClick={() => {
                  void openObs();
                }}
              >
                <span>OBS</span>
                <span>{obsConnected ? "Connected" : "Disconnected"}</span>
              </button>

              <button
                type="button"
                className={`status-button ${ankiConnected ? "green" : "red"}`}
                title={ankiConnected ? "Anki is connected." : "Anki is disconnected."}
              >
                <span>Anki</span>
                <span>{ankiConnected ? "Connected" : "Disconnected"}</span>
              </button>
            </div>
          </section>

          <section className="card legacy-card">
            <h2>Support GSM Development</h2>
            <p className="muted">
              GSM will always be free. If GSM helps your workflow, consider supporting
              continued development.
            </p>
            <div className="link-row">
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  void openExternalLink("https://github.com/sponsors/bpwhelan")
                }
              >
                GitHub Sponsors
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void openExternalLink("https://ko-fi.com/beangate")}
              >
                Ko-fi
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
