import json
import logging
import os
from os.path import expanduser

import toml

# Define the path to your config.toml file
CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'config.json')
temp_directory = ''


def save_updated_offsets_to_file():
    global audio_beginning_offset, audio_end_offset
    config_file = "config.toml"  # Ensure this is the correct path to your config file

    try:
        # Load the existing config
        with open(config_file, "r") as f:
            config_data = toml.load(f)

        # Update the audio offsets in the config data
        config_data["audio"]["beginning_offset"] = audio_beginning_offset
        config_data["audio"]["end_offset"] = audio_end_offset

        # Write the updated config back to the file
        with open(config_file, "w") as f:
            toml.dump(config_data, f)

        logger.info(
            f"Offsets saved to config.toml: beginning_offset={audio_beginning_offset}, end_offset={audio_end_offset}")
        print("Offsets have been successfully saved to the config file.")

    except Exception as e:
        logger.error(f"Failed to update offsets in config file: {e}")
        print(f"Error saving updated offsets: {e}")


TOML_CONFIG_FILE = 'config.toml'

def load_config():
    if os.path.exists(CONFIG_FILE):
        # If the JSON config exists, load it
        try:
            with open(CONFIG_FILE, 'r') as file:
                config_file = json.load(file)

                # Expanding user home paths in case "~" is used
                config_file['paths']['folder_to_watch'] = expanduser(config_file['paths'].get('folder_to_watch', '~/Videos/OBS'))
                config_file['paths']['audio_destination'] = expanduser(config_file['paths'].get('audio_destination', '~/Videos/OBS/Audio/'))
                config_file['paths']['screenshot_destination'] = expanduser(config_file['paths'].get('screenshot_destination', '~/Videos/OBS/SS/'))

                return config_file
        except json.JSONDecodeError as e:
            logger.error(f"Error parsing {CONFIG_FILE}: {e}")
            return None
    else:
        # If the JSON config doesn't exist, load from TOML and write to JSON
        try:
            with open(TOML_CONFIG_FILE, 'r') as file:
                toml_config = toml.load(file)

                # Write the TOML data to JSON file
                with open(CONFIG_FILE, 'w') as json_file:
                    json.dump(toml_config, json_file, indent=4)

                toml_config['paths']['folder_to_watch'] = expanduser(toml_config['paths'].get('folder_to_watch', '~/Videos/OBS'))
                toml_config['paths']['audio_destination'] = expanduser(toml_config['paths'].get('audio_destination', '~/Videos/OBS/Audio/'))
                toml_config['paths']['screenshot_destination'] = expanduser(toml_config['paths'].get('screenshot_destination', '~/Videos/OBS/SS/'))

                print(f"Configuration file created from {TOML_CONFIG_FILE}.")
                return toml_config
        except FileNotFoundError:
            print(f"Configuration file {TOML_CONFIG_FILE} not found!")
            return None
        except toml.TomlDecodeError as e:
            print(f"Error parsing {TOML_CONFIG_FILE}: {e}")
            return None


config = load_config()

if config:
    general_config = config.get('general', {})
    path_config = config.get('paths', {})
    audio_config = config.get('audio', {})
    anki_config = config.get('anki', {})
    feature_config = config.get('features', {})
    vosk_config = config.get('vosk', {})
    screenshot_config = config.get('screenshot', {})
    obs_config = config.get('obs', {})
    anki_custom_fields = config.get("anki_custom_fields", {})
    anki_overwrites_config = config.get('anki_overwrites', {})
    websocket_config = config.get('websocket', {})
    hotkey_config = config.get('hotkeys', {})

    #general config
    console_log_level = general_config.get('console_log_level', 'INFO')
    file_log_level = general_config.get('file_log_level', 'DEBUG')
    whisper_model_name = general_config.get('whisper_model', 'base')

    folder_to_watch = path_config.get('folder_to_watch', expanduser("~/Videos/OBS"))
    audio_destination = path_config.get('audio_destination', expanduser("~/Videos/OBS/Audio/"))
    screenshot_destination = path_config.get('screenshot_destination', expanduser("~/Videos/OBS/SS/"))

    # Anki fields
    anki_url = config.get('url', 'http://127.0.0.1:8765')
    sentence_field = anki_config.get('sentence_field', "Sentence")
    sentence_audio_field = anki_config.get('sentence_audio_field', "SentenceAudio")
    picture_field = anki_config.get('picture_field', "Picture")
    current_game = anki_config.get('current_game', "GameSentenceMiner")
    custom_tags = anki_config.get("custom_tags", [])
    add_game_tag = anki_config.get("add_game_tag", True)
    word_field = anki_config.get('word_field', 'Word')
    anki_polling_rate = anki_config.get('polling_rate', 200)

    # Feature flags
    do_vosk_postprocessing = feature_config.get('do_vosk_postprocessing', True)
    remove_video = feature_config.get('remove_video', True)
    remove_audio = feature_config.get('remove_audio', False)
    remove_screenshot = feature_config.get('remove_screenshot', False)
    update_anki = feature_config.get('update_anki', True)
    obs_full_auto_mode = feature_config.get('full_auto', False)
    notify_on_update = feature_config.get('notify_on_update', True)
    open_anki_edit = feature_config.get('open_anki_edit', False)
    backfill_audio = feature_config.get('backfill_audio', False)
    do_whisper_instead = feature_config.get('do_whisper_postprocessing_instead', True)

    # Vosk config
    vosk_model_url = vosk_config.get('url', "https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip")
    vosk_log_level = vosk_config.get('log-level', -1)


    # screenshot config
    screenshot_width = screenshot_config.get('width', 0)
    screenshot_height = screenshot_config.get('height', 0)
    screenshot_quality = str(screenshot_config.get('quality', 85))
    screenshot_extension = screenshot_config.get('extension', "webp")
    screenshot_custom_ffmpeg_settings = screenshot_config.get('custom_ffmpeg_settings', '')
    screenshot_hotkey_save_to_anki = screenshot_config.get('screenshot_hotkey_save_to_anki', True)

    # audio config
    audio_extension = audio_config.get('extension', 'opus')
    audio_beginning_offset = audio_config.get('beginning_offset', 0.0)
    audio_end_offset = audio_config.get('end_offset', 0.5)
    vosk_trim_beginning = audio_config.get('vosk_trim_beginning', False)
    ffmpeg_reencode_options = audio_config.get('ffmpeg_reencode_options', '')

    # Parse OBS settings from the config
    obs_enabled = obs_config.get('enabled', True)
    obs_start_buffer = obs_config.get('start_buffer', True)
    OBS_HOST = obs_config.get('host', "localhost")
    OBS_PORT = obs_config.get('port', 4455)
    OBS_PASSWORD = obs_config.get('password', "your_password")
    get_game_from_scene = obs_config.get('get_game_from_scene', False)

    # websocket settings
    websocket_enabled = websocket_config.get('enabled', True)
    websocket_uri = websocket_config.get('uri') or websocket_config.get('url', 'localhost:6677')

    # Overrides
    overwrite_audio = anki_config.get("override_audio") or anki_overwrites_config.get('overwrite_audio', False)
    overwrite_picture = anki_overwrites_config.get('overwrite_picture', True)

    # hotkeys
    offset_reset_hotkey = hotkey_config.get('reset_offset') or audio_config.get('offset_reset_hotkey', 'f4')
    reset_line_hotkey = hotkey_config.get('reset_line', 'f5')
    take_screenshot_hotkey = hotkey_config.get('take_screenshot', 'f6')

    if backfill_audio and obs_full_auto_mode:
        print("Cannot have backfill_audio and obs_full_auto_mode turned on at the same time!")
        exit(1)

    # Setup Logs
    logger = logging.getLogger("TrimAudio")
    logging_format = logging.Formatter(u'%(asctime)s - %(levelname)s - %(message)s')

    file_handler = logging.FileHandler("anki_script.log", encoding='utf-8')
    file_handler.setLevel(file_log_level)
    file_handler.setFormatter(logging_format)

    console_handler = logging.StreamHandler()
    console_handler.setLevel(console_log_level)  # You can set the desired log level for console output
    console_handler.setFormatter(logging_format)

    logger.addHandler(file_handler)
    logger.addHandler(console_handler)
    logger.setLevel(logging.INFO)

else:
    raise Exception("No config found")

print(config)
