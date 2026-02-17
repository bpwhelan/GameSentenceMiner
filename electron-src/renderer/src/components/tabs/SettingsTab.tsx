import {
  useCallback,
  type ChangeEvent,
  useEffect,
  type MouseEvent,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import { invokeIpc, sendIpc } from "../../lib/ipc";
import type { AppSettings, ControlledTab } from "../../types/models";

const DEFAULT_SETTINGS: AppSettings = {
  autoUpdateGSMApp: false,
  iconStyle: "gsm",
  startConsoleMinimized: false,
  customPythonPackage: "GameSentenceMiner",
  showYuzuTab: false,
  windowTransparencyToolHotkey: "Ctrl+Alt+Y",
  windowTransparencyTarget: "",
  runWindowTransparencyToolOnStartup: false,
  runOverlayOnStartup: false,
  visibleTabs: ["launcher", "stats", "python", "console"],
  statsEndpoint: "overview"
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
    statsEndpoint: value.statsEndpoint || DEFAULT_SETTINGS.statsEndpoint
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

export function SettingsTab({ active }: SettingsTabProps) {
  const platform = window.gsmEnv?.platform ?? "win32";
  const isWindows = platform === "win32";

  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [customPackageDraft, setCustomPackageDraft] = useState(
    DEFAULT_SETTINGS.customPythonPackage
  );
  const [transparencyTargetDraft, setTransparencyTargetDraft] = useState(
    DEFAULT_SETTINGS.windowTransparencyTarget
  );

  const isInitializedRef = useRef(false);

  const persistSettings = useCallback(
    async (nextSettings: AppSettings, iconStyleChanged = false) => {
      if (iconStyleChanged) {
        sendIpc("settings.iconStyleChanged", nextSettings.iconStyle);
      }
      await invokeIpc("settings.saveSettings", nextSettings);
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
      } catch (error) {
        console.error("Failed to load settings:", error);
      } finally {
        isInitializedRef.current = true;
      }
    };

    void load();
  }, [active]);

  const openGsmSettings = async () => {
    await invokeIpc("settings.openGSMSettings");
  };

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

  return (
    <div className={`tab-panel ${active ? "active" : ""}`}>
      <div className="modern-tab">
        <section className="card legacy-card" style={{ marginBottom: '20px' }}>
          <h2>⚠️ Main Settings</h2>
          <p style={{ marginBottom: '15px' }}>
            Most of GSM's settings are not located here. 
            The main GSM settings (Anki, Audio, Screenshot, etc.) 
            can be accessed using the button below or from the "Pickaxe" Tray icon:
          </p>
          <div className="form-group">
            <div className="input-group">
              <button 
                type="button"
                onClick={() => {
                  void openGsmSettings();
                }}
              >
                Show GSM Settings
              </button>
            </div>
          </div>
        </section>

        <div className="legacy-grid settings-grid">
          <section className="card legacy-card">
            <h2>Settings</h2>
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
