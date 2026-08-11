import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  DEFAULT_HOSHIDICTS_CUSTOM_POPUP_CSS,
  DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
  DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
  HOSHIDICTS_THEME_GROUPS,
  MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
  MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
  MAX_HOSHIDICTS_CUSTOM_POPUP_CSS_LENGTH,
  MAX_HOSHIDICTS_POPUP_COLUMNS,
  MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_LABEL_LENGTH,
  MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_URL_LENGTH,
  MAX_HOSHIDICTS_POPUP_CUSTOM_LINKS,
  MAX_HOSHIDICTS_POPUP_HEIGHT_PX,
  MAX_HOSHIDICTS_POPUP_OPACITY_PERCENT,
  MAX_HOSHIDICTS_POPUP_WIDTH_PX,
  MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
  MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
  MIN_HOSHIDICTS_POPUP_COLUMNS,
  MIN_HOSHIDICTS_POPUP_HEIGHT_PX,
  MIN_HOSHIDICTS_POPUP_OPACITY_PERCENT,
  MIN_HOSHIDICTS_POPUP_WIDTH_PX,
  hoshidictsReaderPreferencesFromSnapshot,
  isHoshidictsPopupCustomLinkTemplate,
  type HoshidictsPopupToolbarPosition,
  type HoshidictsTheme
} from "../../../../shared/features/hoshidicts";
import { useTranslation } from "../../i18n";
import { HoshidictsPopupPreview } from "./HoshidictsPopupPreview";
import { HoshidictsSaveIndicator } from "./HoshidictsSaveIndicator";
import type { useHoshidictsSettingsController } from "./useHoshidictsSettingsController";

type Controller = ReturnType<typeof useHoshidictsSettingsController>;

const CUSTOM_POPUP_CSS_PLACEHOLDER = `:scope {
  --hoshidicts-popup-background: rgb(20 24 32 / 92%);
  border-radius: 16px;
}

.gsm-hoshidicts-expression {
  color: #ff7eb6;
}`;

const POPUP_BUTTON_CHOICES = [
  {
    id: "addToAnki",
    inputId: "hoshidicts-popup-button-add-to-anki",
    labelKey: "settings.hoshidicts.reader.popupButtons.addToAnki"
  },
  {
    id: "audio",
    inputId: "hoshidicts-popup-button-audio",
    labelKey: "settings.hoshidicts.reader.popupButtons.audio"
  },
  {
    id: "customDefinition",
    inputId: "hoshidicts-popup-button-custom-definition",
    labelKey: "settings.hoshidicts.reader.popupButtons.customDefinition"
  },
  {
    id: "viewInAnki",
    inputId: "hoshidicts-popup-button-view-in-anki",
    labelKey: "settings.hoshidicts.reader.popupButtons.viewInAnki"
  }
] as const;

function PopupButtonsControl({ controller }: { controller: Controller }) {
  const t = useTranslation();
  const {
    readerDraft,
    preferencesBusy,
    setPopupButtonEnabled,
    setPopupCustomLinks
  } = controller;
  const [editingLinkIndex, setEditingLinkIndex] = useState<number | null>(null);
  const [linkLabel, setLinkLabel] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkErrorKey, setLinkErrorKey] = useState<string | null>(null);

  const resetLinkForm = () => {
    setEditingLinkIndex(null);
    setLinkLabel("");
    setLinkUrl("");
    setLinkErrorKey(null);
  };

  return (
    <div className="hoshidicts-popup-buttons">
      <div className="hoshidicts-popup-buttons__heading">
        <strong>{t("settings.hoshidicts.reader.popupButtons.title")}</strong>
        <small>{t("settings.hoshidicts.reader.popupButtons.hint")}</small>
      </div>

      <div
        className="hoshidicts-popup-buttons__toggles"
        role="group"
        aria-label={t("settings.hoshidicts.reader.popupButtons.title")}
      >
        {POPUP_BUTTON_CHOICES.map((button) => (
          <label key={button.id}>
            <input
              id={button.inputId}
              type="checkbox"
              checked={readerDraft.popupButtons[button.id]}
              disabled={preferencesBusy}
              onChange={(event) =>
                setPopupButtonEnabled(button.id, event.currentTarget.checked)
              }
            />
            <span>{t(button.labelKey)}</span>
          </label>
        ))}
      </div>

      <div className="hoshidicts-popup-links">
        <div className="hoshidicts-popup-links__heading">
          <strong>
            {t("settings.hoshidicts.reader.popupButtons.customLinks")}
          </strong>
          <small>
            {t("settings.hoshidicts.reader.popupButtons.customLinksHint")}
          </small>
        </div>

        {readerDraft.popupButtons.customLinks.length > 0 ? (
          <div className="hoshidicts-popup-links__list">
            {readerDraft.popupButtons.customLinks.map((link, index) => (
              <div
                className="hoshidicts-popup-link"
                key={`${link.label}-${index}`}
              >
                <div>
                  <strong>{link.label}</strong>
                  <code>{link.url}</code>
                </div>
                <button
                  type="button"
                  className="secondary hoshidicts-icon-button"
                  aria-label={t(
                    "settings.hoshidicts.reader.popupButtons.editLink",
                    { name: link.label }
                  )}
                  disabled={preferencesBusy}
                  onClick={() => {
                    setEditingLinkIndex(index);
                    setLinkLabel(link.label);
                    setLinkUrl(link.url);
                    setLinkErrorKey(null);
                  }}
                >
                  <Pencil size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="danger hoshidicts-icon-button"
                  aria-label={t(
                    "settings.hoshidicts.reader.popupButtons.deleteLink",
                    { name: link.label }
                  )}
                  disabled={preferencesBusy}
                  onClick={() => {
                    setPopupCustomLinks(
                      readerDraft.popupButtons.customLinks.filter(
                        (_entry, linkIndex) => linkIndex !== index
                      )
                    );
                    if (editingLinkIndex !== null) resetLinkForm();
                  }}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <small className="hoshidicts-popup-links__empty">
            {t("settings.hoshidicts.reader.popupButtons.noCustomLinks")}
          </small>
        )}

        <form
          className="hoshidicts-popup-links__form"
          onSubmit={(event) => {
            event.preventDefault();
            const label = linkLabel.trim();
            const url = linkUrl.trim();
            if (!label) {
              setLinkErrorKey(
                "settings.hoshidicts.reader.popupButtons.labelRequired"
              );
              return;
            }
            if (!isHoshidictsPopupCustomLinkTemplate(url)) {
              setLinkErrorKey(
                "settings.hoshidicts.reader.popupButtons.invalidUrl"
              );
              return;
            }
            const customLinks = readerDraft.popupButtons.customLinks.map(
              (link) => ({ ...link })
            );
            if (editingLinkIndex === null) {
              customLinks.push({ label, url });
            } else {
              customLinks[editingLinkIndex] = { label, url };
            }
            setPopupCustomLinks(customLinks);
            resetLinkForm();
          }}
        >
          <label>
            <span>{t("settings.hoshidicts.reader.popupButtons.name")}</span>
            <input
              id="hoshidicts-popup-link-label"
              type="text"
              value={linkLabel}
              maxLength={MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_LABEL_LENGTH}
              placeholder={t(
                "settings.hoshidicts.reader.popupButtons.namePlaceholder"
              )}
              disabled={preferencesBusy}
              onChange={(event) => {
                setLinkLabel(event.currentTarget.value);
                setLinkErrorKey(null);
              }}
            />
          </label>
          <label>
            <span>{t("settings.hoshidicts.reader.popupButtons.url")}</span>
            <input
              id="hoshidicts-popup-link-url"
              type="url"
              value={linkUrl}
              maxLength={MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_URL_LENGTH}
              placeholder={t(
                "settings.hoshidicts.reader.popupButtons.urlPlaceholder"
              )}
              disabled={preferencesBusy}
              onChange={(event) => {
                setLinkUrl(event.currentTarget.value);
                setLinkErrorKey(null);
              }}
            />
          </label>
          <div className="hoshidicts-popup-links__actions">
            <button
              id="hoshidicts-popup-link-submit"
              type="submit"
              disabled={
                preferencesBusy ||
                (editingLinkIndex === null &&
                  readerDraft.popupButtons.customLinks.length >=
                    MAX_HOSHIDICTS_POPUP_CUSTOM_LINKS)
              }
            >
              {t(
                editingLinkIndex === null
                  ? "settings.hoshidicts.reader.popupButtons.addLink"
                  : "settings.hoshidicts.reader.popupButtons.saveLink"
              )}
            </button>
            {editingLinkIndex !== null ? (
              <button
                type="button"
                className="secondary"
                onClick={resetLinkForm}
              >
                {t("settings.hoshidicts.reader.popupButtons.cancel")}
              </button>
            ) : null}
          </div>
          {linkErrorKey ? (
            <small className="is-error" role="alert">
              {t(linkErrorKey)}
            </small>
          ) : null}
        </form>
      </div>
    </div>
  );
}

export function HoshidictsDesignPanel({
  controller
}: {
  controller: Controller;
}) {
  const t = useTranslation();
  const {
    state,
    readerDraft,
    readerSaveStatus,
    preferencesBusy,
    resetPopupSize,
    setCompactDefinitionSummaryDictionary,
    setCustomPopupCss,
    setDefinitionBlurEnabled,
    setDefinitionBlurLookupThreshold,
    setDefinitionBlurRevealDelayMs,
    setDefinitionBlurRevealMode,
    setAverageFrequency,
    setShowFrequencyDictionaryNames,
    setHidePopupGrammarTags,
    setPitchAccentFuriganaDictionary,
    setPopupColumns,
    setPopupHeightPx,
    setPopupOpacityPercent,
    setPopupToolbarPosition,
    setPopupWidthPx,
    setShowCompactDefinitionSummary,
    setShowLookupCounts,
    setShowPitchAccentBadge,
    setShowPitchAccentFurigana,
    setSourceHighlightEnabled,
    setTheme
  } = controller;
  if (!state) return null;

  const compactDefinitionDictionaries = state.dictionaries.filter(
    (dictionary) => dictionary.termCount > 0
  );
  const compactDefinitionDictionaryIsStale =
    readerDraft.compactDefinitionSummaryDictionary !== null &&
    !compactDefinitionDictionaries.some(
      (dictionary) =>
        dictionary.title === readerDraft.compactDefinitionSummaryDictionary
    );
  const pitchAccentDictionaries = state.dictionaries.filter(
    (dictionary) => dictionary.pitchCount > 0
  );
  const pitchAccentDictionaryIsStale =
    readerDraft.pitchAccentFuriganaDictionary !== null &&
    !pitchAccentDictionaries.some(
      (dictionary) =>
        dictionary.title === readerDraft.pitchAccentFuriganaDictionary
    );
  const previewPreferences = {
    ...hoshidictsReaderPreferencesFromSnapshot(state),
    ...readerDraft
  };

  return (
    <div className="hoshidicts-design">
      <section className="hoshidicts-design__controls">
        <div className="hoshidicts-section__heading hoshidicts-design__heading">
          <div>
            <h2>{t("settings.hoshidicts.design.title")}</h2>
            <p>{t("settings.hoshidicts.design.subtitle")}</p>
          </div>
          <div className="hoshidicts-design__heading-actions">
            <HoshidictsSaveIndicator status={readerSaveStatus} />
          </div>
        </div>

        <div className="hoshidicts-design-section">
          <div className="hoshidicts-design-section__heading">
            <strong>{t("settings.hoshidicts.design.sections.appearance")}</strong>
            <small>{t("settings.hoshidicts.reader.appearance.hint")}</small>
          </div>
          <div className="hoshidicts-reader-appearance__controls">
            <label>
              <span>{t("settings.hoshidicts.reader.appearance.theme")}</span>
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
              <span>{t("settings.hoshidicts.reader.appearance.opacity")}</span>
              <div className="hoshidicts-reader-appearance__number">
                <input
                  id="hoshidicts-popup-opacity"
                  type="number"
                  min={MIN_HOSHIDICTS_POPUP_OPACITY_PERCENT}
                  max={MAX_HOSHIDICTS_POPUP_OPACITY_PERCENT}
                  step={1}
                  value={readerDraft.popupOpacityPercent}
                  disabled={preferencesBusy}
                  onChange={(event) =>
                    setPopupOpacityPercent(event.currentTarget.valueAsNumber)
                  }
                />
                <span>{t("settings.hoshidicts.reader.appearance.percent")}</span>
              </div>
            </label>
            <label>
              <span>
                {t("settings.hoshidicts.reader.appearance.toolbarPosition")}
              </span>
              <select
                id="hoshidicts-popup-toolbar-position"
                value={readerDraft.popupToolbarPosition}
                disabled={preferencesBusy}
                onChange={(event) =>
                  setPopupToolbarPosition(
                    event.currentTarget.value as HoshidictsPopupToolbarPosition
                  )
                }
              >
                <option value="top">
                  {t("settings.hoshidicts.reader.appearance.toolbarPositionTop")}
                </option>
                <option value="bottom">
                  {t(
                    "settings.hoshidicts.reader.appearance.toolbarPositionBottom"
                  )}
                </option>
              </select>
            </label>
            <label>
              <span>{t("settings.hoshidicts.reader.appearance.width")}</span>
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
                <span>{t("settings.hoshidicts.reader.appearance.pixels")}</span>
              </div>
            </label>
            <label>
              <span>{t("settings.hoshidicts.reader.appearance.height")}</span>
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
                <span>{t("settings.hoshidicts.reader.appearance.pixels")}</span>
              </div>
            </label>
            <label>
              <span>{t("settings.hoshidicts.reader.appearance.columns")}</span>
              <input
                id="hoshidicts-popup-columns"
                type="number"
                min={MIN_HOSHIDICTS_POPUP_COLUMNS}
                max={MAX_HOSHIDICTS_POPUP_COLUMNS}
                step={1}
                value={readerDraft.popupColumns}
                disabled={preferencesBusy}
                onChange={(event) =>
                  setPopupColumns(event.currentTarget.valueAsNumber)
                }
              />
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

        <div className="hoshidicts-design-section">
          <div className="hoshidicts-design-section__heading">
            <strong>{t("settings.hoshidicts.design.sections.content")}</strong>
          </div>
          <label className="hoshidicts-reader-compact-summary">
            <input
              id="hoshidicts-show-compact-definition-summary"
              type="checkbox"
              checked={readerDraft.showCompactDefinitionSummary}
              disabled={preferencesBusy}
              onChange={(event) =>
                setShowCompactDefinitionSummary(event.currentTarget.checked)
              }
            />
            <span>
              <strong>
                {t(
                  "settings.hoshidicts.reader.appearance.compactDefinitionSummary"
                )}
              </strong>
              <small>
                {t(
                  "settings.hoshidicts.reader.appearance.compactDefinitionSummaryHint"
                )}
              </small>
            </span>
          </label>
          <label className="hoshidicts-reader-compact-summary-dictionary">
            <span>
              {t(
                "settings.hoshidicts.reader.appearance.compactDefinitionSummaryDictionary"
              )}
            </span>
            <select
              id="hoshidicts-compact-definition-summary-dictionary"
              value={readerDraft.compactDefinitionSummaryDictionary ?? ""}
              disabled={
                preferencesBusy || !readerDraft.showCompactDefinitionSummary
              }
              onChange={(event) =>
                setCompactDefinitionSummaryDictionary(
                  event.currentTarget.value || null
                )
              }
            >
              <option value="">
                {t(
                  "settings.hoshidicts.reader.appearance.compactDefinitionSummaryDictionaryAutomatic"
                )}
              </option>
              {compactDefinitionDictionaryIsStale ? (
                <option
                  value={readerDraft.compactDefinitionSummaryDictionary ?? ""}
                >
                  {t(
                    "settings.hoshidicts.reader.appearance.compactDefinitionSummaryDictionaryUnavailable",
                    {
                      dictionary:
                        readerDraft.compactDefinitionSummaryDictionary ?? ""
                    }
                  )}
                </option>
              ) : null}
              {compactDefinitionDictionaries.map((dictionary) => (
                <option key={dictionary.id} value={dictionary.title}>
                  {dictionary.title}
                </option>
              ))}
            </select>
            <small>
              {t(
                "settings.hoshidicts.reader.appearance.compactDefinitionSummaryDictionaryHint"
              )}
            </small>
          </label>
          <label className="hoshidicts-reader-pitch-accent">
            <input
              id="hoshidicts-show-pitch-accent-furigana"
              type="checkbox"
              checked={readerDraft.showPitchAccentFurigana}
              disabled={preferencesBusy}
              onChange={(event) =>
                setShowPitchAccentFurigana(event.currentTarget.checked)
              }
            />
            <span>
              <strong>
                {t(
                  "settings.hoshidicts.reader.appearance.pitchAccentFurigana"
                )}
              </strong>
              <small>
                {t(
                  "settings.hoshidicts.reader.appearance.pitchAccentFuriganaHint"
                )}
              </small>
            </span>
          </label>
          <label className="hoshidicts-reader-pitch-accent-dictionary">
            <span>
              {t(
                "settings.hoshidicts.reader.appearance.pitchAccentFuriganaDictionary"
              )}
            </span>
            <select
              id="hoshidicts-pitch-accent-furigana-dictionary"
              value={readerDraft.pitchAccentFuriganaDictionary ?? ""}
              disabled={
                preferencesBusy || !readerDraft.showPitchAccentFurigana
              }
              onChange={(event) =>
                setPitchAccentFuriganaDictionary(
                  event.currentTarget.value || null
                )
              }
            >
              <option value="">
                {t(
                  "settings.hoshidicts.reader.appearance.pitchAccentFuriganaDictionaryAutomatic"
                )}
              </option>
              {pitchAccentDictionaryIsStale ? (
                <option value={readerDraft.pitchAccentFuriganaDictionary ?? ""}>
                  {t(
                    "settings.hoshidicts.reader.appearance.pitchAccentFuriganaDictionaryUnavailable",
                    {
                      dictionary:
                        readerDraft.pitchAccentFuriganaDictionary ?? ""
                    }
                  )}
                </option>
              ) : null}
              {pitchAccentDictionaries.map((dictionary) => (
                <option key={dictionary.id} value={dictionary.title}>
                  {dictionary.title}
                </option>
              ))}
            </select>
            <small>
              {t(
                "settings.hoshidicts.reader.appearance.pitchAccentFuriganaDictionaryHint"
              )}
            </small>
          </label>
          <label className="hoshidicts-reader-pitch-badge">
            <input
              id="hoshidicts-show-pitch-accent-badge"
              type="checkbox"
              checked={readerDraft.showPitchAccentBadge}
              disabled={preferencesBusy}
              onChange={(event) =>
                setShowPitchAccentBadge(event.currentTarget.checked)
              }
            />
            <span>
              <strong>
                {t(
                  "settings.hoshidicts.reader.appearance.pitchAccentBadge"
                )}
              </strong>
              <small>
                {t(
                  "settings.hoshidicts.reader.appearance.pitchAccentBadgeHint"
                )}
              </small>
            </span>
          </label>
          <label className="hoshidicts-reader-popup-metadata">
            <input
              id="hoshidicts-average-frequency"
              type="checkbox"
              checked={readerDraft.averageFrequency}
              disabled={preferencesBusy}
              onChange={(event) =>
                setAverageFrequency(event.currentTarget.checked)
              }
            />
            <span>
              <strong>
                {t(
                  "settings.hoshidicts.reader.appearance.averageFrequency"
                )}
              </strong>
              <small>
                {t(
                  "settings.hoshidicts.reader.appearance.averageFrequencyHint"
                )}
              </small>
            </span>
          </label>
          <label className="hoshidicts-reader-popup-metadata">
            <input
              id="hoshidicts-show-frequency-dictionary-names"
              type="checkbox"
              checked={readerDraft.showFrequencyDictionaryNames}
              disabled={preferencesBusy}
              onChange={(event) =>
                setShowFrequencyDictionaryNames(event.currentTarget.checked)
              }
            />
            <span>
              <strong>
                {t(
                  "settings.hoshidicts.reader.appearance.showFrequencyDictionaryNames"
                )}
              </strong>
              <small>
                {t(
                  "settings.hoshidicts.reader.appearance.showFrequencyDictionaryNamesHint"
                )}
              </small>
            </span>
          </label>
          <label className="hoshidicts-reader-popup-metadata">
            <input
              id="hoshidicts-hide-popup-grammar-tags"
              type="checkbox"
              checked={readerDraft.hidePopupGrammarTags}
              disabled={preferencesBusy}
              onChange={(event) =>
                setHidePopupGrammarTags(event.currentTarget.checked)
              }
            />
            <span>
              <strong>
                {t(
                  "settings.hoshidicts.reader.appearance.hidePopupGrammarTags"
                )}
              </strong>
              <small>
                {t(
                  "settings.hoshidicts.reader.appearance.hidePopupGrammarTagsHint"
                )}
              </small>
            </span>
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
        </div>

        <div className="hoshidicts-design-section">
          <div className="hoshidicts-design-section__heading">
            <strong>{t("settings.hoshidicts.design.sections.actions")}</strong>
          </div>
          <PopupButtonsControl controller={controller} />
        </div>

        <div className="hoshidicts-design-section">
          <div className="hoshidicts-design-section__heading">
            <strong>{t("settings.hoshidicts.design.sections.definitions")}</strong>
          </div>
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
        </div>

        <div className="hoshidicts-design-section">
          <div className="hoshidicts-design-section__heading">
            <strong>{t("settings.hoshidicts.design.sections.gameText")}</strong>
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
        </div>

        <div className="hoshidicts-design-section hoshidicts-custom-css">
          <div className="hoshidicts-design-section__heading">
            <strong>{t("settings.hoshidicts.design.sections.customCss")}</strong>
            <small>{t("settings.hoshidicts.design.customCss.hint")}</small>
          </div>
          <label htmlFor="hoshidicts-custom-popup-css">
            {t("settings.hoshidicts.design.customCss.label")}
          </label>
          <textarea
            id="hoshidicts-custom-popup-css"
            value={readerDraft.customPopupCss}
            placeholder={CUSTOM_POPUP_CSS_PLACEHOLDER}
            maxLength={MAX_HOSHIDICTS_CUSTOM_POPUP_CSS_LENGTH}
            rows={12}
            spellCheck={false}
            disabled={preferencesBusy}
            aria-describedby="hoshidicts-custom-popup-css-count hoshidicts-custom-popup-css-scope-hint"
            onChange={(event) => setCustomPopupCss(event.currentTarget.value)}
          />
          <div className="hoshidicts-custom-css__footer">
            <small id="hoshidicts-custom-popup-css-count">
              {t("settings.hoshidicts.design.customCss.characterCount", {
                count: readerDraft.customPopupCss.length,
                limit: MAX_HOSHIDICTS_CUSTOM_POPUP_CSS_LENGTH
              })}
            </small>
            <button
              id="hoshidicts-custom-popup-css-reset"
              type="button"
              className="secondary"
              disabled={
                preferencesBusy ||
                readerDraft.customPopupCss ===
                  DEFAULT_HOSHIDICTS_CUSTOM_POPUP_CSS
              }
              onClick={() =>
                setCustomPopupCss(DEFAULT_HOSHIDICTS_CUSTOM_POPUP_CSS)
              }
            >
              {t("settings.hoshidicts.design.customCss.reset")}
            </button>
          </div>
          <small
            id="hoshidicts-custom-popup-css-scope-hint"
            className="hoshidicts-custom-css__scope-hint"
          >
            {t("settings.hoshidicts.design.customCss.scopeHint")}
          </small>
        </div>
      </section>

      <aside
        className="hoshidicts-design__preview"
        aria-label={t("settings.hoshidicts.design.preview.title")}
      >
        <HoshidictsPopupPreview preferences={previewPreferences} />
      </aside>
    </div>
  );
}
