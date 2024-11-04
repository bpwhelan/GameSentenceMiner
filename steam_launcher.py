import os
import sqlite3
import subprocess
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta

import psutil
import requests
from rapidfuzz import process

import main

# This looks at config.toml for current_game
# Directory containing the scripts, Edit this.
SCRIPTS_DIR = r"E:\Japanese Stuff\agent-v0.1.4-win32-x64\data\scripts"

STEAM_API_URL = "https://api.steampowered.com/ISteamApps/GetAppList/v0002/"
LOCAL_DB = "steam_app_list.db"
DAYS_THRESHOLD = 7


@dataclass
class SteamGame:
    id: int
    name: str


# Function to walk the directory and get all script file paths
def get_script_files(directory):
    script_files = []
    for root, dirs, files in os.walk(directory):
        for file in files:
            if file.endswith(".js"):  # Assuming the scripts are .js files
                script_files.append(os.path.join(root, file))
    return script_files


# Function to filter Steam-related scripts
def filter_steam_scripts(scripts):
    return [script for script in scripts if "PC_Steam" in os.path.basename(script)]


# Function to extract the game name from the script file path
def extract_game_name(script_path):
    # Remove directory and file extension to get the name part
    script_name = os.path.basename(script_path)
    game_name = script_name.replace("PC_Steam_", "").replace(".js", "")
    return game_name.replace("_", " ").replace(".", " ")


# Function to find the most similar script
def find_most_similar_script(game_title, steam_scripts):
    # Create a list of game names from the script paths
    game_names = [extract_game_name(script) for script in steam_scripts]

    # Use rapidfuzz to find the closest match
    best_match = process.extractOne(game_title, game_names)

    if best_match:
        matched_game_name, confidence_score, index = best_match
        return steam_scripts[index], matched_game_name, confidence_score
    return None, None, None


# Main function to find the most similar script based on the game title
def find_script_for_game(game_title):
    script_files = get_script_files(SCRIPTS_DIR)

    steam_scripts = filter_steam_scripts(script_files)

    best_script, matched_game_name, confidence = find_most_similar_script(game_title, steam_scripts)

    if best_script:
        print(f"Found Script: {best_script}")
        return best_script
    else:
        print("No similar script found.")


def is_file_outdated(file_path, days_threshold):
    if not os.path.exists(file_path):
        return True

    file_mod_time = datetime.fromtimestamp(os.path.getmtime(file_path))
    return datetime.now() - file_mod_time > timedelta(days=days_threshold)


def fetch_steam_app_list():
    try:
        response = requests.get(STEAM_API_URL, timeout=10)
        response.raise_for_status()
        return response.json()
    except requests.RequestException as e:
        print(f"Error fetching data from Steam API: {e}")
        return None


def insert_app_list_to_db(app_list):
    conn = sqlite3.connect(LOCAL_DB)
    c = conn.cursor()

    c.execute('''
        CREATE TABLE IF NOT EXISTS steam_apps (
            appid INTEGER PRIMARY KEY,
            name TEXT
        )
    ''')

    apps = app_list['applist']['apps']
    for app in apps:
        c.execute('''
            REPLACE INTO steam_apps (appid, name)
            VALUES (?, ?)
        ''', (app['appid'], app['name']))

    conn.commit()
    conn.close()
    print(f"Inserted {len(apps)} apps into the database.")


def search_app_by_name(search_term):
    conn = sqlite3.connect(LOCAL_DB)
    c = conn.cursor()

    c.execute('''
        SELECT appid, name FROM steam_apps
        WHERE name LIKE ?
    ''', ('%' + search_term + '%',))

    results = c.fetchall()
    conn.close()
    ret = []
    if results:
        for appid, name in results:
            if not any(blacklist.casefold() in name.casefold() for blacklist in ['DEMO']):
                print(f"AppID: {appid}, Name: {name}")
                ret.append(SteamGame(appid, name))
    else:
        print(f"No results found for '{search_term}'.")
    return ret


def get_steam_app_list():
    # Check if the SQLite database is outdated
    if is_file_outdated(LOCAL_DB, DAYS_THRESHOLD):
        print("The database is older than 7 days or doesn't exist. Fetching new data...")
        app_list = fetch_steam_app_list()
        if app_list:
            insert_app_list_to_db(app_list)
        else:
            print("Failed to fetch the app list.")
    else:
        print("Using the local database.")


def run_steam_app(steam_id):
    steam_path = r"C:\Program Files (x86)\Steam\steam.exe"
    args = ['-applaunch', str(steam_id)]
    steam_process = subprocess.Popen([steam_path] + args)
    print(f"Steam launched with game ID: {steam_id}")
    return steam_process


def wait(seconds):
    # print(f"Waiting for {seconds} seconds...")
    time.sleep(seconds)


# 3. Run PowerShell script to get process ID by game title
def get_process_id_by_title(game_title):
    powershell_command = f"Get-Process | Where-Object {{$_.MainWindowTitle -like '*{game_title}*'}} | Select-Object -First 1 -ExpandProperty Id"
    process_id = subprocess.check_output(["powershell", "-Command", powershell_command], text=True).strip()
    print(f"Process ID for {game_title}: {process_id}")
    return process_id


# def run_obs():
#     obs_path = r"C:\Program Files\obs-studio\bin\64bit\obs64.exe"
#     obs_process = subprocess.Popen([obs_path])
#     print("OBS launched")
#     return obs_process

def run_python_script(script_path, working_dir):
    python_executable = r"C:\Users\Beangate\Dev\Pycharm\venv\autoConvertGameReplayToAudio\Scripts\python.exe"
    process = subprocess.Popen([python_executable, script_path], cwd=working_dir)
    print(f"Python script {script_path} launched")
    return process


def run_agent_and_hook(pname, agent_script):
    command = f'agent --script=\"{agent_script}\" --pname={pname}'
    print("Running and Hooking Agent!")
    try:
        dos_process = subprocess.Popen(command, shell=True)
        dos_process.wait()  # Wait for the process to complete
        print("Agent script finished or closed.")
    except Exception as e:
        print(f"Error occurred while running agent script: {e}")

    main.keep_running = False


def wait_for_process(process):
    process.wait()
    print(f"Process {process.pid} finished")


def is_game_process_running(process_id):
    try:
        process = psutil.Process(process_id)
        return process.is_running() and process.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


def monitor_process_and_flag(process_id):
    while main.keep_running:
        # Check the game process every iteration
        if not is_game_process_running(int(process_id)):
            print("Game process is no longer running.")
            main.keep_running = False
            break

        # Sleep for a short period to reduce CPU usage
        time.sleep(1)  # You can adjust this interval for more responsiveness or lower CPU usage

    print("Monitoring loop exited.")


def launch():
    print(f"Running with game name: {config_reader.current_game}")
    games = search_app_by_name(config_reader.current_game)

    if not games:
        print("No game found! Exiting")
        exit(0)
    if len(games) > 1:
        print("More than one game found!")
        for i, game in enumerate(games):
            print(f"{i}: {game.name}")
        game = games[int(input("Select Game to Launch: (Enter for the first)") or 0)]
    else:
        game = games[0]

    run_steam_app(game.id)

    # Wait before hooking
    wait(8)

    game_process_id = get_process_id_by_title(config_reader.current_game)

    game_script = find_script_for_game(config_reader.current_game)

    agent_thread = threading.Thread(target=run_agent_and_hook,
                                    args=(game_process_id, game_script))
    agent_thread.start()

    monitor_thread = threading.Thread(target=monitor_process_and_flag, args=(game_process_id,))
    monitor_thread.start()

    # Launch the Mining Script
    main.main()


if __name__ == '__main__':
    launch()
    pass
