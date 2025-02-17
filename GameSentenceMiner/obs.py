import subprocess
import time

import psutil
from obswebsocket import obsws, requests

from GameSentenceMiner import util, configuration
from GameSentenceMiner.configuration import *
from GameSentenceMiner.model import *

client: obsws = None

# REFERENCE: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md


def get_obs_path():
    return os.path.join(configuration.get_app_directory(), 'obs-studio/bin/64bit/obs64.exe')

def start_obs():
    obs_path = get_obs_path()
    if not os.path.exists(obs_path):
        logger.error(f"OBS not found at {obs_path}. Please install OBS.")
        return None

    try:
        obs_pid = is_obs_running(obs_path)
        if obs_pid:
            return obs_pid
        process = subprocess.Popen([obs_path, '--disable-shutdown-check', '--portable'], cwd=os.path.dirname(obs_path))
        logger.info("OBS launched")
        return process.pid
    except Exception as e:
        logger.error(f"Error launching OBS: {e}")
        return None

def is_obs_running(obs_path):
    obs_path = os.path.abspath(obs_path)  # Normalize path
    for process in psutil.process_iter(['exe']):
        try:
            if process.info['exe'] and os.path.abspath(process.info['exe']) == obs_path:
                return process.pid
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
    return False

def get_obs_websocket_config_values():
    config_path = os.path.join(get_app_directory(), 'obs-studio', 'config', 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json')

        # Check if config file exists
    if not os.path.isfile(config_path):
        raise FileNotFoundError(f"OBS WebSocket config not found at {config_path}")

    # Read the JSON configuration
    with open(config_path, 'r') as file:
        config = json.load(file)

    # Extract values
    server_enabled = config.get("server_enabled", False)
    server_port = config.get("server_port", 4455)  # Default to 4455 if not set
    server_password = config.get("server_password", None)

    if not server_enabled:
        logger.info("OBS WebSocket server is not enabled. Enabling it now... Restart OBS for changes to take effect.")
        config["server_enabled"] = True

        with open(config_path, 'w') as file:
            json.dump(config, file, indent=4)

    if get_config().obs.password == 'your_password':
        logger.info("OBS WebSocket password is not set. Setting it now...")
        config = get_master_config()
        config.get_config().obs.port = server_port
        config.get_config().obs.password = server_password
        with open(get_config_path(), 'w') as file:
            json.dump(config.to_dict(), file, indent=4)
        reload_config()


def on_connect(obs):
    logger.info("Connected to OBS WebSocket.")
    time.sleep(2)
    if get_config().obs.start_buffer:
        start_replay_buffer()


def on_disconnect(obs):
    logger.error("OBS Connection Lost!")


def connect_to_obs(start_replay=False):
    global client
    if get_config().obs.enabled:
        if util.is_windows():
            get_obs_websocket_config_values()
        client = obsws(host=get_config().obs.host, port=get_config().obs.port,
                       password=get_config().obs.password, authreconnect=1, on_connect=on_connect,
                       on_disconnect=on_disconnect)
        client.connect()

        time.sleep(1)
        if start_replay and get_config().obs.start_buffer:
            start_replay_buffer()
        update_current_game()


# Disconnect from OBS WebSocket
def disconnect_from_obs():
    global client
    if client:
        client.disconnect()
        client = None
        logger.info("Disconnected from OBS WebSocket.")


def toggle_replay_buffer():
    try:
        client.call(requests.ToggleReplayBuffer())
        logger.info("Replay buffer Toggled.")
    except Exception as e:
        logger.error(f"Error toggling buffer: {e}")


# Start replay buffer
def start_replay_buffer():
    try:
        client.call(requests.GetVersion())
        client.call(requests.StartReplayBuffer())
    except Exception as e:
        logger.error(f"Error starting replay buffer: {e}")


# Stop replay buffer
def stop_replay_buffer():
    try:
        client.call(requests.StopReplayBuffer())
        logger.error("Replay buffer stopped.")
    except Exception as e:
        logger.error(f"Error stopping replay buffer: {e}")


# Save the current replay buffer
def save_replay_buffer():
    try:
        replay_buffer_started = client.call(requests.GetReplayBufferStatus()).datain['outputActive']
        if replay_buffer_started:
            client.call(requests.SaveReplayBuffer())
            logger.info("Replay buffer saved.")
        else:
            logger.error("Replay Buffer is not active, could not save Replay Buffer!")
    except Exception as e:
        logger.error(f"Error saving replay buffer: {e}")


def get_current_scene():
    try:
        response = client.call(requests.GetCurrentProgramScene())
        scene_info = SceneInfo.from_dict(response.datain)
        return scene_info.sceneName
    except Exception as e:
        logger.error(f"Couldn't get scene: {e}")
    return ''


def get_source_from_scene(scene_name):
    try:
        response = client.call(requests.GetSceneItemList(sceneName=scene_name))
        scene_list = SceneItemsResponse.from_dict(response.datain)
        return scene_list.sceneItems[0]
    except Exception as e:
        logger.error(f"Error getting source from scene: {e}")
        return ''


def get_screenshot():
    try:
        screenshot = util.make_unique_file_name(os.path.abspath(
            configuration.get_temporary_directory()) + '/screenshot.png')
        update_current_game()
        current_source = get_source_from_scene(get_current_game())
        current_source_name = current_source.sourceName
        if not current_source_name:
            logger.error("No active scene found.")
            return
        client.call(
            requests.SaveSourceScreenshot(sourceName=current_source_name, imageFormat='png', imageFilePath=screenshot))
        return screenshot
    except Exception as e:
        logger.error(f"Error getting screenshot: {e}")


def update_current_game():
    configuration.current_game = get_current_scene()


def get_current_game(sanitize=False):
    if not configuration.current_game:
        update_current_game()

    if sanitize:
        return util.sanitize_filename(configuration.current_game)
    return configuration.current_game
