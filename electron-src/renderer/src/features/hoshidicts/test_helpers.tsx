// Hoshidicts-private test factories. Not shared with unrelated GSM tests.
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi, type Mock } from "vitest";

import {
  createDefaultHoshidictsAudioProfile,
  createDefaultHoshidictsFieldOverwriteModes,
  createDefaultHoshidictsPopupButtons,
  DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
  DEFAULT_HOSHIDICTS_AVERAGE_FREQUENCY,
  DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY,
  HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS,
  DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT,
  DEFAULT_HOSHIDICTS_CUSTOM_POPUP_CSS,
  DEFAULT_HOSHIDICTS_DEFINITION_BLUR,
  DEFAULT_HOSHIDICTS_HIDE_POPUP_GRAMMAR_TAGS,
  DEFAULT_HOSHIDICTS_MAX_RESULTS,
  DEFAULT_HOSHIDICTS_POPUP_COLUMNS,
  DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
  DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT,
  DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION,
  DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
  DEFAULT_HOSHIDICTS_SCAN_LENGTH,
  DEFAULT_HOSHIDICTS_SHOW_FREQUENCY_DICTIONARY_NAMES,
  DEFAULT_HOSHIDICTS_SHOW_PITCH_ACCENT_BADGE,
  DEFAULT_HOSHIDICTS_SHOW_PITCH_ACCENT_FURIGANA,
  DEFAULT_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY_ORDER,
  DEFAULT_HOSHIDICTS_THEME,
  HOSHIDICTS_CHANNELS,
  type HoshidictsCustomDictionaryDocument,
  type HoshidictsDesktopSnapshot,
  type HoshidictsMiningOptions,
  type HoshidictsMiningProfile,
  type HoshidictsReaderPreferences
} from "../../../../shared/features/hoshidicts";
import { I18nProvider } from "../../i18n";
import { HoshidictsSettingsWindow } from "./HoshidictsSettingsWindow";

type Dictionary = HoshidictsDesktopSnapshot["dictionaries"][number];
type IpcListener = (...args: unknown[]) => void;
type IpcHandler = (...args: unknown[]) => unknown;

export function makeHoshidictsDictionary(
  overrides: Partial<Dictionary> = {}
): Dictionary {
  return {
    id: "jmdict-id",
    title: "JMdict",
    displayName: null,
    enabled: true,
    favorite: false,
    revision: "2026-08-06",
    isUpdatable: true,
    indexUrl: "https://example.test/jmdict.json",
    downloadUrl: "https://example.test/jmdict.zip",
    language: "ja",
    termCount: 123,
    frequencyCount: 12,
    pitchCount: 3,
    kanjiCount: 4,
    mediaCount: 0,
    frequencyMode: null,
    installedAt: "2026-08-06T10:00:00.000Z",
    updateScheduleOverride: null,
    lastUpdateCheck: "2026-08-06T10:00:00.000Z",
    ...overrides
  };
}

/** Frequency-only companion of the default term dictionary. */
export function makeHoshidictsFrequencyDictionary(
  overrides: Partial<Dictionary> = {}
): Dictionary {
  return makeHoshidictsDictionary({
    id: "custom-id",
    title: "Custom",
    enabled: false,
    revision: "one",
    isUpdatable: false,
    indexUrl: null,
    downloadUrl: null,
    termCount: 0,
    frequencyCount: 456,
    pitchCount: 0,
    kanjiCount: 0,
    frequencyMode: "rank-based",
    installedAt: "2026-08-06T11:00:00.000Z",
    lastUpdateCheck: null,
    ...overrides
  });
}

export function makeHoshidictsMiningProfile(
  overrides: Partial<HoshidictsMiningProfile> = {}
): HoshidictsMiningProfile {
  return {
    version: 3,
    enabled: true,
    deck: "Default",
    model: "",
    fields: {
      expression: "",
      reading: "",
      definition: "",
      sentence: "",
      frequency: "",
      pitch: "",
      audio: ""
    },
    disabledFields: [],
    tags: ["hoshidicts"],
    checkForDuplicates: true,
    duplicateScope: "collection",
    duplicateScopeCheckAllModels: false,
    duplicateBehavior: "prevent",
    fieldOverwriteModes: createDefaultHoshidictsFieldOverwriteModes(),
    fieldTemplates: null,
    ...overrides
  };
}

/** The reader-preferences payload the settings window sends when saving. */
export function makeHoshidictsReaderPreferences(
  overrides: Partial<HoshidictsReaderPreferences> = {}
): HoshidictsReaderPreferences {
  return {
    lookupMode: "shift",
    scanLength: DEFAULT_HOSHIDICTS_SCAN_LENGTH,
    maxResults: DEFAULT_HOSHIDICTS_MAX_RESULTS,
    sortFrequencyDictionary: null,
    sortFrequencyDictionaryOrder:
      DEFAULT_HOSHIDICTS_SORT_FREQUENCY_DICTIONARY_ORDER,
    activationKey: DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
    sourceHighlightEnabled: false,
    onlyScanJapaneseText: true,
    popupHideDelayMs: 300,
    showLookupCounts: true,
    averageFrequency: DEFAULT_HOSHIDICTS_AVERAGE_FREQUENCY,
    showFrequencyDictionaryNames:
      DEFAULT_HOSHIDICTS_SHOW_FREQUENCY_DICTIONARY_NAMES,
    showCompactDefinitionSummary: DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY,
    compactDefinitionSummaryCount:
      DEFAULT_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT,
    compactDefinitionSummaryDictionary: null,
    kanjiClickDictionary: null,
    popupImageSource: null,
    showPitchAccentFurigana: DEFAULT_HOSHIDICTS_SHOW_PITCH_ACCENT_FURIGANA,
    pitchAccentFuriganaDictionary: null,
    showPitchAccentBadge: DEFAULT_HOSHIDICTS_SHOW_PITCH_ACCENT_BADGE,
    hidePopupGrammarTags: DEFAULT_HOSHIDICTS_HIDE_POPUP_GRAMMAR_TAGS,
    popupNestingMaxDepth: 10,
    definitionBlur: { ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR },
    popupWidthPx: DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
    popupHeightPx: DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
    popupColumns: DEFAULT_HOSHIDICTS_POPUP_COLUMNS,
    theme: DEFAULT_HOSHIDICTS_THEME,
    popupOpacityPercent: DEFAULT_HOSHIDICTS_POPUP_OPACITY_PERCENT,
    popupToolbarPosition: DEFAULT_HOSHIDICTS_POPUP_TOOLBAR_POSITION,
    popupButtons: createDefaultHoshidictsPopupButtons(),
    customPopupCss: DEFAULT_HOSHIDICTS_CUSTOM_POPUP_CSS,
    ...overrides
  };
}

export function makeHoshidictsSnapshot(
  overrides: Partial<HoshidictsDesktopSnapshot> = {}
): HoshidictsDesktopSnapshot {
  return {
    ...makeHoshidictsReaderPreferences(),
    revision: 10,
    activeProfileId: "default",
    profiles: [{ id: "default", name: "Default" }],
    effectiveEnabled: true,
    dictionaries: [
      makeHoshidictsDictionary(),
      makeHoshidictsFrequencyDictionary()
    ],
    tabGroups: [],
    customDictionaryActive: false,
    // The main process always sends the full catalogue, one entry per id.
    recommendedDictionaries: HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS.map(
      (id) => ({ id, installed: id === "jmdict" })
    ),
    miningProfile: makeHoshidictsMiningProfile(),
    audioProfile: createDefaultHoshidictsAudioProfile(),
    schedule: "weekly",
    lastCheck: "2026-08-06T10:00:00.000Z",
    nextCheck: "2026-08-13T10:00:00.000Z",
    lastError: null,
    busy: false,
    progress: { phase: "idle" },
    overlay: { running: true, restartRequired: false },
    ...overrides
  };
}

const MINING_TARGET_FIELDS = {
  expression: "Expression",
  reading: "ExpressionReading",
  definition: "Glossary",
  sentence: "Sentence",
  frequency: "Frequency",
  pitch: "PitchPosition",
  audio: "WordAudio"
} as const;

const MINING_FIELD_TEMPLATES = {
  Expression: "{expression}",
  ExpressionReading: "{reading}",
  Glossary: "{definition}",
  Sentence: "{sentence}",
  Frequency: "{frequency}",
  PitchPosition: "{pitch-position}",
  WordAudio: "{audio}",
  Front: ""
} as const;

export function makeHoshidictsMiningOptions(
  overrides: Partial<HoshidictsMiningOptions> = {}
): HoshidictsMiningOptions {
  return {
    connected: true,
    gsmAnkiEnabled: true,
    decks: ["Default", "Mining"],
    noteTypes: ["Kiku", "Lapis"],
    selectedNoteType: "Kiku",
    fields: Object.keys(MINING_FIELD_TEMPLATES),
    suggestedFields: { ...MINING_TARGET_FIELDS },
    resolvedFields: { ...MINING_TARGET_FIELDS },
    suggestedFieldTemplates: { ...MINING_FIELD_TEMPLATES },
    resolvedFieldTemplates: Object.fromEntries(
      Object.entries(MINING_FIELD_TEMPLATES).map(([field, value]) => [
        field,
        { value, overwriteMode: "coalesce" as const }
      ])
    ),
    warnings: [],
    error: null,
    ...overrides
  };
}

export function makeHoshidictsCustomDocument(
  overrides: Partial<HoshidictsCustomDictionaryDocument> = {}
): HoshidictsCustomDictionaryDocument {
  return {
    text: "螺旋丸, らせんがん, Rotating chakra sphere attack\n",
    revision: "source-one",
    exists: true,
    filePath: "/data/dictionaries/hoshidicts/custom-dictionary.txt",
    ...overrides
  };
}

export interface HoshidictsIpcMockOptions {
  state?: HoshidictsDesktopSnapshot;
  miningOptions?: HoshidictsMiningOptions;
  customDocument?: HoshidictsCustomDictionaryDocument;
  /** Per-channel overrides that win over the default responses. */
  handlers?: Record<string, IpcHandler>;
}

export interface HoshidictsIpcMock {
  invoke: Mock;
  listeners: Map<string, IpcListener[]>;
  /** Replaces the default responses; unspecified options keep their value. */
  configure(options: HoshidictsIpcMockOptions): void;
  emit(channel: string, payload: unknown): void;
  nextRevision(): number;
}

/**
 * Installs `window.ipcRenderer` with the responses the settings window needs to
 * boot, so tests only describe the channel they actually exercise.
 */
export function createHoshidictsIpcMock(
  options: HoshidictsIpcMockOptions = {}
): HoshidictsIpcMock {
  let state = options.state ?? makeHoshidictsSnapshot();
  let miningOptions = options.miningOptions ?? makeHoshidictsMiningOptions();
  let customDocument = options.customDocument ?? makeHoshidictsCustomDocument();
  let handlers = options.handlers ?? {};
  let revision = state.revision;
  const listeners = new Map<string, IpcListener[]>();
  const nextRevision = () => ++revision;
  const changed = (extra: Partial<HoshidictsDesktopSnapshot> = {}) => ({
    ...state,
    revision: nextRevision(),
    ...extra
  });

  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    const handler = handlers[channel];
    if (handler) {
      const handled = await handler(...args);
      // `undefined` means "not this call", so the default response is used.
      if (handled !== undefined) return handled;
    }
    switch (channel) {
      case HOSHIDICTS_CHANNELS.getState:
        return state;
      case HOSHIDICTS_CHANNELS.getMiningOptions:
        return miningOptions;
      case HOSHIDICTS_CHANNELS.getCustomDictionary:
        return customDocument;
      case HOSHIDICTS_CHANNELS.saveCustomDictionary:
        return {
          success: true,
          outcome: { code: "customDictionarySaved" },
          document: {
            ...customDocument,
            text: (args[0] as { text: string }).text,
            revision: "source-two"
          },
          state: changed({ customDictionaryActive: true })
        };
      case HOSHIDICTS_CHANNELS.setReaderPreferences:
        return {
          success: true,
          outcome: { code: "preferencesSaved" },
          state: changed(args[0] as Partial<HoshidictsDesktopSnapshot>)
        };
      case HOSHIDICTS_CHANNELS.setMiningProfile:
        return {
          success: true,
          outcome: { code: "miningProfileSaved" },
          state: changed({ miningProfile: args[0] as HoshidictsMiningProfile })
        };
      case HOSHIDICTS_CHANNELS.setAudioProfile:
        return {
          success: true,
          outcome: { code: "audioProfileSaved" },
          state: changed({
            audioProfile: args[0] as HoshidictsDesktopSnapshot["audioProfile"]
          })
        };
      default:
        return {
          success: true,
          outcome: { code: "dictionaryChanged" },
          state: changed()
        };
    }
  });

  Object.defineProperty(window, "ipcRenderer", {
    configurable: true,
    value: {
      invoke,
      send: vi.fn(),
      on: (channel: string, callback: IpcListener) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
        return () => {
          listeners.set(
            channel,
            (listeners.get(channel) ?? []).filter((entry) => entry !== callback)
          );
        };
      }
    }
  });

  return {
    invoke,
    listeners,
    nextRevision,
    configure(update) {
      if (update.state) {
        state = update.state;
        revision = update.state.revision;
      }
      if (update.miningOptions) miningOptions = update.miningOptions;
      if (update.customDocument) customDocument = update.customDocument;
      if (update.handlers) handlers = update.handlers;
    },
    emit(channel, payload) {
      listeners.get(channel)?.[0]?.({}, payload);
    }
  };
}

export interface HoshidictsSettingsHarness {
  container: HTMLElement;
  unmount(): Promise<void>;
  dispose(): Promise<void>;
}

/** Mounts the standalone settings window into a fresh detached container. */
export async function renderHoshidictsSettings(
  { locale = "en" }: { locale?: string } = {}
): Promise<HoshidictsSettingsHarness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = createRoot(container);

  await act(async () => {
    root?.render(
      <I18nProvider initialLocale={locale}>
        <HoshidictsSettingsWindow />
      </I18nProvider>
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  const unmount = async () => {
    const current = root;
    root = null;
    if (current) await act(async () => current.unmount());
  };
  return {
    container,
    unmount,
    async dispose() {
      await unmount();
      container.remove();
    }
  };
}

export interface FakeAudioElement {
  readonly src: string;
  volume: number;
  onended: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  play: Mock;
  pause: Mock;
}

/** Replaces `Audio` plus the object-url pair the panel uses to play bytes. */
export function installFakeAudio(objectUrl: string) {
  const createObjectUrl = vi.fn((_blob: Blob) => objectUrl);
  const revokeObjectUrl = vi.fn();
  for (const [name, value] of [
    ["createObjectURL", createObjectUrl],
    ["revokeObjectURL", revokeObjectUrl]
  ] as const) {
    Object.defineProperty(URL, name, { configurable: true, value });
  }

  const instances: FakeAudioElement[] = [];
  vi.stubGlobal(
    "Audio",
    class FakeAudio implements FakeAudioElement {
      volume = 1;
      onended: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      play = vi.fn(async () => undefined);
      pause = vi.fn();

      constructor(readonly src: string) {
        instances.push(this);
      }
    }
  );
  return { instances, createObjectUrl, revokeObjectUrl };
}

export interface FakeUtterance {
  readonly text: string;
  lang: string;
  volume: number;
  voice: SpeechSynthesisVoice | null;
  onend: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}

/** Replaces the speech-synthesis globals jsdom does not implement. */
export function installFakeSpeechSynthesis() {
  const spoken: FakeUtterance[] = [];
  const cancel = vi.fn();
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class implements FakeUtterance {
      lang = "";
      volume = 1;
      voice: SpeechSynthesisVoice | null = null;
      onend: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(readonly text: string) {}
    }
  );
  vi.stubGlobal("speechSynthesis", {
    getVoices: () => [],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    cancel,
    speak: (utterance: FakeUtterance) => spoken.push(utterance)
  });
  return { spoken, cancel };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function setNativeValue(
  prototype: object,
  element: Element | null,
  value: string,
  events: string[]
) {
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value
  );
  for (const type of events) {
    element?.dispatchEvent(new Event(type, { bubbles: true }));
  }
}

export function setInputValue(input: HTMLInputElement | null, value: string) {
  setNativeValue(HTMLInputElement.prototype, input, value, ["input", "change"]);
}

export function setTextareaValue(
  input: HTMLTextAreaElement | null,
  value: string
) {
  setNativeValue(HTMLTextAreaElement.prototype, input, value, [
    "input",
    "change"
  ]);
}

export function setSelectValue(input: HTMLSelectElement | null, value: string) {
  setNativeValue(HTMLSelectElement.prototype, input, value, ["change"]);
}

/**
 * React act support plus the browser globals jsdom lacks, restoring the
 * `URL` object-url descriptors that audio tests replace.
 */
export function installHoshidictsTestEnvironment(): () => void {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  const objectUrlDescriptors = (
    ["createObjectURL", "revokeObjectURL"] as const
  ).map(
    (name) => [name, Object.getOwnPropertyDescriptor(URL, name)] as const
  );
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      disconnect() {}
    }
  );

  return () => {
    for (const [name, descriptor] of objectUrlDescriptors) {
      if (descriptor) Object.defineProperty(URL, name, descriptor);
      else Reflect.deleteProperty(URL, name);
    }
    vi.unstubAllGlobals();
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  };
}
