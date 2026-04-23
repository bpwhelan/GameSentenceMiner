import {
  useCallback,
  type ChangeEvent,
  useEffect,
  type MouseEvent,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import { invokeIpc, sendIpc } from "../../lib/ipc";
import type {
  AppSettings,
  ControlledTab,
  UpdateStatusSnapshot,
  UpdateTargetStatus
} from "../../types/models";
import type { SettingsCatalogAction } from "../../types/settings";
import {
  filterSettingsCatalogEntries,
  performSettingsCatalogAction,
  SETTINGS_CATALOG,
  SETTINGS_LOCATION_LABELS
} from "./settingsCatalog";
import { SUPPORTED_LOCALES, useLocale } from "../../i18n";

const DEFAULT_SETTINGS: AppSettings = {
  autoUpdateGSMApp: false,
  pullPreReleases: false,
  iconStyle: "gsm",
  startConsoleMinimized: false,
  customPythonPackage: "GameSentenceMiner",
  showYuzuTab: false,
  windowTransparencyToolHotkey: "Ctrl+Alt+Y",
  windowTransparencyTarget: "",
  runWindowTransparencyToolOnStartup: false,
  runOverlayOnStartup: false,
  visibleTabs: ["launcher", "stats", "python", "console"],
  statsEndpoint: "overview",
  locale: "en"
};

const DEFAULT_UPDATE_STATUS: UpdateStatusSnapshot = {
  backend: {
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
    checkedAt: null,
    error: null,
    checking: false,
    source: "pypi",
    branch: null
  },
  app: {
    currentVersion: "",
    latestVersion: null,
    updateAvailable: false,
    checkedAt: null,
    error: null,
    checking: false,
    channel: "latest"
  },
  anyUpdateInProgress: false
};

const VISIBLE_TAB_OPTIONS: Array<{ id: ControlledTab; label: string }> = [
  { id: "launcher", label: "Game Settings" },
  { id: "stats", label: "Stats" },
  { id: "python", label: "Python" },
  { id: "console", label: "Console" }
];

const STATS_ENDPOINT_OPTIONS = [
  "overview",
  "stats",
  "goals",
  "anki_stats",
  "search"
];

const SETTINGS_QUICK_LINK_IDS = [
  "gsm-key-settings",
  "gsm-anki",
  "gsm-audio",
  "gsm-screenshot",
  "gsm-overlay",
  "overlay-display-hotkeys",
  "overlay-gamepad"
];

interface SettingsTabProps {
  active: boolean;
}

function normalizeSettings(value: Partial<AppSettings> | null | undefined): AppSettings {
  if (!value) {
    return { ...DEFAULT_SETTINGS };
  }

  const visibleTabs = Array.isArray(value.visibleTabs)
    ? value.visibleTabs.filter((tab): tab is ControlledTab =>
        ["launcher", "stats", "python", "console"].includes(tab)
      )
    : DEFAULT_SETTINGS.visibleTabs;

  return {
    ...DEFAULT_SETTINGS,
    ...value,
    visibleTabs,
    windowTransparencyToolHotkey:
      value.windowTransparencyToolHotkey || DEFAULT_SETTINGS.windowTransparencyToolHotkey,
    windowTransparencyTarget:
      value.windowTransparencyTarget || DEFAULT_SETTINGS.windowTransparencyTarget,
    customPythonPackage:
      value.customPythonPackage || DEFAULT_SETTINGS.customPythonPackage,
    statsEndpoint: value.statsEndpoint || DEFAULT_SETTINGS.statsEndpoint,
    locale: value.locale || DEFAULT_SETTINGS.locale
  };
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
}

function selectedOptionValues(event: ChangeEvent<HTMLSelectElement>): string[] {
  return Array.from(event.currentTarget.selectedOptions).map((option) => option.value);
}

function formatCheckedAt(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }

  return timestamp.toLocaleString();
}

function getDisplayCurrentVersion(status: UpdateTargetStatus): string {
  return status.currentVersion && status.currentVersion.trim().length > 0
    ? status.currentVersion
    : "Unknown";
}

function getDisplayLatestVersion(
  label: "backend" | "app",
  status: UpdateTargetStatus
): string {
  if (label === "backend" && status.source === "prerelease-branch") {
    return status.branch ? `Branch ${status.branch}` : "Beta branch";
  }

  if (status.latestVersion && status.latestVersion.trim().length > 0) {
    return status.latestVersion;
  }

  return "Unknown";
}

export function SettingsTab({ active }: SettingsTabProps) {
  const platform = window.gsmEnv?.platform ?? "win32";
  const isWindows = platform === "win32";
  const [currentLocale, setCurrentLocale] = useLocale();

  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [customPackageDraft, setCustomPackageDraft] = useState(
    DEFAULT_SETTINGS.customPythonPackage
  );
  const [transparencyTargetDraft, setTransparencyTargetDraft] = useState(
    DEFAULT_SETTINGS.windowTransparencyTarget
  );
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusSnapshot>(
    DEFAULT_UPDATE_STATUS
  );
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [isApplyingUpdates, setIsApplyingUpdates] = useState(false);
  const [settingsSearchQuery, setSettingsSearchQuery] = useState("");
  const [hubMessage, setHubMessage] = useState<string | null>(null);

  const isInitializedRef = useRef(false);

  const persistSettings = useCallback(
    async (nextSettings: AppSettings, iconStyleChanged = false) => {
      if (iconStyleChanged) {
        sendIpc("settings.iconStyleChanged", nextSettings.iconStyle);
      }
      const result = await invokeIpc<{
        success?: boolean;
        settings?: Partial<AppSettings>;
      }>("settings.saveSettings", nextSettings);

      if (result?.settings) {
        const normalized = normalizeSettings(result.settings);
        setSettings(normalized);
        setCustomPackageDraft(normalized.customPythonPackage);
        setTransparencyTargetDraft(normalized.windowTransparencyTarget);
      }
    },
    []
  );

  const patchSettings = useCallback(
    (
      patch:
        | Partial<AppSettings>
        | ((current: AppSettings) => Partial<AppSettings>),
      options?: { iconStyleChanged?: boolean }
    ) => {
      setSettings((current) => {
        const resolvedPatch =
          typeof patch === "function" ? patch(current) : patch;
        const next = { ...current, ...resolvedPatch };

        if (isInitializedRef.current) {
          void persistSettings(next, options?.iconStyleChanged);
        }

        return next;
      });
    },
    [persistSettings]
  );

  useEffect(() => {
    if (!active) {
      return;
    }

    const load = async () => {
      try {
        const fetchedSettings = await invokeIpc<Partial<AppSettings>>(
          "settings.getSettings"
        );
        const normalized = normalizeSettings(fetchedSettings);
        setSettings(normalized);
        setCustomPackageDraft(normalized.customPythonPackage);
        setTransparencyTargetDraft(normalized.windowTransparencyTarget);
        setCurrentLocale(normalized.locale);
      } catch (error) {
        console.error("Failed to load settings:", error);
      } finally {
        isInitializedRef.current = true;
      }
    };

    void load();
  }, [active]);

  const loadUpdateStatus = useCallback(
    async (refresh = false) => {
      const channel = refresh
        ? "settings.checkForUpdates"
        : "settings.getUpdateStatus";

      try {
        const nextStatus = await invokeIpc<UpdateStatusSnapshot | null>(channel);
        if (nextStatus) {
          setUpdateStatus(nextStatus);
          setUpdateMessage(null);
        }
      } catch (error) {
        console.error("Failed to load update status:", error);
        setUpdateMessage(
          error instanceof Error ? error.message : "Failed to load update status."
        );
      }
    },
    []
  );

  useEffect(() => {
    if (!active) {
      return;
    }

    void loadUpdateStatus(false);
  }, [active, loadUpdateStatus]);

  const openGsmSettings = async () => {
    await invokeIpc("settings.openGSMSettings");
  };

  const handleCatalogAction = useCallback(
    async (action: SettingsCatalogAction) => {
      const result = await performSettingsCatalogAction(action);
      const maybeResult =
        result && typeof result === "object"
          ? (result as { success?: boolean })
          : null;

      if (action.type === "open-overlay-settings" && maybeResult?.success === false) {
        setHubMessage(
          "Overlay settings could not be opened automatically. Start/connect the overlay first, or use its tray icon."
        );
        return;
      }

      setHubMessage(null);
    },
    []
  );

  const runWindowTransparencyTool = async () => {
    await invokeIpc("settings.runWindowTransparencyTool");
  };

  const updateHotkey = (event: KeyboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const keys: string[] = [];

    if (event.ctrlKey) {
      keys.push("Ctrl");
    }
    if (event.shiftKey) {
      keys.push("Shift");
    }
    if (event.altKey) {
      keys.push("Alt");
    }

    if (!["Control", "Shift", "Alt"].includes(event.key)) {
      keys.push(event.key.toUpperCase());
    }

    patchSettings({ windowTransparencyToolHotkey: keys.join("+") });
  };

  const checkForUpdates = useCallback(async () => {
    setIsCheckingUpdates(true);
    setUpdateMessage(null);
    try {
      const nextStatus = await invokeIpc<UpdateStatusSnapshot | null>(
        "settings.checkForUpdates"
      );
      if (nextStatus) {
        setUpdateStatus(nextStatus);
      }
    } catch (error) {
      console.error("Failed to check for updates:", error);
      setUpdateMessage(
        error instanceof Error ? error.message : "Failed to check for updates."
      );
    } finally {
      setIsCheckingUpdates(false);
    }
  }, []);

  const updateNow = useCallback(async () => {
    setIsApplyingUpdates(true);
    setUpdateMessage(null);
    try {
      const nextStatus = await invokeIpc<UpdateStatusSnapshot | null>(
        "settings.updateNow"
      );
      if (nextStatus) {
        setUpdateStatus(nextStatus);
      }
    } catch (error) {
      console.error("Failed to apply updates:", error);
      setUpdateMessage(
        error instanceof Error ? error.message : "Failed to apply updates."
      );
    } finally {
      setIsApplyingUpdates(false);
      void loadUpdateStatus(false);
    }
  }, [loadUpdateStatus]);

  const hasPendingUpdates =
    updateStatus.backend.updateAvailable || updateStatus.app.updateAvailable;
  const updateBusy =
    isCheckingUpdates || isApplyingUpdates || updateStatus.anyUpdateInProgress;
  const checkedAt =
    updateStatus.app.checkedAt && updateStatus.backend.checkedAt
      ? new Date(updateStatus.app.checkedAt) > new Date(updateStatus.backend.checkedAt)
        ? updateStatus.app.checkedAt
        : updateStatus.backend.checkedAt
      : updateStatus.app.checkedAt || updateStatus.backend.checkedAt || null;
  const displayCheckedAt = formatCheckedAt(checkedAt);
  const combinedUpdateError =
    updateMessage || updateStatus.backend.error || updateStatus.app.error;
  const filteredCatalogEntries = useMemo(
    () => filterSettingsCatalogEntries(SETTINGS_CATALOG, settingsSearchQuery),
    [settingsSearchQuery]
  );
  const totalCatalogMatches = filteredCatalogEntries.length;
  const hasSearchQuery = settingsSearchQuery.trim().length > 0;
  const quickLinkEntries = useMemo(
    () =>
      SETTINGS_QUICK_LINK_IDS.map((id) =>
        SETTINGS_CATALOG.find((entry) => entry.id === id)
      ).filter(
        (entry): entry is (typeof SETTINGS_CATALOG)[number] => entry !== undefined
      ),
    []
  );

  return (
    <div className={`tab-panel ${active ? "active" : ""}`}>
      <div className="modern-tab">
        <section className="card legacy-card settings-hub-card">
          <div className="settings-hub-header">
            <div>
              <h2>Find a Setting</h2>
              <p className="muted settings-hub-copy">
                Search for what you want to change and GSM will open the right
                settings screen for you.
              </p>
            </div>
            <div className="settings-hub-shortcuts">
              <button
                type="button"
                onClick={() => {
                  void openGsmSettings();
                }}
              >
                Open Main GSM Settings
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  void handleCatalogAction({
                    type: "open-overlay-settings",
                    label: "Open Overlay Settings"
                  });
                }}
              >
                Open Overlay Settings
              </button>
            </div>
          </div>

          <div className="input-group settings-hub-search">
            <label htmlFor="settings-hub-search">Find Setting:</label>
            <input
              id="settings-hub-search"
              type="text"
              placeholder="Try: anki fields, OBS password, OCR area, furigana hotkey, JPDB"
              value={settingsSearchQuery}
              onChange={(event) => setSettingsSearchQuery(event.target.value)}
            />
          </div>

          <p className="muted settings-hub-count">
            Try everyday words, feature names, hotkeys, ports, field names, or tool
            names.
          </p>

          {hubMessage ? <p className="update-error-text">{hubMessage}</p> : null}

          <div className="settings-hub-quick-links">
            {quickLinkEntries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="launcher-docs-button secondary settings-hub-quick-link"
                onClick={() => {
                  void handleCatalogAction(entry.openAction);
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {hasSearchQuery ? (
            <div className="settings-hub-results">
              <div className="settings-hub-results-header">
                <strong>
                  {totalCatalogMatches} result{totalCatalogMatches === 1 ? "" : "s"}
                </strong>
              </div>
              {totalCatalogMatches === 0 ? (
                <p className="muted settings-hub-empty">
                  No matching settings found. Try broader words like{" "}
                  <span className="mono-text">anki</span>,{" "}
                  <span className="mono-text">hotkey</span>,{" "}
                  <span className="mono-text">overlay</span>,{" "}
                  <span className="mono-text">OBS</span>, or{" "}
                  <span className="mono-text">audio</span>.
                </p>
              ) : (
                <div className="settings-directory-list settings-directory-list--compact">
                  {filteredCatalogEntries.map((entry) => (
                    <div key={entry.id} className="settings-directory-item">
                      <div className="settings-directory-copy">
                        <div className="settings-directory-title-row">
                          <strong>{entry.label}</strong>
                          <span
                            className={`settings-owner-pill settings-owner-pill--${entry.owner}`}
                          >
                            {SETTINGS_LOCATION_LABELS[entry.owner]}
                          </span>
                        </div>
                        <p className="muted settings-directory-description">
                          {entry.shortDescription}
                        </p>
                        {entry.notes ? (
                          <p className="settings-directory-note">{entry.notes}</p>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className={
                          entry.openAction.type === "current-tab" ? "secondary" : ""
                        }
                        disabled={entry.openAction.type === "current-tab"}
                        onClick={() => {
                          void handleCatalogAction(entry.openAction);
                        }}
                      >
                        {entry.openAction.label}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </section>

        <div className="legacy-grid settings-grid">
          <section className="card legacy-card">
            <h2>Desktop App Settings</h2>
            <div className="form-group">
              <div className="input-group">
                <label htmlFor="icon-style">Icon Style:</label>
                <select
                  id="icon-style"
                  value={settings.iconStyle}
                  onChange={(event) =>
                    patchSettings(
                      {
                        iconStyle: event.target.value
                      },
                      { iconStyleChanged: true }
                    )
                  }
                >
                  <option value="gsm">Default</option>
                  <option value="gsm_cute">Anime Girl</option>
                  <option value="gsm_jacked">Jacked</option>
                  <option value="gsm_cursed">Cursed</option>
                  <option value="gsm_cute[tray]">Anime Girl (Tray Icon Also)</option>
                  <option value="gsm_jacked[tray]">Jacked (Tray Icon Also)</option>
                  <option value="gsm_cursed[tray]">Cursed (Tray Icon Also)</option>
                  <option value="random">Random</option>
                  <option value="random[tray]">Random (Tray Icon Also)</option>
                </select>
              </div>

              <div className="input-group">
                <label htmlFor="locale-select">Language:</label>
                <select
                  id="locale-select"
                  value={currentLocale}
                  onChange={(event) => {
                    const next = event.target.value;
                    setCurrentLocale(next);
                    patchSettings({ locale: next });
                  }}
                >
                  {SUPPORTED_LOCALES.map((loc) => (
                    <option key={loc.code} value={loc.code}>
                      {loc.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="input-group">
                <label htmlFor="start-console-minimized">Start Console Minimized:</label>
                <input
                  id="start-console-minimized"
                  type="checkbox"
                  checked={settings.startConsoleMinimized}
                  onChange={(event) =>
                    patchSettings({ startConsoleMinimized: event.target.checked })
                  }
                />
              </div>

              <div className="input-group">
                <label htmlFor="show-yuzu-tab">Show Yuzu Launcher:</label>
                <input
                  id="show-yuzu-tab"
                  type="checkbox"
                  checked={settings.showYuzuTab}
                  onChange={(event) =>
                    patchSettings({ showYuzuTab: event.target.checked })
                  }
                />
              </div>

              {isWindows ? (
                <div className="input-group">
                  <label htmlFor="run-transparency-startup">
                    Run Window Transparency Tool on Startup:
                  </label>
                  <input
                    id="run-transparency-startup"
                    type="checkbox"
                    checked={settings.runWindowTransparencyToolOnStartup}
                    onChange={(event) =>
                      patchSettings({
                        runWindowTransparencyToolOnStartup: event.target.checked
                      })
                    }
                  />
                </div>
              ) : null}

              {isWindows ? (
                <div className="input-group">
                  <label htmlFor="run-overlay-startup">Run Overlay on Startup:</label>
                  <input
                    id="run-overlay-startup"
                    type="checkbox"
                    checked={settings.runOverlayOnStartup}
                    onChange={(event) =>
                      patchSettings({ runOverlayOnStartup: event.target.checked })
                    }
                  />
                </div>
              ) : null}
            </div>
          </section>

          <section className="card legacy-card">
            <h2>Visibility Settings</h2>
            <div className="form-group">
              <div className="input-group settings-multi-select-group">
                <label htmlFor="visible-tabs-selector">Visible Tabs:</label>
                <select
                  id="visible-tabs-selector"
                  className="settings-multi-select"
                  multiple
                  value={settings.visibleTabs}
                  onChange={(event) => {
                    patchSettings({
                      visibleTabs: selectedOptionValues(event) as ControlledTab[]
                    });
                  }}
                  onMouseDown={(event: MouseEvent<HTMLSelectElement>) => {
                    event.preventDefault();
                    const option = event.target as HTMLOptionElement;
                    if (option.tagName !== "OPTION") {
                      return;
                    }
                    patchSettings((current) => ({
                      visibleTabs: toggleValue(
                        current.visibleTabs,
                        option.value
                      ) as ControlledTab[]
                    }));
                  }}
                >
                  {VISIBLE_TAB_OPTIONS.map((tab) => (
                    <option key={tab.id} value={tab.id}>
                      {tab.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="form-group">
              <div className="input-group">
                <label htmlFor="stats-target">Stats Target:</label>
                <select
                  id="stats-target"
                  value={settings.statsEndpoint}
                  onChange={(event) =>
                    patchSettings({ statsEndpoint: event.target.value })
                  }
                >
                  {STATS_ENDPOINT_OPTIONS.map((endpoint) => (
                    <option key={endpoint} value={endpoint}>
                      {endpoint}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          {isWindows ? (
            <section className="card legacy-card">
              <h2>Transparency Tool (Deprecated)</h2>
              <div className="form-group">
                <div className="input-group">
                  <label htmlFor="window-transparency-hotkey">Tool Hotkey:</label>
                  <input
                    id="window-transparency-hotkey"
                    type="text"
                    value={settings.windowTransparencyToolHotkey}
                    onKeyDown={updateHotkey}
                    readOnly
                  />
                </div>

                <div className="input-group">
                  <label htmlFor="window-transparency-target">Window Target:</label>
                  <input
                    id="window-transparency-target"
                    type="text"
                    placeholder="Leave empty to target focused window"
                    value={transparencyTargetDraft}
                    onChange={(event) =>
                      setTransparencyTargetDraft(event.target.value)
                    }
                    onBlur={() =>
                      patchSettings({
                        windowTransparencyTarget: transparencyTargetDraft.trim()
                      })
                    }
                  />
                </div>

                <div className="input-group">
                  <button
                    type="button"
                    onClick={() => {
                      void runWindowTransparencyTool();
                    }}
                  >
                    Run Window Transparency Tool
                  </button>
                </div>
              </div>
            </section>
          ) : null}

          <section className="card legacy-card">
            <h2>Updates</h2>
            <div className="form-group">
              <div className="input-group">
                <label htmlFor="auto-update-gsm">Auto Update:</label>
                <input
                  id="auto-update-gsm"
                  type="checkbox"
                  checked={settings.autoUpdateGSMApp}
                  onChange={(event) =>
                    patchSettings({ autoUpdateGSMApp: event.target.checked })
                  }
                />
              </div>

              <div className="input-group">
                <label htmlFor="pull-pre-releases" title="Receive beta updates from the develop branch. Only newer versions will be offered.">
                  Beta Updates:
                </label>
                <input
                  id="pull-pre-releases"
                  type="checkbox"
                  checked={settings.pullPreReleases}
                  onChange={(event) =>
                    patchSettings({ pullPreReleases: event.target.checked })
                  }
                />
              </div>
            </div>

            <div className="settings-update-panel">
              <p className="muted">
                Check both the backend package and the desktop app from here.
              </p>

              <div className="update-version-list">
                <div className="update-version-row">
                  <div>
                    <strong>GameSentenceMiner Backend</strong>
                    <div className="update-version-meta">
                      Current: {getDisplayCurrentVersion(updateStatus.backend)}
                    </div>
                    {updateStatus.backend.source === "prerelease-branch" ? (
                      <div className="update-version-meta">
                        Channel: {getDisplayLatestVersion("backend", updateStatus.backend)}
                      </div>
                    ) : (
                      <div className="update-version-meta">
                        Latest: {getDisplayLatestVersion("backend", updateStatus.backend)}
                      </div>
                    )}
                  </div>
                  <div className="update-version-state">
                    {updateStatus.backend.updateAvailable &&
                    updateStatus.backend.latestVersion ? (
                      <div className="update-version-delta">
                        <span className="update-version-current">
                          {getDisplayCurrentVersion(updateStatus.backend)}
                        </span>
                        <span className="update-version-arrow">→</span>
                        <span className="update-version-next">
                          {getDisplayLatestVersion("backend", updateStatus.backend)}
                        </span>
                      </div>
                    ) : (
                      <span className="update-version-stable">
                        {updateStatus.backend.source === "prerelease-branch"
                          ? "Manual branch tracking"
                          : "Up to date"}
                      </span>
                    )}
                  </div>
                </div>

                <div className="update-version-row">
                  <div>
                    <strong>Electron App</strong>
                    <div className="update-version-meta">
                      Current: {getDisplayCurrentVersion(updateStatus.app)}
                    </div>
                    <div className="update-version-meta">
                      Latest: {getDisplayLatestVersion("app", updateStatus.app)}
                    </div>
                  </div>
                  <div className="update-version-state">
                    {updateStatus.app.updateAvailable &&
                    updateStatus.app.latestVersion ? (
                      <div className="update-version-delta">
                        <span className="update-version-current">
                          {getDisplayCurrentVersion(updateStatus.app)}
                        </span>
                        <span className="update-version-arrow">→</span>
                        <span className="update-version-next">
                          {getDisplayLatestVersion("app", updateStatus.app)}
                        </span>
                      </div>
                    ) : (
                      <span className="update-version-stable">Up to date</span>
                    )}
                  </div>
                </div>
              </div>

              {displayCheckedAt ? (
                <p className="update-version-meta">Last checked: {displayCheckedAt}</p>
              ) : null}

              {combinedUpdateError ? (
                <p className="update-error-text">{combinedUpdateError}</p>
              ) : null}

              <div className="input-group wrap settings-update-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    void checkForUpdates();
                  }}
                  disabled={updateBusy}
                >
                  {isCheckingUpdates ? "Checking..." : "Check for Updates"}
                </button>
                <button
                  type="button"
                  className={
                    hasPendingUpdates
                      ? "update-action-button update-action-button--available"
                      : "update-action-button secondary"
                  }
                  onClick={() => {
                    void updateNow();
                  }}
                  disabled={!hasPendingUpdates || updateBusy}
                >
                  {isApplyingUpdates || updateStatus.anyUpdateInProgress
                    ? "Updating..."
                    : "Update Now"}
                </button>
              </div>
            </div>
          </section>

          {/* <section className="card legacy-card">
            <h2>Debug Settings</h2>
            <div className="form-group">
              <div className="input-group">
                <label htmlFor="custom-python-package">Custom Python Package:</label>
                <input
                  id="custom-python-package"
                  type="text"
                  value={customPackageDraft}
                  onChange={(event) => setCustomPackageDraft(event.target.value)}
                  onBlur={() =>
                    patchSettings({ customPythonPackage: customPackageDraft.trim() })
                  }
                />
              </div>
            </div>
          </section> */}
        </div>
      </div>
    </div>
  );
}
