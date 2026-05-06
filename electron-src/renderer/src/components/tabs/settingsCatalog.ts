import { invokeIpc } from "../../lib/ipc";
import type {
  SettingsCatalogAction,
  SettingsCatalogEntry,
  SettingsCatalogOwner
} from "../../types/settings";

const OPEN_CURRENT_TAB: SettingsCatalogAction = {
  type: "current-tab",
  label: "Already on this screen"
};

const OPEN_GSM_SETTINGS: SettingsCatalogAction = {
  type: "open-gsm-settings",
  label: "Open Main GSM Settings"
};

const OPEN_OVERLAY_SETTINGS: SettingsCatalogAction = {
  type: "open-overlay-settings",
  label: "Open Overlay Settings"
};

export const SETTINGS_LOCATION_LABELS: Record<SettingsCatalogOwner, string> = {
  electron: "This screen",
  python: "Main GSM settings",
  overlay: "Overlay settings"
};

export const SETTINGS_CATALOG: SettingsCatalogEntry[] = [
  {
    id: "desktop-appearance-startup",
    label: "Desktop app appearance and startup",
    owner: "electron",
    keywords: [
      "desktop",
      "app",
      "icon",
      "tray",
      "tray icon",
      "app icon",
      "desktop icon",
      "startup",
      "start minimized",
      "start console minimized",
      "run overlay on startup",
      "open overlay on startup",
      "launch overlay automatically",
      "show yuzu launcher",
      "transparency tool",
      "window transparency",
      "anime girl",
      "cute",
      "jacked",
      "cursed",
      "random icon"
    ],
    shortDescription: "Change desktop app visuals, tray icons, and startup behavior.",
    openAction: OPEN_CURRENT_TAB
  },
  {
    id: "desktop-tabs-and-stats",
    label: "Desktop tabs and stats",
    owner: "electron",
    keywords: [
      "tabs",
      "visible tabs",
      "hide tabs",
      "show tabs",
      "launcher tab",
      "stats tab",
      "python tab",
      "console tab",
      "navigation",
      "stats",
      "stats target",
      "overview",
      "goals",
      "anki stats",
      "search stats",
      "default stats page"
    ],
    shortDescription: "Show or hide desktop tabs and choose the default stats page.",
    openAction: OPEN_CURRENT_TAB
  },
  {
    id: "desktop-updates",
    label: "Updates and beta releases",
    owner: "electron",
    keywords: [
      "updates",
      "auto update",
      "beta",
      "pre release",
      "prerelease",
      "develop branch",
      "stable",
      "latest version",
      "update channel"
    ],
    shortDescription: "Control update checks and whether beta builds are offered.",
    openAction: OPEN_CURRENT_TAB,
    notes: "Some update changes take effect next launch."
  },
  {
    id: "gsm-key-settings",
    label: "Key Settings",
    owner: "python",
    keywords: [
      "key settings",
      "required settings",
      "ports",
      "port",
      "single port",
      "texthooker port",
      "anki connect",
      "obs password",
      "obs host",
      "manual overlay scan hotkey",
      "play latest clip hotkey",
      "required"
    ],
    shortDescription: "Main setup, connection ports, and the most important first-run settings.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "key_settings"
    },
    notes: "Saved per GSM profile."
  },
  {
    id: "gsm-general",
    label: "General",
    owner: "python",
    keywords: [
      "general",
      "full auto",
      "open anki edit",
      "open anki browser",
      "browser query",
      "longplay",
      "websocket sources",
      "paths",
      "folders",
      "folder to watch",
      "output folder",
      "directory",
      "copy temp files",
      "copy trimmed replay",
      "remove video",
      "open output folder",
      "discord",
      "rich presence",
      "rpc",
      "discord status",
      "blacklist scenes",
      "inactivity timer",
      "text filtering",
      "text processing",
      "cleanup",
      "replace text",
      "string replacement",
      "ignore text",
      "normalize text",
      "filter lines",
      "ocr cleanup",
      "text filter"
    ],
    shortDescription: "General behavior, folders, Discord status, and text cleanup settings.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "general",
      subtabKey: "general"
    },
    notes: "Saved per GSM profile."
  },
  {
    id: "gsm-anki",
    label: "Anki",
    owner: "python",
    keywords: [
      "anki",
      "deck",
      "note type",
      "field mapping",
      "sentence field",
      "sentence audio field",
      "picture field",
      "image field",
      "video field",
      "furigana field",
      "game name field",
      "ankiconnect",
      "anki confirmation",
      "confirmation popup",
      "confirm before add",
      "auto accept",
      "always on top",
      "focus on show",
      "autoplay audio",
      "replay audio",
      "anki tags",
      "tags",
      "tag",
      "parent tag",
      "custom tags",
      "tags to check",
      "game tag",
      "unvoiced cards"
    ],
    shortDescription: "Decks, fields, confirmation pop-up behavior, and tags for Anki cards.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "anki",
      subtabKey: "general"
    },
    notes: "Saved per GSM profile."
  },
  {
    id: "gsm-screenshot",
    label: "Screenshot",
    owner: "python",
    keywords: [
      "screenshot",
      "screenshots",
      "capture image",
      "animated screenshot",
      "fps",
      "width",
      "height",
      "resolution",
      "quality",
      "extension",
      "gif",
      "webp",
      "png",
      "jpg",
      "black bars",
      "ffmpeg",
      "seconds after line",
      "timing"
    ],
    shortDescription: "Adjust screenshot size, format, timing, and animated capture options.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "screenshot"
    },
    notes: "Saved per GSM profile."
  },
  {
    id: "gsm-audio",
    label: "Audio",
    owner: "python",
    keywords: [
      "audio",
      "voice detection",
      "vad",
      "whisper",
      "silero",
      "tts",
      "tts url",
      "audio clip",
      "trim audio",
      "ffmpeg",
      "reencode",
      "audio extension",
      "mp3",
      "opus",
      "ogg",
      "aac",
      "m4a",
      "anki media collection",
      "external tool",
      "ocenaudio",
      "beginning offset",
      "end offset",
      "splice padding",
      "backup vad model",
      "add audio on no results",
      "pre vad offset"
    ],
    shortDescription: "Audio clips, trimming, export, voice detection, and speech model settings.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "audio",
      subtabKey: "audio"
    },
    notes: "Saved per GSM profile."
  },
  {
    id: "gsm-obs",
    label: "OBS",
    owner: "python",
    keywords: [
      "obs",
      "scene",
      "recording",
      "open obs",
      "close obs",
      "disable recording",
      "recording fps"
    ],
    shortDescription: "OBS scenes, recording, and related capture behavior.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "obs"
    },
    notes: "Saved per GSM profile."
  },
  {
    id: "gsm-ai",
    label: "AI and Translation",
    owner: "python",
    keywords: [
      "ai",
      "translation ai",
      "gemini",
      "groq",
      "openai",
      "ollama",
      "lm studio",
      "provider",
      "api key",
      "model",
      "backup model",
      "temperature",
      "max output tokens",
      "top p",
      "context length",
      "anki field",
      "gsm cloud",
      "cloud sync",
      "authenticate",
      "cloud login",
      "sync local db",
      "client id",
      "cloud api",
      "prompts",
      "prompt",
      "custom prompt",
      "translation prompt",
      "context prompt",
      "texthooker prompt",
      "full prompt",
      "canned prompt"
    ],
    shortDescription: "AI providers, prompts, translation settings, and GSM Cloud.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "ai",
      subtabKey: "general"
    },
    notes: "Saved per GSM profile."
  },
  {
    id: "gsm-overlay",
    label: "Overlay OCR",
    owner: "python",
    keywords: [
      "overlay",
      "overlay ocr",
      "ocr area",
      "monitor",
      "capture area",
      "overlay engine",
      "minimum character size",
      "periodic scan",
      "periodic interval",
      "periodic ratio",
      "use ocr result",
      "select area",
      "full screen ocr"
    ],
    shortDescription: "Choose monitor, OCR area, and backend overlay capture behavior.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "overlay"
    },
    notes: "Saved per GSM profile."
  },
  {
    id: "gsm-advanced-network",
    label: "Advanced",
    owner: "python",
    keywords: [
      "advanced",
      "network",
      "audio player",
      "video player",
      "ocr websocket port",
      "texthooker websocket port",
      "plaintext websocket port",
      "localhost bind address",
      "polling rate",
      "multiline line break",
      "sleep time",
      "process pausing",
      "pause game",
      "allowlist",
      "denylist",
      "overlay pause",
      "texthooker pause",
      "gamepad navigation pause"
    ],
    shortDescription: "Advanced networking, player paths, ports, and experimental process pausing.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "advanced",
      subtabKey: "advanced"
    },
    notes: "Most users will not need this often."
  },
  {
    id: "gsm-profiles",
    label: "Profiles",
    owner: "python",
    keywords: [
      "profiles",
      "profile",
      "copy profile",
      "delete profile",
      "default profile",
      "per game profile",
      "scene assignments"
    ],
    shortDescription: "Create, copy, delete, and switch between GSM profiles.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "profiles"
    },
    notes: "Profiles save different setups for different games."
  },
  {
    id: "overlay-display-hotkeys",
    label: "Overlay display and hotkeys",
    owner: "overlay",
    keywords: [
      "overlay",
      "hotkey",
      "hotkeys",
      "display",
      "window",
      "show overlay",
      "hide overlay",
      "toggle window",
      "minimize",
      "overlay settings hotkey",
      "ready indicator",
      "text indicators",
      "recycled line indicator",
      "offset",
      "offset x",
      "offset y",
      "text position",
      "calibrate",
      "reset offset",
      "show main box on startup",
      "startup",
      "auto minimize",
      "afk timer",
      "manual mode",
      "only show on hotkey",
      "manual mode type",
      "show overlay",
      "hide overlay",
      "window visibility",
      "furigana",
      "hide furigana on startup",
      "toggle furigana hotkey",
      "yomitan settings"
    ],
    shortDescription: "Overlay visibility, furigana display, indicators, offsets, and hotkeys.",
    openAction: OPEN_OVERLAY_SETTINGS,
    notes: "Saved in the overlay window itself."
  },
  {
    id: "overlay-translation-reader",
    label: "Overlay translation and reader tools",
    owner: "overlay",
    keywords: [
      "translation",
      "translate",
      "translate hotkey",
      "auto request translation",
      "reader",
      "reading tools",
      "jiten",
      "jiten reader",
      "reader popup",
      "dictionary",
      "yomitan",
      "yomitan settings",
      "texthooker",
      "text hooker",
      "textractor",
      "plaintext websocket",
      "gsm websocket",
      "texthooker url",
      "texthooker hotkey"
    ],
    shortDescription: "Translation requests, reader tools, Yomitan, and text hooker options.",
    openAction: OPEN_OVERLAY_SETTINGS,
    notes: "Saved in the overlay window itself."
  },
  {
    id: "overlay-gamepad",
    label: "Overlay gamepad navigation",
    owner: "overlay",
    keywords: [
      "gamepad",
      "controller",
      "navigation",
      "hotkey",
      "keyboard toggle",
      "keyboard hotkey",
      "activation mode",
      "modifier button",
      "toggle button",
      "confirm button",
      "cancel button",
      "forward enter",
      "manual overlay scan button",
      "tokenizer",
      "token mode",
      "mecab",
      "yomitan bridge",
      "yomitan api",
      "jiten api",
      "jpdb api",
      "api key",
      "scan length",
      "dictionary backend",
      "lookup backend",
      "repeat delay",
      "repeat rate",
      "controller enabled",
      "keyboard enabled",
      "auto confirm",
      "gamepad server port",
      "gamepad status",
      "controller status",
      "input test",
      "start test",
      "clear input log",
      "server status",
      "connected controller",
      "platform override",
      "windows mode",
      "linux mode",
      "mac mode",
      "reload settings window",
      "operating system"
    ],
    shortDescription: "Controller navigation, tokenizer backends, keyboard toggle, and input testing.",
    openAction: OPEN_OVERLAY_SETTINGS,
    notes: "Saved in the overlay window itself."
  }
];

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenizeSearchText(value: string): string[] {
  return normalizeSearchText(value)
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function getEntrySearchParts(entry: SettingsCatalogEntry): string[] {
  return [
    entry.label,
    SETTINGS_LOCATION_LABELS[entry.owner],
    entry.shortDescription,
    entry.notes ?? "",
    ...entry.keywords
  ];
}

function hasExactSettingsCatalogMatch(
  entry: SettingsCatalogEntry,
  normalizedQuery: string
): boolean {
  const exactTerms = [entry.label, ...entry.keywords].map(normalizeSearchText);
  return exactTerms.includes(normalizedQuery);
}

function scoreSettingsCatalogEntry(
  entry: SettingsCatalogEntry,
  normalizedQuery: string,
  queryTokens: string[]
): number {
  const normalizedLabel = normalizeSearchText(entry.label);
  const normalizedParts = getEntrySearchParts(entry).map(normalizeSearchText);
  const combinedText = normalizedParts.join(" ");

  let score = 0;

  if (normalizedLabel === normalizedQuery) {
    score += 400;
  }
  if (normalizedLabel.startsWith(normalizedQuery)) {
    score += 180;
  }
  if (combinedText.includes(normalizedQuery)) {
    score += 120;
  }

  for (const token of queryTokens) {
    if (normalizedLabel.includes(token)) {
      score += 40;
    }
    if (entry.keywords.some((keyword) => normalizeSearchText(keyword).includes(token))) {
      score += 24;
    }
    if (combinedText.includes(token)) {
      score += 10;
    }
  }

  return score;
}

export function normalizeSettingsCatalogQuery(query: string): string {
  return normalizeSearchText(query);
}

export function filterSettingsCatalogEntries(
  entries: SettingsCatalogEntry[],
  query: string
): SettingsCatalogEntry[] {
  const normalizedQuery = normalizeSettingsCatalogQuery(query);
  const queryTokens = tokenizeSearchText(query);

  if (normalizedQuery.length === 0 || queryTokens.length === 0) {
    return entries;
  }

  if (queryTokens.length === 1) {
    const exactMatches = entries.filter((entry) =>
      hasExactSettingsCatalogMatch(entry, normalizedQuery)
    );

    if (exactMatches.length > 0) {
      return exactMatches.sort((left, right) =>
        left.label.localeCompare(right.label)
      );
    }
  }

  return entries
    .filter((entry) => {
      const searchParts = getEntrySearchParts(entry).map(normalizeSearchText);
      return queryTokens.every((token) =>
        searchParts.some((part) => part.includes(token))
      );
    })
    .sort((left, right) => {
      const scoreDelta =
        scoreSettingsCatalogEntry(right, normalizedQuery, queryTokens) -
        scoreSettingsCatalogEntry(left, normalizedQuery, queryTokens);

      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return left.label.localeCompare(right.label);
    });
}

export async function performSettingsCatalogAction(
  action: SettingsCatalogAction,
  invoke: typeof invokeIpc = invokeIpc
): Promise<unknown> {
  switch (action.type) {
    case "current-tab":
      return;
    case "open-gsm-settings":
      return await invoke("settings.openGSMSettings", {
        rootTabKey: action.rootTabKey,
        subtabKey: action.subtabKey
      });
    case "open-overlay-settings":
      return await invoke("settings.openOverlaySettings");
    default: {
      const neverAction: never = action.type;
      throw new Error(`Unsupported settings action: ${neverAction}`);
    }
  }
}
