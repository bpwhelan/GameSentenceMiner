import subprocess
import threading
import time
import psutil

import main

steam_game_id = 1295510
agent_script = "E:\\Japanese Stuff\\agent-v0.1.4-win32-x64\\data\\scripts\\PC_Steam_Unreal_Dragon.Quest.XI.S_Echoes.of.an.Elusive.Age.js"
game_title = "Dragon Quest XI S"


def run_steam_app(steam_id):
    steam_path = r"C:\Program Files (x86)\Steam\steam.exe"
    args = ['-applaunch', str(steam_id)]
    steam_process = subprocess.Popen([steam_path] + args)
    print(f"Steam launched with game ID: {steam_id}")
    return steam_process


def wait(seconds):
    print(f"Waiting for {seconds} seconds...")
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


def run_agent_and_hook(pname):
    command = f'agent --script={agent_script} --pname={pname}'
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


steam_process = run_steam_app(steam_game_id)

# Wait before hooking
wait(8)

game_process_id = get_process_id_by_title(game_title)


agent_thread = threading.Thread(target=run_agent_and_hook,
                                args=(game_process_id,))
agent_thread.start()

monitor_thread = threading.Thread(target=monitor_process_and_flag, args=(game_process_id,))
monitor_thread.start()

# Launch the Mining Script
main.main()
