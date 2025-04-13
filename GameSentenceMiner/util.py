import importlib
import os
import random
import re
import string
import subprocess
import sys
import threading
import time
from datetime import datetime
from sys import platform

from rapidfuzz import process

from GameSentenceMiner.configuration import logger, get_config

SCRIPTS_DIR = r"E:\Japanese Stuff\agent-v0.1.4-win32-x64\data\scripts"

# Global variables to control script execution
keep_running = True
lock = threading.Lock()
last_mined_line = None

def get_last_mined_line():
    return last_mined_line

def set_last_mined_line(line):
    global last_mined_line
    last_mined_line = line

def run_new_thread(func):
    thread = threading.Thread(target=func, daemon=True)
    thread.start()
    return thread


def make_unique_file_name(path):
    split = path.rsplit('.', 1)
    filename = split[0]
    extension = split[1]

    current_time = datetime.now().strftime('%Y-%m-%d-%H-%M-%S-%f')[:-3]

    return f"{filename}_{current_time}.{extension}"

def sanitize_filename(filename):
        return re.sub(r'[ <>:"/\\|?*\x00-\x1F]', '', filename)


def get_random_digit_string():
    return ''.join(random.choice(string.digits) for i in range(9))


def timedelta_to_ffmpeg_friendly_format(td_obj):
    total_seconds = td_obj.total_seconds()
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return "{:02}:{:02}:{:06.3f}".format(int(hours), int(minutes), seconds)


def get_file_modification_time(file_path):
    mod_time_epoch = os.path.getctime(file_path)
    mod_time = datetime.fromtimestamp(mod_time_epoch)
    return mod_time


def get_process_id_by_title(game_title):
    powershell_command = f"Get-Process | Where-Object {{$_.MainWindowTitle -like '*{game_title}*'}} | Select-Object -First 1 -ExpandProperty Id"
    process_id = subprocess.check_output(["powershell", "-Command", powershell_command], text=True).strip()
    logger.info(f"Process ID for {game_title}: {process_id}")
    return process_id


def get_script_files(directory):
    script_files = []
    for root, dirs, files in os.walk(directory):
        for file in files:
            if file.endswith(".js"):  # Assuming the scripts are .js files
                script_files.append(os.path.join(root, file))
    return script_files


def filter_steam_scripts(scripts):
    return [script for script in scripts if "PC_Steam" in os.path.basename(script)]


def extract_game_name(script_path):
    # Remove directory and file extension to get the name part
    script_name = os.path.basename(script_path)
    game_name = script_name.replace("PC_Steam_", "").replace(".js", "")
    return game_name.replace("_", " ").replace(".", " ")


def find_most_similar_script(game_title, steam_scripts):
    # Create a list of game names from the script paths
    game_names = [extract_game_name(script) for script in steam_scripts]

    # Use rapidfuzz to find the closest match
    best_match = process.extractOne(game_title, game_names)

    if best_match:
        matched_game_name, confidence_score, index = best_match
        return steam_scripts[index], matched_game_name, confidence_score
    return None, None, None


def find_script_for_game(game_title):
    script_files = get_script_files(SCRIPTS_DIR)

    steam_scripts = filter_steam_scripts(script_files)

    best_script, matched_game_name, confidence = find_most_similar_script(game_title, steam_scripts)


    if best_script:
        logger.info(f"Found Script: {best_script}")
        return best_script
    else:
        logger.warning("No similar script found.")


def run_agent_and_hook(pname, agent_script):
    command = f'agent --script=\"{agent_script}\" --pname={pname}'
    logger.info("Running and Hooking Agent!")
    try:
        dos_process = subprocess.Popen(command, shell=True)
        dos_process.wait()  # Wait for the process to complete
        logger.info("Agent script finished or closed.")
    except Exception as e:
        logger.error(f"Error occurred while running agent script: {e}")

    keep_running = False


def is_linux():
    return platform == 'linux'

def is_windows():
    return platform == 'win32'

# def run_command(command, shell=False, input=None, capture_output=False, timeout=None, check=False, **kwargs):
#     # Use shell=True if the OS is Linux, otherwise shell=False
#     if is_linux():
#         return subprocess.run(command, shell=True, input=input, capture_output=capture_output, timeout=timeout,
#                               check=check, **kwargs)
#     else:
#         return subprocess.run(command, shell=shell, input=input, capture_output=capture_output, timeout=timeout,
#                               check=check, **kwargs)
def remove_html_and_cloze_tags(text):
    text = re.sub(r'<.*?>', '', re.sub(r'{{c\d+::(.*?)(::.*?)?}}', r'\1', text))
    return text


def combine_dialogue(dialogue_lines, new_lines=None):
    if not dialogue_lines:  # Handle empty input
        return []

    if new_lines is None:
        new_lines = []

    if len(dialogue_lines) == 1 and '「' not in dialogue_lines[0]:
        new_lines.append(dialogue_lines[0])
        return new_lines

    character_name = dialogue_lines[0].split("「")[0]
    text = character_name + "「"

    for i, line in enumerate(dialogue_lines):
        if not line.startswith(character_name + "「"):
            text = text + "」" + get_config().advanced.multi_line_line_break
            new_lines.append(text)
            new_lines.extend(combine_dialogue(dialogue_lines[i:]))
            break
        else:
            text +=  (get_config().advanced.multi_line_line_break if i > 0 else "") + line.split("「")[1].rstrip("」") + ""
    else:
        text = text + "」"
        new_lines.append(text)

    return new_lines

def wait_for_stable_file(file_path, timeout=10, check_interval=0.1):
    elapsed_time = 0
    last_size = -1

    while elapsed_time < timeout:
        try:
            current_size = os.path.getsize(file_path)
            if current_size == last_size:
                return True
            last_size = current_size
            time.sleep(check_interval)
            elapsed_time += check_interval
        except Exception as e:
            logger.warning(f"Error checking file size, will still try updating Anki Card!: {e}")
            return False
    logger.warning("File size did not stabilize within the timeout period. Continuing...")
    return False


def import_vad_models():
    silero_trim, whisper_helper, vosk_helper = None, None, None
    if get_config().vad.is_silero():
        from GameSentenceMiner.vad import silero_trim
    if get_config().vad.is_whisper():
        from GameSentenceMiner.vad import whisper_helper
    if get_config().vad.is_vosk():
        from GameSentenceMiner.vad import vosk_helper
    return silero_trim, whisper_helper, vosk_helper