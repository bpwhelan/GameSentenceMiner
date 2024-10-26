import threading
import time

import requests
import obsws_python as obs

import anki
import configuration
import util
from configuration import *

# Global variables to track state
previous_note_ids = set()
first_run = True
obs_ws: obs.ReqClient = None


def connect_to_obs():
    global obs_ws
    # Connect to OBS WebSocket
    if get_config().obs.enabled:
        try:
            obs_ws = obs.ReqClient(host=get_config().obs.host, port=get_config().obs.port, password=get_config().obs.password)
            logger.info("Connected to OBS WebSocket.")
        except Exception as conn_exception:
            print(f"Error connecting to OBS WebSocket: {conn_exception}")


# Disconnect from OBS WebSocket
def disconnect_from_obs():
    global obs_ws
    if obs_ws:
        obs_ws.disconnect()
        obs_ws = None
        logger.info("Disconnected from OBS WebSocket.")


# Start replay buffer
def start_replay_buffer():
    try:
        obs_ws.start_replay_buffer()
    except Exception as e:
        print(f"Error starting replay buffer: {e}")


# Stop replay buffer
def stop_replay_buffer():
    try:
        obs_ws.stop_replay_buffer()
        print("Replay buffer stopped.")
    except Exception as e:
        print(f"Error stopping replay buffer: {e}")


# Fetch recent note IDs from Anki
def get_note_ids():
    try:
        response = requests.post(get_config().anki.url, json={
            "action": "findNotes",
            "version": 6,
            "params": {"query": "added:1"}
        })
        result = response.json()
        return set(result['result'])
    except Exception as e:
        print(f"Error fetching Anki notes: {e}")
        return None


# Save the current replay buffer
def save_replay_buffer():
    try:
        obs_ws.save_replay_buffer()
    except Exception as e:
        print(f"Error saving replay buffer: {e}")


# Check for new Anki cards and save replay buffer if detected
def check_for_new_cards():
    global previous_note_ids, first_run
    current_note_ids = get_note_ids()
    if not current_note_ids:
        return
    new_card_ids = current_note_ids - previous_note_ids
    if new_card_ids and not first_run:
        update_new_card()
    first_run = False
    previous_note_ids = current_note_ids  # Update the list of known notes


def update_new_card():
    last_card = anki.get_last_anki_card()
    use_prev_audio = util.use_previous_audio
    if util.lock.locked():
        print("Audio still being Trimmed, Card Queued!")
        use_prev_audio = True
    with util.lock:
        print(f"use previous audio: {use_prev_audio}")
        if get_config().obs.get_game_from_scene:
            configuration.current_game = get_current_scene()
        if use_prev_audio:
            anki.update_anki_card(last_card, reuse_audio=True)
        else:
            print("New card(s) detected!")
            save_replay_buffer()


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
        response = obs_ws.get_current_program_scene()
        return response.scene_name
    except Exception as e:
        print(f"Couldn't get scene: {e}")


def get_source_from_scene(scene_name):
    try:
        response = obs_ws.get_scene_item_list(scene_name)
        return response.scene_items[0]['sourceName']
    except Exception as e:
        print(f"Error getting source from scene: {e}")
        return None


def start_monitoring_anki():
    # Start monitoring anki
    if get_config().obs.enabled and get_config().features.full_auto:
        obs_thread = threading.Thread(target=monitor_anki)
        obs_thread.daemon = True  # Ensures the thread will exit when the main program exits
        obs_thread.start()


def get_screenshot():
    try:
        screenshot = util.make_unique_file_name(os.path.abspath(configuration.temp_directory) + '/screenshot.png')
        current_source = get_source_from_scene(get_current_scene())
        if not current_source:
            print("No active scene found.")
            return
        obs_ws.save_source_screenshot(current_source, 'png', screenshot, None, None, 100)
        return screenshot
    except Exception as e:
        print(f"Error getting screenshot: {e}")
