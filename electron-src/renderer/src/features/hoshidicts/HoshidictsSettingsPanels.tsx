import {
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Download,
  EllipsisVertical,
  Eraser,
  FileArchive,
  FileJson,
  FolderPlus,
  Keyboard,
  Pencil,
  RefreshCw,
  Save,
  Star,
  Trash2
} from "lucide-react";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";

import {
  DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
  DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
  DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
  DEFAULT_HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS,
  HOSHIDICTS_THEME_GROUPS,
  HOSHIDICTS_FIELD_OVERWRITE_MODES,
  MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
  MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
  MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
  MAX_HOSHIDICTS_POPUP_HEIGHT_PX,
  MAX_HOSHIDICTS_POPUP_WIDTH_PX,
  MAX_HOSHIDICTS_TAB_GROUP_NAME_LENGTH,
  MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
  MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
  MIN_HOSHIDICTS_POPUP_HEIGHT_PX,
  MIN_HOSHIDICTS_POPUP_WIDTH_PX,
  type HoshidictsActivationKey,
  type HoshidictsFieldOverwriteMode,
  type HoshidictsTheme,
  type HoshidictsSchedule
} from "../../../../shared/features/hoshidicts";
import { useTranslation } from "../../i18n";
import {
  MINING_FIELD_TEMPLATE_SUGGESTIONS,
  RECOMMENDED_KEYS,
  activationKeyFromKeyboardCode,
  frequencyModeKey,
  formatTimestamp,
  resolvedMiningFieldTemplate,
  summarizeCustomDictionaryText,
  visibleMiningFields
} from "./hoshidictsSettingsModel";
import { HoshidictsSaveIndicator } from "./HoshidictsSaveIndicator";
import type { useHoshidictsSettingsController } from "./useHoshidictsSettingsController";

type Controller = ReturnType<typeof useHoshidictsSettingsController>;

const OVERWRITE_MODE_KEYS: Record<HoshidictsFieldOverwriteMode, string> = {
  coalesce: "settings.hoshidicts.mining.overwriteModes.coalesce",
  "coalesce-new": "settings.hoshidicts.mining.overwriteModes.coalesceNew",
  skip: "settings.hoshidicts.mining.overwriteModes.skip",
  append: "settings.hoshidicts.mining.overwriteModes.append",
  prepend: "settings.hoshidicts.mining.overwriteModes.prepend",
  overwrite: "settings.hoshidicts.mining.overwriteModes.overwrite"
};

const SCHEDULE_KEYS: Record<HoshidictsSchedule, string> = {
  off: "settings.hoshidicts.schedules.off",
  hourly: "settings.hoshidicts.schedules.hourly",
  daily: "settings.hoshidicts.schedules.daily",
  weekly: "settings.hoshidicts.schedules.weekly",
  monthly: "settings.hoshidicts.schedules.monthly"
};

type DictionaryScheduleChoice = "global" | HoshidictsSchedule;

function dictionaryDisplayName(dictionary: {
  title: string;
  displayName: string | null;
}): string {
  return dictionary.displayName ?? dictionary.title;
}

function CreateTabGroupForm({
  controller,
  dictionaryId,
  autoFocus = false
}: {
  controller: Controller;
  dictionaryId?: string;
  autoFocus?: boolean;
}) {
  const t = useTranslation();
  const { dictionaryBusy, actions } = controller;
  const [name, setName] = useState("");
  const assigning = dictionaryId !== undefined;

  return (
    <form
      className={
        assigning
          ? "hoshidicts-dictionary-tab-groups__create"
          : "hoshidicts-tab-groups__create"
      }
      onSubmit={(event) => {
        event.preventDefault();
        const normalizedName = name.trim();
        if (!normalizedName) return;
        void actions
          .createTabGroup(normalizedName, dictionaryId)
          .then((saved) => {
            if (saved) setName("");
          });
      }}
    >
      <input
        type="text"
        value={name}
        maxLength={MAX_HOSHIDICTS_TAB_GROUP_NAME_LENGTH}
        autoFocus={autoFocus}
        aria-label={t(
          assigning
            ? "settings.hoshidicts.tabGroups.newGroupName"
            : "settings.hoshidicts.tabGroups.name"
        )}
        placeholder={t("settings.hoshidicts.tabGroups.namePlaceholder")}
        disabled={dictionaryBusy}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      <button
        type="submit"
        disabled={dictionaryBusy || name.trim().length === 0}
      >
        {t(
          assigning
            ? "settings.hoshidicts.tabGroups.createAndAdd"
            : "settings.hoshidicts.tabGroups.create"
        )}
      </button>
    </form>
  );
}

function TabGroupsSection({ controller }: { controller: Controller }) {
  const t = useTranslation();
  const { state, dictionaryBusy, actions } = controller;
  const [expanded, setExpanded] = useState(false);
  const [groupRename, setGroupRename] = useState<{
    id: string;
    value: string;
  } | null>(null);
  if (!state) return null;

  return (
    <section className="hoshidicts-section hoshidicts-tab-groups">
      <div className="hoshidicts-section__heading hoshidicts-tab-groups__heading">
        <div>
          <h2>
            <button
              type="button"
              className="hoshidicts-tab-groups__toggle"
              aria-expanded={expanded}
              aria-controls="hoshidicts-tab-groups-panel"
              aria-label={t(
                expanded
                  ? "settings.hoshidicts.tabGroups.collapse"
                  : "settings.hoshidicts.tabGroups.expand",
                { count: state.tabGroups.length }
              )}
              onClick={() => setExpanded((current) => !current)}
            >
              <ChevronDown size={18} aria-hidden="true" />
              <span>{t("settings.hoshidicts.tabGroups.title")}</span>
              <span className="hoshidicts-section__count">
                {state.tabGroups.length}
              </span>
            </button>
          </h2>
          <p>{t("settings.hoshidicts.tabGroups.subtitle")}</p>
        </div>
      </div>

      <div id="hoshidicts-tab-groups-panel" hidden={!expanded}>
        <CreateTabGroupForm controller={controller} />

        {state.tabGroups.length === 0 ? (
          <div className="hoshidicts-tab-groups__empty">
            {t("settings.hoshidicts.tabGroups.empty")}
          </div>
        ) : (
          <div className="hoshidicts-tab-groups__list">
            {state.tabGroups.map((group, index) => (
              <div className="hoshidicts-tab-group-row" key={group.id}>
                {groupRename?.id === group.id ? (
                  <form
                    className="hoshidicts-tab-group-row__rename"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      const name = groupRename.value.trim();
                      if (!name) return;
                      if (await actions.renameTabGroup(group.id, name)) {
                        setGroupRename(null);
                      }
                    }}
                  >
                    <input
                      type="text"
                      autoFocus
                      required
                      maxLength={MAX_HOSHIDICTS_TAB_GROUP_NAME_LENGTH}
                      value={groupRename.value}
                      aria-label={t("settings.hoshidicts.tabGroups.renameName", {
                        name: group.name
                      })}
                      disabled={dictionaryBusy}
                      onChange={(event) =>
                        setGroupRename({
                          id: group.id,
                          value: event.currentTarget.value
                        })
                      }
                    />
                    <button
                      type="submit"
                      disabled={
                        dictionaryBusy || groupRename.value.trim().length === 0
                      }
                    >
                      {t("settings.hoshidicts.tabGroups.save")}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setGroupRename(null)}
                    >
                      {t("settings.hoshidicts.tabGroups.cancel")}
                    </button>
                  </form>
                ) : (
                  <>
                    <div className="hoshidicts-tab-group-row__copy">
                      <strong>{group.name}</strong>
                      <span>
                        {t("settings.hoshidicts.tabGroups.dictionaryCount", {
                          count: group.dictionaryIds.length
                        })}
                      </span>
                    </div>
                    <div className="hoshidicts-tab-group-row__actions">
                      <button
                        type="button"
                        className="hoshidicts-icon-button secondary"
                        aria-label={t("settings.hoshidicts.tabGroups.moveUp", {
                          name: group.name
                        })}
                        disabled={dictionaryBusy || index === 0}
                        onClick={() => void actions.moveTabGroup(group.id, -1)}
                      >
                        <ArrowUp size={16} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="hoshidicts-icon-button secondary"
                        aria-label={t("settings.hoshidicts.tabGroups.moveDown", {
                          name: group.name
                        })}
                        disabled={
                          dictionaryBusy || index === state.tabGroups.length - 1
                        }
                        onClick={() => void actions.moveTabGroup(group.id, 1)}
                      >
                        <ArrowDown size={16} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="hoshidicts-icon-button secondary"
                        aria-label={t("settings.hoshidicts.tabGroups.rename", {
                          name: group.name
                        })}
                        disabled={dictionaryBusy}
                        onClick={() =>
                          setGroupRename({ id: group.id, value: group.name })
                        }
                      >
                        <Pencil size={16} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="hoshidicts-icon-button secondary danger"
                        aria-label={t("settings.hoshidicts.tabGroups.delete", {
                          name: group.name
                        })}
                        disabled={dictionaryBusy}
                        onClick={() => {
                          if (
                            window.confirm(
                              t("settings.hoshidicts.tabGroups.deleteConfirm", {
                                name: group.name
                              })
                            )
                          ) {
                            void actions.deleteTabGroup(group.id);
                          }
                        }}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function DictionaryTabGroupPicker({
  controller,
  dictionary,
  onBack
}: {
  controller: Controller;
  dictionary: NonNullable<Controller["state"]>["dictionaries"][number];
  onBack: () => void;
}) {
  const t = useTranslation();
  const { state, dictionaryBusy, actions } = controller;
  if (!state) return null;
  const headingId = `hoshidicts-dictionary-tab-groups-heading-${dictionary.id}`;

  return (
    <div
      className="hoshidicts-dictionary-tab-groups"
      role="group"
      aria-labelledby={headingId}
    >
      <div className="hoshidicts-dictionary-tab-groups__heading">
        <strong id={headingId}>
          {t("settings.hoshidicts.tabGroups.addToGroup")}
        </strong>
        <button type="button" className="secondary" onClick={onBack}>
          {t("settings.hoshidicts.tabGroups.back")}
        </button>
      </div>

      {state.tabGroups.length === 0 ? (
        <p>{t("settings.hoshidicts.tabGroups.noGroups")}</p>
      ) : (
        <div className="hoshidicts-dictionary-tab-groups__choices">
          {state.tabGroups.map((group, index) => {
            const member = group.dictionaryIds.includes(dictionary.id);
            return (
              <label
                key={group.id}
                className={dictionaryBusy ? "is-disabled" : undefined}
              >
                <input
                  type="checkbox"
                  autoFocus={index === 0}
                  checked={member}
                  disabled={dictionaryBusy}
                  aria-label={t(
                    member
                      ? "settings.hoshidicts.tabGroups.removeMembership"
                      : "settings.hoshidicts.tabGroups.addMembership",
                    {
                      dictionary: dictionaryDisplayName(dictionary),
                      group: group.name
                    }
                  )}
                  onChange={(event) =>
                    void actions.setTabGroupMembership(
                      group.id,
                      dictionary.id,
                      event.currentTarget.checked
                    )
                  }
                />
                <span>{group.name}</span>
              </label>
            );
          })}
        </div>
      )}

      <CreateTabGroupForm
        controller={controller}
        dictionaryId={dictionary.id}
        autoFocus={state.tabGroups.length === 0}
      />
    </div>
  );
}

function CustomDictionarySaveIndicator({
  status
}: {
  status: Controller["customSaveStatus"];
}) {
  const t = useTranslation();
  if (status === "idle") return null;
  return (
    <span
      className="hoshidicts-save-status"
      data-status={status}
      role="status"
    >
      {t(`settings.hoshidicts.saveStatus.${status}`)}
    </span>
  );
}

function ActivationKeyControl({
  activationKey,
  disabled,
  onChange
}: {
  activationKey: HoshidictsActivationKey;
  disabled: boolean;
  onChange: (activationKey: HoshidictsActivationKey) => void;
}) {
  const t = useTranslation();
  const [capturing, setCapturing] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const hintId = "hoshidicts-activation-key-hint";

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;

    const next = activationKeyFromKeyboardCode(event.code);
    if (!next) {
      setUnsupported(true);
      return;
    }

    setCapturing(false);
    setUnsupported(false);
    onChange(next);
  };

  return (
    <div className="hoshidicts-activation-key">
      <span>{t("settings.hoshidicts.reader.activationKey")}</span>
      <div className="hoshidicts-activation-key__controls">
        <output
          className="hoshidicts-activation-key__current"
          aria-live="polite"
        >
          <span>{t("settings.hoshidicts.reader.currentKey")}</span>
          <kbd>{activationKey}</kbd>
        </output>
        <button
          id="hoshidicts-activation-key-capture"
          type="button"
          className="secondary hoshidicts-activation-key__capture"
          data-capturing={capturing}
          aria-pressed={capturing}
          aria-describedby={hintId}
          disabled={disabled}
          onClick={() => {
            setCapturing(true);
            setUnsupported(false);
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            setCapturing(false);
            setUnsupported(false);
          }}
        >
          <Keyboard size={16} aria-hidden="true" />
          {capturing
            ? t("settings.hoshidicts.reader.capturingKey")
            : t("settings.hoshidicts.reader.changeKey")}
        </button>
        <button
          id="hoshidicts-activation-key-reset"
          type="button"
          className="secondary"
          disabled={
            disabled || activationKey === DEFAULT_HOSHIDICTS_ACTIVATION_KEY
          }
          onClick={() => {
            setCapturing(false);
            setUnsupported(false);
            onChange(DEFAULT_HOSHIDICTS_ACTIVATION_KEY);
          }}
        >
          {t("settings.hoshidicts.reader.resetKey")}
        </button>
      </div>
      <small
        id={hintId}
        className={unsupported ? "is-error" : ""}
        aria-live="polite"
      >
        {unsupported
          ? t("settings.hoshidicts.reader.unsupportedKey")
          : capturing
            ? t("settings.hoshidicts.reader.capturingKeyHint")
            : t("settings.hoshidicts.reader.activationKeyHint")}
      </small>
    </div>
  );
}

export function CustomDictionaryPanel({
  controller
}: {
  controller: Controller;
}) {
  const t = useTranslation();
  const {
    customDocument,
    customDraft,
    customDirty,
    customLoading,
    customSaveStatus,
    updateCustomDraft,
    saveCustomDictionary,
    reloadCustomDictionary,
    customBusy
  } = controller;
  const summary = useMemo(
    () => summarizeCustomDictionaryText(customDraft),
    [customDraft]
  );

  return (
    <section className="hoshidicts-section hoshidicts-custom">
      <div className="hoshidicts-section__heading">
        <div>
          <h2>{t("settings.hoshidicts.custom.title")}</h2>
          <p>{t("settings.hoshidicts.custom.subtitle")}</p>
        </div>
        <CustomDictionarySaveIndicator status={customSaveStatus} />
      </div>

      {customDocument ? (
        <>
          <div className="hoshidicts-custom__path">
            <span>{t("settings.hoshidicts.custom.path")}</span>
            <code>{customDocument.filePath}</code>
          </div>

          <label className="hoshidicts-custom__editor">
            <span>{t("settings.hoshidicts.custom.editorLabel")}</span>
            <textarea
              id="hoshidicts-custom-dictionary-editor"
              value={customDraft}
              disabled={customBusy}
              spellCheck={false}
              placeholder={t("settings.hoshidicts.custom.placeholder")}
              onChange={(event) => updateCustomDraft(event.currentTarget.value)}
            />
          </label>

          <div className="hoshidicts-custom__summary" role="status">
            <span>
              {t("settings.hoshidicts.custom.entries", {
                count: summary.entryCount
              })}
            </span>
            <span>
              {customDocument.exists
                ? t("settings.hoshidicts.custom.fileExists")
                : t("settings.hoshidicts.custom.fileNotCreated")}
            </span>
          </div>

          {summary.ignoredLineCount > 0 ? (
            <p className="hoshidicts-custom__warning" role="alert">
              {t("settings.hoshidicts.custom.skippedLines", {
                count: summary.ignoredLineCount,
                lines: summary.ignoredLines.join(", ")
              })}
            </p>
          ) : null}

          <div className="hoshidicts-custom__hint">
            <strong>{t("settings.hoshidicts.custom.formatTitle")}</strong>
            <code>{t("settings.hoshidicts.custom.formatExample")}</code>
            <span>{t("settings.hoshidicts.custom.formatHint")}</span>
            <span>{t("settings.hoshidicts.custom.newlineHint")}</span>
          </div>

          <div className="hoshidicts-custom__actions">
            <button
              type="button"
              className="secondary"
              disabled={customBusy}
              onClick={() => void reloadCustomDictionary()}
            >
              <RefreshCw size={17} aria-hidden="true" />
              {t("settings.hoshidicts.custom.reload")}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={customBusy || customDraft.length === 0}
              onClick={() => updateCustomDraft("")}
            >
              <Eraser size={17} aria-hidden="true" />
              {t("settings.hoshidicts.custom.clear")}
            </button>
            <button
              type="button"
              disabled={customBusy || !customDirty}
              onClick={() => void saveCustomDictionary()}
            >
              <Save size={17} aria-hidden="true" />
              {customSaveStatus === "saving"
                ? t("settings.hoshidicts.custom.saving")
                : t("settings.hoshidicts.custom.save")}
            </button>
          </div>
        </>
      ) : (
        <div className="hoshidicts-custom__loading" role="status">
          <span>
            {customLoading
              ? t("settings.hoshidicts.custom.loading")
              : t("settings.hoshidicts.custom.loadFailed")}
          </span>
          {!customLoading ? (
            <button
              type="button"
              className="secondary"
              onClick={() => void reloadCustomDictionary(false)}
            >
              <RefreshCw size={16} aria-hidden="true" />
              {t("settings.hoshidicts.custom.retry")}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function DictionariesPanel({ controller }: { controller: Controller }) {
  const t = useTranslation();
  const {
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
    backupOperation,
    backupBusy,
    dictionaryBusy,
    preferencesBusy,
    actions
  } = controller;
  const [positionMove, setPositionMove] = useState<{
    id: string;
    value: string;
  } | null>(null);
  const [dictionaryRename, setDictionaryRename] = useState<{
    id: string;
    value: string;
  } | null>(null);
  const [dictionarySchedule, setDictionarySchedule] = useState<{
    id: string;
    value: DictionaryScheduleChoice;
  } | null>(null);
  const [tabGroupDictionaryId, setTabGroupDictionaryId] = useState<
    string | null
  >(null);
  const [tabGroupFocusReturnId, setTabGroupFocusReturnId] = useState<
    string | null
  >(null);
  const tabGroupTriggerRefs = useRef(
    new Map<string, HTMLButtonElement>()
  );
  const [recommendedExpandedOverride, setRecommendedExpandedOverride] =
    useState<boolean | null>(null);

  useEffect(() => {
    if (tabGroupDictionaryId !== null || tabGroupFocusReturnId === null) {
      return;
    }
    tabGroupTriggerRefs.current.get(tabGroupFocusReturnId)?.focus();
    setTabGroupFocusReturnId(null);
  }, [tabGroupDictionaryId, tabGroupFocusReturnId]);

  if (!state) return null;

  const recommendedExpanded =
    recommendedExpandedOverride ??
    (state.dictionaries.length === 0 && !state.customDictionaryActive);
  const importingYomitan =
    backupOperation === "importingYomitanDictionaries" ||
    backupOperation === "importingYomitanSettings";
  const lastCheck = formatTimestamp(state.lastCheck);
  const nextCheck = formatTimestamp(state.nextCheck);

  return (
    <div className="hoshidicts-dictionaries">
      <section className="hoshidicts-section hoshidicts-reader-settings">
        <div className="hoshidicts-section__heading">
          <div>
            <h2>{t("settings.hoshidicts.reader.title")}</h2>
            <p>{t("settings.hoshidicts.reader.subtitle")}</p>
          </div>
          <HoshidictsSaveIndicator status={readerSaveStatus} />
        </div>

        <fieldset className="hoshidicts-reader-mode">
          <legend>{t("settings.hoshidicts.reader.activation")}</legend>
          <label>
            <input
              id="hoshidicts-reader-mode-shift"
              type="radio"
              name="hoshidicts-reader-mode"
              value="shift"
              checked={readerDraft.lookupMode === "shift"}
              disabled={preferencesBusy}
              onChange={() => setLookupMode("shift")}
            />
            <span>
              <strong>
                {t("settings.hoshidicts.reader.holdKey", {
                  key: readerDraft.activationKey
                })}
              </strong>
              <small>
                {t("settings.hoshidicts.reader.holdKeyHint", {
                  key: readerDraft.activationKey
                })}
              </small>
            </span>
          </label>
          <label>
            <input
              id="hoshidicts-reader-mode-hover"
              type="radio"
              name="hoshidicts-reader-mode"
              value="hover"
              checked={readerDraft.lookupMode === "hover"}
              disabled={preferencesBusy}
              onChange={() => setLookupMode("hover")}
            />
            <span>
              <strong>{t("settings.hoshidicts.reader.automaticHover")}</strong>
              <small>{t("settings.hoshidicts.reader.automaticHoverHint")}</small>
            </span>
          </label>
        </fieldset>

        <ActivationKeyControl
          activationKey={readerDraft.activationKey}
          disabled={preferencesBusy}
          onChange={setActivationKey}
        />

        <div className="hoshidicts-reader-appearance">
          <div className="hoshidicts-reader-appearance__heading">
            <strong>
              {t("settings.hoshidicts.reader.appearance.title")}
            </strong>
            <small>
              {t("settings.hoshidicts.reader.appearance.hint")}
            </small>
          </div>
          <div className="hoshidicts-reader-appearance__controls">
            <label>
              <span>
                {t("settings.hoshidicts.reader.appearance.theme")}
              </span>
              <select
                id="hoshidicts-popup-theme"
                value={readerDraft.theme}
                disabled={preferencesBusy}
                onChange={(event) =>
                  setTheme(event.currentTarget.value as HoshidictsTheme)
                }
              >
                {HOSHIDICTS_THEME_GROUPS.map((group) => (
                  <optgroup key={group.id} label={t(group.labelKey)}>
                    {group.themes.map((theme) => (
                      <option key={theme.id} value={theme.id}>
                        {t(theme.labelKey)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label>
              <span>
                {t("settings.hoshidicts.reader.appearance.width")}
              </span>
              <div className="hoshidicts-reader-appearance__number">
                <input
                  id="hoshidicts-popup-width"
                  type="number"
                  min={MIN_HOSHIDICTS_POPUP_WIDTH_PX}
                  max={MAX_HOSHIDICTS_POPUP_WIDTH_PX}
                  step={10}
                  value={readerDraft.popupWidthPx}
                  disabled={preferencesBusy}
                  onChange={(event) =>
                    setPopupWidthPx(event.currentTarget.valueAsNumber)
                  }
                />
                <span>
                  {t("settings.hoshidicts.reader.appearance.pixels")}
                </span>
              </div>
            </label>
            <label>
              <span>
                {t("settings.hoshidicts.reader.appearance.height")}
              </span>
              <div className="hoshidicts-reader-appearance__number">
                <input
                  id="hoshidicts-popup-height"
                  type="number"
                  min={MIN_HOSHIDICTS_POPUP_HEIGHT_PX}
                  max={MAX_HOSHIDICTS_POPUP_HEIGHT_PX}
                  step={10}
                  value={readerDraft.popupHeightPx}
                  disabled={preferencesBusy}
                  onChange={(event) =>
                    setPopupHeightPx(event.currentTarget.valueAsNumber)
                  }
                />
                <span>
                  {t("settings.hoshidicts.reader.appearance.pixels")}
                </span>
              </div>
            </label>
            <button
              type="button"
              className="secondary hoshidicts-reader-appearance__reset"
              disabled={
                preferencesBusy ||
                (readerDraft.popupWidthPx ===
                  DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX &&
                  readerDraft.popupHeightPx ===
                    DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX)
              }
              onClick={resetPopupSize}
            >
              {t("settings.hoshidicts.reader.appearance.resetSize")}
            </button>
          </div>
        </div>

        <label className="hoshidicts-reader-highlight">
          <input
            id="hoshidicts-source-highlight-enabled"
            type="checkbox"
            checked={readerDraft.sourceHighlightEnabled}
            disabled={preferencesBusy}
            onChange={(event) =>
              setSourceHighlightEnabled(event.currentTarget.checked)
            }
          />
          <span>
            <strong>{t("settings.hoshidicts.reader.sourceHighlight")}</strong>
            <small>
              {t("settings.hoshidicts.reader.sourceHighlightHint")}
            </small>
          </span>
        </label>

        <label className="hoshidicts-reader-delay">
          <span>{t("settings.hoshidicts.reader.hideDelay")}</span>
          <div>
            <input
              id="hoshidicts-popup-hide-delay"
              type="number"
              min={0}
              max={MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS}
              step={50}
              value={readerDraft.popupHideDelayMs}
              disabled={preferencesBusy}
              onChange={(event) =>
                setPopupHideDelayMs(event.currentTarget.valueAsNumber)
              }
            />
            <span>{t("settings.hoshidicts.reader.milliseconds")}</span>
          </div>
          <small>{t("settings.hoshidicts.reader.hideDelayHint")}</small>
        </label>

        <label className="hoshidicts-reader-counts">
          <input
            id="hoshidicts-show-lookup-counts"
            type="checkbox"
            checked={readerDraft.showLookupCounts}
            disabled={preferencesBusy}
            onChange={(event) =>
              setShowLookupCounts(event.currentTarget.checked)
            }
          />
          <span>
            <strong>{t("settings.hoshidicts.reader.showLookupCounts")}</strong>
            <small>
              {t("settings.hoshidicts.reader.showLookupCountsHint")}
            </small>
          </span>
        </label>

        <div className="hoshidicts-definition-blur">
          <label className="hoshidicts-definition-blur__toggle">
            <input
              id="hoshidicts-definition-blur-enabled"
              type="checkbox"
              checked={readerDraft.definitionBlur.enabled}
              disabled={preferencesBusy}
              onChange={(event) =>
                setDefinitionBlurEnabled(event.currentTarget.checked)
              }
            />
            <span>
              <strong>
                {t("settings.hoshidicts.reader.definitionBlur.title")}
              </strong>
              <small>
                {t("settings.hoshidicts.reader.definitionBlur.hint")}
              </small>
            </span>
          </label>

          <div className="hoshidicts-definition-blur__controls">
            <label>
              <span>
                {t("settings.hoshidicts.reader.definitionBlur.threshold")}
              </span>
              <div className="hoshidicts-definition-blur__number">
                <input
                  id="hoshidicts-definition-blur-threshold"
                  type="number"
                  min={MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD}
                  max={MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD}
                  step={1}
                  value={readerDraft.definitionBlur.lookupThreshold}
                  disabled={preferencesBusy}
                  onChange={(event) =>
                    setDefinitionBlurLookupThreshold(
                      event.currentTarget.valueAsNumber
                    )
                  }
                />
                <span>
                  {t("settings.hoshidicts.reader.definitionBlur.lookups")}
                </span>
              </div>
            </label>

            <label>
              <span>
                {t("settings.hoshidicts.reader.definitionBlur.reveal")}
              </span>
              <select
                id="hoshidicts-definition-blur-reveal-mode"
                value={readerDraft.definitionBlur.revealMode}
                disabled={preferencesBusy}
                onChange={(event) =>
                  setDefinitionBlurRevealMode(
                    event.currentTarget.value === "hover" ? "hover" : "timed"
                  )
                }
              >
                <option value="timed">
                  {t("settings.hoshidicts.reader.definitionBlur.timed")}
                </option>
                <option value="hover">
                  {t("settings.hoshidicts.reader.definitionBlur.hover")}
                </option>
              </select>
            </label>

            {readerDraft.definitionBlur.revealMode === "timed" ? (
              <label>
                <span>
                  {t("settings.hoshidicts.reader.definitionBlur.delay")}
                </span>
                <div className="hoshidicts-definition-blur__number">
                  <input
                    id="hoshidicts-definition-blur-reveal-delay"
                    type="number"
                    min={
                      MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS / 1000
                    }
                    max={
                      MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS / 1000
                    }
                    step={1}
                    value={readerDraft.definitionBlur.revealDelayMs / 1000}
                    disabled={preferencesBusy}
                    onChange={(event) =>
                      setDefinitionBlurRevealDelayMs(
                        event.currentTarget.valueAsNumber * 1000
                      )
                    }
                  />
                  <span>
                    {t("settings.hoshidicts.reader.definitionBlur.seconds")}
                  </span>
                </div>
                <small>
                  {t("settings.hoshidicts.reader.definitionBlur.delayHint")}
                </small>
              </label>
            ) : null}
          </div>
        </div>

        <div className="hoshidicts-reader-popup-scanning">
          <label className="hoshidicts-reader-popup-scanning__toggle">
            <input
              id="hoshidicts-popup-content-scanning"
              type="checkbox"
              checked={readerDraft.popupNestingMaxDepth > 0}
              disabled={preferencesBusy}
              onChange={(event) =>
                setPopupContentScanningEnabled(event.currentTarget.checked)
              }
            />
            <span>
              <strong>
                {t("settings.hoshidicts.reader.allowPopupContentScanning")}
              </strong>
              <small>
                {t("settings.hoshidicts.reader.allowPopupContentScanningHint")}
              </small>
            </span>
          </label>

          {readerDraft.popupNestingMaxDepth > 0 ? (
            <label className="hoshidicts-reader-depth">
              <span>{t("settings.hoshidicts.reader.maxChildPopups")}</span>
              <input
                id="hoshidicts-popup-nesting-max-depth"
                type="number"
                min={1}
                step={1}
                value={readerDraft.popupNestingMaxDepth}
                disabled={preferencesBusy}
                onChange={(event) =>
                  setPopupNestingMaxDepth(event.currentTarget.valueAsNumber)
                }
              />
              <small>
                {t("settings.hoshidicts.reader.maxChildPopupsHint")}
              </small>
            </label>
          ) : null}
        </div>
      </section>

      <section className="hoshidicts-section hoshidicts-section--toolbar">
        <div className="hoshidicts-dictionary-import">
          <div className="hoshidicts-actions">
            <button
              type="button"
              onClick={() => void actions.importDictionary()}
              disabled={dictionaryBusy}
            >
              <FileArchive size={17} aria-hidden="true" />
              {t("settings.hoshidicts.import")}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void actions.checkUpdates()}
              disabled={dictionaryBusy}
            >
              <RefreshCw size={17} aria-hidden="true" />
              {t("settings.hoshidicts.checkNow")}
            </button>
          </div>
          {state.busy &&
          state.progress.phase === "importing" &&
          !importingYomitan ? (
            <div
              className="hoshidicts-window__progress hoshidicts-dictionary-import-progress"
              role="status"
            >
              <span>{t("settings.hoshidicts.progress.importing")}</span>
              {typeof state.progress.total === "number" &&
              state.progress.total > 0 ? (
                <span>
                  {t("settings.hoshidicts.progress.count", {
                    completed: state.progress.completed ?? 0,
                    total: state.progress.total
                  })}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        <label className="hoshidicts-schedule">
          <span>{t("settings.hoshidicts.schedule")}</span>
          <select
            id="hoshidicts-update-schedule"
            value={state.schedule}
            disabled={dictionaryBusy}
            onChange={(event) =>
              void actions.setSchedule(event.target.value as HoshidictsSchedule)
            }
          >
            <option value="off">{t("settings.hoshidicts.schedules.off")}</option>
            <option value="hourly">
              {t("settings.hoshidicts.schedules.hourly")}
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
              time: nextCheck ?? t("settings.hoshidicts.notScheduled")
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
          <div className="hoshidicts-section__status-actions">
            <button
              type="button"
              className="secondary"
              disabled={
                dictionaryBusy ||
                state.recommendedDictionaries
                  .filter((dictionary) =>
                    DEFAULT_HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS.some(
                      (dictionaryId) => dictionaryId === dictionary.id
                    )
                  )
                  .every((dictionary) => dictionary.installed)
              }
              onClick={() => void actions.installAllRecommended()}
            >
              {t("settings.hoshidicts.recommended.install")}
            </button>
            <button
              type="button"
              className="hoshidicts-icon-button hoshidicts-recommended-toggle secondary"
              title={t(
                recommendedExpanded
                  ? "settings.hoshidicts.recommended.collapse"
                  : "settings.hoshidicts.recommended.expand"
              )}
              aria-label={t(
                recommendedExpanded
                  ? "settings.hoshidicts.recommended.collapse"
                  : "settings.hoshidicts.recommended.expand"
              )}
              aria-expanded={recommendedExpanded}
              aria-controls="hoshidicts-recommended-list"
              onClick={() =>
                setRecommendedExpandedOverride(!recommendedExpanded)
              }
            >
              <ChevronDown size={18} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div
          id="hoshidicts-recommended-list"
          className="hoshidicts-recommended-list"
          hidden={!recommendedExpanded}
        >
          {state.recommendedDictionaries.map((dictionary) => (
            <div className="hoshidicts-recommended-row" key={dictionary.id}>
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
                disabled={dictionaryBusy || dictionary.installed}
                onClick={() => void actions.installRecommended(dictionary.id)}
              >
                {dictionary.installed
                  ? t("settings.hoshidicts.recommended.installed")
                  : t("settings.hoshidicts.recommended.installOne")}
              </button>
            </div>
          ))}
        </div>
      </section>

      <TabGroupsSection controller={controller} />

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
                    disabled={dictionaryBusy}
                    aria-label={t("settings.hoshidicts.enableDictionary", {
                      title: dictionaryDisplayName(dictionary)
                    })}
                    onChange={(event) =>
                      void actions.setDictionaryEnabled(
                        dictionary.id,
                        event.target.checked
                      )
                    }
                  />
                </label>
                <div className="hoshidicts-dictionary-copy">
                  <div className="hoshidicts-dictionary-title">
                    {dictionary.termCount > 0 ? (
                      <button
                        type="button"
                        className="hoshidicts-dictionary-favorite"
                        aria-pressed={dictionary.favorite}
                        aria-label={t(
                          dictionary.favorite
                            ? "settings.hoshidicts.dictionaryPresentation.removeFavorite"
                            : "settings.hoshidicts.dictionaryPresentation.addFavorite",
                          { title: dictionaryDisplayName(dictionary) }
                        )}
                        title={t(
                          dictionary.favorite
                            ? "settings.hoshidicts.dictionaryPresentation.removeFavorite"
                            : "settings.hoshidicts.dictionaryPresentation.addFavorite",
                          { title: dictionaryDisplayName(dictionary) }
                        )}
                        disabled={dictionaryBusy}
                        onClick={() =>
                          void actions.setDictionaryPresentation(
                            dictionary.id,
                            !dictionary.favorite
                          )
                        }
                      >
                        <Star
                          size={18}
                          fill={dictionary.favorite ? "currentColor" : "none"}
                          aria-hidden="true"
                        />
                      </button>
                    ) : (
                      <span
                        className="hoshidicts-dictionary-favorite-placeholder"
                        aria-hidden="true"
                      />
                    )}
                    <strong
                      title={
                        dictionary.displayName
                          ? t(
                              "settings.hoshidicts.dictionaryActions.originalName",
                              { title: dictionary.title }
                            )
                          : undefined
                      }
                    >
                      {dictionaryDisplayName(dictionary)}
                    </strong>
                  </div>
                  <div className="hoshidicts-dictionary-meta">
                    {dictionary.displayName ? (
                      <span className="hoshidicts-dictionary-canonical-name">
                        {t(
                          "settings.hoshidicts.dictionaryActions.originalName",
                          { title: dictionary.title }
                        )}
                      </span>
                    ) : null}
                    <span>
                      {t("settings.hoshidicts.revision", {
                        revision:
                          dictionary.revision || t("settings.hoshidicts.unknown")
                      })}
                    </span>
                    <span>
                      {t("settings.hoshidicts.language", {
                        language:
                          dictionary.language ||
                          t("settings.hoshidicts.legacyJapanese")
                      })}
                    </span>
                    {dictionary.termCount > 0 ? (
                      <span>
                        {t("settings.hoshidicts.terms", {
                          count: dictionary.termCount
                        })}
                      </span>
                    ) : null}
                    {dictionary.frequencyCount > 0 ? (
                      <span>
                        {t("settings.hoshidicts.frequencies", {
                          count: dictionary.frequencyCount
                        })}
                      </span>
                    ) : null}
                    {dictionary.pitchCount > 0 ? (
                      <span>
                        {t("settings.hoshidicts.pitches", {
                          count: dictionary.pitchCount
                        })}
                      </span>
                    ) : null}
                    {dictionary.kanjiCount > 0 ? (
                      <span>
                        {t("settings.hoshidicts.kanjiEntries", {
                          count: dictionary.kanjiCount
                        })}
                      </span>
                    ) : null}
                    {dictionary.frequencyCount > 0 ? (
                      <span>
                        {t("settings.hoshidicts.frequencyMode", {
                          mode: t(frequencyModeKey(dictionary.frequencyMode))
                        })}
                      </span>
                    ) : null}
                    <span>
                      {dictionary.isUpdatable
                        ? t("settings.hoshidicts.updatable")
                        : t("settings.hoshidicts.manualOnly")}
                    </span>
                  </div>
                </div>
                <div className="hoshidicts-dictionary-actions">
                  <details
                    className="hoshidicts-dictionary-menu"
                    onToggle={(event) => {
                      if (
                        !event.currentTarget.open &&
                        tabGroupDictionaryId === dictionary.id
                      ) {
                        setTabGroupDictionaryId(null);
                      }
                    }}
                  >
                    <summary
                      className="hoshidicts-icon-button secondary"
                      title={t("settings.hoshidicts.dictionaryActions.menu", {
                        title: dictionaryDisplayName(dictionary)
                      })}
                      aria-label={t(
                        "settings.hoshidicts.dictionaryActions.menu",
                        { title: dictionaryDisplayName(dictionary) }
                      )}
                      aria-disabled={dictionaryBusy}
                      aria-haspopup="menu"
                      onClick={(event) => {
                        if (dictionaryBusy) event.preventDefault();
                      }}
                    >
                      <EllipsisVertical size={18} aria-hidden="true" />
                    </summary>
                    <div className="hoshidicts-dictionary-menu__popover">
                      {tabGroupDictionaryId === dictionary.id ? (
                        <DictionaryTabGroupPicker
                          controller={controller}
                          dictionary={dictionary}
                          onBack={() => {
                            setTabGroupFocusReturnId(dictionary.id);
                            setTabGroupDictionaryId(null);
                          }}
                        />
                      ) : dictionaryRename?.id === dictionary.id ? (
                        <form
                          className="hoshidicts-dictionary-rename"
                          aria-label={t(
                            "settings.hoshidicts.dictionaryActions.renameForm",
                            { title: dictionaryDisplayName(dictionary) }
                          )}
                          onSubmit={(event) => {
                            event.preventDefault();
                            const displayName = dictionaryRename.value.trim();
                            if (!displayName) return;
                            setDictionaryRename(null);
                            event.currentTarget
                              .closest("details")
                              ?.removeAttribute("open");
                            void actions.renameDictionary(
                              dictionary.id,
                              displayName
                            );
                          }}
                        >
                          <label>
                            <span>
                              {t(
                                "settings.hoshidicts.dictionaryActions.displayName"
                              )}
                            </span>
                            <input
                              type="text"
                              autoFocus
                              required
                              aria-describedby={`hoshidicts-dictionary-rename-original-${dictionary.id}`}
                              value={dictionaryRename.value}
                              onChange={(event) =>
                                setDictionaryRename({
                                  id: dictionary.id,
                                  value: event.currentTarget.value
                                })
                              }
                            />
                          </label>
                          <small
                            id={`hoshidicts-dictionary-rename-original-${dictionary.id}`}
                          >
                            {t(
                              "settings.hoshidicts.dictionaryActions.originalName",
                              { title: dictionary.title }
                            )}
                          </small>
                          <div>
                            <button
                              type="submit"
                              disabled={
                                dictionaryBusy ||
                                dictionaryRename.value.trim().length === 0
                              }
                            >
                              {t(
                                "settings.hoshidicts.dictionaryActions.saveName"
                              )}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => setDictionaryRename(null)}
                            >
                              {t(
                                "settings.hoshidicts.dictionaryActions.cancel"
                              )}
                            </button>
                            <button
                              type="button"
                              className="secondary hoshidicts-dictionary-rename__reset"
                              disabled={
                                dictionaryBusy || dictionary.displayName === null
                              }
                              onClick={(event) => {
                                setDictionaryRename(null);
                                event.currentTarget
                                  .closest("details")
                                  ?.removeAttribute("open");
                                void actions.renameDictionary(
                                  dictionary.id,
                                  null
                                );
                              }}
                            >
                              {t(
                                "settings.hoshidicts.dictionaryActions.resetName"
                              )}
                            </button>
                          </div>
                        </form>
                      ) : positionMove?.id === dictionary.id ? (
                        <form
                          className="hoshidicts-dictionary-position"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const position = Number(positionMove.value);
                            if (
                              !Number.isInteger(position) ||
                              position < 1 ||
                              position > state.dictionaries.length
                            ) {
                              return;
                            }
                            setPositionMove(null);
                            event.currentTarget
                              .closest("details")
                              ?.removeAttribute("open");
                            void actions.moveDictionaryToPosition(
                              dictionary.id,
                              position
                            );
                          }}
                        >
                          <label>
                            <span>
                              {t(
                                "settings.hoshidicts.dictionaryActions.position"
                              )}
                            </span>
                            <input
                              type="number"
                              min={1}
                              max={state.dictionaries.length}
                              step={1}
                              autoFocus
                              value={positionMove.value}
                              onChange={(event) =>
                                setPositionMove({
                                  id: dictionary.id,
                                  value: event.currentTarget.value
                                })
                              }
                            />
                          </label>
                          <small>
                            {t(
                              "settings.hoshidicts.dictionaryActions.positionHint"
                            )}
                          </small>
                          <div>
                            <button
                              type="submit"
                              disabled={
                                dictionaryBusy ||
                                !Number.isInteger(Number(positionMove.value)) ||
                                Number(positionMove.value) < 1 ||
                                Number(positionMove.value) >
                                  state.dictionaries.length
                              }
                            >
                              {t(
                                "settings.hoshidicts.dictionaryActions.move"
                              )}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => setPositionMove(null)}
                            >
                              {t(
                                "settings.hoshidicts.dictionaryActions.cancel"
                              )}
                            </button>
                          </div>
                        </form>
                      ) : dictionarySchedule?.id === dictionary.id ? (
                        <form
                          className="hoshidicts-dictionary-schedule"
                          aria-label={t(
                            "settings.hoshidicts.dictionaryActions.scheduleForm",
                            { title: dictionaryDisplayName(dictionary) }
                          )}
                          onSubmit={(event) => {
                            event.preventDefault();
                            const schedule =
                              dictionarySchedule.value === "global"
                                ? null
                                : dictionarySchedule.value;
                            setDictionarySchedule(null);
                            event.currentTarget
                              .closest("details")
                              ?.removeAttribute("open");
                            void actions.setDictionarySchedule(
                              dictionary.id,
                              schedule
                            );
                          }}
                        >
                          <label>
                            <span>
                              {t(
                                "settings.hoshidicts.dictionaryActions.schedule"
                              )}
                            </span>
                            <select
                              autoFocus
                              value={dictionarySchedule.value}
                              onChange={(event) =>
                                setDictionarySchedule({
                                  id: dictionary.id,
                                  value: event.currentTarget
                                    .value as DictionaryScheduleChoice
                                })
                              }
                            >
                              <option value="global">
                                {t(
                                  "settings.hoshidicts.dictionaryActions.useGlobalSchedule",
                                  { schedule: t(SCHEDULE_KEYS[state.schedule]) }
                                )}
                              </option>
                              <option value="off">
                                {t(SCHEDULE_KEYS.off)}
                              </option>
                              <option value="hourly">
                                {t(SCHEDULE_KEYS.hourly)}
                              </option>
                              <option value="daily">
                                {t(SCHEDULE_KEYS.daily)}
                              </option>
                              <option value="weekly">
                                {t(SCHEDULE_KEYS.weekly)}
                              </option>
                              <option value="monthly">
                                {t(SCHEDULE_KEYS.monthly)}
                              </option>
                            </select>
                          </label>
                          <small>
                            {t(
                              "settings.hoshidicts.dictionaryActions.scheduleHint"
                            )}
                          </small>
                          <div>
                            <button type="submit" disabled={dictionaryBusy}>
                              {t(
                                "settings.hoshidicts.dictionaryActions.saveSchedule"
                              )}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => setDictionarySchedule(null)}
                            >
                              {t(
                                "settings.hoshidicts.dictionaryActions.cancel"
                              )}
                            </button>
                          </div>
                        </form>
                      ) : (
                        <div role="menu" className="hoshidicts-dictionary-menu__items">
                          <button
                            type="button"
                            role="menuitem"
                            disabled={dictionaryBusy || index === 0}
                            onClick={(event) => {
                              event.currentTarget
                                .closest("details")
                                ?.removeAttribute("open");
                              void actions.moveDictionary(dictionary.id, -1);
                            }}
                          >
                            <ArrowUp size={16} aria-hidden="true" />
                            {t("settings.hoshidicts.moveUp")}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            disabled={
                              dictionaryBusy ||
                              index === state.dictionaries.length - 1
                            }
                            onClick={(event) => {
                              event.currentTarget
                                .closest("details")
                                ?.removeAttribute("open");
                              void actions.moveDictionary(dictionary.id, 1);
                            }}
                          >
                            <ArrowDown size={16} aria-hidden="true" />
                            {t("settings.hoshidicts.moveDown")}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            disabled={dictionaryBusy}
                            onClick={() => {
                              setDictionaryRename(null);
                              setDictionarySchedule(null);
                              setPositionMove({
                                id: dictionary.id,
                                value: String(index + 1)
                              });
                            }}
                          >
                            {t(
                              "settings.hoshidicts.dictionaryActions.moveToPosition"
                            )}
                          </button>
                          {dictionary.termCount > 0 ? (
                            <button
                              type="button"
                              role="menuitem"
                              ref={(button) => {
                                if (button) {
                                  tabGroupTriggerRefs.current.set(
                                    dictionary.id,
                                    button
                                  );
                                } else {
                                  tabGroupTriggerRefs.current.delete(
                                    dictionary.id
                                  );
                                }
                              }}
                              disabled={dictionaryBusy}
                              onClick={() => {
                                setPositionMove(null);
                                setDictionaryRename(null);
                                setDictionarySchedule(null);
                                setTabGroupDictionaryId(dictionary.id);
                              }}
                            >
                              <FolderPlus size={16} aria-hidden="true" />
                              {t(
                                "settings.hoshidicts.dictionaryActions.addToTabGroup"
                              )}
                            </button>
                          ) : null}
                          {dictionary.isUpdatable ? (
                            <button
                              type="button"
                              role="menuitem"
                              disabled={dictionaryBusy}
                              onClick={() => {
                                setPositionMove(null);
                                setDictionaryRename(null);
                                setTabGroupDictionaryId(null);
                                setDictionarySchedule({
                                  id: dictionary.id,
                                  value:
                                    dictionary.updateScheduleOverride ??
                                    "global"
                                });
                              }}
                            >
                              <RefreshCw size={16} aria-hidden="true" />
                              {t(
                                "settings.hoshidicts.dictionaryActions.updateSchedule"
                              )}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            role="menuitem"
                            disabled={dictionaryBusy}
                            onClick={() => {
                              setPositionMove(null);
                              setDictionarySchedule(null);
                              setTabGroupDictionaryId(null);
                              setDictionaryRename({
                                id: dictionary.id,
                                value: dictionaryDisplayName(dictionary)
                              });
                            }}
                          >
                            <Pencil size={16} aria-hidden="true" />
                            {t(
                              "settings.hoshidicts.dictionaryActions.rename"
                            )}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="danger"
                            disabled={dictionaryBusy}
                            onClick={(event) => {
                              event.currentTarget
                                .closest("details")
                                ?.removeAttribute("open");
                              void actions.removeDictionary(dictionary.id);
                            }}
                          >
                            <Trash2 size={16} aria-hidden="true" />
                            {t("settings.hoshidicts.remove")}
                          </button>
                        </div>
                      )}
                    </div>
                  </details>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="hoshidicts-section hoshidicts-backups">
        <div className="hoshidicts-section__heading">
          <div>
            <h2>{t("settings.hoshidicts.backups.title")}</h2>
            <p>{t("settings.hoshidicts.backups.subtitle")}</p>
          </div>
        </div>
        <div className="hoshidicts-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => void actions.exportBackup()}
            disabled={backupBusy}
          >
            <Download size={17} aria-hidden="true" />
            {t("settings.hoshidicts.backups.exportHoshidicts")}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void actions.restoreBackup()}
            disabled={backupBusy}
          >
            <ArchiveRestore size={17} aria-hidden="true" />
            {t("settings.hoshidicts.backups.restoreHoshidicts")}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void actions.importYomitanDictionaries()}
            disabled={backupBusy}
          >
            <FileArchive size={17} aria-hidden="true" />
            {t("settings.hoshidicts.backups.importDictionaries")}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void actions.importYomitanSettings()}
            disabled={backupBusy}
          >
            <FileJson size={17} aria-hidden="true" />
            {t("settings.hoshidicts.backups.importSettings")}
          </button>
        </div>
        {backupOperation ? (
          <div
            className="hoshidicts-window__progress hoshidicts-backups__status"
            role="status"
          >
            {t(`settings.hoshidicts.backups.${backupOperation}`)}
          </div>
        ) : null}
      </section>
    </div>
  );
}

export function MiningPanel({ controller }: { controller: Controller }) {
  const t = useTranslation();
  const {
    miningDraft,
    miningOptions,
    miningOptionsLoading,
    miningSaveStatus,
    updateMiningDraft,
    setMiningModel,
    setMiningField,
    loadMiningOptions,
    miningBusy
  } = controller;

  const visibleFields = useMemo(
    () => visibleMiningFields(miningDraft, miningOptions),
    [miningDraft, miningOptions]
  );
  const visibleTemplates = useMemo(
    () =>
      Object.fromEntries(
        visibleFields.map((field) => [
          field,
          resolvedMiningFieldTemplate(miningDraft, miningOptions, field)
        ])
      ),
    [miningDraft, miningOptions, visibleFields]
  );
  const mappedCount = useMemo(
    () =>
      visibleFields.filter(
        (field) => visibleTemplates[field]?.value.trim().length > 0
      )
        .length,
    [visibleFields, visibleTemplates]
  );
  const showOverwriteModes =
    miningDraft.checkForDuplicates &&
    miningDraft.duplicateBehavior === "overwrite";

  return (
    <section className="hoshidicts-section hoshidicts-mining">
      <div className="hoshidicts-section__heading">
        <div>
          <h2>{t("settings.hoshidicts.mining.title")}</h2>
          <p>{t("settings.hoshidicts.mining.autoSaveHint")}</p>
        </div>
        <div className="hoshidicts-section__status-actions">
          <HoshidictsSaveIndicator status={miningSaveStatus} />
          <label className="hoshidicts-mining__toggle">
            <input
              id="hoshidicts-mining-enabled"
              type="checkbox"
              checked={miningDraft.enabled}
              disabled={miningBusy}
              onChange={(event) =>
                updateMiningDraft((current) => ({
                  ...current,
                  enabled: event.target.checked
                }))
              }
            />
            <span>{t("settings.hoshidicts.mining.enabled")}</span>
          </label>
        </div>
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
          onClick={() => void loadMiningOptions(miningDraft.model || undefined)}
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
          {t("settings.hoshidicts.mining.ankiError", {
            message: miningOptions.error
          })}
        </p>
      ) : null}

      <div className="hoshidicts-mining-grid">
        <label>
          <span>{t("settings.hoshidicts.mining.deck")}</span>
          {miningOptions.connected ? (
            <select
              id="hoshidicts-mining-deck"
              value={miningDraft.deck}
              disabled={miningBusy}
              onChange={(event) =>
                updateMiningDraft((current) => ({
                  ...current,
                  deck: event.target.value
                }))
              }
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
              disabled={miningBusy}
              onChange={(event) =>
                updateMiningDraft((current) => ({
                  ...current,
                  deck: event.target.value
                }))
              }
            />
          )}
        </label>

        <label>
          <span>{t("settings.hoshidicts.mining.noteType")}</span>
          {miningOptions.connected ? (
            <select
              id="hoshidicts-mining-model"
              value={miningDraft.model}
              disabled={miningBusy}
              onChange={(event) => setMiningModel(event.target.value)}
            >
              <option value="">
                {miningOptions.selectedNoteType
                  ? t("settings.hoshidicts.mining.automaticNoteType", {
                      name: miningOptions.selectedNoteType
                    })
                  : t("settings.hoshidicts.mining.automatic")}
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
              disabled={miningBusy}
              onChange={(event) => setMiningModel(event.target.value)}
            />
          )}
        </label>

        <label>
          <span>{t("settings.hoshidicts.mining.tags")}</span>
          <input
            id="hoshidicts-mining-tags"
            type="text"
            value={miningDraft.tags}
            disabled={miningBusy}
            onChange={(event) =>
              updateMiningDraft((current) => ({
                ...current,
                tags: event.target.value
              }))
            }
          />
        </label>

      </div>

      <fieldset className="hoshidicts-mining-duplicates">
        <legend>{t("settings.hoshidicts.mining.duplicateHandling")}</legend>
        <label className="hoshidicts-mining-duplicates__toggle">
          <input
            id="hoshidicts-mining-check-duplicates"
            type="checkbox"
            checked={miningDraft.checkForDuplicates}
            disabled={miningBusy}
            onChange={(event) =>
              updateMiningDraft((current) => ({
                ...current,
                checkForDuplicates: event.target.checked
              }))
            }
          />
          <span>{t("settings.hoshidicts.mining.checkForDuplicates")}</span>
        </label>
        <p>{t("settings.hoshidicts.mining.duplicateCheckHint")}</p>

        <div className="hoshidicts-mining-duplicates__options">
          <label>
            <span>{t("settings.hoshidicts.mining.duplicateScope")}</span>
            <select
              id="hoshidicts-mining-duplicate-scope"
              value={miningDraft.duplicateScope}
              disabled={miningBusy || !miningDraft.checkForDuplicates}
              onChange={(event) =>
                updateMiningDraft((current) => ({
                  ...current,
                  duplicateScope:
                    event.target.value === "deck" ||
                    event.target.value === "deck-root"
                      ? event.target.value
                      : "collection"
                }))
              }
            >
              <option value="collection">
                {t("settings.hoshidicts.mining.scopeCollection")}
              </option>
              <option value="deck">
                {t("settings.hoshidicts.mining.scopeDeck")}
              </option>
              <option value="deck-root">
                {t("settings.hoshidicts.mining.scopeDeckRoot")}
              </option>
            </select>
          </label>

          <label>
            <span>{t("settings.hoshidicts.mining.whenDuplicateDetected")}</span>
            <select
              id="hoshidicts-mining-duplicate-behavior"
              value={miningDraft.duplicateBehavior}
              disabled={miningBusy || !miningDraft.checkForDuplicates}
              onChange={(event) =>
                updateMiningDraft((current) => ({
                  ...current,
                  duplicateBehavior:
                    event.target.value === "overwrite" ||
                    event.target.value === "new"
                      ? event.target.value
                      : "prevent"
                }))
              }
            >
              <option value="prevent">
                {t("settings.hoshidicts.mining.preventAdding")}
              </option>
              <option value="overwrite">
                {t("settings.hoshidicts.mining.allowOverwriting")}
              </option>
              <option value="new">
                {t("settings.hoshidicts.mining.allowAdding")}
              </option>
            </select>
          </label>
        </div>

        <label className="hoshidicts-mining-duplicates__toggle">
          <input
            id="hoshidicts-mining-check-all-note-types"
            type="checkbox"
            checked={miningDraft.duplicateScopeCheckAllModels}
            disabled={miningBusy || !miningDraft.checkForDuplicates}
            onChange={(event) =>
              updateMiningDraft((current) => ({
                ...current,
                duplicateScopeCheckAllModels: event.target.checked
              }))
            }
          />
          <span>{t("settings.hoshidicts.mining.checkAllNoteTypes")}</span>
        </label>
        <p>{t("settings.hoshidicts.mining.checkAllNoteTypesHint")}</p>
        {showOverwriteModes ? (
          <p className="hoshidicts-mining-duplicates__warning" role="note">
            {t("settings.hoshidicts.mining.overwriteWarning")}
          </p>
        ) : null}
      </fieldset>

      <details className="hoshidicts-mining-fields" open>
        <summary>{t("settings.hoshidicts.mining.fieldMappings")}</summary>
        <div className="hoshidicts-mining-fields__summary" role="status">
          <span>
            {t("settings.hoshidicts.mining.mappingCount", {
              mapped: mappedCount,
              total: visibleFields.length
            })}
          </span>
          <span>{t("settings.hoshidicts.mining.mappingHint")}</span>
        </div>
        <datalist id="hoshidicts-mining-field-values">
          {MINING_FIELD_TEMPLATE_SUGGESTIONS.map((suggestion) => (
            <option value={suggestion.value} key={suggestion.value}>
              {t(suggestion.labelKey)}
            </option>
          ))}
        </datalist>
        {visibleFields.length > 0 ? (
          <div className="hoshidicts-mining-field-grid">
            <div
              className="hoshidicts-mining-field-grid__header-row"
              data-overwrite={showOverwriteModes}
            >
              <span className="hoshidicts-mining-field-grid__header">
                {t("settings.hoshidicts.mining.mappingFieldHeader")}
              </span>
              <span className="hoshidicts-mining-field-grid__header">
                {t("settings.hoshidicts.mining.mappingValueHeader")}
              </span>
              {showOverwriteModes ? (
                <span className="hoshidicts-mining-field-grid__header">
                  {t("settings.hoshidicts.mining.overwriteModeHeader")}
                </span>
              ) : null}
            </div>
            {visibleFields.map((field, index) => {
              const template = visibleTemplates[field];
              const inputId = `hoshidicts-mining-field-${index}`;
              return (
                <div
                  className="hoshidicts-mining-field-row"
                  data-overwrite={showOverwriteModes}
                  key={field}
                >
                  <label htmlFor={inputId}>{field}</label>
                  <input
                    id={inputId}
                    className="hoshidicts-mining-field-value"
                    data-anki-field={field}
                    data-field-control="value"
                    type="text"
                    list="hoshidicts-mining-field-values"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t(
                      "settings.hoshidicts.mining.mappingValuePlaceholder"
                    )}
                    value={template?.value ?? ""}
                    disabled={miningBusy || miningOptionsLoading}
                    onChange={(event) =>
                      setMiningField(field, { value: event.target.value })
                    }
                  />
                  {showOverwriteModes ? (
                    <select
                      id={`hoshidicts-mining-overwrite-${index}`}
                      data-anki-field={field}
                      data-field-control="overwrite"
                      aria-label={t(
                        "settings.hoshidicts.mining.overwriteFieldLabel",
                        { field }
                      )}
                      value={template?.overwriteMode ?? "coalesce"}
                      disabled={miningBusy || miningOptionsLoading}
                      onChange={(event) => {
                        const overwriteMode = event.target
                          .value as HoshidictsFieldOverwriteMode;
                        if (
                          !HOSHIDICTS_FIELD_OVERWRITE_MODES.includes(
                            overwriteMode
                          )
                        ) {
                          return;
                        }
                        setMiningField(field, { overwriteMode });
                      }}
                    >
                      {HOSHIDICTS_FIELD_OVERWRITE_MODES.map((mode) => (
                        <option value={mode} key={mode}>
                          {t(OVERWRITE_MODE_KEYS[mode])}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="hoshidicts-mining-fields__empty">
            {t("settings.hoshidicts.mining.noModelFields")}
          </p>
        )}

        {miningOptions.warnings.map((warning) => (
          <p className="hoshidicts-mining-fields__warning" key={warning}>
            {t("settings.hoshidicts.mining.mappingWarning", {
              message: warning
            })}
          </p>
        ))}
      </details>
    </section>
  );
}
