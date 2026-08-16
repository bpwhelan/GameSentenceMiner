import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  DEFAULT_HOSHIDICTS_CUSTOM_POPUP_CSS,
  DEFAULT_HOSHIDICTS_POPUP_HEIGHT_PX,
  DEFAULT_HOSHIDICTS_POPUP_WIDTH_PX,
  HOSHIDICTS_THEME_GROUPS,
  MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
  MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
  MAX_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT,
  MAX_HOSHIDICTS_CUSTOM_POPUP_CSS_LENGTH,
  MAX_HOSHIDICTS_POPUP_COLUMNS,
  MAX_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX,
  MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_LABEL_LENGTH,
  MAX_HOSHIDICTS_POPUP_CUSTOM_LINK_URL_LENGTH,
  MAX_HOSHIDICTS_POPUP_CUSTOM_LINKS,
  MAX_HOSHIDICTS_POPUP_HEIGHT_PX,
  MAX_HOSHIDICTS_POPUP_OPACITY_PERCENT,
  MAX_HOSHIDICTS_POPUP_WIDTH_PX,
  MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
  MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
  MIN_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT,
  MIN_HOSHIDICTS_POPUP_COLUMNS,
  MIN_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX,
  MIN_HOSHIDICTS_POPUP_HEIGHT_PX,
  MIN_HOSHIDICTS_POPUP_OPACITY_PERCENT,
  MIN_HOSHIDICTS_POPUP_WIDTH_PX,
  hoshidictsReaderPreferencesFromSnapshot,
  isHoshidictsPopupCustomLinkTemplate,
  type HoshidictsPopupToolbarPosition,
  type HoshidictsTheme
} from "../../../../shared/features/hoshidicts";
import { useTranslation } from "../../i18n";
import { HoshidictsDictionarySelect } from "./components/HoshidictsDictionarySelect";
import { HoshidictsNumberSetting } from "./components/HoshidictsNumberSetting";
import { HoshidictsPopupImageSourceSelect } from "./components/HoshidictsPopupImageSourceSelect";
import { HoshidictsSelectSetting } from "./components/HoshidictsSelectSetting";
import { HoshidictsToggleSetting } from "./components/HoshidictsToggleSetting";
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

const APPEARANCE_NUMBERS = [
  {
    id: "hoshidicts-popup-opacity",
    key: "popupOpacityPercent",
    labelKey: "settings.hoshidicts.reader.appearance.opacity",
    unitKey: "settings.hoshidicts.reader.appearance.percent",
    min: MIN_HOSHIDICTS_POPUP_OPACITY_PERCENT,
    max: MAX_HOSHIDICTS_POPUP_OPACITY_PERCENT,
    step: 1
  },
  {
    id: "hoshidicts-popup-backdrop-blur",
    key: "popupBackdropBlurPx",
    labelKey: "settings.hoshidicts.reader.appearance.backdropBlur",
    unitKey: "settings.hoshidicts.reader.appearance.pixels",
    min: MIN_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX,
    max: MAX_HOSHIDICTS_POPUP_BACKDROP_BLUR_PX,
    step: 1
  },
  {
    id: "hoshidicts-popup-width",
    key: "popupWidthPx",
    labelKey: "settings.hoshidicts.reader.appearance.width",
    unitKey: "settings.hoshidicts.reader.appearance.pixels",
    min: MIN_HOSHIDICTS_POPUP_WIDTH_PX,
    max: MAX_HOSHIDICTS_POPUP_WIDTH_PX,
    step: 10
  },
  {
    id: "hoshidicts-popup-height",
    key: "popupHeightPx",
    labelKey: "settings.hoshidicts.reader.appearance.height",
    unitKey: "settings.hoshidicts.reader.appearance.pixels",
    min: MIN_HOSHIDICTS_POPUP_HEIGHT_PX,
    max: MAX_HOSHIDICTS_POPUP_HEIGHT_PX,
    step: 10
  },
  {
    id: "hoshidicts-popup-columns",
    key: "popupColumns",
    labelKey: "settings.hoshidicts.reader.appearance.columns",
    unitKey: null,
    min: MIN_HOSHIDICTS_POPUP_COLUMNS,
    max: MAX_HOSHIDICTS_POPUP_COLUMNS,
    step: 1
  }
] as const;

const CONTENT_TOGGLES = [
  {
    id: "hoshidicts-show-pitch-accent-badge",
    key: "showPitchAccentBadge",
    labelKey: "settings.hoshidicts.reader.appearance.pitchAccentBadge"
  },
  {
    id: "hoshidicts-average-frequency",
    key: "averageFrequency",
    labelKey: "settings.hoshidicts.reader.appearance.averageFrequency"
  },
  {
    id: "hoshidicts-show-frequency-dictionary-names",
    key: "showFrequencyDictionaryNames",
    labelKey:
      "settings.hoshidicts.reader.appearance.showFrequencyDictionaryNames"
  },
  {
    id: "hoshidicts-hide-popup-grammar-tags",
    key: "hidePopupGrammarTags",
    labelKey: "settings.hoshidicts.reader.appearance.hidePopupGrammarTags"
  },
  {
    id: "hoshidicts-show-lookup-counts",
    key: "showLookupCounts",
    labelKey: "settings.hoshidicts.reader.showLookupCounts"
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
          <HoshidictsToggleSetting
            key={button.id}
            id={button.inputId}
            variant="inline"
            label={t(button.labelKey)}
            checked={readerDraft.popupButtons[button.id]}
            disabled={preferencesBusy}
            onChange={(enabled) => setPopupButtonEnabled(button.id, enabled)}
          />
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
          <label className="hoshidicts-setting">
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
          <label className="hoshidicts-setting">
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
    setBoundedDefinitionBlurInteger,
    setBoundedReaderInteger,
    setCustomPopupCss,
    setDefinitionBlurPreference,
    setReaderPreference
  } = controller;
  if (!state) return null;

  const previewPreferences = {
    ...hoshidictsReaderPreferencesFromSnapshot(state),
    ...readerDraft
  };

  // Only dictionaries that already ship images can drive the popup image
  // source, and only tab groups that contain at least one such dictionary.
  const imageDictionaries = state.dictionaries.filter(
    (dictionary) => dictionary.enabled && dictionary.mediaCount > 0
  );
  const imageDictionaryIds = new Set(
    imageDictionaries.map((dictionary) => dictionary.id)
  );
  const imageTabGroups = state.tabGroups.filter((group) =>
    group.dictionaryIds.some((id) => imageDictionaryIds.has(id))
  );

  // The appearance numbers are rendered in two runs, either side of the
  // toolbar-position select.
  const renderAppearanceNumber = (
    setting: (typeof APPEARANCE_NUMBERS)[number]
  ) => (
    <HoshidictsNumberSetting
      key={setting.id}
      id={setting.id}
      label={t(setting.labelKey)}
      unit={setting.unitKey ? t(setting.unitKey) : undefined}
      min={setting.min}
      max={setting.max}
      step={setting.step}
      value={readerDraft[setting.key]}
      disabled={preferencesBusy}
      onChange={(value) =>
        setBoundedReaderInteger(setting.key, value, setting.min, setting.max)
      }
    />
  );

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
            <HoshidictsSelectSetting
              id="hoshidicts-popup-theme"
              label={t("settings.hoshidicts.reader.appearance.theme")}
              value={readerDraft.theme}
              disabled={preferencesBusy}
              onChange={(theme) =>
                setReaderPreference("theme", theme as HoshidictsTheme)
              }
            >
              {HOSHIDICTS_THEME_GROUPS.map((group) => (
                <optgroup key={group.id} label={t(group.labelKey)}>
                  {group.themes.map((theme) => (
                    <option key={theme.id} value={theme.id}>
                      {theme.labelKey ? t(theme.labelKey) : theme.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </HoshidictsSelectSetting>
            {APPEARANCE_NUMBERS.slice(0, 2).map(renderAppearanceNumber)}
            <HoshidictsSelectSetting
              id="hoshidicts-popup-toolbar-position"
              label={t("settings.hoshidicts.reader.appearance.toolbarPosition")}
              value={readerDraft.popupToolbarPosition}
              disabled={preferencesBusy}
              options={[
                {
                  value: "auto",
                  label: t(
                    "settings.hoshidicts.reader.appearance.toolbarPositionAuto"
                  )
                },
                {
                  value: "top",
                  label: t(
                    "settings.hoshidicts.reader.appearance.toolbarPositionTop"
                  )
                },
                {
                  value: "bottom",
                  label: t(
                    "settings.hoshidicts.reader.appearance.toolbarPositionBottom"
                  )
                }
              ]}
              onChange={(position) =>
                setReaderPreference(
                  "popupToolbarPosition",
                  position as HoshidictsPopupToolbarPosition
                )
              }
            />
            {APPEARANCE_NUMBERS.slice(2).map(renderAppearanceNumber)}
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
          <HoshidictsToggleSetting
            id="hoshidicts-show-compact-definition-summary"
            className="hoshidicts-toggle--divided"
            label={t(
              "settings.hoshidicts.reader.appearance.compactDefinitionSummary"
            )}
            hint={t(
              "settings.hoshidicts.reader.appearance.compactDefinitionSummaryHint"
            )}
            checked={readerDraft.showCompactDefinitionSummary}
            disabled={preferencesBusy}
            onChange={(value) =>
              setReaderPreference("showCompactDefinitionSummary", value)
            }
          />
          <HoshidictsNumberSetting
            id="hoshidicts-compact-definition-summary-count"
            className="hoshidicts-setting--split"
            label={t(
              "settings.hoshidicts.reader.appearance.compactDefinitionSummaryCount"
            )}
            min={MIN_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT}
            max={MAX_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT}
            value={readerDraft.compactDefinitionSummaryCount}
            disabled={
              preferencesBusy || !readerDraft.showCompactDefinitionSummary
            }
            onChange={(value) =>
              setBoundedReaderInteger(
                "compactDefinitionSummaryCount",
                value,
                MIN_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT,
                MAX_HOSHIDICTS_COMPACT_DEFINITION_SUMMARY_COUNT
              )
            }
          />
          <HoshidictsDictionarySelect
            id="hoshidicts-compact-definition-summary-dictionary"
            className="hoshidicts-setting--split"
            label={t(
              "settings.hoshidicts.reader.appearance.compactDefinitionSummaryDictionary"
            )}
            hint={t(
              "settings.hoshidicts.reader.appearance.compactDefinitionSummaryDictionaryHint"
            )}
            automaticLabel={t(
              "settings.hoshidicts.reader.appearance.compactDefinitionSummaryDictionaryAutomatic"
            )}
            unavailableLabel={t(
              "settings.hoshidicts.reader.appearance.compactDefinitionSummaryDictionaryUnavailable",
              { dictionary: readerDraft.compactDefinitionSummaryDictionary ?? "" }
            )}
            value={readerDraft.compactDefinitionSummaryDictionary}
            dictionaries={state.dictionaries.filter(
              (dictionary) => dictionary.termCount > 0
            )}
            disabled={
              preferencesBusy || !readerDraft.showCompactDefinitionSummary
            }
            onChange={(value) =>
              setReaderPreference("compactDefinitionSummaryDictionary", value)
            }
          />
          <HoshidictsDictionarySelect
            id="hoshidicts-kanji-click-dictionary"
            className="hoshidicts-setting--split"
            label={t(
              "settings.hoshidicts.reader.appearance.kanjiClickDictionary"
            )}
            hint={t(
              "settings.hoshidicts.reader.appearance.kanjiClickDictionaryHint"
            )}
            automaticLabel={t(
              "settings.hoshidicts.reader.appearance.kanjiClickDictionaryAutomatic"
            )}
            unavailableLabel={t(
              "settings.hoshidicts.reader.appearance.kanjiClickDictionaryUnavailable",
              { dictionary: readerDraft.kanjiClickDictionary ?? "" }
            )}
            value={readerDraft.kanjiClickDictionary}
            dictionaries={state.dictionaries}
            disabled={preferencesBusy}
            onChange={(value) =>
              setReaderPreference("kanjiClickDictionary", value)
            }
          />
          <HoshidictsPopupImageSourceSelect
            id="hoshidicts-popup-image-source"
            className="hoshidicts-setting--split"
            label={t(
              "settings.hoshidicts.reader.appearance.popupImageSource"
            )}
            hint={t(
              "settings.hoshidicts.reader.appearance.popupImageSourceHint"
            )}
            automaticLabel={t(
              "settings.hoshidicts.reader.appearance.popupImageSourceAutomatic"
            )}
            missingDictionaryLabel={t(
              "settings.hoshidicts.reader.appearance.popupImageSourceDictionaryUnavailable",
              {
                dictionary:
                  readerDraft.popupImageSource?.kind === "dictionary"
                    ? readerDraft.popupImageSource.title
                    : ""
              }
            )}
            missingTabGroupLabel={t(
              "settings.hoshidicts.reader.appearance.popupImageSourceTabGroupUnavailable"
            )}
            value={readerDraft.popupImageSource}
            dictionaries={imageDictionaries}
            tabGroups={imageTabGroups}
            disabled={preferencesBusy}
            onChange={(value) => setReaderPreference("popupImageSource", value)}
          />
          <HoshidictsToggleSetting
            id="hoshidicts-show-pitch-accent-furigana"
            className="hoshidicts-toggle--divided"
            label={t("settings.hoshidicts.reader.appearance.pitchAccentFurigana")}
            hint={t(
              "settings.hoshidicts.reader.appearance.pitchAccentFuriganaHint"
            )}
            checked={readerDraft.showPitchAccentFurigana}
            disabled={preferencesBusy}
            onChange={(value) =>
              setReaderPreference("showPitchAccentFurigana", value)
            }
          />
          <HoshidictsDictionarySelect
            id="hoshidicts-pitch-accent-furigana-dictionary"
            className="hoshidicts-setting--split"
            label={t(
              "settings.hoshidicts.reader.appearance.pitchAccentFuriganaDictionary"
            )}
            hint={t(
              "settings.hoshidicts.reader.appearance.pitchAccentFuriganaDictionaryHint"
            )}
            automaticLabel={t(
              "settings.hoshidicts.reader.appearance.pitchAccentFuriganaDictionaryAutomatic"
            )}
            unavailableLabel={t(
              "settings.hoshidicts.reader.appearance.pitchAccentFuriganaDictionaryUnavailable",
              { dictionary: readerDraft.pitchAccentFuriganaDictionary ?? "" }
            )}
            value={readerDraft.pitchAccentFuriganaDictionary}
            dictionaries={state.dictionaries.filter(
              (dictionary) => dictionary.pitchCount > 0
            )}
            disabled={preferencesBusy || !readerDraft.showPitchAccentFurigana}
            onChange={(value) =>
              setReaderPreference("pitchAccentFuriganaDictionary", value)
            }
          />
          {CONTENT_TOGGLES.map((toggle) => (
            <HoshidictsToggleSetting
              key={toggle.id}
              id={toggle.id}
              className="hoshidicts-toggle--divided"
              label={t(toggle.labelKey)}
              hint={t(`${toggle.labelKey}Hint`)}
              checked={readerDraft[toggle.key]}
              disabled={preferencesBusy}
              onChange={(value) => setReaderPreference(toggle.key, value)}
            />
          ))}
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
            <HoshidictsToggleSetting
              id="hoshidicts-definition-blur-enabled"
              label={t("settings.hoshidicts.reader.definitionBlur.title")}
              hint={t("settings.hoshidicts.reader.definitionBlur.hint")}
              checked={readerDraft.definitionBlur.enabled}
              disabled={preferencesBusy}
              onChange={(value) => setDefinitionBlurPreference("enabled", value)}
            />

            <div className="hoshidicts-definition-blur__controls">
              <HoshidictsNumberSetting
                id="hoshidicts-definition-blur-threshold"
                label={t("settings.hoshidicts.reader.definitionBlur.threshold")}
                unit={t("settings.hoshidicts.reader.definitionBlur.lookups")}
                min={MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD}
                max={MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD}
                value={readerDraft.definitionBlur.lookupThreshold}
                disabled={preferencesBusy}
                onChange={(value) =>
                  setBoundedDefinitionBlurInteger(
                    "lookupThreshold",
                    value,
                    MIN_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD,
                    MAX_HOSHIDICTS_DEFINITION_BLUR_LOOKUP_THRESHOLD
                  )
                }
              />

              <HoshidictsSelectSetting
                id="hoshidicts-definition-blur-reveal-mode"
                label={t("settings.hoshidicts.reader.definitionBlur.reveal")}
                value={readerDraft.definitionBlur.revealMode}
                disabled={preferencesBusy}
                options={[
                  {
                    value: "timed",
                    label: t("settings.hoshidicts.reader.definitionBlur.timed")
                  },
                  {
                    value: "hover",
                    label: t("settings.hoshidicts.reader.definitionBlur.hover")
                  }
                ]}
                onChange={(mode) =>
                  setDefinitionBlurPreference(
                    "revealMode",
                    mode === "hover" ? "hover" : "timed"
                  )
                }
              />

              {readerDraft.definitionBlur.revealMode === "timed" ? (
                <HoshidictsNumberSetting
                  id="hoshidicts-definition-blur-reveal-delay"
                  label={t("settings.hoshidicts.reader.definitionBlur.delay")}
                  hint={t("settings.hoshidicts.reader.definitionBlur.delayHint")}
                  unit={t("settings.hoshidicts.reader.definitionBlur.seconds")}
                  min={MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS / 1000}
                  max={MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS / 1000}
                  value={readerDraft.definitionBlur.revealDelayMs / 1000}
                  disabled={preferencesBusy}
                  onChange={(value) =>
                    setBoundedDefinitionBlurInteger(
                      "revealDelayMs",
                      value * 1000,
                      MIN_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS,
                      MAX_HOSHIDICTS_DEFINITION_BLUR_REVEAL_DELAY_MS
                    )
                  }
                />
              ) : null}
            </div>
          </div>
        </div>

        <div className="hoshidicts-design-section">
          <div className="hoshidicts-design-section__heading">
            <strong>{t("settings.hoshidicts.design.sections.gameText")}</strong>
          </div>
          <HoshidictsToggleSetting
            id="hoshidicts-source-highlight-enabled"
            className="hoshidicts-toggle--boxed"
            label={t("settings.hoshidicts.reader.sourceHighlight")}
            hint={t("settings.hoshidicts.reader.sourceHighlightHint")}
            checked={readerDraft.sourceHighlightEnabled}
            disabled={preferencesBusy}
            onChange={(value) =>
              setReaderPreference("sourceHighlightEnabled", value)
            }
          />
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
