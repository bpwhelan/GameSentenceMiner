import {
  createDefaultHoshidictsAudioProfile,
  createDefaultHoshidictsFieldOverwriteModes,
  createDefaultHoshidictsPopupButtons,
  DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
  DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY,
  DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_DICTIONARY,
  DEFAULT_HOSHIDICTS_HIDE_POPUP_GRAMMAR_TAGS,
  DEFAULT_HOSHIDICTS_DEFINITION_BLUR,
  DEFAULT_HOSHIDICTS_MAX_RESULTS,
  DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
  DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
  DEFAULT_HOSHIDICTS_POPUP_COLUMNS,
  DEFAULT_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH,
  DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT,
  DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION,
  DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
  DEFAULT_HOSHIDICTS_ONLY_SCAN_JAPANESE_TEXT,
  DEFAULT_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED,
  DEFAULT_HOSHIDICTS_SCAN_LENGTH,
  DEFAULT_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY,
  DEFAULT_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY_ORDER,
  DEFAULT_HOSHIDICTS_THEME,
  HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS,
  HOSHIDICTS_DUPLICATE_BEHAVIORS,
  HOSHIDICTS_DUPLICATE_SCOPES,
  HOSHIDICTS_FIELD_OVERWRITE_MODES,
  HOSHIDICTS_MINING_FIELD_MARKERS,
  isHoshidictsActivationKey,
  isHoshidictsAudioSourceType,
  isHoshidictsPopupToolbarPosition,
  isHoshidictsTheme,
  MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
  MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
  MAX_HOSHIDICTS_MAX_RESULTS,
  MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
  MAX_HOSHIDICTS_POPUP_HEIGHT_PX,
  MAX_HOSHIDICTS_POPUP_COLUMNS,
  MAX_HOSHIDICTS_POPUP_OPACITY_PERCENT,
  MAX_HOSHIDICTS_POPUP_WIDTH_PX,
  MAX_HOSHIDICTS_SCAN_LENGTH,
  MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
  MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
  MIN_HOSHIDICTS_MAX_RESULTS,
  MIN_HOSHIDICTS_POPUP_HEIGHT_PX,
  MIN_HOSHIDICTS_POPUP_COLUMNS,
  MIN_HOSHIDICTS_POPUP_OPACITY_PERCENT,
  MIN_HOSHIDICTS_POPUP_WIDTH_PX,
  MIN_HOSHIDICTS_SCAN_LENGTH,
  normalizeHoshidictsPopupButtons,
  parseHoshidictsCustomDictionary,
  type HoshidictsActivationKey,
  type HoshidictsAudioProfile,
  type HoshidictsAudioSource,
  type HoshidictsDesktopSnapshot,
  type HoshidictsDictionaryTabGroup,
  type HoshidictsFrequencyMode,
  type HoshidictsFieldOverwriteMode,
  type HoshidictsFieldOverwriteModes,
  type HoshidictsMiningFieldName,
  type HoshidictsMiningFieldMarker,
  type HoshidictsMiningFields,
  type HoshidictsMiningOptions,
  type HoshidictsMiningProfile,
  type HoshidictsProgressPhase,
  type HoshidictsRecommendedDictionaryId,
  type HoshidictsReaderPreferences,
  type HoshidictsSchedule
} from "../../../../shared/features/hoshidicts";

export type HoshidictsView = "dictionaries" | "custom" | "audio" | "mining";
export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";
export type MiningField = HoshidictsMiningFieldName;
export type MiningProfileDraft = Omit<HoshidictsMiningProfile, "tags"> & {
  tags: string;
};

export type MiningFieldTemplate = NonNullable<
  HoshidictsMiningProfile["fieldTemplates"]
>[string];

const ACTIVATION_KEY_BY_CODE: Readonly<
  Record<string, HoshidictsActivationKey>
> = {
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
  ControlLeft: "Ctrl",
  ControlRight: "Ctrl",
  AltLeft: "Alt",
  AltRight: "Alt",
  MetaLeft: "Cmd",
  MetaRight: "Cmd",
  OSLeft: "Cmd",
  OSRight: "Cmd",
  Space: "Space",
  Enter: "Return",
  NumpadEnter: "Return",
  Escape: "Escape",
  Backspace: "Backspace",
  Delete: "Delete",
  Tab: "Tab",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  Minus: "-",
  NumpadSubtract: "-",
  Equal: "=",
  NumpadEqual: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  IntlBackslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  NumpadDecimal: ".",
  Slash: "/",
  NumpadDivide: "/",
  Backquote: "`"
};

function isSchedule(value: unknown): value is HoshidictsSchedule {
  return (
    value === "off" ||
    value === "hourly" ||
    value === "daily" ||
    value === "weekly" ||
    value === "monthly"
  );
}

export function activationKeyFromKeyboardCode(
  code: string
): HoshidictsActivationKey | null {
  const mapped = ACTIVATION_KEY_BY_CODE[code];
  if (mapped) return mapped;

  const keyCode = /^Key([A-Z])$/.exec(code)?.[1];
  if (isHoshidictsActivationKey(keyCode)) return keyCode;

  const digitCode = /^(?:Digit|Numpad)([0-9])$/.exec(code)?.[1];
  if (isHoshidictsActivationKey(digitCode)) return digitCode;

  return /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code) &&
    isHoshidictsActivationKey(code)
    ? code
    : null;
}

export const PROGRESS_KEYS: Record<HoshidictsProgressPhase, string> = {
  idle: "settings.hoshidicts.progress.idle",
  importing: "settings.hoshidicts.progress.importing",
  checking: "settings.hoshidicts.progress.checking",
  downloading: "settings.hoshidicts.progress.downloading",
  reloading: "settings.hoshidicts.progress.reloading",
  removing: "settings.hoshidicts.progress.removing",
  saving: "settings.hoshidicts.progress.saving"
};

export const RECOMMENDED_KEYS: Record<
  HoshidictsRecommendedDictionaryId,
  string
> = {
  jitendex: "settings.hoshidicts.recommended.jitendex",
  jmdict: "settings.hoshidicts.recommended.jmdict",
  jmnedict: "settings.hoshidicts.recommended.jmnedict",
  bccwj: "settings.hoshidicts.recommended.bccwj",
  "jpdbv2-kana": "settings.hoshidicts.recommended.jpdbv2Kana",
  jiten: "settings.hoshidicts.recommended.jiten",
  "kanjium-pitch": "settings.hoshidicts.recommended.kanjiumPitch",
  kanjidic: "settings.hoshidicts.recommended.kanjidic"
};

export function frequencyModeKey(mode: HoshidictsFrequencyMode | null): string {
  if (mode === "occurrence-based") {
    return "settings.hoshidicts.frequencyModes.occurrenceBased";
  }
  if (mode === "rank-based") {
    return "settings.hoshidicts.frequencyModes.rankBased";
  }
  return "settings.hoshidicts.frequencyModes.automatic";
}

export function sortFrequencyDictionaryOrderForMode(
  mode: HoshidictsFrequencyMode | null
): "ascending" | "descending" {
  return mode === "rank-based" ? "ascending" : "descending";
}

export const MINING_FIELDS: Array<{
  id: MiningField;
  labelKey: string;
}> = [
  { id: "expression", labelKey: "settings.hoshidicts.mining.fields.expression" },
  { id: "reading", labelKey: "settings.hoshidicts.mining.fields.reading" },
  { id: "definition", labelKey: "settings.hoshidicts.mining.fields.definition" },
  { id: "sentence", labelKey: "settings.hoshidicts.mining.fields.sentence" },
  { id: "frequency", labelKey: "settings.hoshidicts.mining.fields.frequency" },
  { id: "pitch", labelKey: "settings.hoshidicts.mining.fields.pitch" },
  { id: "audio", labelKey: "settings.hoshidicts.mining.fields.audio" }
];

const MINING_FIELD_MARKER_LABEL_KEYS: Record<
  HoshidictsMiningFieldMarker,
  string
> = {
  expression: "settings.hoshidicts.mining.fields.expression",
  reading: "settings.hoshidicts.mining.fields.reading",
  furigana: "settings.hoshidicts.mining.fields.furigana",
  "furigana-plain": "settings.hoshidicts.mining.fields.furiganaPlain",
  definition: "settings.hoshidicts.mining.fields.definition",
  "main-definition": "settings.hoshidicts.mining.fields.mainDefinition",
  glossary: "settings.hoshidicts.mining.fields.glossary",
  dictionary: "settings.hoshidicts.mining.fields.dictionary",
  sentence: "settings.hoshidicts.mining.fields.sentence",
  "popup-selection-text":
    "settings.hoshidicts.mining.fields.popupSelectionText",
  "sentence-furigana":
    "settings.hoshidicts.mining.fields.sentenceFurigana",
  "sentence-furigana-plain":
    "settings.hoshidicts.mining.fields.sentenceFuriganaPlain",
  frequency: "settings.hoshidicts.mining.fields.frequency",
  frequencies: "settings.hoshidicts.mining.fields.frequencies",
  "frequency-harmonic-rank":
    "settings.hoshidicts.mining.fields.frequencyHarmonicRank",
  pitch: "settings.hoshidicts.mining.fields.pitch",
  "pitch-position": "settings.hoshidicts.mining.fields.pitchPosition",
  "pitch-accent-positions":
    "settings.hoshidicts.mining.fields.pitchAccentPositions",
  "pitch-accent-categories":
    "settings.hoshidicts.mining.fields.pitchAccentCategories",
  audio: "settings.hoshidicts.mining.fields.audio",
  "document-title": "settings.hoshidicts.mining.fields.documentTitle"
};

export const MINING_FIELD_TEMPLATE_SUGGESTIONS =
  HOSHIDICTS_MINING_FIELD_MARKERS.map((marker) => ({
    ...marker,
    labelKey: MINING_FIELD_MARKER_LABEL_KEYS[marker.id]
  }));

const EMPTY_FIELDS: HoshidictsMiningFields = {
  expression: "",
  reading: "",
  definition: "",
  sentence: "",
  frequency: "",
  pitch: "",
  audio: ""
};

const LEGACY_MINING_FIELD_NAMES = Object.keys(
  EMPTY_FIELDS
) as HoshidictsMiningFieldName[];

function legacyMiningFieldTemplate(
  draft: MiningProfileDraft,
  target: string
): MiningFieldTemplate {
  const targetKey = target.toLowerCase();
  const fields = LEGACY_MINING_FIELD_NAMES.filter(
    (field) =>
      !draft.disabledFields.includes(field) &&
      draft.fields[field].toLowerCase() === targetKey
  );
  return {
    value: fields.map((field) => `{${field}}`).join("<br>"),
    overwriteMode:
      fields.length > 0 ? draft.fieldOverwriteModes[fields[0]] : "coalesce"
  };
}

export const DEFAULT_MINING_PROFILE: HoshidictsMiningProfile = {
  version: 3,
  enabled: true,
  deck: "Default",
  model: "",
  fields: { ...EMPTY_FIELDS },
  disabledFields: [],
  tags: ["hoshidicts"],
  checkForDuplicates: true,
  duplicateScope: "collection",
  duplicateScopeCheckAllModels: false,
  duplicateBehavior: "prevent",
  fieldOverwriteModes: createDefaultHoshidictsFieldOverwriteModes(),
  fieldTemplates: null
};

export const DEFAULT_MINING_OPTIONS: HoshidictsMiningOptions = {
  connected: false,
  gsmAnkiEnabled: false,
  decks: [],
  noteTypes: [],
  selectedNoteType: "",
  fields: [],
  suggestedFields: { ...EMPTY_FIELDS },
  resolvedFields: { ...EMPTY_FIELDS },
  suggestedFieldTemplates: {},
  resolvedFieldTemplates: {},
  warnings: [],
  error: null
};

const DEFAULT_STATE: HoshidictsDesktopSnapshot = {
  revision: 0,
  effectiveEnabled: false,
  dictionaries: [],
  tabGroups: [],
  customDictionaryActive: false,
  recommendedDictionaries: HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS.map((id) => ({
    id,
    installed: false
  })),
  miningProfile: DEFAULT_MINING_PROFILE,
  audioProfile: createDefaultHoshidictsAudioProfile(),
  scanLength: DEFAULT_HOSHIDICTS_SCAN_LENGTH,
  maxResults: DEFAULT_HOSHIDICTS_MAX_RESULTS,
  sortFrequencyDictionary: DEFAULT_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY,
  sortFrequencyDictionaryOrder:
    DEFAULT_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY_ORDER,
  lookupMode: "shift",
  activationKey: DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
  sourceHighlightEnabled: DEFAULT_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED,
  onlyScanJapaneseText: DEFAULT_HOSHIDICTS_ONLY_SCAN_JAPANESE_TEXT,
  popupHideDelayMs: DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
  showLookupCounts: true,
  showCompactDefinitionSummary:
    DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY,
  compactDefinitionSummaryDictionary:
    DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_DICTIONARY,
  hidePopupGrammarTags: DEFAULT_HOSHIDICTS_HIDE_POPUP_GRAMMAR_TAGS,
  definitionBlur: { ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR },
  popupNestingMaxDepth: DEFAULT_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH,
  popupWidthPx: DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
  popupHeightPx: DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
  popupColumns: DEFAULT_HOSHIDICTS_POPUP_COLUMNS,
  theme: DEFAULT_HOSHIDICTS_THEME,
  popupOpacityPercent: DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT,
  popupToolbarPosition: DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION,
  popupButtons: createDefaultHoshidictsPopupButtons(),
  schedule: "off",
  lastCheck: null,
  nextCheck: null,
  lastError: null,
  busy: false,
  progress: { phase: "idle" },
  overlay: { running: false, restartRequired: false }
};

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0
      )
    : [];
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function fieldValues(value: unknown): HoshidictsMiningFields {
  const candidate =
    value && typeof value === "object"
      ? (value as Partial<HoshidictsMiningFields>)
      : {};
  const read = (field: MiningField) =>
    typeof candidate[field] === "string" ? candidate[field] : "";
  return {
    expression: read("expression"),
    reading: read("reading"),
    definition: read("definition"),
    sentence: read("sentence"),
    frequency: read("frequency"),
    pitch: read("pitch"),
    audio: read("audio")
  };
}

function fieldTemplateValues(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([field, template]) =>
      field && typeof template === "string" ? [[field, template]] : []
    )
  );
}

function fieldTemplates(
  value: unknown
): HoshidictsMiningProfile["fieldTemplates"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const templates: NonNullable<HoshidictsMiningProfile["fieldTemplates"]> = {};
  for (const [field, rawTemplate] of Object.entries(value)) {
    if (!field || !rawTemplate || typeof rawTemplate !== "object") continue;
    const candidate = rawTemplate as Partial<MiningFieldTemplate>;
    if (typeof candidate.value !== "string") continue;
    const overwriteMode = HOSHIDICTS_FIELD_OVERWRITE_MODES.includes(
      candidate.overwriteMode as HoshidictsFieldOverwriteMode
    )
      ? (candidate.overwriteMode as HoshidictsFieldOverwriteMode)
      : "coalesce";
    templates[field] = { value: candidate.value, overwriteMode };
  }
  return templates;
}

function resolvedFieldTemplates(
  value: unknown
): HoshidictsMiningOptions["resolvedFieldTemplates"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const templates: HoshidictsMiningOptions["resolvedFieldTemplates"] = {};
  for (const [field, rawTemplate] of Object.entries(value)) {
    if (!field || !rawTemplate || typeof rawTemplate !== "object") continue;
    const candidate = rawTemplate as Partial<MiningFieldTemplate>;
    if (typeof candidate.value !== "string") continue;
    const overwriteMode = HOSHIDICTS_FIELD_OVERWRITE_MODES.includes(
      candidate.overwriteMode as HoshidictsFieldOverwriteMode
    )
      ? (candidate.overwriteMode as HoshidictsFieldOverwriteMode)
      : "coalesce";
    templates[field] = { value: candidate.value, overwriteMode };
  }
  return templates;
}

function miningFields(value: unknown): MiningField[] {
  const valid = new Set<MiningField>(MINING_FIELDS.map(({ id }) => id));
  const result: MiningField[] = [];
  for (const item of strings(value)) {
    if (valid.has(item as MiningField) && !result.includes(item as MiningField)) {
      result.push(item as MiningField);
    }
  }
  return result;
}

function fieldOverwriteModes(value: unknown): HoshidictsFieldOverwriteModes {
  const result = createDefaultHoshidictsFieldOverwriteModes();
  if (!value || typeof value !== "object") return result;
  const candidate = value as Partial<HoshidictsFieldOverwriteModes>;
  for (const { id } of MINING_FIELDS) {
    const mode = candidate[id];
    if (
      HOSHIDICTS_FIELD_OVERWRITE_MODES.includes(
        mode as HoshidictsFieldOverwriteMode
      )
    ) {
      result[id] = mode as HoshidictsFieldOverwriteMode;
    }
  }
  return result;
}

export function copyMiningProfile(
  profile: HoshidictsMiningProfile = DEFAULT_MINING_PROFILE
): HoshidictsMiningProfile {
  return {
    ...profile,
    fields: { ...profile.fields },
    fieldOverwriteModes: { ...profile.fieldOverwriteModes },
    disabledFields: [...profile.disabledFields],
    fieldTemplates:
      profile.fieldTemplates === null
        ? null
        : Object.fromEntries(
            Object.entries(profile.fieldTemplates).map(([field, template]) => [
              field,
              { ...template }
            ])
          ),
    tags: [...profile.tags]
  };
}

export function normalizeMiningProfile(value: unknown): HoshidictsMiningProfile {
  if (!value || typeof value !== "object") return copyMiningProfile();
  const candidate = value as Partial<HoshidictsMiningProfile> & {
    duplicatePolicy?: unknown;
  };
  return {
    version: 3,
    enabled: candidate.enabled !== false,
    deck:
      typeof candidate.deck === "string" && candidate.deck.length > 0
        ? candidate.deck
        : "Default",
    model: typeof candidate.model === "string" ? candidate.model : "",
    fields: fieldValues(candidate.fields),
    disabledFields: miningFields(candidate.disabledFields),
    tags: Array.isArray(candidate.tags) ? strings(candidate.tags) : ["hoshidicts"],
    checkForDuplicates: candidate.checkForDuplicates !== false,
    duplicateScope: HOSHIDICTS_DUPLICATE_SCOPES.includes(
      candidate.duplicateScope as HoshidictsMiningProfile["duplicateScope"]
    )
      ? (candidate.duplicateScope as HoshidictsMiningProfile["duplicateScope"])
      : "collection",
    duplicateScopeCheckAllModels:
      candidate.duplicateScopeCheckAllModels === true,
    duplicateBehavior: HOSHIDICTS_DUPLICATE_BEHAVIORS.includes(
      candidate.duplicateBehavior as HoshidictsMiningProfile["duplicateBehavior"]
    )
      ? (candidate.duplicateBehavior as HoshidictsMiningProfile["duplicateBehavior"])
      : candidate.duplicatePolicy === "allow"
        ? "new"
        : "prevent",
    fieldOverwriteModes: fieldOverwriteModes(candidate.fieldOverwriteModes),
    fieldTemplates: fieldTemplates(candidate.fieldTemplates)
  };
}

export function copyAudioProfile(
  profile: HoshidictsAudioProfile = createDefaultHoshidictsAudioProfile()
): HoshidictsAudioProfile {
  return {
    ...profile,
    sources: profile.sources.map((source) => ({ ...source }))
  };
}

export function normalizeAudioProfile(value: unknown): HoshidictsAudioProfile {
  if (!value || typeof value !== "object") return copyAudioProfile();
  const candidate = value as Partial<HoshidictsAudioProfile>;
  const seenIds = new Set<string>();
  const sources = Array.isArray(candidate.sources)
    ? candidate.sources.flatMap((value): HoshidictsAudioSource[] => {
        if (!value || typeof value !== "object") return [];
        const source = value as Partial<HoshidictsAudioSource>;
        const id = typeof source.id === "string" ? source.id.trim() : "";
        if (
          !id ||
          seenIds.has(id) ||
          !isHoshidictsAudioSourceType(source.type)
        )
          return [];
        seenIds.add(id);
        return [
          {
            id,
            type: source.type,
            url: typeof source.url === "string" ? source.url : "",
            voice: typeof source.voice === "string" ? source.voice : ""
          }
        ];
      })
    : copyAudioProfile().sources;
  const volume =
    typeof candidate.volume === "number" && Number.isFinite(candidate.volume)
      ? Math.min(100, Math.max(0, Math.round(candidate.volume)))
      : 100;
  return {
    version: 1,
    enabled: candidate.enabled !== false,
    autoPlay: candidate.autoPlay === true,
    volume,
    sources
  };
}

export function normalizeMiningOptions(value: unknown): HoshidictsMiningOptions {
  if (!value || typeof value !== "object") {
    return {
      ...DEFAULT_MINING_OPTIONS,
      suggestedFields: { ...EMPTY_FIELDS },
      resolvedFields: { ...EMPTY_FIELDS },
      suggestedFieldTemplates: {},
      resolvedFieldTemplates: {}
    };
  }
  const candidate = value as Partial<HoshidictsMiningOptions>;
  return {
    connected: candidate.connected === true,
    gsmAnkiEnabled: candidate.gsmAnkiEnabled === true,
    decks: strings(candidate.decks),
    noteTypes: strings(candidate.noteTypes),
    selectedNoteType:
      typeof candidate.selectedNoteType === "string"
        ? candidate.selectedNoteType
        : "",
    fields: strings(candidate.fields),
    suggestedFields: fieldValues(candidate.suggestedFields),
    resolvedFields: fieldValues(candidate.resolvedFields),
    suggestedFieldTemplates: fieldTemplateValues(
      candidate.suggestedFieldTemplates
    ),
    resolvedFieldTemplates: resolvedFieldTemplates(
      candidate.resolvedFieldTemplates
    ),
    warnings: strings(candidate.warnings),
    error: typeof candidate.error === "string" ? candidate.error : null
  };
}

export function normalizeDefinitionBlur(
  value: unknown
): HoshidictsReaderPreferences["definitionBlur"] {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR };
  }

  const candidate = value as Partial<
    HoshidictsReaderPreferences["definitionBlur"]
  >;
  const lookupThreshold =
    Number.isInteger(candidate.lookupThreshold) &&
    (candidate.lookupThreshold as number) >=
      MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD &&
    (candidate.lookupThreshold as number) <=
      MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD
      ? (candidate.lookupThreshold as number)
      : DEFAULT_HOSHIDICTS_DEFINITION_BLUR.lookupThreshold;
  const revealDelayMs =
    Number.isInteger(candidate.revealDelayMs) &&
    (candidate.revealDelayMs as number) >=
      MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS &&
    (candidate.revealDelayMs as number) <=
      MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS
      ? (candidate.revealDelayMs as number)
      : DEFAULT_HOSHIDICTS_DEFINITION_BLUR.revealDelayMs;

  return {
    enabled: candidate.enabled === true,
    lookupThreshold,
    revealMode: candidate.revealMode === "hover" ? "hover" : "timed",
    revealDelayMs
  };
}

export function normalizeHoshidictsDesktopState(
  value: unknown
): HoshidictsDesktopSnapshot {
  if (!value || typeof value !== "object") {
    return {
      ...DEFAULT_STATE,
      definitionBlur: { ...DEFAULT_STATE.definitionBlur },
      popupButtons: createDefaultHoshidictsPopupButtons(),
      miningProfile: copyMiningProfile(),
      audioProfile: copyAudioProfile(),
      tabGroups: [],
      recommendedDictionaries: DEFAULT_STATE.recommendedDictionaries.map(
        (dictionary) => ({ ...dictionary })
      ),
      overlay: { ...DEFAULT_STATE.overlay }
    };
  }

  const candidate = value as Partial<HoshidictsDesktopSnapshot>;
  const schedule: HoshidictsSchedule = isSchedule(candidate.schedule)
    ? candidate.schedule
    : "off";
  const phase =
    candidate.progress?.phase &&
    Object.prototype.hasOwnProperty.call(PROGRESS_KEYS, candidate.progress.phase)
      ? candidate.progress.phase
      : "idle";
  const popupHideDelayMs =
    Number.isInteger(candidate.popupHideDelayMs) &&
    (candidate.popupHideDelayMs as number) >= 0 &&
    (candidate.popupHideDelayMs as number) <=
      MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS
      ? (candidate.popupHideDelayMs as number)
      : DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS;
  const scanLength =
    Number.isInteger(candidate.scanLength) &&
    (candidate.scanLength as number) >= MIN_HOSHIDICTS_SCAN_LENGTH &&
    (candidate.scanLength as number) <= MAX_HOSHIDICTS_SCAN_LENGTH
      ? (candidate.scanLength as number)
      : DEFAULT_HOSHIDICTS_SCAN_LENGTH;
  const maxResults =
    Number.isInteger(candidate.maxResults) &&
    (candidate.maxResults as number) >= MIN_HOSHIDICTS_MAX_RESULTS &&
    (candidate.maxResults as number) <= MAX_HOSHIDICTS_MAX_RESULTS
      ? (candidate.maxResults as number)
      : DEFAULT_HOSHIDICTS_MAX_RESULTS;
  const popupNestingMaxDepth =
    Number.isSafeInteger(candidate.popupNestingMaxDepth) &&
    (candidate.popupNestingMaxDepth as number) >= 0
      ? (candidate.popupNestingMaxDepth as number)
      : DEFAULT_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH;
  const popupWidthPx =
    Number.isInteger(candidate.popupWidthPx) &&
    (candidate.popupWidthPx as number) >= MIN_HOSHIDICTS_POPUP_WIDTH_PX &&
    (candidate.popupWidthPx as number) <= MAX_HOSHIDICTS_POPUP_WIDTH_PX
      ? (candidate.popupWidthPx as number)
      : DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX;
  const popupHeightPx =
    Number.isInteger(candidate.popupHeightPx) &&
    (candidate.popupHeightPx as number) >= MIN_HOSHIDICTS_POPUP_HEIGHT_PX &&
    (candidate.popupHeightPx as number) <= MAX_HOSHIDICTS_POPUP_HEIGHT_PX
      ? (candidate.popupHeightPx as number)
      : DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX;
  const popupColumns =
    Number.isInteger(candidate.popupColumns) &&
    (candidate.popupColumns as number) >= MIN_HOSHIDICTS_POPUP_COLUMNS &&
    (candidate.popupColumns as number) <= MAX_HOSHIDICTS_POPUP_COLUMNS
      ? (candidate.popupColumns as number)
      : DEFAULT_HOSHIDICTS_POPUP_COLUMNS;
  const popupOpacityPercent =
    Number.isInteger(candidate.popupOpacityPercent) &&
    (candidate.popupOpacityPercent as number) >=
      MIN_HOSHIDICTS_POPUP_OPACITY_PERCENT &&
    (candidate.popupOpacityPercent as number) <=
      MAX_HOSHIDICTS_POPUP_OPACITY_PERCENT
      ? (candidate.popupOpacityPercent as number)
      : DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT;
  const popupToolbarPosition = isHoshidictsPopupToolbarPosition(
    candidate.popupToolbarPosition
  )
    ? candidate.popupToolbarPosition
    : DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION;
  let popupButtons = createDefaultHoshidictsPopupButtons();
  try {
    popupButtons = normalizeHoshidictsPopupButtons(candidate.popupButtons);
  } catch {
    // Keep settings usable if an older or manually edited snapshot is malformed.
  }
  const dictionaries = Array.isArray(candidate.dictionaries)
    ? candidate.dictionaries
        .filter(
          (dictionary) =>
            dictionary &&
            typeof dictionary.id === "string" &&
            typeof dictionary.title === "string"
        )
        .map((dictionary) => ({
          ...dictionary,
          displayName:
            typeof dictionary.displayName === "string" &&
            dictionary.displayName.trim()
              ? dictionary.displayName.trim()
              : null,
          enabled: dictionary.enabled !== false,
          favorite: dictionary.favorite === true,
          termCount: count(dictionary.termCount),
          frequencyCount: count(dictionary.frequencyCount),
          pitchCount: count(dictionary.pitchCount),
          kanjiCount: count(dictionary.kanjiCount),
          frequencyMode:
            dictionary.frequencyMode === "occurrence-based" ||
            dictionary.frequencyMode === "rank-based"
              ? dictionary.frequencyMode
              : null,
          updateScheduleOverride: isSchedule(dictionary.updateScheduleOverride)
            ? dictionary.updateScheduleOverride
            : null,
          lastUpdateCheck:
            typeof dictionary.lastUpdateCheck === "string"
              ? dictionary.lastUpdateCheck
              : null
        }))
    : [];
  const sortFrequencyDictionary =
    typeof candidate.sortFrequencyDictionary === "string" &&
    candidate.sortFrequencyDictionary.length > 0 &&
    dictionaries.some(
      (dictionary) =>
        dictionary.title === candidate.sortFrequencyDictionary &&
        dictionary.enabled &&
        dictionary.frequencyCount > 0
    )
      ? candidate.sortFrequencyDictionary
      : DEFAULT_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY;

  return {
    revision:
      typeof candidate.revision === "number" && candidate.revision >= 0
        ? candidate.revision
        : 0,
    effectiveEnabled: candidate.effectiveEnabled === true,
    dictionaries,
    tabGroups: Array.isArray(candidate.tabGroups)
      ? candidate.tabGroups.flatMap((value): HoshidictsDictionaryTabGroup[] => {
          if (!value || typeof value !== "object") return [];
          const group = value as Partial<HoshidictsDictionaryTabGroup>;
          if (
            typeof group.id !== "string" ||
            !group.id ||
            typeof group.name !== "string" ||
            !group.name
          ) {
            return [];
          }
          return [
            {
              id: group.id,
              name: group.name,
              dictionaryIds: [...new Set(strings(group.dictionaryIds))]
            }
          ];
        })
      : [],
    customDictionaryActive: candidate.customDictionaryActive === true,
    recommendedDictionaries: HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS.map((id) => ({
      id,
      installed:
        candidate.recommendedDictionaries?.some(
          (dictionary) => dictionary?.id === id && dictionary.installed === true
        ) === true
    })),
    miningProfile: normalizeMiningProfile(candidate.miningProfile),
    audioProfile: normalizeAudioProfile(candidate.audioProfile),
    scanLength,
    maxResults,
    sortFrequencyDictionary,
    sortFrequencyDictionaryOrder:
      candidate.sortFrequencyDictionaryOrder === "ascending" ||
      candidate.sortFrequencyDictionaryOrder === "descending"
        ? candidate.sortFrequencyDictionaryOrder
        : DEFAULT_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY_ORDER,
    lookupMode: candidate.lookupMode === "hover" ? "hover" : "shift",
    activationKey: isHoshidictsActivationKey(candidate.activationKey)
      ? candidate.activationKey
      : DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
    sourceHighlightEnabled: candidate.sourceHighlightEnabled === true,
    onlyScanJapaneseText:
      candidate.onlyScanJapaneseText !== false,
    popupHideDelayMs,
    showLookupCounts: candidate.showLookupCounts !== false,
    showCompactDefinitionSummary:
      candidate.showCompactDefinitionSummary === true,
    compactDefinitionSummaryDictionary:
      typeof candidate.compactDefinitionSummaryDictionary === "string" &&
      candidate.compactDefinitionSummaryDictionary.trim().length > 0 &&
      candidate.compactDefinitionSummaryDictionary.length <= 4096
        ? candidate.compactDefinitionSummaryDictionary.trim()
        : DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_DICTIONARY,
    hidePopupGrammarTags: candidate.hidePopupGrammarTags !== false,
    definitionBlur: normalizeDefinitionBlur(candidate.definitionBlur),
    popupNestingMaxDepth,
    popupWidthPx,
    popupHeightPx,
    popupColumns,
    theme: isHoshidictsTheme(candidate.theme)
      ? candidate.theme
      : DEFAULT_HOSHIDICTS_THEME,
    popupOpacityPercent,
    popupToolbarPosition,
    popupButtons,
    schedule,
    lastCheck:
      typeof candidate.lastCheck === "string" ? candidate.lastCheck : null,
    nextCheck:
      typeof candidate.nextCheck === "string" ? candidate.nextCheck : null,
    lastError:
      typeof candidate.lastError === "string" ? candidate.lastError : null,
    busy: candidate.busy === true,
    progress: {
      phase,
      scope:
        candidate.progress?.scope === "dictionary" ||
        candidate.progress?.scope === "preferences" ||
        candidate.progress?.scope === "mining" ||
        candidate.progress?.scope === "audio" ||
        candidate.progress?.scope === "custom"
          ? candidate.progress.scope
          : undefined,
      title:
        typeof candidate.progress?.title === "string"
          ? candidate.progress.title
          : undefined,
      completed:
        typeof candidate.progress?.completed === "number"
          ? candidate.progress.completed
          : undefined,
      total:
        typeof candidate.progress?.total === "number"
          ? candidate.progress.total
          : undefined
    },
    overlay: {
      running: candidate.overlay?.running === true,
      restartRequired: candidate.overlay?.restartRequired === true
    }
  };
}

export function profileToDraft(
  profile: HoshidictsMiningProfile
): MiningProfileDraft {
  return {
    ...copyMiningProfile(profile),
    tags: profile.tags.join(", ")
  };
}

export function draftToProfile(
  draft: MiningProfileDraft
): HoshidictsMiningProfile {
  return {
    ...draft,
    fields: { ...draft.fields },
    fieldOverwriteModes: { ...draft.fieldOverwriteModes },
    disabledFields: [...draft.disabledFields],
    fieldTemplates:
      draft.fieldTemplates === null
        ? null
        : Object.fromEntries(
            Object.entries(draft.fieldTemplates).map(([field, template]) => [
              field,
              { ...template }
            ])
          ),
    tags: draft.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
  };
}

export function visibleMiningFields(
  draft: MiningProfileDraft,
  options: HoshidictsMiningOptions
): string[] {
  if (options.fields.length > 0) return options.fields;
  if (draft.fieldTemplates !== null) return Object.keys(draft.fieldTemplates);
  const seen = new Set<string>();
  return LEGACY_MINING_FIELD_NAMES.flatMap((field) => {
    if (draft.disabledFields.includes(field)) return [];
    const target = draft.fields[field];
    const key = target.toLowerCase();
    if (!target || seen.has(key)) return [];
    seen.add(key);
    return [target];
  });
}

export function resolvedMiningFieldTemplate(
  draft: MiningProfileDraft,
  options: HoshidictsMiningOptions,
  field: string
): MiningFieldTemplate {
  if (draft.fieldTemplates !== null) {
    return (
      draft.fieldTemplates[field] ??
      options.resolvedFieldTemplates[field] ?? {
        value: "",
        overwriteMode: "coalesce"
      }
    );
  }
  return (
    options.resolvedFieldTemplates[field] ?? {
      ...legacyMiningFieldTemplate(draft, field),
      value:
        options.suggestedFieldTemplates[field] ??
        legacyMiningFieldTemplate(draft, field).value
    }
  );
}

export function materializeMiningFieldTemplates(
  draft: MiningProfileDraft,
  options: HoshidictsMiningOptions,
  visibleFields = visibleMiningFields(draft, options)
): NonNullable<HoshidictsMiningProfile["fieldTemplates"]> {
  return Object.fromEntries(
    visibleFields.map((field) => [
      field,
      { ...resolvedMiningFieldTemplate(draft, options, field) }
    ])
  );
}

export function setMiningFieldTemplate(
  draft: MiningProfileDraft,
  options: HoshidictsMiningOptions,
  field: string,
  update: Partial<MiningFieldTemplate>
): MiningProfileDraft {
  const fieldTemplates = materializeMiningFieldTemplates(draft, options);
  const current = fieldTemplates[field] ?? {
    value: "",
    overwriteMode: "coalesce"
  };
  fieldTemplates[field] = { ...current, ...update };
  return { ...draft, fieldTemplates };
}

export type ReadinessKind =
  | "featureOff"
  | "overlayStopped"
  | "restartRequired"
  | "noEnabledDictionaries"
  | "noEnabledLookupDictionary"
  | "ready";

export interface HoshidictsReadiness {
  kind: ReadinessKind;
  installed: number;
  enabled: number;
}

export function getReadiness(
  state: HoshidictsDesktopSnapshot
): HoshidictsReadiness {
  const customActive = state.customDictionaryActive ? 1 : 0;
  const installed = state.dictionaries.length + customActive;
  const enabled =
    state.dictionaries.filter((dictionary) => dictionary.enabled).length +
    customActive;
  const enabledLookupDictionaries = state.dictionaries.filter(
    (dictionary) =>
      dictionary.enabled &&
      (dictionary.termCount > 0 || dictionary.kanjiCount > 0)
  ).length + customActive;
  const kind: ReadinessKind = !state.effectiveEnabled
    ? "featureOff"
    : !state.overlay.running
      ? "overlayStopped"
      : state.overlay.restartRequired
        ? "restartRequired"
        : enabled === 0
          ? "noEnabledDictionaries"
          : enabledLookupDictionaries === 0
            ? "noEnabledLookupDictionary"
            : "ready";
  return { kind, installed, enabled };
}

export function isScopedBusy(
  state: HoshidictsDesktopSnapshot,
  scope: "dictionary" | "preferences" | "mining" | "audio" | "custom"
): boolean {
  return (
    state.busy &&
    (state.progress.scope === undefined || state.progress.scope === scope)
  );
}

export interface CustomDictionaryDraftSummary {
  entryCount: number;
  ignoredLines: number[];
  ignoredLineCount: number;
}

export function summarizeCustomDictionaryText(
  text: string
): CustomDictionaryDraftSummary {
  const { entries, ignoredLines, ignoredLineCount } =
    parseHoshidictsCustomDictionary(text);
  return { entryCount: entries.length, ignoredLines, ignoredLineCount };
}

export function formatTimestamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}
