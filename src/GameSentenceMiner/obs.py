import time

import obswebsocket
from obswebsocket import obsws, requests
from obswebsocket.exceptions import ConnectionFailure

from . import util
from . import configuration
from .configuration import *
from .model import *

client: obsws = None

# REFERENCE: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md


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
        client = obsws(host=get_config().obs.host, port=get_config().obs.port,
                       password=get_config().obs.password, authreconnect=1, on_connect=on_connect,
                       on_disconnect=on_disconnect)
        try:
            client.connect()
        except ConnectionFailure:
            logger.error("OBS Websocket Connection Has not been Set up, please set it up in Settings")
            exit(1)

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


# Start replay buffer
def start_replay_buffer():
    try:
        client.call(requests.GetVersion())
        client.call(requests.StartReplayBuffer())
    except Exception as e:
        print(f"Error starting replay buffer: {e}")


# Stop replay buffer
def stop_replay_buffer():
    try:
        client.call(requests.StopReplayBuffer())
        print("Replay buffer stopped.")
    except Exception as e:
        print(f"Error stopping replay buffer: {e}")


# Save the current replay buffer
def save_replay_buffer():
    try:
        client.call(requests.SaveReplayBuffer())
    except Exception as e:
        print(f"Error saving replay buffer: {e}")


def get_current_scene():
    try:
        response = client.call(requests.GetCurrentProgramScene())
        scene_info = SceneInfo.from_dict(response.datain)
        return scene_info.sceneName
    except Exception as e:
        print(f"Couldn't get scene: {e}")
    return ''


def get_source_from_scene(scene_name):
    try:
        response = client.call(requests.GetSceneItemList(sceneName=scene_name))
        scene_list = SceneItemsResponse.from_dict(response.datain)
        print(scene_list)
        return scene_list.sceneItems[0]
    except Exception as e:
        print(f"Error getting source from scene: {e}")
        return ''


def get_screenshot():
    try:
        screenshot = util.make_unique_file_name(os.path.abspath(configuration.get_temporary_directory()) + '/screenshot.png')
        update_current_game()
        current_source = get_source_from_scene(get_current_game())
        current_source_name = current_source.sourceName
        if not current_source_name:
            print("No active scene found.")
            return
        client.call(
            requests.SaveSourceScreenshot(sourceName=current_source_name, imageFormat='png', imageFilePath=screenshot))
        return screenshot
    except Exception as e:
        print(f"Error getting screenshot: {e}")


def update_current_game():
    configuration.current_game = get_current_scene()


def get_current_game(sanitize=False):
    if not configuration.current_game:
        update_current_game()

    if sanitize:
        return util.sanitize_filename(configuration.current_game)
    return configuration.current_game
