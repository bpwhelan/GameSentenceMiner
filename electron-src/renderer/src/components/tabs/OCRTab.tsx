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

const OCR_TOOLTIPS = {
  scene:
    "Choose which OBS scene GSM should use when loading OCR areas. Each scene can have its own rectangles and furigana sensitivity.",
  refreshScenes:
    "Reload the OBS scene list and re-read the active scene's OCR area file. Use this after changing scenes or editing OCR areas outside this tab.",
  selectAreas:
    "Open the OCR area selector for the current scene. This is where you draw the rectangles GSM should scan.",
  importAreas:
    "Replace the current scene's OCR rectangles with JSON from your clipboard. Only the area layout is imported.",
  exportAreas:
    "Copy the current scene's OCR rectangles to your clipboard so you can back them up or paste them into another scene.",
  docs:
    "Open the OCR guide documentation for setup help, engine notes, and recommended workflows.",
  advancedMode:
    "Show engine selection and comparison tuning. Basic mode keeps the common settings visible and hides the expert knobs.",
  basicScanRate:
    "How quickly GSM should re-scan for new text in the normal simplified setup. Faster catches short lines sooner but uses more CPU.",
  advancedScanRate:
    "Exact OCR polling interval in seconds while auto OCR is running. Lower values scan more often and increase CPU use.",
  language:
    "Primary language script expected in the captured text. This affects OCR filtering, post-processing, and some engine behavior.",
  baseScale:
    "Scale the captured image before OCR. Higher values can improve accuracy on small text, but they cost more CPU and VRAM.",
  furiganaFilter:
    "Filter out small ruby or furigana text from OCR results. Raise this when furigana leaks into lines; lower it if main text disappears.",
  furiganaPreview:
    "Open the furigana preview helper so you can tune the sensitivity against a sample character before saving it.",
  sendToClipboard:
    "Copy finalized OCR text to the system clipboard each time GSM accepts a line.",
  keepNewlineAuto:
    "Keep line breaks for normal automatic OCR results instead of flattening them into one line.",
  keepNewlineMenu:
    "Keep line breaks for menu or secondary-rectangle OCR results.",
  keepNewlineAreaSelect:
    "Keep line breaks for manual area-select OCR captures.",
  twoPassOCR:
    "Use a fast first OCR engine for change detection and a second engine for the final text. Turn this off if you want one engine only.",
  stabilityOcr:
    "The first-pass engine used to detect stable text and decide when a line is ready for the final scan.",
  mainOcr:
    "The engine used for the final OCR text that gets sent to GSM after filtering and dedupe.",
  optimizeSecondScan:
    "Crop the second OCR pass down to the detected text region when possible. This is usually faster and can improve accuracy.",
  ocrScreenshots:
    "Also watch clipboard screenshots as an OCR input source. This is useful if you copy images directly instead of relying only on OBS capture.",
  manualHotkey:
    "Hotkey used for menu OCR in auto mode, or manual capture in manual mode. Press Escape in the field to clear it.",
  areaSelectHotkey:
    "Hotkey that opens the manual screen crop OCR flow. Press Escape in the field to disable it.",
  wholeWindowHotkey:
    "Hotkey for a one-shot OCR pass over the full game window or OBS source. Press Escape in the field to disable it.",
  pauseHotkey:
    "Global OCR pause or resume hotkey. This toggles background scanning without stopping the OCR process.",
  processPriority:
    "Windows process priority for the OCR worker. Higher priorities can reduce OCR lag, but they steal CPU time from the game and the rest of the app.",
  defaultSceneFurigana:
    "Fallback furigana sensitivity used when a scene does not have its own saved value yet.",
  obsCapturePreprocess:
    "Optional preprocessing applied to OBS captures before OCR. Use this only if a source benefits from grayscale or sharpening.",
  ignoreRun1Logs:
    'Hide the noisy "OCR Run 1" recognition logs from the console so the final OCR lines are easier to scan.',
  installDependency:
    "Install optional OCR dependencies into the GSM Python environment. Use this when enabling engines that need extra packages.",
  uninstallDependency:
    "Remove optional OCR dependencies from the GSM Python environment.",
  replacements:
    "Open the OCR replacement rules page for fixing recurring OCR mistakes after text is recognized.",
  openConfigFile:
    "Open the active Electron OCR config JSON file.",
  openConfigFolder:
    "Open the OCR config folder that stores per-scene area files.",
  openGlobalConfig:
    "Open the global OWOCR config used by the OCR engines themselves.",
  openTempFolder:
    "Open GSM's temp folder where recent OCR artifacts and helper files are written.",
  clearConsole:
    "Clear the OCR console output shown in this tab.",
  startAuto:
    "Start continuous OCR scanning for the selected scene's rectangles. GSM will keep polling and send lines automatically.",
  startManual:
    "Start manual OCR mode. GSM waits for your manual capture hotkeys instead of scanning continuously.",
  stop:
    "Stop the active OCR process completely.",
  pause:
    "Pause automatic OCR scanning without closing the OCR process.",
  resume:
    "Resume OCR scanning after it has been paused.",
  advancedRecognition:
    "Engine, scan, and capture settings that control how OCR runs while advanced mode is enabled.",
  comparison:
    "Dedupe and change-detection thresholds that decide when text is considered new, stable, or a subset of a previous line."
} as const;

function titleProps(title: string) {
  return { title };
}

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
      <div className="modern-tab ocr-workspace">
        <div className="legacy-grid ocr-main-grid">
            <section
              className={`card legacy-card ocr-card ocr-runtime-card ocr-runtime-card--${footerTone}`}
            >
              <div className="ocr-card-header-row">
                <div>
                  <h2>OCR Runtime</h2>
                  <p className="muted ocr-card-muted">
                    Scene setup and OCR area tools live here. Runtime transport stays pinned
                    at the bottom while you work.
                  </p>
                </div>
              </div>

              <div className="ocr-runtime-grid">
                <div className="ocr-runtime-summary">
                  <strong className="ocr-runtime-summary-title">{sceneSummary}</strong>
                  <p className="muted ocr-runtime-summary-copy">
                    {configuredAreaCount} {configuredAreaCount === 1 ? "OCR area" : "OCR areas"}{" "}
                    configured. {scanSummary}.{" "}
                    {config.advancedMode
                      ? `Advanced flow: ${engineFlowLabel}.`
                      : "Basic OCR mode is enabled."}
                  </p>
                </div>

                <div className="form-group ocr-form-group">
                  <div className="input-group wrap">
                    <label htmlFor="ocr-scene-select" {...titleProps(OCR_TOOLTIPS.scene)}>
                      OBS Scene:
                    </label>
                    <select
                      id="ocr-scene-select"
                      value={selectedSceneId}
                      {...titleProps(OCR_TOOLTIPS.scene)}
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
                      {...titleProps(OCR_TOOLTIPS.refreshScenes)}
                      onClick={() => {
                        void refreshScenesAndConfig();
                      }}
                    >
                      Reload Scenes
                    </button>
                  </div>

                  <div className="link-row">
                    <button
                      type="button"
                      {...titleProps(OCR_TOOLTIPS.selectAreas)}
                      onClick={runScreenSelector}
                    >
                      Select OCR Areas
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      {...titleProps(OCR_TOOLTIPS.importAreas)}
                      onClick={() => void importAreaConfig()}
                    >
                      Import Areas
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      {...titleProps(OCR_TOOLTIPS.exportAreas)}
                      onClick={() => void exportAreaConfig()}
                    >
                      Export Areas
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      {...titleProps(OCR_TOOLTIPS.docs)}
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
                    Core OCR behavior first, with expert controls tucked behind advanced
                    panels.
                  </p>
                </div>
                <label
                  className="ocr-inline-toggle"
                  htmlFor="ocr-advanced-toggle"
                  {...titleProps(OCR_TOOLTIPS.advancedMode)}
                >
                  <span>Advanced</span>
                  <input
                    id="ocr-advanced-toggle"
                    type="checkbox"
                    checked={config.advancedMode}
                    {...titleProps(OCR_TOOLTIPS.advancedMode)}
                    onChange={(event) => {
                      setConfig((current) => ({
                        ...current,
                        advancedMode: event.target.checked
                      }));
                    }}
                  />
                </label>
              </div>

              <div className="form-group ocr-form-group">
                {config.advancedMode ? (
                  <div className="input-group">
                    <label
                      htmlFor="ocr-advanced-scan-rate"
                      {...titleProps(OCR_TOOLTIPS.advancedScanRate)}
                    >
                      Scan Rate (s):
                    </label>
                    <input
                      id="ocr-advanced-scan-rate"
                      type="number"
                      min={0.1}
                      max={10}
                      step={0.1}
                      value={config.advancedScanRate}
                      {...titleProps(OCR_TOOLTIPS.advancedScanRate)}
                      onChange={(event) => {
                        setConfig((current) => ({
                          ...current,
                          advancedScanRate: numericValue(event.target.value, 0.5)
                        }));
                      }}
                    />
                  </div>
                ) : (
                  <div className="input-group">
                    <label
                      htmlFor="ocr-basic-speed"
                      {...titleProps(OCR_TOOLTIPS.basicScanRate)}
                    >
                      Text Speed:
                    </label>
                    <select
                      id="ocr-basic-speed"
                      value={String(config.basicScanRate)}
                      {...titleProps(OCR_TOOLTIPS.basicScanRate)}
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
                )}

                <div className="input-group">
                  <label htmlFor="ocr-language" {...titleProps(OCR_TOOLTIPS.language)}>
                    Language:
                  </label>
                  <select
                    id="ocr-language"
                    value={config.language}
                    {...titleProps(OCR_TOOLTIPS.language)}
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

                <div className="ocr-slider-field">
                  <div className="ocr-slider-header">
                    <label
                      htmlFor="ocr-base-scale"
                      {...titleProps(OCR_TOOLTIPS.baseScale)}
                    >
                      Scan Image Quality
                    </label>
                    <span>{Math.round(config.baseScale * 100)}%</span>
                  </div>
                  <input
                    id="ocr-base-scale"
                    type="range"
                    min={0.5}
                    max={1}
                    step={0.05}
                    value={config.baseScale}
                    {...titleProps(OCR_TOOLTIPS.baseScale)}
                    onChange={(event) => {
                      setConfig((current) => ({
                        ...current,
                        baseScale: numericValue(event.target.value, 0.75)
                      }));
                    }}
                  />
                </div>

                <div className="ocr-slider-field">
                  <div className="ocr-slider-header">
                    <label
                      htmlFor="ocr-furigana-filter"
                      {...titleProps(OCR_TOOLTIPS.furiganaFilter)}
                    >
                      Furigana Filter
                    </label>
                    <span>{config.furiganaFilterSensitivity}</span>
                  </div>
                  <div className="ocr-slider-row">
                    <input
                      id="ocr-furigana-filter"
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={config.furiganaFilterSensitivity}
                      {...titleProps(OCR_TOOLTIPS.furiganaFilter)}
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
                      {...titleProps(OCR_TOOLTIPS.furiganaPreview)}
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

                <div className="input-group">
                  <label
                    htmlFor="ocr-send-clipboard"
                    {...titleProps(OCR_TOOLTIPS.sendToClipboard)}
                  >
                    Send Text to Clipboard:
                  </label>
                  <input
                    id="ocr-send-clipboard"
                    type="checkbox"
                    checked={config.sendToClipboard}
                    {...titleProps(OCR_TOOLTIPS.sendToClipboard)}
                    onChange={(event) => {
                      setConfig((current) => ({
                        ...current,
                        sendToClipboard: event.target.checked
                      }));
                    }}
                  />
                </div>
              </div>

              <div className="ocr-subsection">
                <div className="ocr-subsection-header">Preserve Line Breaks</div>
                <p className="muted ocr-subsection-copy">
                  Control whether each OCR source keeps embedded line breaks instead of
                  flattening text into one line.
                </p>
                <div className="checkbox-grid ocr-checkbox-grid">
                  <label className="checkbox-item" htmlFor="keep-newline-auto">
                    <input
                      id="keep-newline-auto"
                      type="checkbox"
                      checked={config.keepNewlineAuto}
                      {...titleProps(OCR_TOOLTIPS.keepNewlineAuto)}
                      onChange={(event) => {
                        setConfig((current) => ({
                          ...current,
                          keepNewlineAuto: event.target.checked
                        }));
                      }}
                    />
                    <span {...titleProps(OCR_TOOLTIPS.keepNewlineAuto)}>Auto OCR</span>
                  </label>
                  <label className="checkbox-item" htmlFor="keep-newline-menu">
                    <input
                      id="keep-newline-menu"
                      type="checkbox"
                      checked={config.keepNewlineMenu}
                      {...titleProps(OCR_TOOLTIPS.keepNewlineMenu)}
                      onChange={(event) => {
                        setConfig((current) => ({
                          ...current,
                          keepNewlineMenu: event.target.checked
                        }));
                      }}
                    />
                    <span {...titleProps(OCR_TOOLTIPS.keepNewlineMenu)}>Menu OCR</span>
                  </label>
                  <label className="checkbox-item" htmlFor="keep-newline-area-select">
                    <input
                      id="keep-newline-area-select"
                      type="checkbox"
                      checked={config.keepNewlineAreaSelect}
                      {...titleProps(OCR_TOOLTIPS.keepNewlineAreaSelect)}
                      onChange={(event) => {
                        setConfig((current) => ({
                          ...current,
                          keepNewlineAreaSelect: event.target.checked
                        }));
                      }}
                    />
                    <span {...titleProps(OCR_TOOLTIPS.keepNewlineAreaSelect)}>
                      Area Select
                    </span>
                  </label>
                </div>
              </div>

              {config.advancedMode ? (
                <>
                  <details className="ocr-details-card">
                    <summary {...titleProps(OCR_TOOLTIPS.advancedRecognition)}>
                      Recognition Pipeline
                    </summary>
                    <div className="form-group ocr-form-group ocr-details-body">
                      <div className="input-group">
                        <label htmlFor="ocr-main-engine" {...titleProps(OCR_TOOLTIPS.mainOcr)}>
                          Main OCR:
                        </label>
                        <select
                          id="ocr-main-engine"
                          value={config.mainOcr}
                          {...titleProps(OCR_TOOLTIPS.mainOcr)}
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

                      <div className="input-group">
                        <label
                          htmlFor="ocr-stability-engine"
                          {...titleProps(OCR_TOOLTIPS.stabilityOcr)}
                        >
                          Stability OCR:
                        </label>
                        <select
                          id="ocr-stability-engine"
                          value={config.stabilityOcr}
                          {...titleProps(OCR_TOOLTIPS.stabilityOcr)}
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

                      <div className="input-group">
                        <label htmlFor="ocr-two-pass" {...titleProps(OCR_TOOLTIPS.twoPassOCR)}>
                          Two-pass OCR:
                        </label>
                        <input
                          id="ocr-two-pass"
                          type="checkbox"
                          checked={config.twoPassOCR}
                          {...titleProps(OCR_TOOLTIPS.twoPassOCR)}
                          onChange={(event) => {
                            setConfig((current) => ({
                              ...current,
                              twoPassOCR: event.target.checked
                            }));
                          }}
                        />
                      </div>

                      <div className="input-group">
                        <label
                          htmlFor="ocr-optimize-second-scan"
                          {...titleProps(OCR_TOOLTIPS.optimizeSecondScan)}
                        >
                          Optimize Second Scan:
                        </label>
                        <input
                          id="ocr-optimize-second-scan"
                          type="checkbox"
                          checked={config.optimizeSecondScan}
                          {...titleProps(OCR_TOOLTIPS.optimizeSecondScan)}
                          onChange={(event) => {
                            setConfig((current) => ({
                              ...current,
                              optimizeSecondScan: event.target.checked
                            }));
                          }}
                        />
                      </div>

                      <div className="input-group">
                        <label
                          htmlFor="ocr-clipboard-screenshots"
                          {...titleProps(OCR_TOOLTIPS.ocrScreenshots)}
                        >
                          OCR Clipboard Screenshots:
                        </label>
                        <input
                          id="ocr-clipboard-screenshots"
                          type="checkbox"
                          checked={config.ocrScreenshots}
                          {...titleProps(OCR_TOOLTIPS.ocrScreenshots)}
                          onChange={(event) => {
                            setConfig((current) => ({
                              ...current,
                              ocrScreenshots: event.target.checked
                            }));
                          }}
                        />
                      </div>
                    </div>
                  </details>

                  <details className="ocr-details-card">
                    <summary {...titleProps(OCR_TOOLTIPS.comparison)}>
                      Text Comparison Tuning
                    </summary>
                    <div className="ocr-comparison-primary-grid ocr-details-body">
                      {COMPARISON_LAYOUT.primary.map((field) => (
                        <div key={field.key} className="ocr-comparison-field">
                          <label
                            htmlFor={`comparison-${field.key}`}
                            {...titleProps(field.title)}
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
                            {...titleProps(field.title)}
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

                    <details className="ocr-details-card ocr-details-card--nested">
                      <summary>Expert Heuristics</summary>
                      <div className="ocr-comparison-expert-grid ocr-details-body">
                        <div className="ocr-comparison-column">
                          {COMPARISON_LAYOUT.expertLeft.map((field) => (
                            <div key={field.key} className="ocr-comparison-field">
                              <label
                                htmlFor={`comparison-${field.key}`}
                                {...titleProps(field.title)}
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
                                {...titleProps(field.title)}
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
                            <div key={field.key} className="ocr-comparison-field">
                              <label
                                htmlFor={`comparison-${field.key}`}
                                {...titleProps(field.title)}
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
                                {...titleProps(field.title)}
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
                  </details>
                </>
              ) : null}
            </section>
            <section className="card legacy-card ocr-card">
              <div className="ocr-card-header-row">
                <div>
                  <h2>Hotkeys and Tools</h2>
                  <p className="muted ocr-card-muted">
                    Capture hotkeys stay editable while OCR is running. Press Escape in a
                    hotkey field to clear it.
                  </p>
                </div>
              </div>

              <div className="form-group ocr-form-group">
                <div className="input-group">
                  <label htmlFor="manual-hotkey" {...titleProps(OCR_TOOLTIPS.manualHotkey)}>
                    Manual or Menu OCR:
                  </label>
                  <input
                    id="manual-hotkey"
                    type="text"
                    readOnly
                    value={config.manualOcrHotkey}
                    {...titleProps(OCR_TOOLTIPS.manualHotkey)}
                    onKeyDown={(event) => {
                      const next = captureHotkey(event);
                      setConfig((current) => ({
                        ...current,
                        manualOcrHotkey: next
                      }));
                    }}
                  />
                </div>

                <div className="input-group">
                  <label htmlFor="area-hotkey" {...titleProps(OCR_TOOLTIPS.areaSelectHotkey)}>
                    Area Select OCR:
                  </label>
                  <input
                    id="area-hotkey"
                    type="text"
                    readOnly
                    value={config.areaSelectOcrHotkey}
                    {...titleProps(OCR_TOOLTIPS.areaSelectHotkey)}
                    onKeyDown={(event) => {
                      const next = captureHotkey(event);
                      setConfig((current) => ({
                        ...current,
                        areaSelectOcrHotkey: next
                      }));
                    }}
                  />
                </div>

                <div className="input-group">
                  <label
                    htmlFor="whole-window-hotkey"
                    {...titleProps(OCR_TOOLTIPS.wholeWindowHotkey)}
                  >
                    Whole Window OCR:
                  </label>
                  <input
                    id="whole-window-hotkey"
                    type="text"
                    readOnly
                    value={config.wholeWindowOcrHotkey}
                    {...titleProps(OCR_TOOLTIPS.wholeWindowHotkey)}
                    onKeyDown={(event) => {
                      const next = captureHotkey(event);
                      setConfig((current) => ({
                        ...current,
                        wholeWindowOcrHotkey: next
                      }));
                    }}
                  />
                </div>

                <div className="input-group">
                  <label htmlFor="pause-hotkey" {...titleProps(OCR_TOOLTIPS.pauseHotkey)}>
                    Global Pause:
                  </label>
                  <input
                    id="pause-hotkey"
                    type="text"
                    readOnly
                    value={config.globalPauseHotkey}
                    {...titleProps(OCR_TOOLTIPS.pauseHotkey)}
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

              <div className="ocr-card-divider" />

              <div className="ocr-card-header-row ocr-card-header-row--compact">
                <div>
                  <h3>Extra and Debug</h3>
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
                <div className="form-group ocr-form-group">
                  <div className="input-group">
                    <label
                      htmlFor="ignore-ocr-run-1"
                      {...titleProps(OCR_TOOLTIPS.ignoreRun1Logs)}
                    >
                      Ignore "OCR Run 1" Logs:
                    </label>
                    <input
                      id="ignore-ocr-run-1"
                      type="checkbox"
                      checked={config.ignoreOcrRun1Text}
                      {...titleProps(OCR_TOOLTIPS.ignoreRun1Logs)}
                      onChange={(event) => {
                        setConfig((current) => ({
                          ...current,
                          ignoreOcrRun1Text: event.target.checked
                        }));
                      }}
                    />
                  </div>

                  <div className="input-group">
                    <label
                      htmlFor="process-priority"
                      {...titleProps(OCR_TOOLTIPS.processPriority)}
                    >
                      OCR Process Priority:
                    </label>
                    <select
                      id="process-priority"
                      value={config.processPriority}
                      {...titleProps(OCR_TOOLTIPS.processPriority)}
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

                  <div className="input-group">
                    <label
                      htmlFor="default-furigana-sensitivity"
                      {...titleProps(OCR_TOOLTIPS.defaultSceneFurigana)}
                    >
                      Default Furigana Sensitivity:
                    </label>
                    <input
                      id="default-furigana-sensitivity"
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={config.defaultSceneFuriganaFilterSensitivity}
                      {...titleProps(OCR_TOOLTIPS.defaultSceneFurigana)}
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

                  <div className="input-group">
                    <label
                      htmlFor="obs-preprocess"
                      {...titleProps(OCR_TOOLTIPS.obsCapturePreprocess)}
                    >
                      OBS Capture Preprocess:
                    </label>
                    <select
                      id="obs-preprocess"
                      value={config.obsCapturePreprocess}
                      {...titleProps(OCR_TOOLTIPS.obsCapturePreprocess)}
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

                  <div className="input-group wrap">
                    <label htmlFor="dep-install" {...titleProps(OCR_TOOLTIPS.installDependency)}>
                      Optional Dependency Install:
                    </label>
                    <select
                      id="dep-install"
                      value={installDependency}
                      {...titleProps(OCR_TOOLTIPS.installDependency)}
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
                      {...titleProps(OCR_TOOLTIPS.installDependency)}
                      onClick={installSelectedDependency}
                    >
                      Install
                    </button>
                  </div>

                  <div className="input-group wrap">
                    <label
                      htmlFor="dep-remove"
                      {...titleProps(OCR_TOOLTIPS.uninstallDependency)}
                    >
                      Dependency Removal:
                    </label>
                    <select
                      id="dep-remove"
                      value={removeDependency}
                      {...titleProps(OCR_TOOLTIPS.uninstallDependency)}
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
                      {...titleProps(OCR_TOOLTIPS.uninstallDependency)}
                      onClick={uninstallSelectedDependency}
                    >
                      Uninstall
                    </button>
                  </div>

                  <div className="link-row">
                    <button
                      type="button"
                      className="secondary"
                      {...titleProps(OCR_TOOLTIPS.replacements)}
                      onClick={openOcrReplacementsPage}
                    >
                      OCR Error Fixes
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      {...titleProps(OCR_TOOLTIPS.openConfigFile)}
                      onClick={() => void invokeIpc("ocr.open-config-json")}
                    >
                      Open Config File
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      {...titleProps(OCR_TOOLTIPS.openConfigFolder)}
                      onClick={() => void invokeIpc("ocr.open-config-folder")}
                    >
                      Open OCR Config Folder
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      {...titleProps(OCR_TOOLTIPS.openGlobalConfig)}
                      onClick={() => void invokeIpc("ocr.open-global-owocr-config")}
                    >
                      Open Global OWOCR Config
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      {...titleProps(OCR_TOOLTIPS.openTempFolder)}
                      onClick={() => void invokeIpc("ocr.open-temp-folder")}
                    >
                      Open Temp Folder
                    </button>
                  </div>
                </div>
              ) : null}
            </section>

            <section className="card legacy-card ocr-card ocr-card--full">
              <div className="ocr-card-header-row">
                <div>
                  <h2>OCR Console</h2>
                  <p className="muted ocr-card-muted">
                    Runtime logs, selector output, and dependency install output.
                  </p>
                </div>
                <div className="ocr-console-actions">
                  <span className="ocr-console-status">
                    {runningState.isRunning ? (paused ? "Paused" : "Active") : "Idle"}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    {...titleProps(OCR_TOOLTIPS.clearConsole)}
                    onClick={clearTerminal}
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div ref={terminalElementRef} className="ocr-terminal-surface" />
            </section>
          </div>
          <div className={`ocr-sticky-footer ocr-sticky-footer--${footerTone}`}>
            <div className="ocr-sticky-footer-status">
              <span className={`ocr-runtime-badge ocr-runtime-badge--${footerTone}`}>
                {footerStatusLabel}
              </span>
              <div className="ocr-sticky-footer-copy">
                <strong>{runningState.isRunning ? runtimeEngine || "OCR Runtime" : sceneSummary}</strong>
                <p className="muted">{footerSummary}</p>
              </div>
            </div>
            <div className="ocr-sticky-footer-actions">
              {runningState.isRunning ? (
                <>
                  <button
                    type="button"
                    className="danger"
                    {...titleProps(OCR_TOOLTIPS.stop)}
                    onClick={() => void stopOcr()}
                  >
                    Stop OCR
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    {...titleProps(paused ? OCR_TOOLTIPS.resume : OCR_TOOLTIPS.pause)}
                    onClick={togglePause}
                  >
                    {paused ? "Resume OCR" : "Pause OCR"}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={!hasConfiguredAreas}
                    title={
                      hasConfiguredAreas
                        ? OCR_TOOLTIPS.startAuto
                        : "Draw OCR areas for this scene before starting auto OCR."
                    }
                    onClick={() => void startOcr(false)}
                  >
                    Start Auto OCR
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={!hasConfiguredAreas}
                    title={
                      hasConfiguredAreas
                        ? OCR_TOOLTIPS.startManual
                        : "Draw OCR areas for this scene before starting manual OCR."
                    }
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
