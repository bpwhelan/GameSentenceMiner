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
import { invokeIpc, onIpc, sendIpc } from "../../lib/ipc";
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
  SETTINGS_CATALOG
} from "./settingsCatalog";
import { SUPPORTED_LOCALES, useLocale, useTranslation } from "../../i18n";
import type { SettingsCatalogOwner } from "../../types/settings";
import { applyTheme, DEFAULT_THEME, THEME_GROUPS } from "../../lib/theme";
import {
  SETTINGS_BACKUP_CATEGORY_IDS,
  type SettingsBackupCategoryId
} from "../../../../shared/settings_backup";

const CATALOG_I18N_KEYS: Record<string, string> = {
  "desktop-appearance-startup": "desktopAppearance",
  "desktop-tabs-and-stats": "desktopTabs",
  "desktop-updates": "desktopUpdates",
  "gsm-key-settings": "keySettings",
  "gsm-general": "general",
  "gsm-anki": "anki",
  "gsm-screenshot": "screenshot",
  "gsm-audio": "audio",
  "gsm-obs": "obs",
  "gsm-ai": "ai",
  "gsm-advanced-network": "advanced",
  "gsm-profiles": "profiles",
  "overlay-display-hotkeys": "overlayDisplay",
  "overlay-translation-reader": "overlayTranslation",
  "overlay-gamepad": "overlayGamepad"
};

const ACTION_I18N_KEYS: Record<string, string> = {
  "current-tab": "settings.catalog.alreadyOnScreen",
  "open-gsm-settings": "settings.catalog.openGSMSettings",
  "open-overlay-settings": "settings.catalog.openOverlaySettings"
};

const LOCATION_I18N_KEYS: Record<SettingsCatalogOwner, string> = {
  electron: "settings.catalog.locationElectron",
  python: "settings.catalog.locationPython",
  overlay: "settings.catalog.locationOverlay"
};

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
  quitOnWindowClose: false,
  textCaptureWizardEnabled: true,
  visibleTabs: ["launcher", "stats", "python", "console"],
  statsEndpoint: "overview",
  databaseBackupEnabled: false,
  databaseBackupDirectory: "",
  databaseBackupRetentionCount: 2,
  singlePort: 7275,
  locale: "en",
  theme: DEFAULT_THEME
};

const DEFAULT_UPDATE_STATUS: UpdateStatusSnapshot = {
  backend: {
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
    checkedAt: null,
    error: null,
    checking: false
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

const VISIBLE_TAB_OPTIONS: Array<{ id: ControlledTab; labelKey: string }> = [
  { id: "launcher", labelKey: "settings.visibility.tabGameSettings" },
  { id: "stats", labelKey: "settings.visibility.tabStats" },
  { id: "python", labelKey: "settings.visibility.tabPython" },
  { id: "console", labelKey: "settings.visibility.tabConsole" }
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
  "overlay-display-hotkeys",
  "overlay-gamepad"
];

const SETTINGS_BACKUP_PROGRESS_CHANNEL = "settings-backup-progress";
const DATA_RELOCATE_PROGRESS_CHANNEL = "data.relocate.progress";

interface SettingsTabProps {
  active: boolean;
}

interface SettingsBackupResult {
  success?: boolean;
  canceled?: boolean;
  error?: string;
  filePath?: string;
  fileCount?: number;
  restartRequired?: boolean;
}

interface DataRelocateResult {
  success?: boolean;
  canceled?: boolean;
  error?: string;
}

type DataRelocateProgressPhase =
  | "validating"
  | "copying"
  | "finalizing"
  | "done";

const DATA_RELOCATE_PHASE_I18N_KEYS: Record<
  DataRelocateProgressPhase,
  string
> = {
  validating: "settings.dataFolder.progress.validating",
  copying: "settings.dataFolder.progress.copying",
  finalizing: "settings.dataFolder.progress.finalizing",
  done: "settings.dataFolder.progress.done"
};

type SettingsBackupOperation = "create" | "restore";

type SettingsBackupProgressPhase =
  | "scanning"
  | "archiving"
  | "extracting"
  | "stopping-obs"
  | "stopping-python"
  | "restoring"
  | "restarting-python"
  | "done"
  | "error";

interface SettingsBackupProgressEvent {
  operation: SettingsBackupOperation;
  phase: SettingsBackupProgressPhase;
  fileName?: string;
  completed?: number;
  total?: number;
  progress?: number | null;
}

const BACKUP_PROGRESS_PHASE_I18N_KEYS: Record<SettingsBackupProgressPhase, string> = {
  scanning: "settings.backup.progress.scanning",
  archiving: "settings.backup.progress.archiving",
  extracting: "settings.backup.progress.extracting",
  "stopping-obs": "settings.backup.progress.stoppingObs",
  "stopping-python": "settings.backup.progress.stoppingPython",
  restoring: "settings.backup.progress.restoring",
  "restarting-python": "settings.backup.progress.restartingPython",
  done: "settings.backup.progress.done",
  error: "settings.backup.progress.error"
};

interface BackupSelectionNode {
  id: string;
  labelKey: string;
  category?: SettingsBackupCategoryId;
  children?: BackupSelectionNode[];
}

function getBackupSelectionTree(isWindows: boolean): BackupSelectionNode[] {
  const settingsChildren: BackupSelectionNode[] = [
    {
      id: "python-settings",
      category: "python-settings",
      labelKey: "settings.backup.categories.pythonSettings"
    },
    {
      id: "desktop-settings",
      category: "desktop-settings",
      labelKey: "settings.backup.categories.desktopSettings"
    },
    {
      id: "overlay-settings",
      category: "overlay-settings",
      labelKey: "settings.backup.categories.overlaySettings"
    },
    {
      id: "scene-config",
      category: "scene-config",
      labelKey: "settings.backup.categories.sceneConfig"
    },
    {
      id: "ocr-configs",
      category: "ocr-configs",
      labelKey: "settings.backup.categories.ocrConfigs"
    },
    ...(isWindows
      ? [
          {
            id: "obs-config",
            category: "obs-config" as const,
            labelKey: "settings.backup.categories.obsConfig"
          }
        ]
      : []),
    {
      id: "text-hook-settings",
      category: "text-hook-settings",
      labelKey: "settings.backup.categories.textHookSettings"
    },
    {
      id: "window-layouts",
      category: "window-layouts",
      labelKey: "settings.backup.categories.windowLayouts"
    }
  ];

  return [
    {
      id: "all",
      labelKey: "settings.backup.categories.all",
      children: [
        {
          id: "database",
          category: "database",
          labelKey: "settings.backup.categories.database"
        },
        {
          id: "settings",
          labelKey: "settings.backup.categories.settings",
          children: settingsChildren
        },
        {
          id: "yomitan",
          category: "yomitan",
          labelKey: "settings.backup.categories.yomitan"
        },
        {
          id: "customizations",
          labelKey: "settings.backup.categories.customizations",
          children: [
            {
              id: "plugins",
              category: "plugins",
              labelKey: "settings.backup.categories.plugins"
            },
            {
              id: "agent-scripts",
              category: "agent-scripts",
              labelKey: "settings.backup.categories.agentScripts"
            },
            {
              id: "user-scripts",
              category: "user-scripts",
              labelKey: "settings.backup.categories.userScripts"
            }
          ]
        }
      ]
    }
  ];
}

function getBackupNodeCategories(node: BackupSelectionNode): SettingsBackupCategoryId[] {
  if (node.category) {
    return [node.category];
  }
  return (node.children ?? []).flatMap(getBackupNodeCategories);
}

interface BackupSelectionTreeNodeProps {
  node: BackupSelectionNode;
  selected: ReadonlySet<SettingsBackupCategoryId>;
  disabled: boolean;
  onToggle: (categories: SettingsBackupCategoryId[], checked: boolean) => void;
}

function BackupSelectionTreeNode({
  node,
  selected,
  disabled,
  onToggle
}: BackupSelectionTreeNodeProps) {
  const t = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const categories = getBackupNodeCategories(node);
  const selectedCount = categories.filter((category) => selected.has(category)).length;
  const checked = categories.length > 0 && selectedCount === categories.length;
  const indeterminate = selectedCount > 0 && !checked;

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <div
      className="settings-backup-tree-node"
      role="treeitem"
      aria-checked={indeterminate ? "mixed" : checked}
    >
      <label className="settings-backup-tree-label">
        <input
          ref={inputRef}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onToggle(categories, event.currentTarget.checked)}
        />
        <span>{t(node.labelKey)}</span>
      </label>
      {node.children?.length ? (
        <div className="settings-backup-tree-children" role="group">
          {node.children.map((child) => (
            <BackupSelectionTreeNode
              key={child.id}
              node={child}
              selected={selected}
              disabled={disabled}
              onToggle={onToggle}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
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
    databaseBackupDirectory:
      typeof value.databaseBackupDirectory === "string"
        ? value.databaseBackupDirectory
        : DEFAULT_SETTINGS.databaseBackupDirectory,
    databaseBackupRetentionCount:
      typeof value.databaseBackupRetentionCount === "number" &&
      Number.isFinite(value.databaseBackupRetentionCount)
        ? Math.max(1, Math.min(1000, Math.trunc(value.databaseBackupRetentionCount)))
        : DEFAULT_SETTINGS.databaseBackupRetentionCount,
    locale: value.locale || DEFAULT_SETTINGS.locale,
    theme: value.theme || DEFAULT_SETTINGS.theme
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
  _label: "backend" | "app",
  status: UpdateTargetStatus
): string {
  if (status.latestVersion && status.latestVersion.trim().length > 0) {
    return status.latestVersion;
  }

  return "Unknown";
}

function isSettingsBackupOperation(value: unknown): value is SettingsBackupOperation {
  return value === "create" || value === "restore";
}

function isSettingsBackupProgressPhase(value: unknown): value is SettingsBackupProgressPhase {
  return (
    value === "scanning" ||
    value === "archiving" ||
    value === "extracting" ||
    value === "stopping-obs" ||
    value === "stopping-python" ||
    value === "restoring" ||
    value === "restarting-python" ||
    value === "done" ||
    value === "error"
  );
}

function normalizeProgressNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeDataRelocatePhase(value: unknown): DataRelocateProgressPhase | null {
  if (!value || typeof value !== "object" || !("phase" in value)) {
    return null;
  }
  const phase = (value as { phase?: unknown }).phase;
  return phase === "validating" ||
    phase === "copying" ||
    phase === "finalizing" ||
    phase === "done"
    ? phase
    : null;
}

function normalizeOptionalCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function normalizeSettingsBackupProgress(
  value: unknown
): SettingsBackupProgressEvent | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const payload = value as Partial<SettingsBackupProgressEvent>;
  if (
    !isSettingsBackupOperation(payload.operation) ||
    !isSettingsBackupProgressPhase(payload.phase)
  ) {
    return null;
  }

  return {
    operation: payload.operation,
    phase: payload.phase,
    fileName: typeof payload.fileName === "string" ? payload.fileName : undefined,
    completed: normalizeOptionalCount(payload.completed),
    total: normalizeOptionalCount(payload.total),
    progress: normalizeProgressNumber(payload.progress)
  };
}

export function SettingsTab({ active }: SettingsTabProps) {
  const t = useTranslation();
  const platform = window.gsmEnv?.platform ?? "win32";
  const isWindows = platform === "win32";
  const backupSelectionTree = useMemo(
    () => getBackupSelectionTree(isWindows),
    [isWindows]
  );
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
  const [isLoadingReleaseNotes, setIsLoadingReleaseNotes] = useState(false);
  const [settingsSearchQuery, setSettingsSearchQuery] = useState("");
  const [hubMessage, setHubMessage] = useState<string | null>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState<"create" | "restore" | null>(null);
  const [backupProgress, setBackupProgress] =
    useState<SettingsBackupProgressEvent | null>(null);
  const [selectedBackupCategories, setSelectedBackupCategories] = useState<
    Set<SettingsBackupCategoryId>
  >(() => new Set(getBackupNodeCategories(getBackupSelectionTree(isWindows)[0])));
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [defaultDataDir, setDefaultDataDir] = useState<string | null>(null);
  const [dataRelocationBusy, setDataRelocationBusy] = useState<
    "change" | "restore" | null
  >(null);
  const [dataRelocationMessage, setDataRelocationMessage] = useState<string | null>(null);
  const [dataRelocationPhase, setDataRelocationPhase] =
    useState<DataRelocateProgressPhase | null>(null);

  const isInitializedRef = useRef(false);

  const toggleBackupCategories = useCallback(
    (categories: SettingsBackupCategoryId[], checked: boolean) => {
      setSelectedBackupCategories((current) => {
        const next = new Set(current);
        for (const category of categories) {
          if (checked) {
            next.add(category);
          } else {
            next.delete(category);
          }
        }
        return next;
      });
    },
    []
  );

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

  useEffect(() => {
    if (!active) {
      return;
    }

    void Promise.all([
      invokeIpc<string>("data.getCurrentDir"),
      invokeIpc<string>("data.getDefaultDir")
    ])
      .then(([currentDir, originalDir]) => {
        if (typeof currentDir === "string") {
          setDataDir(currentDir);
        }
        if (typeof originalDir === "string") {
          setDefaultDataDir(originalDir);
        }
      })
      .catch((error) => {
        console.error("Failed to load GSM data folder:", error);
        setDataRelocationMessage(
          t("settings.dataFolder.loadFailed", {
            error:
              error instanceof Error
                ? error.message
                : t("settings.dataFolder.unknownError")
          })
        );
      });
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
          t("settings.hub.overlayNotAvailable")
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

  const selectDatabaseBackupDirectory = useCallback(async () => {
    const result = await invokeIpc<{ canceled?: boolean; directory?: string }>(
      "settings.selectDatabaseBackupDirectory"
    );
    if (!result?.canceled && typeof result?.directory === "string") {
      patchSettings({ databaseBackupDirectory: result.directory });
    }
  }, [patchSettings]);

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

  const showUpdateChangelogPreview = useCallback(async () => {
    const fromVersion = updateStatus.app.currentVersion?.trim() ?? "";
    const toVersion = updateStatus.app.latestVersion?.trim() ?? "";
    if (!fromVersion || !toVersion) {
      setUpdateMessage(t("settings.updates.releaseNotesUnavailable"));
      return;
    }

    setIsLoadingReleaseNotes(true);
    setUpdateMessage(null);
    try {
      const snapshot = await invokeIpc<unknown>(
        "settings.showUpdateChangelogPreview",
        {
          fromVersion,
          toVersion,
          includePrereleases: updateStatus.app.channel === "beta"
        }
      );
      if (!snapshot) {
        setUpdateMessage(t("settings.updates.releaseNotesUnavailable"));
      }
    } catch (error) {
      console.error("Failed to load update release notes:", error);
      setUpdateMessage(
        error instanceof Error
          ? error.message
          : t("settings.updates.releaseNotesUnavailable")
      );
    } finally {
      setIsLoadingReleaseNotes(false);
    }
  }, [
    t,
    updateStatus.app.channel,
    updateStatus.app.currentVersion,
    updateStatus.app.latestVersion
  ]);

  useEffect(() => {
    return onIpc(SETTINGS_BACKUP_PROGRESS_CHANNEL, (_event, payload) => {
      const progress = normalizeSettingsBackupProgress(payload);
      if (progress) {
        setBackupProgress(progress);
      }
    });
  }, []);

  useEffect(() => {
    return onIpc(DATA_RELOCATE_PROGRESS_CHANNEL, (_event, payload) => {
      const phase = normalizeDataRelocatePhase(payload);
      if (phase) {
        setDataRelocationPhase(phase);
      }
    });
  }, []);

  const relocateDataFolder = useCallback(async () => {
    setDataRelocationBusy("change");
    setDataRelocationMessage(null);
    setDataRelocationPhase("validating");
    try {
      const result = await invokeIpc<DataRelocateResult>("data.relocate");
      if (result?.canceled) {
        setDataRelocationMessage(t("settings.dataFolder.cancelled"));
        setDataRelocationPhase(null);
      } else if (!result?.success) {
        setDataRelocationMessage(
          t("settings.dataFolder.failed", {
            error: result?.error ?? t("settings.dataFolder.unknownError")
          })
        );
        setDataRelocationPhase(null);
      }
    } catch (error) {
      setDataRelocationMessage(
        t("settings.dataFolder.failed", {
          error:
            error instanceof Error
              ? error.message
              : t("settings.dataFolder.unknownError")
        })
      );
      setDataRelocationPhase(null);
    } finally {
      setDataRelocationBusy(null);
    }
  }, [t]);

  const restoreDefaultDataFolder = useCallback(async () => {
    setDataRelocationBusy("restore");
    setDataRelocationMessage(null);
    setDataRelocationPhase("validating");
    try {
      const result = await invokeIpc<DataRelocateResult>("data.restoreDefault");
      if (result?.canceled) {
        setDataRelocationMessage(t("settings.dataFolder.restoreCancelled"));
        setDataRelocationPhase(null);
      } else if (!result?.success) {
        setDataRelocationMessage(
          t("settings.dataFolder.restoreFailed", {
            error: result?.error ?? t("settings.dataFolder.unknownError")
          })
        );
        setDataRelocationPhase(null);
      }
    } catch (error) {
      setDataRelocationMessage(
        t("settings.dataFolder.restoreFailed", {
          error:
            error instanceof Error
              ? error.message
              : t("settings.dataFolder.unknownError")
        })
      );
      setDataRelocationPhase(null);
    } finally {
      setDataRelocationBusy(null);
    }
  }, [t]);

  const createSettingsBackup = useCallback(async () => {
    setBackupBusy("create");
    setBackupMessage(null);
    setBackupProgress(null);
    try {
      const categories = SETTINGS_BACKUP_CATEGORY_IDS.filter((category) =>
        selectedBackupCategories.has(category)
      );
      const result = await invokeIpc<SettingsBackupResult>("settings.createBackup", {
        categories
      });
      if (result?.canceled) {
        setBackupMessage(t("settings.backup.cancelled"));
        setBackupProgress(null);
      } else if (result?.success) {
        setBackupMessage(
          t("settings.backup.created", {
            path: result.filePath ?? "",
            count: String(result.fileCount ?? 0)
          })
        );
      } else {
        setBackupMessage(
          t("settings.backup.failed", {
            error: result?.error ?? t("settings.backup.unknownError")
          })
        );
      }
    } catch (error) {
      console.error("Failed to create settings backup:", error);
      setBackupProgress({
        operation: "create",
        phase: "error",
        progress: null
      });
      setBackupMessage(
        t("settings.backup.failed", {
          error: error instanceof Error ? error.message : t("settings.backup.unknownError")
        })
      );
    } finally {
      setBackupBusy(null);
    }
  }, [selectedBackupCategories, t]);

  const restoreSettingsBackup = useCallback(async () => {
    setBackupBusy("restore");
    setBackupMessage(null);
    setBackupProgress(null);
    try {
      const categories = SETTINGS_BACKUP_CATEGORY_IDS.filter((category) =>
        selectedBackupCategories.has(category)
      );
      const result = await invokeIpc<SettingsBackupResult>("settings.restoreBackup", {
        categories
      });
      if (result?.canceled) {
        setBackupMessage(t("settings.backup.cancelled"));
        setBackupProgress(null);
      } else if (result?.success) {
        setBackupMessage(
          result.restartRequired
            ? t("settings.backup.restoredRestart")
            : t("settings.backup.restored")
        );
      } else {
        setBackupMessage(
          t("settings.backup.failed", {
            error: result?.error ?? t("settings.backup.unknownError")
          })
        );
      }
    } catch (error) {
      console.error("Failed to restore settings backup:", error);
      setBackupProgress({
        operation: "restore",
        phase: "error",
        progress: null
      });
      setBackupMessage(
        t("settings.backup.failed", {
          error: error instanceof Error ? error.message : t("settings.backup.unknownError")
        })
      );
    } finally {
      setBackupBusy(null);
    }
  }, [selectedBackupCategories, t]);

  const hasPendingUpdates =
    updateStatus.backend.updateAvailable || updateStatus.app.updateAvailable;
  const canPreviewUpdateChangelog = Boolean(
    updateStatus.app.updateAvailable &&
      updateStatus.app.currentVersion?.trim() &&
      updateStatus.app.latestVersion?.trim()
  );
  const updateBusy =
    isCheckingUpdates ||
    isApplyingUpdates ||
    isLoadingReleaseNotes ||
    updateStatus.anyUpdateInProgress;
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
  const backupProgressLabel = backupProgress
    ? t("settings.backup.progressSummary", {
        operation:
          backupProgress.operation === "create"
            ? t("settings.backup.operationCreate")
            : t("settings.backup.operationRestore"),
        phase: t(BACKUP_PROGRESS_PHASE_I18N_KEYS[backupProgress.phase])
      })
    : null;
  const backupProgressPercent =
    backupProgress?.progress === null || backupProgress?.progress === undefined
      ? null
      : Math.round(backupProgress.progress * 100);
  const backupProgressCount =
    backupProgress?.total && backupProgress.total > 0
      ? t("settings.backup.progressCount", {
          completed: String(backupProgress.completed ?? 0),
          total: String(backupProgress.total)
        })
      : null;
  const dataRelocationProgressLabel = dataRelocationPhase
    ? t(DATA_RELOCATE_PHASE_I18N_KEYS[dataRelocationPhase])
    : null;
  const usingCustomDataDir =
    dataDir !== null && defaultDataDir !== null && dataDir !== defaultDataDir;
  const hasBackupSelection = selectedBackupCategories.size > 0;

  return (
    <div className={`tab-panel ${active ? "active" : ""}`}>
      <div className="modern-tab">
        <section className="card legacy-card settings-hub-card">
          <div className="settings-hub-header">
            <div>
              <h2>{t("settings.hub.findSetting")}</h2>
              <p className="muted settings-hub-copy">
                {t("settings.hub.findDescription")}
              </p>
            </div>
            <div className="settings-hub-shortcuts">
              <button
                type="button"
                onClick={() => {
                  void openGsmSettings();
                }}
              >
                {t("settings.hub.openGSMSettings")}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  void handleCatalogAction({
                    type: "open-overlay-settings",
                    label: t("settings.hub.openOverlaySettings")
                  });
                }}
              >
                {t("settings.hub.openOverlaySettings")}
              </button>
            </div>
          </div>

          <div className="input-group settings-hub-search">
            <label htmlFor="settings-hub-search">{t("settings.hub.searchLabel")}</label>
            <input
              id="settings-hub-search"
              type="text"
              placeholder={t("settings.hub.searchPlaceholder")}
              value={settingsSearchQuery}
              onChange={(event) => setSettingsSearchQuery(event.target.value)}
            />
          </div>

          <p className="muted settings-hub-count">
            {t("settings.hub.searchHint")}
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
                {t(`settings.catalog.${CATALOG_I18N_KEYS[entry.id]}.label`)}
              </button>
            ))}
          </div>

          {hasSearchQuery ? (
            <div className="settings-hub-results">
              <div className="settings-hub-results-header">
                <strong>
                  {totalCatalogMatches === 1 ? t("settings.hub.resultCount", { count: String(totalCatalogMatches) }) : t("settings.hub.resultCountPlural", { count: String(totalCatalogMatches) })}
                </strong>
              </div>
              {totalCatalogMatches === 0 ? (
                <p className="muted settings-hub-empty">
                  {t("settings.hub.noResults")}
                </p>
              ) : (
                <div className="settings-directory-list settings-directory-list--compact">
                  {filteredCatalogEntries.map((entry) => (
                    <div key={entry.id} className="settings-directory-item">
                      <div className="settings-directory-copy">
                        <div className="settings-directory-title-row">
                          <strong>{t(`settings.catalog.${CATALOG_I18N_KEYS[entry.id]}.label`)}</strong>
                          <span
                            className={`settings-owner-pill settings-owner-pill--${entry.owner}`}
                          >
                            {t(LOCATION_I18N_KEYS[entry.owner])}
                          </span>
                        </div>
                        <p className="muted settings-directory-description">
                          {t(`settings.catalog.${CATALOG_I18N_KEYS[entry.id]}.description`)}
                        </p>
                        {entry.notes ? (
                          <p className="settings-directory-note">{t(`settings.catalog.${CATALOG_I18N_KEYS[entry.id]}.notes`)}</p>
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
                        {t(ACTION_I18N_KEYS[entry.openAction.type])}
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
            <h2>{t("settings.desktop.title")}</h2>
            <div className="form-group">
              <div className="input-group">
                <label htmlFor="icon-style">{t("settings.desktop.iconStyle")}</label>
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
                  <option value="gsm">{t("settings.desktop.iconDefault")}</option>
                  <option value="gsm_cute">{t("settings.desktop.iconAnimeGirl")}</option>
                  <option value="gsm_jacked">{t("settings.desktop.iconJacked")}</option>
                  <option value="gsm_cursed">{t("settings.desktop.iconCursed")}</option>
                  <option value="gsm_cute[tray]">{t("settings.desktop.iconAnimeGirlTray")}</option>
                  <option value="gsm_jacked[tray]">{t("settings.desktop.iconJackedTray")}</option>
                  <option value="gsm_cursed[tray]">{t("settings.desktop.iconCursedTray")}</option>
                  <option value="random">{t("settings.desktop.iconRandom")}</option>
                  <option value="random[tray]">{t("settings.desktop.iconRandomTray")}</option>
                </select>
              </div>

              <div className="input-group">
                <label htmlFor="locale-select">{t("settings.desktop.language")}</label>
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
                <label htmlFor="theme-select">{t("settings.desktop.theme")}</label>
                <select
                  id="theme-select"
                  value={settings.theme}
                  onChange={(event) => {
                    const next = event.target.value;
                    applyTheme(next);
                    patchSettings({ theme: next });
                  }}
                >
                  {THEME_GROUPS.map((group) => (
                    <optgroup key={group.category} label={t(group.labelKey)}>
                      {group.themes.map((theme) => (
                        <option key={theme.id} value={theme.id}>
                          {theme.labelKey ? t(theme.labelKey) : theme.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              <div className="input-group">
                <label htmlFor="start-console-minimized">{t("settings.desktop.startMinimized")}</label>
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
                <label htmlFor="show-yuzu-tab">{t("settings.desktop.showYuzuLauncher")}</label>
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
                    {t("settings.desktop.runTransparencyOnStartup")}
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
                  <label htmlFor="run-overlay-startup">{t("settings.desktop.runOverlayOnStartup")}</label>
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

              <div className="input-group">
                <label htmlFor="quit-on-window-close">
                  {t("settings.desktop.quitOnWindowClose")}
                </label>
                <input
                  id="quit-on-window-close"
                  type="checkbox"
                  checked={settings.quitOnWindowClose}
                  onChange={(event) =>
                    patchSettings({ quitOnWindowClose: event.target.checked })
                  }
                />
              </div>

              <div className="input-group">
                <label htmlFor="text-capture-wizard-enabled">
                  {t("settings.desktop.textCaptureWizard")}
                </label>
                <input
                  id="text-capture-wizard-enabled"
                  type="checkbox"
                  checked={settings.textCaptureWizardEnabled}
                  onChange={(event) =>
                    patchSettings({ textCaptureWizardEnabled: event.target.checked })
                  }
                />
              </div>
            </div>
          </section>

          <section className="card legacy-card">
            <h2>{t("settings.visibility.title")}</h2>
            <div className="form-group">
              <div className="input-group settings-multi-select-group">
                <label htmlFor="visible-tabs-selector">{t("settings.visibility.visibleTabs")}</label>
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
                      {t(tab.labelKey)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="form-group">
              <div className="input-group">
                <label htmlFor="stats-target">{t("settings.visibility.statsTarget")}</label>
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
              <h2>{t("settings.transparency.title")}</h2>
              <div className="form-group">
                <div className="input-group">
                  <label htmlFor="window-transparency-hotkey">{t("settings.transparency.toolHotkey")}</label>
                  <input
                    id="window-transparency-hotkey"
                    type="text"
                    value={settings.windowTransparencyToolHotkey}
                    onKeyDown={updateHotkey}
                    readOnly
                  />
                </div>

                <div className="input-group">
                  <label htmlFor="window-transparency-target">{t("settings.transparency.windowTarget")}</label>
                  <input
                    id="window-transparency-target"
                    type="text"
                    placeholder={t("settings.transparency.windowTargetPlaceholder")}
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
                    {t("settings.transparency.runTool")}
                  </button>
                </div>
              </div>
            </section>
          ) : null}

          <section className="card legacy-card">
            <h2>{t("settings.updates.title")}</h2>
            <div className="form-group">
              <div className="input-group">
                <label htmlFor="auto-update-gsm">{t("settings.updates.autoUpdate")}</label>
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
                <label htmlFor="pull-pre-releases" title={t("settings.updates.betaTooltip")}>
                  {t("settings.updates.betaUpdates")}
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
                {t("settings.updates.description")}
              </p>

              <div className="update-version-list">
                <div className="update-version-row">
                  <div>
                    <strong>{t("settings.updates.backend")}</strong>
                    <div className="update-version-meta">
                      {t("settings.updates.current", { version: getDisplayCurrentVersion(updateStatus.backend) })}
                    </div>
                    <div className="update-version-meta">
                      {t("settings.updates.latest", { version: getDisplayLatestVersion("backend", updateStatus.backend) })}
                    </div>
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
                        {t("settings.updates.upToDate")}
                      </span>
                    )}
                  </div>
                </div>

                <div className="update-version-row">
                  <div>
                    <strong>{t("settings.updates.electronApp")}</strong>
                    <div className="update-version-meta">
                      {t("settings.updates.current", { version: getDisplayCurrentVersion(updateStatus.app) })}
                    </div>
                    <div className="update-version-meta">
                      {t("settings.updates.latest", { version: getDisplayLatestVersion("app", updateStatus.app) })}
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
                      <span className="update-version-stable">{t("settings.updates.upToDate")}</span>
                    )}
                  </div>
                </div>
              </div>

              {displayCheckedAt ? (
                <p className="update-version-meta">{t("settings.updates.lastChecked", { time: displayCheckedAt ?? "" })}</p>
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
                  {isCheckingUpdates ? t("settings.updates.checking") : t("settings.updates.checkForUpdates")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    void showUpdateChangelogPreview();
                  }}
                  disabled={!canPreviewUpdateChangelog || updateBusy}
                >
                  {isLoadingReleaseNotes
                    ? t("settings.updates.loadingReleaseNotes")
                    : t("settings.updates.viewReleaseNotes")}
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
                    ? t("settings.updates.updating")
                    : t("settings.updates.updateNow")}
                </button>
              </div>
            </div>
          </section>

          <section className="card legacy-card">
            <h2>{t("settings.backup.title")}</h2>
            <div className="settings-update-panel">
              <div className="settings-automatic-backup">
                <h3>{t("settings.backup.automatic.title")}</h3>
                <p className="muted">{t("settings.backup.automatic.description")}</p>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={settings.databaseBackupEnabled}
                    onChange={(event) =>
                      patchSettings({ databaseBackupEnabled: event.currentTarget.checked })
                    }
                  />
                  <span>{t("settings.backup.automatic.enabled")}</span>
                </label>
                <label className="field-label" htmlFor="database-backup-count">
                  {t("settings.backup.automatic.retentionCount")}
                </label>
                <input
                  id="database-backup-count"
                  type="number"
                  min={1}
                  max={1000}
                  value={settings.databaseBackupRetentionCount}
                  disabled={!settings.databaseBackupEnabled}
                  onChange={(event) => {
                    const value = Number(event.currentTarget.value);
                    if (Number.isFinite(value)) {
                      patchSettings({
                        databaseBackupRetentionCount: Math.max(
                          1,
                          Math.min(1000, Math.trunc(value))
                        )
                      });
                    }
                  }}
                />
                <div className="settings-backup-directory">
                  <div>
                    <span className="field-label">
                      {t("settings.backup.automatic.directory")}
                    </span>
                    <p className="update-version-meta">
                      {settings.databaseBackupDirectory ||
                        t("settings.backup.automatic.defaultDirectory")}
                    </p>
                  </div>
                  <div className="input-group wrap">
                    <button
                      type="button"
                      className="secondary"
                      disabled={!settings.databaseBackupEnabled}
                      onClick={() => void selectDatabaseBackupDirectory()}
                    >
                      {t("settings.backup.automatic.chooseDirectory")}
                    </button>
                    {settings.databaseBackupDirectory ? (
                      <button
                        type="button"
                        className="secondary"
                        disabled={!settings.databaseBackupEnabled}
                        onClick={() => patchSettings({ databaseBackupDirectory: "" })}
                      >
                        {t("settings.backup.automatic.useDefaultDirectory")}
                      </button>
                    ) : null}
                  </div>
                </div>
                <p className="muted">{t("settings.backup.automatic.restartHint")}</p>
              </div>
              <p className="muted">{t("settings.backup.description")}</p>
              <p className="settings-backup-selection-hint">
                {t("settings.backup.selectionHint")}
              </p>
              <div className="settings-backup-tree" role="tree">
                {backupSelectionTree.map((node) => (
                  <BackupSelectionTreeNode
                    key={node.id}
                    node={node}
                    selected={selectedBackupCategories}
                    disabled={backupBusy !== null}
                    onToggle={toggleBackupCategories}
                  />
                ))}
              </div>
              {!hasBackupSelection ? (
                <p className="settings-backup-selection-error" role="alert">
                  {t("settings.backup.selectAtLeastOne")}
                </p>
              ) : null}
              <div className="input-group wrap settings-update-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    void createSettingsBackup();
                  }}
                  disabled={backupBusy !== null || !hasBackupSelection}
                >
                  {backupBusy === "create"
                    ? t("settings.backup.creating")
                    : t("settings.backup.create")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    void restoreSettingsBackup();
                  }}
                  disabled={backupBusy !== null || !hasBackupSelection}
                >
                  {backupBusy === "restore"
                    ? t("settings.backup.restoring")
                    : t("settings.backup.restore")}
                </button>
              </div>
              {backupProgress && backupProgressLabel ? (
                <div className="settings-backup-progress">
                  <div className="settings-backup-progress-top">
                    <strong>{backupProgressLabel}</strong>
                    {backupProgressPercent !== null ? (
                      <span>
                        {t("settings.backup.progressPercent", {
                          percent: String(backupProgressPercent)
                        })}
                      </span>
                    ) : null}
                  </div>
                  <div
                    className={`settings-backup-progress-bar ${
                      backupProgressPercent === null ? "is-running" : ""
                    }`}
                    role="progressbar"
                    aria-label={backupProgressLabel}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={backupProgressPercent ?? undefined}
                  >
                    <div
                      className={`settings-backup-progress-fill ${
                        backupProgressPercent === null ? "is-indeterminate" : ""
                      }`}
                      style={{
                        width:
                          backupProgressPercent === null
                            ? "36%"
                            : `${backupProgressPercent}%`
                      }}
                    />
                  </div>
                  {backupProgress.fileName ? (
                    <p className="settings-backup-progress-file">
                      {t("settings.backup.progressFile", {
                        file: backupProgress.fileName
                      })}
                    </p>
                  ) : null}
                  {backupProgressCount ? (
                    <p className="settings-backup-progress-count">
                      {backupProgressCount}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {backupMessage ? (
                <p className="update-version-meta">{backupMessage}</p>
              ) : null}
            </div>
          </section>

          <section className="card legacy-card">
            <h2>{t("settings.dataFolder.title")}</h2>
            <div className="settings-update-panel">
              <p className="muted">{t("settings.dataFolder.description")}</p>
              <p className="update-version-meta">
                {t("settings.dataFolder.current", {
                  path: dataDir ?? t("settings.dataFolder.loading")
                })}
              </p>
              {usingCustomDataDir ? (
                <>
                  <p className="update-version-meta">
                    {t("settings.dataFolder.original", {
                      path: defaultDataDir
                    })}
                  </p>
                  <p className="muted">{t("settings.dataFolder.restoreHint")}</p>
                </>
              ) : null}
              <div className="input-group wrap settings-update-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    void relocateDataFolder();
                  }}
                  disabled={dataRelocationBusy !== null}
                >
                  {dataRelocationBusy === "change"
                    ? t("settings.dataFolder.changing")
                    : t("settings.dataFolder.change")}
                </button>
                {usingCustomDataDir ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      void restoreDefaultDataFolder();
                    }}
                    disabled={dataRelocationBusy !== null}
                  >
                    {dataRelocationBusy === "restore"
                      ? t("settings.dataFolder.restoring")
                      : t("settings.dataFolder.restore")}
                  </button>
                ) : null}
              </div>
              {dataRelocationProgressLabel ? (
                <p className="update-version-meta">{dataRelocationProgressLabel}</p>
              ) : null}
              {dataRelocationMessage ? (
                <p className="update-version-meta">{dataRelocationMessage}</p>
              ) : null}
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
