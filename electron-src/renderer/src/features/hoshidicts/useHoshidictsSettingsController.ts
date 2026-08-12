import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cloneHoshidictsReaderPreferences,
  createDefaultHoshidictsFieldOverwriteModes,
  createDefaultHoshidictsReaderPreferences,
  DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
  DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
  HOSHIDICTS_CHANNELS,
  MAX_HOSHIDICTS_CUSTOM_POPUP_CSS_LENGTH,
  normalizeHoshidictsReaderPreferences,
  type HoshidictsActionResult,
  type HoshidictsAudioProfile,
  type HoshidictsBulkDictionaryAction,
  type HoshidictsBulkDictionaryActionRequest,
  type HoshidictsCreateProfileRequest,
  type HoshidictsCreateTabGroupRequest,
  type HoshidictsCustomDictionaryDocument,
  type HoshidictsDefinitionBlurPreferences,
  type HoshidictsDeleteTabGroupRequest,
  type HoshidictsDesktopSnapshot,
  type HoshidictsDictionaryPresentationRequest,
  type HoshidictsDictionaryScheduleRequest,
  type HoshidictsFieldOverwriteMode,
  type HoshidictsMiningOptions,
  type HoshidictsMiningProfile,
  type HoshidictsMoveDictionaryToPositionRequest,
  type HoshidictsMoveDirection,
  type HoshidictsMoveTabGroupRequest,
  type HoshidictsNumericReaderPreference,
  type HoshidictsPopupButtons,
  type HoshidictsProfileIdRequest,
  type HoshidictsReaderPreferences,
  type HoshidictsRecommendedDictionaryId,
  type HoshidictsRenameDictionaryRequest,
  type HoshidictsRenameProfileRequest,
  type HoshidictsRenameTabGroupRequest,
  type HoshidictsSaveCustomDictionaryRequest,
  type HoshidictsSchedule,
  type HoshidictsSetTabGroupMembershipRequest
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

function clampInteger(
  value: number,
  minimum: number,
  maximum: number
): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

type NumericDefinitionBlurPreference = {
  [K in keyof HoshidictsDefinitionBlurPreferences]-?: HoshidictsDefinitionBlurPreferences[K] extends number
    ? K
    : never;
}[keyof HoshidictsDefinitionBlurPreferences];

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

// Hoisted so it keeps one identity: the autosave debounce depends on saveNow,
// which depends on savedDraft, so an inline arrow would restart the timer on
// every unrelated re-render.
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
  const [profileSwitching, setProfileSwitching] = useState(false);
  const draftSynchronizersRef = useRef<DraftSynchronizers | null>(null);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const applyState = useCallback((value: unknown, forceDrafts = false) => {
    if (!value || typeof value !== "object") return null;
    const normalized = value as HoshidictsDesktopSnapshot;
    if (normalized.revision < highestRevisionRef.current) return null;
    highestRevisionRef.current = normalized.revision;
    setState(normalized);

    const synchronizers = draftSynchronizersRef.current;
    if (!synchronizers) return normalized;

    const reader = normalizeHoshidictsReaderPreferences(normalized);
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
        title: result.outcome.title ?? ""
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
    initialDraft: createDefaultHoshidictsReaderPreferences,
    cloneDraft: cloneHoshidictsReaderPreferences,
    toRequest: cloneHoshidictsReaderPreferences,
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
    saveStatus: readerSaveStatus,
    flush: flushReader
  } = readerAutosave;
  const {
    draft: audioDraft,
    updateDraft: updateAudioDraft,
    saving: audioSaving,
    saveStatus: audioSaveStatus,
    flush: flushAudio
  } = audioAutosave;
  const {
    draft: miningDraft,
    draftRef: miningDraftRef,
    updateDraft: updateMiningDraft,
    saving: miningSaving,
    saveStatus: miningSaveStatus,
    flush: flushMining
  } = miningAutosave;

  const flushAutosaves = useCallback(async (): Promise<boolean> => {
    const results = await Promise.all([
      flushReader(),
      flushAudio(),
      flushMining()
    ]);
    return results.every(Boolean);
  }, [flushAudio, flushMining, flushReader]);

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
        const normalized = value;
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
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
      unsubscribe();
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

  const setReaderPreference = useCallback(
    <K extends keyof HoshidictsReaderPreferences>(
      key: K,
      value: HoshidictsReaderPreferences[K]
    ) => {
      updateReaderDraft((current) => ({ ...current, [key]: value }));
    },
    [updateReaderDraft]
  );

  const setBoundedReaderInteger = useCallback(
    (
      key: HoshidictsNumericReaderPreference,
      value: number,
      minimum: number,
      maximum: number
    ) => {
      const bounded = clampInteger(value, minimum, maximum);
      if (bounded !== null) setReaderPreference(key, bounded);
    },
    [setReaderPreference]
  );

  const setCustomPopupCss = useCallback(
    (customPopupCss: string) => {
      setReaderPreference(
        "customPopupCss",
        customPopupCss.slice(0, MAX_HOSHIDICTS_CUSTOM_POPUP_CSS_LENGTH)
      );
    },
    [setReaderPreference]
  );

  const updatePopupButtons = useCallback(
    (update: Partial<HoshidictsPopupButtons>) => {
      setReaderPreference("popupButtons", {
        ...readerDraftRef.current.popupButtons,
        ...update
      });
    },
    [readerDraftRef, setReaderPreference]
  );

  const setPopupButtonEnabled = useCallback(
    (
      button: "addToAnki" | "audio" | "customDefinition" | "viewInAnki",
      enabled: boolean
    ) => {
      updatePopupButtons({ [button]: enabled });
    },
    [updatePopupButtons]
  );

  const setPopupCustomLinks = useCallback(
    (customLinks: HoshidictsPopupButtons["customLinks"]) => {
      updatePopupButtons({
        customLinks: customLinks.map((link) => ({ ...link }))
      });
    },
    [updatePopupButtons]
  );

  const resetPopupSize = useCallback(() => {
    updateReaderDraft((current) => ({
      ...current,
      popupWidthPx: DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
      popupHeightPx: DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX
    }));
  }, [updateReaderDraft]);

  const setDefinitionBlurPreference = useCallback(
    <K extends keyof HoshidictsDefinitionBlurPreferences>(
      key: K,
      value: HoshidictsDefinitionBlurPreferences[K]
    ) => {
      setReaderPreference("definitionBlur", {
        ...readerDraftRef.current.definitionBlur,
        [key]: value
      });
    },
    [readerDraftRef, setReaderPreference]
  );

  const setBoundedDefinitionBlurInteger = useCallback(
    (
      key: NumericDefinitionBlurPreference,
      value: number,
      minimum: number,
      maximum: number
    ) => {
      const bounded = clampInteger(value, minimum, maximum);
      if (bounded !== null) setDefinitionBlurPreference(key, bounded);
    },
    [setDefinitionBlurPreference]
  );

  // Zero disables nested popups, so enabling restores one child level.
  const setPopupContentScanningEnabled = useCallback(
    (enabled: boolean) => {
      setReaderPreference(
        "popupNestingMaxDepth",
        enabled ? Math.max(1, readerDraftRef.current.popupNestingMaxDepth) : 0
      );
    },
    [readerDraftRef, setReaderPreference]
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

  /** runAction for the entries that are just one IPC call and one error key. */
  const ipcAction = useCallback(
    (channel: string, fallbackKey: string, ...args: unknown[]) =>
      runAction(() => invokeIpc(channel, ...args), fallbackKey),
    [runAction]
  );

  const actions = useMemo(
    () => ({
      createProfile: async (name: string) => {
        setProfileSwitching(true);
        try {
          if (!(await flushAutosaves())) return false;
          return await runAction(
            () =>
              invokeIpc(
                HOSHIDICTS_CHANNELS.createProfile,
                { name } satisfies HoshidictsCreateProfileRequest
              ),
            "settings.hoshidicts.errors.profiles",
            true
          );
        } finally {
          setProfileSwitching(false);
        }
      },
      switchProfile: async (id: string) => {
        if (state?.activeProfileId === id) return true;
        setProfileSwitching(true);
        try {
          if (!(await flushAutosaves())) return false;
          return await runAction(
            () =>
              invokeIpc(
                HOSHIDICTS_CHANNELS.switchProfile,
                { id } satisfies HoshidictsProfileIdRequest
              ),
            "settings.hoshidicts.errors.profiles",
            true
          );
        } finally {
          setProfileSwitching(false);
        }
      },
      renameProfile: (id: string, name: string) =>
        ipcAction(
          HOSHIDICTS_CHANNELS.renameProfile,
          "settings.hoshidicts.errors.profiles",
          { id, name } satisfies HoshidictsRenameProfileRequest
        ),
      deleteProfile: async (id: string) => {
        setProfileSwitching(true);
        try {
          if (state?.activeProfileId === id && !(await flushAutosaves())) {
            return false;
          }
          return await runAction(
            () =>
              invokeIpc(
                HOSHIDICTS_CHANNELS.deleteProfile,
                { id } satisfies HoshidictsProfileIdRequest
              ),
            "settings.hoshidicts.errors.profiles",
            state?.activeProfileId === id
          );
        } finally {
          setProfileSwitching(false);
        }
      },
      importDictionary: () =>
        ipcAction(
          HOSHIDICTS_CHANNELS.importDictionary,
          "settings.hoshidicts.errors.import",
        ),
      checkUpdates: () =>
        ipcAction(
          HOSHIDICTS_CHANNELS.checkUpdates,
          "settings.hoshidicts.errors.update",
        ),
      installAllRecommended: () =>
        ipcAction(
          HOSHIDICTS_CHANNELS.installAllRecommended,
          "settings.hoshidicts.errors.recommended",
        ),
      installRecommended: (id: HoshidictsRecommendedDictionaryId) =>
        ipcAction(
          HOSHIDICTS_CHANNELS.installRecommended,
          "settings.hoshidicts.errors.recommended",
          { id }
        ),
      removeDictionary: (id: string) =>
        ipcAction(
          HOSHIDICTS_CHANNELS.removeDictionary,
          "settings.hoshidicts.errors.remove",
          id
        ),
      setDictionaryEnabled: (id: string, enabled: boolean) =>
        ipcAction(
          HOSHIDICTS_CHANNELS.setDictionaryEnabled,
          "settings.hoshidicts.errors.operation",
          { id, enabled }
        ),
      setDictionaryPresentation: (id: string, favorite: boolean) =>
        ipcAction(
          HOSHIDICTS_CHANNELS.setDictionaryPresentation,
          "settings.hoshidicts.errors.operation",
          { id, favorite } satisfies HoshidictsDictionaryPresentationRequest
        ),
      bulkDictionaryAction: (
        action: HoshidictsBulkDictionaryAction,
        ids: string[]
      ) =>
        runAction(
          () =>
            invokeIpc(
              HOSHIDICTS_CHANNELS.bulkDictionaryAction,
              { action, ids } satisfies HoshidictsBulkDictionaryActionRequest
            ),
          action === "update"
            ? "settings.hoshidicts.errors.update"
            : "settings.hoshidicts.errors.operation"
        ),
      createTabGroup: (name: string, dictionaryId?: string) =>
        ipcAction(
          HOSHIDICTS_CHANNELS.createTabGroup,
          "settings.hoshidicts.errors.tabGroups",
          { name, ...(dictionaryId ? { dictionaryId } : {}) } satisfies HoshidictsCreateTabGroupRequest
        ),
      setTabGroupMembership: (
        groupId: string,
        dictionaryId: string,
        member: boolean
      ) =>
        ipcAction(
          HOSHIDICTS_CHANNELS.setTabGroupMembership,
          "settings.hoshidicts.errors.tabGroups",
          { groupId, dictionaryId, member } satisfies HoshidictsSetTabGroupMembershipRequest
        ),
      renameTabGroup: (groupId: string, name: string) =>
        ipcAction(
          HOSHIDICTS_CHANNELS.renameTabGroup,
          "settings.hoshidicts.errors.tabGroups",
          { groupId, name } satisfies HoshidictsRenameTabGroupRequest
        ),
      deleteTabGroup: (groupId: string) =>
        ipcAction(
          HOSHIDICTS_CHANNELS.deleteTabGroup,
          "settings.hoshidicts.errors.tabGroups",
          { groupId } satisfies HoshidictsDeleteTabGroupRequest
        ),
      moveTabGroup: (groupId: string, direction: HoshidictsMoveDirection) =>
        ipcAction(
          HOSHIDICTS_CHANNELS.moveTabGroup,
          "settings.hoshidicts.errors.tabGroups",
          { groupId, direction } satisfies HoshidictsMoveTabGroupRequest
        ),
      setDictionarySchedule: (
        id: string,
        schedule: HoshidictsSchedule | null
      ) =>
        ipcAction(
          HOSHIDICTS_CHANNELS.setDictionarySchedule,
          "settings.hoshidicts.errors.dictionarySchedule",
          { id, schedule } satisfies HoshidictsDictionaryScheduleRequest
        ),
      renameDictionary: (id: string, displayName: string | null) =>
        ipcAction(
          HOSHIDICTS_CHANNELS.renameDictionary,
          "settings.hoshidicts.errors.rename",
          { id, displayName } satisfies HoshidictsRenameDictionaryRequest
        ),
      moveDictionary: (id: string, direction: HoshidictsMoveDirection) =>
        ipcAction(
          HOSHIDICTS_CHANNELS.moveDictionary,
          "settings.hoshidicts.errors.operation",
          { id, direction }
        ),
      moveDictionaryToPosition: (id: string, position: number) =>
        ipcAction(
          HOSHIDICTS_CHANNELS.moveDictionaryToPosition,
          "settings.hoshidicts.errors.operation",
          { id, position } satisfies HoshidictsMoveDictionaryToPositionRequest
        ),
      setSchedule: (schedule: HoshidictsSchedule) =>
        ipcAction(
          HOSHIDICTS_CHANNELS.setSchedule,
          "settings.hoshidicts.errors.schedule",
          schedule
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
    [flushAutosaves, runAction, state?.activeProfileId]
  );

  const dictionaryBusy = state ? isScopedBusy(state, "dictionary") : true;
  const preferencesBusy = state
    ? profileSwitching ||
      isScopedBusy(state, "preferences") ||
      readerSaving
    : true;
  const miningBusy = state
    ? profileSwitching ||
      isScopedBusy(state, "mining") ||
      miningSaving
    : true;
  const audioBusy = state
    ? profileSwitching ||
      isScopedBusy(state, "audio") ||
      audioSaving
    : true;
  const customBusy = state
    ? isScopedBusy(state, "custom") ||
      customLoading ||
      customSaving
    : true;

  return {
    view,
    setView,
    state,
    readerDraft,
    readerSaveStatus,
    setReaderPreference,
    setBoundedReaderInteger,
    setCustomPopupCss,
    setPopupButtonEnabled,
    setPopupCustomLinks,
    resetPopupSize,
    setDefinitionBlurPreference,
    setBoundedDefinitionBlurInteger,
    setPopupContentScanningEnabled,
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
    profileSwitching,
    dictionaryBusy,
    preferencesBusy,
    audioBusy,
    miningBusy,
    customBusy,
    actions
  };
}
