import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import "./OCRTab.css";
import { OCRCaptureMap, type CaptureMapConfig } from "./OCRCaptureMap";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { DOCS_URLS } from "../../../../shared/docs";
import { getBasicMainOcr, getDefaultStabilityOcr, type OcrPlatform } from "../../../../shared/ocr_defaults";
import { invokeIpc, onIpc, platformFromEnv, sendIpc } from "../../lib/ipc";
import type { ObsScene, SceneLaunchProfile, SceneOcrMode } from "../../types/models";
import { useTranslation } from "../../i18n";
import { Tooltip, tooltipProps } from "../Tooltip";
import { getTerminalColors, THEME_CHANGED_EVENT } from "../../lib/theme";

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
  useOnlineOcr?: boolean;
  ocr1?: string;
  ocr2?: string;
  ocr1_advanced?: string;
  ocr2_advanced?: string;
  twoPassOCR?: boolean;
  optimize_second_scan?: boolean;
  text_appears_instantly?: boolean;
  advanced_debug_logging?: boolean;
  scanRate?: number;
  scanRate_basic?: number;
  scanRate_advanced?: number;
  language?: string;
  ocr_screenshots?: boolean;
  furigana_filter_sensitivity?: number;
  defaultSceneFuriganaFilterSensitivity?: number;
  gamepadHotkeysEnabled?: boolean;
  manualOcrHotkey?: string;
  manualOcrGamepad?: string;
  manualOcrDelayMs?: number;
  manualOcrDelayGamepadOnly?: boolean;
  menuOcrHotkey?: string;
  menuOcrGamepad?: string;
  areaSelectOcrHotkey?: string;
  areaSelectOcrGamepad?: string;
  addAreaOcrHotkey?: string;
  addAreaOcrGamepad?: string;
  wholeWindowOcrHotkey?: string;
  wholeWindowOcrGamepad?: string;
  globalPauseHotkey?: string;
  globalPauseGamepad?: string;
  sendToClipboard?: boolean;
  send_to_clipboard_auto?: boolean | null;
  send_to_clipboard_menu?: boolean | null;
  send_to_clipboard_area_select?: boolean | null;

  keep_newline?: boolean;
  keep_newline_auto?: boolean;
  keep_newline_menu?: boolean;
  keep_newline_area_select?: boolean;
  obs_capture_preprocess?: string;
  compactBoxes?: boolean;
  compactBoxesGap?: number;
  ignore_ocr_run_1_text?: boolean;
  processPriority?: string;
  base_scale?: number;
  advancedMode?: boolean;
  [key: string]: unknown;
}

interface OcrUiConfig {
  useOnlineOcr: boolean;
  advancedMode: boolean;
  basicScanRate: number;
  advancedScanRate: number;
  mainOcr: string;
  stabilityOcr: string;
  twoPassOCR: boolean;
  optimizeSecondScan: boolean;
  textAppearsInstantly: boolean;
  advancedDebugLogging: boolean;
  language: string;
  ocrScreenshots: boolean;
  furiganaFilterSensitivity: number;
  defaultSceneFuriganaFilterSensitivity: number;
  gamepadHotkeysEnabled: boolean;
  manualOcrHotkey: string;
  manualOcrGamepad: string;
  manualOcrDelayMs: number;
  manualOcrDelayGamepadOnly: boolean;
  menuOcrHotkey: string;
  menuOcrGamepad: string;
  areaSelectOcrHotkey: string;
  areaSelectOcrGamepad: string;
  addAreaOcrHotkey: string;
  addAreaOcrGamepad: string;
  wholeWindowOcrHotkey: string;
  wholeWindowOcrGamepad: string;
  globalPauseHotkey: string;
  globalPauseGamepad: string;
  sendToClipboardAuto: boolean;
  sendToClipboardMenu: boolean;
  sendToClipboardAreaSelect: boolean;

  keepNewlineAuto: boolean;
  keepNewlineMenu: boolean;
  keepNewlineAreaSelect: boolean;
  obsCapturePreprocess: string;
  compactBoxes: boolean;
  compactBoxesGap: number;
  ignoreOcrRun1Text: boolean;
  processPriority: ProcessPriority;
  baseScale: number;
  comparison: Record<ComparisonFieldKey, number>;
}

interface OcrSceneAreaConfig extends CaptureMapConfig {
  scene?: string;
  window?: string;
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

interface NormalizedOcrStatus {
  paused: boolean;
  mode: "auto" | "manual";
  engineKey: string;
  engineLabel: string;
  scanRate: number;
  signature: string;
}

interface NoticeState {
  type: "info" | "success" | "error";
  message: string;
}

interface OcrTabProps {
  active: boolean;
}

type HotkeyConfigKey =
  | "manualOcrHotkey"
  | "menuOcrHotkey"
  | "areaSelectOcrHotkey"
  | "addAreaOcrHotkey"
  | "wholeWindowOcrHotkey"
  | "globalPauseHotkey";

type GamepadConfigKey =
  | "manualOcrGamepad"
  | "menuOcrGamepad"
  | "areaSelectOcrGamepad"
  | "addAreaOcrGamepad"
  | "wholeWindowOcrGamepad"
  | "globalPauseGamepad";

interface HotkeyActionDefinition {
  id: string;
  labelKey: string;
  tooltip: string;
  hotkeyKey: HotkeyConfigKey;
  gamepadKey: GamepadConfigKey;
  trigger?: () => void;
}

interface Option {
  value: string;
  label: string;
}

const GAMEPAD_HOTKEY_OPTIONS: Array<{ value: string; labelKey: string }> = [
  { value: "", labelKey: "ocr.hotkeys.gamepadButtons.disabled" },
  { value: "0", labelKey: "ocr.hotkeys.gamepadButtons.a" },
  { value: "1", labelKey: "ocr.hotkeys.gamepadButtons.b" },
  { value: "2", labelKey: "ocr.hotkeys.gamepadButtons.x" },
  { value: "3", labelKey: "ocr.hotkeys.gamepadButtons.y" },
  { value: "4", labelKey: "ocr.hotkeys.gamepadButtons.lb" },
  { value: "5", labelKey: "ocr.hotkeys.gamepadButtons.rb" },
  { value: "6", labelKey: "ocr.hotkeys.gamepadButtons.lt" },
  { value: "7", labelKey: "ocr.hotkeys.gamepadButtons.rt" },
  { value: "8", labelKey: "ocr.hotkeys.gamepadButtons.back" },
  { value: "9", labelKey: "ocr.hotkeys.gamepadButtons.start" },
  { value: "10", labelKey: "ocr.hotkeys.gamepadButtons.ls" },
  { value: "11", labelKey: "ocr.hotkeys.gamepadButtons.rs" },
  { value: "12", labelKey: "ocr.hotkeys.gamepadButtons.dpadUp" },
  { value: "13", labelKey: "ocr.hotkeys.gamepadButtons.dpadDown" },
  { value: "14", labelKey: "ocr.hotkeys.gamepadButtons.dpadLeft" },
  { value: "15", labelKey: "ocr.hotkeys.gamepadButtons.dpadRight" },
  { value: "16", labelKey: "ocr.hotkeys.gamepadButtons.guide" }
];

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

interface OcrScanTiming {
  engineKey: string;
  recordedAt: number;
  durationSeconds: number;
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

const BASIC_SCAN_RATE_OPTIONS: Array<{ value: string; labelKey: string }> = [
  { value: "0", labelKey: "ocr.scanRates.asFastAsPossibleWarning" },
  { value: "0.2", labelKey: "ocr.scanRates.fast" },
  { value: "0.5", labelKey: "ocr.scanRates.normal" },
  { value: "0.8", labelKey: "ocr.scanRates.slow" },
  { value: "1", labelKey: "ocr.scanRates.verySlow" }
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
const BLACK_HOLE_LOG_MESSAGE =
  "Text is inside a black hole OCR box, skipping further processing.";
const BLACK_HOLE_CONSOLE_MESSAGE =
  "\x1b[33mSkipped OCR result: text is inside a black hole box\x1b[0m";
const ANSI_RESET = "\x1b[0m";
const OCR_SCAN_AVERAGE_WINDOW_MS = 5000;

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
  "change_detection_threshold",
  "evolving_prefix_similarity_threshold"
];

const COMPARISON_TRUNCATION_KEYS: ComparisonFieldKey[] = [
  "truncation_compare_threshold_min",
  "truncation_strict_threshold_min",
  "truncation_similarity_margin",
  "truncation_min_length",
  "truncation_min_ratio_percent"
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

function normalizeOcrStatusPayload(
  status: OcrStatusPayload,
  fallbackScanRate: number
): NormalizedOcrStatus {
  const engineKey =
    typeof status.current_engine === "string" ? status.current_engine : "";
  const scanRate = numericValue(status.scan_rate, fallbackScanRate);
  const paused = Boolean(status.paused);
  const mode = status.manual ? "manual" : "auto";

  return {
    paused,
    mode,
    engineKey,
    engineLabel: engineKey ? getEngineLabel(engineKey) : "",
    scanRate,
    signature: [
      paused ? "paused" : "running",
      mode,
      engineKey,
      scanRate.toFixed(3)
    ].join("|")
  };
}

function ocrRunningStatesEqual(
  left: OcrRunningState,
  right: OcrRunningState
): boolean {
  return (
    left.isRunning === right.isRunning &&
    left.source === right.source &&
    left.mode === right.mode
  );
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
  const hasSeparateMenuBinding = typeof value?.menuOcrHotkey === "string";
  const gamepadHotkeysEnabled =
    typeof value?.gamepadHotkeysEnabled === "boolean"
      ? value.gamepadHotkeysEnabled
      : [
          value?.manualOcrGamepad,
          value?.menuOcrGamepad,
          value?.areaSelectOcrGamepad,
          value?.addAreaOcrGamepad,
          value?.wholeWindowOcrGamepad,
          value?.globalPauseGamepad
        ].some((binding) => typeof binding === "string" && binding.length > 0);

  for (const field of COMPARISON_FIELDS) {
    comparison[field.key] = numericValue(
      value?.[field.key],
      COMPARISON_DEFAULTS[field.key]
    );
  }

  return {
    advancedMode: Boolean(value?.advancedMode),
    useOnlineOcr: value?.useOnlineOcr === true,
    basicScanRate: numericValue(value?.scanRate_basic, scanRate),
    advancedScanRate: numericValue(value?.scanRate_advanced, scanRate),
    mainOcr:
      typeof value?.ocr2_advanced === "string"
        ? value.ocr2_advanced
        : typeof value?.ocr2 === "string"
          ? value.ocr2
          : getBasicMainOcr(),
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
    textAppearsInstantly: value?.text_appears_instantly === true,
    advancedDebugLogging: value?.advanced_debug_logging === true,
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
    gamepadHotkeysEnabled,
    manualOcrHotkey:
      hasSeparateMenuBinding && typeof value?.manualOcrHotkey === "string"
        ? value.manualOcrHotkey
        : "Ctrl+Shift+M",
    manualOcrGamepad:
      hasSeparateMenuBinding && typeof value?.manualOcrGamepad === "string"
        ? value.manualOcrGamepad
        : "",
    manualOcrDelayMs: Math.max(0, integerValue(value?.manualOcrDelayMs, 0)),
    manualOcrDelayGamepadOnly: value?.manualOcrDelayGamepadOnly === true,
    menuOcrHotkey: hasSeparateMenuBinding
      ? value.menuOcrHotkey ?? "Ctrl+Shift+G"
      : typeof value?.manualOcrHotkey === "string"
        ? value.manualOcrHotkey
        : "Ctrl+Shift+G",
    menuOcrGamepad:
      typeof value?.menuOcrGamepad === "string"
        ? value.menuOcrGamepad
        : typeof value?.manualOcrGamepad === "string"
          ? value.manualOcrGamepad
          : "",
    areaSelectOcrHotkey:
      typeof value?.areaSelectOcrHotkey === "string"
        ? value.areaSelectOcrHotkey
        : "Ctrl+Shift+O",
    areaSelectOcrGamepad:
      typeof value?.areaSelectOcrGamepad === "string"
        ? value.areaSelectOcrGamepad
        : "",
    addAreaOcrHotkey:
      typeof value?.addAreaOcrHotkey === "string"
        ? value.addAreaOcrHotkey
        : "Alt+Shift+N",
    addAreaOcrGamepad:
      typeof value?.addAreaOcrGamepad === "string"
        ? value.addAreaOcrGamepad
        : "",
    wholeWindowOcrHotkey:
      typeof value?.wholeWindowOcrHotkey === "string"
        ? value.wholeWindowOcrHotkey
        : "Ctrl+Shift+W",
    wholeWindowOcrGamepad:
      typeof value?.wholeWindowOcrGamepad === "string"
        ? value.wholeWindowOcrGamepad
        : "",
    globalPauseHotkey:
      typeof value?.globalPauseHotkey === "string"
        ? value.globalPauseHotkey
        : "Ctrl+Shift+P",
    globalPauseGamepad:
      typeof value?.globalPauseGamepad === "string" ? value.globalPauseGamepad : "",
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
    compactBoxes: value?.compactBoxes === true,
    compactBoxesGap: numericValue(value?.compactBoxesGap, 12),
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
    useOnlineOcr: config.useOnlineOcr,
    twoPassOCR: config.twoPassOCR,
    optimize_second_scan: config.optimizeSecondScan,
    text_appears_instantly: config.textAppearsInstantly,
    advanced_debug_logging: config.advancedDebugLogging,
    scanRate: config.advancedMode ? config.advancedScanRate : config.basicScanRate,
    scanRate_basic: config.basicScanRate,
    scanRate_advanced: config.advancedScanRate,
    language: config.language,
    ocr_screenshots: config.ocrScreenshots,
    furigana_filter_sensitivity: config.furiganaFilterSensitivity,
    defaultSceneFuriganaFilterSensitivity:
      config.defaultSceneFuriganaFilterSensitivity,
    gamepadHotkeysEnabled: config.gamepadHotkeysEnabled,
    manualOcrHotkey: config.manualOcrHotkey,
    manualOcrGamepad: config.manualOcrGamepad,
    manualOcrDelayMs: config.manualOcrDelayMs,
    manualOcrDelayGamepadOnly: config.manualOcrDelayGamepadOnly,
    menuOcrHotkey: config.menuOcrHotkey,
    menuOcrGamepad: config.menuOcrGamepad,
    areaSelectOcrHotkey: config.areaSelectOcrHotkey,
    areaSelectOcrGamepad: config.areaSelectOcrGamepad,
    addAreaOcrHotkey: config.addAreaOcrHotkey,
    addAreaOcrGamepad: config.addAreaOcrGamepad,
    wholeWindowOcrHotkey: config.wholeWindowOcrHotkey,
    wholeWindowOcrGamepad: config.wholeWindowOcrGamepad,
    globalPauseHotkey: config.globalPauseHotkey,
    globalPauseGamepad: config.globalPauseGamepad,
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
    compactBoxes: config.compactBoxes,
    compactBoxesGap: config.compactBoxesGap,
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
    next.ocr2 = getBasicMainOcr(config.useOnlineOcr);
  }

  for (const field of COMPARISON_FIELDS) {
    next[field.key] = config.comparison[field.key];
  }

  delete next.wgcCaptureFps;
  return next;
}

function basicSpeedLabelKey(scanRate: number): string {
  if (scanRate <= 0) {
    return "ocr.scanRates.asFastAsPossible";
  }
  if (scanRate <= 0.3) {
    return "ocr.scanRates.fast";
  }
  if (scanRate <= 0.65) {
    return "ocr.scanRates.normal";
  }
  if (scanRate <= 0.9) {
    return "ocr.scanRates.slow";
  }
  return "ocr.scanRates.verySlow";
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
  const truncation = COMPARISON_FIELDS.filter((field) =>
    COMPARISON_TRUNCATION_KEYS.includes(field.key)
  );
  const subset = COMPARISON_FIELDS.filter(
    (field) =>
      !COMPARISON_PRIMARY_KEYS.includes(field.key) &&
      !COMPARISON_TRUNCATION_KEYS.includes(field.key)
  );

  return {
    primary,
    truncation,
    subset
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
  textAppearsInstantly: "ocr.tooltips.textAppearsInstantly",
  twoPassOCR: "ocr.tooltips.twoPassOCR",
  stabilityOcr: "ocr.tooltips.stabilityOcr",
  mainOcr: "ocr.tooltips.mainOcr",
  optimizeSecondScan: "ocr.tooltips.optimizeSecondScan",
  ocrScreenshots: "ocr.tooltips.ocrScreenshots",
  manualHotkey: "ocr.tooltips.manualHotkey",
  menuHotkey: "ocr.tooltips.menuHotkey",
  areaSelectHotkey: "ocr.tooltips.areaSelectHotkey",
  addAreaHotkey: "ocr.tooltips.addAreaHotkey",
  wholeWindowHotkey: "ocr.tooltips.wholeWindowHotkey",
  pauseHotkey: "ocr.tooltips.pauseHotkey",
  processPriority: "ocr.tooltips.processPriority",
  defaultSceneFurigana: "ocr.tooltips.defaultSceneFurigana",
  obsCapturePreprocess: "ocr.tooltips.obsCapturePreprocess",
  compactBoxes: "ocr.tooltips.compactBoxes",
  compactBoxesGap: "ocr.tooltips.compactBoxesGap",
  ignoreRun1Logs: "ocr.tooltips.ignoreRun1Logs",
  advancedDebugLogging: "ocr.tooltips.advancedDebugLogging",
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

const OCR_WORKSPACE_VIEWS = [
  { id: "capture", labelKey: "ocr.desk.capture" },
  { id: "recognition", labelKey: "ocr.workspace.recognition" },
  { id: "filtering", labelKey: "ocr.workspace.filtering" },
  { id: "comparison", labelKey: "ocr.desk.textMatching" },
  { id: "shortcuts", labelKey: "ocr.workspace.shortcuts" },
  { id: "tools", labelKey: "ocr.workspace.tools" }
] as const;

type WorkspaceViewId = (typeof OCR_WORKSPACE_VIEWS)[number]["id"];

const OCR_COMPARISON_TABS = [
  { id: "primary", labelKey: "ocr.workspace.comparisonPrimary" },
  { id: "truncation", labelKey: "ocr.workspace.comparisonTruncation" },
  { id: "subset", labelKey: "ocr.workspace.comparisonSubset" }
] as const;

type ComparisonSubTabId = (typeof OCR_COMPARISON_TABS)[number]["id"];

const OCR_TOOLS_TABS = [
  { id: "diagnostics", labelKey: "ocr.workspace.toolsDiagnostics" },
  { id: "packages", labelKey: "ocr.workspace.toolsPackages" },
  { id: "files", labelKey: "ocr.workspace.toolsFiles" }
] as const;

type ToolsSubTabId = (typeof OCR_TOOLS_TABS)[number]["id"];

function navigateWorkspaceTabs<T extends string>(
  event: KeyboardEvent<HTMLButtonElement>,
  tabs: readonly { id: T }[],
  index: number,
  select: (id: T) => void,
  prefix: string
) {
  let next = index;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % tabs.length;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + tabs.length - 1) % tabs.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = tabs.length - 1;
  else return;

  event.preventDefault();
  const nextTab = tabs[next].id;
  select(nextTab);
  document.getElementById(prefix + nextTab)?.focus();
}

const OCR_OUTPUT_MODES = [
  {
    id: "auto",
    labelKey: "ocr.settings.auto",
    clipboardKey: "sendToClipboardAuto",
    newlineKey: "keepNewlineAuto"
  },
  {
    id: "menu",
    labelKey: "ocr.settings.menu",
    clipboardKey: "sendToClipboardMenu",
    newlineKey: "keepNewlineMenu"
  },
  {
    id: "area-select",
    labelKey: "ocr.settings.areaSelect",
    clipboardKey: "sendToClipboardAreaSelect",
    newlineKey: "keepNewlineAreaSelect"
  }
] as const;

const DEPENDENCY_INSTALL_LABEL_KEYS: Record<string, string> = {
  "pip install fpng-py": "ocr.dependencies.install.fasterPng",
  "pip install owocr[gvision]": "ocr.dependencies.install.googleVision",
  "pip install owocr[azure]": "ocr.dependencies.install.azure",
  "pip install owocr[ocrspace]": "ocr.dependencies.install.ocrspace"
};
const DEPENDENCY_REMOVE_LABEL_KEYS: Record<string, string> = {
  owocr: "ocr.dependencies.remove.owocr",
  protobuf: "ocr.dependencies.remove.protobuf",
  oneocr: "ocr.dependencies.remove.oneocr",
  "fpng-py": "ocr.dependencies.remove.fasterPng",
  "transformers sentencepiece": "ocr.dependencies.remove.transformers",
  "google-cloud-vision": "ocr.dependencies.remove.googleVision",
  "azure-ai-vision-imageanalysis": "ocr.dependencies.remove.azure",
  ocrspace: "ocr.dependencies.remove.ocrspace"
};

function WorkspaceIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    capture: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 12h8m-4-4v8",
    recognition: "M4 7h16M4 17h16M8 4v6m8 4v6",
    filtering: "M4 4h16v16H4zM4 15l5-5 4 4 3-3 4 4M15 8h.01",
    comparison: "M4 6h11m3 0h2M4 12h5m3 0h8M4 18h11m3 0h2",
    shortcuts:
      "M3 6h18v12H3zM6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h4M7 15h10",
    tools: "m14 7 3 3-9 10H4v-4L14 7zm0 0a6 6 0 0 1 7-4l-4 4 3 3 3-3a6 6 0 0 1-7 7",
    console: "m5 6 5 6-5 6m8 0h7",
    help: "M9 9a3 3 0 1 1 4 3c-1 .5-1 1-1 2m0 3h.01M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20",
    edit: "m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z",
    import: "M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5",
    export: "M12 15V3m-4 4 4-4 4 4M4 16v5h16v-5",
    add: "M12 5v14M5 12h14",
    manual: "M4 6h16v12H4zM8 10h8m-8 4h5",
    menu: "M4 5h16v14H4zM8 9h8m-8 3h8m-8 3h5",
    area: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8h8v8H8z",
    "whole-window": "M3 4h18v16H3zM3 8h18"
  };
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.capture} />
    </svg>
  );
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
  const [sceneAutostart, setSceneAutostart] = useState<{
    sceneId: string;
    mode: SceneOcrMode;
  } | null>(null);
  const [savingAutostart, setSavingAutostart] = useState(false);
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
  const [workspaceView, setWorkspaceView] = useState<WorkspaceViewId | "console">("capture");
  const lastWorkspaceView = useRef<WorkspaceViewId>("capture");
  useEffect(() => {
    if (workspaceView !== "console") lastWorkspaceView.current = workspaceView;
    else if (active) document.getElementById("ocr-view-console")?.focus();
  }, [active, workspaceView]);
  const openWorkspace = (view: WorkspaceViewId) => {
    setWorkspaceView(view);
    document.getElementById("ocr-nav-" + view)?.focus();
  };
  const toggleConsole = () => {
    if (workspaceView === "console") openWorkspace(lastWorkspaceView.current);
    else {
      setWorkspaceView("console");
      document.getElementById("ocr-console-toggle")?.focus();
    }
  };
  const [comparisonSubTab, setComparisonSubTab] = useState<ComparisonSubTabId>("primary");
  const [toolsSubTab, setToolsSubTab] = useState<ToolsSubTabId>("diagnostics");
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
  const lastOcrStatusSignatureRef = useRef("");
  const lastFooterScanKeyRef = useRef("");
  const scanTimingsRef = useRef<OcrScanTiming[]>([]);

  const selectedScene = useMemo(
    () => scenes.find((scene) => scene.id === selectedSceneId) ?? null,
    [scenes, selectedSceneId]
  );
  const selectedAutostartMode = sceneAutostart?.sceneId === selectedSceneId
    ? sceneAutostart.mode
    : null;
  const autostartTooltip = [
    t("ocr.sceneAndAreas.autostartHint"),
    `${t("launcher.scene.ocrNone")}: ${t("launcher.tooltips.ocrNone")}`,
    `${t("launcher.scene.ocrAuto")}: ${t("launcher.tooltips.ocrAuto")}`,
    `${t("launcher.scene.ocrManual")}: ${t("launcher.tooltips.ocrManual")}`
  ].join("\n\n");

  useEffect(() => {
    if (!selectedScene) {
      setSceneAutostart(null);
      return;
    }
    if (!active || savingAutostart) {
      return;
    }

    let cancelled = false;
    const loadAutostart = async () => {
      try {
        const profile = await invokeIpc<SceneLaunchProfile | null>(
          "settings.getSceneLaunchProfile",
          selectedScene
        );
        if (!cancelled) {
          setSceneAutostart({
            sceneId: selectedScene.id,
            mode: profile?.ocrMode ?? "none"
          });
        }
      } catch (error) {
        console.error("Failed to load OCR autostart settings:", error);
        if (!cancelled) {
          setSceneAutostart(null);
          setNotice({ type: "error", message: t("ocr.runtime.failedLoadAutostart") });
        }
      }
    };

    void loadAutostart();
    return () => {
      cancelled = true;
    };
  }, [active, selectedScene, savingAutostart, t]);

  const saveAutostart = useCallback(async (mode: SceneOcrMode) => {
    if (!selectedScene || selectedAutostartMode === null || savingAutostart) {
      return;
    }

    setSavingAutostart(true);
    try {
      // The save API replaces the profile, so preserve its latest non-OCR settings.
      const profile = await invokeIpc<SceneLaunchProfile | null>(
        "settings.getSceneLaunchProfile",
        selectedScene
      );
      const result = await invokeIpc<{ success: boolean }>(
        "settings.saveSceneLaunchProfile",
        {
          scene: selectedScene,
          textHookMode: profile?.textHookMode ?? "none",
          ocrMode: mode,
          launchOverlay: profile?.launchOverlay ?? false,
          agentScriptPath: profile?.agentScriptPath ?? "",
          launchDelaySeconds: profile?.launchDelaySeconds ?? 0
        }
      );
      if (!result?.success) {
        throw new Error("Failed to save scene launch profile");
      }
      setSceneAutostart({ sceneId: selectedScene.id, mode });
      setNotice({
        type: "success",
        message: t("launcher.status.savedScene", { scene: selectedScene.name })
      });
    } catch (error) {
      console.error("Failed to save OCR autostart settings:", error);
      setNotice({ type: "error", message: t("ocr.runtime.failedSaveAutostart") });
    } finally {
      setSavingAutostart(false);
    }
  }, [selectedScene, selectedAutostartMode, savingAutostart, t]);

  const configuredAreaCount = activeSceneAreaConfig?.rectangles?.length ?? 0;
  const hasConfiguredAreas = configuredAreaCount > 0;
  const effectiveScanRate = config.advancedMode
    ? config.advancedScanRate
    : config.basicScanRate;
  const effectiveMainEngine = config.advancedMode ? config.mainOcr : getBasicMainOcr(config.useOnlineOcr);
  const effectiveStabilityEngine = config.advancedMode
    ? config.stabilityOcr
    : getDefaultStabilityOcr(platform);
  const engineFlowLabel =
    (config.advancedMode && !config.twoPassOCR) || effectiveMainEngine === effectiveStabilityEngine
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
      : t("ocr.footer.areasRecommendedLabel");

  const sceneSummary = selectedScene?.name ?? t("ocr.footer.noSceneSelected");
  const scanSummary = config.advancedMode
    ? `${effectiveScanRate.toFixed(1)}s`
    : t(basicSpeedLabelKey(config.basicScanRate));
  const footerSummaryWhenIdle = configuredAreaCount === 1
    ? t("ocr.sceneAndAreas.areaCount", { count: configuredAreaCount })
    : t("ocr.sceneAndAreas.areaCountPlural", { count: configuredAreaCount });

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
      if (terminalElementRef.current?.clientWidth && terminalElementRef.current?.clientHeight) {
        fitAddonRef.current?.fit();
      }
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
        ...getTerminalColors(),
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
    const handleThemeChange = () => {
      terminal.options.theme = {
        ...getTerminalColors(),
        cursor: "transparent",
        cursorAccent: "transparent"
      };
    };

    terminalElementRef.current.addEventListener("contextmenu", handleContextMenu);
    window.addEventListener("resize", handleResize);
    window.addEventListener(THEME_CHANGED_EVENT, handleThemeChange);

    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener(THEME_CHANGED_EVENT, handleThemeChange);
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
  }, [active, workspaceView, fitTerminal]);

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

        if (nextSelectedSceneId !== selectedSceneId) setActiveSceneAreaConfig(null);
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
      const normalizedState: OcrRunningState = {
        isRunning: Boolean(nextState?.isRunning),
        source: nextState?.source,
        mode: nextState?.mode ?? null
      };
      setRunningState((current) =>
        ocrRunningStatesEqual(current, normalizedState) ? current : normalizedState
      );

      if (!nextState?.isRunning) {
        lastOcrStatusSignatureRef.current = "";
        lastFooterScanKeyRef.current = "";
        scanTimingsRef.current = [];
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

      if (
        trimmedLine.endsWith(":") &&
        engineKey &&
        !pausedRef.current &&
        !OCR_RUN_2_RECOGNIZED_PATTERN.test(trimmedLine)
      ) {
        const engineLabel = getEngineLabel(engineKey);
        const speed = trimmedLine.split(" in ")[1]?.split("s")[0]?.trim();
        const scanDurationSeconds = speed ? Number.parseFloat(speed) : Number.NaN;
        let displaySpeed = speed;
        if (Number.isFinite(scanDurationSeconds)) {
          const now = Date.now();
          const cutoff = now - OCR_SCAN_AVERAGE_WINDOW_MS;
          scanTimingsRef.current = [
            ...scanTimingsRef.current.filter(
              (entry) => entry.recordedAt >= cutoff
            ),
            {
              engineKey,
              recordedAt: now,
              durationSeconds: scanDurationSeconds
            }
          ];
          const engineTimings = scanTimingsRef.current.filter(
            (entry) => entry.engineKey === engineKey
          );
          const averageDuration =
            engineTimings.reduce(
              (sum, entry) => sum + entry.durationSeconds,
              0
            ) / engineTimings.length;
          displaySpeed = averageDuration.toFixed(3);
        }
        const currentConfig = configRef.current;
        const textResultEngineKey = currentConfig.advancedMode
          ? currentConfig.mainOcr
          : "glens";
        const usesSeparateTextResultEngine =
          !(currentConfig.advancedMode && !currentConfig.twoPassOCR) &&
          textResultEngineKey &&
          textResultEngineKey !== engineKey;
        const textResultSuffix = usesSeparateTextResultEngine
          ? ` and using ${getEngineLabel(textResultEngineKey)} for text results`
          : "";
        const nextRuntimeMessage = speed
          ? `Scanning with ${engineLabel} in ${displaySpeed}s${textResultSuffix}`
          : `Scanning with ${engineLabel}${textResultSuffix}`;
        const footerScanKey = `scan:${engineKey}:${nextRuntimeMessage}`;
        setRuntimeEngine((current) =>
          current === engineLabel ? current : engineLabel
        );
        if (lastFooterScanKeyRef.current !== footerScanKey) {
          lastFooterScanKeyRef.current = footerScanKey;
          setRuntimeMessage(nextRuntimeMessage);
        }
        return;
      }

      if (trimmedLine.includes("Seems like Text we already sent")) {
        if (previousLogLineRef.current) {
          appendTerminalLine(`\x1b[33m${previousLogLineRef.current} (Duplicate)\x1b[0m`);
        }
        return;
      }

      const isMenuOnlyLog = lowerLine.includes(MENU_ONLY_LOG_MESSAGE.toLowerCase());
      const isBlackHoleLog = lowerLine.includes(BLACK_HOLE_LOG_MESSAGE.toLowerCase());
      const nextTerminalLine = isMenuOnlyLog
        ? MENU_ONLY_CONSOLE_MESSAGE
        : isBlackHoleLog
          ? BLACK_HOLE_CONSOLE_MESSAGE
        : OCR_RUN_2_RECOGNIZED_PATTERN.test(trimmedLine)
          ? `\x1b[92m${trimmedLine}\x1b[0m`
          : replaceEngineLabelsWithAnsi(trimmedLine);

      appendTerminalLine(nextTerminalLine, {
        dedupeKey: isMenuOnlyLog
          ? MENU_ONLY_LOG_MESSAGE
          : isBlackHoleLog
            ? BLACK_HOLE_LOG_MESSAGE
            : undefined
      });
      previousLogLineRef.current = trimmedLine;
    });

    const offStarted = onIpc("ocr-started", () => {
      lastOcrStatusSignatureRef.current = "";
      lastFooterScanKeyRef.current = "";
      scanTimingsRef.current = [];
      setRunningState((current) =>
        current.isRunning ? current : { ...current, isRunning: true }
      );
      setPaused(false);
      setRuntimeMessage("Starting OCR...");
    });

    const offStopped = onIpc("ocr-stopped", () => {
      void refreshRunningState();
    });

    const offPaused = onIpc("ocr-ipc-paused", () => {
      lastFooterScanKeyRef.current = "";
      setPaused(true);
      setRuntimeMessage("Paused");
    });

    const offUnpaused = onIpc("ocr-ipc-unpaused", () => {
      lastFooterScanKeyRef.current = "";
      setPaused(false);
      setRuntimeMessage("Running");
    });

    const offStatus = onIpc("ocr-ipc-status", (_event, payload) => {
      const status = normalizeOcrStatusPayload(
        (payload ?? {}) as OcrStatusPayload,
        effectiveScanRate
      );
      if (lastOcrStatusSignatureRef.current === status.signature) {
        return;
      }
      lastOcrStatusSignatureRef.current = status.signature;
      lastFooterScanKeyRef.current = "";

      setPaused((current) => (current === status.paused ? current : status.paused));
      setRunningState((current) => {
        const nextState = {
          ...current,
          isRunning: true,
          mode: status.mode
        };
        return ocrRunningStatesEqual(current, nextState) ? current : nextState;
      });
      setRuntimeEngine((current) =>
        current === status.engineLabel ? current : status.engineLabel
      );

      if (status.paused) {
        setRuntimeMessage("Paused");
        return;
      }

      if (status.mode === "manual") {
        setRuntimeMessage(
          status.engineLabel
            ? `Running manual OCR with ${status.engineLabel}`
            : "Running manual OCR"
        );
        return;
      }

      setRuntimeMessage(
        status.engineLabel
          ? `Running auto OCR with ${status.engineLabel} at ${status.scanRate.toFixed(1)}s`
          : `Running auto OCR at ${status.scanRate.toFixed(1)}s`
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

  const customizedComparisonCount = useMemo(
    () =>
      COMPARISON_FIELDS.filter(
        (field) => config.comparison[field.key] !== COMPARISON_DEFAULTS[field.key]
      ).length,
    [config.comparison]
  );

  const resetComparisonDefaults = useCallback(() => {
    setConfig((current) => ({
      ...current,
      comparison: { ...COMPARISON_DEFAULTS }
    }));
  }, []);

  const switchScene = useCallback(
    async (sceneId: string) => {
      setActiveSceneAreaConfig(null);
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
      lastOcrStatusSignatureRef.current = "";
      lastFooterScanKeyRef.current = "";
      scanTimingsRef.current = [];
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
      lastOcrStatusSignatureRef.current = "";
      lastFooterScanKeyRef.current = "";
      scanTimingsRef.current = [];
      setRunningState((current) => {
        const nextState = { isRunning: false, mode: null };
        return ocrRunningStatesEqual(current, nextState) ? current : nextState;
      });
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

  const triggerManualOcr = useCallback(() => {
    sendIpc("ocr.manual-ocr");
  }, []);

  const triggerMenuOcr = useCallback(() => {
    sendIpc("ocr.menu-ocr");
  }, []);

  const triggerWholeWindowOcr = useCallback(() => {
    sendIpc("ocr.whole-window-ocr");
  }, []);

  const triggerAreaSelectOcr = useCallback(() => {
    sendIpc("ocr.area-select-ocr");
  }, []);

  const triggerAddOcrArea = useCallback(() => {
    sendIpc("ocr.add-area");
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

  const hotkeyActions: HotkeyActionDefinition[] = [
    {
      id: "manual",
      labelKey: "ocr.hotkeys.manual",
      tooltip: ocrTooltips.manualHotkey,
      hotkeyKey: "manualOcrHotkey",
      gamepadKey: "manualOcrGamepad",
      trigger: triggerManualOcr
    },
    {
      id: "menu",
      labelKey: "ocr.hotkeys.menu",
      tooltip: ocrTooltips.menuHotkey,
      hotkeyKey: "menuOcrHotkey",
      gamepadKey: "menuOcrGamepad",
      trigger: triggerMenuOcr
    },
    {
      id: "area",
      labelKey: "ocr.hotkeys.areaSelect",
      tooltip: ocrTooltips.areaSelectHotkey,
      hotkeyKey: "areaSelectOcrHotkey",
      gamepadKey: "areaSelectOcrGamepad",
      trigger: triggerAreaSelectOcr
    },
    {
      id: "add-area",
      labelKey: "ocr.hotkeys.addArea",
      tooltip: ocrTooltips.addAreaHotkey,
      hotkeyKey: "addAreaOcrHotkey",
      gamepadKey: "addAreaOcrGamepad",
      trigger: triggerAddOcrArea
    },
    {
      id: "whole-window",
      labelKey: "ocr.hotkeys.wholeWindow",
      tooltip: ocrTooltips.wholeWindowHotkey,
      hotkeyKey: "wholeWindowOcrHotkey",
      gamepadKey: "wholeWindowOcrGamepad",
      trigger: triggerWholeWindowOcr
    },
    {
      id: "pause",
      labelKey: "ocr.hotkeys.pause",
      tooltip: ocrTooltips.pauseHotkey,
      hotkeyKey: "globalPauseHotkey",
      gamepadKey: "globalPauseGamepad"
    }
  ];
  const configuredGamepadHotkeyCount = hotkeyActions.filter(
    (action) => config[action.gamepadKey]
  ).length;

  const usesTwoPassFlow =
    (!config.advancedMode || config.twoPassOCR) &&
    effectiveMainEngine !== effectiveStabilityEngine;

  return (
    <div className={"tab-panel " + (active ? "active" : "")}>
      <div className="ocr-desk">
        {notice ? (
          <div
            className={`ocr-toast ocr-toast--${notice.type}`}
            role="status"
            aria-live="polite"
          >
            <span>{notice.message}</span>
          </div>
        ) : null}

        <aside className="desk-sidebar">
          <div className="desk-brand">
            <span className="desk-brand-mark">
              <WorkspaceIcon name="capture" />
            </span>
            <div>
              <strong>{t("app.tabs.ocr")}</strong>
              <span>{t("ocr.desk.brandHint")}</span>
            </div>
          </div>
          <div className="desk-game">
            <div className="desk-target-game">
              <div className="input-group ocr-scene-row">
                <Tooltip text={ocrTooltips.scene}>
                  <label htmlFor="ocr-scene-select">{t("ocr.sceneAndAreas.sceneLabel")}</label>
                </Tooltip>
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
                      <option
                        key={scene.id}
                        value={scene.id}
                      >
                        {scene.name}
                      </option>
                    ))
                  )}
                </select>
                <Tooltip
                  text={ocrTooltips.refreshScenes}
                  align="center"
                >
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
                </Tooltip>
              </div>
            </div>
          </div>
          <nav
            className="desk-navigation"
            role="tablist"
            aria-orientation="vertical"
            aria-label={t("ocr.workspace.navigation")}
          >
            {OCR_WORKSPACE_VIEWS.map((view, index) => (
              <button
                key={view.id}
                type="button"
                role="tab"
                id={"ocr-nav-" + view.id}
                aria-selected={workspaceView === view.id}
                aria-controls={"ocr-view-" + view.id}
                tabIndex={
                  workspaceView === view.id ||
                  (workspaceView === "console" && lastWorkspaceView.current === view.id)
                    ? 0
                    : -1
                }
                onClick={() => setWorkspaceView(view.id)}
                onKeyDown={(event) =>
                  navigateWorkspaceTabs(
                    event,
                    OCR_WORKSPACE_VIEWS,
                    index,
                    setWorkspaceView,
                    "ocr-nav-"
                  )
                }
              >
                <WorkspaceIcon name={view.id} />
                <span>{t(view.labelKey)}</span>
              </button>
            ))}
          </nav>
          <div className={"desk-transport desk-transport--" + footerTone}>
            <div className="desk-transport-status">
              <i aria-hidden="true" />
              {footerStatusLabel}
            </div>
            <strong>{runtimeEngine || getEngineLabel(effectiveMainEngine)}</strong>
            <span>
              {runningState.isRunning
                ? t(runningState.mode === "manual" ? "ocr.desk.manualMode" : "ocr.desk.autoMode")
                : scanSummary}
            </span>
            <div className="desk-transport-actions">
              {runningState.isRunning ? (
                <>
                  <button
                    type="button"
                    className="danger"
                    data-tip={ocrTooltips.stop}
                    onClick={() => void stopOcr()}
                  >
                    {t("ocr.footer.stopOcr")}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    data-tip={paused ? ocrTooltips.resume : ocrTooltips.pause}
                    onClick={togglePause}
                  >
                    {paused ? t("ocr.footer.resumeOcr") : t("ocr.footer.pauseOcr")}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    data-tip={
                      hasConfiguredAreas
                        ? ocrTooltips.startAuto
                        : t("ocr.footer.areasRecommended", {
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
                    data-tip={
                      hasConfiguredAreas
                        ? ocrTooltips.startManual
                        : t("ocr.footer.areasRecommended", {
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
        </aside>

        <div className="desk-workspace">
          <header className="desk-page-header">
            <div>
              <span className="desk-eyebrow">{t("ocr.desk.workspace")}</span>
              <h1>
                {workspaceView === "capture"
                  ? sceneSummary
                  : workspaceView === "console"
                    ? t("ocr.console.title")
                    : t(OCR_WORKSPACE_VIEWS.find((view) => view.id === workspaceView)!.labelKey)}
              </h1>
              <p>{t("ocr.desk.viewHelp." + workspaceView)}</p>
            </div>
            <button
              type="button"
              className="desk-guide"
              {...tooltipProps(ocrTooltips.docs)}
              onClick={() => void openOcrDocs()}
            >
              <WorkspaceIcon name="help" />
              {t("ocr.sceneAndAreas.ocrGuide")}
            </button>
          </header>

          <div className="desk-pages">
            <section
              id="ocr-view-capture"
              role="tabpanel"
              aria-labelledby="ocr-nav-capture"
              hidden={workspaceView !== "capture"}
              className="desk-view desk-capture-view"
              tabIndex={0}
            >
              <div className="desk-capture-grid">
                <section className="desk-capture-layout">
                  <div className="desk-section-heading">
                    <div>
                      <h2>{t("ocr.desk.captureAreas")}</h2>
                      <span className="desk-muted">{footerSummaryWhenIdle}</span>
                    </div>
                    <button
                      type="button"
                      className="desk-primary"
                      disabled={loadingScenes || scenes.length === 0}
                      onClick={runScreenSelector}
                      {...tooltipProps(ocrTooltips.selectAreas)}
                    >
                      <WorkspaceIcon name="edit" />
                      {t("ocr.desk.editAreas")}
                    </button>
                  </div>
                  <OCRCaptureMap
                    config={activeSceneAreaConfig}
                    disabled={loadingScenes || scenes.length === 0}
                    onEdit={runScreenSelector}
                    active={active && workspaceView === "capture"}
                    scene={selectedScene}
                    ocrRunning={runningState.isRunning}
                  />
                  <div className="desk-area-tools">
                    <button
                      type="button"
                      disabled={loadingScenes || scenes.length === 0}
                      {...tooltipProps(ocrTooltips.importAreas)}
                      onClick={() => void importAreaConfig()}
                    >
                      <WorkspaceIcon name="import" />
                      {t("ocr.sceneAndAreas.importAreas")}
                    </button>
                    <button
                      type="button"
                      disabled={loadingScenes || scenes.length === 0}
                      {...tooltipProps(ocrTooltips.exportAreas)}
                      onClick={() => void exportAreaConfig()}
                    >
                      <WorkspaceIcon name="export" />
                      {t("ocr.sceneAndAreas.exportAreas")}
                    </button>
                    <button
                      type="button"
                      disabled={!runningState.isRunning}
                      {...tooltipProps(ocrTooltips.addAreaHotkey)}
                      onClick={triggerAddOcrArea}
                    >
                      <WorkspaceIcon name="add" />
                      {t("ocr.hotkeys.addArea")}
                    </button>
                  </div>
                </section>
                <aside className="desk-session-settings">
                  <h2>{t("ocr.desk.thisSession")}</h2>
                  <dl>
                    <div>
                      <dt>{t("ocr.desk.engine")}</dt>
                      <dd>{getEngineLabel(effectiveMainEngine)}</dd>
                    </div>
                    {usesTwoPassFlow ? (
                      <div>
                        <dt>{t("ocr.desk.stability")}</dt>
                        <dd>{getEngineLabel(effectiveStabilityEngine)}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>{t("ocr.settings.language")}</dt>
                      <dd>{t("ocr.languages." + config.language)}</dd>
                    </div>
                    <div>
                      <dt>{t("ocr.settings.scanSpeed")}</dt>
                      <dd>{scanSummary}</dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    className="desk-text-button"
                    onClick={() => openWorkspace("recognition")}
                  >
                    {t("ocr.desk.adjustRecognition")}
                    <span aria-hidden="true">→</span>
                  </button>
                  <div className="desk-autostart">
                    <div
                      className="input-group tooltip-trigger tooltip-trigger--start"
                      {...tooltipProps(autostartTooltip)}
                    >
                      <label htmlFor="ocr-autostart-mode">{t("ocr.sceneAndAreas.autostart")}</label>
                      <select
                        id="ocr-autostart-mode"
                        aria-description={autostartTooltip}
                        value={selectedAutostartMode ?? "none"}
                        disabled={
                          loadingScenes || selectedAutostartMode === null || savingAutostart
                        }
                        onChange={(event) => {
                          void saveAutostart(event.target.value as SceneOcrMode);
                        }}
                      >
                        <option value="none">{t("launcher.scene.ocrNone")}</option>
                        <option value="auto">{t("launcher.scene.ocrAuto")}</option>
                        <option value="manual">{t("launcher.scene.ocrManual")}</option>
                      </select>
                    </div>
                  </div>
                </aside>
              </div>
              {!loadingScenes && scenes.length === 0 ? (
                <p className="desk-empty-hint">{t("ocr.sceneAndAreas.noScenesHint")}</p>
              ) : null}

              <section className="desk-quick-capture">
                <div className="desk-section-heading">
                  <div>
                    <h2>{t("ocr.workspace.quickCapture")}</h2>
                    <p>
                      {t(
                        runningState.isRunning
                          ? "ocr.workspace.quickCaptureHint"
                          : "ocr.workspace.startToCapture"
                      )}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="desk-text-button"
                    onClick={() => openWorkspace("shortcuts")}
                  >
                    {t("ocr.desk.editShortcuts")}
                    <span aria-hidden="true">→</span>
                  </button>
                </div>
                <div className="desk-quick-actions">
                  {hotkeyActions
                    .filter((action) => action.trigger && action.id !== "add-area")
                    .map((action) => (
                      <button
                        key={action.id}
                        type="button"
                        disabled={!runningState.isRunning}
                        aria-label={t(action.labelKey)}
                        {...tooltipProps(action.tooltip)}
                        onClick={action.trigger}
                      >
                        <WorkspaceIcon name={action.id} />
                        <span>{t(action.labelKey)}</span>
                        <kbd>{config[action.hotkeyKey] || t("ocr.desk.unbound")}</kbd>
                      </button>
                    ))}
                </div>
              </section>
            </section>

            <section
              id="ocr-view-recognition"
              role="tabpanel"
              aria-labelledby="ocr-nav-recognition"
              hidden={workspaceView !== "recognition"}
              className="desk-view"
              tabIndex={0}
            >
              <div className="desk-recognition-top">
                <div>
                  <h2>{t("ocr.workspace.scanSettings")}</h2>
                  <p>{engineFlowLabel}</p>
                </div>
                <label
                  className="desk-advanced-toggle"
                  htmlFor="ocr-advanced-toggle"
                  {...tooltipProps(ocrTooltips.advancedMode)}
                >
                  <input
                    id="ocr-advanced-toggle"
                    type="checkbox"
                    checked={config.advancedMode}
                    onChange={(event) =>
                      setConfig((current) => ({ ...current, advancedMode: event.target.checked }))
                    }
                  />
                  <span>{t("ocr.settings.advanced")}</span>
                </label>
              </div>
              <div className="desk-recognition-form">
                <div className="desk-field-grid">
                  {config.advancedMode ? (
                    <div className="input-group">
                      <label
                        htmlFor="ocr-advanced-scan-rate"
                        {...tooltipProps(ocrTooltips.advancedScanRate)}
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
                        {...tooltipProps(ocrTooltips.basicScanRate)}
                      >
                        {t("ocr.settings.scanSpeed")}
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
                          <option
                            key={option.value}
                            value={option.value}
                          >
                            {t(option.labelKey)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="input-group">
                    <label
                      htmlFor="ocr-language"
                      {...tooltipProps(ocrTooltips.language)}
                    >
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
                        <option
                          key={option.value}
                          value={option.value}
                        >
                          {t("ocr.languages." + option.value)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {!config.advancedMode && (
                  <div className="ocr-linebreak-row ocr-online-scans">
                    <label
                      htmlFor="ocr-online-scans"
                      className="ocr-instant-toggle"
                    >
                      <input
                        id="ocr-online-scans"
                        type="checkbox"
                        checked={config.useOnlineOcr}
                        aria-describedby="ocr-online-scans-help"
                        onChange={(event) =>
                          setConfig((current) => ({
                            ...current,
                            useOnlineOcr: event.target.checked
                          }))
                        }
                      />
                      <span className="ocr-linebreak-label">{t("ocr.settings.onlineScans")}</span>
                    </label>
                    <small id="ocr-online-scans-help">{t("ocr.settings.onlineScansHelp")}</small>
                  </div>
                )}

                {config.advancedMode ? (
                  <div className="ocr-pipeline-section">
                    <h3
                      className="ocr-pipeline-heading"
                      {...tooltipProps(ocrTooltips.advancedRecognition)}
                    >
                      {t("ocr.pipeline.title")}
                    </h3>
                    <div className="ocr-pipeline-grid">
                      <div className="input-group ocr-pipeline-control ocr-pipeline-control--toggle">
                        <label
                          htmlFor="ocr-two-pass"
                          {...tooltipProps(ocrTooltips.twoPassOCR)}
                        >
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
                        <div className="input-group ocr-pipeline-control ocr-engine-control">
                          <label
                            htmlFor="ocr-stability-engine"
                            {...tooltipProps(ocrTooltips.stabilityOcr)}
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
                              <option
                                key={option.value}
                                value={option.value}
                              >
                                {t("ocr.engines." + option.value)}
                              </option>
                            ))}
                          </select>
                        </div>
                      ) : null}

                      <div className="input-group ocr-pipeline-control ocr-engine-control">
                        <label
                          htmlFor="ocr-main-engine"
                          {...tooltipProps(ocrTooltips.mainOcr)}
                        >
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
                            <option
                              key={option.value}
                              value={option.value}
                            >
                              {t("ocr.engines." + option.value)}
                            </option>
                          ))}
                        </select>
                      </div>

                      {config.twoPassOCR ? (
                        <div className="input-group ocr-pipeline-control ocr-pipeline-control--toggle">
                          <label
                            htmlFor="ocr-optimize-second-scan"
                            {...tooltipProps(ocrTooltips.optimizeSecondScan)}
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
                          {...tooltipProps(ocrTooltips.ocrScreenshots)}
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
                ) : null}

                <div className="desk-recognition-tuning">
                  <div className="desk-field-grid">
                    <div className="ocr-slider-field">
                      <div className="ocr-slider-header">
                        <label
                          htmlFor="ocr-furigana-filter"
                          {...tooltipProps(ocrTooltips.furiganaFilter)}
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
                          {...tooltipProps(ocrTooltips.furiganaPreview)}
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

                    <div className="input-group">
                      <label
                        htmlFor="default-furigana-sensitivity"
                        {...tooltipProps(ocrTooltips.defaultSceneFurigana)}
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
                  </div>
                  <div className="ocr-linebreak-row ocr-linebreak-row--warning">
                    <label
                      className="ocr-instant-toggle"
                      htmlFor="ocr-text-appears-instantly"
                      {...tooltipProps(ocrTooltips.textAppearsInstantly)}
                    >
                      <input
                        id="ocr-text-appears-instantly"
                        type="checkbox"
                        checked={config.textAppearsInstantly}
                        disabled={config.advancedMode && !config.twoPassOCR}
                        onChange={(event) => {
                          setConfig((current) => ({
                            ...current,
                            textAppearsInstantly: event.target.checked
                          }));
                        }}
                      />
                      <span className="ocr-instant-copy">
                        <span className="ocr-linebreak-label ocr-instant-label">
                          <span>{t("ocr.settings.textAppearsInstantly")}</span>
                          <span className="ocr-instant-qualifier">
                            (
                            <span
                              className="ocr-warning-icon"
                              aria-hidden="true"
                            >
                              ⚠
                            </span>
                            <span>{t("ocr.settings.textAppearsInstantlyQualifier")}</span>)
                          </span>
                        </span>
                      </span>
                    </label>
                  </div>
                </div>
              </div>
            </section>

            <section
              id="ocr-view-filtering"
              role="tabpanel"
              aria-labelledby="ocr-nav-filtering"
              hidden={workspaceView !== "filtering"}
              className="desk-view"
              tabIndex={0}
            >
              <div className="desk-recognition-layout">
                <div className="desk-capture-settings">
                  <div className="desk-section-heading">
                    <div>
                      <h2>{t("ocr.workspace.imageSettings")}</h2>
                    </div>
                  </div>

                  <div className="desk-slider-grid">
                    <div className="ocr-slider-field">
                      <div className="ocr-slider-header">
                        <label
                          htmlFor="ocr-base-scale"
                          {...tooltipProps(ocrTooltips.baseScale)}
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
                      <div className="desk-scale-presets">
                        {[0.5, 0.75, 1].map((scale) => (
                          <button
                            key={scale}
                            type="button"
                            className={
                              "desk-preset-chip" +
                              (Math.abs(config.baseScale - scale) < 0.01 ? " is-active" : "")
                            }
                            onClick={() =>
                              setConfig((current) => ({
                                ...current,
                                baseScale: scale
                              }))
                            }
                          >
                            {Math.round(scale * 100)}%
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="desk-field-grid desk-preprocess-grid">
                    <div className="input-group">
                      <label
                        htmlFor="obs-preprocess"
                        {...tooltipProps(ocrTooltips.obsCapturePreprocess)}
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
                          <option
                            key={option.value}
                            value={option.value}
                          >
                            {t("ocr.preprocess." + option.value)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="desk-toggle-row-group">
                    <div className="desk-compact-boxes-row">
                      <label
                        className="ocr-instant-toggle"
                        htmlFor="compact-boxes"
                        {...tooltipProps(ocrTooltips.compactBoxes)}
                      >
                        <input
                          id="compact-boxes"
                          type="checkbox"
                          checked={config.compactBoxes}
                          onChange={(event) => {
                            setConfig((current) => ({
                              ...current,
                              compactBoxes: event.target.checked
                            }));
                          }}
                        />
                        <span className="ocr-linebreak-label">{t("ocr.debug.compactBoxes")}</span>
                      </label>

                      {config.compactBoxes && (
                        <div className="desk-compact-gap-field">
                          <label
                            htmlFor="compact-boxes-gap"
                            {...tooltipProps(ocrTooltips.compactBoxesGap)}
                          >
                            {t("ocr.debug.compactBoxesGap")}
                          </label>
                          <input
                            id="compact-boxes-gap"
                            type="number"
                            min={0}
                            max={512}
                            step={1}
                            value={config.compactBoxesGap}
                            onChange={(event) => {
                              setConfig((current) => ({
                                ...current,
                                compactBoxesGap: integerValue(event.target.value, 12)
                              }));
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <aside className="desk-side">
                  <section className="desk-output">
                    <h2>{t("ocr.workspace.textOutput")}</h2>
                    <table
                      className="desk-output-table"
                      aria-label={t("ocr.workspace.textOutput")}
                    >
                      <thead>
                        <tr>
                          <th scope="col">{t("ocr.hotkeys.action")}</th>
                          <th
                            scope="col"
                            {...tooltipProps(ocrTooltips.sendToClipboard)}
                          >
                            {t("ocr.workspace.copyText")}
                          </th>
                          <th
                            scope="col"
                            {...tooltipProps(ocrTooltips.keepNewline)}
                          >
                            {t("ocr.workspace.lineBreaks")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {OCR_OUTPUT_MODES.map((mode) => (
                          <tr key={mode.id}>
                            <th scope="row">{t(mode.labelKey)}</th>
                            <td>
                              <input
                                id={"send-to-clipboard-" + mode.id}
                                type="checkbox"
                                aria-label={t("ocr.workspace.copyMode", {
                                  mode: t(mode.labelKey)
                                })}
                                {...tooltipProps(ocrTooltips[mode.clipboardKey])}
                                checked={config[mode.clipboardKey]}
                                onChange={(event) =>
                                  setConfig((current) => ({
                                    ...current,
                                    [mode.clipboardKey]: event.target.checked
                                  }))
                                }
                              />
                            </td>
                            <td>
                              <input
                                id={"keep-newline-" + mode.id}
                                type="checkbox"
                                aria-label={t("ocr.workspace.lineBreaksMode", {
                                  mode: t(mode.labelKey)
                                })}
                                {...tooltipProps(ocrTooltips[mode.newlineKey])}
                                checked={config[mode.newlineKey]}
                                onChange={(event) =>
                                  setConfig((current) => ({
                                    ...current,
                                    [mode.newlineKey]: event.target.checked
                                  }))
                                }
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                </aside>
              </div>
            </section>

            <section
              id="ocr-view-comparison"
              role="tabpanel"
              aria-labelledby="ocr-nav-comparison"
              hidden={workspaceView !== "comparison"}
              className="desk-view"
              tabIndex={0}
            >
              <section className="desk-comparison">
                <div className="ocr-card-header-row desk-subtab-header">
                  <div className="desk-subtab-controls">
                    <div
                      className="desk-subtablist"
                      role="tablist"
                      aria-label={t("ocr.comparison.title")}
                    >
                      {OCR_COMPARISON_TABS.map((subTab, index) => (
                        <button
                          key={subTab.id}
                          type="button"
                          role="tab"
                          id={"ocr-comp-tab-" + subTab.id}
                          aria-selected={comparisonSubTab === subTab.id}
                          aria-controls={"ocr-comp-panel-" + subTab.id}
                          tabIndex={comparisonSubTab === subTab.id ? 0 : -1}
                          onClick={() => setComparisonSubTab(subTab.id)}
                          onKeyDown={(event) =>
                            navigateWorkspaceTabs(
                              event,
                              OCR_COMPARISON_TABS,
                              index,
                              setComparisonSubTab,
                              "ocr-comp-tab-"
                            )
                          }
                        >
                          {t(subTab.labelKey)}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="secondary desk-reset-btn"
                      disabled={customizedComparisonCount === 0}
                      onClick={resetComparisonDefaults}
                    >
                      {t("ocr.workspace.resetDefaults")}
                    </button>
                  </div>
                </div>

                {(
                  [
                    ["primary", COMPARISON_LAYOUT.primary],
                    ["truncation", COMPARISON_LAYOUT.truncation],
                    ["subset", COMPARISON_LAYOUT.subset]
                  ] as const
                ).map(([groupKey, fields]) => (
                  <div
                    key={groupKey}
                    id={"ocr-comp-panel-" + groupKey}
                    role="tabpanel"
                    aria-labelledby={"ocr-comp-tab-" + groupKey}
                    hidden={comparisonSubTab !== groupKey}
                    className="desk-comparison-grid"
                  >
                    {fields.map((field) => {
                      const currentValue = config.comparison[field.key];
                      const isModified = currentValue !== COMPARISON_DEFAULTS[field.key];

                      return (
                        <div
                          key={field.key}
                          className={"ocr-comparison-field" + (isModified ? " is-modified" : "")}
                        >
                          <div className="ocr-comparison-field-top">
                            <label
                              htmlFor={`comparison-${field.key}`}
                              {...tooltipProps(t(field.titleKey))}
                            >
                              {t(field.labelKey)}
                            </label>
                            <input
                              id={`comparison-${field.key}`}
                              type="number"
                              min={field.min}
                              max={field.max}
                              step={field.step}
                              value={currentValue}
                              onChange={(event) => {
                                setComparisonValue(
                                  field.key,
                                  numericValue(event.target.value, COMPARISON_DEFAULTS[field.key])
                                );
                              }}
                            />
                          </div>
                          {field.max <= 100 ? (
                            <input
                              type="range"
                              aria-hidden="true"
                              tabIndex={-1}
                              min={field.min}
                              max={field.max}
                              step={field.step}
                              value={currentValue}
                              onChange={(event) => {
                                setComparisonValue(
                                  field.key,
                                  numericValue(event.target.value, COMPARISON_DEFAULTS[field.key])
                                );
                              }}
                            />
                          ) : null}
                          <small className="ocr-comparison-hint">{t(field.titleKey)}</small>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </section>
            </section>

            <section
              id="ocr-view-shortcuts"
              role="tabpanel"
              aria-labelledby="ocr-nav-shortcuts"
              hidden={workspaceView !== "shortcuts"}
              className="desk-view"
              tabIndex={0}
            >
              <section className="desk-shortcuts">
                <div className="ocr-card-header-row ocr-hotkey-card-header">
                  <p className="desk-shortcut-help">{t("ocr.desk.shortcutHelp")}</p>
                  <button
                    type="button"
                    className="secondary ocr-gamepad-toggle"
                    aria-expanded={config.gamepadHotkeysEnabled}
                    aria-controls="ocr-gamepad-bindings"
                    onClick={() => {
                      setConfig((current) => ({
                        ...current,
                        gamepadHotkeysEnabled: !current.gamepadHotkeysEnabled
                      }));
                    }}
                  >
                    {t(
                      config.gamepadHotkeysEnabled
                        ? "ocr.hotkeys.disableGamepad"
                        : "ocr.hotkeys.enableGamepad",
                      { count: configuredGamepadHotkeyCount }
                    )}
                  </button>
                </div>
                <div
                  id="ocr-gamepad-bindings"
                  className={`form-group ocr-form-group ocr-hotkey-grid${
                    config.gamepadHotkeysEnabled ? " ocr-hotkey-grid--gamepad-visible" : ""
                  }`}
                >
                  <div
                    className="ocr-hotkey-columns"
                    aria-hidden="true"
                  >
                    <span>{t("ocr.hotkeys.action")}</span>
                    <span>{t("ocr.hotkeys.keyboard")}</span>
                    {config.gamepadHotkeysEnabled ? <span>{t("ocr.hotkeys.gamepad")}</span> : null}
                    <span />
                  </div>
                  {hotkeyActions.map((action) => {
                    const actionLabel = t(action.labelKey);
                    const hotkeyInputId = `${action.id}-hotkey`;
                    const gamepadInputId = `${action.id}-gamepad-hotkey`;

                    return (
                      <div
                        className="ocr-hotkey-item"
                        key={action.id}
                      >
                        <div className="ocr-hotkey-item-header">
                          <h3
                            id={action.id + "-action-label"}
                            {...tooltipProps(action.tooltip)}
                          >
                            {actionLabel}
                          </h3>
                        </div>
                        <div className="ocr-hotkey-bindings">
                          <label
                            className="ocr-hotkey-binding"
                            htmlFor={hotkeyInputId}
                          >
                            <span id={action.id + "-keyboard-label"}>
                              {t("ocr.hotkeys.keyboard")}
                            </span>
                            <input
                              id={hotkeyInputId}
                              type="text"
                              readOnly
                              placeholder={t("ocr.desk.unbound")}
                              aria-labelledby={
                                action.id + "-action-label " + action.id + "-keyboard-label"
                              }
                              value={config[action.hotkeyKey]}
                              onKeyDown={(event) => {
                                const next = captureHotkey(event);
                                setConfig((current) => ({
                                  ...current,
                                  [action.hotkeyKey]: next
                                }));
                              }}
                            />
                          </label>
                          {config.gamepadHotkeysEnabled ? (
                            <label
                              className="ocr-hotkey-binding"
                              htmlFor={gamepadInputId}
                            >
                              <span>{t("ocr.hotkeys.gamepad")}</span>
                              <select
                                id={gamepadInputId}
                                className="ocr-gamepad-hotkey"
                                value={config[action.gamepadKey]}
                                aria-label={t("ocr.hotkeys.gamepadBindingAria", {
                                  action: actionLabel
                                })}
                                data-tip={t("ocr.hotkeys.gamepadBindingTitle")}
                                onChange={(event) => {
                                  setConfig((current) => ({
                                    ...current,
                                    [action.gamepadKey]: event.target.value
                                  }));
                                }}
                              >
                                {GAMEPAD_HOTKEY_OPTIONS.map((option) => (
                                  <option
                                    key={option.value}
                                    value={option.value}
                                  >
                                    {t(option.labelKey)}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : null}
                        </div>
                        {action.id === "manual" ? (
                          <div className="ocr-manual-delay-settings">
                            <label
                              className="ocr-hotkey-binding"
                              htmlFor="manual-ocr-delay-ms"
                              {...tooltipProps(t("ocr.tooltips.manualDelay"))}
                            >
                              <span>{t("ocr.hotkeys.manualDelay")}</span>
                              <input
                                id="manual-ocr-delay-ms"
                                type="number"
                                min="0"
                                step="50"
                                value={config.manualOcrDelayMs}
                                onChange={(event) => {
                                  setConfig((current) => ({
                                    ...current,
                                    manualOcrDelayMs: Math.max(
                                      0,
                                      integerValue(event.target.value, 0)
                                    )
                                  }));
                                }}
                              />
                            </label>
                            {config.gamepadHotkeysEnabled ? (
                              <label
                                className="checkbox-label ocr-manual-delay-gamepad-only"
                                htmlFor="manual-ocr-delay-gamepad-only"
                                {...tooltipProps(t("ocr.tooltips.manualDelayGamepadOnly"))}
                              >
                                <input
                                  id="manual-ocr-delay-gamepad-only"
                                  type="checkbox"
                                  checked={config.manualOcrDelayGamepadOnly}
                                  onChange={(event) => {
                                    setConfig((current) => ({
                                      ...current,
                                      manualOcrDelayGamepadOnly: event.target.checked
                                    }));
                                  }}
                                />
                                <span>{t("ocr.hotkeys.manualDelayGamepadOnly")}</span>
                              </label>
                            ) : null}
                          </div>
                        ) : null}
                        {action.trigger ? (
                          <button
                            type="button"
                            className="secondary ocr-hotkey-run"
                            disabled={!runningState.isRunning}
                            aria-labelledby={
                              action.id + "-run-label " + action.id + "-action-label"
                            }
                            data-tip={t("ocr.hotkeys.runActionTitle")}
                            onClick={action.trigger}
                          >
                            <span id={action.id + "-run-label"}>{t("ocr.hotkeys.runAction")}</span>
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            </section>

            <section
              id="ocr-view-tools"
              role="tabpanel"
              aria-labelledby="ocr-nav-tools"
              hidden={workspaceView !== "tools"}
              className="desk-view"
              tabIndex={0}
            >
              <section className="desk-tools">
                <div className="ocr-card-header-row desk-subtab-header">
                  <div
                    className="desk-subtablist"
                    role="tablist"
                    aria-label={t("ocr.debug.title")}
                  >
                    {OCR_TOOLS_TABS.map((subTab, index) => (
                      <button
                        key={subTab.id}
                        type="button"
                        role="tab"
                        id={"ocr-tools-tab-" + subTab.id}
                        aria-selected={toolsSubTab === subTab.id}
                        aria-controls={"ocr-tools-panel-" + subTab.id}
                        tabIndex={toolsSubTab === subTab.id ? 0 : -1}
                        onClick={() => setToolsSubTab(subTab.id)}
                        onKeyDown={(event) =>
                          navigateWorkspaceTabs(
                            event,
                            OCR_TOOLS_TABS,
                            index,
                            setToolsSubTab,
                            "ocr-tools-tab-"
                          )
                        }
                      >
                        {t(subTab.labelKey)}
                      </button>
                    ))}
                  </div>
                </div>

                <div
                  id="ocr-tools-panel-diagnostics"
                  role="tabpanel"
                  aria-labelledby="ocr-tools-tab-diagnostics"
                  hidden={toolsSubTab !== "diagnostics"}
                  className="form-group ocr-form-group ocr-details-body desk-tools-panel"
                >
                  <div className="input-group">
                    <label
                      htmlFor="process-priority"
                      {...tooltipProps(ocrTooltips.processPriority)}
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
                        <option
                          key={option.value}
                          value={option.value}
                        >
                          {t("ocr.priorities." + option.value)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="desk-tools-toggles">
                    <div className="input-group">
                      <label
                        htmlFor="advanced-debug-logging"
                        {...tooltipProps(ocrTooltips.advancedDebugLogging)}
                      >
                        {t("ocr.debug.advancedDebugLogging")}
                      </label>
                      <input
                        id="advanced-debug-logging"
                        type="checkbox"
                        checked={config.advancedDebugLogging}
                        onChange={(event) => {
                          setConfig((current) => ({
                            ...current,
                            advancedDebugLogging: event.target.checked
                          }));
                        }}
                      />
                    </div>

                    <div className="input-group">
                      <label
                        htmlFor="ignore-ocr-run-1"
                        {...tooltipProps(ocrTooltips.ignoreRun1Logs)}
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
                  </div>
                </div>

                <div
                  id="ocr-tools-panel-packages"
                  role="tabpanel"
                  aria-labelledby="ocr-tools-tab-packages"
                  hidden={toolsSubTab !== "packages"}
                  className="form-group ocr-form-group ocr-details-body desk-tools-panel"
                >
                  <div className="input-group wrap">
                    <label
                      htmlFor="dep-install"
                      {...tooltipProps(ocrTooltips.installDependency)}
                    >
                      {t("ocr.debug.installDependency")}
                    </label>
                    <select
                      id="dep-install"
                      value={installDependency}
                      onChange={(event) => setInstallDependency(event.target.value)}
                    >
                      {DEPENDENCY_INSTALL_OPTIONS.map((option) => (
                        <option
                          key={option.value}
                          value={option.value}
                        >
                          {t(DEPENDENCY_INSTALL_LABEL_KEYS[option.value])}
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
                      {...tooltipProps(ocrTooltips.uninstallDependency)}
                    >
                      {t("ocr.debug.removeDependency")}
                    </label>
                    <select
                      id="dep-remove"
                      value={removeDependency}
                      onChange={(event) => setRemoveDependency(event.target.value)}
                    >
                      {DEPENDENCY_REMOVE_OPTIONS.map((option) => (
                        <option
                          key={option.value}
                          value={option.value}
                        >
                          {t(DEPENDENCY_REMOVE_LABEL_KEYS[option.value])}
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
                </div>

                <div
                  id="ocr-tools-panel-files"
                  role="tabpanel"
                  aria-labelledby="ocr-tools-tab-files"
                  hidden={toolsSubTab !== "files"}
                  className="form-group ocr-form-group ocr-details-body desk-tools-panel"
                >
                  <div className="link-row desk-files-grid">
                    <button
                      type="button"
                      className="secondary"
                      {...tooltipProps(ocrTooltips.replacements)}
                      onClick={openOcrReplacementsPage}
                    >
                      {t("ocr.debug.ocrErrorFixes")}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      {...tooltipProps(ocrTooltips.openConfigFile)}
                      onClick={() => void invokeIpc("ocr.open-config-json")}
                    >
                      {t("ocr.debug.configFile")}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      {...tooltipProps(ocrTooltips.openConfigFolder)}
                      onClick={() => void invokeIpc("ocr.open-config-folder")}
                    >
                      {t("ocr.debug.configFolder")}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      {...tooltipProps(ocrTooltips.openGlobalConfig)}
                      onClick={() => void invokeIpc("ocr.open-global-owocr-config")}
                    >
                      {t("ocr.debug.globalConfig")}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      {...tooltipProps(ocrTooltips.openTempFolder)}
                      onClick={() => void invokeIpc("ocr.open-temp-folder")}
                    >
                      {t("ocr.debug.tempFolder")}
                    </button>
                  </div>
                </div>
              </section>
            </section>

            <section
              id="ocr-view-console"
              role="tabpanel"
              aria-labelledby="ocr-console-toggle"
              hidden={workspaceView !== "console"}
              className="desk-console-view"
              tabIndex={-1}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  toggleConsole();
                }
              }}
            >
              <div className="desk-console-toolbar">
                <span className={"desk-console-state desk-console-state--" + footerTone}>
                  <i aria-hidden="true" />
                  {t(
                    runningState.isRunning
                      ? paused
                        ? "ocr.console.paused"
                        : "ocr.console.active"
                      : "ocr.console.idle"
                  )}
                </span>
                <div>
                  <button
                    type="button"
                    {...tooltipProps(ocrTooltips.clearConsole)}
                    onClick={clearTerminal}
                  >
                    {t("ocr.console.clear")}
                  </button>
                  <button
                    type="button"
                    onClick={toggleConsole}
                  >
                    {t("ocr.desk.closeConsole")}
                    <span aria-hidden="true">×</span>
                  </button>
                </div>
              </div>
              <div
                id="ocr-console-output"
                ref={terminalElementRef}
                className="ocr-terminal-surface"
              />
            </section>
          </div>

          <footer className="desk-statusbar">
            <div
              className={"desk-runtime desk-runtime--" + footerTone}
              role="status"
            >
              <i aria-hidden="true" />
              <span>{runningState.isRunning ? runtimeMessage : t("ocr.desk.settingsSaved")}</span>
            </div>
            <button
              id="ocr-console-toggle"
              type="button"
              className={workspaceView === "console" ? "is-active" : ""}
              aria-expanded={workspaceView === "console"}
              aria-controls="ocr-view-console"
              onClick={toggleConsole}
            >
              <WorkspaceIcon name="console" />
              {t("ocr.console.title")}
              <span aria-hidden="true">{workspaceView === "console" ? "−" : "+"}</span>
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
