import os
import subprocess
import threading
import time
from dataclasses import dataclass

import psutil

from GameSentenceMiner import GameSentenceMiner, util

# from steam_launcher import is_game_process_running
vn_path = r"E:\Japanese Stuff\Visual Novels\Nanairo Reincarnation\nanarin\nanairo_uncen.exe"
# yuzu_cmd = r"C:\Emulation\Emulators\ryujinx-1.1.1403-win_x64\publish\Ryujinx.exe"
# roms_path = r"C:\Emulation\Yuzu\Games"
# AGENT_SCRIPTS_DIR = r"E:\Japanese Stuff\agent-v0.1.4-win32-x64\data\scripts"
texttractor_path = r"E:\Japanese Stuff\Textractor-5.2.0-Zip-Version-English-Only\Textractor\x86\Textractor.exe"
pre_select = -1


@dataclass
class YuzuGame:
    id: str
    name: str
    path: str


# def get_yuzu_games(directory):
#     games = []
#     # Regular expression to capture the ID between square brackets
#     pattern = re.compile(r'(.+?)\s*\[(\w+)\]')
#
#     # Iterate through the directory
#     for filename in os.listdir(directory):
#         # Check if the filename matches the pattern for extracting the ID
#         match = pattern.search(filename)
#         if match:
#             name = match.group(1)
#             file_id = match.group(2)  # Extract ID
#             abs_path = os.path.abspath(os.path.join(directory, filename))  # Get absolute path
#             games.append(YuzuGame(file_id, name, abs_path))
#
#     return games


# Function to launch Yuzu with the selected game
def launch_vn():
    # flag = "-g" if "yuzu" in vn_path.lower() else ""
    try:
    #     command = f"{vn_path} {flag} \"{rom_path}\""
    #
    #     print(command)
        os.chdir(vn_path.rsplit('\\',1)[0])
        process = subprocess.Popen(vn_path, stdout=subprocess.DEVNULL)
        return process.pid
    except Exception as e:
        print(f"Error launching VN: {e}")

def get_pid_by_name(task_name):
    """
    Returns the PID of the first process matching the task name.
    """
    for process in psutil.process_iter(['pid', 'name']):
        print(process)
        if process.info['name'] == task_name:
            return process.info['pid']
    return None


# Function to find the agent script that matches the game ID
# def find_agent_script(game_id):
#     for root, dirs, files in os.walk(AGENT_SCRIPTS_DIR):
#         for file in files:
#             if game_id in file and file.endswith(".js"):
#                 return os.path.join(root, file)
#     return None


def run_agent_and_hook(pname, agent_script):
    command = f'agent --script=\"{agent_script}\" --pname={pname}'
    print("Running and Hooking Agent!")
    try:
        dos_process = subprocess.Popen(command, shell=True)
        dos_process.wait()  # Wait for the process to complete
        print("Agent script finished or closed.")
    except Exception as e:
        print(f"Error occurred while running agent script: {e}")

    util.keep_running = False


def launch_textractor():
    # flag = "-g" if "yuzu" in vn_path.lower() else ""
    try:
    #     command = f"{vn_path} {flag} \"{rom_path}\""
    #
    #     print(command)

        process = subprocess.Popen(texttractor_path, stdout=subprocess.DEVNULL)

        return process.pid
    except Exception as e:
        print(f"Error launching VN: {e}")

# Function to run the agent with the matching script
# def run_agent_with_script(game_id, yuzu_pid):
#     agent_script = find_agent_script(game_id)
#
#     print(agent_script)
#
#     if agent_script:
#         try:
#             command = f'agent --script=\"{agent_script}\" --pname={yuzu_pid}'
#
#             dos_process = subprocess.Popen(command, shell=True)
#             dos_process.wait()  # Wait for the process to complete
#             print("Agent script finished or closed.")
#         except Exception as e:
#             print(f"Error occurred while running agent script: {e}")
#         util.keep_running = False
#     else:
#         print(f"No matching agent script found for game ID {game_id}.")


def is_game_process_running(process_id):
    try:
        process = psutil.Process(process_id)
        return process.is_running() and process.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


def monitor_process_and_flag(process_id):
    while util.keep_running:
        # Check the game process every iteration
        if not is_game_process_running(int(process_id)):
            print("Game process is no longer running.")
            util.keep_running = False
            exit(0)

        # Sleep for a short period to reduce CPU usage
        time.sleep(1)  # You can adjust this interval for more responsiveness or lower CPU usage

    print("Monitoring loop exited.")


# Example integration with the Yuzu launcher
if __name__ == "__main__":
    # games = get_yuzu_games(roms_path)
    # for i, game in enumerate(games):
    #     print(f"{i} : {game.name}")
    #
    # if pre_select >= 0:
    #     selection = pre_select
    # else:
    #     selection: int = int(input("Select Which Game to launch: "))
    # game = games[selection]
    #
    # if game.id and game.path:
    #     print(f"Launching Game: {game.id} - {game.path}")
    path = os.getcwd()
    vn_pid = launch_vn()
    os.chdir(path)

    vn_pid = get_pid_by_name('nanairo.exe')

    time.sleep(2)

    print(vn_pid)
    if vn_pid:
        agent_thread = threading.Thread(target=launch_textractor, daemon=True)
        agent_thread.start()

        monitor_thread = threading.Thread(target=monitor_process_and_flag, args=(vn_pid,))
        monitor_thread.start()

        # Launch the Mining Script
        GameSentenceMiner.main(do_config_input=False)

    else:
        print("Failed to launch VN.")
    # else:
    #     print("No active game found.")
