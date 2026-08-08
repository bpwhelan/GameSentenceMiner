import {
  ArrowDown,
  ArrowUp,
  Plus,
  RotateCcw,
  Trash2,
  Volume2
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  HOSHIDICTS_AUDIO_SOURCE_TYPES,
  MAX_HOSHIDICTS_AUDIO_SOURCES,
  type HoshidictsAudioProfile,
  type HoshidictsAudioSource,
  type HoshidictsAudioSourceType
} from "../../../../shared/features/hoshidicts";
import { useTranslation } from "../../i18n";
import { HoshidictsSaveIndicator } from "./HoshidictsSaveIndicator";
import { copyAudioProfile } from "./hoshidictsSettingsModel";
import { useHoshidictsSettingsController } from "./useHoshidictsSettingsController";

type Controller = ReturnType<typeof useHoshidictsSettingsController>;

const AUDIO_SOURCE_I18N_SUFFIXES: Record<HoshidictsAudioSourceType, string> = {
  jpod101: "jpod101",
  "language-pod-101": "languagePod101",
  jisho: "jisho",
  custom: "custom",
  "custom-json": "customJson",
  "text-to-speech": "termTts",
  "text-to-speech-reading": "readingTts"
};

function createSourceId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `audio-${randomUuid}`;
  return `audio-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function newCustomSource(): HoshidictsAudioSource {
  return {
    id: createSourceId(),
    type: "custom",
    url: "",
    voice: ""
  };
}

function isCustomSource(type: HoshidictsAudioSourceType): boolean {
  return type === "custom" || type === "custom-json";
}

function isTtsSource(type: HoshidictsAudioSourceType): boolean {
  return type === "text-to-speech" || type === "text-to-speech-reading";
}

export function HoshidictsAudioPanel({
  controller
}: {
  controller: Controller;
}) {
  const t = useTranslation();
  const { audioDraft, audioSaveStatus, updateAudioDraft, audioBusy } =
    controller;
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    const synthesis = window.speechSynthesis;
    if (!synthesis) return;
    const refresh = () => setVoices(synthesis.getVoices());
    refresh();
    synthesis.addEventListener?.("voiceschanged", refresh);
    return () => synthesis.removeEventListener?.("voiceschanged", refresh);
  }, []);

  const japaneseVoices = useMemo(() => {
    const preferred = voices.filter((voice) =>
      voice.lang.toLowerCase().startsWith("ja")
    );
    return preferred.length > 0 ? preferred : voices;
  }, [voices]);

  const updateProfile = (
    update: (profile: HoshidictsAudioProfile) => HoshidictsAudioProfile
  ) => updateAudioDraft(update);

  const updateSource = (
    sourceId: string,
    update: Partial<HoshidictsAudioSource>
  ) => {
    updateProfile((profile) => ({
      ...profile,
      sources: profile.sources.map((source) =>
        source.id === sourceId ? { ...source, ...update } : source
      )
    }));
  };

  const changeSourceType = (
    source: HoshidictsAudioSource,
    type: HoshidictsAudioSourceType
  ) => {
    updateSource(source.id, { type, url: "", voice: "" });
  };

  const moveSource = (sourceId: string, direction: -1 | 1) => {
    updateProfile((profile) => {
      const index = profile.sources.findIndex(
        (source) => source.id === sourceId
      );
      const target = index + direction;
      if (index < 0 || target < 0 || target >= profile.sources.length) {
        return profile;
      }
      const sources = [...profile.sources];
      [sources[index], sources[target]] = [sources[target], sources[index]];
      return { ...profile, sources };
    });
  };

  const removeSource = (sourceId: string) => {
    updateProfile((profile) => ({
      ...profile,
      sources: profile.sources.filter((source) => source.id !== sourceId)
    }));
  };

  const testVoice = (source: HoshidictsAudioSource) => {
    const synthesis = window.speechSynthesis;
    if (!synthesis || typeof SpeechSynthesisUtterance === "undefined") return;
    synthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(
      t("settings.hoshidicts.audio.testPhrase")
    );
    utterance.lang = "ja-JP";
    utterance.volume = audioDraft.volume / 100;
    const selectedVoice = voices.find(
      (voice) => voice.voiceURI === source.voice || voice.name === source.voice
    );
    if (selectedVoice) utterance.voice = selectedVoice;
    synthesis.speak(utterance);
  };

  return (
    <div className="hoshidicts-audio">
      <section className="hoshidicts-section">
        <div className="hoshidicts-section__heading">
          <div>
            <h2>{t("settings.hoshidicts.audio.title")}</h2>
            <p>{t("settings.hoshidicts.audio.subtitle")}</p>
          </div>
          <HoshidictsSaveIndicator status={audioSaveStatus} />
        </div>

        <div className="hoshidicts-audio-controls">
          <label className="hoshidicts-audio-toggle">
            <input
              id="hoshidicts-audio-enabled"
              type="checkbox"
              checked={audioDraft.enabled}
              disabled={audioBusy}
              onChange={(event) =>
                updateProfile((profile) => ({
                  ...profile,
                  enabled: event.target.checked
                }))
              }
            />
            <span>
              <strong>{t("settings.hoshidicts.audio.enabled")}</strong>
              <small>{t("settings.hoshidicts.audio.enabledHint")}</small>
            </span>
          </label>
          <label className="hoshidicts-audio-toggle">
            <input
              id="hoshidicts-audio-autoplay"
              type="checkbox"
              checked={audioDraft.autoPlay}
              disabled={audioBusy}
              onChange={(event) =>
                updateProfile((profile) => ({
                  ...profile,
                  autoPlay: event.target.checked
                }))
              }
            />
            <span>
              <strong>{t("settings.hoshidicts.audio.autoplay")}</strong>
              <small>{t("settings.hoshidicts.audio.autoplayHint")}</small>
            </span>
          </label>
        </div>

        <label className="hoshidicts-audio-volume">
          <span>
            <Volume2 size={17} aria-hidden="true" />
            {t("settings.hoshidicts.audio.volume", {
              volume: audioDraft.volume
            })}
          </span>
          <input
            id="hoshidicts-audio-volume"
            type="range"
            min={0}
            max={100}
            step={1}
            value={audioDraft.volume}
            disabled={audioBusy}
            onChange={(event) =>
              updateProfile((profile) => ({
                ...profile,
                volume: event.currentTarget.valueAsNumber
              }))
            }
          />
        </label>
      </section>

      <section className="hoshidicts-section">
        <div className="hoshidicts-section__heading">
          <div>
            <h2>{t("settings.hoshidicts.audio.sources")}</h2>
            <p>{t("settings.hoshidicts.audio.sourcesHint")}</p>
          </div>
          <div className="hoshidicts-actions">
            <button
              type="button"
              className="secondary"
              disabled={audioBusy}
              onClick={() =>
                updateProfile((profile) => ({
                  ...profile,
                  sources: copyAudioProfile().sources
                }))
              }
            >
              <RotateCcw size={16} aria-hidden="true" />
              {t("settings.hoshidicts.audio.restoreDefaults")}
            </button>
            <button
              id="hoshidicts-audio-add-source"
              type="button"
              disabled={
                audioBusy ||
                audioDraft.sources.length >= MAX_HOSHIDICTS_AUDIO_SOURCES
              }
              onClick={() =>
                updateProfile((profile) => ({
                  ...profile,
                  sources: [...profile.sources, newCustomSource()]
                }))
              }
            >
              <Plus size={16} aria-hidden="true" />
              {t("settings.hoshidicts.audio.addSource")}
            </button>
          </div>
        </div>

        {audioDraft.sources.length === 0 ? (
          <div className="hoshidicts-empty">
            {t("settings.hoshidicts.audio.noSources")}
          </div>
        ) : (
          <div className="hoshidicts-audio-sources">
            {audioDraft.sources.map((source, index) => {
              const sourceSuffix = AUDIO_SOURCE_I18N_SUFFIXES[source.type];
              const sourceName = t(
                `settings.hoshidicts.audio.sourceTypes.${sourceSuffix}`
              );
              const selectedVoiceExists = voices.some(
                (voice) =>
                  voice.voiceURI === source.voice || voice.name === source.voice
              );
              return (
                <div className="hoshidicts-audio-source" key={source.id}>
                  <div className="hoshidicts-audio-source__order">
                    <span>{index + 1}</span>
                    <button
                      type="button"
                      className="hoshidicts-icon-button secondary"
                      aria-label={t("settings.hoshidicts.audio.moveUp", {
                        name: sourceName
                      })}
                      disabled={audioBusy || index === 0}
                      onClick={() => moveSource(source.id, -1)}
                    >
                      <ArrowUp size={16} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="hoshidicts-icon-button secondary"
                      aria-label={t("settings.hoshidicts.audio.moveDown", {
                        name: sourceName
                      })}
                      disabled={
                        audioBusy || index === audioDraft.sources.length - 1
                      }
                      onClick={() => moveSource(source.id, 1)}
                    >
                      <ArrowDown size={16} aria-hidden="true" />
                    </button>
                  </div>

                  <div className="hoshidicts-audio-source__body">
                    <label>
                      <span>{t("settings.hoshidicts.audio.sourceType")}</span>
                      <select
                        value={source.type}
                        disabled={audioBusy}
                        onChange={(event) =>
                          changeSourceType(
                            source,
                            event.target.value as HoshidictsAudioSourceType
                          )
                        }
                      >
                        {HOSHIDICTS_AUDIO_SOURCE_TYPES.map((type) => (
                          <option value={type} key={type}>
                            {t(
                              `settings.hoshidicts.audio.sourceTypes.${AUDIO_SOURCE_I18N_SUFFIXES[type]}`
                            )}
                          </option>
                        ))}
                      </select>
                    </label>

                    {isCustomSource(source.type) ? (
                      <label>
                        <span>{t("settings.hoshidicts.audio.sourceUrl")}</span>
                        <input
                          type="text"
                          inputMode="url"
                          value={source.url}
                          disabled={audioBusy}
                          placeholder={t(
                            "settings.hoshidicts.audio.sourceUrlPlaceholder"
                          )}
                          onChange={(event) =>
                            updateSource(source.id, {
                              url: event.target.value
                            })
                          }
                        />
                      </label>
                    ) : null}

                    {isTtsSource(source.type) ? (
                      <label>
                        <span>{t("settings.hoshidicts.audio.voice")}</span>
                        <div className="hoshidicts-audio-source__voice">
                          <select
                            value={source.voice}
                            disabled={audioBusy || voices.length === 0}
                            onChange={(event) =>
                              updateSource(source.id, {
                                voice: event.target.value
                              })
                            }
                          >
                            <option value="">
                              {t("settings.hoshidicts.audio.defaultVoice")}
                            </option>
                            {source.voice && !selectedVoiceExists ? (
                              <option value={source.voice}>
                                {t("settings.hoshidicts.audio.missingVoice", {
                                  name: source.voice
                                })}
                              </option>
                            ) : null}
                            {japaneseVoices.map((voice) => (
                              <option
                                value={voice.voiceURI}
                                key={voice.voiceURI}
                              >
                                {voice.name} ({voice.lang})
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="secondary"
                            disabled={
                              audioBusy ||
                              !window.speechSynthesis ||
                              typeof SpeechSynthesisUtterance === "undefined"
                            }
                            onClick={() => testVoice(source)}
                          >
                            <Volume2 size={16} aria-hidden="true" />
                            {t("settings.hoshidicts.audio.testVoice")}
                          </button>
                        </div>
                      </label>
                    ) : null}

                    <small>
                      {t(
                        `settings.hoshidicts.audio.sourceHelp.${sourceSuffix}`
                      )}
                    </small>
                  </div>

                  <button
                    type="button"
                    className="hoshidicts-icon-button danger"
                    aria-label={t("settings.hoshidicts.audio.removeSource", {
                      name: sourceName
                    })}
                    disabled={audioBusy}
                    onClick={() => removeSource(source.id)}
                  >
                    <Trash2 size={17} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <p className="hoshidicts-audio-privacy">
          {t("settings.hoshidicts.audio.privacy")}
        </p>
      </section>
    </div>
  );
}
