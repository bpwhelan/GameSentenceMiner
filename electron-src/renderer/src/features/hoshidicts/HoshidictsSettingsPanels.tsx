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
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";

import {
  DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
  DEFAULT_HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS,
  HOSHIDICTS_FIELD_OVERWRITE_MODES,
  MAX_HOSHIDICTS_MAX_RESULTS,
  MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
  MAX_HOSHIDICTS_SCAN_LENGTH,
  MAX_HOSHIDICTS_TAB_GROUP_NAME_LENGTH,
  MIN_HOSHIDICTS_MAX_RESULTS,
  MIN_HOSHIDICTS_SCAN_LENGTH,
  type HoshidictsActivationKey,
  type HoshidictsBulkDictionaryAction,
  type HoshidictsFieldOverwriteMode,
  type HoshidictsSchedule
} from "../../../../shared/features/hoshidicts";
import { useTranslation } from "../../i18n";
import { HoshidictsNumberSetting } from "./components/HoshidictsNumberSetting";
import { HoshidictsSelectSetting } from "./components/HoshidictsSelectSetting";
import { HoshidictsToggleSetting } from "./components/HoshidictsToggleSetting";
import {
  MINING_FIELD_TEMPLATE_SUGGESTIONS,
  RECOMMENDED_KEYS,
  activationKeyFromKeyboardCode,
  frequencyModeKey,
  formatTimestamp,
  resolvedMiningFieldTemplate,
  sortFrequencyDictionaryOrderForMode,
  summarizeCustomDictionaryText,
  visibleMiningFields,
  type MiningProfileDraft
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

const SCHEDULE_ENTRIES = Object.entries(SCHEDULE_KEYS) as Array<
  [HoshidictsSchedule, string]
>;

const LOOKUP_LIMITS = [
  {
    id: "hoshidicts-scan-length",
    key: "scanLength",
    labelKey: "settings.hoshidicts.reader.lookup.scanLength",
    min: MIN_HOSHIDICTS_SCAN_LENGTH,
    max: MAX_HOSHIDICTS_SCAN_LENGTH
  },
  {
    id: "hoshidicts-max-results",
    key: "maxResults",
    labelKey: "settings.hoshidicts.reader.lookup.maxResults",
    min: MIN_HOSHIDICTS_MAX_RESULTS,
    max: MAX_HOSHIDICTS_MAX_RESULTS
  }
] as const;

const DUPLICATE_SCOPES = [
  { value: "collection", labelKey: "settings.hoshidicts.mining.scopeCollection" },
  { value: "deck", labelKey: "settings.hoshidicts.mining.scopeDeck" },
  { value: "deck-root", labelKey: "settings.hoshidicts.mining.scopeDeckRoot" }
] as const;

const DUPLICATE_BEHAVIORS = [
  { value: "prevent", labelKey: "settings.hoshidicts.mining.preventAdding" },
  {
    value: "overwrite",
    labelKey: "settings.hoshidicts.mining.allowOverwriting"
  },
  { value: "new", labelKey: "settings.hoshidicts.mining.allowAdding" }
] as const;

const BULK_DICTIONARY_ACTIONS: ReadonlyArray<{
  action: HoshidictsBulkDictionaryAction;
  labelKey: string;
  scope: "all" | "terms" | "updatable";
  secondary?: boolean;
  refreshIcon?: boolean;
}> = [
  {
    action: "enable",
    labelKey: "settings.hoshidicts.dictionaryBulk.enable",
    scope: "all"
  },
  {
    action: "disable",
    labelKey: "settings.hoshidicts.dictionaryBulk.disable",
    scope: "all"
  },
  {
    action: "favorite",
    labelKey: "settings.hoshidicts.dictionaryBulk.favorite",
    scope: "terms",
    secondary: true
  },
  {
    action: "unfavorite",
    labelKey: "settings.hoshidicts.dictionaryBulk.unfavorite",
    scope: "terms",
    secondary: true
  },
  {
    action: "update",
    labelKey: "settings.hoshidicts.dictionaryBulk.updateNow",
    scope: "updatable",
    secondary: true,
    refreshIcon: true
  }
];

const DICTIONARY_ENTRY_COUNTS = [
  { field: "termCount", labelKey: "settings.hoshidicts.terms" },
  { field: "frequencyCount", labelKey: "settings.hoshidicts.frequencies" },
  { field: "pitchCount", labelKey: "settings.hoshidicts.pitches" },
  { field: "kanjiCount", labelKey: "settings.hoshidicts.kanjiEntries" }
] as const;

type DictionaryScheduleChoice = "global" | HoshidictsSchedule;

function dictionaryDisplayName(dictionary: {
  title: string;
  displayName: string | null;
}): string {
  return dictionary.displayName ?? dictionary.title;
}

function isDictionaryPosition(value: string, total: number): boolean {
  const position = Number(value);
  return Number.isInteger(position) && position >= 1 && position <= total;
}

/**
 * One editor inside a dictionary action menu: a labelled control, a hint and
 * save/cancel buttons that close the menu once the edit is accepted.
 */
function DictionaryMenuForm({
  className,
  ariaLabel,
  label,
  hint,
  hintId,
  submitLabel,
  submitDisabled,
  extraAction,
  children,
  onSubmit,
  onCancel
}: {
  className: string;
  ariaLabel?: string;
  label: string;
  hint: string;
  hintId?: string;
  submitLabel: string;
  submitDisabled: boolean;
  extraAction?: ReactNode;
  children: ReactNode;
  /** Returns false to keep the menu open, for example on invalid input. */
  onSubmit: () => boolean;
  onCancel: () => void;
}) {
  const t = useTranslation();

  return (
    <form
      className={className}
      aria-label={ariaLabel}
      onSubmit={(event) => {
        event.preventDefault();
        const menu = event.currentTarget.closest("details");
        if (onSubmit()) menu?.removeAttribute("open");
      }}
    >
      <label className="hoshidicts-setting">
        <span>{label}</span>
        {children}
      </label>
      <small id={hintId}>{hint}</small>
      <div>
        <button type="submit" disabled={submitDisabled}>
          {submitLabel}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t("settings.hoshidicts.dictionaryActions.cancel")}
        </button>
        {extraAction}
      </div>
    </form>
  );
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
              <div
                className="hoshidicts-list-row hoshidicts-tab-group-row"
                key={group.id}
              >
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
  dictionary
}: {
  controller: Controller;
  dictionary: NonNullable<Controller["state"]>["dictionaries"][number];
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
    <div className="hoshidicts-setting hoshidicts-activation-key">
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

          <label className="hoshidicts-setting hoshidicts-custom__editor">
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
    setReaderPreference,
    setBoundedReaderInteger,
    setPopupContentScanningEnabled,
    backupOperation,
    yomitanImportProgress,
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
  const [recommendedExpandedOverride, setRecommendedExpandedOverride] =
    useState<boolean | null>(null);
  const [dictionarySearch, setDictionarySearch] = useState("");
  const [selectedDictionaryIds, setSelectedDictionaryIds] = useState<
    Set<string>
  >(() => new Set());

  const installedDictionaries = state?.dictionaries ?? [];
  const normalizedDictionarySearch = dictionarySearch
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase();
  const matchingDictionaries = useMemo(
    () =>
      installedDictionaries
        .map((dictionary, index) => ({ dictionary, index }))
        .filter(({ dictionary }) => {
          if (!normalizedDictionarySearch) return true;
          return [dictionary.title, dictionary.displayName]
            .filter((name): name is string => name !== null)
            .some((name) =>
              name
                .normalize("NFKC")
                .toLocaleLowerCase()
                .includes(normalizedDictionarySearch)
            );
        }),
    [installedDictionaries, normalizedDictionarySearch]
  );

  useEffect(() => {
    const installedIds = new Set(
      installedDictionaries.map((dictionary) => dictionary.id)
    );
    setSelectedDictionaryIds((current) => {
      const next = new Set(
        [...current].filter((dictionaryId) => installedIds.has(dictionaryId))
      );
      if (
        next.size === current.size &&
        [...next].every((dictionaryId) => current.has(dictionaryId))
      ) {
        return current;
      }
      return next;
    });
  }, [installedDictionaries]);

  useEffect(() => {
    const closeMenusOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;

      let closed = false;
      document
        .querySelectorAll<HTMLDetailsElement>(
          ".hoshidicts-dictionary-menu[open]"
        )
        .forEach((menu) => {
          if (!menu.contains(target)) {
            menu.removeAttribute("open");
            closed = true;
          }
        });

      if (closed) {
        setPositionMove(null);
        setDictionaryRename(null);
        setDictionarySchedule(null);
        setTabGroupDictionaryId(null);
      }
    };

    document.addEventListener("pointerdown", closeMenusOutside, true);
    return () =>
      document.removeEventListener("pointerdown", closeMenusOutside, true);
  }, []);

  if (!state) return null;

  const matchingIds = matchingDictionaries.map(
    ({ dictionary }) => dictionary.id
  );
  const allMatchesSelected =
    matchingIds.length > 0 &&
    matchingIds.every((dictionaryId) =>
      selectedDictionaryIds.has(dictionaryId)
    );
  const selectedDictionaries = state.dictionaries.filter((dictionary) =>
    selectedDictionaryIds.has(dictionary.id)
  );
  const selectedTermDictionaryIds = selectedDictionaries
    .filter((dictionary) => dictionary.termCount > 0)
    .map((dictionary) => dictionary.id);
  const selectedUpdatableDictionaryIds = selectedDictionaries
    .filter((dictionary) => dictionary.isUpdatable)
    .map((dictionary) => dictionary.id);
  const bulkActionIds = (scope: "all" | "terms" | "updatable") =>
    scope === "terms"
      ? selectedTermDictionaryIds
      : scope === "updatable"
        ? selectedUpdatableDictionaryIds
        : selectedDictionaries.map((dictionary) => dictionary.id);

  const recommendedExpanded =
    recommendedExpandedOverride ??
    (state.dictionaries.length === 0 && !state.customDictionaryActive);
  const importingYomitan =
    backupOperation === "importingYomitanDictionaries" ||
    backupOperation === "importingYomitanSettings";
  const yomitanReadingPercent =
    backupOperation === "importingYomitanDictionaries" &&
    yomitanImportProgress?.phase === "reading" &&
    yomitanImportProgress.totalBytes > 0
      ? yomitanImportProgress.completedBytes >=
        yomitanImportProgress.totalBytes
        ? 100
        : Math.min(
            99,
            Math.max(
              0,
              Math.floor(
                (yomitanImportProgress.completedBytes /
                  yomitanImportProgress.totalBytes) *
                  100
              )
            )
          )
      : null;
  let yomitanReadingEta: string | null = null;
  if (
    yomitanImportProgress?.phase === "reading" &&
    yomitanImportProgress.estimatedSecondsRemaining !== null
  ) {
    const seconds = Math.max(
      1,
      Math.ceil(yomitanImportProgress.estimatedSecondsRemaining)
    );
    if (seconds < 60) {
      yomitanReadingEta = t("settings.hoshidicts.backups.etaSeconds", {
        seconds
      });
    } else {
      const minutes = Math.ceil(seconds / 60);
      yomitanReadingEta =
        minutes < 60
          ? t("settings.hoshidicts.backups.etaMinutes", { minutes })
          : t("settings.hoshidicts.backups.etaHours", {
              hours: Math.floor(minutes / 60),
              minutes: minutes % 60
            });
    }
  }
  const yomitanReadingSummary =
    yomitanReadingPercent === null
      ? null
      : t(
          yomitanReadingEta
            ? "settings.hoshidicts.backups.progressEstimate"
            : "settings.hoshidicts.backups.progressPercent",
          {
            percent: yomitanReadingPercent,
            eta: yomitanReadingEta
          }
        );
  const yomitanDictionaryImportProgress =
    backupOperation === "importingYomitanDictionaries" &&
    yomitanImportProgress !== null
      ? yomitanImportProgress.phase === "reading"
        ? t("settings.hoshidicts.backups.readingYomitanDictionaries")
        : t(
            yomitanImportProgress.phase === "preparing"
              ? "settings.hoshidicts.backups.preparingYomitanDictionary"
              : "settings.hoshidicts.backups.importingYomitanDictionary",
            {
              current: yomitanImportProgress.current,
              total: yomitanImportProgress.total,
              title: yomitanImportProgress.title
            }
          )
      : null;
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
              onChange={() => setReaderPreference("lookupMode", "shift")}
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
              onChange={() => setReaderPreference("lookupMode", "hover")}
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
          onChange={(activationKey) =>
            setReaderPreference("activationKey", activationKey)
          }
        />

        <HoshidictsToggleSetting
          id="hoshidicts-only-scan-japanese-text"
          className="hoshidicts-toggle--boxed"
          label={t("settings.hoshidicts.reader.onlyScanJapaneseText")}
          hint={t("settings.hoshidicts.reader.onlyScanJapaneseTextHint")}
          checked={readerDraft.onlyScanJapaneseText}
          disabled={preferencesBusy}
          onChange={(value) =>
            setReaderPreference("onlyScanJapaneseText", value)
          }
        />

        <div className="hoshidicts-reader-lookup-options">
          <div className="hoshidicts-reader-lookup-options__heading">
            <strong>{t("settings.hoshidicts.reader.lookup.title")}</strong>
            <small>{t("settings.hoshidicts.reader.lookup.hint")}</small>
          </div>
          <div className="hoshidicts-reader-lookup-options__controls">
            {LOOKUP_LIMITS.map((limit) => (
              <HoshidictsNumberSetting
                key={limit.id}
                id={limit.id}
                label={t(limit.labelKey)}
                hint={t(`${limit.labelKey}Hint`)}
                min={limit.min}
                max={limit.max}
                value={readerDraft[limit.key]}
                disabled={preferencesBusy}
                onChange={(value) =>
                  setBoundedReaderInteger(limit.key, value, limit.min, limit.max)
                }
              />
            ))}
            <HoshidictsSelectSetting
              id="hoshidicts-sort-frequency-dictionary"
              label={t("settings.hoshidicts.reader.lookup.frequencyDictionary")}
              hint={t(
                "settings.hoshidicts.reader.lookup.frequencyDictionaryHint"
              )}
              value={readerDraft.sortFrequencyDictionary ?? ""}
              disabled={preferencesBusy}
              onChange={(selected) => {
                const title = selected || null;
                setReaderPreference("sortFrequencyDictionary", title);
                if (title !== null) {
                  const dictionary = state.dictionaries.find(
                    (candidate) => candidate.title === title
                  );
                  setReaderPreference(
                    "sortFrequencyDictionaryOrder",
                    sortFrequencyDictionaryOrderForMode(
                      dictionary?.frequencyMode ?? null
                    )
                  );
                }
              }}
            >
              <option value="">
                {t("settings.hoshidicts.reader.lookup.frequencyOff")}
              </option>
              {state.dictionaries
                .filter(
                  (dictionary) =>
                    dictionary.enabled && dictionary.frequencyCount > 0
                )
                .map((dictionary) => (
                  <option key={dictionary.id} value={dictionary.title}>
                    {dictionaryDisplayName(dictionary)}
                  </option>
                ))}
            </HoshidictsSelectSetting>
          </div>

          {readerDraft.sortFrequencyDictionary !== null ? (
            <div
              id="hoshidicts-sort-frequency-dictionary-order-container"
              className="hoshidicts-reader-lookup-options__order"
            >
              <label htmlFor="hoshidicts-sort-frequency-dictionary-order">
                {t("settings.hoshidicts.reader.lookup.frequencyOrder")}
              </label>
              <div>
                <button
                  id="hoshidicts-sort-frequency-dictionary-order-auto"
                  type="button"
                  className="secondary"
                  disabled={preferencesBusy}
                  onClick={() => {
                    const dictionary = state.dictionaries.find(
                      (candidate) =>
                        candidate.title === readerDraft.sortFrequencyDictionary
                    );
                    setReaderPreference(
                      "sortFrequencyDictionaryOrder",
                      sortFrequencyDictionaryOrderForMode(
                        dictionary?.frequencyMode ?? null
                      )
                    );
                  }}
                >
                  {t("settings.hoshidicts.reader.lookup.frequencyOrderAuto")}
                </button>
                <select
                  id="hoshidicts-sort-frequency-dictionary-order"
                  value={readerDraft.sortFrequencyDictionaryOrder}
                  disabled={preferencesBusy}
                  onChange={(event) =>
                    setReaderPreference(
                      "sortFrequencyDictionaryOrder",
                      event.currentTarget.value === "ascending"
                        ? "ascending"
                        : "descending"
                    )
                  }
                >
                  <option value="descending">
                    {t(
                      "settings.hoshidicts.reader.lookup.frequencyOccurrenceBased"
                    )}
                  </option>
                  <option value="ascending">
                    {t("settings.hoshidicts.reader.lookup.frequencyRankBased")}
                  </option>
                </select>
              </div>
            </div>
          ) : null}
        </div>

        <HoshidictsNumberSetting
          id="hoshidicts-popup-hide-delay"
          className="hoshidicts-reader-delay"
          label={t("settings.hoshidicts.reader.hideDelay")}
          hint={t("settings.hoshidicts.reader.hideDelayHint")}
          unit={t("settings.hoshidicts.reader.milliseconds")}
          min={0}
          max={MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS}
          step={50}
          value={readerDraft.popupHideDelayMs}
          disabled={preferencesBusy}
          onChange={(value) =>
            setBoundedReaderInteger(
              "popupHideDelayMs",
              value,
              0,
              MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS
            )
          }
        />

        <div className="hoshidicts-reader-popup-scanning">
          <HoshidictsToggleSetting
            id="hoshidicts-popup-content-scanning"
            label={t("settings.hoshidicts.reader.allowPopupContentScanning")}
            hint={t("settings.hoshidicts.reader.allowPopupContentScanningHint")}
            checked={readerDraft.popupNestingMaxDepth > 0}
            disabled={preferencesBusy}
            onChange={setPopupContentScanningEnabled}
          />

          {readerDraft.popupNestingMaxDepth > 0 ? (
            <HoshidictsNumberSetting
              id="hoshidicts-popup-nesting-max-depth"
              className="hoshidicts-reader-depth"
              label={t("settings.hoshidicts.reader.maxChildPopups")}
              hint={t("settings.hoshidicts.reader.maxChildPopupsHint")}
              min={1}
              value={readerDraft.popupNestingMaxDepth}
              disabled={preferencesBusy}
              onChange={(value) =>
                setBoundedReaderInteger(
                  "popupNestingMaxDepth",
                  value,
                  1,
                  Number.MAX_SAFE_INTEGER
                )
              }
            />
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

        <HoshidictsSelectSetting
          id="hoshidicts-update-schedule"
          label={t("settings.hoshidicts.schedule")}
          value={state.schedule}
          disabled={dictionaryBusy}
          options={SCHEDULE_ENTRIES.map(([schedule, labelKey]) => ({
            value: schedule,
            label: t(labelKey)
          }))}
          onChange={(schedule) =>
            void actions.setSchedule(schedule as HoshidictsSchedule)
          }
        />

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
            <div
              className="hoshidicts-list-row hoshidicts-recommended-row"
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

        {state.dictionaries.length > 0 ? (
          <div className="hoshidicts-dictionary-bulk-toolbar">
            <div className="hoshidicts-dictionary-search">
              <input
                type="search"
                value={dictionarySearch}
                aria-label={t(
                  "settings.hoshidicts.dictionaryBulk.searchLabel"
                )}
                placeholder={t(
                  "settings.hoshidicts.dictionaryBulk.searchPlaceholder"
                )}
                onChange={(event) =>
                  setDictionarySearch(event.currentTarget.value)
                }
              />
              <span>
                {t("settings.hoshidicts.dictionaryBulk.matchCount", {
                  count: matchingDictionaries.length
                })}
              </span>
            </div>
            <div className="hoshidicts-dictionary-selection-actions">
              <button
                type="button"
                className="secondary"
                disabled={dictionaryBusy || matchingIds.length === 0}
                onClick={() =>
                  setSelectedDictionaryIds((current) => {
                    const next = new Set(current);
                    for (const dictionaryId of matchingIds) {
                      if (allMatchesSelected) next.delete(dictionaryId);
                      else next.add(dictionaryId);
                    }
                    return next;
                  })
                }
              >
                {t(
                  allMatchesSelected
                    ? "settings.hoshidicts.dictionaryBulk.deselectAllMatches"
                    : "settings.hoshidicts.dictionaryBulk.selectAllMatches"
                )}
              </button>
              <span role="status">
                {t("settings.hoshidicts.dictionaryBulk.selectedCount", {
                  count: selectedDictionaries.length
                })}
              </span>
            </div>
            <div className="hoshidicts-dictionary-bulk-actions">
              {BULK_DICTIONARY_ACTIONS.map((bulk) => {
                const ids = bulkActionIds(bulk.scope);
                return (
                  <button
                    key={bulk.action}
                    type="button"
                    className={bulk.secondary ? "secondary" : undefined}
                    disabled={dictionaryBusy || ids.length === 0}
                    onClick={() =>
                      void actions.bulkDictionaryAction(bulk.action, ids)
                    }
                  >
                    {bulk.refreshIcon ? (
                      <RefreshCw size={16} aria-hidden="true" />
                    ) : null}
                    {t(bulk.labelKey)}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {state.dictionaries.length === 0 ? (
          <div className="hoshidicts-empty">
            {t("settings.hoshidicts.empty")}
          </div>
        ) : matchingDictionaries.length === 0 ? (
          <div className="hoshidicts-empty">
            {t("settings.hoshidicts.dictionaryBulk.noMatches")}
          </div>
        ) : (
          <div className="hoshidicts-dictionary-list">
            {matchingDictionaries.map(({ dictionary, index }) => (
              <div
                className={`hoshidicts-list-row hoshidicts-dictionary-row ${
                  dictionary.enabled ? "" : "is-disabled"
                }`}
                key={dictionary.id}
              >
                <label className="hoshidicts-dictionary-row__selection">
                  <input
                    type="checkbox"
                    checked={selectedDictionaryIds.has(dictionary.id)}
                    disabled={dictionaryBusy}
                    aria-label={t(
                      "settings.hoshidicts.dictionaryBulk.selectDictionary",
                      { title: dictionaryDisplayName(dictionary) }
                    )}
                    onChange={(event) => {
                      const selected = event.currentTarget.checked;
                      setSelectedDictionaryIds((current) => {
                        const next = new Set(current);
                        if (selected) next.add(dictionary.id);
                        else next.delete(dictionary.id);
                        return next;
                      });
                    }}
                  />
                </label>
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
                    <span
                      className="hoshidicts-dictionary-search-position"
                      aria-label={t(
                        "settings.hoshidicts.dictionaryActions.searchPosition",
                        {
                          title: dictionaryDisplayName(dictionary),
                          position: index + 1,
                          total: state.dictionaries.length
                        }
                      )}
                      title={t(
                        "settings.hoshidicts.dictionaryActions.searchPosition",
                        {
                          title: dictionaryDisplayName(dictionary),
                          position: index + 1,
                          total: state.dictionaries.length
                        }
                      )}
                    >
                      {index + 1}
                    </span>
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
                    {DICTIONARY_ENTRY_COUNTS.filter(
                      ({ field }) => dictionary[field] > 0
                    ).map(({ field, labelKey }) => (
                      <span key={field}>
                        {t(labelKey, { count: dictionary[field] })}
                      </span>
                    ))}
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
                      if (event.currentTarget.open) return;
                      if (positionMove?.id === dictionary.id) {
                        setPositionMove(null);
                      }
                      if (dictionaryRename?.id === dictionary.id) {
                        setDictionaryRename(null);
                      }
                      if (dictionarySchedule?.id === dictionary.id) {
                        setDictionarySchedule(null);
                      }
                      if (tabGroupDictionaryId === dictionary.id) {
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
                        />
                      ) : dictionaryRename?.id === dictionary.id ? (
                        <DictionaryMenuForm
                          className="hoshidicts-dictionary-rename"
                          ariaLabel={t(
                            "settings.hoshidicts.dictionaryActions.renameForm",
                            { title: dictionaryDisplayName(dictionary) }
                          )}
                          label={t(
                            "settings.hoshidicts.dictionaryActions.displayName"
                          )}
                          hintId={`hoshidicts-dictionary-rename-original-${dictionary.id}`}
                          hint={t(
                            "settings.hoshidicts.dictionaryActions.originalName",
                            { title: dictionary.title }
                          )}
                          submitLabel={t(
                            "settings.hoshidicts.dictionaryActions.saveName"
                          )}
                          submitDisabled={
                            dictionaryBusy ||
                            dictionaryRename.value.trim().length === 0
                          }
                          onSubmit={() => {
                            const displayName = dictionaryRename.value.trim();
                            if (!displayName) return false;
                            setDictionaryRename(null);
                            void actions.renameDictionary(
                              dictionary.id,
                              displayName
                            );
                            return true;
                          }}
                          onCancel={() => setDictionaryRename(null)}
                          extraAction={
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
                          }
                        >
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
                        </DictionaryMenuForm>
                      ) : positionMove?.id === dictionary.id ? (
                        <DictionaryMenuForm
                          className="hoshidicts-dictionary-position"
                          label={t(
                            "settings.hoshidicts.dictionaryActions.position"
                          )}
                          hint={t(
                            "settings.hoshidicts.dictionaryActions.positionHint"
                          )}
                          submitLabel={t(
                            "settings.hoshidicts.dictionaryActions.move"
                          )}
                          submitDisabled={
                            dictionaryBusy ||
                            !isDictionaryPosition(
                              positionMove.value,
                              state.dictionaries.length
                            )
                          }
                          onSubmit={() => {
                            if (
                              !isDictionaryPosition(
                                positionMove.value,
                                state.dictionaries.length
                              )
                            ) {
                              return false;
                            }
                            setPositionMove(null);
                            void actions.moveDictionaryToPosition(
                              dictionary.id,
                              Number(positionMove.value)
                            );
                            return true;
                          }}
                          onCancel={() => setPositionMove(null)}
                        >
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
                        </DictionaryMenuForm>
                      ) : dictionarySchedule?.id === dictionary.id ? (
                        <DictionaryMenuForm
                          className="hoshidicts-dictionary-schedule"
                          ariaLabel={t(
                            "settings.hoshidicts.dictionaryActions.scheduleForm",
                            { title: dictionaryDisplayName(dictionary) }
                          )}
                          label={t(
                            "settings.hoshidicts.dictionaryActions.schedule"
                          )}
                          hint={t(
                            "settings.hoshidicts.dictionaryActions.scheduleHint"
                          )}
                          submitLabel={t(
                            "settings.hoshidicts.dictionaryActions.saveSchedule"
                          )}
                          submitDisabled={dictionaryBusy}
                          onSubmit={() => {
                            const schedule =
                              dictionarySchedule.value === "global"
                                ? null
                                : dictionarySchedule.value;
                            setDictionarySchedule(null);
                            void actions.setDictionarySchedule(
                              dictionary.id,
                              schedule
                            );
                            return true;
                          }}
                          onCancel={() => setDictionarySchedule(null)}
                        >
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
                            {SCHEDULE_ENTRIES.map(([schedule, labelKey]) => (
                              <option value={schedule} key={schedule}>
                                {t(labelKey)}
                              </option>
                            ))}
                          </select>
                        </DictionaryMenuForm>
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
            aria-live="polite"
            aria-atomic="true"
          >
            <span>{t(`settings.hoshidicts.backups.${backupOperation}`)}</span>
            {yomitanDictionaryImportProgress ? (
              <span className="hoshidicts-backups__progress">
                {yomitanDictionaryImportProgress}
                {yomitanReadingSummary ? ` ${yomitanReadingSummary}` : null}
              </span>
            ) : null}
            {yomitanReadingPercent !== null ? (
              <progress
                className="hoshidicts-backups__reading-meter"
                aria-label={t(
                  "settings.hoshidicts.backups.readingYomitanDictionaries"
                )}
                aria-valuetext={yomitanReadingSummary ?? undefined}
                max={100}
                value={yomitanReadingPercent}
              />
            ) : null}
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
  const setMiningValue = <K extends keyof MiningProfileDraft>(
    key: K,
    value: MiningProfileDraft[K]
  ) => updateMiningDraft((current) => ({ ...current, [key]: value }));

  return (
    <section className="hoshidicts-section hoshidicts-mining">
      <div className="hoshidicts-section__heading">
        <div>
          <h2>{t("settings.hoshidicts.mining.title")}</h2>
          <p>{t("settings.hoshidicts.mining.autoSaveHint")}</p>
        </div>
        <div className="hoshidicts-section__status-actions">
          <HoshidictsSaveIndicator status={miningSaveStatus} />
          <HoshidictsToggleSetting
            id="hoshidicts-mining-enabled"
            variant="inline"
            label={t("settings.hoshidicts.mining.enabled")}
            checked={miningDraft.enabled}
            disabled={miningBusy}
            onChange={(value) => setMiningValue("enabled", value)}
          />
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
        <label className="hoshidicts-setting">
          <span>{t("settings.hoshidicts.mining.deck")}</span>
          {miningOptions.connected ? (
            <select
              id="hoshidicts-mining-deck"
              value={miningDraft.deck}
              disabled={miningBusy}
              onChange={(event) => setMiningValue("deck", event.target.value)}
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
              onChange={(event) => setMiningValue("deck", event.target.value)}
            />
          )}
        </label>

        <label className="hoshidicts-setting">
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

        <label className="hoshidicts-setting">
          <span>{t("settings.hoshidicts.mining.tags")}</span>
          <input
            id="hoshidicts-mining-tags"
            type="text"
            value={miningDraft.tags}
            disabled={miningBusy}
            onChange={(event) => setMiningValue("tags", event.target.value)}
          />
        </label>
      </div>

      <fieldset className="hoshidicts-mining-duplicates">
        <legend>{t("settings.hoshidicts.mining.duplicateHandling")}</legend>
        <HoshidictsToggleSetting
          id="hoshidicts-mining-check-duplicates"
          variant="inline"
          label={t("settings.hoshidicts.mining.checkForDuplicates")}
          checked={miningDraft.checkForDuplicates}
          disabled={miningBusy}
          onChange={(value) => setMiningValue("checkForDuplicates", value)}
        />
        <p>{t("settings.hoshidicts.mining.duplicateCheckHint")}</p>

        <div className="hoshidicts-mining-duplicates__options">
          <HoshidictsSelectSetting
            id="hoshidicts-mining-duplicate-scope"
            label={t("settings.hoshidicts.mining.duplicateScope")}
            value={miningDraft.duplicateScope}
            disabled={miningBusy || !miningDraft.checkForDuplicates}
            options={DUPLICATE_SCOPES.map((scope) => ({
              value: scope.value,
              label: t(scope.labelKey)
            }))}
            onChange={(scope) =>
              setMiningValue(
                "duplicateScope",
                scope === "deck" || scope === "deck-root" ? scope : "collection"
              )
            }
          />

          <HoshidictsSelectSetting
            id="hoshidicts-mining-duplicate-behavior"
            label={t("settings.hoshidicts.mining.whenDuplicateDetected")}
            value={miningDraft.duplicateBehavior}
            disabled={miningBusy || !miningDraft.checkForDuplicates}
            options={DUPLICATE_BEHAVIORS.map((behavior) => ({
              value: behavior.value,
              label: t(behavior.labelKey)
            }))}
            onChange={(behavior) =>
              setMiningValue(
                "duplicateBehavior",
                behavior === "overwrite" || behavior === "new"
                  ? behavior
                  : "prevent"
              )
            }
          />
        </div>

        <HoshidictsToggleSetting
          id="hoshidicts-mining-check-all-note-types"
          variant="inline"
          label={t("settings.hoshidicts.mining.checkAllNoteTypes")}
          checked={miningDraft.duplicateScopeCheckAllModels}
          disabled={miningBusy || !miningDraft.checkForDuplicates}
          onChange={(value) =>
            setMiningValue("duplicateScopeCheckAllModels", value)
          }
        />
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
