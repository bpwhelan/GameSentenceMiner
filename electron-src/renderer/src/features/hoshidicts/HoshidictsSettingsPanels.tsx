import {
  ArrowDown,
  ArrowUp,
  Eraser,
  FileArchive,
  Keyboard,
  RefreshCw,
  Save,
  Trash2
} from "lucide-react";
import {
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";

import {
  DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
  DEFAULT_HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS,
  MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
  type HoshidictsActivationKey,
  type HoshidictsSchedule
} from "../../../../shared/features/hoshidicts";
import { useTranslation } from "../../i18n";
import {
  AUTO_FIELD_VALUE,
  DISABLED_FIELD_VALUE,
  MINING_FIELDS,
  RECOMMENDED_KEYS,
  activationKeyFromKeyboardCode,
  automaticFieldTarget,
  frequencyModeKey,
  formatTimestamp,
  getFieldChoice,
  resolvedDraftField,
  summarizeCustomDictionaryText
} from "./hoshidictsSettingsModel";
import { HoshidictsSaveIndicator } from "./HoshidictsSaveIndicator";
import type { useHoshidictsSettingsController } from "./useHoshidictsSettingsController";

type Controller = ReturnType<typeof useHoshidictsSettingsController>;

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
    setPopupContentScanningEnabled,
    setPopupNestingMaxDepth,
    dictionaryBusy,
    preferencesBusy,
    actions
  } = controller;
  if (!state) return null;

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
        </div>
        <div className="hoshidicts-recommended-list">
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
                      title: dictionary.title
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
                  <strong>{dictionary.title}</strong>
                  <div className="hoshidicts-dictionary-meta">
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
                  <button
                    type="button"
                    className="hoshidicts-icon-button secondary"
                    title={t("settings.hoshidicts.moveUp")}
                    aria-label={t("settings.hoshidicts.moveUp")}
                    disabled={dictionaryBusy || index === 0}
                    onClick={() =>
                      void actions.moveDictionary(dictionary.id, -1)
                    }
                  >
                    <ArrowUp size={17} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="hoshidicts-icon-button secondary"
                    title={t("settings.hoshidicts.moveDown")}
                    aria-label={t("settings.hoshidicts.moveDown")}
                    disabled={
                      dictionaryBusy || index === state.dictionaries.length - 1
                    }
                    onClick={() =>
                      void actions.moveDictionary(dictionary.id, 1)
                    }
                  >
                    <ArrowDown size={17} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="hoshidicts-icon-button danger"
                    title={t("settings.hoshidicts.remove")}
                    aria-label={t("settings.hoshidicts.remove")}
                    disabled={dictionaryBusy}
                    onClick={() => void actions.removeDictionary(dictionary.id)}
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

  const mappedCount = useMemo(
    () =>
      MINING_FIELDS.filter(({ id }) =>
        Boolean(resolvedDraftField(miningDraft, miningOptions, id))
      ).length,
    [miningDraft, miningOptions]
  );
  const mappingWarnings = useMemo(() => {
    const missingOverrides = MINING_FIELDS.filter(
      ({ id }) =>
        miningDraft.fields[id] &&
        miningOptions.connected &&
        !miningOptions.fields.includes(miningDraft.fields[id])
    ).map(({ labelKey }) => t(labelKey));
    return { backend: miningOptions.warnings, missingOverrides };
  }, [miningDraft.fields, miningOptions, t]);

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

        <label>
          <span>{t("settings.hoshidicts.mining.duplicates")}</span>
          <select
            id="hoshidicts-mining-duplicates"
            value={miningDraft.duplicatePolicy}
            disabled={miningBusy}
            onChange={(event) =>
              updateMiningDraft((current) => ({
                ...current,
                duplicatePolicy:
                  event.target.value === "allow" ? "allow" : "prevent"
              }))
            }
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

      <details className="hoshidicts-mining-fields" open>
        <summary>{t("settings.hoshidicts.mining.fieldMappings")}</summary>
        <div className="hoshidicts-mining-fields__summary" role="status">
          <span>
            {t("settings.hoshidicts.mining.mappingCount", {
              mapped: mappedCount,
              total: MINING_FIELDS.length
            })}
          </span>
          <span>{t("settings.hoshidicts.mining.mappingHint")}</span>
        </div>
        <div className="hoshidicts-mining-grid">
          {MINING_FIELDS.map((field) => {
            const target = automaticFieldTarget(miningOptions, field.id);
            const choice = getFieldChoice(miningDraft, field.id);
            const explicitValue = miningDraft.fields[field.id];
            return (
              <label key={field.id}>
                <span>{t(field.labelKey)}</span>
                <select
                  id={`hoshidicts-mining-field-${field.id}`}
                  value={choice}
                  disabled={miningBusy}
                  onChange={(event) =>
                    setMiningField(field.id, event.target.value)
                  }
                >
                  <option value={AUTO_FIELD_VALUE}>
                    {target
                      ? t("settings.hoshidicts.mining.automaticField", {
                          name: target
                        })
                      : t("settings.hoshidicts.mining.automaticUnmapped")}
                  </option>
                  <option value={DISABLED_FIELD_VALUE}>
                    {t("settings.hoshidicts.mining.noField")}
                  </option>
                  {explicitValue &&
                  !miningOptions.fields.includes(explicitValue) ? (
                    <option value={explicitValue}>
                      {t("settings.hoshidicts.mining.missingOption", {
                        name: explicitValue
                      })}
                    </option>
                  ) : null}
                  {miningOptions.fields.map((modelField) => (
                    <option value={modelField} key={modelField}>
                      {modelField}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>

        {mappingWarnings.backend.map((warning) => (
          <p className="hoshidicts-mining-fields__warning" key={warning}>
            {t("settings.hoshidicts.mining.mappingWarning", {
              message: warning
            })}
          </p>
        ))}
        {mappingWarnings.missingOverrides.length > 0 ? (
          <p className="hoshidicts-mining-fields__warning">
            {t("settings.hoshidicts.mining.missingMappings", {
              fields: mappingWarnings.missingOverrides.join(", ")
            })}
          </p>
        ) : null}
      </details>
    </section>
  );
}
