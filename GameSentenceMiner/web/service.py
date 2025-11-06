import os
import shlex
import shutil
import subprocess
import threading


from GameSentenceMiner import anki
from GameSentenceMiner.util import ffmpeg, notification
from GameSentenceMiner.util.configuration import gsm_state, logger, get_config, get_temporary_directory
from GameSentenceMiner.util.ffmpeg import get_video_timings
from GameSentenceMiner.util.text_log import GameLine
from GameSentenceMiner.util.audio_player import AudioPlayer


def set_get_audio_from_video_callback(func):
    global get_audio_from_video
    get_audio_from_video = func


# Global audio player instance
_audio_player = None


def get_audio_player():
    """Get or create the global audio player instance."""
    global _audio_player
    if _audio_player is None:
        _audio_player = AudioPlayer(finished_callback=_on_audio_finished)
    return _audio_player


def _on_audio_finished():
    """Callback when audio playback finishes."""
    # Clear the current audio stream reference from gsm_state
    gsm_state.current_audio_stream = None


def stop_current_audio():
    """Stop the currently playing audio."""
    player = get_audio_player()
    player.stop_audio()
    gsm_state.current_audio_stream = None


def play_audio_data_safe(data, samplerate):
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
    return success


def handle_texthooker_button(video_path=''):
    try:
        if gsm_state.line_for_audio:
            # Check if audio is currently playing and stop it
            if gsm_state.current_audio_stream:
                stop_current_audio()
                gsm_state.line_for_audio = None
                return
                
            line: GameLine = gsm_state.line_for_audio
            gsm_state.line_for_audio = None
            
            if line == gsm_state.previous_line_for_audio:
                logger.info("Line is the same as the last one, skipping processing.")
                if get_config().advanced.video_player_path:
                    play_video_in_external(line, video_path)
                else:
                    # Use cached audio data with safe playback
                    if gsm_state.previous_audio:
                        data, samplerate = gsm_state.previous_audio
                        play_audio_data_safe(data, samplerate)
                return
                
            gsm_state.previous_line_for_audio = line
            
            if get_config().advanced.video_player_path:
                play_video_in_external(line, video_path)
            else:
                # Extract audio and play with safe method
                import soundfile as sf
                audio = get_audio_from_video(line, line.next.time if line.next else None, video_path,
                                             temporary=True)
                data, samplerate = sf.read(audio)
                data = data.astype('float32')
                
                # Use safe audio playback
                success = play_audio_data_safe(data, samplerate)
                if success:
                    gsm_state.previous_audio = (data, samplerate)
            return
            
        if gsm_state.line_for_screenshot:
            line: GameLine = gsm_state.line_for_screenshot
            gsm_state.line_for_screenshot = None
            gsm_state.previous_line_for_screenshot = line
            screenshot = ffmpeg.get_screenshot_for_line(video_path, line, True)
            if gsm_state.anki_note_for_screenshot:
                gsm_state.anki_note_for_screenshot = None
                encoded_image = ffmpeg.process_image(screenshot)
                if get_config().anki.update_anki and get_config().screenshot.screenshot_hotkey_updates_anki:
                    last_note = anki.get_last_anki_card()
                    if last_note:
                        anki.add_image_to_card(last_note, encoded_image)
                        notification.send_screenshot_updated(last_note.get_field(get_config().anki.word_field))
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
        logger.error(f"Error Playing Audio/Video: {e}", exc_info=True)
        return
    finally:
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
            command.extend(["--start-time", str(start), '--one-instance'])
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
        