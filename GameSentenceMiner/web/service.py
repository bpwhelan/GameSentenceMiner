import os
import shutil
import subprocess
import threading


from GameSentenceMiner import anki
from GameSentenceMiner.util import ffmpeg, notification
from GameSentenceMiner.util.configuration import gsm_state, logger, get_config, get_temporary_directory
from GameSentenceMiner.util.ffmpeg import get_video_timings
from GameSentenceMiner.util.text_log import GameLine


def set_get_audio_from_video_callback(func):
    global get_audio_from_video
    get_audio_from_video = func


def handle_texthooker_button(video_path=''):
    try:
        if gsm_state.line_for_audio:
            line: GameLine = gsm_state.line_for_audio
            gsm_state.line_for_audio = None
            if line == gsm_state.previous_line_for_audio:
                logger.info("Line is the same as the last one, skipping processing.")
                if get_config().advanced.audio_player_path:
                    play_audio_in_external(gsm_state.previous_audio)
                elif get_config().advanced.video_player_path:
                    play_video_in_external(line, video_path)
                else:
                    import sounddevice as sd
                    data, samplerate = gsm_state.previous_audio
                    sd.play(data, samplerate)
                    sd.wait()
                return
            gsm_state.previous_line_for_audio = line
            if get_config().advanced.audio_player_path:
                audio = get_audio_from_video(line, line.next.time if line.next else None, video_path,
                                             temporary=True)
                play_audio_in_external(audio)
                gsm_state.previous_audio = audio
            elif get_config().advanced.video_player_path:
                play_video_in_external(line, video_path)
            else:
                import sounddevice as sd
                import soundfile as sf
                audio = get_audio_from_video(line, line.next.time if line.next else None, video_path,
                                             temporary=True)
                data, samplerate = sf.read(audio)
                sd.play(data, samplerate)
                sd.wait()
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
        logger.error(f"Error Playing Audio/Video: {e}")
        logger.debug(f"Error Playing Audio/Video: {e}", exc_info=True)
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
        if "vlc" in get_config().advanced.video_player_path:
            command.extend(["--start-time", convert_to_vlc_seconds(start), '--one-instance'])
        else:
            command.extend(["--start", convert_to_vlc_seconds(start)])
    command.append(os.path.normpath(filepath))

    logger.info(" ".join(command))



    try:
        subprocess.Popen(command)
        logger.info(f"Opened {filepath} in {get_config().advanced.video_player_path}.")
    except FileNotFoundError:
        logger.error("VLC not found. Make sure it's installed and in your PATH.")
    except Exception as e:
        logger.error(f"An error occurred: {e}")


def convert_to_vlc_seconds(time_str):
    """Converts HH:MM:SS.milliseconds to VLC-compatible seconds."""
    try:
        hours, minutes, seconds_ms = time_str.split(":")
        seconds, milliseconds = seconds_ms.split(".")
        total_seconds = (int(hours) * 3600) + (int(minutes) * 60) + int(seconds) + (int(milliseconds) / 1000.0)
        return str(total_seconds)
    except ValueError:
        return "Invalid time format"
