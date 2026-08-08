import { BookOpen, EllipsisVertical, Plus, RotateCw } from "lucide-react";
import { useMemo } from "react";

import {
  HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS,
  type HoshidictsRecommendedDictionaryId
} from "../../../../shared/features/hoshidicts";
import { useTranslation } from "../../i18n";
import { HoshidictsAudioPanel } from "./HoshidictsAudioPanel";
import { HoshidictsDesignPanel } from "./HoshidictsDesignPanel";
import {
  CustomDictionaryPanel,
  DictionariesPanel,
  MiningPanel
} from "./HoshidictsSettingsPanels";
import {
  PROGRESS_KEYS,
  RECOMMENDED_KEYS,
  type HoshidictsView,
  getReadiness
} from "./hoshidictsSettingsModel";
import { useHoshidictsSettingsController } from "./useHoshidictsSettingsController";
import "./hoshidicts.css";

const HOSHIDICTS_TABS: Array<{
  view: HoshidictsView;
  labelKey: string;
}> = [
  {
    view: "dictionaries",
    labelKey: "settings.hoshidicts.tabs.dictionaries"
  },
  { view: "design", labelKey: "settings.hoshidicts.tabs.design" },
  { view: "custom", labelKey: "settings.hoshidicts.tabs.custom" },
  { view: "audio", labelKey: "settings.hoshidicts.tabs.audio" },
  { view: "mining", labelKey: "settings.hoshidicts.tabs.mining" }
];

function ReadinessBanner({
  controller
}: {
  controller: ReturnType<typeof useHoshidictsSettingsController>;
}) {
  const t = useTranslation();
  const { state, actions, dictionaryBusy, restarting } = controller;
  if (!state) {
    return (
      <div
        className="hoshidicts-readiness is-loading"
        data-readiness="loading"
        role="status"
      >
        <div>
          <strong>{t("settings.hoshidicts.readiness.loading")}</strong>
          <span>{t("settings.hoshidicts.readiness.loadingHint")}</span>
        </div>
      </div>
    );
  }

  const readiness = getReadiness(state);
  const firstLookupDictionary = state.dictionaries.find(
    (dictionary) => dictionary.termCount > 0 || dictionary.kanjiCount > 0
  );
  const label = t(`settings.hoshidicts.readiness.${readiness.kind}`);
  const hint = t(`settings.hoshidicts.readiness.${readiness.kind}Hint`);

  return (
    <div
      className="hoshidicts-readiness"
      data-readiness={readiness.kind}
      role="status"
    >
      <div>
        <strong>{label}</strong>
        <span>{hint}</span>
        <small>
          {t("settings.hoshidicts.readiness.dictionaryCounts", {
            installed: readiness.installed,
            enabled: readiness.enabled
          })}
        </small>
      </div>
      {readiness.kind === "restartRequired" ? (
        <button
          type="button"
          onClick={() => void actions.restartOverlay()}
          disabled={restarting}
        >
          <RotateCw size={16} aria-hidden="true" />
          {restarting
            ? t("settings.hoshidicts.restarting")
            : t("settings.hoshidicts.restartNow")}
        </button>
      ) : readiness.kind === "noEnabledDictionaries" ||
        readiness.kind === "noEnabledLookupDictionary" ? (
        <button
          type="button"
          disabled={dictionaryBusy}
          onClick={() => {
            if (firstLookupDictionary) {
              void actions.setDictionaryEnabled(firstLookupDictionary.id, true);
            } else {
              void actions.installAllRecommended();
            }
          }}
        >
          {firstLookupDictionary
            ? t("settings.hoshidicts.readiness.enableDictionary")
            : t("settings.hoshidicts.recommended.install")}
        </button>
      ) : null}
    </div>
  );
}

function ProfileControl({
  controller
}: {
  controller: ReturnType<typeof useHoshidictsSettingsController>;
}) {
  const t = useTranslation();
  const { state, profileSwitching, actions } = controller;
  if (!state) return null;
  const activeProfile = state.profiles.find(
    ({ id }) => id === state.activeProfileId
  );
  const disabled = profileSwitching || state.busy;

  return (
    <div className="hoshidicts-profile-control">
      <label htmlFor="hoshidicts-active-profile">
        {t("settings.hoshidicts.profiles.label")}
      </label>
      <select
        id="hoshidicts-active-profile"
        value={state.activeProfileId}
        disabled={disabled}
        onChange={(event) => void actions.switchProfile(event.currentTarget.value)}
      >
        {state.profiles.map((profile) => (
          <option value={profile.id} key={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="hoshidicts-icon-button secondary"
        aria-label={t("settings.hoshidicts.profiles.create")}
        disabled={disabled}
        onClick={() => {
          const name = window.prompt(
            t("settings.hoshidicts.profiles.createPrompt")
          );
          if (name?.trim()) void actions.createProfile(name);
        }}
      >
        <Plus size={16} aria-hidden="true" />
      </button>
      <details className="hoshidicts-profile-control__menu">
        <summary
          className="hoshidicts-icon-button secondary"
          aria-label={t("settings.hoshidicts.profiles.manage")}
          aria-disabled={disabled}
          onClick={(event) => {
            if (disabled) event.preventDefault();
          }}
        >
          <EllipsisVertical size={16} aria-hidden="true" />
        </summary>
        <div>
          <button
            type="button"
            className="secondary"
            disabled={disabled || !activeProfile}
            onClick={(event) => {
              const details = event.currentTarget.closest(
                "details"
              ) as HTMLDetailsElement | null;
              if (details) details.open = false;
              if (!activeProfile) return;
              const name = window.prompt(
                t("settings.hoshidicts.profiles.renamePrompt"),
                activeProfile.name
              );
              if (name?.trim()) {
                void actions.renameProfile(activeProfile.id, name);
              }
            }}
          >
            {t("settings.hoshidicts.profiles.rename")}
          </button>
          <button
            type="button"
            className="danger"
            disabled={disabled || state.profiles.length === 1 || !activeProfile}
            onClick={(event) => {
              const details = event.currentTarget.closest(
                "details"
              ) as HTMLDetailsElement | null;
              if (details) details.open = false;
              if (
                activeProfile &&
                window.confirm(
                  t("settings.hoshidicts.profiles.deleteConfirm", {
                    name: activeProfile.name
                  })
                )
              ) {
                void actions.deleteProfile(activeProfile.id);
              }
            }}
          >
            {t("settings.hoshidicts.profiles.delete")}
          </button>
        </div>
      </details>
      {profileSwitching ? (
        <span role="status">{t("settings.hoshidicts.profiles.switching")}</span>
      ) : null}
    </div>
  );
}

export function HoshidictsSettingsWindow() {
  const t = useTranslation();
  const controller = useHoshidictsSettingsController();
  const { state, view, setView, actionError, notice } = controller;

  const progressLabel = useMemo(() => {
    if (!state) return "";
    const recommendedId = HOSHIDICTS_RECOMMENDED_DICTIONARY_IDS.find(
      (dictionaryId) => dictionaryId === state.progress.title
    ) as HoshidictsRecommendedDictionaryId | undefined;
    const title = recommendedId
      ? t(RECOMMENDED_KEYS[recommendedId])
      : (state.progress.title ?? "");
    return t(PROGRESS_KEYS[state.progress.phase], { title });
  }, [state, t]);

  const readiness = state ? getReadiness(state) : null;
  const displayedError = actionError ?? state?.lastError ?? null;
  const importProgressIsLocal =
    view === "dictionaries" && state?.progress.phase === "importing";

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
        <div className="hoshidicts-window__header-actions">
          <ProfileControl controller={controller} />
          <div
            className="hoshidicts-window__feature-status"
            data-ready={readiness?.kind === "ready"}
            role="status"
          >
            {readiness
              ? t(`settings.hoshidicts.readiness.${readiness.kind}`)
              : t("settings.hoshidicts.readiness.loading")}
          </div>
        </div>
      </header>

      <ReadinessBanner controller={controller} />

      <nav
        className="hoshidicts-window__tabs"
        aria-label={t("settings.hoshidicts.appTitle")}
      >
        {HOSHIDICTS_TABS.map((tab) => (
          <button
            type="button"
            className={view === tab.view ? "is-active" : ""}
            aria-selected={view === tab.view}
            onClick={() => setView(tab.view)}
            key={tab.view}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </nav>

      <main
        className={`hoshidicts-window__content${
          view === "design" ? " hoshidicts-window__content--design" : ""
        }`}
      >
        {state?.busy && !importProgressIsLocal ? (
          <div className="hoshidicts-window__progress" role="status">
            <span>{progressLabel}</span>
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

        {notice ? (
          <div className="hoshidicts-window__notice" role="status">
            {notice}
          </div>
        ) : null}
        {displayedError ? (
          <div className="hoshidicts-window__error" role="alert">
            {displayedError}
          </div>
        ) : null}

        {!state ? (
          <div className="hoshidicts-window__loading" role="status">
            {t("settings.hoshidicts.loading")}
          </div>
        ) : view === "dictionaries" ? (
          <DictionariesPanel controller={controller} />
        ) : view === "design" ? (
          <HoshidictsDesignPanel controller={controller} />
        ) : view === "audio" ? (
          <HoshidictsAudioPanel controller={controller} />
        ) : view === "custom" ? (
          <CustomDictionaryPanel controller={controller} />
        ) : (
          <MiningPanel controller={controller} />
        )}
      </main>
    </div>
  );
}
