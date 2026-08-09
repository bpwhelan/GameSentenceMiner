import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createDefaultHoshidictsFieldOverwriteModes,
  DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
  DEFAULT_HOSHIDICTS_DEFINITION_BLUR,
  DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
  DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
  DEFAULT_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH,
  DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
  DEFAULT_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED,
  DEFAULT_HOSHIDICTS_THEME,
  HOSHIDICTS_CHANNELS,
  MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
  MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
  MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
  MAX_HOSHIDICTS_POPUP_HEIGHT_PX,
  MAX_HOSHIDICTS_POPUP_WIDTH_PX,
  MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
  MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
  MIN_HOSHIDICTS_POPUP_HEIGHT_PX,
  MIN_HOSHIDICTS_POPUP_WIDTH_PX,
  type HoshidictsActionResult,
  type HoshidictsActivationKey,
  type HoshidictsAudioProfile,
  type HoshidictsCreateTabGroupRequest,
  type HoshidictsCustomDictionaryDocument,
  type HoshidictsDeleteTabGroupRequest,
  type HoshidictsDesktopSnapshot,
  type HoshidictsFieldOverwriteMode,
  type HoshidictsDictionaryPresentationRequest,
  type HoshidictsDictionaryScheduleRequest,
  type HoshidictsLookupMode,
  type HoshidictsMiningOptions,
  type HoshidictsMiningProfile,
  type HoshidictsMoveDirection,
  type HoshidictsMoveDictionaryToPositionRequest,
  type HoshidictsMoveTabGroupRequest,
  type HoshidictsReaderPreferences,
  type HoshidictsRenameDictionaryRequest,
  type HoshidictsRenameTabGroupRequest,
  type HoshidictsRecommendedDictionaryId,
  type HoshidictsSaveCustomDictionaryRequest,
  type HoshidictsSchedule,
  type HoshidictsSetTabGroupMembershipRequest,
  type HoshidictsTheme,
  type HoshidictsYomitanImportProgress
} from "../../../../shared/features/hoshidicts";
import { useTranslation } from "../../i18n";
import { invokeIpc, onIpc } from "../../lib/ipc";
import {
  DEFAULT_MINING_OPTIONS,
  DEFAULT_MINING_PROFILE,
  type SaveStatus,
  type HoshidictsView,
  type MiningProfileDraft,
  copyAudioProfile,
  draftToProfile,
  isScopedBusy,
  normalizeHoshidictsDesktopState,
  normalizeMiningOptions,
  profileToDraft,
  setMiningFieldTemplate
} from "./hoshidictsSettingsModel";
import { useHoshidictsAutosave } from "./useHoshidictsAutosave";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function sameMiningModel(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function resetMiningFieldMappings(
  draft: MiningProfileDraft
): MiningProfileDraft {
  return {
    ...draft,
    fields: { ...DEFAULT_MINING_PROFILE.fields },
    disabledFields: [],
    fieldOverwriteModes: createDefaultHoshidictsFieldOverwriteModes(),
    fieldTemplates: null
  };
}

const defaultReaderPreferences = (): HoshidictsReaderPreferences => ({
  lookupMode: "shift",
  activationKey: DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
  sourceHighlightEnabled: DEFAULT_HOSHIDICTS_SOURCE_HIGHLIGHT_ENABLED,
  popupHideDelayMs: DEFAULT_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
  showLookupCounts: true,
  popupNestingMaxDepth: DEFAULT_HOSHIDICTS_POPUP_NESTING_MAX_DEPTH,
  definitionBlur: { ...DEFAULT_HOSHIDICTS_DEFINITION_BLUR },
  popupWidthPx: DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
  popupHeightPx: DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
  theme: DEFAULT_HOSHIDICTS_THEME
});

function copyReaderPreferences(
  preferences: HoshidictsReaderPreferences
): HoshidictsReaderPreferences {
  return {
    ...preferences,
    definitionBlur: { ...preferences.definitionBlur }
  };
}

function copyMiningDraft(draft: MiningProfileDraft): MiningProfileDraft {
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
          )
  };
}

function defaultMiningDraft(): MiningProfileDraft {
  return profileToDraft(DEFAULT_MINING_PROFILE);
}

const savedReaderDraft = (
  _result: HoshidictsActionResult,
  request: HoshidictsReaderPreferences
): HoshidictsReaderPreferences => request;

const savedAudioDraft = (
  result: HoshidictsActionResult
): HoshidictsAudioProfile => result.state.audioProfile;

const savedMiningDraft = (
  _result: HoshidictsActionResult,
  request: HoshidictsMiningProfile
): MiningProfileDraft => profileToDraft(request);

type SyncDraft<T> = (draft: T, force?: boolean) => void;

interface DraftSynchronizers {
  reader: SyncDraft<HoshidictsReaderPreferences>;
  audio: SyncDraft<HoshidictsAudioProfile>;
  mining: SyncDraft<MiningProfileDraft>;
}

type HoshidictsBackupOperation =
  | "exporting"
  | "restoring"
  | "importingYomitanDictionaries"
  | "importingYomitanSettings";

export function useHoshidictsSettingsController() {
  const t = useTranslation();
  const [view, setView] = useState<HoshidictsView>("dictionaries");
  const viewRef = useRef<HoshidictsView>(view);
  const [state, setState] = useState<HoshidictsDesktopSnapshot | null>(null);
  const highestRevisionRef = useRef(-1);
  const initializedRef = useRef(false);

  const [customDocument, setCustomDocument] =
    useState<HoshidictsCustomDictionaryDocument | null>(null);
  const [customDraft, setCustomDraft] = useState("");
  const [customLoading, setCustomLoading] = useState(true);
  const [customSaving, setCustomSaving] = useState(false);
  const [customSaveStatus, setCustomSaveStatus] =
    useState<SaveStatus>("idle");
  const customLoadedRef = useRef(false);
  const customDirty =
    customDocument !== null && customDraft !== customDocument.text;
  const [miningOptions, setMiningOptions] = useState<HoshidictsMiningOptions>({
    ...DEFAULT_MINING_OPTIONS,
    suggestedFields: { ...DEFAULT_MINING_OPTIONS.suggestedFields },
    resolvedFields: { ...DEFAULT_MINING_OPTIONS.resolvedFields },
    suggestedFieldTemplates: {},
    resolvedFieldTemplates: {}
  });
  const [miningOptionsLoading, setMiningOptionsLoading] = useState(false);
  const miningOptionsRequestRef = useRef(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [backupOperation, setBackupOperation] =
    useState<HoshidictsBackupOperation | null>(null);
  const [yomitanImportProgress, setYomitanImportProgress] =
    useState<HoshidictsYomitanImportProgress | null>(null);
  const draftSynchronizersRef = useRef<DraftSynchronizers | null>(null);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const applyState = useCallback((value: unknown, forceDrafts = false) => {
    const normalized = normalizeHoshidictsDesktopState(value);
    if (normalized.revision < highestRevisionRef.current) return null;
    highestRevisionRef.current = normalized.revision;
    setState(normalized);

    const synchronizers = draftSynchronizersRef.current;
    if (!synchronizers) return normalized;

    const reader = {
      lookupMode: normalized.lookupMode,
      activationKey: normalized.activationKey,
      sourceHighlightEnabled: normalized.sourceHighlightEnabled,
      popupHideDelayMs: normalized.popupHideDelayMs,
      showLookupCounts: normalized.showLookupCounts,
      popupNestingMaxDepth: normalized.popupNestingMaxDepth,
      definitionBlur: { ...normalized.definitionBlur },
      popupWidthPx: normalized.popupWidthPx,
      popupHeightPx: normalized.popupHeightPx,
      theme: normalized.theme
    };
    const mining = profileToDraft(normalized.miningProfile);
    const audio = copyAudioProfile(normalized.audioProfile);
    if (!initializedRef.current) {
      initializedRef.current = true;
      synchronizers.reader(reader, true);
      synchronizers.mining(mining, true);
      synchronizers.audio(audio, true);
      return normalized;
    }
    synchronizers.reader(reader, forceDrafts);
    synchronizers.mining(mining, forceDrafts);
    synchronizers.audio(audio, forceDrafts);
    return normalized;
  }, []);

  const outcomeMessage = useCallback(
    (result: HoshidictsActionResult): string | null => {
      if (!result.outcome) return null;
      return t(`settings.hoshidicts.outcomes.${result.outcome.code}`, {
        count: result.outcome.count ?? 0,
        title: result.outcome.title ?? "",
        dictionaries:
          (result.yomitanReport?.imported ?? 0) +
          (result.yomitanReport?.replaced ?? 0),
        settings: result.yomitanReport?.settings.length ?? 0,
        warnings: result.yomitanReport?.warnings.length ?? 0
      });
    },
    [t]
  );

  const applyResult = useCallback(
    (
      result: HoshidictsActionResult,
      showOutcome = true,
      forceDrafts = false
    ): boolean => {
      if (result.state) applyState(result.state, forceDrafts);
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

  const readerAutosave = useHoshidictsAutosave({
    initialDraft: defaultReaderPreferences,
    cloneDraft: copyReaderPreferences,
    toRequest: copyReaderPreferences,
    savedDraft: savedReaderDraft,
    channel: HOSHIDICTS_CHANNELS.setReaderPreferences,
    errorFallback: t("settings.hoshidicts.errors.readerPreferences"),
    applyResult,
    setActionError
  });
  const audioAutosave = useHoshidictsAutosave({
    initialDraft: copyAudioProfile,
    cloneDraft: copyAudioProfile,
    toRequest: copyAudioProfile,
    savedDraft: savedAudioDraft,
    channel: HOSHIDICTS_CHANNELS.setAudioProfile,
    errorFallback: t("settings.hoshidicts.errors.audioProfile"),
    applyResult,
    setActionError
  });
  const miningAutosave = useHoshidictsAutosave({
    initialDraft: defaultMiningDraft,
    cloneDraft: copyMiningDraft,
    toRequest: draftToProfile,
    savedDraft: savedMiningDraft,
    channel: HOSHIDICTS_CHANNELS.setMiningProfile,
    errorFallback: t("settings.hoshidicts.errors.miningProfile"),
    applyResult,
    setActionError,
    paused: miningOptionsLoading
  });
  draftSynchronizersRef.current = {
    reader: readerAutosave.syncDraft,
    audio: audioAutosave.syncDraft,
    mining: miningAutosave.syncDraft
  };

  const {
    draft: readerDraft,
    draftRef: readerDraftRef,
    updateDraft: updateReaderDraft,
    saving: readerSaving,
    saveStatus: readerSaveStatus
  } = readerAutosave;
  const {
    draft: audioDraft,
    updateDraft: updateAudioDraft,
    saving: audioSaving,
    saveStatus: audioSaveStatus
  } = audioAutosave;
  const {
    draft: miningDraft,
    draftRef: miningDraftRef,
    updateDraft: updateMiningDraft,
    saving: miningSaving,
    saveStatus: miningSaveStatus
  } = miningAutosave;

  const loadMiningOptions = useCallback(
    async (model?: string) => {
      const requestId = miningOptionsRequestRef.current + 1;
      miningOptionsRequestRef.current = requestId;
      setMiningOptionsLoading(true);
      try {
        const value = await invokeIpc<HoshidictsMiningOptions>(
          HOSHIDICTS_CHANNELS.getMiningOptions,
          model
        );
        if (requestId !== miningOptionsRequestRef.current) return null;
        const normalized = normalizeMiningOptions(value);
        setMiningOptions(normalized);
        return normalized;
      } catch (error) {
        if (requestId !== miningOptionsRequestRef.current) return null;
        setMiningOptions({
          ...DEFAULT_MINING_OPTIONS,
          suggestedFields: { ...DEFAULT_MINING_OPTIONS.suggestedFields },
          resolvedFields: { ...DEFAULT_MINING_OPTIONS.resolvedFields },
          suggestedFieldTemplates: {},
          resolvedFieldTemplates: {},
          error: errorMessage(
            error,
            t("settings.hoshidicts.errors.ankiOptions")
          )
        });
        return null;
      } finally {
        if (requestId === miningOptionsRequestRef.current) {
          setMiningOptionsLoading(false);
        }
      }
    },
    [t]
  );

  const loadCustomDictionary = useCallback(async (force = false) => {
    if (customLoadedRef.current && !force) return;
    customLoadedRef.current = true;
    setCustomLoading(true);
    try {
      const document = await invokeIpc<HoshidictsCustomDictionaryDocument>(
        HOSHIDICTS_CHANNELS.getCustomDictionary
      );
      setCustomDocument(document);
      setCustomDraft(document.text);
      setCustomSaveStatus("idle");
      setActionError(null);
    } catch (error) {
      customLoadedRef.current = false;
      setActionError(
        errorMessage(error, t("settings.hoshidicts.errors.customLoad"))
      );
    } finally {
      setCustomLoading(false);
    }
  }, [t]);

  const reloadCustomDictionary = useCallback(async (
    confirmDiscard = true
  ): Promise<boolean> => {
    if (
      confirmDiscard &&
      customDirty &&
      !window.confirm(t("settings.hoshidicts.custom.reloadConfirm"))
    ) {
      return false;
    }
    await loadCustomDictionary(true);
    return true;
  }, [customDirty, loadCustomDictionary, t]);

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
    const unsubscribeYomitanImportProgress = onIpc(
      HOSHIDICTS_CHANNELS.yomitanImportProgress,
      (_event, progress) => {
        if (!disposed) {
          setYomitanImportProgress(
            progress as HoshidictsYomitanImportProgress | null
          );
        }
      }
    );
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
      unsubscribe();
      unsubscribeYomitanImportProgress();
    };
  }, [applyState, loadMiningOptions, t]);

  useEffect(() => {
    if (view === "mining") {
      void loadMiningOptions(miningDraftRef.current.model || undefined);
    } else if (view === "custom") {
      void loadCustomDictionary();
    }
  }, [loadCustomDictionary, loadMiningOptions, view]);

  const updateCustomDraft = useCallback((text: string) => {
    setCustomDraft(text);
    setCustomSaveStatus(text === customDocument?.text ? "idle" : "dirty");
    setActionError(null);
    setNotice(null);
  }, [customDocument]);

  const saveCustomDictionary = useCallback(async (): Promise<boolean> => {
    if (!customDocument || customSaving || !customDirty) {
      return false;
    }
    const request: HoshidictsSaveCustomDictionaryRequest = {
      text: customDraft,
      expectedRevision: customDocument.revision
    };
    setCustomSaving(true);
    setCustomSaveStatus("saving");
    setActionError(null);
    setNotice(null);
    try {
      const result = await invokeIpc<HoshidictsActionResult>(
        HOSHIDICTS_CHANNELS.saveCustomDictionary,
        request
      );
      if (!applyResult(result)) {
        setCustomSaveStatus("error");
        return false;
      }
      if (!result.document) {
        setActionError(t("settings.hoshidicts.errors.customSave"));
        setCustomSaveStatus("error");
        return false;
      }
      setCustomDocument(result.document);
      setCustomDraft(result.document.text);
      setCustomSaveStatus("saved");
      return true;
    } catch (error) {
      setActionError(
        errorMessage(error, t("settings.hoshidicts.errors.customSave"))
      );
      setCustomSaveStatus("error");
      return false;
    } finally {
      setCustomSaving(false);
    }
  }, [applyResult, customDirty, customDocument, customDraft, customSaving, t]);

  const updateReaderPreferences = useCallback(
    (update: Partial<HoshidictsReaderPreferences>) => {
      updateReaderDraft((current) => ({ ...current, ...update }));
    },
    [updateReaderDraft]
  );

  const setLookupMode = useCallback(
    (lookupMode: HoshidictsLookupMode) => {
      updateReaderPreferences({ lookupMode });
    },
    [updateReaderPreferences]
  );

  const setActivationKey = useCallback(
    (activationKey: HoshidictsActivationKey) => {
      updateReaderPreferences({ activationKey });
    },
    [updateReaderPreferences]
  );

  const setSourceHighlightEnabled = useCallback(
    (sourceHighlightEnabled: boolean) => {
      updateReaderPreferences({ sourceHighlightEnabled });
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

  const setPopupWidthPx = useCallback(
    (popupWidthPx: number) => {
      if (!Number.isFinite(popupWidthPx)) return;
      updateReaderPreferences({
        popupWidthPx: Math.min(
          MAX_HOSHIDICTS_POPUP_WIDTH_PX,
          Math.max(MIN_HOSHIDICTS_POPUP_WIDTH_PX, Math.round(popupWidthPx))
        )
      });
    },
    [updateReaderPreferences]
  );

  const setPopupHeightPx = useCallback(
    (popupHeightPx: number) => {
      if (!Number.isFinite(popupHeightPx)) return;
      updateReaderPreferences({
        popupHeightPx: Math.min(
          MAX_HOSHIDICTS_POPUP_HEIGHT_PX,
          Math.max(MIN_HOSHIDICTS_POPUP_HEIGHT_PX, Math.round(popupHeightPx))
        )
      });
    },
    [updateReaderPreferences]
  );

  const setTheme = useCallback(
    (theme: HoshidictsTheme) => updateReaderPreferences({ theme }),
    [updateReaderPreferences]
  );

  const resetPopupSize = useCallback(() => {
    updateReaderPreferences({
      popupWidthPx: DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
      popupHeightPx: DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX
    });
  }, [updateReaderPreferences]);

  const setShowLookupCounts = useCallback(
    (showLookupCounts: boolean) => {
      updateReaderPreferences({ showLookupCounts });
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

  const setPopupContentScanningEnabled = useCallback(
    (enabled: boolean) => {
      const currentDepth = readerDraftRef.current.popupNestingMaxDepth;
      updateReaderPreferences({
        popupNestingMaxDepth: enabled ? Math.max(1, currentDepth) : 0
      });
    },
    [updateReaderPreferences]
  );

  const setPopupNestingMaxDepth = useCallback(
    (popupNestingMaxDepth: number) => {
      if (!Number.isFinite(popupNestingMaxDepth)) return;
      updateReaderPreferences({
        popupNestingMaxDepth: Math.min(
          Number.MAX_SAFE_INTEGER,
          Math.max(1, Math.round(popupNestingMaxDepth))
        )
      });
    },
    [updateReaderPreferences]
  );
  const setMiningModel = useCallback(
    (model: string) => {
      const previousEffectiveModel = miningOptions.selectedNoteType;
      const resetImmediately =
        model.trim().length > 0 &&
        !sameMiningModel(model, previousEffectiveModel);
      updateMiningDraft((current) => {
        const next = { ...current, model };
        return resetImmediately ? resetMiningFieldMappings(next) : next;
      });
      if (resetImmediately) {
        setMiningOptions((current) => ({
          ...DEFAULT_MINING_OPTIONS,
          connected: current.connected,
          gsmAnkiEnabled: current.gsmAnkiEnabled,
          decks: current.decks,
          noteTypes: current.noteTypes,
          selectedNoteType: model,
          suggestedFields: { ...DEFAULT_MINING_OPTIONS.suggestedFields },
          resolvedFields: { ...DEFAULT_MINING_OPTIONS.resolvedFields },
          suggestedFieldTemplates: {},
          resolvedFieldTemplates: {}
        }));
      }
      void loadMiningOptions(model).then((loaded) => {
        if (
          loaded === null ||
          resetImmediately ||
          sameMiningModel(previousEffectiveModel, loaded.selectedNoteType) ||
          miningDraftRef.current.model !== model
        ) {
          return;
        }
        updateMiningDraft((current) => resetMiningFieldMappings(current));
      });
    },
    [loadMiningOptions, miningOptions.selectedNoteType, updateMiningDraft]
  );

  const setMiningField = useCallback(
    (
      field: string,
      update: { value?: string; overwriteMode?: HoshidictsFieldOverwriteMode }
    ) => {
      updateMiningDraft((current) =>
        setMiningFieldTemplate(current, miningOptions, field, update)
      );
    },
    [miningOptions, updateMiningDraft]
  );

  const runAction = useCallback(
    async (
      action: () => Promise<HoshidictsActionResult>,
      fallbackKey: string,
      forceDrafts = false
    ): Promise<boolean> => {
      setActionError(null);
      setNotice(null);
      try {
        const result = await action();
        const success = applyResult(result, true, forceDrafts);
        if (success && forceDrafts && result.state) {
          void loadMiningOptions();
        }
        return success;
      } catch (error) {
        setActionError(errorMessage(error, t(fallbackKey)));
        return false;
      }
    },
    [applyResult, loadMiningOptions, t]
  );

  const actions = useMemo(
    () => ({
      exportBackup: async () => {
        setBackupOperation("exporting");
        try {
          return await runAction(
            () => invokeIpc(HOSHIDICTS_CHANNELS.exportBackup),
            "settings.hoshidicts.errors.exportBackup"
          );
        } finally {
          setBackupOperation(null);
        }
      },
      restoreBackup: async () => {
        setBackupOperation("restoring");
        try {
          return await runAction(
            () => invokeIpc(HOSHIDICTS_CHANNELS.restoreBackup),
            "settings.hoshidicts.errors.restoreBackup",
            true
          );
        } finally {
          setBackupOperation(null);
        }
      },
      importDictionary: () =>
        runAction(
          () => invokeIpc(HOSHIDICTS_CHANNELS.importDictionary),
          "settings.hoshidicts.errors.import"
        ),
      importYomitanDictionaries: async () => {
        setBackupOperation("importingYomitanDictionaries");
        setYomitanImportProgress(null);
        try {
          return await runAction(
            () => invokeIpc(HOSHIDICTS_CHANNELS.importYomitanDictionaries),
            "settings.hoshidicts.errors.importYomitanDictionaries",
            true
          );
        } finally {
          setYomitanImportProgress(null);
          setBackupOperation(null);
        }
      },
      importYomitanSettings: async () => {
        setBackupOperation("importingYomitanSettings");
        try {
          return await runAction(
            () => invokeIpc(HOSHIDICTS_CHANNELS.importYomitanSettings),
            "settings.hoshidicts.errors.importYomitanSettings",
            true
          );
        } finally {
          setBackupOperation(null);
        }
      },
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
      setDictionaryPresentation: (id: string, favorite: boolean) =>
        runAction(
          () =>
            invokeIpc(
              HOSHIDICTS_CHANNELS.setDictionaryPresentation,
              {
                id,
                favorite
              } satisfies HoshidictsDictionaryPresentationRequest
            ),
          "settings.hoshidicts.errors.operation"
        ),
      createTabGroup: (name: string, dictionaryId?: string) =>
        runAction(
          () =>
            invokeIpc(
              HOSHIDICTS_CHANNELS.createTabGroup,
              {
                name,
                ...(dictionaryId ? { dictionaryId } : {})
              } satisfies HoshidictsCreateTabGroupRequest
            ),
          "settings.hoshidicts.errors.tabGroups"
        ),
      setTabGroupMembership: (
        groupId: string,
        dictionaryId: string,
        member: boolean
      ) =>
        runAction(
          () =>
            invokeIpc(
              HOSHIDICTS_CHANNELS.setTabGroupMembership,
              {
                groupId,
                dictionaryId,
                member
              } satisfies HoshidictsSetTabGroupMembershipRequest
            ),
          "settings.hoshidicts.errors.tabGroups"
        ),
      renameTabGroup: (groupId: string, name: string) =>
        runAction(
          () =>
            invokeIpc(
              HOSHIDICTS_CHANNELS.renameTabGroup,
              { groupId, name } satisfies HoshidictsRenameTabGroupRequest
            ),
          "settings.hoshidicts.errors.tabGroups"
        ),
      deleteTabGroup: (groupId: string) =>
        runAction(
          () =>
            invokeIpc(
              HOSHIDICTS_CHANNELS.deleteTabGroup,
              { groupId } satisfies HoshidictsDeleteTabGroupRequest
            ),
          "settings.hoshidicts.errors.tabGroups"
        ),
      moveTabGroup: (groupId: string, direction: HoshidictsMoveDirection) =>
        runAction(
          () =>
            invokeIpc(
              HOSHIDICTS_CHANNELS.moveTabGroup,
              { groupId, direction } satisfies HoshidictsMoveTabGroupRequest
            ),
          "settings.hoshidicts.errors.tabGroups"
        ),
      setDictionarySchedule: (
        id: string,
        schedule: HoshidictsSchedule | null
      ) =>
        runAction(
          () =>
            invokeIpc(
              HOSHIDICTS_CHANNELS.setDictionarySchedule,
              { id, schedule } satisfies HoshidictsDictionaryScheduleRequest
            ),
          "settings.hoshidicts.errors.dictionarySchedule"
        ),
      renameDictionary: (id: string, displayName: string | null) =>
        runAction(
          () =>
            invokeIpc(
              HOSHIDICTS_CHANNELS.renameDictionary,
              {
                id,
                displayName
              } satisfies HoshidictsRenameDictionaryRequest
            ),
          "settings.hoshidicts.errors.rename"
        ),
      moveDictionary: (id: string, direction: HoshidictsMoveDirection) =>
        runAction(
          () =>
            invokeIpc(HOSHIDICTS_CHANNELS.moveDictionary, { id, direction }),
          "settings.hoshidicts.errors.operation"
        ),
      moveDictionaryToPosition: (id: string, position: number) =>
        runAction(
          () =>
            invokeIpc(
              HOSHIDICTS_CHANNELS.moveDictionaryToPosition,
              { id, position } satisfies HoshidictsMoveDictionaryToPositionRequest
            ),
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

  const dictionaryBusy = state
    ? backupOperation !== null || isScopedBusy(state, "dictionary")
    : true;
  const preferencesBusy = state
    ? backupOperation !== null ||
      isScopedBusy(state, "preferences") ||
      readerSaving
    : true;
  const miningBusy = state
    ? backupOperation !== null ||
      isScopedBusy(state, "mining") ||
      miningSaving
    : true;
  const audioBusy = state
    ? backupOperation !== null ||
      isScopedBusy(state, "audio") ||
      audioSaving
    : true;
  const customBusy = state
    ? backupOperation !== null ||
      isScopedBusy(state, "custom") ||
      customLoading ||
      customSaving
    : true;
  const backupBusy = state
    ? backupOperation !== null ||
      state.busy ||
      readerSaving ||
      miningSaving ||
      audioSaving ||
      customSaving
    : true;

  return {
    view,
    setView,
    state,
    readerDraft,
    readerSaveStatus,
    setLookupMode,
    setActivationKey,
    setSourceHighlightEnabled,
    setPopupHideDelayMs,
    setPopupWidthPx,
    setPopupHeightPx,
    setTheme,
    resetPopupSize,
    setShowLookupCounts,
    setDefinitionBlurEnabled,
    setDefinitionBlurLookupThreshold,
    setDefinitionBlurRevealMode,
    setDefinitionBlurRevealDelayMs,
    setPopupContentScanningEnabled,
    setPopupNestingMaxDepth,
    audioDraft,
    audioSaveStatus,
    updateAudioDraft,
    miningDraft,
    miningOptions,
    miningOptionsLoading,
    miningSaveStatus,
    updateMiningDraft,
    setMiningModel,
    setMiningField,
    loadMiningOptions,
    customDocument,
    customDraft,
    customDirty,
    customLoading,
    customSaveStatus,
    updateCustomDraft,
    saveCustomDictionary,
    reloadCustomDictionary,
    actionError,
    notice,
    restarting,
    backupOperation,
    yomitanImportProgress,
    backupBusy,
    dictionaryBusy,
    preferencesBusy,
    audioBusy,
    miningBusy,
    customBusy,
    actions
  };
}
