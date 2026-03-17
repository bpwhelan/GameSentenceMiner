import asyncio
import os
import secrets
import shlex
import subprocess

from GameSentenceMiner import anki
from GameSentenceMiner.util.config.configuration import gsm_state, logger, get_config
from GameSentenceMiner.util.media import ffmpeg
from GameSentenceMiner.util.media.audio_player import AudioPlayer
from GameSentenceMiner.util.media.ffmpeg import get_video_timings
from GameSentenceMiner.util.platform import notification
from GameSentenceMiner.util.text_log import GameLine


def set_get_audio_from_video_callback(func):
    global get_audio_from_video
    get_audio_from_video = func


# Global audio player instance
_audio_player = None
_MAX_TEXTHOOKER_AUDIO_ASSETS = 16


def get_audio_player():
    """Get or create the global audio player instance."""
    global _audio_player
    if _audio_player is None:
        _audio_player = AudioPlayer(finished_callback=_on_audio_finished)
    return _audio_player


def _send_texthooker_audio_event(event_name: str, **payload):
    try:
        from GameSentenceMiner.web.gsm_websocket import websocket_manager, ID_HOOKER

        event_payload = {"event": event_name, **payload}

        async def _send():
            await websocket_manager.send(ID_HOOKER, event_payload)

        try:
            running_loop = asyncio.get_running_loop()
            running_loop.create_task(_send())
        except RuntimeError:
            asyncio.run(_send())
    except Exception as e:
        logger.debug(f"Failed to send texthooker audio event '{event_name}': {e}")


def _register_texthooker_audio_asset(audio_path: str, line_id: str) -> str:
    if not audio_path or not os.path.isfile(audio_path):
        return ""

    token = secrets.token_urlsafe(12)
    assets = gsm_state.texthooker_audio_assets
    assets[token] = audio_path
    gsm_state.texthooker_audio_token = token
    gsm_state.texthooker_audio_line_id = line_id

    # Keep only the most recent N entries and drop stale paths.
    stale_tokens = []
    for existing_token, existing_path in assets.items():
        if not os.path.isfile(existing_path):
            stale_tokens.append(existing_token)
    for stale_token in stale_tokens:
        assets.pop(stale_token, None)

    while len(assets) > _MAX_TEXTHOOKER_AUDIO_ASSETS:
        oldest_token = next(iter(assets))
        assets.pop(oldest_token, None)

    return token


def _emit_audio_ready_event(line_id: str, audio_path: str):
    token = _register_texthooker_audio_asset(audio_path, line_id)
    if not token:
        _send_texthooker_audio_event(
            "audio_error", line_id=line_id, error="Audio file not found."
        )
        return
    _send_texthooker_audio_event(
        "audio_ready",
        line_id=line_id,
        audio_url=f"/texthooker/audio/{token}",
    )


def _audio_cache_key(line_id: str, trim_with_vad: bool) -> str:
    return f"{line_id}|vad={int(bool(trim_with_vad))}"


def _remember_previous_audio_variant(
    line_id: str, trim_with_vad: bool, audio_path: str = ""
):
    gsm_state.previous_audio_cache_key = _audio_cache_key(line_id, trim_with_vad)
    if audio_path:
        gsm_state.previous_audio_path = audio_path


def _get_cached_audio_path(line_id: str, trim_with_vad: bool) -> str:
    key = _audio_cache_key(line_id, trim_with_vad)
    audio_path = gsm_state.texthooker_audio_cache.get(key, "")
    if audio_path and os.path.isfile(audio_path):
        return audio_path
    if key in gsm_state.texthooker_audio_cache:
        gsm_state.texthooker_audio_cache.pop(key, None)
    return ""


def cache_texthooker_audio_path(line_id: str, trim_with_vad: bool, audio_path: str):
    if audio_path and os.path.isfile(audio_path):
        gsm_state.texthooker_audio_cache[_audio_cache_key(line_id, trim_with_vad)] = (
            audio_path
        )


def has_cached_texthooker_audio(line_id: str, trim_with_vad: bool = False) -> bool:
    return bool(_get_cached_audio_path(line_id, trim_with_vad))


def _play_audio_from_file(audio_path: str, line_id: str) -> bool:
    if not audio_path or not os.path.isfile(audio_path):
        return False

    import soundfile as sf

    data, samplerate = sf.read(audio_path)
    data = data.astype("float32")
    success = play_audio_data_safe(data, samplerate, line_id)
    if success:
        gsm_state.previous_audio = (data, samplerate)
    return success


def _on_audio_finished():
    """Callback when audio playback finishes."""
    # Clear the current audio stream reference from gsm_state
    gsm_state.current_audio_stream = None
    current_line_id = gsm_state.current_audio_line_id
    gsm_state.current_audio_line_id = None
    if current_line_id:
        _send_texthooker_audio_event(
            "audio_state", state="stopped", line_id=current_line_id
        )


def stop_current_audio():
    """Stop the currently playing audio."""
    player = get_audio_player()
    player.stop_audio()
    gsm_state.current_audio_stream = None
    stopped_line_id = gsm_state.current_audio_line_id
    gsm_state.current_audio_line_id = None
    if stopped_line_id:
        _send_texthooker_audio_event(
            "audio_state", state="stopped", line_id=stopped_line_id
        )


def play_audio_data_safe(data, samplerate, line_id: str = ""):
    """
    Play audio data using the safe audio player.

    Args:
        data: Audio data as numpy array
        samplerate: Sample rate of the audio

    Returns:
        True if playback started successfully, False otherwise
    """
    player = get_audio_player()
    success = player.play_audio_data(data, samplerate)
    if success:
        # Store reference in gsm_state for compatibility
        gsm_state.current_audio_stream = player.current_audio_stream
        gsm_state.current_audio_line_id = line_id
        if line_id:
            _send_texthooker_audio_event(
                "audio_state", state="playing", line_id=line_id
            )
    return success


def _trim_video_for_line(line: GameLine, video_path: str, trim_with_vad: bool) -> str:
    start_time, end_time, _, _ = get_video_timings(video_path, line)

    if trim_with_vad:
        try:
            vad_result = get_audio_from_video(
                line,
                getattr(line.next, "time", None),
                video_path,
                temporary=False,
                use_vad_postprocessing=True,
                timing_only=True,
                full_text=line.text,
            )
            if vad_result and getattr(vad_result, "success", False):
                start_time = max(0, start_time + float(getattr(vad_result, "start", 0) or 0))
                end_time = max(start_time, start_time + float(getattr(vad_result, "end", 0) or 0))
        except Exception as e:
            logger.warning(f"Failed to compute VAD timings for video trim, using default timings: {e}")

    return ffmpeg.trim_replay_for_gameline(video_path, start_time, end_time, accurate=True)


def handle_texthooker_button(video_path=''):
    try:
        if gsm_state.line_for_audio:
            request = gsm_state.texthooker_audio_request or {}
            playback_mode = request.get("playback_mode", "native")
            trim_with_vad = bool(request.get("trim_with_vad", False))
            use_browser_playback = playback_mode == "browser"
            can_play_from_audio_cache = (
                use_browser_playback or not get_config().advanced.video_player_path
            )

            def get_line_cutoff_time(target_line: GameLine):
                # Texthooker playback should trim at the chronological next line,
                # even if the line was never "mined" into Anki.
                next_line = getattr(target_line, "next", None)
                return next_line.time if next_line else None

            def extract_audio_path(target_line: GameLine) -> str:
                return get_audio_from_video(
                    target_line,
                    get_line_cutoff_time(target_line),
                    video_path,
                    temporary=True,
                    use_vad_postprocessing=trim_with_vad,
                    full_text=target_line.text,
                )

            # Native mode keeps old toggle behavior (click while playing => stop).
            if gsm_state.current_audio_stream:
                if not use_browser_playback:
                    stop_current_audio()
                    gsm_state.line_for_audio = None
                    gsm_state.texthooker_audio_request = {}
                    return
                stop_current_audio()

            line: GameLine = gsm_state.line_for_audio
            gsm_state.line_for_audio = None
            gsm_state.texthooker_audio_request = {}
            cached_audio_path = _get_cached_audio_path(line.id, trim_with_vad)

            if cached_audio_path and can_play_from_audio_cache:
                gsm_state.previous_line_for_audio = line
                _remember_previous_audio_variant(
                    line.id, trim_with_vad, cached_audio_path
                )
                if use_browser_playback:
                    _emit_audio_ready_event(line.id, cached_audio_path)
                else:
                    _play_audio_from_file(cached_audio_path, line.id)
                return

            if line == gsm_state.previous_line_for_audio:
                logger.info("Line is the same as the last one, skipping processing.")

                if get_config().advanced.video_player_path and not use_browser_playback:
                    play_video_in_external(line, video_path)
                elif not use_browser_playback:
                    # Use cached audio data with safe playback
                    if gsm_state.previous_audio and getattr(
                        gsm_state, "previous_audio_cache_key", ""
                    ) == _audio_cache_key(line.id, trim_with_vad):
                        data, samplerate = gsm_state.previous_audio
                        play_audio_data_safe(data, samplerate, line.id)
                    else:
                        audio_path = extract_audio_path(line)
                        _remember_previous_audio_variant(
                            line.id, trim_with_vad, audio_path
                        )
                        if audio_path and os.path.isfile(audio_path):
                            cache_texthooker_audio_path(
                                line.id, trim_with_vad, audio_path
                            )
                            _play_audio_from_file(audio_path, line.id)
                        else:
                            _send_texthooker_audio_event(
                                "audio_error",
                                line_id=line.id,
                                error="Failed to prepare audio.",
                            )
                else:
                    audio_path = extract_audio_path(line)
                    _remember_previous_audio_variant(line.id, trim_with_vad, audio_path)
                    if audio_path and os.path.isfile(audio_path):
                        cache_texthooker_audio_path(line.id, trim_with_vad, audio_path)
                        _emit_audio_ready_event(line.id, audio_path)
                    else:
                        _send_texthooker_audio_event(
                            "audio_error",
                            line_id=line.id,
                            error="Failed to prepare audio.",
                        )
                return

            gsm_state.previous_line_for_audio = line

            if get_config().advanced.video_player_path and not use_browser_playback:
                play_video_in_external(line, video_path)
            else:
                audio_path = extract_audio_path(line)
                _remember_previous_audio_variant(line.id, trim_with_vad, audio_path)
                if not audio_path or not os.path.isfile(audio_path):
                    _send_texthooker_audio_event(
                        "audio_error",
                        line_id=line.id,
                        error="Failed to prepare audio.",
                    )
                    return

                cache_texthooker_audio_path(line.id, trim_with_vad, audio_path)
                if use_browser_playback:
                    _emit_audio_ready_event(line.id, audio_path)
                else:
                    _play_audio_from_file(audio_path, line.id)
            return

        if gsm_state.line_for_video_trim:
            line: GameLine = gsm_state.line_for_video_trim
            request = gsm_state.texthooker_video_trim_request or {}
            trim_with_vad = bool(request.get("trim_with_vad", False))
            show_in_explorer = bool(request.get("show_in_explorer", False))

            gsm_state.line_for_video_trim = None
            gsm_state.texthooker_video_trim_request = {}
            gsm_state.previous_line_for_video_trim = line

            trimmed_video = _trim_video_for_line(line, video_path, trim_with_vad)
            gsm_state.previous_trimmed_video_path = trimmed_video

            if show_in_explorer and trimmed_video and os.path.isfile(trimmed_video):
                try:
                    os.startfile(trimmed_video)
                except AttributeError:
                    logger.info(f"Trimmed video created: {trimmed_video}")
            return


        if gsm_state.line_for_screenshot:
            line: GameLine = gsm_state.line_for_screenshot
            gsm_state.line_for_screenshot = None
            gsm_state.previous_line_for_screenshot = line
            screenshot = ffmpeg.get_screenshot_for_line(video_path, line, True)
            if gsm_state.anki_note_for_screenshot:
                gsm_state.anki_note_for_screenshot = None
                encoded_image = ffmpeg.process_image(screenshot)
                if (
                    get_config().anki.update_anki
                    and get_config().screenshot.screenshot_hotkey_updates_anki
                ):
                    last_note = anki.get_last_anki_card()
                    if last_note:
                        anki.add_image_to_card(last_note, encoded_image)
                        notification.send_screenshot_updated(
                            last_note.get_field(get_config().anki.word_field)
                        )
                        if get_config().features.open_anki_edit:
                            notification.open_anki_card(last_note.noteId)
                    else:
                        notification.send_screenshot_saved(encoded_image)
                else:
                    notification.send_screenshot_saved(encoded_image)
            else:
                os.startfile(screenshot)
            return
    except Exception as e:
        logger.exception(f"Error Playing Audio/Video: {e}")
        return
    finally:
        if video_path:
            gsm_state.previous_replay = video_path
            gsm_state.videos_to_remove.add(video_path)


def play_audio_in_external(filepath):
    exe = get_config().advanced.audio_player_path

    filepath = os.path.normpath(filepath)

    command = [exe, "--no-video", filepath]

    try:
        subprocess.Popen(command)
        print(f"Opened {filepath} in {exe}.")
    except Exception as e:
        print(f"An error occurred: {e}")


def play_video_in_external(line, filepath):
    command = [get_config().advanced.video_player_path]

    start, _, _, _ = get_video_timings(filepath, line)

    if start:
        if "vlc" in get_config().advanced.video_player_path.lower():
            # VLC uses --start-time with seconds (float or int)
            command.extend(["--start-time", str(start), "--one-instance"])
        else:
            # MPV and most other players use --start with seconds
            command.extend([f"--start={start}"])
    command.append(os.path.normpath(filepath))

    # Use shlex.join for proper shell-escaped logging (runnable command)
    logger.info(shlex.join(command))

    try:
        subprocess.Popen(command)
        logger.info(f"Opened {filepath} in {get_config().advanced.video_player_path}.")
    except FileNotFoundError:
        logger.error("VLC not found. Make sure it's installed and in your PATH.")
    except Exception as e:
        logger.error(f"An error occurred: {e}")
