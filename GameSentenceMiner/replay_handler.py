import os
import shutil
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Optional

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
from GameSentenceMiner.util.gsm_utils import make_unique_file_name, remove_html_and_cloze_tags, wait_for_stable_file
from GameSentenceMiner.util.media import ffmpeg
from GameSentenceMiner.util.media.ffmpeg import get_audio_and_trim
from GameSentenceMiner.util.models.model import VADResult
from GameSentenceMiner.vad import vad_processor
from GameSentenceMiner.web.service import handle_texthooker_button


@dataclass
class ReplayAudioResult:
    final_audio_output: str
    vad_result: VADResult
    vad_trimmed_audio: str
    start_time: float
    end_time: float


class ReplayAudioExtractor:
    def process_replay(self, video_path: str) -> None:
        gsm_state.current_replay = video_path
        vad_trimmed_audio = ""
        final_audio_output = ""
        skip_delete = False
        selected_lines = []
        anki_card_creation_time = None
        mined_line = None
        start_time = 0
        end_time = 0
        word_being_processed = ""
        background_update_started = False
        if gsm_state.line_for_audio or gsm_state.line_for_screenshot:
            handle_texthooker_button(video_path)
            return
        try:
            if anki.card_queue and len(anki.card_queue) > 0:
                last_note, anki_card_creation_time, selected_lines, mined_line = anki.card_queue.pop(0)
            else:
                logger.info("Replay buffer initiated externally. Skipping processing.")
                skip_delete = True
                return

            # Just for safety
            if not last_note:
                if get_config().anki.update_anki:
                    last_note = anki.get_last_anki_card()

            note, last_note = anki.get_initial_card_info(last_note, selected_lines, game_line=mined_line)
            tango = last_note.get_field(get_config().anki.word_field) if last_note else ""
            word_being_processed = tango

            # Get Info of line mined
            line_cutoff = None
            start_line = None
            full_text = ""
            if selected_lines:
                start_line = selected_lines[0]
                line_cutoff = selected_lines[-1].get_next_time()
                sentence_field_name = get_config().anki.sentence_field
                sentence_for_audio = note["fields"].get(sentence_field_name) or (
                    last_note.get_field(sentence_field_name) if last_note else ""
                )
                full_text = remove_html_and_cloze_tags(sentence_for_audio)
            else:
                if mined_line:
                    start_line = mined_line
                    if mined_line.next_line():
                        line_cutoff = mined_line.next_line().time
                    full_text = mined_line.text

            gsm_state.last_mined_line = mined_line

            if os.path.exists(video_path) and os.access(video_path, os.R_OK):
                logger.debug(f"Video found and is readable: {video_path}")

            if last_note:
                logger.debug(last_note.pretty_print())

            ss_timing = ffmpeg.get_screenshot_time(
                video_path,
                mined_line,
                doing_multi_line=bool(selected_lines),
                anki_card_creation_time=anki_card_creation_time,
            )

            prefetched_assets = None
            prefetched_translation = None
            with ThreadPoolExecutor(max_workers=3, thread_name_prefix="gsm-card-prep") as executor:
                audio_future = None
                media_future = None
                translation_future = None

                if get_config().anki.sentence_audio_field and get_config().audio.enabled:
                    logger.debug("Attempting to get audio from video")
                    audio_future = executor.submit(
                        self.get_audio,
                        start_line,
                        line_cutoff,
                        video_path,
                        anki_card_creation_time,
                        mined_line=mined_line,
                        full_text=full_text,
                    )
                else:
                    final_audio_output = ""
                    vad_result = VADResult(True, 0, 0, "")
                    vad_trimmed_audio = ""
                    if not get_config().audio.enabled:
                        logger.info("Audio is disabled in config, skipping audio processing!")
                    elif not get_config().anki.sentence_audio_field:
                        logger.info("No SentenceAudio Field in config, skipping audio processing!")

                if get_config().anki.update_anki and last_note:
                    media_future = executor.submit(
                        anki.prefetch_media_assets_for_card,
                        game_line=mined_line,
                        video_path=video_path,
                        ss_time=ss_timing,
                        selected_lines=selected_lines,
                    )
                    if get_config().ai.add_to_anki:
                        sentence_to_translate = note["fields"].get(
                            get_config().anki.sentence_field, ""
                        ) or last_note.get_field(get_config().anki.sentence_field)
                        translation_future = executor.submit(
                            anki.prefetch_ai_translation,
                            sentence_to_translate,
                            mined_line,
                        )

                if audio_future:
                    audio_result = audio_future.result()
                    final_audio_output = audio_result.final_audio_output
                    vad_result = audio_result.vad_result
                    vad_trimmed_audio = audio_result.vad_trimmed_audio
                    start_time = audio_result.start_time
                    end_time = audio_result.end_time

                if media_future:
                    try:
                        prefetched_assets = media_future.result()
                    except Exception as e:
                        logger.exception(f"Failed prefetching media assets, falling back to normal generation: {e}")
                        prefetched_assets = None

                if translation_future:
                    try:
                        prefetched_translation = translation_future.result()
                    except Exception as e:
                        logger.exception(f"Failed prefetching AI translation, falling back to sync translation: {e}")
                        prefetched_translation = None

            if get_config().anki.update_anki and last_note:
                background_update_started = bool(anki.update_anki_card(
                    last_note,
                    note,
                    audio_path=final_audio_output,
                    video_path=video_path,
                    tango=tango,
                    should_update_audio=vad_result.output_audio,
                    ss_time=ss_timing,
                    game_line=mined_line,
                    selected_lines=selected_lines,
                    start_time=start_time,
                    end_time=end_time,
                    vad_result=vad_result,
                    precomputed_assets=prefetched_assets,
                    precomputed_translation=prefetched_translation,
                ))
            elif get_config().features.notify_on_update and vad_result.success:
                from GameSentenceMiner.util.platform import notification

                notification.send_audio_generated_notification(vad_trimmed_audio)
        except Exception as e:
            if mined_line:
                anki_results[mined_line.id] = AnkiUpdateResult.failure()
            logger.exception(f"Failed Processing and/or adding to Anki: Reason {e}")
            logger.debug(
                f"Some error was hit catching to allow further work to be done: {e}", exc_info=True
            )
            from GameSentenceMiner.util.platform import notification

            notification.send_error_no_anki_update()
        finally:
            if word_being_processed and not background_update_started:
                gsm_status.remove_word_being_processed(word_being_processed)
        if get_config().paths.remove_video and video_path and not skip_delete:
            # Don't remove video here if we have pending animated/video operations
            # The cleanup callback in anki.py will handle it after background processing
            if video_path in gsm_state.videos_with_pending_operations:
                logger.debug(f"Video cleanup deferred to background thread for: {video_path}")
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
        timing_only: bool = False,
        mined_line=None,
        full_text: str = "",
    ) -> ReplayAudioResult | VADResult | str:
        trimmed_audio, start_time, end_time = get_audio_and_trim(
            video_path, game_line, next_line_time, anki_card_creation_time
        )
        if temporary:
            return ffmpeg.convert_audio_to_wav_lossless(trimmed_audio)
        final_audio_output = make_unique_file_name(
            os.path.join(get_temporary_directory(), f"{obs.get_current_game(sanitize=True)}.{get_config().audio.extension}")
        )
        if not get_config().vad.do_vad_postprocessing or not vad_processor.initialized:
            if not vad_processor.initialized:
                logger.warning("VAD Processor not initialized, skipping VAD processing.")
            if get_config().audio.ffmpeg_reencode_options_to_use and os.path.exists(trimmed_audio):
                ffmpeg.reencode_file_with_user_config(
                    trimmed_audio,
                    final_audio_output,
                    get_config().audio.ffmpeg_reencode_options_to_use,
                )
            else:
                shutil.move(trimmed_audio, final_audio_output)
            return ReplayAudioResult(
                final_audio_output=final_audio_output,
                vad_result=VADResult(True, start_time, end_time, "No VAD", output_audio=final_audio_output),
                vad_trimmed_audio=trimmed_audio,
                start_time=start_time,
                end_time=end_time,
            )

        vad_trimmed_audio = make_unique_file_name(
            f"{os.path.abspath(configuration.get_temporary_directory())}/{obs.get_current_game(sanitize=True)}.{get_config().audio.extension}"
        )

        vad_result = vad_processor.trim_audio_with_vad(trimmed_audio, vad_trimmed_audio, game_line, full_text)
        if timing_only:
            return vad_result

        if not vad_result.success:
            # Store the trimmed audio path so it can be offered to the user in the confirmation dialog
            if get_config().anki.show_update_confirmation_dialog_v2:
                if get_config().audio.ffmpeg_reencode_options_to_use and os.path.exists(trimmed_audio):
                    ffmpeg.reencode_file_with_user_config(
                        trimmed_audio,
                        final_audio_output,
                        get_config().audio.ffmpeg_reencode_options_to_use,
                    )
                else:
                    shutil.move(trimmed_audio, final_audio_output)
                vad_result.trimmed_audio_path = final_audio_output
            if get_config().vad.add_audio_on_no_results:
                logger.info("No voice activity detected, using full audio.")
                if get_config().audio.ffmpeg_reencode_options_to_use and os.path.exists(trimmed_audio):
                    ffmpeg.reencode_file_with_user_config(
                        trimmed_audio,
                        final_audio_output,
                        get_config().audio.ffmpeg_reencode_options_to_use,
                    )
                else:
                    shutil.move(trimmed_audio, final_audio_output)
                vad_result.output_audio = final_audio_output
                vad_result.success = True
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
                except Exception as e:
                    logger.exception(f"Failed to fetch TTS audio: {e}")
                    vad_result.success = False
                    vad_result.output_audio = ""
        else:
            logger.info(vad_result.trim_successful_string())

        if vad_result.output_audio:
            vad_trimmed_audio = vad_result.output_audio

        if os.path.exists(vad_trimmed_audio):
            if get_config().audio.ffmpeg_reencode_options_to_use:
                ffmpeg.reencode_file_with_user_config(
                    vad_trimmed_audio,
                    final_audio_output,
                    get_config().audio.ffmpeg_reencode_options_to_use,
                )
            elif os.path.abspath(vad_trimmed_audio) != os.path.abspath(final_audio_output):
                shutil.move(vad_trimmed_audio, final_audio_output)
            vad_result.output_audio = final_audio_output
        return ReplayAudioResult(
            final_audio_output=final_audio_output,
            vad_result=vad_result,
            vad_trimmed_audio=vad_trimmed_audio,
            start_time=start_time,
            end_time=end_time,
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
