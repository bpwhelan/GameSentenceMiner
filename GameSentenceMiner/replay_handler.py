import os
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import requests
from watchdog.events import FileSystemEventHandler

from GameSentenceMiner import anki, obs
from GameSentenceMiner.util.config import configuration
from GameSentenceMiner.util.config.configuration import (
    AnkiUpdateResult,
    anki_results,
    get_config,
    get_temporary_directory,
    gsm_state,
    gsm_status,
    logger,
)
from GameSentenceMiner.util.gsm_utils import (
    combine_dialogue,
    make_unique_file_name,
    remove_html_and_cloze_tags,
    wait_for_stable_file,
)
from GameSentenceMiner.util.media import ffmpeg
from GameSentenceMiner.util.media.ffmpeg import get_audio_and_trim, get_audio_length
from GameSentenceMiner.util.models.model import VADResult
from GameSentenceMiner.vad import vad_processor


def _handle_texthooker_button(video_path: str) -> None:
    from GameSentenceMiner.web.service import handle_texthooker_button

    handle_texthooker_button(video_path)


def _notify_anki_enhancement_failure(reason: str) -> None:
    message = str(reason or "").strip()
    if not message:
        message = "Anki card enhancement failed. Check console for reason."
    from GameSentenceMiner.util.platform import notification

    notification.send_anki_enhancement_failed(message)


@dataclass
class ReplayAudioResult:
    final_audio_output: str
    vad_result: VADResult
    vad_trimmed_audio: str
    start_time: float
    end_time: float
    audio_edit_context: "AudioEditContext | None" = None


@dataclass
class AudioEditContext:
    source_audio_path: str
    source_duration: float
    range_start: float
    range_end: float
    rebase_on_selection_trim: bool = False


@dataclass
class ReplayProcessingContext:
    video_path: str
    skip_delete: bool = False
    selected_lines: list = field(default_factory=list)
    anki_card_creation_time: object = None
    mined_line: object = None
    last_note: object = None
    note: dict | None = None
    tango: str = ""
    word_being_processed: str = ""
    background_update_started: bool = False
    line_cutoff: object = None
    start_line: object = None
    full_text: str = ""
    sentence_for_translation: str = ""
    ss_timing: float = 0.0
    prefetched_assets: object = None
    prefetched_translation: object = None
    audio_result: ReplayAudioResult | None = None

    @property
    def final_audio_output(self) -> str:
        return self.audio_result.final_audio_output if self.audio_result else ""

    @property
    def vad_result(self):
        return self.audio_result.vad_result if self.audio_result else None

    @property
    def vad_trimmed_audio(self) -> str:
        return self.audio_result.vad_trimmed_audio if self.audio_result else ""

    @property
    def start_time(self) -> float:
        return self.audio_result.start_time if self.audio_result else 0.0

    @property
    def end_time(self) -> float:
        return self.audio_result.end_time if self.audio_result else 0.0

    @property
    def audio_edit_context(self) -> AudioEditContext | None:
        return self.audio_result.audio_edit_context if self.audio_result else None


class ReplayAudioExtractor:
    @staticmethod
    def _should_rebase_audio_edit_context(vad_result) -> bool:
        if not vad_result or getattr(vad_result, "tts_used", False):
            return False
        if not getattr(vad_result, "success", False):
            return False
        if getattr(vad_result, "model", "") in {"", "No VAD"}:
            return False

        vad_config = get_config().vad
        return bool(getattr(vad_config, "cut_and_splice_segments", False))

    @staticmethod
    def _build_audio_edit_context(source_audio_path, start_time, end_time, vad_result):
        if not source_audio_path:
            return None

        source_duration = get_audio_length(source_audio_path)
        if source_duration <= 0:
            return None

        current_start = max(0.0, float(start_time or 0.0))
        current_end = float(end_time) if end_time and end_time > 0 else source_duration

        if vad_result and getattr(vad_result, "tts_used", False):
            return None

        if (
            vad_result
            and getattr(vad_result, "success", False)
            and getattr(vad_result, "model", "") not in {"", "No VAD"}
        ):
            vad_start = max(0.0, float(getattr(vad_result, "start", 0.0) or 0.0))
            vad_end = float(getattr(vad_result, "end", 0.0) or 0.0)
            if get_config().vad.trim_beginning:
                current_start = min(source_duration, current_start + vad_start)
            if vad_end > 0:
                current_end = min(source_duration, float(start_time or 0.0) + vad_end)

        current_start = max(0.0, min(current_start, source_duration))
        current_end = max(current_start, min(current_end, source_duration))

        return AudioEditContext(
            source_audio_path=source_audio_path,
            source_duration=source_duration,
            range_start=current_start,
            range_end=current_end,
            rebase_on_selection_trim=ReplayAudioExtractor._should_rebase_audio_edit_context(vad_result),
        )

    @staticmethod
    def _build_selected_lines_sentence(selected_lines) -> str:
        if not selected_lines:
            return ""
        line_texts = [line.text for line in selected_lines if line and line.text]
        if not line_texts:
            return ""
        try:
            combined_lines = combine_dialogue(line_texts)
            if combined_lines:
                return "".join(combined_lines)
        except Exception as e:
            logger.debug(f"Failed to combine multi-line dialogue for translation, falling back to join: {e}")
        return get_config().advanced.multi_line_line_break.join(line_texts)

    @staticmethod
    def _sentence_covers_selected_lines(sentence: str, selected_lines) -> bool:
        if not sentence or not selected_lines:
            return False
        normalized_sentence = remove_html_and_cloze_tags(sentence).replace("\r", "").replace("\n", "").strip()
        if not normalized_sentence:
            return False
        for line in selected_lines:
            line_text = (
                remove_html_and_cloze_tags(line.text if line else "").replace("\r", "").replace("\n", "").strip()
            )
            if line_text and line_text not in normalized_sentence:
                return False
        return True

    @staticmethod
    def _resolve_sentence_for_translation(note, last_note, selected_lines) -> str:
        sentence_field_name = get_config().anki.sentence_field
        note_sentence = note["fields"].get(sentence_field_name, "") if note else ""
        if selected_lines:
            if ReplayAudioExtractor._sentence_covers_selected_lines(note_sentence, selected_lines):
                return note_sentence
            last_sentence = last_note.get_field(sentence_field_name) if last_note else ""
            if ReplayAudioExtractor._sentence_covers_selected_lines(last_sentence, selected_lines):
                return last_sentence
            return ReplayAudioExtractor._build_selected_lines_sentence(selected_lines)
        if note_sentence:
            return note_sentence
        return last_note.get_field(sentence_field_name) if last_note else ""

    def process_replay(self, video_path: str) -> None:
        context = ReplayProcessingContext(video_path=video_path)
        gsm_state.current_replay = video_path
        gsm_state.current_replay_context = context
        if gsm_state.line_for_audio or gsm_state.line_for_screenshot or gsm_state.line_for_video_trim:
            _handle_texthooker_button(video_path)
            return
        try:
            if anki.card_queue and len(anki.card_queue) > 0:
                (
                    context.last_note,
                    context.anki_card_creation_time,
                    context.selected_lines,
                    context.mined_line,
                ) = anki.card_queue.pop(0)
            else:
                logger.info("Replay buffer initiated externally. Skipping processing.")
                context.skip_delete = True
                return

            # Just for safety
            if not context.last_note:
                if get_config().anki.update_anki:
                    context.last_note = anki.get_last_anki_card()

            context.note, context.last_note = anki.get_initial_card_info(
                context.last_note,
                context.selected_lines,
                game_line=context.mined_line,
                generate_furigana=not get_config().anki.show_update_confirmation_dialog_v2,
            )
            context.tango = context.last_note.get_field(get_config().anki.word_field) if context.last_note else ""
            context.word_being_processed = context.tango

            # Get Info of line mined
            context.sentence_for_translation = self._resolve_sentence_for_translation(
                context.note,
                context.last_note,
                context.selected_lines,
            )
            if context.selected_lines:
                context.start_line = context.selected_lines[0]
                context.line_cutoff = context.selected_lines[-1].get_next_time()
                context.full_text = remove_html_and_cloze_tags(context.sentence_for_translation)
            else:
                if context.mined_line:
                    context.start_line = context.mined_line
                    if context.mined_line.next_line():
                        context.line_cutoff = context.mined_line.next_line().time
                    context.full_text = context.mined_line.text

            gsm_state.last_mined_line = context.mined_line

            if os.path.exists(video_path) and os.access(video_path, os.R_OK):
                logger.debug(f"Video found and is readable: {video_path}")

            if context.last_note:
                logger.debug(context.last_note.pretty_print())

            context.ss_timing = ffmpeg.get_screenshot_time(
                video_path,
                context.mined_line,
                doing_multi_line=bool(context.selected_lines),
                anki_card_creation_time=context.anki_card_creation_time,
            )

            with ThreadPoolExecutor(max_workers=3, thread_name_prefix="gsm-card-prep") as executor:
                audio_future = None
                media_future = None
                translation_future = None

                if get_config().anki.sentence_audio_field and get_config().audio.enabled:
                    logger.debug("Attempting to get audio from video")
                    audio_future = executor.submit(
                        self.get_audio,
                        context.start_line,
                        context.line_cutoff,
                        video_path,
                        context.anki_card_creation_time,
                        mined_line=context.mined_line,
                        full_text=context.full_text,
                    )
                else:
                    context.audio_result = ReplayAudioResult(
                        final_audio_output="",
                        vad_result=VADResult(True, 0, 0, ""),
                        vad_trimmed_audio="",
                        start_time=0.0,
                        end_time=0.0,
                        audio_edit_context=None,
                    )
                    if not get_config().audio.enabled:
                        logger.info("Audio is disabled in config, skipping audio processing!")
                    elif not get_config().anki.sentence_audio_field:
                        logger.info("No SentenceAudio Field in config, skipping audio processing!")

                if get_config().anki.update_anki and context.last_note:
                    media_future = executor.submit(
                        anki.prefetch_media_assets_for_card,
                        game_line=context.mined_line,
                        video_path=video_path,
                        ss_time=context.ss_timing,
                        selected_lines=context.selected_lines,
                    )
                    if get_config().ai.add_to_anki:
                        translation_future = executor.submit(
                            anki.prefetch_ai_translation,
                            context.sentence_for_translation,
                            context.mined_line,
                        )

                if audio_future:
                    context.audio_result = audio_future.result()
                    gsm_state.audio_edit_context = context.audio_edit_context
                    resolved_audio_output = context.final_audio_output or (
                        context.vad_result.output_audio if context.vad_result else ""
                    )
                    if context.vad_result and resolved_audio_output and not context.vad_result.output_audio:
                        context.vad_result.output_audio = resolved_audio_output
                    if resolved_audio_output and not os.path.isfile(resolved_audio_output):
                        reason = f"Audio path returned for the Anki card, but the file does not exist: {resolved_audio_output}"
                        logger.warning(reason)
                        _notify_anki_enhancement_failure(reason)
                        resolved_audio_output = ""
                    if (
                        context.vad_result
                        and context.vad_result.output_audio
                        and not os.path.isfile(context.vad_result.output_audio)
                    ):
                        reason = f"VAD output audio path does not exist: {context.vad_result.output_audio}"
                        logger.warning(reason)
                        _notify_anki_enhancement_failure(reason)
                        context.vad_result.output_audio = ""
                    if resolved_audio_output != context.final_audio_output:
                        context.audio_result.final_audio_output = resolved_audio_output
                else:
                    gsm_state.audio_edit_context = None

                if media_future:
                    try:
                        context.prefetched_assets = media_future.result()
                    except Exception as e:
                        logger.exception(f"Failed prefetching media assets, falling back to normal generation: {e}")
                        context.prefetched_assets = None
                    if context.prefetched_assets and get_config().anki.show_update_confirmation_dialog_v2:
                        try:
                            anki.prefetch_animated_screenshot_for_confirmation(
                                context.prefetched_assets,
                                video_path,
                                context.start_time,
                                context.vad_result,
                            )
                        except Exception as e:
                            logger.exception(f"Failed to start animated screenshot prefetch early: {e}")

                if translation_future:
                    try:
                        context.prefetched_translation = translation_future.result()
                    except Exception as e:
                        logger.exception(f"Failed prefetching AI translation, falling back to sync translation: {e}")
                        context.prefetched_translation = None

            if get_config().anki.update_anki and context.last_note:
                context.background_update_started = bool(
                    anki.update_anki_card(
                        context.last_note,
                        context.note,
                        audio_path=context.final_audio_output,
                        video_path=video_path,
                        tango=context.tango,
                        should_update_audio=bool(
                            context.final_audio_output and os.path.isfile(context.final_audio_output)
                        ),
                        ss_time=context.ss_timing,
                        game_line=context.mined_line,
                        selected_lines=context.selected_lines,
                        start_time=context.start_time,
                        end_time=context.end_time,
                        vad_result=context.vad_result,
                        precomputed_assets=context.prefetched_assets,
                        precomputed_translation=context.prefetched_translation,
                    )
                )
            elif get_config().features.notify_on_update and context.vad_result and context.vad_result.success:
                from GameSentenceMiner.util.platform import notification

                notification.send_audio_generated_notification(context.vad_trimmed_audio)
        except Exception as e:
            reason = f"Failed processing replay for Anki note enhancement: {e}"
            if context.mined_line:
                anki_results[context.mined_line.id] = AnkiUpdateResult.failure(reason=reason, word=context.tango)
            logger.exception(f"Failed Processing and/or adding to Anki: Reason {e}")
            logger.debug(
                f"Some error was hit catching to allow further work to be done: {e}",
                exc_info=True,
            )
            _notify_anki_enhancement_failure(reason)
        finally:
            if context.word_being_processed and not context.background_update_started:
                gsm_status.remove_word_being_processed(context.word_being_processed)
        if get_config().paths.remove_video and video_path and not context.skip_delete:
            # Don't remove video here if we have pending animated/video operations
            # The cleanup callback in anki.py will handle it after background processing
            from GameSentenceMiner.util import pending_reviews

            if video_path in gsm_state.videos_with_pending_operations:
                logger.debug(f"Video cleanup deferred to background thread for: {video_path}")
            elif pending_reviews.is_video_pinned_for_review(video_path):
                logger.debug(f"Video pinned by Pending Reviews queue, not deleting: {video_path}")
            else:
                try:
                    if os.path.exists(video_path):
                        logger.debug(f"Removing video: {video_path}")
                        os.remove(video_path)
                except Exception as e:
                    logger.exception(f"Error removing video file {video_path}: {e}")

    @staticmethod
    def get_audio(
        game_line,
        next_line_time,
        video_path: str,
        anki_card_creation_time=None,
        temporary: bool = False,
        use_vad_postprocessing: bool = True,
        timing_only: bool = False,
        mined_line=None,
        full_text: str = "",
    ) -> ReplayAudioResult | VADResult | str:
        source_audio_path, trimmed_audio, start_time, end_time = get_audio_and_trim(
            video_path, game_line, next_line_time, anki_card_creation_time
        )
        if temporary:
            temporary_audio = ffmpeg.convert_audio_to_wav_lossless(trimmed_audio)
            if (
                not use_vad_postprocessing
                or not get_config().vad.do_vad_postprocessing
                or not vad_processor.initialized
            ):
                return temporary_audio

            try:
                vad_output_path = make_unique_file_name(
                    os.path.join(
                        get_temporary_directory(),
                        f"{obs.get_current_game(sanitize=True)}_texthooker.{get_config().audio.extension}",
                    )
                )
                vad_result = vad_processor.trim_audio_with_vad(
                    temporary_audio,
                    vad_output_path,
                    game_line,
                    full_text,
                )
                candidate_output = vad_result.output_audio if vad_result else ""
                if candidate_output and os.path.isfile(candidate_output):
                    return candidate_output
            except Exception as e:
                logger.warning(f"Temporary VAD trim failed for texthooker audio, using untrimmed audio: {e}")
            return temporary_audio

        if not get_config().vad.do_vad_postprocessing or not vad_processor.initialized:
            if not vad_processor.initialized:
                logger.warning("VAD Processor not initialized, skipping VAD processing.")
            final_audio_output = trimmed_audio if os.path.exists(trimmed_audio) else ""
            if not final_audio_output:
                _notify_anki_enhancement_failure(
                    f"Failed to create trimmed audio for the Anki card from replay: {trimmed_audio}"
                )
            return ReplayAudioResult(
                final_audio_output=final_audio_output,
                vad_result=VADResult(
                    True,
                    start_time,
                    end_time,
                    "No VAD",
                    output_audio=final_audio_output,
                ),
                vad_trimmed_audio=final_audio_output,
                start_time=start_time,
                end_time=end_time,
                audio_edit_context=ReplayAudioExtractor._build_audio_edit_context(
                    source_audio_path,
                    start_time,
                    end_time,
                    None,
                ),
            )

        vad_trimmed_audio = make_unique_file_name(
            f"{os.path.abspath(configuration.get_temporary_directory())}/{obs.get_current_game(sanitize=True)}.{get_config().audio.extension}"
        )
        final_audio_output = ""

        vad_result = vad_processor.trim_audio_with_vad(trimmed_audio, vad_trimmed_audio, game_line, full_text)
        if vad_result and vad_result.success and not getattr(vad_result, "trimmed_audio_path", None):
            vad_result.trimmed_audio_path = trimmed_audio
        if timing_only:
            return vad_result

        if not vad_result.success:
            # Store the trimmed audio path so it can be offered to the user in the confirmation dialog
            if get_config().anki.show_update_confirmation_dialog_v2:
                vad_result.trimmed_audio_path = trimmed_audio
                if os.path.exists(trimmed_audio):
                    final_audio_output = trimmed_audio
            if get_config().vad.add_audio_on_no_results:
                logger.info("No voice activity detected, using full audio.")
                if os.path.exists(trimmed_audio):
                    final_audio_output = trimmed_audio
                    vad_result.output_audio = trimmed_audio
                    vad_result.success = True
                else:
                    reason = f"Expected trimmed audio file does not exist: {trimmed_audio}"
                    logger.warning(reason)
                    _notify_anki_enhancement_failure(reason)
            elif get_config().vad.use_tts_as_fallback:
                try:
                    logger.info("No voice activity detected, using TTS as fallback.")
                    text_to_tts = full_text if full_text else game_line.text
                    url = get_config().vad.tts_url.replace("$s", text_to_tts)
                    tts_resp = requests.get(url)
                    if not tts_resp.ok:
                        logger.error(
                            f"Error fetching TTS audio from {url}. Is it running?: {tts_resp.status_code} {tts_resp.text}"
                        )
                    with tempfile.NamedTemporaryFile(
                        dir=get_temporary_directory(),
                        prefix=f"{obs.get_current_game(sanitize=True)}_tts_",
                        delete=False,
                        suffix=".opus",
                    ) as tmpfile:
                        tmpfile.write(tts_resp.content)
                        vad_result.output_audio = tmpfile.name
                        vad_result.tts_used = True
                        vad_result.success = True
                        final_audio_output = tmpfile.name
                except Exception as e:
                    logger.exception(f"Failed to fetch TTS audio: {e}")
                    vad_result.success = False
                    vad_result.output_audio = ""
                    _notify_anki_enhancement_failure(f"Failed to fetch TTS fallback audio for the Anki card: {e}")
            else:
                _notify_anki_enhancement_failure(
                    "No voice activity detected for the Anki card audio, and no fallback audio was configured."
                )
        else:
            logger.info(vad_result.trim_successful_string())

        if vad_result.output_audio and os.path.exists(vad_result.output_audio):
            final_audio_output = vad_result.output_audio

        if final_audio_output and os.path.exists(final_audio_output):
            vad_trimmed_audio = final_audio_output
            if vad_result and vad_result.output_audio and not os.path.exists(vad_result.output_audio):
                vad_result.output_audio = final_audio_output
        else:
            vad_reported_output = getattr(vad_result, "output_audio", "") if vad_result else ""
            if vad_reported_output:
                reason = f"VAD reported an output audio path, but the file does not exist: {vad_reported_output}"
                logger.warning(reason)
                _notify_anki_enhancement_failure(reason)
            elif vad_result and getattr(vad_result, "success", False):
                reason = "VAD reported success but no usable audio file was produced; continuing without audio."
                logger.warning(reason)
                _notify_anki_enhancement_failure(reason)
            vad_trimmed_audio = ""

        if final_audio_output and not os.path.isfile(final_audio_output):
            logger.warning(f"Final audio output path is not a file: {final_audio_output}")
            final_audio_output = ""
            if vad_result:
                vad_result.output_audio = ""
        return ReplayAudioResult(
            final_audio_output=final_audio_output,
            vad_result=vad_result,
            vad_trimmed_audio=vad_trimmed_audio,
            start_time=start_time,
            end_time=end_time,
            audio_edit_context=ReplayAudioExtractor._build_audio_edit_context(
                source_audio_path,
                start_time,
                end_time,
                vad_result,
            ),
        )


class ReplayFileWatcher(FileSystemEventHandler):
    def __init__(self, extractor: ReplayAudioExtractor):
        super().__init__()
        self._extractor = extractor

    def on_created(self, event):
        file_name = os.path.basename(event.src_path)
        if event.is_directory:
            return
        if "Replay" not in file_name and "GSM" not in file_name:
            return
        if file_name.endswith(".mkv") or file_name.endswith(".mp4"):
            logger.info(f"MKV {event.src_path} FOUND, RUNNING LOGIC")
            wait_for_stable_file(event.src_path)
            self._extractor.process_replay(event.src_path)
