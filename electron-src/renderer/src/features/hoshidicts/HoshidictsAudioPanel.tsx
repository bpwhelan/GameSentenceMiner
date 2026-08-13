import {
  ArrowDown,
  ArrowUp,
  Plus,
  RotateCcw,
  Trash2,
  Volume2
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  HOSHIDICTS_AUDIO_SOURCE_TYPES,
  HOSHIDICTS_CHANNELS,
  MAX_HOSHIDICTS_AUDIO_SOURCES,
  type HoshidictsAudioProfile,
  type HoshidictsAudioSource,
  type HoshidictsAudioSourceTestRequest,
  type HoshidictsAudioSourceTestResult,
  type HoshidictsAudioSourceType
} from "../../../../shared/features/hoshidicts";
import { useTranslation } from "../../i18n";
import { HoshidictsToggleSetting } from "./components/HoshidictsToggleSetting";
import { HoshidictsSaveIndicator } from "./HoshidictsSaveIndicator";
import { copyAudioProfile } from "./hoshidictsSettingsModel";
import { useHoshidictsSettingsController } from "./useHoshidictsSettingsController";

type Controller = ReturnType<typeof useHoshidictsSettingsController>;
type AudioTestPhase = "testing" | "playing" | "success" | "error";

interface AudioTestFeedback {
  phase: AudioTestPhase;
  detail?: string;
}

interface ActiveAudioPlayback {
  audio: HTMLAudioElement;
  objectUrl: string;
}

const AUDIO_TEST_TERM = "聞く";
const AUDIO_TEST_READING = "きく";
const AUDIO_TEST_TIMEOUT_MS = 15_000;

const AUDIO_TOGGLES = [
  {
    id: "hoshidicts-audio-enabled",
    key: "enabled",
    labelKey: "settings.hoshidicts.audio.enabled"
  },
  {
    id: "hoshidicts-audio-autoplay",
    key: "autoPlay",
    labelKey: "settings.hoshidicts.audio.autoplay"
  }
] as const;

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

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
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
  const [activeTestSourceId, setActiveTestSourceId] = useState<string | null>(
    null
  );
  const [testFeedback, setTestFeedback] = useState<
    Record<string, AudioTestFeedback>
  >({});
  const testSequenceRef = useRef(0);
  const activeTestSourceRef = useRef<string | null>(null);
  const audioPlaybackRef = useRef<ActiveAudioPlayback | null>(null);
  const speechUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const testTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioControlsDisabled = audioBusy || activeTestSourceId !== null;

  const clearTestTimeout = useCallback(() => {
    const timeout = testTimeoutRef.current;
    if (timeout !== null) {
      clearTimeout(timeout);
      testTimeoutRef.current = null;
    }
  }, []);

  const releaseAudioPlayback = useCallback(
    (playback: ActiveAudioPlayback) => {
      playback.audio.onended = null;
      playback.audio.onerror = null;
      playback.audio.pause();
      if (typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(playback.objectUrl);
      }
      if (audioPlaybackRef.current === playback) {
        audioPlaybackRef.current = null;
      }
    },
    []
  );

  const stopActivePlayback = useCallback(() => {
    const utterance = speechUtteranceRef.current;
    if (utterance) {
      utterance.onend = null;
      utterance.onerror = null;
      speechUtteranceRef.current = null;
    }
    window.speechSynthesis?.cancel();

    const playback = audioPlaybackRef.current;
    if (playback) {
      releaseAudioPlayback(playback);
    }
  }, [releaseAudioPlayback]);

  useEffect(() => {
    const synthesis = window.speechSynthesis;
    if (!synthesis) return;
    const refresh = () => setVoices(synthesis.getVoices());
    refresh();
    synthesis.addEventListener?.("voiceschanged", refresh);
    return () => synthesis.removeEventListener?.("voiceschanged", refresh);
  }, []);

  useEffect(
    () => () => {
      testSequenceRef.current += 1;
      activeTestSourceRef.current = null;
      clearTestTimeout();
      stopActivePlayback();
    },
    [clearTestTimeout, stopActivePlayback]
  );

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

  const updateTestFeedback = (
    sourceId: string,
    feedback: AudioTestFeedback
  ) => {
    setTestFeedback((current) => ({
      ...current,
      [sourceId]: feedback
    }));
  };

  const completeTest = (
    sequence: number,
    sourceId: string,
    feedback: AudioTestFeedback
  ) => {
    if (testSequenceRef.current !== sequence) return;
    clearTestTimeout();
    testSequenceRef.current += 1;
    activeTestSourceRef.current = null;
    updateTestFeedback(sourceId, feedback);
    setActiveTestSourceId(null);
  };

  const testTtsSource = (
    source: HoshidictsAudioSource,
    sequence: number
  ) => {
    const synthesis = window.speechSynthesis;
    if (!synthesis || typeof SpeechSynthesisUtterance === "undefined") {
      completeTest(sequence, source.id, {
        phase: "error",
        detail: t("settings.hoshidicts.audio.ttsUnavailable")
      });
      return;
    }

    const spokenText =
      source.type === "text-to-speech-reading"
        ? AUDIO_TEST_READING
        : AUDIO_TEST_TERM;
    try {
      const utterance = new SpeechSynthesisUtterance(spokenText);
      utterance.lang = "ja-JP";
      utterance.volume = audioDraft.volume / 100;
      const selectedVoice = voices.find(
        (voice) => voice.voiceURI === source.voice || voice.name === source.voice
      );
      if (selectedVoice) utterance.voice = selectedVoice;
      utterance.onend = () => {
        if (speechUtteranceRef.current === utterance) {
          speechUtteranceRef.current = null;
        }
        completeTest(sequence, source.id, {
          phase: "success",
          detail: spokenText
        });
      };
      utterance.onerror = () => {
        if (speechUtteranceRef.current === utterance) {
          speechUtteranceRef.current = null;
        }
        completeTest(sequence, source.id, {
          phase: "error",
          detail: t("settings.hoshidicts.audio.ttsFailed")
        });
      };
      speechUtteranceRef.current = utterance;
      updateTestFeedback(source.id, {
        phase: "playing",
        detail: spokenText
      });
      synthesis.speak(utterance);
    } catch (error) {
      speechUtteranceRef.current = null;
      completeTest(sequence, source.id, {
        phase: "error",
        detail: messageFromError(
          error,
          t("settings.hoshidicts.audio.ttsFailed")
        )
      });
    }
  };

  const testAudioSource = async (
    source: HoshidictsAudioSource,
    sourceName: string
  ) => {
    if (activeTestSourceRef.current !== null) return;
    stopActivePlayback();
    clearTestTimeout();
    const sequence = testSequenceRef.current + 1;
    testSequenceRef.current = sequence;
    activeTestSourceRef.current = source.id;
    setActiveTestSourceId(source.id);
    updateTestFeedback(source.id, { phase: "testing" });
    testTimeoutRef.current = setTimeout(() => {
      if (testSequenceRef.current !== sequence) return;
      stopActivePlayback();
      completeTest(sequence, source.id, {
        phase: "error",
        detail: t("settings.hoshidicts.audio.testTimeout")
      });
    }, AUDIO_TEST_TIMEOUT_MS);

    if (isTtsSource(source.type)) {
      testTtsSource(source, sequence);
      return;
    }

    try {
      const request: HoshidictsAudioSourceTestRequest = {
        profile: audioDraft,
        sourceId: source.id
      };
      const result =
        await window.ipcRenderer.invoke<HoshidictsAudioSourceTestResult>(
          HOSHIDICTS_CHANNELS.testAudioSource,
          request
        );
      if (testSequenceRef.current !== sequence) return;
      if (!result.success || !result.audio) {
        throw new Error(
          result.error?.trim() ||
            t("settings.hoshidicts.audio.testUnavailable")
        );
      }

      const bytes = new Uint8Array(result.audio.bytes.byteLength);
      bytes.set(result.audio.bytes);
      const blob = new Blob([bytes.buffer], {
        type: result.audio.contentType
      });
      const objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(objectUrl);
      const playback = { audio, objectUrl };
      audioPlaybackRef.current = playback;
      audio.volume = Math.min(1, Math.max(0, audioDraft.volume / 100));
      const candidateName = result.audio.candidateName.trim() || sourceName;
      audio.onended = () => {
        releaseAudioPlayback(playback);
        completeTest(sequence, source.id, {
          phase: "success",
          detail: candidateName
        });
      };
      audio.onerror = () => {
        releaseAudioPlayback(playback);
        completeTest(sequence, source.id, {
          phase: "error",
          detail: t("settings.hoshidicts.audio.playbackFailed")
        });
      };
      updateTestFeedback(source.id, {
        phase: "playing",
        detail: candidateName
      });
      await audio.play();
    } catch (error) {
      if (testSequenceRef.current !== sequence) return;
      stopActivePlayback();
      completeTest(sequence, source.id, {
        phase: "error",
        detail: messageFromError(
          error,
          t("settings.hoshidicts.audio.testUnavailable")
        )
      });
    }
  };

  const testFeedbackText = (feedback: AudioTestFeedback): string => {
    if (feedback.phase === "testing") {
      return t("settings.hoshidicts.audio.testing", {
        term: AUDIO_TEST_TERM,
        reading: AUDIO_TEST_READING
      });
    }
    if (feedback.phase === "playing") {
      return t("settings.hoshidicts.audio.playing", {
        name: feedback.detail ?? ""
      });
    }
    if (feedback.phase === "success") {
      return t("settings.hoshidicts.audio.testSuccess", {
        name: feedback.detail ?? ""
      });
    }
    return t("settings.hoshidicts.audio.testError", {
      error: feedback.detail ?? t("settings.hoshidicts.audio.testUnavailable")
    });
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
          {AUDIO_TOGGLES.map((toggle) => (
            <HoshidictsToggleSetting
              key={toggle.id}
              id={toggle.id}
              className="hoshidicts-toggle--boxed"
              label={t(toggle.labelKey)}
              hint={t(`${toggle.labelKey}Hint`)}
              checked={audioDraft[toggle.key]}
              disabled={audioControlsDisabled}
              onChange={(value) =>
                updateProfile((profile) => ({ ...profile, [toggle.key]: value }))
              }
            />
          ))}
        </div>

        <label className="hoshidicts-setting hoshidicts-audio-volume">
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
            disabled={audioControlsDisabled}
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
              disabled={audioControlsDisabled}
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
                audioControlsDisabled ||
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
              const feedback = testFeedback[source.id];
              const testStatusId = `hoshidicts-audio-test-status-${source.id}`;
              const testSourceLabel = t(
                "settings.hoshidicts.audio.testSourceLabel",
                {
                  name: sourceName,
                  term: AUDIO_TEST_TERM,
                  reading: AUDIO_TEST_READING
                }
              );
              const ttsUnavailable =
                isTtsSource(source.type) &&
                (!window.speechSynthesis ||
                  typeof SpeechSynthesisUtterance === "undefined");
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
                      disabled={audioControlsDisabled || index === 0}
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
                        audioControlsDisabled ||
                        index === audioDraft.sources.length - 1
                      }
                      onClick={() => moveSource(source.id, 1)}
                    >
                      <ArrowDown size={16} aria-hidden="true" />
                    </button>
                  </div>

                  <div className="hoshidicts-audio-source__body">
                    <label className="hoshidicts-setting">
                      <span>{t("settings.hoshidicts.audio.sourceType")}</span>
                      <select
                        value={source.type}
                        disabled={audioControlsDisabled}
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
                      <label className="hoshidicts-setting">
                        <span>{t("settings.hoshidicts.audio.sourceUrl")}</span>
                        <input
                          type="text"
                          inputMode="url"
                          value={source.url}
                          disabled={audioControlsDisabled}
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
                      <label className="hoshidicts-setting">
                        <span>{t("settings.hoshidicts.audio.voice")}</span>
                        <div className="hoshidicts-audio-source__voice">
                          <select
                            value={source.voice}
                            disabled={
                              audioControlsDisabled || voices.length === 0
                            }
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
                        </div>
                      </label>
                    ) : null}

                    <small>
                      {t(
                        `settings.hoshidicts.audio.sourceHelp.${sourceSuffix}`
                      )}
                    </small>

                    {feedback ? (
                      <div className="hoshidicts-audio-source__test">
                        <span
                          id={testStatusId}
                          className="hoshidicts-audio-source__test-status"
                          data-phase={feedback.phase}
                          role={feedback.phase === "error" ? "alert" : "status"}
                        >
                          {testFeedbackText(feedback)}
                        </span>
                      </div>
                    ) : null}
                  </div>

                  <div className="hoshidicts-audio-source__actions">
                    <button
                      type="button"
                      className="hoshidicts-icon-button secondary"
                      data-audio-test-source={source.id}
                      title={testSourceLabel}
                      aria-label={testSourceLabel}
                      aria-describedby={feedback ? testStatusId : undefined}
                      disabled={audioControlsDisabled || ttsUnavailable}
                      onClick={() => void testAudioSource(source, sourceName)}
                    >
                      <Volume2 size={17} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="hoshidicts-icon-button danger"
                      aria-label={t("settings.hoshidicts.audio.removeSource", {
                        name: sourceName
                      })}
                      disabled={audioControlsDisabled}
                      onClick={() => removeSource(source.id)}
                    >
                      <Trash2 size={17} aria-hidden="true" />
                    </button>
                  </div>
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
