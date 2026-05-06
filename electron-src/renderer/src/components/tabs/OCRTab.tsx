import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { DOCS_URLS } from "../../../../shared/docs";
import { invokeIpc, onIpc, platformFromEnv, sendIpc } from "../../lib/ipc";
import type { ObsScene } from "../../types/models";
import { useTranslation } from "../../i18n";

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
  send_to_clipboard_auto?: boolean | null;
  send_to_clipboard_menu?: boolean | null;
  send_to_clipboard_area_select?: boolean | null;
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
  sendToClipboardAuto: boolean;
  sendToClipboardMenu: boolean;
  sendToClipboardAreaSelect: boolean;
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
  labelKey: string;
  titleKey: string;
  min: number;
  max: number;
  step: number;
}

interface TerminalRepeatState {
  dedupeKey: string;
  count: number;
  baseMessage: string;
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
    labelKey: "ocr.comparison.duplicateThreshold.label",
    titleKey: "ocr.comparison.duplicateThreshold.title",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "change_detection_threshold",
    labelKey: "ocr.comparison.changeThreshold.label",
    titleKey: "ocr.comparison.changeThreshold.title",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "evolving_prefix_similarity_threshold",
    labelKey: "ocr.comparison.evolvingPrefix.label",
    titleKey: "ocr.comparison.evolvingPrefix.title",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "truncation_compare_threshold_min",
    labelKey: "ocr.comparison.truncationFallbackMin.label",
    titleKey: "ocr.comparison.truncationFallbackMin.title",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "truncation_strict_threshold_min",
    labelKey: "ocr.comparison.truncationStrictMin.label",
    titleKey: "ocr.comparison.truncationStrictMin.title",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "truncation_similarity_margin",
    labelKey: "ocr.comparison.truncationMargin.label",
    titleKey: "ocr.comparison.truncationMargin.title",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "truncation_min_length",
    labelKey: "ocr.comparison.truncationMinLength.label",
    titleKey: "ocr.comparison.truncationMinLength.title",
    min: 1,
    max: 1000,
    step: 1
  },
  {
    key: "truncation_min_ratio_percent",
    labelKey: "ocr.comparison.truncationMinRatio.label",
    titleKey: "ocr.comparison.truncationMinRatio.title",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "subset_chunk_min_length",
    labelKey: "ocr.comparison.subsetChunkMinLength.label",
    titleKey: "ocr.comparison.subsetChunkMinLength.title",
    min: 1,
    max: 1000,
    step: 1
  },
  {
    key: "matching_block_short_chunk_char_limit",
    labelKey: "ocr.comparison.shortChunkLimit.label",
    titleKey: "ocr.comparison.shortChunkLimit.title",
    min: 1,
    max: 1000,
    step: 1
  },
  {
    key: "matching_block_small_chunk_min_size",
    labelKey: "ocr.comparison.shortChunkMinSize.label",
    titleKey: "ocr.comparison.shortChunkMinSize.title",
    min: 1,
    max: 1000,
    step: 1
  },
  {
    key: "matching_block_default_min_size",
    labelKey: "ocr.comparison.defaultMinSize.label",
    titleKey: "ocr.comparison.defaultMinSize.title",
    min: 1,
    max: 1000,
    step: 1
  },
  {
    key: "subset_coverage_floor_percent",
    labelKey: "ocr.comparison.coverageFloor.label",
    titleKey: "ocr.comparison.coverageFloor.title",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "subset_coverage_ceiling_percent",
    labelKey: "ocr.comparison.coverageCeiling.label",
    titleKey: "ocr.comparison.coverageCeiling.title",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "subset_coverage_threshold_offset",
    labelKey: "ocr.comparison.coverageOffset.label",
    titleKey: "ocr.comparison.coverageOffset.title",
    min: 0,
    max: 100,
    step: 1
  },
  {
    key: "subset_longest_block_min_chars",
    labelKey: "ocr.comparison.longestBlockMin.label",
    titleKey: "ocr.comparison.longestBlockMin.title",
    min: 1,
    max: 1000,
    step: 1
  },
  {
    key: "subset_longest_block_divisor",
    labelKey: "ocr.comparison.longestBlockDivisor.label",
    titleKey: "ocr.comparison.longestBlockDivisor.title",
    min: 1,
    max: 1000,
    step: 1
  }
];

const MENU_ONLY_LOG_MESSAGE =
  "Text is identified as all menu items, skipping further processing.";
const MENU_ONLY_CONSOLE_MESSAGE = "\x1b[33mSkipped OCR result: detected only menu text\x1b[0m";
const ANSI_RESET = "\x1b[0m";

function formatRepeatedTerminalLine(message: string, count: number): string {
  if (count <= 1) {
    return message;
  }

  if (message.endsWith(ANSI_RESET)) {
    return `${message.slice(0, -ANSI_RESET.length)} x${count}${ANSI_RESET}`;
  }

  return `${message} x${count}`;
}

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

function sendToClipboardEnabled(
  config: OcrStoredConfig | null | undefined,
  key:
    | "send_to_clipboard_auto"
    | "send_to_clipboard_menu"
    | "send_to_clipboard_area_select"
): boolean {
  const explicitValue = config?.[key];
  if (typeof explicitValue === "boolean") {
    return explicitValue;
  }

  if (config?.sendToClipboard === true) {
    return true;
  }

  return key === "send_to_clipboard_area_select";
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
    sendToClipboardAuto: sendToClipboardEnabled(value, "send_to_clipboard_auto"),
    sendToClipboardMenu: sendToClipboardEnabled(value, "send_to_clipboard_menu"),
    sendToClipboardAreaSelect: sendToClipboardEnabled(
      value,
      "send_to_clipboard_area_select"
    ),
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
    sendToClipboard:
      config.sendToClipboardAuto ||
      config.sendToClipboardMenu ||
      config.sendToClipboardAreaSelect,
    send_to_clipboard_auto: config.sendToClipboardAuto,
    send_to_clipboard_menu: config.sendToClipboardMenu,
    send_to_clipboard_area_select: config.sendToClipboardAreaSelect,
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

const OCR_TOOLTIP_KEYS = {
  scene: "ocr.tooltips.scene",
  refreshScenes: "ocr.tooltips.refreshScenes",
  selectAreas: "ocr.tooltips.selectAreas",
  importAreas: "ocr.tooltips.importAreas",
  exportAreas: "ocr.tooltips.exportAreas",
  docs: "ocr.tooltips.docs",
  advancedMode: "ocr.tooltips.advancedMode",
  basicScanRate: "ocr.tooltips.basicScanRate",
  advancedScanRate: "ocr.tooltips.advancedScanRate",
  language: "ocr.tooltips.language",
  baseScale: "ocr.tooltips.baseScale",
  furiganaFilter: "ocr.tooltips.furiganaFilter",
  furiganaPreview: "ocr.tooltips.furiganaPreview",
  sendToClipboard: "ocr.tooltips.sendToClipboard",
  sendToClipboardAuto: "ocr.tooltips.sendToClipboardAuto",
  sendToClipboardMenu: "ocr.tooltips.sendToClipboardMenu",
  sendToClipboardAreaSelect: "ocr.tooltips.sendToClipboardAreaSelect",
  keepNewline: "ocr.tooltips.keepNewline",
  keepNewlineAuto: "ocr.tooltips.keepNewlineAuto",
  keepNewlineMenu: "ocr.tooltips.keepNewlineMenu",
  keepNewlineAreaSelect: "ocr.tooltips.keepNewlineAreaSelect",
  twoPassOCR: "ocr.tooltips.twoPassOCR",
  stabilityOcr: "ocr.tooltips.stabilityOcr",
  mainOcr: "ocr.tooltips.mainOcr",
  optimizeSecondScan: "ocr.tooltips.optimizeSecondScan",
  ocrScreenshots: "ocr.tooltips.ocrScreenshots",
  manualHotkey: "ocr.tooltips.manualHotkey",
  areaSelectHotkey: "ocr.tooltips.areaSelectHotkey",
  wholeWindowHotkey: "ocr.tooltips.wholeWindowHotkey",
  pauseHotkey: "ocr.tooltips.pauseHotkey",
  processPriority: "ocr.tooltips.processPriority",
  defaultSceneFurigana: "ocr.tooltips.defaultSceneFurigana",
  obsCapturePreprocess: "ocr.tooltips.obsCapturePreprocess",
  ignoreRun1Logs: "ocr.tooltips.ignoreRun1Logs",
  installDependency: "ocr.tooltips.installDependency",
  uninstallDependency: "ocr.tooltips.uninstallDependency",
  replacements: "ocr.tooltips.replacements",
  openConfigFile: "ocr.tooltips.openConfigFile",
  openConfigFolder: "ocr.tooltips.openConfigFolder",
  openGlobalConfig: "ocr.tooltips.openGlobalConfig",
  openTempFolder: "ocr.tooltips.openTempFolder",
  clearConsole: "ocr.tooltips.clearConsole",
  startAuto: "ocr.tooltips.startAuto",
  startManual: "ocr.tooltips.startManual",
  stop: "ocr.tooltips.stop",
  pause: "ocr.tooltips.pause",
  resume: "ocr.tooltips.resume",
  advancedRecognition: "ocr.tooltips.advancedRecognition",
  comparison: "ocr.tooltips.comparison"
} as const;

type TipAlignment = "start" | "center";

/* ── Custom instant tooltip ── */
function Tip({
  text,
  align = "start",
  children
}: {
  text: string;
  align?: TipAlignment;
  children: React.ReactNode;
}) {
  return (
    <span className={`ocr-tip-wrap ocr-tip-wrap--${align}`} data-tip={text}>
      {children}
    </span>
  );
}

function titleProps(text: string) {
  return { "data-tip": text } as const;
}

export function OCRTab({ active }: OcrTabProps) {
  const t = useTranslation();
  const ocrTooltips = useMemo(() => {
    const localized = {} as Record<keyof typeof OCR_TOOLTIP_KEYS, string>;
    for (const key of Object.keys(OCR_TOOLTIP_KEYS) as Array<
      keyof typeof OCR_TOOLTIP_KEYS
    >) {
      localized[key] = t(OCR_TOOLTIP_KEYS[key]);
    }
    return localized;
  }, [t]);
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
  const repeatedTerminalLineRef = useRef<TerminalRepeatState | null>(null);

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
      ? t("ocr.footer.paused")
      : t("ocr.footer.running")
    : hasConfiguredAreas
      ? t("ocr.footer.ready")
      : t("ocr.footer.needsAreas");

  const footerSummary = runningState.isRunning
    ? runtimeMessage
    : hasConfiguredAreas
      ? (configuredAreaCount === 1
          ? t("ocr.sceneAndAreas.areaCount", { count: String(configuredAreaCount) })
          : t("ocr.sceneAndAreas.areaCountPlural", { count: String(configuredAreaCount) }))
      : t("ocr.footer.noAreasForScene", { scene: selectedScene?.name ?? t("ocr.footer.noSceneSelected") });

  const sceneSummary = selectedScene?.name ?? t("ocr.footer.noSceneSelected");
  const scanSummary = config.advancedMode
    ? `${effectiveScanRate.toFixed(1)}s`
    : basicSpeedLabel(config.basicScanRate);
  const pipelineSummary = config.twoPassOCR
    ? `${getEngineLabel(effectiveStabilityEngine)} at ${effectiveScanRate.toFixed(1)}s -> ${getEngineLabel(effectiveMainEngine)}`
    : `${getEngineLabel(effectiveMainEngine)} at ${effectiveScanRate.toFixed(1)}s`;

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
      cursorInactiveStyle: "none",
      theme: {
        foreground: "#eeeeee",
        background: "#11151c",
        cursor: "transparent",
        cursorAccent: "transparent"
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
    (message: string, options?: { dedupeKey?: string }) => {
      const trimmedMessage = message.trim();
      if (!trimmedMessage) {
        return;
      }
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }

      const dedupeKey = options?.dedupeKey?.trim();
      const previousRepeatedLine = repeatedTerminalLineRef.current;
      if (dedupeKey && previousRepeatedLine?.dedupeKey === dedupeKey) {
        const nextCount = previousRepeatedLine.count + 1;
        terminal.write(
          `\x1b[1A\r\x1b[2K${formatRepeatedTerminalLine(
            previousRepeatedLine.baseMessage,
            nextCount
          )}\r\n`
        );
        repeatedTerminalLineRef.current = {
          dedupeKey,
          count: nextCount,
          baseMessage: previousRepeatedLine.baseMessage
        };
        fitTerminal();
        return;
      }

      terminal.writeln(message);
      repeatedTerminalLineRef.current = dedupeKey
        ? {
            dedupeKey,
            count: 1,
            baseMessage: message
          }
        : null;
      fitTerminal();
    },
    [fitTerminal]
  );

  const clearTerminal = useCallback(() => {
    terminalRef.current?.clear();
    previousLogLineRef.current = "";
    repeatedTerminalLineRef.current = null;
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
        setNotice({ type: "success", message: t("ocr.runtime.areaSelectionFinished") });
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

      const isMenuOnlyLog = lowerLine.includes(MENU_ONLY_LOG_MESSAGE.toLowerCase());
      const nextTerminalLine = isMenuOnlyLog
        ? MENU_ONLY_CONSOLE_MESSAGE
        : OCR_RUN_2_RECOGNIZED_PATTERN.test(trimmedLine)
          ? `\x1b[92m${trimmedLine}\x1b[0m`
          : replaceEngineLabelsWithAnsi(trimmedLine);

      appendTerminalLine(nextTerminalLine, {
        dedupeKey: isMenuOnlyLog ? MENU_ONLY_LOG_MESSAGE : undefined
      });
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
        setNotice({ type: "error", message: t("ocr.runtime.failedSwitchScene") });
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
        setNotice({ type: "success", message: t("ocr.notices.areaConfigImported") });
        await refreshActiveSceneInfo();
      } else {
        setNotice({ type: "error", message: result.message });
      }
    } catch (error) {
      console.error("Failed to import OCR config:", error);
      setNotice({ type: "error", message: t("ocr.notices.importFailed") });
    }
  }, [refreshActiveSceneInfo]);

  const exportAreaConfig = useCallback(async () => {
    try {
      const result = await invokeIpc<{ success: boolean; message: string }>(
        "ocr.export-ocr-config"
      );
      setNotice({
        type: result.success ? "success" : "error",
        message: result.success ? t("ocr.notices.areaConfigExported") : result.message
      });
    } catch (error) {
      console.error("Failed to export OCR config:", error);
      setNotice({ type: "error", message: t("ocr.notices.exportFailed") });
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
        {/* Toast notification */}
        {notice ? (
          <div
            className={`ocr-toast ocr-toast--${notice.type}`}
            role="status"
            aria-live="polite"
          >
            <span>{notice.message}</span>
          </div>
        ) : null}

        <div className="ocr-dashboard">
          {/* ── LEFT COLUMN: Setup + Settings ── */}
          <div className="ocr-col ocr-col--settings">
            {/* Scene & Areas */}
            <section className="card legacy-card ocr-card">
              <div className="ocr-card-header-row">
                <h2>{t("ocr.sceneAndAreas.title")}</h2>
                <span
                  className={`ocr-area-badge ${hasConfiguredAreas ? "ocr-area-badge--ok" : "ocr-area-badge--empty"}`}
                >
                  {configuredAreaCount === 1
                    ? t("ocr.sceneAndAreas.areaCount", { count: String(configuredAreaCount) })
                    : t("ocr.sceneAndAreas.areaCountPlural", { count: String(configuredAreaCount) })}
                </span>
              </div>
              <div className="form-group ocr-form-group">
                <div className="input-group ocr-scene-row">
                  <Tip text={ocrTooltips.scene}>
                    <label htmlFor="ocr-scene-select">{t("ocr.sceneAndAreas.sceneLabel")}</label>
                  </Tip>
                  <select
                    id="ocr-scene-select"
                    className="ocr-scene-select"
                    value={selectedSceneId}
                    onChange={(event) => {
                      void switchScene(event.target.value);
                    }}
                  >
                    {loadingScenes ? (
                      <option value="">{t("ocr.sceneAndAreas.loading")}</option>
                    ) : scenes.length === 0 ? (
                      <option value="">{t("ocr.sceneAndAreas.noScenes")}</option>
                    ) : (
                      scenes.map((scene) => (
                        <option key={scene.id} value={scene.id}>
                          {scene.name}
                        </option>
                      ))
                    )}
                  </select>
                  <Tip text={ocrTooltips.refreshScenes} align="center">
                    <button
                      type="button"
                      className="secondary ocr-icon-btn"
                      onClick={() => {
                        void refreshScenesAndConfig();
                      }}
                      aria-label={t("ocr.sceneAndAreas.reloadScenes")}
                    >
                      ↻
                    </button>
                  </Tip>
                </div>
                <div className="link-row">
                  <button
                    type="button"
                    {...titleProps(ocrTooltips.selectAreas)}
                    onClick={runScreenSelector}
                  >
                    {t("ocr.sceneAndAreas.selectAreas")}
                  </button>
                  <Tip text={ocrTooltips.importAreas} align="center">
                    <button
                      type="button"
                      className="secondary ocr-icon-btn"
                      onClick={() => void importAreaConfig()}
                      aria-label={t("ocr.sceneAndAreas.importAreas")}
                    >
                      📋
                    </button>
                  </Tip>
                  <Tip text={ocrTooltips.exportAreas} align="center">
                    <button
                      type="button"
                      className="secondary ocr-icon-btn"
                      onClick={() => void exportAreaConfig()}
                      aria-label={t("ocr.sceneAndAreas.exportAreas")}
                    >
                      📤
                    </button>
                  </Tip>
                  <Tip text={ocrTooltips.docs} align="center">
                    <button
                      type="button"
                      className="secondary ocr-icon-btn"
                      onClick={() => void openOcrDocs()}
                      aria-label={t("ocr.sceneAndAreas.ocrGuide")}
                    >
                      📖
                    </button>
                  </Tip>
                </div>
              </div>
            </section>

            {/* OCR Settings */}
            <section className="card legacy-card ocr-card ocr-card--grow">
              <div className="ocr-card-header-row">
                <h2>{t("ocr.settings.title")}</h2>
                <label
                  className="ocr-inline-toggle"
                  htmlFor="ocr-advanced-toggle"
                  {...titleProps(ocrTooltips.advancedMode)}
                >
                  <span>{t("ocr.settings.advanced")}</span>
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

              <div className="form-group ocr-form-group">
                {config.advancedMode ? (
                  <div className="input-group">
                    <label
                      htmlFor="ocr-advanced-scan-rate"
                      {...titleProps(ocrTooltips.advancedScanRate)}
                    >
                      {t("ocr.settings.scanRate")}
                    </label>
                    <input
                      id="ocr-advanced-scan-rate"
                      type="number"
                      min={0.1}
                      max={10}
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
                ) : (
                  <div className="input-group">
                    <label
                      htmlFor="ocr-basic-speed"
                      {...titleProps(ocrTooltips.basicScanRate)}
                    >
                      {t("ocr.settings.textSpeed")}
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
                )}

                <div className="input-group">
                  <label htmlFor="ocr-language" {...titleProps(ocrTooltips.language)}>
                    {t("ocr.settings.language")}
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

                <div className="ocr-slider-field">
                  <div className="ocr-slider-header">
                    <label
                      htmlFor="ocr-base-scale"
                      {...titleProps(ocrTooltips.baseScale)}
                    >
                      {t("ocr.settings.scanImageQuality")}
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
                      {...titleProps(ocrTooltips.furiganaFilter)}
                    >
                      {t("ocr.settings.furiganaFilter")}
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
                      {...titleProps(ocrTooltips.furiganaPreview)}
                      onClick={async () => {
                        const next = await invokeIpc<number>("run-furigana-window");
                        setConfig((current) => ({
                          ...current,
                          furiganaFilterSensitivity: integerValue(next, 0)
                        }));
                      }}
                    >
                      {t("ocr.settings.preview")}
                    </button>
                  </div>
                </div>

                <div className="ocr-linebreak-row">
                  <Tip text={ocrTooltips.sendToClipboard}>
                    <span className="ocr-linebreak-label">{t("ocr.settings.copyToClipboard")}</span>
                  </Tip>
                  <label className="checkbox-item" htmlFor="send-to-clipboard-auto">
                    <input
                      id="send-to-clipboard-auto"
                      type="checkbox"
                      checked={config.sendToClipboardAuto}
                      onChange={(event) => {
                        setConfig((current) => ({
                          ...current,
                          sendToClipboardAuto: event.target.checked
                        }));
                      }}
                    />
                    <span
                      className="ocr-lb-auto"
                      {...titleProps(ocrTooltips.sendToClipboardAuto)}
                    >
                      {t("ocr.settings.auto")}
                    </span>
                  </label>
                  <label className="checkbox-item" htmlFor="send-to-clipboard-menu">
                    <input
                      id="send-to-clipboard-menu"
                      type="checkbox"
                      checked={config.sendToClipboardMenu}
                      onChange={(event) => {
                        setConfig((current) => ({
                          ...current,
                          sendToClipboardMenu: event.target.checked
                        }));
                      }}
                    />
                    <span
                      className="ocr-lb-menu"
                      {...titleProps(ocrTooltips.sendToClipboardMenu)}
                    >
                      {t("ocr.settings.menu")}
                    </span>
                  </label>
                  <label
                    className="checkbox-item"
                    htmlFor="send-to-clipboard-area-select"
                  >
                    <input
                      id="send-to-clipboard-area-select"
                      type="checkbox"
                      checked={config.sendToClipboardAreaSelect}
                      onChange={(event) => {
                        setConfig((current) => ({
                          ...current,
                          sendToClipboardAreaSelect: event.target.checked
                        }));
                      }}
                    />
                    <span
                      className="ocr-lb-area"
                      {...titleProps(ocrTooltips.sendToClipboardAreaSelect)}
                    >
                      {t("ocr.settings.areaSelect")}
                    </span>
                  </label>
                </div>

                <div className="ocr-linebreak-row">
                  <Tip text={ocrTooltips.keepNewline}>
                    <span className="ocr-linebreak-label">{t("ocr.settings.lineBreaks")}</span>
                  </Tip>
                  <label className="checkbox-item" htmlFor="keep-newline-auto">
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
                    <span className="ocr-lb-auto" {...titleProps(ocrTooltips.keepNewlineAuto)}>{t("ocr.settings.auto")}</span>
                  </label>
                  <label className="checkbox-item" htmlFor="keep-newline-menu">
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
                    <span className="ocr-lb-menu" {...titleProps(ocrTooltips.keepNewlineMenu)}>{t("ocr.settings.menu")}</span>
                  </label>
                  <label className="checkbox-item" htmlFor="keep-newline-area-select">
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
                    <span className="ocr-lb-area" {...titleProps(ocrTooltips.keepNewlineAreaSelect)}>
                      {t("ocr.settings.areaSelect")}
                    </span>
                  </label>
                </div>
              </div>

              {/* Advanced-only sections */}
              {config.advancedMode ? (
                <>
                  <div className="ocr-pipeline-section">
                    <h3 className="ocr-pipeline-heading" {...titleProps(ocrTooltips.advancedRecognition)}>
                      {t("ocr.pipeline.title")}
                    </h3>
                    <div className="ocr-pipeline-summary">
                      <strong>{config.twoPassOCR ? t("ocr.pipeline.twoPassFlow") : t("ocr.pipeline.singlePassFlow")}</strong>
                      <span>{pipelineSummary}</span>
                    </div>
                    <div className="ocr-pipeline-grid">
                      {config.twoPassOCR ? (
                        <div className="input-group ocr-pipeline-control">
                          <label
                            htmlFor="ocr-stability-engine"
                            {...titleProps(ocrTooltips.stabilityOcr)}
                          >
                            {t("ocr.pipeline.stabilityOcr")}
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
                      ) : null}

                      <div className="input-group ocr-pipeline-control">
                        <label htmlFor="ocr-main-engine" {...titleProps(ocrTooltips.mainOcr)}>
                          {t("ocr.pipeline.mainOcr")}
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

                      <div className="input-group ocr-pipeline-control ocr-pipeline-control--toggle">
                        <label htmlFor="ocr-two-pass" {...titleProps(ocrTooltips.twoPassOCR)}>
                          {t("ocr.pipeline.twoPassOcr")}
                        </label>
                        <input
                          id="ocr-two-pass"
                          type="checkbox"
                          checked={config.twoPassOCR}
                          onChange={(event) => {
                            setConfig((current) => ({
                              ...current,
                              twoPassOCR: event.target.checked
                            }));
                          }}
                        />
                      </div>

                      {config.twoPassOCR ? (
                        <div className="input-group ocr-pipeline-control ocr-pipeline-control--toggle">
                          <label
                            htmlFor="ocr-optimize-second-scan"
                            {...titleProps(ocrTooltips.optimizeSecondScan)}
                          >
                            {t("ocr.pipeline.optimizeSecondScan")}
                          </label>
                          <input
                            id="ocr-optimize-second-scan"
                            type="checkbox"
                            checked={config.optimizeSecondScan}
                            onChange={(event) => {
                              setConfig((current) => ({
                                ...current,
                                optimizeSecondScan: event.target.checked
                              }));
                            }}
                          />
                        </div>
                      ) : null}

                      <div className="input-group ocr-pipeline-control ocr-pipeline-control--toggle">
                        <label
                          htmlFor="ocr-clipboard-screenshots"
                          {...titleProps(ocrTooltips.ocrScreenshots)}
                        >
                          {t("ocr.pipeline.ocrClipboardImages")}
                        </label>
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
                      </div>
                    </div>
                  </div>

                  <details className="ocr-details-card">
                    <summary {...titleProps(ocrTooltips.comparison)}>
                      {t("ocr.comparison.title")}
                    </summary>
                    <div className="ocr-comparison-primary-grid ocr-details-body">
                      {COMPARISON_LAYOUT.primary.map((field) => (
                        <div key={field.key} className="ocr-comparison-field">
                          <label
                            htmlFor={`comparison-${field.key}`}
                            {...titleProps(t(field.titleKey))}
                          >
                            {t(field.labelKey)}
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

                    <details className="ocr-details-card ocr-details-card--nested">
                      <summary>{t("ocr.comparison.expertTitle")}</summary>
                      <div className="ocr-comparison-expert-grid ocr-details-body">
                        <div className="ocr-comparison-column">
                          {COMPARISON_LAYOUT.expertLeft.map((field) => (
                            <div key={field.key} className="ocr-comparison-field">
                              <label
                                htmlFor={`comparison-${field.key}`}
                                {...titleProps(t(field.titleKey))}
                              >
                                {t(field.labelKey)}
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
                            <div key={field.key} className="ocr-comparison-field">
                              <label
                                htmlFor={`comparison-${field.key}`}
                                {...titleProps(t(field.titleKey))}
                              >
                                {t(field.labelKey)}
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
                  </details>
                </>
              ) : null}
            </section>
          </div>

          {/* ── RIGHT COLUMN: Hotkeys + Console + Debug ── */}
          <div className="ocr-col ocr-col--monitor">
            {/* Hotkeys */}
            <section className="card legacy-card ocr-card">
              <div className="ocr-card-header-row">
                <h2>{t("ocr.hotkeys.title")}</h2>
              </div>
              <div className="form-group ocr-form-group ocr-hotkey-grid">
                <div className="input-group">
                  <label htmlFor="manual-hotkey" {...titleProps(ocrTooltips.manualHotkey)}>
                    {t("ocr.hotkeys.manualMenu")}
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

                <div className="input-group">
                  <label htmlFor="area-hotkey" {...titleProps(ocrTooltips.areaSelectHotkey)}>
                    {t("ocr.hotkeys.areaSelect")}
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

                <div className="input-group">
                  <label
                    htmlFor="whole-window-hotkey"
                    {...titleProps(ocrTooltips.wholeWindowHotkey)}
                  >
                    {t("ocr.hotkeys.wholeWindow")}
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

                <div className="input-group">
                  <label htmlFor="pause-hotkey" {...titleProps(ocrTooltips.pauseHotkey)}>
                    {t("ocr.hotkeys.pause")}
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
            </section>

            {/* Console - always visible */}
            <section className="card legacy-card ocr-card ocr-card--console">
              <div className="ocr-card-header-row">
                <h2>{t("ocr.console.title")}</h2>
                <div className="ocr-console-actions">
                  <span className={`ocr-console-status ocr-console-status--${runningState.isRunning ? (paused ? "paused" : "active") : "idle"}`}>
                    {runningState.isRunning ? (paused ? t("ocr.console.paused") : t("ocr.console.active")) : t("ocr.console.idle")}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    {...titleProps(ocrTooltips.clearConsole)}
                    onClick={clearTerminal}
                  >
                    {t("ocr.console.clear")}
                  </button>
                </div>
              </div>
              <div ref={terminalElementRef} className="ocr-terminal-surface" />
            </section>

            {/* Extra & Debug - collapsible */}
            <details className="card legacy-card ocr-card ocr-details-card ocr-details-card--debug">
              <summary>{t("ocr.debug.title")}</summary>
              <div className="form-group ocr-form-group ocr-details-body">
                <div className="input-group">
                  <label
                    htmlFor="ignore-ocr-run-1"
                    {...titleProps(ocrTooltips.ignoreRun1Logs)}
                  >
                    {t("ocr.debug.ignoreRun1Logs")}
                  </label>
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
                </div>

                <div className="input-group">
                  <label
                    htmlFor="process-priority"
                    {...titleProps(ocrTooltips.processPriority)}
                  >
                    {t("ocr.debug.processPriority")}
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

                <div className="input-group">
                  <label
                    htmlFor="default-furigana-sensitivity"
                    {...titleProps(ocrTooltips.defaultSceneFurigana)}
                  >
                    {t("ocr.debug.defaultFuriganaSensitivity")}
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

                <div className="input-group">
                  <label
                    htmlFor="obs-preprocess"
                    {...titleProps(ocrTooltips.obsCapturePreprocess)}
                  >
                    {t("ocr.debug.obsCapturePreprocess")}
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

                <div className="input-group wrap">
                  <label htmlFor="dep-install" {...titleProps(ocrTooltips.installDependency)}>
                    {t("ocr.debug.installDependency")}
                  </label>
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
                    {t("ocr.debug.installBtn")}
                  </button>
                </div>

                <div className="input-group wrap">
                  <label
                    htmlFor="dep-remove"
                    {...titleProps(ocrTooltips.uninstallDependency)}
                  >
                    {t("ocr.debug.removeDependency")}
                  </label>
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
                    {t("ocr.debug.uninstallBtn")}
                  </button>
                </div>

                <div className="link-row">
                  <button
                    type="button"
                    className="secondary"
                    {...titleProps(ocrTooltips.replacements)}
                    onClick={openOcrReplacementsPage}
                  >
                    {t("ocr.debug.ocrErrorFixes")}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    {...titleProps(ocrTooltips.openConfigFile)}
                    onClick={() => void invokeIpc("ocr.open-config-json")}
                  >
                    {t("ocr.debug.configFile")}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    {...titleProps(ocrTooltips.openConfigFolder)}
                    onClick={() => void invokeIpc("ocr.open-config-folder")}
                  >
                    {t("ocr.debug.configFolder")}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    {...titleProps(ocrTooltips.openGlobalConfig)}
                    onClick={() => void invokeIpc("ocr.open-global-owocr-config")}
                  >
                    {t("ocr.debug.globalConfig")}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    {...titleProps(ocrTooltips.openTempFolder)}
                    onClick={() => void invokeIpc("ocr.open-temp-folder")}
                  >
                    {t("ocr.debug.tempFolder")}
                  </button>
                </div>
              </div>
            </details>
          </div>
        </div>

        {/* ── Sticky Footer ── */}
        <div className={`ocr-sticky-footer ocr-sticky-footer--${footerTone}`}>
          <div className="ocr-sticky-footer-status">
            <span className={`ocr-runtime-badge ocr-runtime-badge--${footerTone}`}>
              {footerStatusLabel}
            </span>
            <div className="ocr-sticky-footer-copy">
              <strong>{runningState.isRunning ? runtimeEngine || t("ocr.footer.ocrRuntime") : sceneSummary}</strong>
              <p className="muted">{footerSummary}</p>
            </div>
          </div>
          <div className="ocr-sticky-footer-actions">
            {runningState.isRunning ? (
              <>
                <button
                  type="button"
                  className="danger"
                  title={ocrTooltips.stop}
                  onClick={() => void stopOcr()}
                >
                  {t("ocr.footer.stopOcr")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  title={paused ? ocrTooltips.resume : ocrTooltips.pause}
                  onClick={togglePause}
                >
                  {paused ? t("ocr.footer.resumeOcr") : t("ocr.footer.pauseOcr")}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={!hasConfiguredAreas}
                  title={
                    hasConfiguredAreas
                      ? ocrTooltips.startAuto
                      : t("ocr.footer.needAreasFirst", {
                          mode: t("ocr.footer.modeAuto")
                        })
                  }
                  onClick={() => void startOcr(false)}
                >
                  {t("ocr.footer.startAutoOcr")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!hasConfiguredAreas}
                  title={
                    hasConfiguredAreas
                      ? ocrTooltips.startManual
                      : t("ocr.footer.needAreasFirst", {
                          mode: t("ocr.footer.modeManual")
                        })
                  }
                  onClick={() => void startOcr(true)}
                >
                  {t("ocr.footer.startManualOcr")}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
