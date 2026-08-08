import {
  DEFAULT_HOSHIDICTS_DEFINITION_BLUR,
  DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
  MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
  MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
  MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
  MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
  MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
  type HoshidictsDesktopSnapshot,
  type HoshidictsMiningFieldName,
  type HoshidictsMiningFields,
  type HoshidictsMiningOptions,
  type HoshidictsMiningProfile,
  type HoshidictsProgressPhase,
  type HoshidictsRecommendedDictionaryId,
  type HoshidictsReaderPreferences,
  type HoshidictsSchedule
} from "../../../../shared/features/hoshidicts";

export type HoshidictsView = "dictionaries" | "mining";
export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";
export type MiningField = HoshidictsMiningFieldName;
export type MiningProfileDraft = Omit<HoshidictsMiningProfile, "tags"> & {
  tags: string;
};

export const AUTO_FIELD_VALUE = "__hoshidicts_auto__";
export const DISABLED_FIELD_VALUE = "__hoshidicts_disabled__";

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
  jmdict: "settings.hoshidicts.recommended.jmdict",
  jmnedict: "settings.hoshidicts.recommended.jmnedict"
};

export const MINING_FIELDS: Array<{
  id: MiningField;
  labelKey: string;
}> = [
  { id: "expression", labelKey: "settings.hoshidicts.mining.fields.expression" },
  { id: "reading", labelKey: "settings.hoshidicts.mining.fields.reading" },
  { id: "definition", labelKey: "settings.hoshidicts.mining.fields.definition" },
  { id: "sentence", labelKey: "settings.hoshidicts.mining.fields.sentence" },
  { id: "frequency", labelKey: "settings.hoshidicts.mining.fields.frequency" },
  { id: "pitch", labelKey: "settings.hoshidicts.mining.fields.pitch" }
];

const EMPTY_FIELDS: HoshidictsMiningFields = {
  expression: "",
  reading: "",
  definition: "",
  sentence: "",
  frequency: "",
  pitch: ""
};

export const DEFAULT_MINING_PROFILE: HoshidictsMiningProfile = {
  version: 1,
  enabled: true,
  deck: "Default",
  model: "",
  fields: { ...EMPTY_FIELDS },
  disabledFields: [],
  tags: ["hoshidicts"],
  duplicatePolicy: "prevent"
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
  warnings: [],
  error: null
};

const DEFAULT_STATE: HoshidictsDesktopSnapshot = {
  revision: 0,
  effectiveEnabled: false,
  dictionaries: [],
  recommendedDictionaries: [
    { id: "jmdict", installed: false },
    { id: "jmnedict", installed: false }
  ],
  miningProfile: DEFAULT_MINING_PROFILE,
  lookupMode: "shift",
  popupHideDelayMs: DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
  definitionBlur: { ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR },
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
    pitch: read("pitch")
  };
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

export function copyMiningProfile(
  profile: HoshidictsMiningProfile = DEFAULT_MINING_PROFILE
): HoshidictsMiningProfile {
  return {
    ...profile,
    fields: { ...profile.fields },
    disabledFields: [...profile.disabledFields],
    tags: [...profile.tags]
  };
}

export function normalizeMiningProfile(value: unknown): HoshidictsMiningProfile {
  if (!value || typeof value !== "object") return copyMiningProfile();
  const candidate = value as Partial<HoshidictsMiningProfile>;
  return {
    version: 1,
    enabled: candidate.enabled !== false,
    deck:
      typeof candidate.deck === "string" && candidate.deck.length > 0
        ? candidate.deck
        : "Default",
    model: typeof candidate.model === "string" ? candidate.model : "",
    fields: fieldValues(candidate.fields),
    disabledFields: miningFields(candidate.disabledFields),
    tags: Array.isArray(candidate.tags) ? strings(candidate.tags) : ["hoshidicts"],
    duplicatePolicy: candidate.duplicatePolicy === "allow" ? "allow" : "prevent"
  };
}

export function normalizeMiningOptions(value: unknown): HoshidictsMiningOptions {
  if (!value || typeof value !== "object") {
    return {
      ...DEFAULT_MINING_OPTIONS,
      suggestedFields: { ...EMPTY_FIELDS },
      resolvedFields: { ...EMPTY_FIELDS }
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
      miningProfile: copyMiningProfile(),
      recommendedDictionaries: DEFAULT_STATE.recommendedDictionaries.map(
        (dictionary) => ({ ...dictionary })
      ),
      overlay: { ...DEFAULT_STATE.overlay }
    };
  }

  const candidate = value as Partial<HoshidictsDesktopSnapshot>;
  const schedule: HoshidictsSchedule =
    candidate.schedule === "daily" ||
    candidate.schedule === "weekly" ||
    candidate.schedule === "monthly"
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

  return {
    revision:
      typeof candidate.revision === "number" && candidate.revision >= 0
        ? candidate.revision
        : 0,
    effectiveEnabled: candidate.effectiveEnabled === true,
    dictionaries: Array.isArray(candidate.dictionaries)
      ? candidate.dictionaries
          .filter(
            (dictionary) =>
              dictionary &&
              typeof dictionary.id === "string" &&
              typeof dictionary.title === "string"
          )
          .map((dictionary) => ({
            ...dictionary,
            enabled: dictionary.enabled !== false
          }))
      : [],
    recommendedDictionaries: (
      ["jmdict", "jmnedict"] as HoshidictsRecommendedDictionaryId[]
    ).map((id) => ({
      id,
      installed:
        candidate.recommendedDictionaries?.some(
          (dictionary) => dictionary?.id === id && dictionary.installed === true
        ) === true
    })),
    miningProfile: normalizeMiningProfile(candidate.miningProfile),
    lookupMode: candidate.lookupMode === "hover" ? "hover" : "shift",
    popupHideDelayMs,
    definitionBlur: normalizeDefinitionBlur(candidate.definitionBlur),
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
        candidate.progress?.scope === "mining"
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
    disabledFields: [...draft.disabledFields],
    tags: draft.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
  };
}

export function getFieldChoice(
  draft: MiningProfileDraft,
  field: MiningField
): string {
  if (draft.disabledFields.includes(field)) return DISABLED_FIELD_VALUE;
  return draft.fields[field] || AUTO_FIELD_VALUE;
}

export function setFieldChoice(
  draft: MiningProfileDraft,
  field: MiningField,
  value: string
): MiningProfileDraft {
  const disabledFields = draft.disabledFields.filter((item) => item !== field);
  const fields = { ...draft.fields };
  if (value === DISABLED_FIELD_VALUE) {
    disabledFields.push(field);
    fields[field] = "";
  } else if (value === AUTO_FIELD_VALUE) {
    fields[field] = "";
  } else {
    fields[field] = value;
  }
  return { ...draft, fields, disabledFields };
}

export function automaticFieldTarget(
  options: HoshidictsMiningOptions,
  field: MiningField
): string {
  return options.suggestedFields[field] || options.resolvedFields[field] || "";
}

export function resolvedDraftField(
  draft: MiningProfileDraft,
  options: HoshidictsMiningOptions,
  field: MiningField
): string {
  if (draft.disabledFields.includes(field)) return "";
  return draft.fields[field] || automaticFieldTarget(options, field);
}

export type ReadinessKind =
  | "featureOff"
  | "overlayStopped"
  | "restartRequired"
  | "noEnabledDictionaries"
  | "ready";

export interface HoshidictsReadiness {
  kind: ReadinessKind;
  installed: number;
  enabled: number;
}

export function getReadiness(
  state: HoshidictsDesktopSnapshot
): HoshidictsReadiness {
  const installed = state.dictionaries.length;
  const enabled = state.dictionaries.filter((dictionary) => dictionary.enabled)
    .length;
  const kind: ReadinessKind = !state.effectiveEnabled
    ? "featureOff"
    : !state.overlay.running
      ? "overlayStopped"
      : state.overlay.restartRequired
        ? "restartRequired"
        : enabled === 0
          ? "noEnabledDictionaries"
          : "ready";
  return { kind, installed, enabled };
}

export function isScopedBusy(
  state: HoshidictsDesktopSnapshot,
  scope: "dictionary" | "preferences" | "mining"
): boolean {
  return (
    state.busy &&
    (state.progress.scope === undefined || state.progress.scope === scope)
  );
}

export function formatTimestamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}
