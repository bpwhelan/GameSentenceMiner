import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_HOSHIDICTS_DEFINITION_BLUR,
  DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
  HOSHIDICTS_CHANNELS,
  MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
  MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
  MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
  MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
  MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
  type HoshidictsActionResult,
  type HoshidictsDesktopSnapshot,
  type HoshidictsLookupMode,
  type HoshidictsMiningOptions,
  type HoshidictsMoveDirection,
  type HoshidictsReaderPreferences,
  type HoshidictsRecommendedDictionaryId,
  type HoshidictsSchedule
} from "../../../../shared/features/hoshidicts";
import { useTranslation } from "../../i18n";
import { invokeIpc, onIpc } from "../../lib/ipc";
import {
  DEFAULT_MINING_OPTIONS,
  DEFAULT_MINING_PROFILE,
  type HoshidictsView,
  type MiningField,
  type MiningProfileDraft,
  type SaveStatus,
  draftToProfile,
  isScopedBusy,
  normalizeHoshidictsDesktopState,
  normalizeMiningOptions,
  profileToDraft,
  setFieldChoice
} from "./hoshidictsSettingsModel";

const AUTO_SAVE_DELAY_MS = 400;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function readerPreferencesFromState(
  state: HoshidictsDesktopSnapshot
): HoshidictsReaderPreferences {
  return {
    lookupMode: state.lookupMode,
    popupHideDelayMs: state.popupHideDelayMs,
    definitionBlur: { ...state.definitionBlur }
  };
}

export function useHoshidictsSettingsController() {
  const t = useTranslation();
  const [view, setView] = useState<HoshidictsView>("dictionaries");
  const viewRef = useRef<HoshidictsView>(view);
  const [state, setState] = useState<HoshidictsDesktopSnapshot | null>(null);
  const highestRevisionRef = useRef(-1);
  const initializedRef = useRef(false);

  const initialReaderPreferences: HoshidictsReaderPreferences = {
    lookupMode: "shift",
    popupHideDelayMs: DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
    definitionBlur: { ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR }
  };
  const [readerDraft, setReaderDraft] = useState(initialReaderPreferences);
  const readerDraftRef = useRef(initialReaderPreferences);
  const [readerDirty, setReaderDirty] = useState(false);
  const readerDirtyRef = useRef(false);
  const [readerSaving, setReaderSaving] = useState(false);
  const readerSavingRef = useRef(false);
  const readerEditVersionRef = useRef(0);
  const readerBlockedVersionRef = useRef(-1);
  const [readerSaveStatus, setReaderSaveStatus] = useState<SaveStatus>("idle");

  const initialMiningDraft = profileToDraft(DEFAULT_MINING_PROFILE);
  const [miningDraft, setMiningDraft] =
    useState<MiningProfileDraft>(initialMiningDraft);
  const miningDraftRef = useRef(initialMiningDraft);
  const [miningDirty, setMiningDirty] = useState(false);
  const miningDirtyRef = useRef(false);
  const [miningSaving, setMiningSaving] = useState(false);
  const miningSavingRef = useRef(false);
  const miningEditVersionRef = useRef(0);
  const miningBlockedVersionRef = useRef(-1);
  const [miningSaveStatus, setMiningSaveStatus] = useState<SaveStatus>("idle");

  const [miningOptions, setMiningOptions] = useState<HoshidictsMiningOptions>({
    ...DEFAULT_MINING_OPTIONS,
    suggestedFields: { ...DEFAULT_MINING_OPTIONS.suggestedFields },
    resolvedFields: { ...DEFAULT_MINING_OPTIONS.resolvedFields }
  });
  const [miningOptionsLoading, setMiningOptionsLoading] = useState(false);
  const miningOptionsRequestRef = useRef(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const applyState = useCallback((value: unknown) => {
    const normalized = normalizeHoshidictsDesktopState(value);
    if (normalized.revision < highestRevisionRef.current) return null;
    highestRevisionRef.current = normalized.revision;
    setState(normalized);

    if (!initializedRef.current) {
      initializedRef.current = true;
      const reader = readerPreferencesFromState(normalized);
      const mining = profileToDraft(normalized.miningProfile);
      readerDraftRef.current = reader;
      miningDraftRef.current = mining;
      setReaderDraft(reader);
      setMiningDraft(mining);
      return normalized;
    }

    if (!readerDirtyRef.current && !readerSavingRef.current) {
      const reader = readerPreferencesFromState(normalized);
      readerDraftRef.current = reader;
      setReaderDraft(reader);
    }
    if (!miningDirtyRef.current && !miningSavingRef.current) {
      const mining = profileToDraft(normalized.miningProfile);
      miningDraftRef.current = mining;
      setMiningDraft(mining);
    }
    return normalized;
  }, []);

  const outcomeMessage = useCallback(
    (result: HoshidictsActionResult): string | null => {
      if (!result.outcome) return null;
      return t(`settings.hoshidicts.outcomes.${result.outcome.code}`, {
        count: result.outcome.count ?? 0,
        title: result.outcome.title ?? ""
      });
    },
    [t]
  );

  const applyResult = useCallback(
    (result: HoshidictsActionResult, showOutcome = true): boolean => {
      if (result.state) applyState(result.state);
      if (result.canceled) {
        setActionError(null);
        return true;
      }
      if (!result.success) {
        setActionError(result.error || t("settings.hoshidicts.errors.operation"));
        setNotice(null);
        return false;
      }
      setActionError(null);
      if (showOutcome) setNotice(outcomeMessage(result));
      return true;
    },
    [applyState, outcomeMessage, t]
  );

  const loadMiningOptions = useCallback(
    async (model?: string) => {
      const requestId = miningOptionsRequestRef.current + 1;
      miningOptionsRequestRef.current = requestId;
      setMiningOptionsLoading(true);
      try {
        const value = await invokeIpc<HoshidictsMiningOptions>(
          HOSHIDICTS_CHANNELS.getMiningOptions,
          model || undefined
        );
        if (requestId !== miningOptionsRequestRef.current) return;
        setMiningOptions(normalizeMiningOptions(value));
      } catch (error) {
        if (requestId !== miningOptionsRequestRef.current) return;
        setMiningOptions({
          ...DEFAULT_MINING_OPTIONS,
          suggestedFields: { ...DEFAULT_MINING_OPTIONS.suggestedFields },
          resolvedFields: { ...DEFAULT_MINING_OPTIONS.resolvedFields },
          error: errorMessage(
            error,
            t("settings.hoshidicts.errors.ankiOptions")
          )
        });
      } finally {
        if (requestId === miningOptionsRequestRef.current) {
          setMiningOptionsLoading(false);
        }
      }
    },
    [t]
  );

  useEffect(() => {
    let disposed = false;
    const loadState = () => {
      void invokeIpc<HoshidictsDesktopSnapshot>(HOSHIDICTS_CHANNELS.getState)
        .then((snapshot) => {
          if (!disposed) {
            applyState(snapshot);
            setActionError(null);
          }
        })
        .catch((error) => {
          if (!disposed) {
            setActionError(
              errorMessage(error, t("settings.hoshidicts.errors.load"))
            );
          }
        });
    };
    const refresh = () => {
      loadState();
      if (viewRef.current === "mining") {
        void loadMiningOptions(miningDraftRef.current.model || undefined);
      }
    };

    loadState();
    window.addEventListener("focus", refresh);
    const unsubscribe = onIpc(
      HOSHIDICTS_CHANNELS.progress,
      (_event, snapshot) => {
        if (!disposed) applyState(snapshot);
      }
    );
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
      unsubscribe();
    };
  }, [applyState, loadMiningOptions, t]);

  useEffect(() => {
    if (view === "mining") {
      void loadMiningOptions(miningDraftRef.current.model || undefined);
    }
  }, [loadMiningOptions, view]);

  const updateReaderPreferences = useCallback(
    (update: Partial<HoshidictsReaderPreferences>) => {
      const next = { ...readerDraftRef.current, ...update };
      readerDraftRef.current = next;
      readerEditVersionRef.current += 1;
      readerDirtyRef.current = true;
      setReaderDraft(next);
      setReaderDirty(true);
      setReaderSaveStatus("dirty");
      setActionError(null);
    },
    []
  );

  const setLookupMode = useCallback(
    (lookupMode: HoshidictsLookupMode) => {
      updateReaderPreferences({ lookupMode });
    },
    [updateReaderPreferences]
  );

  const setPopupHideDelayMs = useCallback(
    (popupHideDelayMs: number) => {
      if (!Number.isFinite(popupHideDelayMs)) return;
      updateReaderPreferences({
        popupHideDelayMs: Math.min(
          MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
          Math.max(0, Math.round(popupHideDelayMs))
        )
      });
    },
    [updateReaderPreferences]
  );

  const updateDefinitionBlur = useCallback(
    (
      update: Partial<HoshidictsReaderPreferences["definitionBlur"]>
    ) => {
      updateReaderPreferences({
        definitionBlur: {
          ...readerDraftRef.current.definitionBlur,
          ...update
        }
      });
    },
    [updateReaderPreferences]
  );

  const setDefinitionBlurEnabled = useCallback(
    (enabled: boolean) => updateDefinitionBlur({ enabled }),
    [updateDefinitionBlur]
  );

  const setDefinitionBlurLookupThreshold = useCallback(
    (lookupThreshold: number) => {
      if (!Number.isFinite(lookupThreshold)) return;
      updateDefinitionBlur({
        lookupThreshold: Math.min(
          MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
          Math.max(
            MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
            Math.round(lookupThreshold)
          )
        )
      });
    },
    [updateDefinitionBlur]
  );

  const setDefinitionBlurRevealMode = useCallback(
    (revealMode: HoshidictsReaderPreferences["definitionBlur"]["revealMode"]) =>
      updateDefinitionBlur({ revealMode }),
    [updateDefinitionBlur]
  );

  const setDefinitionBlurRevealDelayMs = useCallback(
    (revealDelayMs: number) => {
      if (!Number.isFinite(revealDelayMs)) return;
      updateDefinitionBlur({
        revealDelayMs: Math.min(
          MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
          Math.max(
            MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
            Math.round(revealDelayMs)
          )
        )
      });
    },
    [updateDefinitionBlur]
  );

  useEffect(() => {
    if (
      !readerDirty ||
      readerSaving ||
      readerBlockedVersionRef.current === readerEditVersionRef.current
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      const request = {
        ...readerDraftRef.current,
        definitionBlur: { ...readerDraftRef.current.definitionBlur }
      };
      const version = readerEditVersionRef.current;
      readerSavingRef.current = true;
      setReaderSaving(true);
      setReaderSaveStatus("saving");
      void invokeIpc<HoshidictsActionResult>(
        HOSHIDICTS_CHANNELS.setReaderPreferences,
        request
      )
        .then((result) => {
          const success = applyResult(result, false);
          if (!success) {
            readerBlockedVersionRef.current = version;
            setReaderSaveStatus("error");
          } else if (readerEditVersionRef.current === version) {
            readerDirtyRef.current = false;
            setReaderDirty(false);
            setReaderSaveStatus("saved");
          } else {
            setReaderSaveStatus("dirty");
          }
        })
        .catch((error) => {
          readerBlockedVersionRef.current = version;
          setActionError(
            errorMessage(error, t("settings.hoshidicts.errors.readerPreferences"))
          );
          setReaderSaveStatus("error");
        })
        .finally(() => {
          readerSavingRef.current = false;
          setReaderSaving(false);
        });
    }, AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [applyResult, readerDirty, readerDraft, readerSaving, t]);

  const updateMiningDraft = useCallback(
    (update: (current: MiningProfileDraft) => MiningProfileDraft) => {
      const next = update(miningDraftRef.current);
      miningDraftRef.current = next;
      miningEditVersionRef.current += 1;
      miningDirtyRef.current = true;
      setMiningDraft(next);
      setMiningDirty(true);
      setMiningSaveStatus("dirty");
      setActionError(null);
    },
    []
  );

  const setMiningModel = useCallback(
    (model: string) => {
      updateMiningDraft((current) => ({ ...current, model }));
      void loadMiningOptions(model || undefined);
    },
    [loadMiningOptions, updateMiningDraft]
  );

  const setMiningField = useCallback(
    (field: MiningField, value: string) => {
      updateMiningDraft((current) => setFieldChoice(current, field, value));
    },
    [updateMiningDraft]
  );

  useEffect(() => {
    if (
      !miningDirty ||
      miningSaving ||
      miningBlockedVersionRef.current === miningEditVersionRef.current
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      const draft = miningDraftRef.current;
      const request = draftToProfile(draft);
      const version = miningEditVersionRef.current;
      miningSavingRef.current = true;
      setMiningSaving(true);
      setMiningSaveStatus("saving");
      void invokeIpc<HoshidictsActionResult>(
        HOSHIDICTS_CHANNELS.setMiningProfile,
        request
      )
        .then((result) => {
          const success = applyResult(result, false);
          if (!success) {
            miningBlockedVersionRef.current = version;
            setMiningSaveStatus("error");
          } else if (miningEditVersionRef.current === version) {
            miningDirtyRef.current = false;
            setMiningDirty(false);
            const saved = profileToDraft(request);
            miningDraftRef.current = saved;
            setMiningDraft(saved);
            setMiningSaveStatus("saved");
          } else {
            setMiningSaveStatus("dirty");
          }
        })
        .catch((error) => {
          miningBlockedVersionRef.current = version;
          setActionError(
            errorMessage(error, t("settings.hoshidicts.errors.miningProfile"))
          );
          setMiningSaveStatus("error");
        })
        .finally(() => {
          miningSavingRef.current = false;
          setMiningSaving(false);
        });
    }, AUTO_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [applyResult, miningDirty, miningDraft, miningSaving, t]);

  const runAction = useCallback(
    async (
      action: () => Promise<HoshidictsActionResult>,
      fallbackKey: string
    ): Promise<boolean> => {
      setActionError(null);
      setNotice(null);
      try {
        return applyResult(await action());
      } catch (error) {
        setActionError(errorMessage(error, t(fallbackKey)));
        return false;
      }
    },
    [applyResult, t]
  );

  const actions = useMemo(
    () => ({
      importDictionary: () =>
        runAction(
          () => invokeIpc(HOSHIDICTS_CHANNELS.importDictionary),
          "settings.hoshidicts.errors.import"
        ),
      checkUpdates: () =>
        runAction(
          () => invokeIpc(HOSHIDICTS_CHANNELS.checkUpdates),
          "settings.hoshidicts.errors.update"
        ),
      installAllRecommended: () =>
        runAction(
          () => invokeIpc(HOSHIDICTS_CHANNELS.installAllRecommended),
          "settings.hoshidicts.errors.recommended"
        ),
      installRecommended: (id: HoshidictsRecommendedDictionaryId) =>
        runAction(
          () => invokeIpc(HOSHIDICTS_CHANNELS.installRecommended, { id }),
          "settings.hoshidicts.errors.recommended"
        ),
      removeDictionary: (id: string) =>
        runAction(
          () => invokeIpc(HOSHIDICTS_CHANNELS.removeDictionary, id),
          "settings.hoshidicts.errors.remove"
        ),
      setDictionaryEnabled: (id: string, enabled: boolean) =>
        runAction(
          () =>
            invokeIpc(HOSHIDICTS_CHANNELS.setDictionaryEnabled, {
              id,
              enabled
            }),
          "settings.hoshidicts.errors.operation"
        ),
      moveDictionary: (id: string, direction: HoshidictsMoveDirection) =>
        runAction(
          () =>
            invokeIpc(HOSHIDICTS_CHANNELS.moveDictionary, { id, direction }),
          "settings.hoshidicts.errors.operation"
        ),
      setSchedule: (schedule: HoshidictsSchedule) =>
        runAction(
          () => invokeIpc(HOSHIDICTS_CHANNELS.setSchedule, schedule),
          "settings.hoshidicts.errors.schedule"
        ),
      restartOverlay: async () => {
        setRestarting(true);
        try {
          return await runAction(
            () => invokeIpc(HOSHIDICTS_CHANNELS.restartOverlay),
            "settings.hoshidicts.errors.restart"
          );
        } finally {
          setRestarting(false);
        }
      }
    }),
    [runAction]
  );

  const dictionaryBusy = state ? isScopedBusy(state, "dictionary") : true;
  const preferencesBusy = state
    ? isScopedBusy(state, "preferences") || readerSaving
    : true;
  const miningBusy = state
    ? isScopedBusy(state, "mining") || miningSaving
    : true;

  return {
    view,
    setView,
    state,
    readerDraft,
    readerSaveStatus,
    setLookupMode,
    setPopupHideDelayMs,
    setDefinitionBlurEnabled,
    setDefinitionBlurLookupThreshold,
    setDefinitionBlurRevealMode,
    setDefinitionBlurRevealDelayMs,
    miningDraft,
    miningOptions,
    miningOptionsLoading,
    miningSaveStatus,
    updateMiningDraft,
    setMiningModel,
    setMiningField,
    loadMiningOptions,
    actionError,
    notice,
    restarting,
    dictionaryBusy,
    preferencesBusy,
    miningBusy,
    actions
  };
}
