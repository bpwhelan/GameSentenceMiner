import { BookOpen, RotateCw } from "lucide-react";
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
  getReadiness,
  normalizeHoshidictsDesktopState
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

export { normalizeHoshidictsDesktopState } from "./hoshidictsSettingsModel";

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
        <div
          className="hoshidicts-window__feature-status"
          data-ready={readiness?.kind === "ready"}
          role="status"
        >
          {readiness
            ? t(`settings.hoshidicts.readiness.${readiness.kind}`)
            : t("settings.hoshidicts.readiness.loading")}
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
