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

export const SETTINGS_CATALOG_I18N_KEYS: Record<string, string> = {
  "desktop-appearance-startup": "desktopAppearance",
  "desktop-tabs-and-stats": "desktopTabs",
  "desktop-transparency": "desktopTransparency",
  "desktop-updates": "desktopUpdates",
  "desktop-backups": "desktopBackups",
  "desktop-data-folder": "desktopDataFolder",
  "gsm-key-settings": "keySettings",
  "gsm-general": "general",
  "gsm-paths": "paths",
  "gsm-discord": "discord",
  "gsm-text-processing": "textProcessing",
  "gsm-anki": "anki",
  "gsm-anki-confirmation": "ankiConfirmation",
  "gsm-anki-field-grouping": "ankiFieldGrouping",
  "gsm-anki-tags": "ankiTags",
  "gsm-screenshot": "screenshot",
  "gsm-audio": "audio",
  "gsm-voice-detection": "voiceDetection",
  "gsm-hotkeys": "hotkeys",
  "gsm-obs": "obs",
  "gsm-ai": "ai",
  "gsm-ai-prompts": "aiPrompts",
  "gsm-cloud": "gsmCloud",
  "gsm-overlay-capture": "gsmOverlayCapture",
  "gsm-advanced-network": "advanced",
  "gsm-experimental": "features",
  "gsm-profiles": "profiles",
  "overlay-reading-stats": "overlayReadingStats",
  "overlay-furigana-tokenization": "overlayFuriganaTokenization",
  "overlay-display-hotkeys": "overlayDisplay",
  "overlay-translation-reader": "overlayTranslation",
  "overlay-ocr": "overlayOcr",
  "overlay-gamepad": "overlayGamepad",
  "overlay-profiles-system": "overlayProfilesSystem"
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
      "theme",
      "light theme",
      "dark theme",
      "system theme",
      "language",
      "display language",
      "locale",
      "startup",
      "start minimized",
      "start console minimized",
      "run overlay on startup",
      "open overlay on startup",
      "launch overlay automatically",
      "text capture wizard",
      "capture wizard",
      "setup wizard",
      "quit on window close",
      "close to tray",
      "dont ask again",
      "don't ask again",
      "show yuzu launcher",
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
      "windows speech",
      "speech recognition tab",
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
    id: "desktop-transparency",
    label: "Window transparency tool",
    owner: "electron",
    keywords: [
      "transparency",
      "transparent window",
      "window opacity",
      "opacity",
      "transparency hotkey",
      "window target",
      "run transparency on startup",
      "ctrl alt y",
      "click through"
    ],
    shortDescription: "Configure and run the Windows window-transparency helper.",
    openAction: OPEN_CURRENT_TAB,
    notes: "Available on Windows."
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
    id: "desktop-backups",
    label: "Settings and database backups",
    owner: "electron",
    keywords: [
      "backup",
      "backups",
      "create backup",
      "restore backup",
      "automatic database backup",
      "database backup",
      "backup retention",
      "retention count",
      "backup directory",
      "backup folder",
      "python settings backup",
      "desktop settings backup",
      "overlay settings backup",
      "obs scenes backup",
      "ocr configs backup",
      "text hook settings backup",
      "window layouts backup",
      "yomitan data backup",
      "plugins backup",
      "agent scripts backup",
      "user scripts backup"
    ],
    shortDescription: "Create selective backups, restore them, and configure automatic database copies.",
    openAction: OPEN_CURRENT_TAB
  },
  {
    id: "desktop-data-folder",
    label: "Data folder location",
    owner: "electron",
    keywords: [
      "data folder",
      "data directory",
      "move data",
      "move appdata folder",
      "relocate data",
      "change data folder",
      "custom data directory",
      "appdata",
      "roaming",
      "restore original appdata",
      "use original appdata folder",
      "database location",
      "settings location"
    ],
    shortDescription: "Move GSM data to another drive or return it to the original AppData folder.",
    openAction: OPEN_CURRENT_TAB,
    notes: "Changing the data folder restarts the app."
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
      "websocket",
      "input websocket",
      "clipboard",
      "clipboard monitor",
      "clipboard websocket",
      "allow both simultaneously",
      "merge sequential text",
      "text feed startup",
      "open config on startup",
      "unified port",
      "display language",
      "native language",
      "open anki edit",
      "open anki browser",
      "browser query",
      "websocket sources"
    ],
    shortDescription: "Input sources, startup behavior, languages, ports, and general automation.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "general",
      subtabKey: "general"
    },
    notes: "Saved per GSM profile."
  },
  {
    id: "gsm-paths",
    label: "Paths and exported media",
    owner: "python",
    keywords: [
      "paths",
      "folders",
      "folder to watch",
      "obs replay path",
      "output folder",
      "output mirror folder",
      "directory",
      "copy temp files",
      "copy trimmed replay",
      "remove replay",
      "remove video",
      "remove audio from folder",
      "remove screenshot from folder",
      "open output folder",
      "exported files",
      "media destination"
    ],
    shortDescription: "Choose replay and output folders and control exported-media cleanup.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "general",
      subtabKey: "paths"
    },
    notes: "Saved per GSM profile."
  },
  {
    id: "gsm-discord",
    label: "Discord Rich Presence",
    owner: "python",
    keywords: [
      "discord",
      "rich presence",
      "discord rpc",
      "rpc",
      "discord status",
      "blacklist scenes",
      "scene blacklist",
      "inactivity timer",
      "activity status",
      "playing game status"
    ],
    shortDescription: "Publish the current game to Discord and configure privacy and inactivity rules.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "general",
      subtabKey: "discord"
    },
    notes: "Saved in the main GSM settings."
  },
  {
    id: "gsm-text-processing",
    label: "Text filtering and replacement",
    owner: "python",
    keywords: [
      "text filtering",
      "text processing",
      "cleanup",
      "replace text",
      "string replacement",
      "replacement rules",
      "replacement regex",
      "texthook replacement regex",
      "regular expression",
      "regex",
      "ignore text",
      "normalize text",
      "filter lines",
      "ocr cleanup",
      "text filter",
      "junk characters"
    ],
    shortDescription: "Clean incoming text with filters, regular expressions, and replacement rules.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "general",
      subtabKey: "text_processing"
    },
    notes: "Applied before text is logged or sent to the overlay."
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
      "anki url",
      "update anki",
      "overwrite audio",
      "overwrite picture",
      "overwrite sentence",
      "multi line mining",
      "unvoiced cards"
    ],
    shortDescription: "Configure AnkiConnect, note fields, updates, and media overwrite behavior.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "anki",
      subtabKey: "general"
    },
    notes: "Saved per GSM profile."
  },
  {
    id: "gsm-anki-confirmation",
    label: "Anki confirmation dialog",
    owner: "python",
    keywords: [
      "anki confirmation",
      "confirmation popup",
      "confirmation dialog",
      "confirm before add",
      "show update confirmation dialog",
      "auto accept",
      "auto accept timer",
      "always on top",
      "focus on show",
      "autoplay audio",
      "replay audio",
      "confirmation gamepad",
      "gamepad controls",
      "d pad",
      "vad recommended result",
      "voice no voice",
      "manual audio trim",
      "audio confirmation"
    ],
    shortDescription: "Control the card-confirmation window, auto-accept timer, audio choices, and gamepad input.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "anki",
      subtabKey: "confirmation"
    },
    notes: "Saved per GSM profile."
  },
  {
    id: "gsm-anki-field-grouping",
    label: "Anki field grouping",
    owner: "python",
    keywords: [
      "field grouping",
      "duplicate field grouping",
      "duplicate word",
      "merge duplicate notes",
      "merge context",
      "grouped fields",
      "additional grouped fields",
      "overwrite instead of merge",
      "merge automatically",
      "new context order",
      "delete duplicate",
      "kiku",
      "data group id"
    ],
    shortDescription: "Merge new mining context into duplicate Anki notes and choose grouped fields.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "anki",
      subtabKey: "field_grouping"
    },
    notes: "Used when exact duplicate words are found in the same note type."
  },
  {
    id: "gsm-anki-tags",
    label: "Anki tags",
    owner: "python",
    keywords: [
      "anki tags",
      "tags",
      "tag",
      "parent tag",
      "custom tags",
      "tags to check",
      "tags to work on",
      "game tag",
      "add game as tag",
      "unvoiced tag",
      "tag unvoiced cards"
    ],
    shortDescription: "Add custom, game, parent, and unvoiced tags to mined cards.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "anki",
      subtabKey: "tags"
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
      "timing",
      "capture backend",
      "windows graphics capture",
      "wgc",
      "wgc capture fps",
      "screenshot selector",
      "take screenshot hotkey",
      "screenshot hotkey updates anki"
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
      "external audio editor",
      "audio beginning offset",
      "audio end offset"
    ],
    shortDescription: "Configure audio extraction, format, re-encoding, paths, and external editing.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "audio",
      subtabKey: "audio"
    },
    notes: "Saved per GSM profile."
  },
  {
    id: "gsm-voice-detection",
    label: "Voice detection (VAD)",
    owner: "python",
    keywords: [
      "voice detection",
      "voice activity detection",
      "vad",
      "whisper vad",
      "whisper",
      "silero",
      "vad model",
      "backup vad model",
      "speech model",
      "vad language",
      "postprocessing",
      "voice detection postprocessing",
      "add audio on no results",
      "clean vad pre roll",
      "adaptive preroll",
      "trim beginning",
      "beginning offset",
      "condense audio",
      "cut and splice",
      "splice padding",
      "force cpu",
      "preload vad model",
      "tts fallback",
      "text to speech fallback",
      "tts url"
    ],
    shortDescription: "Choose speech-detection models and tune trimming, pre-roll, fallback, and inference behavior.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "audio",
      subtabKey: "vad"
    },
    notes: "Saved per GSM profile."
  },
  {
    id: "gsm-hotkeys",
    label: "Main GSM hotkeys",
    owner: "python",
    keywords: [
      "hotkeys",
      "keyboard shortcuts",
      "keybinds",
      "pause text intake",
      "pause gsm text intake hotkey",
      "mute target window",
      "mute unmute target window hotkey",
      "manual overlay scan hotkey",
      "play latest clip hotkey",
      "play latest video audio hotkey",
      "reset line hotkey",
      "take screenshot hotkey"
    ],
    shortDescription: "Assign global shortcuts for text intake, captured-window audio, playback, scans, and screenshots.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "hotkeys"
    },
    notes: "These are desktop-wide GSM shortcuts, separate from overlay bindings."
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
      "deepl",
      "deepl api key",
      "target language",
      "local model"
    ],
    shortDescription: "Configure cloud and local AI providers, models, API keys, and translation output.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "ai",
      subtabKey: "general"
    },
    notes: "Saved per GSM profile."
  },
  {
    id: "gsm-ai-prompts",
    label: "AI translation prompts",
    owner: "python",
    keywords: [
      "ai prompts",
      "translation prompts",
      "prompts",
      "prompt",
      "custom prompt",
      "translation prompt",
      "context prompt",
      "texthooker prompt",
      "text hook prompt",
      "full prompt",
      "canned prompt",
      "canned translation prompt",
      "canned context prompt",
      "dialogue context",
      "prompt template"
    ],
    shortDescription: "Edit canned and custom instructions used for translation and dialogue context.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "ai",
      subtabKey: "prompts"
    },
    notes: "Saved per GSM profile."
  },
  {
    id: "gsm-cloud",
    label: "GSM Cloud",
    owner: "python",
    keywords: [
      "gsm cloud",
      "cloud sync",
      "authenticate",
      "authentication",
      "cloud login",
      "sync local database",
      "sync local db",
      "client id",
      "cloud api",
      "cloud models",
      "shared models"
    ],
    shortDescription: "Authenticate with GSM Cloud and choose cloud synchronization options.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "gsm_cloud"
    },
    notes: "This tab can be hidden when GSM Cloud preview features are unavailable."
  },
  {
    id: "gsm-overlay-capture",
    label: "Main GSM overlay capture",
    owner: "python",
    keywords: [
      "overlay capture",
      "overlay websocket port",
      "monitor to capture",
      "overlay monitor",
      "overlay engine",
      "periodic capture",
      "periodic scan",
      "capture interval",
      "scan on mouse move",
      "add scanned lines to log",
      "periodic match ratio",
      "local scans per text event",
      "overlay area selector",
      "ocr area config",
      "primary text areas",
      "secondary menu text areas",
      "exclusion zones",
      "use ocr result only",
      "supplement ocr result",
      "freeze game frame",
      "exclusive fullscreen",
      "recycled line indicator"
    ],
    shortDescription: "Configure the Python-side overlay scan pipeline, capture regions, and OCR result merging.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "overlay"
    },
    notes: "Related live controls also appear in Overlay Settings."
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
      "multi line sentence storage field",
      "sleep time",
      "reset line hotkey"
    ],
    shortDescription: "Advanced networking, player paths, capture, and polling settings.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "advanced"
    },
    notes: "Most users will not need this often."
  },
  {
    id: "gsm-experimental",
    label: "Features",
    owner: "python",
    keywords: [
      "features",
      "optional features",
      "quality of life",
      "notify on anki update",
      "anki update notification",
      "longplay",
      "longplay recording",
      "generate longplay",
      "srt subtitles",
      "mute game on minimize",
      "mute minimized game",
      "experimental",
      "tokenization",
      "tokenizer",
      "sudachi",
      "mecab",
      "dictionary",
      "word frequency",
      "kanji frequency",
      "backfill throttle",
      "weak systems",
      "game pausing",
      "process pausing",
      "pause game",
      "suspend process",
      "game pause hotkey",
      "game pausing denylist",
      "denylist",
      "exe denylist",
      "require game exe match",
      "auto resume",
      "overlay pause",
      "manual hotkey requests pause",
      "texthooker pause",
      "text feed pause",
      "gamepad navigation pause"
    ],
    shortDescription: "Configure optional conveniences, tokenization, Longplay recording, and game pausing.",
    openAction: {
      ...OPEN_GSM_SETTINGS,
      rootTabKey: "features"
    },
    notes: "Game muting is Windows-only; tokenization and process pausing are experimental."
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
    id: "overlay-reading-stats",
    label: "Overlay reading stats and Pomodoro",
    owner: "overlay",
    keywords: [
      "live stats",
      "reading stats",
      "overlay stats",
      "show goals",
      "pomodoro goals",
      "pomodoro",
      "work minutes",
      "break minutes",
      "auto start reading session",
      "characters per hour",
      "total characters",
      "active reading time",
      "raw reading time",
      "cards mined",
      "stats display mode",
      "stats layout",
      "hide after seconds",
      "stats position",
      "ready indicator",
      "text indicators",
      "red boxes",
      "red border",
      "fade indicators",
      "recycled line indicator"
    ],
    shortDescription: "Choose overlay session metrics, goals, indicators, layout, and Pomodoro timing.",
    openAction: OPEN_OVERLAY_SETTINGS,
    notes: "Found under Reading, Stats & Jiten in Overlay Settings."
  },
  {
    id: "overlay-furigana-tokenization",
    label: "Furigana, pinyin, and tokenization",
    owner: "overlay",
    keywords: [
      "furigana",
      "readings",
      "show furigana",
      "hide furigana on startup",
      "auto hide furigana",
      "furigana color",
      "furigana outline",
      "furigana font weight",
      "furigana font size",
      "pinyin",
      "pinyin tone colors",
      "mandarin readings",
      "furigana tokenizer",
      "tokenization",
      "tokenizer",
      "tokenize",
      "morphological analysis",
      "word segmentation",
      "mecab",
      "sudachi",
      "sudachi dictionary",
      "sudachi core",
      "sudachi small",
      "sudachi full",
      "yomitan bridge",
      "yomitan api",
      "yomitan scan length",
      "jiten api",
      "jiten api key",
      "jpdb api",
      "jpdb api key",
      "token furigana backend",
      "dictionary backend"
    ],
    shortDescription: "Style readings and choose the MeCab, Sudachi, Yomitan, Jiten, or JPDB tokenizer backend.",
    openAction: OPEN_OVERLAY_SETTINGS,
    notes: "Found under Reading, Stats & Jiten in Overlay Settings."
  },
  {
    id: "overlay-display-hotkeys",
    label: "Overlay display, interaction, and hotkeys",
    owner: "overlay",
    keywords: [
      "overlay",
      "hotkey",
      "hotkeys",
      "display",
      "window",
      "show overlay",
      "hide overlay",
      "push to show",
      "manual mode",
      "only show on hotkey",
      "push to show type",
      "freeze game frame",
      "exclusive fullscreen",
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
      "window visibility",
      "floating window font size",
      "focus overlay on yomitan lookup",
      "text offset",
      "horizontal offset",
      "vertical offset",
      "calibrate offset"
    ],
    shortDescription: "Control Push to Show, visibility, startup behavior, window focus, offsets, and shortcuts.",
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
      "enable jiten reader",
      "jiten server url",
      "reader popup",
      "overlay integration",
      "automatically open reader",
      "insert mined terms",
      "dictionary",
      "yomitan",
      "yomitan settings",
      "texthooker",
      "text hooker",
      "textractor",
      "textfeed",
      "text feed",
      "text feed history",
      "open text feed",
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
    id: "overlay-ocr",
    label: "Overlay OCR and capture",
    owner: "overlay",
    keywords: [
      "ocr",
      "overlay ocr",
      "capture",
      "ocr engine",
      "oneocr",
      "google lens",
      "meikiocr",
      "screenai",
      "text appears instantly",
      "image scaling",
      "base scale",
      "monitor",
      "monitor to capture",
      "capture monitor",
      "ocr area",
      "capture area",
      "select ocr area",
      "minimum character size",
      "periodic scan",
      "periodic scanning",
      "periodic interval",
      "scan on mouse move",
      "use overlay area config",
      "use ocr result",
      "supplement ocr result with overlay",
      "inject scanned lines",
      "add scanned lines to log",
      "text filtering",
      "ocr text filtering",
      "full screen ocr",
      "ocr full screen instead of obs",
      "wgc capture fps",
      "capture fps"
    ],
    shortDescription: "Choose an OCR engine, monitor, region, scaling, scan schedule, and result pipeline.",
    openAction: OPEN_OVERLAY_SETTINGS,
    notes: "Found under Capture / OCR in Overlay Settings."
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
      "tokenization",
      "token mode",
      "token mode toggle",
      "token navigation mode",
      "sudachi",
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
      "detected devices",
      "ignored devices",
      "device blacklist",
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
  },
  {
    id: "overlay-profiles-system",
    label: "Overlay profiles and system",
    owner: "overlay",
    keywords: [
      "overlay profiles",
      "profile specific overlay",
      "profile specific overlay settings",
      "enable overlay profiles",
      "active overlay profile",
      "gsm profile",
      "per game overlay settings",
      "scene assignments",
      "main profile settings",
      "open profiles",
      "developer",
      "mimic platform",
      "platform override",
      "windows mode",
      "linux mode",
      "macos mode",
      "operating system",
      "reload settings window"
    ],
    shortDescription: "Use per-profile overlay settings and inspect or override platform-specific behavior.",
    openAction: OPEN_OVERLAY_SETTINGS,
    notes: "Found under System in Overlay Settings."
  }
];

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
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
