import os
import re
import subprocess
import threading
import time
from dataclasses import dataclass

import psutil

from GameSentenceMiner import util

# from steam_launcher import is_game_process_running
yuzu_cmd = r"C:\Emulation\Emulators\yuzu-windows-msvc\yuzu.exe"
# yuzu_cmd = r"C:\Emulation\Emulators\ryujinx-1.1.1403-win_x64\publish\Ryujinx.exe"
roms_path = r"C:\Emulation\Yuzu\Games"
AGENT_SCRIPTS_DIR = r"E:\Japanese Stuff\agent-v0.1.4-win32-x64\data\scripts"
pre_select = 15


import json
import sys

@dataclass
class YuzuGame:
    id: str
    name: str
    path: str


def get_yuzu_games(directory):
    games = []
    # Regular expression to capture the ID between square brackets
    pattern = re.compile(r'(.+?)\s*[\[\(](\w+)[\]\)]')

    # Iterate through the directory
    for filename in os.listdir(directory):
        # Check if the filename matches the pattern for extracting the ID
        match = pattern.search(filename)
        if match:
            name = match.group(1)
            file_id = match.group(2)  # Extract ID
            abs_path = os.path.abspath(os.path.join(directory, filename))  # Get absolute path
            games.append(YuzuGame(file_id, name, abs_path))

    return games



# Function to launch Yuzu with the selected game
def launch_yuzu(rom_path):
    flag = "-g" if "yuzu" in yuzu_cmd.lower() else ""
    try:
        command = f"{yuzu_cmd} {flag} \"{rom_path}\""

        process = subprocess.Popen(command, stdout=subprocess.DEVNULL)

        return process.pid
    except Exception as e:
        print(f"Error launching Yuzu: {e}")


# Function to find the agent script that matches the game ID
def find_agent_script(game_id):
    for root, dirs, files in os.walk(AGENT_SCRIPTS_DIR):
        for file in files:
            if game_id in file and file.endswith(".js"):
                return os.path.join(root, file)
    return None


def run_agent_and_hook(pname, agent_script):
    command = f'agent --script=\"{agent_script}\" --pname={pname}'
    try:
        dos_process = subprocess.Popen(command, shell=True)
        dos_process.wait()  # Wait for the process to complete
    except Exception as e:
        print(f"Error occurred while running agent script: {e}")

    util.keep_running = False


# Function to run the agent with the matching script
def run_agent_with_script(game_id, yuzu_pid):
    agent_script = find_agent_script(game_id)

    if agent_script:
        try:
            command = f'agent --script=\"{agent_script}\" --pname={yuzu_pid}'

            dos_process = subprocess.Popen(command, shell=True)
            dos_process.wait()  # Wait for the process to complete
        except Exception as e:
            print(f"Error occurred while running agent script: {e}")
        util.keep_running = False
    else:
        print(f"No matching agent script found for game ID {game_id}.")


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
            util.keep_running = False
            exit(0)

        # Sleep for a short period to reduce CPU usage
        time.sleep(1)  # You can adjust this interval for more responsiveness or lower CPU usage


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else ""

    if action == "list":
        games = get_yuzu_games(roms_path)
        print(json.dumps([game.__dict__ for game in games]))  # Convert to JSON

    elif action == "launch":
        game_id = sys.argv[2]
        games = get_yuzu_games(roms_path)
        selected_game = next((g for g in games if g.id == game_id), None)

        if selected_game:
            yuzu_pid = launch_yuzu(selected_game.path)
            if yuzu_pid:
                agent_thread = threading.Thread(target=run_agent_with_script,
                                                args=(game_id, yuzu_pid))
                agent_thread.start()

                monitor_thread = threading.Thread(target=monitor_process_and_flag, args=(yuzu_pid,))
                monitor_thread.start()
            print(json.dumps({"status": "launched", "pid": yuzu_pid}))
        else:
            print(json.dumps({"status": "error", "message": "Game not found"}))
    elif action == "legacy":
        games = get_yuzu_games(roms_path)
        for i, game in enumerate(games):
            print(f"{i} : {game.name}")

        if pre_select >= 0:
            selection = pre_select
        else:
            selection: int = int(input("Select Which Game to launch: "))
        game = games[selection]

        if game.id and game.path:
            print(f"Launching Game: {game.id} - {game.path}")
            yuzu_pid = launch_yuzu(game.path)

            if yuzu_pid:
                agent_thread = threading.Thread(target=run_agent_with_script,
                                                args=(game.id, yuzu_pid))
                agent_thread.start()

                monitor_thread = threading.Thread(target=monitor_process_and_flag, args=(yuzu_pid,))
                monitor_thread.start()

                # Launch the Mining Script
                # gsm.main(do_config_input=False)

            else:
                print("Failed to launch Yuzu.")
        else:
            print("No active game found.")