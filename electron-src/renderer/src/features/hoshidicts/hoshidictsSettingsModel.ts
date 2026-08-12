import {
  createDefaultHoshidictsAudioProfile,
  createDefaultHoshidictsFieldOverwriteModes,
  HOSHIDICTS_MINING_FIELD_MARKERS,
  isHoshidictsActivationKey,
  parseHoshidictsCustomDictionary,
  type HoshidictsActivationKey,
  type HoshidictsAudioProfile,
  type HoshidictsDesktopSnapshot,
  type HoshidictsFrequencyMode,
  type HoshidictsMiningFieldName,
  type HoshidictsMiningFieldMarker,
  type HoshidictsMiningFields,
  type HoshidictsMiningOptions,
  type HoshidictsMiningProfile,
  type HoshidictsProgressPhase,
  type HoshidictsRecommendedDictionaryId
} from "../../../../shared/features/hoshidicts";

export type HoshidictsView =
  | "dictionaries"
  | "design"
  | "custom"
  | "audio"
  | "mining";
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


export function copyAudioProfile(
  profile: HoshidictsAudioProfile = createDefaultHoshidictsAudioProfile()
): HoshidictsAudioProfile {
  return {
    ...profile,
    sources: profile.sources.map((source) => ({ ...source }))
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
