import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { DOCS_URLS } from "../../../../shared/docs";
import { invokeIpc, onIpc, platformFromEnv, sendIpc } from "../../lib/ipc";
import type { ObsScene } from "../../types/models";

type OcrPlatform = "win32" | "darwin" | "linux" | string;
type ProcessPriority =
  | "low"
  | "below_normal"
  | "normal"
  | "above_normal"
  | "high";

type ComparisonFieldKey =
  | "duplicate_similarity_threshold"
  | "change_detection_threshold"
  | "evolving_prefix_similarity_threshold"
  | "truncation_compare_threshold_min"
  | "truncation_strict_threshold_min"
  | "truncation_similarity_margin"
  | "truncation_min_length"
  | "truncation_min_ratio_percent"
  | "subset_chunk_min_length"
  | "matching_block_short_chunk_char_limit"
  | "matching_block_small_chunk_min_size"
  | "matching_block_default_min_size"
  | "subset_coverage_floor_percent"
  | "subset_coverage_ceiling_percent"
  | "subset_coverage_threshold_offset"
  | "subset_longest_block_min_chars"
  | "subset_longest_block_divisor";

interface OcrStoredConfig {
  ocr1?: string;
  ocr2?: string;
  ocr1_advanced?: string;
  ocr2_advanced?: string;
  twoPassOCR?: boolean;
  optimize_second_scan?: boolean;
  scanRate?: number;
  scanRate_basic?: number;
  scanRate_advanced?: number;
  language?: string;
  ocr_screenshots?: boolean;
  furigana_filter_sensitivity?: number;
  defaultSceneFuriganaFilterSensitivity?: number;
  manualOcrHotkey?: string;
  areaSelectOcrHotkey?: string;
  wholeWindowOcrHotkey?: string;
  globalPauseHotkey?: string;
  sendToClipboard?: boolean;
  keep_newline?: boolean;
  keep_newline_auto?: boolean;
  keep_newline_menu?: boolean;
  keep_newline_area_select?: boolean;
  obs_capture_preprocess?: string;
  ignore_ocr_run_1_text?: boolean;
  processPriority?: string;
  base_scale?: number;
  advancedMode?: boolean;
  [key: string]: unknown;
}

interface OcrUiConfig {
  advancedMode: boolean;
  basicScanRate: number;
  advancedScanRate: number;
  mainOcr: string;
  stabilityOcr: string;
  twoPassOCR: boolean;
  optimizeSecondScan: boolean;
  language: string;
  ocrScreenshots: boolean;
  furiganaFilterSensitivity: number;
  defaultSceneFuriganaFilterSensitivity: number;
  manualOcrHotkey: string;
  areaSelectOcrHotkey: string;
  wholeWindowOcrHotkey: string;
  globalPauseHotkey: string;
  sendToClipboard: boolean;
  keepNewlineAuto: boolean;
  keepNewlineMenu: boolean;
  keepNewlineAreaSelect: boolean;
  obsCapturePreprocess: string;
  ignoreOcrRun1Text: boolean;
  processPriority: ProcessPriority;
  baseScale: number;
  comparison: Record<ComparisonFieldKey, number>;
}

interface OcrSceneAreaConfig {
  scene?: string;
  window?: string;
  coordinate_system?: string;
  rectangles?: unknown[];
}

interface OcrSceneSettings {
  furigana_filter_sensitivity?: number;
}

interface OcrRunningState {
  isRunning: boolean;
  source?: string;
  mode?: "auto" | "manual" | null;
}

interface OcrStatusPayload {
  paused?: boolean;
  manual?: boolean;
  current_engine?: string;
  scan_rate?: number;
}

interface NoticeState {
  type: "info" | "success" | "error";
  message: string;
}

interface OcrTabProps {
  active: boolean;
}

interface Option {
  value: string;
  label: string;
}

interface ComparisonFieldDefinition {
  key: ComparisonFieldKey;
  label: string;
  title: string;
  min: number;
  max: number;
  step: number;
}

const MAIN_OCR_OPTIONS: Option[] = [
  { value: "glens", label: "Google Lens" },
  { value: "bing", label: "Bing" },
  { value: "oneocr", label: "OneOCR" },
  { value: "screenai", label: "ScreenAI OCR" },
  { value: "meikiocr", label: "Meiki OCR" },
  { value: "gemini", label: "Gemini" },
  { value: "gvision", label: "Google Vision" },
  { value: "azure", label: "Azure Image Analysis" },
  { value: "ocrspace", label: "OCRSpace" },
  { value: "local_llm_ocr", label: "Local LLM OCR" },
  { value: "alivetext", label: "Apple Live Text" },
  { value: "mlkitocr", label: "MLKit OCR" }
];

const STABILITY_OCR_OPTIONS: Option[] = [
  { value: "oneocr", label: "OneOCR" },
  { value: "screenai", label: "ScreenAI OCR" },
  { value: "meiki_text_detector", label: "Meiki Text Detector" },
  { value: "meikiocr", label: "Meiki OCR" },
  { value: "alivetext", label: "Apple Live Text" },
  { value: "local_llm_ocr", label: "Local LLM OCR" },
  { value: "mlkitocr", label: "MLKit OCR" }
];

const LANGUAGE_OPTIONS: Option[] = [
  { value: "ja", label: "Japanese" },
  { value: "zh", label: "Chinese" },
  { value: "ko", label: "Korean" },
  { value: "en", label: "English (Latin script)" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "ru", label: "Russian" },
  { value: "ar", label: "Arabic" },
  { value: "hi", label: "Hindi" }
];

const BASIC_SCAN_RATE_OPTIONS: Option[] = [
  { value: "0.2", label: "Instant" },
  { value: "0.5", label: "Normal" },
  { value: "0.8", label: "Slow" },
  { value: "1", label: "Very Slow" }
];

const PROCESS_PRIORITY_OPTIONS: Array<{ value: ProcessPriority; label: string }> =
  [
    { value: "low", label: "Low" },
    { value: "below_normal", label: "Below Normal" },
    { value: "normal", label: "Normal" },
    { value: "above_normal", label: "Above Normal" },
    { value: "high", label: "High" }
  ];

const PREPROCESS_OPTIONS: Option[] = [
  { value: "none", label: "Off" },
  { value: "grayscale", label: "Grayscale" },
  { value: "grayscale_unsharp", label: "Grayscale + Autocontrast + Unsharp" }
];

const DEPENDENCY_INSTALL_OPTIONS: Option[] = [
  {
    value: "pip install fpng-py",
    label: "Faster PNG (Recommended on Windows 11)"
  },
  { value: "pip install owocr[gvision]", label: "Google Vision" },
  { value: "pip install owocr[azure]", label: "Azure" },
  { value: "pip install owocr[ocrspace]", label: "OCRSpace" }
];

const DEPENDENCY_REMOVE_OPTIONS: Option[] = [
  { value: "owocr", label: "OWOCR Base" },
  { value: "protobuf", label: "Google Lens" },
  { value: "oneocr", label: "OneOCR" },
  { value: "fpng-py", label: "Faster PNG" },
  { value: "transformers sentencepiece", label: "Accurate Filtering" },
  { value: "google-cloud-vision", label: "Google Vision" },
  { value: "azure-ai-vision-imageanalysis", label: "Azure" },
  { value: "ocrspace", label: "OCRSpace" }
];

const COMPARISON_FIELDS: ComparisonFieldDefinition[] = [
  {
    key: "duplicate_similarity_threshold",
    label: "Duplicate Match Threshold (%)",
    title:
      "Higher values are stricter. Raise this if different lines are being treated as duplicates.",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "change_detection_threshold",
    label: "Text Change Threshold (%)",
    title:
      "Lower values trigger OCR2 sooner on partial changes. Higher values wait for clearer changes.",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "evolving_prefix_similarity_threshold",
    label: "Evolving Prefix Match (%)",
    title:
      "Used when checking whether a short line looks like the beginning of a longer line.",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "truncation_compare_threshold_min",
    label: "Truncation Fallback Min Threshold (%)",
    title:
      "Minimum compare threshold required before prefix or suffix truncation matching is allowed.",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "truncation_strict_threshold_min",
    label: "Truncation Strict Threshold (%)",
    title:
      "Above this threshold, GSM also requires a stronger base similarity before treating a truncation as the same text.",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "truncation_similarity_margin",
    label: "Truncation Base Margin",
    title:
      "How far below the compare threshold the base similarity may be before truncation fallback is rejected.",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "truncation_min_length",
    label: "Truncation Min Length (chars)",
    title: "Shortest normalized string length allowed for truncation matching.",
    min: 1,
    max: 1000,
    step: 1
  },
  {
    key: "truncation_min_ratio_percent",
    label: "Truncation Min Length Ratio (%)",
    title:
      "How much of the longer line the shorter line must cover before truncation matching is considered.",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "subset_chunk_min_length",
    label: "Subset Chunk Min Length (chars)",
    title:
      "Incoming OCR chunks shorter than this skip the chunk-coverage fallback unless they are exact matches.",
    min: 1,
    max: 1000,
    step: 1
  },
  {
    key: "matching_block_short_chunk_char_limit",
    label: "Short Chunk Limit (chars)",
    title: "Chunks at or below this length use the smaller matching-block minimum.",
    min: 1,
    max: 1000,
    step: 1
  },
  {
    key: "matching_block_small_chunk_min_size",
    label: "Short Chunk Match Min Size",
    title: "Minimum contiguous match size counted for short chunks.",
    min: 1,
    max: 1000,
    step: 1
  },
  {
    key: "matching_block_default_min_size",
    label: "Default Match Min Size",
    title: "Minimum contiguous match size counted for longer chunks.",
    min: 1,
    max: 1000,
    step: 1
  },
  {
    key: "subset_coverage_floor_percent",
    label: "Subset Coverage Floor (%)",
    title: "Lowest allowed chunk-coverage requirement for dedupe fallback.",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "subset_coverage_ceiling_percent",
    label: "Subset Coverage Ceiling (%)",
    title: "Highest allowed chunk-coverage requirement for dedupe fallback.",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "subset_coverage_threshold_offset",
    label: "Coverage Threshold Offset",
    title:
      "Offset applied before converting the current compare threshold into a coverage requirement.",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "subset_longest_block_min_chars",
    label: "Longest Block Minimum (chars)",
    title: "Minimum contiguous block size required in subset coverage mode.",
    min: 1,
    max: 1000,
    step: 1
  },
  {
    key: "subset_longest_block_divisor",
    label: "Longest Block Divisor",
    title:
      "Larger values reduce the required contiguous block length for longer chunks.",
    min: 1,
    max: 1000,
    step: 1
  }
];

const COMPARISON_DEFAULTS: Record<ComparisonFieldKey, number> = {
  duplicate_similarity_threshold: 80,
  change_detection_threshold: 20,
  evolving_prefix_similarity_threshold: 85,
  truncation_compare_threshold_min: 70,
  truncation_strict_threshold_min: 75,
  truncation_similarity_margin: 15,
  truncation_min_length: 8,
  truncation_min_ratio_percent: 25,
  subset_chunk_min_length: 5,
  matching_block_short_chunk_char_limit: 4,
  matching_block_small_chunk_min_size: 1,
  matching_block_default_min_size: 2,
  subset_coverage_floor_percent: 80,
  subset_coverage_ceiling_percent: 95,
  subset_coverage_threshold_offset: 5,
  subset_longest_block_min_chars: 2,
  subset_longest_block_divisor: 4
};

const COMPARISON_PRIMARY_KEYS: ComparisonFieldKey[] = [
  "duplicate_similarity_threshold",
  "change_detection_threshold"
];

const ENGINE_LABELS = new Map<string, string>([
  ...MAIN_OCR_OPTIONS.map((option) => [option.value, option.label] as const),
  ...STABILITY_OCR_OPTIONS.map((option) => [option.value, option.label] as const)
]);

const ENGINE_COLORS: Record<string, string> = {
  oneocr: "\x1b[36m",
  glens: "\x1b[92m",
  gemini: "\x1b[95m",
  bing: "\x1b[34m",
  screenai: "\x1b[96m",
  gvision: "\x1b[92m",
  azure: "\x1b[96m",
  ocrspace: "\x1b[93m",
  local_llm_ocr: "\x1b[95m",
  meiki_text_detector: "\x1b[95m",
  meikiocr: "\x1b[95m",
  mlkitocr: "\x1b[94m",
  alivetext: "\x1b[96m"
};

const VALID_PROCESS_PRIORITIES: ProcessPriority[] = [
  "low",
  "below_normal",
  "normal",
  "above_normal",
  "high"
];

const OCR_RUN_1_RECOGNIZED_PATTERN = /OCR Run 1: Text recognized/i;
const OCR_RUN_2_RECOGNIZED_PATTERN =
  /OCR Run 2(?:\s*\(bypassed\))?: Text recognized/i;

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

function numericValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function integerValue(value: unknown, fallback: number): number {
  return Math.round(numericValue(value, fallback));
}

function normalizeProcessPriority(value: unknown): ProcessPriority {
  if (typeof value !== "string") {
    return "normal";
  }

  const normalized = value.toLowerCase() as ProcessPriority;
  return VALID_PROCESS_PRIORITIES.includes(normalized) ? normalized : "normal";
}

function getDefaultStabilityOcr(platform: OcrPlatform): string {
  if (platform === "darwin") {
    return "alivetext";
  }
  if (platform === "linux") {
    return "meiki_text_detector";
  }
  return "oneocr";
}

function keepNewlineEnabled(
  config: OcrStoredConfig | null | undefined,
  key: "keep_newline_auto" | "keep_newline_menu" | "keep_newline_area_select"
): boolean {
  if (typeof config?.[key] === "boolean") {
    return Boolean(config[key]);
  }

  if (!config?.advancedMode) {
    return true;
  }

  return Boolean(config?.keep_newline);
}

function getEngineLabel(value: string): string {
  return ENGINE_LABELS.get(value) ?? value;
}

function getEngineAnsiColor(value: string): string {
  return ENGINE_COLORS[value] ?? "";
}

function replaceEngineLabelsWithAnsi(line: string): string {
  let next = line;
  for (const [value, label] of ENGINE_LABELS.entries()) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const color = getEngineAnsiColor(value);
    if (!color) {
      continue;
    }
    next = next.replace(new RegExp(`\\b${escaped}\\b`, "g"), `${color}${label}\x1b[0m`);
  }
  return next;
}

function normalizeOcrConfig(
  value: OcrStoredConfig | null | undefined,
  platform: OcrPlatform
): OcrUiConfig {
  const defaultStability = getDefaultStabilityOcr(platform);
  const scanRate = numericValue(value?.scanRate, 0.5);
  const comparison = {} as Record<ComparisonFieldKey, number>;

  for (const field of COMPARISON_FIELDS) {
    comparison[field.key] = numericValue(
      value?.[field.key],
      COMPARISON_DEFAULTS[field.key]
    );
  }

  return {
    advancedMode: Boolean(value?.advancedMode),
    basicScanRate: numericValue(value?.scanRate_basic, scanRate),
    advancedScanRate: numericValue(value?.scanRate_advanced, scanRate),
    mainOcr:
      typeof value?.ocr2_advanced === "string"
        ? value.ocr2_advanced
        : typeof value?.ocr2 === "string"
          ? value.ocr2
          : "glens",
    stabilityOcr:
      typeof value?.ocr1_advanced === "string"
        ? value.ocr1_advanced
        : typeof value?.ocr1 === "string"
          ? value.ocr1
          : defaultStability,
    twoPassOCR: Boolean(value?.twoPassOCR),
    optimizeSecondScan:
      value?.optimize_second_scan === undefined
        ? true
        : Boolean(value.optimize_second_scan),
    language: typeof value?.language === "string" ? value.language : "ja",
    ocrScreenshots: Boolean(value?.ocr_screenshots),
    furiganaFilterSensitivity: integerValue(
      value?.furigana_filter_sensitivity,
      0
    ),
    defaultSceneFuriganaFilterSensitivity: integerValue(
      value?.defaultSceneFuriganaFilterSensitivity,
      0
    ),
    manualOcrHotkey:
      typeof value?.manualOcrHotkey === "string"
        ? value.manualOcrHotkey
        : "Ctrl+Shift+G",
    areaSelectOcrHotkey:
      typeof value?.areaSelectOcrHotkey === "string"
        ? value.areaSelectOcrHotkey
        : "Ctrl+Shift+O",
    wholeWindowOcrHotkey:
      typeof value?.wholeWindowOcrHotkey === "string"
        ? value.wholeWindowOcrHotkey
        : "Ctrl+Shift+W",
    globalPauseHotkey:
      typeof value?.globalPauseHotkey === "string"
        ? value.globalPauseHotkey
        : "Ctrl+Shift+P",
    sendToClipboard: Boolean(value?.sendToClipboard),
    keepNewlineAuto: keepNewlineEnabled(value, "keep_newline_auto"),
    keepNewlineMenu: keepNewlineEnabled(value, "keep_newline_menu"),
    keepNewlineAreaSelect: keepNewlineEnabled(value, "keep_newline_area_select"),
    obsCapturePreprocess:
      typeof value?.obs_capture_preprocess === "string"
        ? value.obs_capture_preprocess
        : "none",
    ignoreOcrRun1Text: value?.ignore_ocr_run_1_text === true,
    processPriority: normalizeProcessPriority(value?.processPriority),
    baseScale: numericValue(value?.base_scale, 0.75),
    comparison
  };
}

function buildPersistedConfig(
  config: OcrUiConfig,
  platform: OcrPlatform,
  baseConfig: OcrStoredConfig
): OcrStoredConfig {
  const defaultStability = getDefaultStabilityOcr(platform);
  const next: OcrStoredConfig = {
    ...baseConfig,
    twoPassOCR: config.twoPassOCR,
    optimize_second_scan: config.optimizeSecondScan,
    scanRate: config.advancedMode ? config.advancedScanRate : config.basicScanRate,
    scanRate_basic: config.basicScanRate,
    scanRate_advanced: config.advancedScanRate,
    language: config.language,
    ocr_screenshots: config.ocrScreenshots,
    furigana_filter_sensitivity: config.furiganaFilterSensitivity,
    defaultSceneFuriganaFilterSensitivity:
      config.defaultSceneFuriganaFilterSensitivity,
    manualOcrHotkey: config.manualOcrHotkey,
    areaSelectOcrHotkey: config.areaSelectOcrHotkey,
    wholeWindowOcrHotkey: config.wholeWindowOcrHotkey,
    globalPauseHotkey: config.globalPauseHotkey,
    sendToClipboard: config.sendToClipboard,
    keep_newline:
      config.keepNewlineAuto ||
      config.keepNewlineMenu ||
      config.keepNewlineAreaSelect,
    keep_newline_auto: config.keepNewlineAuto,
    keep_newline_menu: config.keepNewlineMenu,
    keep_newline_area_select: config.keepNewlineAreaSelect,
    obs_capture_preprocess: config.obsCapturePreprocess,
    ignore_ocr_run_1_text: config.ignoreOcrRun1Text,
    processPriority: config.processPriority,
    base_scale: config.baseScale,
    advancedMode: config.advancedMode,
    ocr1_advanced: config.stabilityOcr,
    ocr2_advanced: config.mainOcr
  };

  if (config.advancedMode) {
    next.ocr1 = config.stabilityOcr;
    next.ocr2 = config.mainOcr;
  } else {
    next.ocr1 = defaultStability;
    next.ocr2 = "glens";
  }

  for (const field of COMPARISON_FIELDS) {
    next[field.key] = config.comparison[field.key];
  }

  return next;
}

function basicSpeedLabel(scanRate: number): string {
  if (scanRate <= 0.3) {
    return "Instant";
  }
  if (scanRate <= 0.65) {
    return "Normal";
  }
  if (scanRate <= 0.9) {
    return "Slow";
  }
  return "Very Slow";
}

function captureHotkey(event: React.KeyboardEvent<HTMLInputElement>): string {
  event.preventDefault();

  if (event.key === "Escape") {
    return "";
  }

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
  if (event.key && !["Control", "Shift", "Alt"].includes(event.key)) {
    keys.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
  }

  return keys.join("+");
}

function getLegacyAssetPath(fileName: string): string {
  const base = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  return `${base}legacy/${fileName.replace(/^\/+/, "")}`;
}

function splitComparisonFields() {
  const primary = COMPARISON_FIELDS.filter((field) =>
    COMPARISON_PRIMARY_KEYS.includes(field.key)
  );
  const expert = COMPARISON_FIELDS.filter(
    (field) => !COMPARISON_PRIMARY_KEYS.includes(field.key)
  );
  const midpoint = Math.ceil(expert.length / 2);

  return {
    primary,
    expertLeft: expert.slice(0, midpoint),
    expertRight: expert.slice(midpoint)
  };
}

const COMPARISON_LAYOUT = splitComparisonFields();

export function OCRTab({ active }: OcrTabProps) {
  const platform = platformFromEnv();
  const [config, setConfig] = useState<OcrUiConfig>(() =>
    normalizeOcrConfig(null, platform)
  );
  const [configLoaded, setConfigLoaded] = useState(false);
  const [scenes, setScenes] = useState<ObsScene[]>([]);
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [loadingScenes, setLoadingScenes] = useState(true);
  const [activeSceneAreaConfig, setActiveSceneAreaConfig] =
    useState<OcrSceneAreaConfig | null>(null);
  const [runningState, setRunningState] = useState<OcrRunningState>({
    isRunning: false,
    mode: null
  });
  const [paused, setPaused] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState("Idle");
  const [runtimeEngine, setRuntimeEngine] = useState("");
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [debugExpanded, setDebugExpanded] = useState(false);
  const [installDependency, setInstallDependency] = useState(
    DEPENDENCY_INSTALL_OPTIONS[0]?.value ?? ""
  );
  const [removeDependency, setRemoveDependency] = useState(
    DEPENDENCY_REMOVE_OPTIONS[0]?.value ?? ""
  );

  const terminalElementRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const baseConfigRef = useRef<OcrStoredConfig>({});
  const configRef = useRef(config);
  const runningStateRef = useRef(runningState);
  const pausedRef = useRef(paused);
  const previousLogLineRef = useRef("");

  const selectedScene = useMemo(
    () => scenes.find((scene) => scene.id === selectedSceneId) ?? null,
    [scenes, selectedSceneId]
  );

  const configuredAreaCount = activeSceneAreaConfig?.rectangles?.length ?? 0;
  const hasConfiguredAreas = configuredAreaCount > 0;
  const effectiveScanRate = config.advancedMode
    ? config.advancedScanRate
    : config.basicScanRate;
  const effectiveMainEngine = config.advancedMode ? config.mainOcr : "glens";
  const effectiveStabilityEngine = config.advancedMode
    ? config.stabilityOcr
    : getDefaultStabilityOcr(platform);
  const engineFlowLabel =
    config.advancedMode && !config.twoPassOCR
      ? getEngineLabel(effectiveMainEngine)
      : `${getEngineLabel(effectiveStabilityEngine)} -> ${getEngineLabel(
          effectiveMainEngine
        )}`;

  const footerTone = runningState.isRunning
    ? paused
      ? "paused"
      : "running"
    : hasConfiguredAreas
      ? "ready"
      : "warning";

  const footerStatusLabel = runningState.isRunning
    ? paused
      ? "Paused"
      : "Running"
    : hasConfiguredAreas
      ? "Ready"
      : "Needs Areas";

  const footerSummary = runningState.isRunning
    ? runtimeMessage
    : hasConfiguredAreas
      ? `${selectedScene?.name ?? "Current scene"} has ${configuredAreaCount} OCR ${
          configuredAreaCount === 1 ? "area" : "areas"
        }.`
      : `No OCR areas saved for ${selectedScene?.name ?? "the selected scene"}.`;

  const sceneSummary = selectedScene?.name ?? "No scene selected";
  const scanSummary = config.advancedMode
    ? `${effectiveScanRate.toFixed(1)}s`
    : basicSpeedLabel(config.basicScanRate);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    runningStateRef.current = runningState;
  }, [runningState]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timer = setTimeout(() => {
      setNotice(null);
    }, 8000);

    return () => clearTimeout(timer);
  }, [notice]);

  const fitTerminal = useCallback(() => {
    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current);
    }

    resizeTimerRef.current = setTimeout(() => {
      fitAddonRef.current?.fit();
    }, 80);
  }, []);

  useEffect(() => {
    if (!terminalElementRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      fontFamily: '"Noto Sans Mono", "IPA Gothic", "Courier New", monospace',
      fontSize: 13,
      cursorBlink: false,
      theme: {
        foreground: "#eeeeee",
        background: "#11151c",
        cursor: "#cff5db"
      }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalElementRef.current);
    fitAddon.fit();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    terminal.onData((data) => {
      sendIpc("ocr.stdin", data);
    });

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.ctrlKey && event.code === "KeyC" && event.type === "keydown") {
        const selection = terminal.getSelection();
        if (selection) {
          window.clipboard.writeText(selection);
          return false;
        }
      }
      return true;
    });

    const handleResize = () => fitAddon.fit();
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (terminal.hasSelection()) {
        window.clipboard.writeText(terminal.getSelection());
        terminal.clearSelection();
      }
    };

    terminalElementRef.current.addEventListener("contextmenu", handleContextMenu);
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      terminalElementRef.current?.removeEventListener(
        "contextmenu",
        handleContextMenu
      );
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
      }
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (active) {
      fitTerminal();
    }
  }, [active, fitTerminal]);

  const appendTerminalLine = useCallback(
    (message: string) => {
      if (!message.trim()) {
        return;
      }
      terminalRef.current?.writeln(message);
      fitTerminal();
    },
    [fitTerminal]
  );

  const clearTerminal = useCallback(() => {
    terminalRef.current?.clear();
    previousLogLineRef.current = "";
  }, []);

  const persistConfig = useCallback(() => {
    const next = buildPersistedConfig(
      configRef.current,
      platform,
      baseConfigRef.current
    );
    baseConfigRef.current = next;
    sendIpc("ocr.save-ocr-config", next);
  }, [platform]);

  const flushConfigSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    persistConfig();
  }, [persistConfig]);

  useEffect(() => {
    if (!configLoaded) {
      return;
    }

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(() => {
      persistConfig();
      saveTimerRef.current = null;
    }, 180);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [config, configLoaded, persistConfig]);

  const refreshActiveSceneInfo = useCallback(async () => {
    try {
      const [areaConfig, sceneSettings] = await Promise.all([
        invokeIpc<OcrSceneAreaConfig | null>("ocr.getActiveOCRConfig"),
        invokeIpc<OcrSceneSettings | null>("ocr.getActiveSceneSettings")
      ]);
      setActiveSceneAreaConfig(areaConfig);

      const sensitivity = integerValue(
        sceneSettings?.furigana_filter_sensitivity,
        configRef.current.furiganaFilterSensitivity
      );
      setConfig((current) =>
        current.furiganaFilterSensitivity === sensitivity
          ? current
          : { ...current, furiganaFilterSensitivity: sensitivity }
      );
    } catch (error) {
      console.error("Failed to refresh active OCR scene info:", error);
    }
  }, []);

  const refreshScenesAndConfig = useCallback(
    async (showLoading = true) => {
      if (showLoading) {
        setLoadingScenes(true);
      }

      try {
        const [sceneResponse, activeSceneResponse] = await Promise.all([
          invokeIpc<unknown>("obs.getScenes"),
          invokeIpc<ObsScene | null>("obs.getActiveScene")
        ]);
        const nextScenes = toObsScenes(sceneResponse);

        let nextSelectedSceneId =
          selectedSceneId &&
          nextScenes.some((scene) => scene.id === selectedSceneId)
            ? selectedSceneId
            : nextScenes[0]?.id ?? "";

        if (
          activeSceneResponse &&
          nextScenes.some((scene) => scene.id === activeSceneResponse.id)
        ) {
          nextSelectedSceneId = activeSceneResponse.id;
        }

        setScenes(nextScenes);
        setSelectedSceneId(nextSelectedSceneId);
        await refreshActiveSceneInfo();
      } catch (error) {
        console.error("Failed to load OCR scenes:", error);
        setScenes([]);
        setSelectedSceneId("");
      } finally {
        setLoadingScenes(false);
      }
    },
    [refreshActiveSceneInfo, selectedSceneId]
  );

  const refreshRunningState = useCallback(async () => {
    try {
      const nextState = await invokeIpc<OcrRunningState>("ocr.get-running-state");
      setRunningState({
        isRunning: Boolean(nextState?.isRunning),
        source: nextState?.source,
        mode: nextState?.mode ?? null
      });

      if (!nextState?.isRunning) {
        setPaused(false);
        setRuntimeMessage("Idle");
        setRuntimeEngine("");
      } else if (nextState.mode === "manual") {
        setRuntimeMessage("Running manual OCR");
      }
    } catch (error) {
      console.error("Failed to refresh OCR running state:", error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const storedConfig = await invokeIpc<OcrStoredConfig | null>("ocr.get-ocr-config");
        if (cancelled) {
          return;
        }

        baseConfigRef.current = storedConfig ?? {};
        setConfig(normalizeOcrConfig(storedConfig, platform));
        setConfigLoaded(true);
      } catch (error) {
        console.error("Failed to load OCR config:", error);
        if (!cancelled) {
          setConfigLoaded(true);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [platform]);

  useEffect(() => {
    if (!active) {
      return;
    }

    void refreshScenesAndConfig();
    void refreshRunningState();

    const sceneTimer = setInterval(() => {
      void refreshScenesAndConfig(false);
    }, 5000);

    const statusTimer = setInterval(() => {
      void refreshRunningState();
      if (runningStateRef.current.isRunning) {
        sendIpc("ocr.get-status");
      }
    }, 5000);

    return () => {
      clearInterval(sceneTimer);
      clearInterval(statusTimer);
    };
  }, [active, refreshRunningState, refreshScenesAndConfig]);

  useEffect(() => {
    const offLog = onIpc("ocr-log", (_event, payload) => {
      const rawLine = String(payload ?? "");
      const trimmedLine = rawLine.trim();
      const lowerLine = trimmedLine.toLowerCase();
      if (!trimmedLine) {
        return;
      }

      const isNativeNoise =
        /^I\d{4}\s/u.test(trimmedLine) || /^W\d{4}\s/u.test(trimmedLine);
      if (
        lowerLine.includes("failed to load cu") ||
        lowerLine.includes("please follow https://onnxruntime.ai")
      ) {
        return;
      }
      if (
        isNativeNoise &&
        (lowerLine.includes("group_rpn_detector_utils") ||
          lowerLine.includes("tflite_model_pooled") ||
          lowerLine.includes("multi_pass_line_recognition_mutator") ||
          lowerLine.includes("mobile_langid") ||
          lowerLine.includes("scheduler.cc:692") ||
          lowerLine.includes("coarse_classifier_calculator"))
      ) {
        return;
      }
      if (
        lowerLine.includes("created tensorflow lite xnnpack delegate for cpu") ||
        lowerLine.includes("standard_text_reorderer.cc:401") ||
        lowerLine.includes("invalid alignment between pre-joined atoms and icu symbols") ||
        trimmedLine.includes("Multiple active video sources found in OBS")
      ) {
        return;
      }
      if (
        configRef.current.ignoreOcrRun1Text &&
        OCR_RUN_1_RECOGNIZED_PATTERN.test(trimmedLine)
      ) {
        return;
      }

      if (trimmedLine.endsWith("sleeping.")) {
        setRuntimeMessage("Sleeping: image empty or unchanged");
        return;
      }

      if (trimmedLine.includes("COMMAND_FINISHED")) {
        setNotice({ type: "success", message: "OCR area selection finished." });
        return;
      }

      const engineMatch = trimmedLine.includes("using")
        ? trimmedLine.split("using")[1]?.split(":")[0]?.trim()
        : "";
      const engineKey =
        MAIN_OCR_OPTIONS.find((option) => option.label === engineMatch)?.value ??
        STABILITY_OCR_OPTIONS.find((option) => option.label === engineMatch)?.value ??
        "";

      if (trimmedLine.endsWith(":") && engineKey && !pausedRef.current) {
        setRuntimeEngine(getEngineLabel(engineKey));
        const speed = trimmedLine.split(" in ")[1]?.split("s")[0]?.trim();
        setRuntimeMessage(
          speed
            ? `Scanning with ${getEngineLabel(engineKey)} in ${speed}s`
            : `Scanning with ${getEngineLabel(engineKey)}`
        );
        return;
      }

      if (trimmedLine.includes("Seems like Text we already sent")) {
        if (previousLogLineRef.current) {
          appendTerminalLine(`\x1b[33m${previousLogLineRef.current} (Duplicate)\x1b[0m`);
        }
        return;
      }

      const nextTerminalLine = OCR_RUN_2_RECOGNIZED_PATTERN.test(trimmedLine)
        ? `\x1b[92m${trimmedLine}\x1b[0m`
        : replaceEngineLabelsWithAnsi(trimmedLine);

      appendTerminalLine(nextTerminalLine);
      previousLogLineRef.current = trimmedLine;
    });

    const offStarted = onIpc("ocr-started", () => {
      setRunningState((current) => ({ ...current, isRunning: true }));
      setPaused(false);
      setRuntimeMessage("Starting OCR...");
    });

    const offStopped = onIpc("ocr-stopped", () => {
      void refreshRunningState();
    });

    const offPaused = onIpc("ocr-ipc-paused", () => {
      setPaused(true);
      setRuntimeMessage("Paused");
    });

    const offUnpaused = onIpc("ocr-ipc-unpaused", () => {
      setPaused(false);
      setRuntimeMessage("Running");
    });

    const offStatus = onIpc("ocr-ipc-status", (_event, payload) => {
      const status = (payload ?? {}) as OcrStatusPayload;
      setPaused(Boolean(status.paused));
      setRunningState((current) => ({
        ...current,
        isRunning: true,
        mode: status.manual ? "manual" : "auto"
      }));

      const engineLabel = status.current_engine
        ? getEngineLabel(status.current_engine)
        : "";
      setRuntimeEngine(engineLabel);

      if (status.paused) {
        setRuntimeMessage("Paused");
        return;
      }

      if (status.manual) {
        setRuntimeMessage(
          engineLabel ? `Running manual OCR with ${engineLabel}` : "Running manual OCR"
        );
        return;
      }

      const scanRate = numericValue(status.scan_rate, effectiveScanRate);
      setRuntimeMessage(
        engineLabel
          ? `Running auto OCR with ${engineLabel} at ${scanRate.toFixed(1)}s`
          : `Running auto OCR at ${scanRate.toFixed(1)}s`
      );
    });

    const offError = onIpc("ocr-ipc-error", (_event, payload) => {
      const message = String(payload ?? "Unknown OCR error");
      setRuntimeMessage(`Error: ${message}`);
      setNotice({ type: "error", message });
      appendTerminalLine(`\x1b[91m${message}\x1b[0m`);
    });

    const offConfigReloaded = onIpc("ocr-ipc-config-reloaded", () => {
      appendTerminalLine("\x1b[36mConfiguration reloaded\x1b[0m");
    });

    const offForceStable = onIpc(
      "ocr-ipc-force-stable-changed",
      (_event, payload) => {
        const enabled = Boolean(
          typeof payload === "object" &&
            payload !== null &&
            "enabled" in (payload as Record<string, unknown>) &&
            (payload as Record<string, unknown>).enabled
        );
        appendTerminalLine(
          `\x1b[35mForce stable mode ${enabled ? "enabled" : "disabled"}\x1b[0m`
        );
      }
    );

    return () => {
      offLog();
      offStarted();
      offStopped();
      offPaused();
      offUnpaused();
      offStatus();
      offError();
      offConfigReloaded();
      offForceStable();
    };
  }, [appendTerminalLine, effectiveScanRate, refreshRunningState]);

  const setComparisonValue = useCallback(
    (key: ComparisonFieldKey, value: number) => {
      setConfig((current) => ({
        ...current,
        comparison: {
          ...current.comparison,
          [key]: value
        }
      }));
    },
    []
  );

  const switchScene = useCallback(
    async (sceneId: string) => {
      setSelectedSceneId(sceneId);
      try {
        await invokeIpc("obs.switchScene.id", sceneId);
        setTimeout(() => {
          void refreshActiveSceneInfo();
        }, 500);
      } catch (error) {
        console.error("Failed to switch OCR scene:", error);
        setNotice({ type: "error", message: "Failed to switch scene." });
      }
    },
    [refreshActiveSceneInfo]
  );

  const openOcrDocs = useCallback(async () => {
    try {
      const result = await invokeIpc<{ success?: boolean; error?: string }>(
        "docs.openWindow",
        { url: DOCS_URLS.ocr }
      );
      if (result?.success === false) {
        window.open(DOCS_URLS.ocr, "_blank", "noopener");
      }
    } catch (error) {
      console.error("Failed to open OCR guide:", error);
      window.open(DOCS_URLS.ocr, "_blank", "noopener");
    }
  }, []);

  const importAreaConfig = useCallback(async () => {
    try {
      const result = await invokeIpc<{ success: boolean; message: string }>(
        "ocr.import-ocr-config"
      );
      if (result.success) {
        setNotice({ type: "success", message: "OCR area config imported." });
        await refreshActiveSceneInfo();
      } else {
        setNotice({ type: "error", message: result.message });
      }
    } catch (error) {
      console.error("Failed to import OCR config:", error);
      setNotice({ type: "error", message: "Import failed." });
    }
  }, [refreshActiveSceneInfo]);

  const exportAreaConfig = useCallback(async () => {
    try {
      const result = await invokeIpc<{ success: boolean; message: string }>(
        "ocr.export-ocr-config"
      );
      setNotice({
        type: result.success ? "success" : "error",
        message: result.success ? "OCR area config copied to clipboard." : result.message
      });
    } catch (error) {
      console.error("Failed to export OCR config:", error);
      setNotice({ type: "error", message: "Export failed." });
    }
  }, []);

  const runScreenSelector = useCallback(() => {
    appendTerminalLine("\x1b[36mOpening OCR area selector...\x1b[0m");
    sendIpc("ocr.run-screen-selector");
  }, [appendTerminalLine]);

  const startOcr = useCallback(
    async (manual: boolean) => {
      clearTerminal();
      flushConfigSave();
      setPaused(false);
      setRuntimeMessage(manual ? "Starting manual OCR..." : "Starting auto OCR...");
      setRunningState((current) => ({
        ...current,
        isRunning: true,
        mode: manual ? "manual" : "auto"
      }));
      sendIpc(manual ? "ocr.start-ocr-ss-only" : "ocr.start-ocr");
    },
    [clearTerminal, flushConfigSave]
  );

  const stopOcr = useCallback(async () => {
    try {
      const state = await invokeIpc<OcrRunningState>("ocr.get-running-state");
      if (state?.isRunning) {
        sendIpc("ocr.kill-ocr");
      }
      setRunningState({ isRunning: false, mode: null });
      setPaused(false);
      setRuntimeMessage("Idle");
      setRuntimeEngine("");
    } catch (error) {
      console.error("Failed to stop OCR:", error);
      sendIpc("ocr.kill-ocr");
    }
  }, []);

  const togglePause = useCallback(() => {
    sendIpc("ocr.toggle-pause");
  }, []);

  const installSelectedDependency = useCallback(() => {
    appendTerminalLine(`\x1b[36mInstalling ${installDependency}...\x1b[0m`);
    sendIpc("ocr.install-selected-dep", installDependency);
  }, [appendTerminalLine, installDependency]);

  const uninstallSelectedDependency = useCallback(() => {
    appendTerminalLine(`\x1b[36mUninstalling ${removeDependency}...\x1b[0m`);
    sendIpc("ocr.uninstall-selected-dep", removeDependency);
  }, [appendTerminalLine, removeDependency]);

  const openOcrReplacementsPage = useCallback(() => {
    window.open(getLegacyAssetPath("ocr_replacements.html"), "_blank", "noopener");
  }, []);

  return (
    <div className={`tab-panel ${active ? "active" : ""}`}>
      <div className="modern-tab ocr-tab-root">
        <div className="ocr-tab-scroll">
          <div className="ocr-tab-stack">
            <section className="card legacy-card ocr-card">
              <div className="ocr-card-header-row">
                <div>
                  <h2>Source and Areas</h2>
                  <p className="muted ocr-card-muted">
                    Pick the OBS scene, then create or import OCR areas for that scene.
                  </p>
                </div>
                <div className="ocr-summary-pill-row">
                  <span className="ocr-summary-pill">{sceneSummary}</span>
                  <span className="ocr-summary-pill">{configuredAreaCount} areas</span>
                  <span className="ocr-summary-pill">
                    {config.advancedMode ? "Advanced" : "Basic"}
                  </span>
                  <span className="ocr-summary-pill">{scanSummary}</span>
                </div>
              </div>

              <div className="ocr-source-grid">
                <div className="ocr-field ocr-field--wide">
                  <label htmlFor="ocr-scene-select" className="ocr-field-label">
                    OBS Scene
                  </label>
                  <div className="ocr-inline-control-row">
                    <select
                      id="ocr-scene-select"
                      value={selectedSceneId}
                      title="Select the OBS scene GSM should watch for OCR."
                      onChange={(event) => {
                        void switchScene(event.target.value);
                      }}
                    >
                      {loadingScenes ? (
                        <option value="">Loading...</option>
                      ) : scenes.length === 0 ? (
                        <option value="">No scenes found</option>
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
                        void refreshScenesAndConfig();
                      }}
                    >
                      Refresh
                    </button>
                  </div>
                </div>

                <div className="ocr-field">
                  <span className="ocr-field-label">OCR Flow</span>
                  <div className="ocr-readonly-value">{engineFlowLabel}</div>
                </div>

                <div className="ocr-field">
                  <span className="ocr-field-label">Current Source</span>
                  <div className="ocr-readonly-value">
                    {activeSceneAreaConfig?.window || "OBS scene capture"}
                  </div>
                </div>

                <div className="ocr-field ocr-field--actions">
                  <span className="ocr-field-label">Area Tools</span>
                  <div className="ocr-action-row">
                    <button type="button" onClick={runScreenSelector}>
                      Select OCR Areas
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void importAreaConfig()}
                    >
                      Import Areas
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void exportAreaConfig()}
                    >
                      Export Areas
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void openOcrDocs()}
                    >
                      OCR Guide
                    </button>
                  </div>
                </div>
              </div>

              {notice ? (
                <div className={`status-card ${notice.type} ocr-inline-notice`} aria-live="polite">
                  <p>{notice.message}</p>
                </div>
              ) : null}
            </section>

            <section className="card legacy-card ocr-card">
              <div className="ocr-card-header-row">
                <div>
                  <h2>OCR Settings</h2>
                  <p className="muted ocr-card-muted">
                    Core settings stay visible first. Advanced mode exposes engine and
                    comparison tuning.
                  </p>
                </div>
                <label className="ocr-mode-toggle" htmlFor="ocr-advanced-toggle">
                  <span>Advanced</span>
                  <input
                    id="ocr-advanced-toggle"
                    type="checkbox"
                    checked={config.advancedMode}
                    onChange={(event) => {
                      setConfig((current) => ({
                        ...current,
                        advancedMode: event.target.checked
                      }));
                    }}
                  />
                </label>
              </div>

              {!config.advancedMode ? (
                <div className="ocr-settings-grid">
                  <div className="ocr-settings-panel">
                    <div className="ocr-panel-header">
                      <h3>Quick Setup</h3>
                      <span className="ocr-panel-tag">Most used</span>
                    </div>

                    <div className="ocr-field">
                      <label
                        htmlFor="ocr-basic-speed"
                        className="ocr-field-label"
                        title="How quickly text appears in-game."
                      >
                        Text Appearance Speed
                      </label>
                      <select
                        id="ocr-basic-speed"
                        value={String(config.basicScanRate)}
                        onChange={(event) => {
                          setConfig((current) => ({
                            ...current,
                            basicScanRate: numericValue(event.target.value, 0.5)
                          }));
                        }}
                      >
                        {BASIC_SCAN_RATE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="ocr-field">
                      <label htmlFor="ocr-language" className="ocr-field-label">
                        Language
                      </label>
                      <select
                        id="ocr-language"
                        value={config.language}
                        onChange={(event) => {
                          setConfig((current) => ({
                            ...current,
                            language: event.target.value
                          }));
                        }}
                      >
                        {LANGUAGE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="ocr-field">
                      <label htmlFor="ocr-base-scale" className="ocr-field-label">
                        Scan Image Quality
                        <span className="ocr-inline-value">
                          {Math.round(config.baseScale * 100)}%
                        </span>
                      </label>
                      <input
                        id="ocr-base-scale"
                        type="range"
                        min={0.5}
                        max={1}
                        step={0.05}
                        value={config.baseScale}
                        onChange={(event) => {
                          setConfig((current) => ({
                            ...current,
                            baseScale: numericValue(event.target.value, 0.75)
                          }));
                        }}
                      />
                    </div>

                    <div className="ocr-field">
                      <label
                        htmlFor="ocr-furigana-filter"
                        className="ocr-field-label"
                      >
                        Furigana Filter
                        <span className="ocr-inline-value">
                          {config.furiganaFilterSensitivity}
                        </span>
                      </label>
                      <div className="ocr-inline-control-row">
                        <input
                          id="ocr-furigana-filter"
                          type="range"
                          min={0}
                          max={100}
                          step={1}
                          value={config.furiganaFilterSensitivity}
                          onChange={(event) => {
                            const next = integerValue(event.target.value, 0);
                            setConfig((current) => ({
                              ...current,
                              furiganaFilterSensitivity: next
                            }));
                            sendIpc("update-furigana-character", "龍", next);
                          }}
                        />
                        <button
                          type="button"
                          className="secondary"
                          onClick={async () => {
                            const next = await invokeIpc<number>("run-furigana-window");
                            setConfig((current) => ({
                              ...current,
                              furiganaFilterSensitivity: integerValue(next, 0)
                            }));
                          }}
                        >
                          Preview
                        </button>
                      </div>
                    </div>

                    <div className="ocr-toggle-list">
                      <label className="ocr-toggle-field" htmlFor="ocr-send-clipboard">
                        <span>Send Text to Clipboard</span>
                        <input
                          id="ocr-send-clipboard"
                          type="checkbox"
                          checked={config.sendToClipboard}
                          onChange={(event) => {
                            setConfig((current) => ({
                              ...current,
                              sendToClipboard: event.target.checked
                            }));
                          }}
                        />
                      </label>

                      <div className="ocr-field">
                        <span className="ocr-field-label">Preserve Line Breaks</span>
                        <div className="ocr-chip-toggle-row">
                          <label className="ocr-chip-toggle" htmlFor="keep-newline-auto">
                            <input
                              id="keep-newline-auto"
                              type="checkbox"
                              checked={config.keepNewlineAuto}
                              onChange={(event) => {
                                setConfig((current) => ({
                                  ...current,
                                  keepNewlineAuto: event.target.checked
                                }));
                              }}
                            />
                            <span>Auto</span>
                          </label>
                          <label className="ocr-chip-toggle" htmlFor="keep-newline-menu">
                            <input
                              id="keep-newline-menu"
                              type="checkbox"
                              checked={config.keepNewlineMenu}
                              onChange={(event) => {
                                setConfig((current) => ({
                                  ...current,
                                  keepNewlineMenu: event.target.checked
                                }));
                              }}
                            />
                            <span>Menu</span>
                          </label>
                          <label
                            className="ocr-chip-toggle"
                            htmlFor="keep-newline-area-select"
                          >
                            <input
                              id="keep-newline-area-select"
                              type="checkbox"
                              checked={config.keepNewlineAreaSelect}
                              onChange={(event) => {
                                setConfig((current) => ({
                                  ...current,
                                  keepNewlineAreaSelect: event.target.checked
                                }));
                              }}
                            />
                            <span>Area Select</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="ocr-settings-panel">
                    <div className="ocr-panel-header">
                      <h3>Hotkeys</h3>
                      <span className="ocr-panel-tag">Basic view</span>
                    </div>

                    <div className="ocr-field">
                      <label htmlFor="manual-hotkey" className="ocr-field-label">
                        Manual or Menu OCR
                      </label>
                      <input
                        id="manual-hotkey"
                        type="text"
                        readOnly
                        value={config.manualOcrHotkey}
                        onKeyDown={(event) => {
                          const next = captureHotkey(event);
                          setConfig((current) => ({
                            ...current,
                            manualOcrHotkey: next
                          }));
                        }}
                      />
                    </div>

                    <div className="ocr-field">
                      <label htmlFor="area-hotkey" className="ocr-field-label">
                        Area Select OCR
                      </label>
                      <input
                        id="area-hotkey"
                        type="text"
                        readOnly
                        value={config.areaSelectOcrHotkey}
                        onKeyDown={(event) => {
                          const next = captureHotkey(event);
                          setConfig((current) => ({
                            ...current,
                            areaSelectOcrHotkey: next
                          }));
                        }}
                      />
                    </div>

                    <div className="ocr-field">
                      <label htmlFor="whole-window-hotkey" className="ocr-field-label">
                        Whole Window OCR
                      </label>
                      <input
                        id="whole-window-hotkey"
                        type="text"
                        readOnly
                        value={config.wholeWindowOcrHotkey}
                        onKeyDown={(event) => {
                          const next = captureHotkey(event);
                          setConfig((current) => ({
                            ...current,
                            wholeWindowOcrHotkey: next
                          }));
                        }}
                      />
                    </div>

                    <div className="ocr-field">
                      <label htmlFor="pause-hotkey" className="ocr-field-label">
                        Global Pause
                      </label>
                      <input
                        id="pause-hotkey"
                        type="text"
                        readOnly
                        value={config.globalPauseHotkey}
                        onKeyDown={(event) => {
                          const next = captureHotkey(event);
                          setConfig((current) => ({
                            ...current,
                            globalPauseHotkey: next
                          }));
                        }}
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="ocr-settings-grid">
                    <div className="ocr-settings-panel">
                      <div className="ocr-panel-header">
                        <h3>Recognition</h3>
                        <span className="ocr-panel-tag">Pipeline</span>
                      </div>

                      <div className="ocr-field">
                        <label htmlFor="ocr-language-advanced" className="ocr-field-label">
                          Language
                        </label>
                        <select
                          id="ocr-language-advanced"
                          value={config.language}
                          onChange={(event) => {
                            setConfig((current) => ({
                              ...current,
                              language: event.target.value
                            }));
                          }}
                        >
                          {LANGUAGE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="ocr-field">
                        <label htmlFor="ocr-main-engine" className="ocr-field-label">
                          Main OCR
                        </label>
                        <select
                          id="ocr-main-engine"
                          value={config.mainOcr}
                          onChange={(event) => {
                            setConfig((current) => ({
                              ...current,
                              mainOcr: event.target.value
                            }));
                          }}
                        >
                          {MAIN_OCR_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <label className="ocr-toggle-field" htmlFor="two-pass-ocr">
                        <span>Enable Two Pass OCR</span>
                        <input
                          id="two-pass-ocr"
                          type="checkbox"
                          checked={config.twoPassOCR}
                          onChange={(event) => {
                            setConfig((current) => ({
                              ...current,
                              twoPassOCR: event.target.checked
                            }));
                          }}
                        />
                      </label>

                      {config.twoPassOCR ? (
                        <>
                          <div className="ocr-field">
                            <label
                              htmlFor="ocr-stability-engine"
                              className="ocr-field-label"
                            >
                              Text Stability OCR
                            </label>
                            <select
                              id="ocr-stability-engine"
                              value={config.stabilityOcr}
                              onChange={(event) => {
                                setConfig((current) => ({
                                  ...current,
                                  stabilityOcr: event.target.value
                                }));
                              }}
                            >
                              {STABILITY_OCR_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </div>

                          <label
                            className="ocr-toggle-field"
                            htmlFor="optimize-second-scan"
                          >
                            <span>Optimize 2nd Scan</span>
                            <input
                              id="optimize-second-scan"
                              type="checkbox"
                              checked={config.optimizeSecondScan}
                              onChange={(event) => {
                                setConfig((current) => ({
                                  ...current,
                                  optimizeSecondScan: event.target.checked
                                }));
                              }}
                            />
                          </label>
                        </>
                      ) : null}

                      <div className="ocr-field">
                        <label htmlFor="ocr-scan-rate" className="ocr-field-label">
                          Scan Rate (seconds)
                        </label>
                        <input
                          id="ocr-scan-rate"
                          type="number"
                          min={0}
                          max={2}
                          step={0.1}
                          value={config.advancedScanRate}
                          onChange={(event) => {
                            setConfig((current) => ({
                              ...current,
                              advancedScanRate: numericValue(event.target.value, 0.5)
                            }));
                          }}
                        />
                      </div>

                      <div className="ocr-field">
                        <label htmlFor="ocr-base-scale-advanced" className="ocr-field-label">
                          Scan Image Quality
                          <span className="ocr-inline-value">
                            {Math.round(config.baseScale * 100)}%
                          </span>
                        </label>
                        <input
                          id="ocr-base-scale-advanced"
                          type="range"
                          min={0.5}
                          max={1}
                          step={0.05}
                          value={config.baseScale}
                          onChange={(event) => {
                            setConfig((current) => ({
                              ...current,
                              baseScale: numericValue(event.target.value, 0.75)
                            }));
                          }}
                        />
                      </div>

                      <div className="ocr-field">
                        <label
                          htmlFor="ocr-furigana-filter-advanced"
                          className="ocr-field-label"
                        >
                          Furigana Filter
                          <span className="ocr-inline-value">
                            {config.furiganaFilterSensitivity}
                          </span>
                        </label>
                        <div className="ocr-inline-control-row">
                          <input
                            id="ocr-furigana-filter-advanced"
                            type="range"
                            min={0}
                            max={100}
                            step={1}
                            value={config.furiganaFilterSensitivity}
                            onChange={(event) => {
                              const next = integerValue(event.target.value, 0);
                              setConfig((current) => ({
                                ...current,
                                furiganaFilterSensitivity: next
                              }));
                              sendIpc("update-furigana-character", "龍", next);
                            }}
                          />
                          <button
                            type="button"
                            className="secondary"
                            onClick={async () => {
                              const next = await invokeIpc<number>("run-furigana-window");
                              setConfig((current) => ({
                                ...current,
                                furiganaFilterSensitivity: integerValue(next, 0)
                              }));
                            }}
                          >
                            Preview
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="ocr-settings-panel">
                      <div className="ocr-panel-header">
                        <h3>Output and Controls</h3>
                        <span className="ocr-panel-tag">Runtime</span>
                      </div>

                      <div className="ocr-field">
                        <label
                          htmlFor="manual-hotkey-advanced"
                          className="ocr-field-label"
                        >
                          Manual or Menu OCR
                        </label>
                        <input
                          id="manual-hotkey-advanced"
                          type="text"
                          readOnly
                          value={config.manualOcrHotkey}
                          onKeyDown={(event) => {
                            const next = captureHotkey(event);
                            setConfig((current) => ({
                              ...current,
                              manualOcrHotkey: next
                            }));
                          }}
                        />
                      </div>

                      <div className="ocr-field">
                        <label
                          htmlFor="area-hotkey-advanced"
                          className="ocr-field-label"
                        >
                          Area Select OCR
                        </label>
                        <input
                          id="area-hotkey-advanced"
                          type="text"
                          readOnly
                          value={config.areaSelectOcrHotkey}
                          onKeyDown={(event) => {
                            const next = captureHotkey(event);
                            setConfig((current) => ({
                              ...current,
                              areaSelectOcrHotkey: next
                            }));
                          }}
                        />
                      </div>

                      <div className="ocr-field">
                        <label
                          htmlFor="whole-window-hotkey-advanced"
                          className="ocr-field-label"
                        >
                          Whole Window OCR
                        </label>
                        <input
                          id="whole-window-hotkey-advanced"
                          type="text"
                          readOnly
                          value={config.wholeWindowOcrHotkey}
                          onKeyDown={(event) => {
                            const next = captureHotkey(event);
                            setConfig((current) => ({
                              ...current,
                              wholeWindowOcrHotkey: next
                            }));
                          }}
                        />
                      </div>

                      <div className="ocr-field">
                        <label
                          htmlFor="pause-hotkey-advanced"
                          className="ocr-field-label"
                        >
                          Global Pause
                        </label>
                        <input
                          id="pause-hotkey-advanced"
                          type="text"
                          readOnly
                          value={config.globalPauseHotkey}
                          onKeyDown={(event) => {
                            const next = captureHotkey(event);
                            setConfig((current) => ({
                              ...current,
                              globalPauseHotkey: next
                            }));
                          }}
                        />
                      </div>

                      <label
                        className="ocr-toggle-field"
                        htmlFor="ocr-clipboard-screenshots"
                      >
                        <span>OCR Clipboard Screenshots</span>
                        <input
                          id="ocr-clipboard-screenshots"
                          type="checkbox"
                          checked={config.ocrScreenshots}
                          onChange={(event) => {
                            setConfig((current) => ({
                              ...current,
                              ocrScreenshots: event.target.checked
                            }));
                          }}
                        />
                      </label>

                      <label
                        className="ocr-toggle-field"
                        htmlFor="ocr-send-clipboard-advanced"
                      >
                        <span>Send Text to Clipboard</span>
                        <input
                          id="ocr-send-clipboard-advanced"
                          type="checkbox"
                          checked={config.sendToClipboard}
                          onChange={(event) => {
                            setConfig((current) => ({
                              ...current,
                              sendToClipboard: event.target.checked
                            }));
                          }}
                        />
                      </label>

                      <div className="ocr-field">
                        <span className="ocr-field-label">Preserve Line Breaks</span>
                        <div className="ocr-chip-toggle-row">
                          <label className="ocr-chip-toggle" htmlFor="keep-newline-auto-adv">
                            <input
                              id="keep-newline-auto-adv"
                              type="checkbox"
                              checked={config.keepNewlineAuto}
                              onChange={(event) => {
                                setConfig((current) => ({
                                  ...current,
                                  keepNewlineAuto: event.target.checked
                                }));
                              }}
                            />
                            <span>Auto</span>
                          </label>
                          <label className="ocr-chip-toggle" htmlFor="keep-newline-menu-adv">
                            <input
                              id="keep-newline-menu-adv"
                              type="checkbox"
                              checked={config.keepNewlineMenu}
                              onChange={(event) => {
                                setConfig((current) => ({
                                  ...current,
                                  keepNewlineMenu: event.target.checked
                                }));
                              }}
                            />
                            <span>Menu</span>
                          </label>
                          <label
                            className="ocr-chip-toggle"
                            htmlFor="keep-newline-area-select-adv"
                          >
                            <input
                              id="keep-newline-area-select-adv"
                              type="checkbox"
                              checked={config.keepNewlineAreaSelect}
                              onChange={(event) => {
                                setConfig((current) => ({
                                  ...current,
                                  keepNewlineAreaSelect: event.target.checked
                                }));
                              }}
                            />
                            <span>Area Select</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="ocr-settings-panel ocr-settings-panel--comparison">
                    <div className="ocr-panel-header">
                      <h3>Text Comparison Tuning</h3>
                      <span className="ocr-panel-tag">Advanced</span>
                    </div>

                    <div className="ocr-comparison-primary-grid">
                      {COMPARISON_LAYOUT.primary.map((field) => (
                        <div key={field.key} className="ocr-field">
                          <label
                            htmlFor={`comparison-${field.key}`}
                            className="ocr-field-label"
                            title={field.title}
                          >
                            {field.label}
                          </label>
                          <input
                            id={`comparison-${field.key}`}
                            type="number"
                            min={field.min}
                            max={field.max}
                            step={field.step}
                            value={config.comparison[field.key]}
                            onChange={(event) => {
                              setComparisonValue(
                                field.key,
                                numericValue(
                                  event.target.value,
                                  COMPARISON_DEFAULTS[field.key]
                                )
                              );
                            }}
                          />
                        </div>
                      ))}
                    </div>

                    <details className="ocr-details-panel">
                      <summary>Expert Heuristics</summary>
                      <div className="ocr-comparison-expert-grid">
                        <div className="ocr-comparison-column">
                          {COMPARISON_LAYOUT.expertLeft.map((field) => (
                            <div key={field.key} className="ocr-field">
                              <label
                                htmlFor={`comparison-${field.key}`}
                                className="ocr-field-label"
                                title={field.title}
                              >
                                {field.label}
                              </label>
                              <input
                                id={`comparison-${field.key}`}
                                type="number"
                                min={field.min}
                                max={field.max}
                                step={field.step}
                                value={config.comparison[field.key]}
                                onChange={(event) => {
                                  setComparisonValue(
                                    field.key,
                                    numericValue(
                                      event.target.value,
                                      COMPARISON_DEFAULTS[field.key]
                                    )
                                  );
                                }}
                              />
                            </div>
                          ))}
                        </div>

                        <div className="ocr-comparison-column">
                          {COMPARISON_LAYOUT.expertRight.map((field) => (
                            <div key={field.key} className="ocr-field">
                              <label
                                htmlFor={`comparison-${field.key}`}
                                className="ocr-field-label"
                                title={field.title}
                              >
                                {field.label}
                              </label>
                              <input
                                id={`comparison-${field.key}`}
                                type="number"
                                min={field.min}
                                max={field.max}
                                step={field.step}
                                value={config.comparison[field.key]}
                                onChange={(event) => {
                                  setComparisonValue(
                                    field.key,
                                    numericValue(
                                      event.target.value,
                                      COMPARISON_DEFAULTS[field.key]
                                    )
                                  );
                                }}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    </details>
                  </div>
                </>
              )}
            </section>

            <section className="card legacy-card ocr-card">
              <div className="ocr-card-header-row">
                <div>
                  <h2>OCR Console</h2>
                  <p className="muted ocr-card-muted">
                    Runtime logs, selector output, and dependency install output.
                  </p>
                </div>
                <div className="ocr-console-actions">
                  <span className="ocr-console-status">
                    {runningState.isRunning
                      ? paused
                        ? "Paused"
                        : "Active"
                      : "Idle"}
                  </span>
                  <button type="button" className="secondary" onClick={clearTerminal}>
                    Clear
                  </button>
                </div>
              </div>
              <div ref={terminalElementRef} className="ocr-terminal-surface" />
            </section>

            <section className="card legacy-card ocr-card">
              <div className="ocr-card-header-row">
                <div>
                  <h2>Extra and Debug</h2>
                  <p className="muted ocr-card-muted">
                    Lower-frequency tuning, dependency helpers, and file shortcuts.
                  </p>
                </div>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setDebugExpanded((current) => !current)}
                >
                  {debugExpanded ? "Hide" : "Show"}
                </button>
              </div>

              {debugExpanded ? (
                <div className="ocr-debug-grid">
                  <label className="ocr-toggle-field" htmlFor="ignore-ocr-run-1">
                    <span>Ignore "OCR Run 1" Logs</span>
                    <input
                      id="ignore-ocr-run-1"
                      type="checkbox"
                      checked={config.ignoreOcrRun1Text}
                      onChange={(event) => {
                        setConfig((current) => ({
                          ...current,
                          ignoreOcrRun1Text: event.target.checked
                        }));
                      }}
                    />
                  </label>

                  <div className="ocr-field">
                    <label htmlFor="process-priority" className="ocr-field-label">
                      OCR Process Priority
                    </label>
                    <select
                      id="process-priority"
                      value={config.processPriority}
                      onChange={(event) => {
                        setConfig((current) => ({
                          ...current,
                          processPriority: normalizeProcessPriority(event.target.value)
                        }));
                      }}
                    >
                      {PROCESS_PRIORITY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="ocr-field">
                    <label
                      htmlFor="default-furigana-sensitivity"
                      className="ocr-field-label"
                    >
                      Default Furigana Sensitivity
                    </label>
                    <input
                      id="default-furigana-sensitivity"
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={config.defaultSceneFuriganaFilterSensitivity}
                      onChange={(event) => {
                        setConfig((current) => ({
                          ...current,
                          defaultSceneFuriganaFilterSensitivity: integerValue(
                            event.target.value,
                            0
                          )
                        }));
                      }}
                    />
                  </div>

                  <div className="ocr-field">
                    <label htmlFor="obs-preprocess" className="ocr-field-label">
                      OBS Capture Preprocess
                    </label>
                    <select
                      id="obs-preprocess"
                      value={config.obsCapturePreprocess}
                      onChange={(event) => {
                        setConfig((current) => ({
                          ...current,
                          obsCapturePreprocess: event.target.value
                        }));
                      }}
                    >
                      {PREPROCESS_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="ocr-field ocr-field--wide">
                    <label htmlFor="dep-install" className="ocr-field-label">
                      Optional Dependency Install
                    </label>
                    <div className="ocr-inline-control-row">
                      <select
                        id="dep-install"
                        value={installDependency}
                        onChange={(event) => setInstallDependency(event.target.value)}
                      >
                        {DEPENDENCY_INSTALL_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="secondary"
                        onClick={installSelectedDependency}
                      >
                        Install
                      </button>
                    </div>
                  </div>

                  <div className="ocr-field ocr-field--wide">
                    <label htmlFor="dep-remove" className="ocr-field-label">
                      Dependency Removal
                    </label>
                    <div className="ocr-inline-control-row">
                      <select
                        id="dep-remove"
                        value={removeDependency}
                        onChange={(event) => setRemoveDependency(event.target.value)}
                      >
                        {DEPENDENCY_REMOVE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="danger"
                        onClick={uninstallSelectedDependency}
                      >
                        Uninstall
                      </button>
                    </div>
                  </div>

                  <div className="ocr-action-row ocr-debug-actions">
                    <button
                      type="button"
                      className="secondary"
                      onClick={openOcrReplacementsPage}
                    >
                      Open OCR Error Fixes Page
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void invokeIpc("ocr.open-config-json")}
                    >
                      Open Config File
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void invokeIpc("ocr.open-config-folder")}
                    >
                      Open OCR Config Folder
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void invokeIpc("ocr.open-global-owocr-config")}
                    >
                      Open Global OWOCR Config
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void invokeIpc("ocr.open-temp-folder")}
                    >
                      Open Temp Folder
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          </div>
        </div>

        <div className={`ocr-footer-bar ocr-footer-bar--${footerTone}`}>
          <div className="ocr-footer-summary">
            <span className={`ocr-footer-status ocr-footer-status--${footerTone}`}>
              {footerStatusLabel}
            </span>
            <div className="ocr-footer-copy">
              <div className="ocr-footer-title">
                {runningState.isRunning
                  ? runtimeEngine || "OCR Runtime"
                  : "Ready to Run"}
              </div>
              <div className="ocr-footer-text">{footerSummary}</div>
            </div>
          </div>

          <div className="ocr-footer-actions">
            {runningState.isRunning ? (
              <>
                <button type="button" className="danger" onClick={() => void stopOcr()}>
                  Stop OCR
                </button>
                <button type="button" className="secondary" onClick={togglePause}>
                  {paused ? "Resume OCR" : "Pause OCR"}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={!hasConfiguredAreas}
                  onClick={() => void startOcr(false)}
                >
                  Start Auto OCR
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!hasConfiguredAreas}
                  onClick={() => void startOcr(true)}
                >
                  Start Manual OCR
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
