import requests as req
from obswebsocket import obsws, requests

import anki
import configuration
import util
from configuration import *
from model import *

# Global variables to track state
previous_note_ids = set()
first_run = True
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
        client.connect()
        time.sleep(1)
        if start_replay and get_config().obs.start_buffer:
            start_replay_buffer()
        configuration.current_game = get_current_scene()


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


# Fetch recent note IDs from Anki
def get_note_ids():
    response = req.post(get_config().anki.url, json={
        "action": "findNotes",
        "version": 6,
        "params": {"query": "added:1"}
    })
    result = response.json()
    return set(result['result'])


# Save the current replay buffer
def save_replay_buffer():
    try:
        client.call(requests.SaveReplayBuffer())
    except Exception as e:
        print(f"Error saving replay buffer: {e}")


# Check for new Anki cards and save replay buffer if detected
def check_for_new_cards():
    global previous_note_ids, first_run
    current_note_ids = set()
    try:
        current_note_ids = get_note_ids()
    except Exception as e:
        print(f"Error fetching Anki notes: {e}")
        return
    new_card_ids = current_note_ids - previous_note_ids
    if new_card_ids and not first_run:
        update_new_card()
    first_run = False
    previous_note_ids = current_note_ids  # Update the list of known notes


def update_new_card():
    last_card = anki.get_last_anki_card()
    if not check_tags_for_should_update(last_card):
        logger.info("Card not tagged properly! Not updating!")
        return

    use_prev_audio = util.use_previous_audio
    if util.lock.locked():
        print("Audio still being Trimmed, Card Queued!")
        use_prev_audio = True
    with util.lock:
        print(f"use previous audio: {use_prev_audio}")
        if get_config().obs.get_game_from_scene:
            configuration.current_game = get_current_scene()
        if use_prev_audio:
            anki.update_anki_card(last_card, note=anki.get_initial_card_info(last_card), reuse_audio=True)
        else:
            print("New card(s) detected!")
            save_replay_buffer()


def check_tags_for_should_update(last_card):
    if get_config().anki.tags_to_check:
        found = False
        for tag in last_card['tags']:
            logger.info(tag)
            logger.info(get_config().anki.tags_to_check)
            if tag.lower() in get_config().anki.tags_to_check:
                found = True
                break
        return found
    else:
        return True


# Main function to handle the script lifecycle
def monitor_anki():
    try:
        # Continuously check for new cards
        while True:
            check_for_new_cards()
            time.sleep(get_config().anki.polling_rate / 1000.0)  # Check every 200ms
    except KeyboardInterrupt:
        print("Stopped Checking For Anki Cards...")


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


def start_monitoring_anki():
    # Start monitoring anki
    if get_config().obs.enabled and get_config().features.full_auto:
        obs_thread = threading.Thread(target=monitor_anki)
        obs_thread.daemon = True  # Ensures the thread will exit when the main program exits
        obs_thread.start()


def get_screenshot():
    try:
        screenshot = util.make_unique_file_name(os.path.abspath(configuration.temp_directory) + '/screenshot.png')
        configuration.current_game = get_current_scene()
        current_source = get_source_from_scene(configuration.current_game)
        current_source_name = current_source.sourceName
        if not current_source_name:
            print("No active scene found.")
            return
        client.call(
            requests.SaveSourceScreenshot(sourceName=current_source_name, imageFormat='png', imageFilePath=screenshot))
        return screenshot
    except Exception as e:
        print(f"Error getting screenshot: {e}")
