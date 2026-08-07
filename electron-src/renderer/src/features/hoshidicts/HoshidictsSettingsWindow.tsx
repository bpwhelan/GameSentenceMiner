import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  FileArchive,
  RefreshCw,
  RotateCw,
  Trash2
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  HOSHIDICTS_CHANNELS,
  type HoshidictsActionResult,
  type HoshidictsDesktopSnapshot,
  type HoshidictsMiningFields,
  type HoshidictsMiningOptions,
  type HoshidictsMiningProfile,
  type HoshidictsProgressPhase,
  type HoshidictsRecommendedDictionaryId,
  type HoshidictsSchedule
} from "../../../../shared/features/hoshidicts";
import { useTranslation } from "../../i18n";
import { invokeIpc, onIpc } from "../../lib/ipc";
import "./hoshidicts.css";

type HoshidictsView = "dictionaries" | "mining";
type MiningField = keyof HoshidictsMiningProfile["fields"];
type MiningProfileDraft = Omit<HoshidictsMiningProfile, "tags"> & {
  tags: string;
};

const DEFAULT_MINING_PROFILE: HoshidictsMiningProfile = {
  version: 1,
  enabled: true,
  deck: "Default",
  model: "",
  fields: {
    expression: "",
    reading: "",
    definition: "",
    sentence: "",
    frequency: "",
    pitch: ""
  },
  tags: ["hoshidicts"],
  duplicatePolicy: "prevent"
};

const DEFAULT_STATE: HoshidictsDesktopSnapshot = {
  effectiveEnabled: false,
  dictionaries: [],
  recommendedDictionaries: [
    { id: "jmdict", installed: false },
    { id: "jmnedict", installed: false }
  ],
  miningProfile: DEFAULT_MINING_PROFILE,
  lookupMode: "shift",
  schedule: "off",
  lastCheck: null,
  nextCheck: null,
  lastError: null,
  busy: false,
  progress: { phase: "idle" },
  overlay: {
    running: false,
    restartRequired: false
  }
};

const DEFAULT_MINING_OPTIONS: HoshidictsMiningOptions = {
  connected: false,
  gsmAnkiEnabled: false,
  decks: [],
  noteTypes: [],
  selectedNoteType: "",
  fields: [],
  suggestedFields: {
    expression: "",
    reading: "",
    definition: "",
    sentence: "",
    frequency: "",
    pitch: ""
  },
  error: null
};

const PROGRESS_KEYS: Record<HoshidictsProgressPhase, string> = {
  idle: "settings.hoshidicts.progress.idle",
  importing: "settings.hoshidicts.progress.importing",
  checking: "settings.hoshidicts.progress.checking",
  downloading: "settings.hoshidicts.progress.downloading",
  reloading: "settings.hoshidicts.progress.reloading",
  removing: "settings.hoshidicts.progress.removing",
  saving: "settings.hoshidicts.progress.saving"
};

const RECOMMENDED_KEYS: Record<HoshidictsRecommendedDictionaryId, string> = {
  jmdict: "settings.hoshidicts.recommended.jmdict",
  jmnedict: "settings.hoshidicts.recommended.jmnedict"
};

const MINING_FIELDS: Array<{ id: MiningField; labelKey: string }> = [
  {
    id: "expression",
    labelKey: "settings.hoshidicts.mining.fields.expression"
  },
  {
    id: "reading",
    labelKey: "settings.hoshidicts.mining.fields.reading"
  },
  {
    id: "definition",
    labelKey: "settings.hoshidicts.mining.fields.definition"
  },
  {
    id: "sentence",
    labelKey: "settings.hoshidicts.mining.fields.sentence"
  },
  {
    id: "frequency",
    labelKey: "settings.hoshidicts.mining.fields.frequency"
  },
  {
    id: "pitch",
    labelKey: "settings.hoshidicts.mining.fields.pitch"
  }
];

function copyDefaultProfile(): HoshidictsMiningProfile {
  return {
    ...DEFAULT_MINING_PROFILE,
    fields: { ...DEFAULT_MINING_PROFILE.fields },
    tags: [...DEFAULT_MINING_PROFILE.tags]
  };
}

function normalizeMiningProfile(value: unknown): HoshidictsMiningProfile {
  if (!value || typeof value !== "object") {
    return copyDefaultProfile();
  }
  const candidate = value as Partial<HoshidictsMiningProfile>;
  const fields =
    candidate.fields && typeof candidate.fields === "object"
      ? candidate.fields
      : {};
  const readString = (input: unknown, fallback = "") =>
    typeof input === "string" ? input : fallback;
  return {
    version: 1,
    enabled: candidate.enabled !== false,
    deck: readString(candidate.deck, "Default") || "Default",
    model: readString(candidate.model),
    fields: {
      expression: readString(fields.expression),
      reading: readString(fields.reading),
      definition: readString(fields.definition),
      sentence: readString(fields.sentence),
      frequency: readString(fields.frequency),
      pitch: readString(fields.pitch)
    },
    tags: Array.isArray(candidate.tags)
      ? candidate.tags.filter(
          (tag): tag is string => typeof tag === "string" && tag.length > 0
        )
      : ["hoshidicts"],
    duplicatePolicy:
      candidate.duplicatePolicy === "allow" ? "allow" : "prevent"
  };
}

function normalizeMiningOptions(value: unknown): HoshidictsMiningOptions {
  if (!value || typeof value !== "object") {
    return {
      ...DEFAULT_MINING_OPTIONS,
      suggestedFields: { ...DEFAULT_MINING_OPTIONS.suggestedFields }
    };
  }
  const candidate = value as Partial<HoshidictsMiningOptions>;
  const strings = (items: unknown): string[] =>
    Array.isArray(items)
      ? items.filter(
          (item): item is string => typeof item === "string" && item.length > 0
        )
      : [];
  const suggested =
    candidate.suggestedFields && typeof candidate.suggestedFields === "object"
      ? candidate.suggestedFields
      : DEFAULT_MINING_OPTIONS.suggestedFields;
  const fieldValue = (field: MiningField) =>
    typeof suggested[field] === "string" ? suggested[field] : "";
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
    suggestedFields: {
      expression: fieldValue("expression"),
      reading: fieldValue("reading"),
      definition: fieldValue("definition"),
      sentence: fieldValue("sentence"),
      frequency: fieldValue("frequency"),
      pitch: fieldValue("pitch")
    },
    error: typeof candidate.error === "string" ? candidate.error : null
  };
}

export function normalizeHoshidictsDesktopState(
  value: unknown
): HoshidictsDesktopSnapshot {
  if (!value || typeof value !== "object") {
    return {
      ...DEFAULT_STATE,
      miningProfile: copyDefaultProfile(),
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

  return {
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
          (dictionary) =>
            dictionary?.id === id && dictionary.installed === true
        ) === true
    })),
    miningProfile: normalizeMiningProfile(candidate.miningProfile),
    lookupMode: candidate.lookupMode === "hover" ? "hover" : "shift",
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

function profileToDraft(profile: HoshidictsMiningProfile): MiningProfileDraft {
  return {
    ...profile,
    fields: { ...profile.fields },
    tags: profile.tags.join(", ")
  };
}

function formatTimestamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

export function HoshidictsSettingsWindow() {
  const t = useTranslation();
  const [view, setView] = useState<HoshidictsView>("dictionaries");
  const [state, setState] = useState<HoshidictsDesktopSnapshot>(
    normalizeHoshidictsDesktopState(null)
  );
  const [miningDraft, setMiningDraft] = useState<MiningProfileDraft>(
    profileToDraft(DEFAULT_MINING_PROFILE)
  );
  const miningDraftRef = useRef<MiningProfileDraft>(
    profileToDraft(DEFAULT_MINING_PROFILE)
  );
  const [miningDirty, setMiningDirty] = useState(false);
  const miningDirtyRef = useRef(false);
  const [miningOptions, setMiningOptions] = useState<HoshidictsMiningOptions>(
    DEFAULT_MINING_OPTIONS
  );
  const [miningOptionsLoading, setMiningOptionsLoading] = useState(false);
  const miningOptionsRequestRef = useRef(0);
  const automaticFieldsRef = useRef<HoshidictsMiningFields>({
    ...DEFAULT_MINING_OPTIONS.suggestedFields
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  const applyState = useCallback(
    (value: unknown, updateMiningDraft = false) => {
      const normalized = normalizeHoshidictsDesktopState(value);
      setState(normalized);
      if (updateMiningDraft || !miningDirtyRef.current) {
        const draft = profileToDraft(normalized.miningProfile);
        miningDraftRef.current = draft;
        setMiningDraft(draft);
      }
      return normalized;
    },
    []
  );

  useEffect(() => {
    miningDraftRef.current = miningDraft;
  }, [miningDraft]);

  const updateMiningDraft = useCallback(
    (update: (current: MiningProfileDraft) => MiningProfileDraft) => {
      setMiningDraft((current) => {
        const next = update(current);
        miningDraftRef.current = next;
        return next;
      });
    },
    []
  );

  const applyResult = useCallback(
    (
      result: HoshidictsActionResult | null | undefined,
      updateMiningDraft = false
    ) => {
      if (result?.state) {
        applyState(result.state, updateMiningDraft);
      }
      if (result?.canceled) {
        setActionError(null);
      } else if (result?.success === false) {
        setActionError(
          result.error || t("settings.hoshidicts.errors.operation")
        );
      } else {
        setActionError(null);
      }
      return result?.success !== false;
    },
    [applyState, t]
  );

  useEffect(() => {
    let disposed = false;
    const loadState = (updateMiningDraft = false) => {
      void invokeIpc<HoshidictsDesktopSnapshot>(HOSHIDICTS_CHANNELS.getState)
        .then((snapshot) => {
          if (!disposed) {
            applyState(snapshot, updateMiningDraft);
            setActionError(null);
          }
        })
        .catch((error) => {
          if (!disposed) {
            setActionError(
              error instanceof Error
                ? error.message
                : t("settings.hoshidicts.errors.load")
            );
          }
        });
    };
    const refreshState = () => loadState();
    loadState(true);
    window.addEventListener("focus", refreshState);

    const unsubscribe = onIpc(
      HOSHIDICTS_CHANNELS.progress,
      (_event, snapshot) => {
        if (!disposed) {
          applyState(snapshot);
        }
      }
    );
    return () => {
      disposed = true;
      window.removeEventListener("focus", refreshState);
      unsubscribe();
    };
  }, [applyState, t]);

  const invokeAction = useCallback(
    async (
      channel: string,
      fallbackKey: string,
      ...args: unknown[]
    ): Promise<boolean> => {
      setActionError(null);
      try {
        return applyResult(
          await invokeIpc<HoshidictsActionResult>(channel, ...args)
        );
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : t(fallbackKey)
        );
        return false;
      }
    },
    [applyResult, t]
  );

  const loadMiningOptions = useCallback(
    async (model?: string, applySuggestions = true) => {
      const requestId = miningOptionsRequestRef.current + 1;
      miningOptionsRequestRef.current = requestId;
      setMiningOptionsLoading(true);
      try {
        const value = await invokeIpc<HoshidictsMiningOptions>(
          HOSHIDICTS_CHANNELS.getMiningOptions,
          model || undefined
        );
        if (requestId !== miningOptionsRequestRef.current) return;
        const normalized = normalizeMiningOptions(value);
        setMiningOptions(normalized);
        if (applySuggestions && normalized.connected) {
          const previousAutomatic = automaticFieldsRef.current;
          automaticFieldsRef.current = { ...normalized.suggestedFields };
          const current = miningDraftRef.current;
          const fields = { ...current.fields };
          let changed = false;
          for (const field of MINING_FIELDS) {
            const suggestion = normalized.suggestedFields[field.id];
            if (
              suggestion &&
              (!fields[field.id] ||
                fields[field.id] === previousAutomatic[field.id]) &&
              fields[field.id] !== suggestion
            ) {
              fields[field.id] = suggestion;
              changed = true;
            }
          }
          const selectedModel = current.model || normalized.selectedNoteType;
          if (selectedModel !== current.model) changed = true;
          if (changed) {
            const next = { ...current, model: selectedModel, fields };
            miningDraftRef.current = next;
            setMiningDraft(next);
            miningDirtyRef.current = true;
            setMiningDirty(true);
          }
        }
      } catch (error) {
        if (requestId !== miningOptionsRequestRef.current) return;
        setMiningOptions({
          ...DEFAULT_MINING_OPTIONS,
          suggestedFields: { ...DEFAULT_MINING_OPTIONS.suggestedFields },
          error:
            error instanceof Error
              ? error.message
              : t("settings.hoshidicts.errors.ankiOptions")
        });
      } finally {
        if (requestId === miningOptionsRequestRef.current) {
          setMiningOptionsLoading(false);
        }
      }
    },
    [t]
  );

  const restartOverlay = useCallback(async () => {
    setRestarting(true);
    try {
      await invokeAction(
        HOSHIDICTS_CHANNELS.restartOverlay,
        "settings.hoshidicts.errors.restart"
      );
    } finally {
      setRestarting(false);
    }
  }, [invokeAction]);

  const saveMiningProfile = useCallback(async () => {
    setActionError(null);
    try {
      const result = await invokeIpc<HoshidictsActionResult>(
        HOSHIDICTS_CHANNELS.setMiningProfile,
        {
          ...miningDraft,
          tags: miningDraft.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean)
        }
      );
      const success = applyResult(result, true);
      if (success) {
        miningDirtyRef.current = false;
        setMiningDirty(false);
      }
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : t("settings.hoshidicts.errors.miningProfile")
      );
    }
  }, [applyResult, miningDraft, t]);

  const progressLabel = useMemo(() => {
    const title =
      state.progress.title === "jmdict" ||
      state.progress.title === "jmnedict"
        ? t(RECOMMENDED_KEYS[state.progress.title])
        : (state.progress.title ?? "");
    return t(PROGRESS_KEYS[state.progress.phase], { title });
  }, [state.progress.phase, state.progress.title, t]);

  const lastCheck = formatTimestamp(state.lastCheck);
  const nextCheck = formatTimestamp(state.nextCheck);
  const displayedError = actionError ?? state.lastError;

  return (
    <div className="hoshidicts-window">
      <header className="hoshidicts-window__header">
        <div className="hoshidicts-window__identity">
          <div className="hoshidicts-window__mark" aria-hidden="true">
            <BookOpen size={24} strokeWidth={1.8} />
          </div>
          <div>
            <h1>{t("settings.hoshidicts.appTitle")}</h1>
            <p>{t("settings.hoshidicts.windowSubtitle")}</p>
          </div>
        </div>
        <div
          className="hoshidicts-window__feature-status"
          data-enabled={state.effectiveEnabled}
          role="status"
        >
          {state.effectiveEnabled
            ? t("settings.hoshidicts.enabled")
            : t("settings.hoshidicts.disabled")}
        </div>
      </header>

      {state.overlay.restartRequired ? (
        <div className="hoshidicts-window__restart" role="status">
          <span>{t("settings.hoshidicts.restartNote")}</span>
          <button
            type="button"
            onClick={() => {
              void restartOverlay();
            }}
            disabled={restarting}
          >
            <RotateCw size={16} aria-hidden="true" />
            {restarting
              ? t("settings.hoshidicts.restarting")
              : t("settings.hoshidicts.restartNow")}
          </button>
        </div>
      ) : null}

      <nav className="hoshidicts-window__tabs" aria-label={t("settings.hoshidicts.appTitle")}>
        <button
          type="button"
          className={view === "dictionaries" ? "is-active" : ""}
          aria-selected={view === "dictionaries"}
          onClick={() => setView("dictionaries")}
        >
          {t("settings.hoshidicts.tabs.dictionaries")}
        </button>
        <button
          type="button"
          className={view === "mining" ? "is-active" : ""}
          aria-selected={view === "mining"}
          onClick={() => {
            setView("mining");
            if (view !== "mining") {
              void loadMiningOptions(miningDraft.model || undefined);
            }
          }}
        >
          {t("settings.hoshidicts.tabs.mining")}
        </button>
      </nav>

      <main className="hoshidicts-window__content">
        {state.busy ? (
          <div className="hoshidicts-window__progress" role="status">
            <span>{progressLabel}</span>
            {typeof state.progress.total === "number" &&
            state.progress.total > 0 ? (
              <span>
                {t("settings.hoshidicts.progress.count", {
                  completed: String(state.progress.completed ?? 0),
                  total: String(state.progress.total)
                })}
              </span>
            ) : null}
          </div>
        ) : null}

        {displayedError ? (
          <div className="hoshidicts-window__error" role="alert">
            {displayedError}
          </div>
        ) : null}

        {view === "dictionaries" ? (
          <div className="hoshidicts-dictionaries">
            <section className="hoshidicts-section hoshidicts-lookup-mode">
              <div>
                <h2>{t("settings.hoshidicts.lookup.title")}</h2>
                <p>
                  {state.lookupMode === "shift"
                    ? t("settings.hoshidicts.lookup.shiftHint")
                    : t("settings.hoshidicts.lookup.hoverHint")}
                </p>
              </div>
              <label className="hoshidicts-mining__toggle">
                <input
                  id="hoshidicts-lookup-require-shift"
                  type="checkbox"
                  checked={state.lookupMode === "shift"}
                  disabled={state.busy}
                  onChange={(event) => {
                    void invokeAction(
                      HOSHIDICTS_CHANNELS.setLookupMode,
                      "settings.hoshidicts.errors.lookupMode",
                      event.target.checked ? "shift" : "hover"
                    );
                  }}
                />
                <span>{t("settings.hoshidicts.lookup.requireShift")}</span>
              </label>
            </section>

            <section className="hoshidicts-section hoshidicts-section--toolbar">
              <div className="hoshidicts-actions">
                <button
                  type="button"
                  onClick={() => {
                    void invokeAction(
                      HOSHIDICTS_CHANNELS.importDictionary,
                      "settings.hoshidicts.errors.import"
                    );
                  }}
                  disabled={state.busy}
                >
                  <FileArchive size={17} aria-hidden="true" />
                  {t("settings.hoshidicts.import")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    void invokeAction(
                      HOSHIDICTS_CHANNELS.checkUpdates,
                      "settings.hoshidicts.errors.update"
                    );
                  }}
                  disabled={state.busy}
                >
                  <RefreshCw size={17} aria-hidden="true" />
                  {t("settings.hoshidicts.checkNow")}
                </button>
              </div>

              <label className="hoshidicts-schedule">
                <span>{t("settings.hoshidicts.schedule")}</span>
                <select
                  id="hoshidicts-update-schedule"
                  value={state.schedule}
                  disabled={state.busy}
                  onChange={(event) => {
                    void invokeAction(
                      HOSHIDICTS_CHANNELS.setSchedule,
                      "settings.hoshidicts.errors.schedule",
                      event.target.value as HoshidictsSchedule
                    );
                  }}
                >
                  <option value="off">
                    {t("settings.hoshidicts.schedules.off")}
                  </option>
                  <option value="daily">
                    {t("settings.hoshidicts.schedules.daily")}
                  </option>
                  <option value="weekly">
                    {t("settings.hoshidicts.schedules.weekly")}
                  </option>
                  <option value="monthly">
                    {t("settings.hoshidicts.schedules.monthly")}
                  </option>
                </select>
              </label>

              <div className="hoshidicts-check-times">
                <span>
                  {t("settings.hoshidicts.lastCheck", {
                    time: lastCheck ?? t("settings.hoshidicts.never")
                  })}
                </span>
                <span>
                  {t("settings.hoshidicts.nextCheck", {
                    time:
                      nextCheck ?? t("settings.hoshidicts.notScheduled")
                  })}
                </span>
              </div>
            </section>

            <section className="hoshidicts-section">
              <div className="hoshidicts-section__heading">
                <div>
                  <h2>{t("settings.hoshidicts.recommended.title")}</h2>
                  <p>{t("settings.hoshidicts.recommended.subtitle")}</p>
                </div>
                <button
                  type="button"
                  className="secondary"
                  disabled={
                    state.busy ||
                    state.recommendedDictionaries.every(
                      (dictionary) => dictionary.installed
                    )
                  }
                  onClick={() => {
                    void invokeAction(
                      HOSHIDICTS_CHANNELS.installAllRecommended,
                      "settings.hoshidicts.errors.recommended"
                    );
                  }}
                >
                  {t("settings.hoshidicts.recommended.install")}
                </button>
              </div>
              <div className="hoshidicts-recommended-list">
                {state.recommendedDictionaries.map((dictionary) => (
                  <div
                    className="hoshidicts-recommended-row"
                    key={dictionary.id}
                  >
                    <div>
                      <strong>{t(RECOMMENDED_KEYS[dictionary.id])}</strong>
                      <span>
                        {dictionary.installed
                          ? t("settings.hoshidicts.recommended.installed")
                          : t("settings.hoshidicts.recommended.notInstalled")}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="secondary"
                      disabled={state.busy || dictionary.installed}
                      onClick={() => {
                        void invokeAction(
                          HOSHIDICTS_CHANNELS.installRecommended,
                          "settings.hoshidicts.errors.recommended",
                          { id: dictionary.id }
                        );
                      }}
                    >
                      {dictionary.installed
                        ? t("settings.hoshidicts.recommended.installed")
                        : t("settings.hoshidicts.recommended.installOne")}
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <section className="hoshidicts-section">
              <div className="hoshidicts-section__heading">
                <div>
                  <h2>{t("settings.hoshidicts.installed")}</h2>
                  <p>{t("settings.hoshidicts.priorityHint")}</p>
                </div>
                <span className="hoshidicts-section__count">
                  {state.dictionaries.length}
                </span>
              </div>

              {state.dictionaries.length === 0 ? (
                <div className="hoshidicts-empty">
                  {t("settings.hoshidicts.empty")}
                </div>
              ) : (
                <div className="hoshidicts-dictionary-list">
                  {state.dictionaries.map((dictionary, index) => (
                    <div
                      className={`hoshidicts-dictionary-row ${
                        dictionary.enabled ? "" : "is-disabled"
                      }`}
                      key={dictionary.id}
                    >
                      <label className="hoshidicts-dictionary-row__toggle">
                        <input
                          type="checkbox"
                          checked={dictionary.enabled}
                          disabled={state.busy}
                          aria-label={t(
                            "settings.hoshidicts.enableDictionary",
                            { title: dictionary.title }
                          )}
                          onChange={(event) => {
                            void invokeAction(
                              HOSHIDICTS_CHANNELS.setDictionaryEnabled,
                              "settings.hoshidicts.errors.operation",
                              {
                                id: dictionary.id,
                                enabled: event.target.checked
                              }
                            );
                          }}
                        />
                      </label>
                      <div className="hoshidicts-dictionary-copy">
                        <strong>{dictionary.title}</strong>
                        <div className="hoshidicts-dictionary-meta">
                          <span>
                            {t("settings.hoshidicts.revision", {
                              revision:
                                dictionary.revision ||
                                t("settings.hoshidicts.unknown")
                            })}
                          </span>
                          <span>
                            {t("settings.hoshidicts.language", {
                              language:
                                dictionary.language ||
                                t("settings.hoshidicts.legacyJapanese")
                            })}
                          </span>
                          <span>
                            {t("settings.hoshidicts.terms", {
                              count: String(dictionary.termCount)
                            })}
                          </span>
                          <span>
                            {dictionary.isUpdatable
                              ? t("settings.hoshidicts.updatable")
                              : t("settings.hoshidicts.manualOnly")}
                          </span>
                        </div>
                      </div>
                      <div className="hoshidicts-dictionary-actions">
                        <button
                          type="button"
                          className="hoshidicts-icon-button secondary"
                          title={t("settings.hoshidicts.moveUp")}
                          aria-label={t("settings.hoshidicts.moveUp")}
                          disabled={state.busy || index === 0}
                          onClick={() => {
                            void invokeAction(
                              HOSHIDICTS_CHANNELS.moveDictionary,
                              "settings.hoshidicts.errors.operation",
                              { id: dictionary.id, direction: -1 }
                            );
                          }}
                        >
                          <ArrowUp size={17} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="hoshidicts-icon-button secondary"
                          title={t("settings.hoshidicts.moveDown")}
                          aria-label={t("settings.hoshidicts.moveDown")}
                          disabled={
                            state.busy ||
                            index === state.dictionaries.length - 1
                          }
                          onClick={() => {
                            void invokeAction(
                              HOSHIDICTS_CHANNELS.moveDictionary,
                              "settings.hoshidicts.errors.operation",
                              { id: dictionary.id, direction: 1 }
                            );
                          }}
                        >
                          <ArrowDown size={17} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="hoshidicts-icon-button danger"
                          title={t("settings.hoshidicts.remove")}
                          aria-label={t("settings.hoshidicts.remove")}
                          disabled={state.busy}
                          onClick={() => {
                            void invokeAction(
                              HOSHIDICTS_CHANNELS.removeDictionary,
                              "settings.hoshidicts.errors.remove",
                              dictionary.id
                            );
                          }}
                        >
                          <Trash2 size={17} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        ) : (
          <section className="hoshidicts-section hoshidicts-mining">
            <div className="hoshidicts-section__heading">
              <h2>{t("settings.hoshidicts.mining.title")}</h2>
              <label className="hoshidicts-mining__toggle">
                <input
                  id="hoshidicts-mining-enabled"
                  type="checkbox"
                  checked={miningDraft.enabled}
                  disabled={state.busy}
                  onChange={(event) => {
                    miningDirtyRef.current = true;
                    setMiningDirty(true);
                    updateMiningDraft((current) => ({
                      ...current,
                      enabled: event.target.checked
                    }));
                  }}
                />
                <span>{t("settings.hoshidicts.mining.enabled")}</span>
              </label>
            </div>

            <div className="hoshidicts-anki-status">
              <div
                className="hoshidicts-anki-status__badge"
                data-connected={miningOptions.connected}
                role="status"
              >
                {miningOptionsLoading
                  ? t("settings.hoshidicts.mining.checkingAnki")
                  : miningOptions.connected
                    ? t("settings.hoshidicts.mining.ankiConnected")
                    : t("settings.hoshidicts.mining.ankiDisconnected")}
              </div>
              <button
                type="button"
                className="secondary"
                disabled={miningOptionsLoading}
                onClick={() => {
                  void loadMiningOptions(miningDraft.model || undefined);
                }}
              >
                <RefreshCw size={16} aria-hidden="true" />
                {t("settings.hoshidicts.mining.refreshAnki")}
              </button>
            </div>
            {!miningOptionsLoading &&
            miningOptions.connected &&
            !miningOptions.gsmAnkiEnabled ? (
              <p className="hoshidicts-anki-status__warning" role="alert">
                {t("settings.hoshidicts.mining.gsmAnkiDisabled")}
              </p>
            ) : miningOptions.error ? (
              <p className="hoshidicts-anki-status__warning" role="alert">
                {miningOptions.error}
              </p>
            ) : null}

            <div className="hoshidicts-mining-grid">
              <label>
                <span>{t("settings.hoshidicts.mining.deck")}</span>
                {miningOptions.connected ? (
                  <select
                    id="hoshidicts-mining-deck"
                    value={miningDraft.deck}
                    disabled={state.busy}
                    onChange={(event) => {
                      miningDirtyRef.current = true;
                      setMiningDirty(true);
                      updateMiningDraft((current) => ({
                        ...current,
                        deck: event.target.value
                      }));
                    }}
                  >
                    {miningDraft.deck &&
                    !miningOptions.decks.includes(miningDraft.deck) ? (
                      <option value={miningDraft.deck}>
                        {t("settings.hoshidicts.mining.missingOption", {
                          name: miningDraft.deck
                        })}
                      </option>
                    ) : null}
                    {miningOptions.decks.map((deck) => (
                      <option value={deck} key={deck}>
                        {deck}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="hoshidicts-mining-deck"
                    type="text"
                    value={miningDraft.deck}
                    disabled={state.busy}
                    onChange={(event) => {
                      miningDirtyRef.current = true;
                      setMiningDirty(true);
                      updateMiningDraft((current) => ({
                        ...current,
                        deck: event.target.value
                      }));
                    }}
                  />
                )}
              </label>
              <label>
                <span>{t("settings.hoshidicts.mining.noteType")}</span>
                {miningOptions.connected ? (
                  <select
                    id="hoshidicts-mining-model"
                    value={miningDraft.model}
                    disabled={state.busy}
                    onChange={(event) => {
                      const model = event.target.value;
                      miningDirtyRef.current = true;
                      setMiningDirty(true);
                      updateMiningDraft((current) => ({ ...current, model }));
                      void loadMiningOptions(model);
                    }}
                  >
                    <option value="">
                      {t("settings.hoshidicts.mining.selectNoteType")}
                    </option>
                    {miningDraft.model &&
                    !miningOptions.noteTypes.includes(miningDraft.model) ? (
                      <option value={miningDraft.model}>
                        {t("settings.hoshidicts.mining.missingOption", {
                          name: miningDraft.model
                        })}
                      </option>
                    ) : null}
                    {miningOptions.noteTypes.map((noteType) => (
                      <option value={noteType} key={noteType}>
                        {noteType}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="hoshidicts-mining-model"
                    type="text"
                    value={miningDraft.model}
                    disabled={state.busy}
                    onChange={(event) => {
                      miningDirtyRef.current = true;
                      setMiningDirty(true);
                      updateMiningDraft((current) => ({
                        ...current,
                        model: event.target.value
                      }));
                    }}
                  />
                )}
              </label>
              <label>
                <span>{t("settings.hoshidicts.mining.tags")}</span>
                <input
                  id="hoshidicts-mining-tags"
                  type="text"
                  value={miningDraft.tags}
                  disabled={state.busy}
                  onChange={(event) => {
                    miningDirtyRef.current = true;
                    setMiningDirty(true);
                    updateMiningDraft((current) => ({
                      ...current,
                      tags: event.target.value
                    }));
                  }}
                />
              </label>
              <label>
                <span>{t("settings.hoshidicts.mining.duplicates")}</span>
                <select
                  id="hoshidicts-mining-duplicates"
                  value={miningDraft.duplicatePolicy}
                  disabled={state.busy}
                  onChange={(event) => {
                    miningDirtyRef.current = true;
                    setMiningDirty(true);
                    updateMiningDraft((current) => ({
                      ...current,
                      duplicatePolicy:
                        event.target.value === "allow" ? "allow" : "prevent"
                    }));
                  }}
                >
                  <option value="prevent">
                    {t("settings.hoshidicts.mining.preventDuplicates")}
                  </option>
                  <option value="allow">
                    {t("settings.hoshidicts.mining.allowDuplicates")}
                  </option>
                </select>
              </label>
            </div>

            <details className="hoshidicts-mining-fields">
              <summary>
                {t("settings.hoshidicts.mining.fieldOverrides")}
              </summary>
              <p>{t("settings.hoshidicts.mining.inheritHint")}</p>
              <div className="hoshidicts-mining-grid">
                {MINING_FIELDS.map((field) => (
                  <label key={field.id}>
                    <span>{t(field.labelKey)}</span>
                    {miningOptions.connected && miningOptions.fields.length ? (
                      <select
                        id={`hoshidicts-mining-field-${field.id}`}
                        value={miningDraft.fields[field.id]}
                        disabled={state.busy}
                        onChange={(event) => {
                          const value = event.target.value;
                          miningDirtyRef.current = true;
                          setMiningDirty(true);
                          updateMiningDraft((current) => ({
                            ...current,
                            fields: { ...current.fields, [field.id]: value }
                          }));
                        }}
                      >
                        <option value="">
                          {t("settings.hoshidicts.mining.noField")}
                        </option>
                        {miningDraft.fields[field.id] &&
                        !miningOptions.fields.includes(
                          miningDraft.fields[field.id]
                        ) ? (
                          <option value={miningDraft.fields[field.id]}>
                            {t("settings.hoshidicts.mining.missingOption", {
                              name: miningDraft.fields[field.id]
                            })}
                          </option>
                        ) : null}
                        {miningOptions.fields.map((modelField) => (
                          <option value={modelField} key={modelField}>
                            {modelField}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={`hoshidicts-mining-field-${field.id}`}
                        type="text"
                        value={miningDraft.fields[field.id]}
                        disabled={state.busy}
                        onChange={(event) => {
                          const value = event.target.value;
                          miningDirtyRef.current = true;
                          setMiningDirty(true);
                          updateMiningDraft((current) => ({
                            ...current,
                            fields: { ...current.fields, [field.id]: value }
                          }));
                        }}
                      />
                    )}
                  </label>
                ))}
              </div>
            </details>

            <div className="hoshidicts-mining__footer">
              <button
                type="button"
                disabled={state.busy || !miningDirty}
                onClick={() => {
                  void saveMiningProfile();
                }}
              >
                {state.progress.phase === "saving"
                  ? t("settings.hoshidicts.mining.saving")
                  : t("settings.hoshidicts.mining.save")}
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
