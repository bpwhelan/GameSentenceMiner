import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  EllipsisVertical,
  Eraser,
  FileArchive,
  FileJson,
  Keyboard,
  RefreshCw,
  Save,
  Star,
  Trash2
} from "lucide-react";
import {
  Fragment,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";

import {
  DEFAULT_HOSHIDICTS_ACTIVATION_KEY,
  DEFAULT_HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS,
  MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
  MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
  MAX_HOSHIDICTS_POPUP_HIDE_DELAY_MS,
  MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
  MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
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
    setShowLookupCounts,
    setDefinitionBlurEnabled,
    setDefinitionBlurLookupThreshold,
    setDefinitionBlurRevealMode,
    setDefinitionBlurRevealDelayMs,
    setPopupContentScanningEnabled,
    setPopupNestingMaxDepth,
    dictionaryBusy,
    preferencesBusy,
    actions
  } = controller;
  const [positionMove, setPositionMove] = useState<{
    id: string;
    value: string;
  } | null>(null);
  const [recommendedExpandedOverride, setRecommendedExpandedOverride] =
    useState<boolean | null>(null);
  if (!state) return null;

  const recommendedExpanded =
    recommendedExpandedOverride ?? state.dictionaries.length === 0;
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
          {state.busy && state.progress.phase === "importing" ? (
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
                          { title: dictionary.title }
                        )}
                        title={t(
                          dictionary.favorite
                            ? "settings.hoshidicts.dictionaryPresentation.removeFavorite"
                            : "settings.hoshidicts.dictionaryPresentation.addFavorite",
                          { title: dictionary.title }
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
                    <strong>{dictionary.title}</strong>
                  </div>
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
                  <details className="hoshidicts-dictionary-menu">
                    <summary
                      className="hoshidicts-icon-button secondary"
                      title={t("settings.hoshidicts.dictionaryActions.menu", {
                        title: dictionary.title
                      })}
                      aria-label={t(
                        "settings.hoshidicts.dictionaryActions.menu",
                        { title: dictionary.title }
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
                      {positionMove?.id === dictionary.id ? (
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
                            onClick={() =>
                              setPositionMove({
                                id: dictionary.id,
                                value: String(index + 1)
                              })
                            }
                          >
                            {t(
                              "settings.hoshidicts.dictionaryActions.moveToPosition"
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
            onClick={() => void actions.importYomitanDictionaries()}
            disabled={dictionaryBusy}
          >
            <FileArchive size={17} aria-hidden="true" />
            {t("settings.hoshidicts.backups.importDictionaries")}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => void actions.importYomitanSettings()}
            disabled={dictionaryBusy}
          >
            <FileJson size={17} aria-hidden="true" />
            {t("settings.hoshidicts.backups.importSettings")}
          </button>
        </div>
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
        <div className="hoshidicts-mining-field-grid">
          <span className="hoshidicts-mining-field-grid__header">
            {t("settings.hoshidicts.mining.mappingFieldHeader")}
          </span>
          <span className="hoshidicts-mining-field-grid__header">
            {t("settings.hoshidicts.mining.mappingValueHeader")}
          </span>
          {MINING_FIELDS.map((field) => {
            const target = automaticFieldTarget(miningOptions, field.id);
            const choice = getFieldChoice(miningDraft, field.id);
            const explicitValue = miningDraft.fields[field.id];
            const selectId = `hoshidicts-mining-field-${field.id}`;
            return (
              <Fragment key={field.id}>
                <label htmlFor={selectId}>{t(field.labelKey)}</label>
                <select
                  id={selectId}
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
              </Fragment>
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
