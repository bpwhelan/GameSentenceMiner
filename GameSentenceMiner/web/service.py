import os
import shutil
import subprocess
import threading


from GameSentenceMiner import anki
from GameSentenceMiner.util import ffmpeg, notification
from GameSentenceMiner.util.configuration import gsm_state, logger, get_config, get_temporary_directory
from GameSentenceMiner.util.ffmpeg import get_video_timings
from GameSentenceMiner.util.text_log import GameLine


def handle_texthooker_button(video_path='', get_audio_from_video=None):
    try:
        if gsm_state.line_for_audio:
            line: GameLine = gsm_state.line_for_audio
            gsm_state.line_for_audio = None
            if line == gsm_state.previous_line_for_audio:
                logger.info("Line is the same as the last one, skipping processing.")
                if get_config().advanced.audio_player_path:
                    play_audio_in_external(gsm_state.previous_audio)
                elif get_config().advanced.video_player_path:
                    play_video_in_external(line, gsm_state.previous_audio)
                else:
                    play_obj = gsm_state.previous_audio.play()
                    play_obj.wait_done()
                return
            gsm_state.previous_line_for_audio = line
            if get_config().advanced.audio_player_path:
                audio = get_audio_from_video(line, line.next.time if line.next else None, video_path,
                                             temporary=True)
                play_audio_in_external(audio)
                gsm_state.previous_audio = audio
            elif get_config().advanced.video_player_path:
                new_video_path = play_video_in_external(line, video_path)
                gsm_state.previous_audio = new_video_path
                gsm_state.previous_replay = new_video_path
            else:
                import simpleaudio as sa
                audio = get_audio_from_video(line, line.next.time if line.next else None, video_path,
                                             temporary=True)
                wave_obj = sa.WaveObject.from_wave_file(audio)
                play_obj = wave_obj.play()
                play_obj.wait_done()
                gsm_state.previous_audio = wave_obj
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
        if video_path and get_config().paths.remove_video and os.path.exists(video_path):
            os.remove(video_path)


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
    def move_video_when_closed(p, fp):
        p.wait()
        os.remove(fp)

    shutil.move(filepath, get_temporary_directory())
    new_filepath = os.path.join(get_temporary_directory(), os.path.basename(filepath))

    command = [get_config().advanced.video_player_path]

    start, _, _, _ = get_video_timings(new_filepath, line)

    if start:
        if "vlc" in get_config().advanced.video_player_path:
            command.extend(["--start-time", convert_to_vlc_seconds(start), '--one-instance'])
        else:
            command.extend(["--start", convert_to_vlc_seconds(start)])
    command.append(os.path.normpath(new_filepath))

    logger.info(" ".join(command))



    try:
        proc = subprocess.Popen(command)
        print(f"Opened {filepath} in {get_config().advanced.video_player_path}.")
        threading.Thread(target=move_video_when_closed, args=(proc, filepath)).start()
    except FileNotFoundError:
        print("VLC not found. Make sure it's installed and in your PATH.")
    except Exception as e:
        print(f"An error occurred: {e}")
    return new_filepath


def convert_to_vlc_seconds(time_str):
    """Converts HH:MM:SS.milliseconds to VLC-compatible seconds."""
    try:
        hours, minutes, seconds_ms = time_str.split(":")
        seconds, milliseconds = seconds_ms.split(".")
        total_seconds = (int(hours) * 3600) + (int(minutes) * 60) + int(seconds) + (int(milliseconds) / 1000.0)
        return str(total_seconds)
    except ValueError:
        return "Invalid time format"
