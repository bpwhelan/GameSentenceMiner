import os
import random
import re
import string
import subprocess
import threading
from datetime import datetime
from sys import platform

from rapidfuzz import process

SCRIPTS_DIR = r"E:\Japanese Stuff\agent-v0.1.4-win32-x64\data\scripts"

# Global variables to control script execution
use_previous_audio = False
keep_running = True
lock = threading.Lock()


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
    mod_time_epoch = os.path.getmtime(file_path)
    mod_time = datetime.fromtimestamp(mod_time_epoch)
    return mod_time


def get_process_id_by_title(game_title):
    powershell_command = f"Get-Process | Where-Object {{$_.MainWindowTitle -like '*{game_title}*'}} | Select-Object -First 1 -ExpandProperty Id"
    process_id = subprocess.check_output(["powershell", "-Command", powershell_command], text=True).strip()
    print(f"Process ID for {game_title}: {process_id}")
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
        print(f"Found Script: {best_script}")
        return best_script
    else:
        print("No similar script found.")


def run_agent_and_hook(pname, agent_script):
    command = f'agent --script=\"{agent_script}\" --pname={pname}'
    print("Running and Hooking Agent!")
    try:
        dos_process = subprocess.Popen(command, shell=True)
        dos_process.wait()  # Wait for the process to complete
        print("Agent script finished or closed.")
    except Exception as e:
        print(f"Error occurred while running agent script: {e}")

    keep_running = False


def is_linux():
    return platform == 'linux'

# def run_command(command, shell=False, input=None, capture_output=False, timeout=None, check=False, **kwargs):
#     # Use shell=True if the OS is Linux, otherwise shell=False
#     if is_linux():
#         return subprocess.run(command, shell=True, input=input, capture_output=capture_output, timeout=timeout,
#                               check=check, **kwargs)
#     else:
#         return subprocess.run(command, shell=shell, input=input, capture_output=capture_output, timeout=timeout,
#                               check=check, **kwargs)
def remove_html_tags(text):
    clean_text = re.sub(r'<.*?>', '', text)
    return clean_text
