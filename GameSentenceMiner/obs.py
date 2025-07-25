import asyncio
import os.path
import subprocess
import threading
import time
from pprint import pprint

import psutil

import obsws_python as obs

from GameSentenceMiner.util import configuration
from GameSentenceMiner.util.configuration import *
from GameSentenceMiner.util.gsm_utils import sanitize_filename, make_unique_file_name

client: obs.ReqClient = None
event_client: obs.EventClient = None
obs_process_pid = None
OBS_PID_FILE = os.path.join(configuration.get_app_directory(), 'obs-studio', 'obs_pid.txt')
obs_connection_manager = None
logging.getLogger("obsws_python").setLevel(logging.CRITICAL)
connecting = False

class OBSConnectionManager(threading.Thread):
    def __init__(self):
        super().__init__()
        self.daemon = True
        self.running = True

    def run(self):
        while self.running:
            time.sleep(1)
            try:
                if not connecting:
                    client.get_version()
            except Exception as e:
                logger.info(f"OBS WebSocket not connected. Attempting to reconnect... {e}")
                gsm_status.obs_connected = False
                asyncio.run(connect_to_obs())

    def stop(self):
        self.running = False

def get_obs_path():
    return os.path.join(configuration.get_app_directory(), 'obs-studio/bin/64bit/obs64.exe')

def is_process_running(pid):
    try:
        process = psutil.Process(pid)
        return 'obs' in process.exe()
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
        if os.path.exists(OBS_PID_FILE):
            os.remove(OBS_PID_FILE)
        return False

def start_obs():
    global obs_process_pid
    if os.path.exists(OBS_PID_FILE):
        with open(OBS_PID_FILE, "r") as f:
            try:
                obs_process_pid = int(f.read().strip())
                if is_process_running(obs_process_pid):
                    print(f"OBS is already running with PID: {obs_process_pid}")
                    return obs_process_pid
            except ValueError:
                print("Invalid PID found in file. Launching new OBS instance.")
            except OSError:
                print("No process found with the stored PID. Launching new OBS instance.")

    obs_path = get_obs_path()
    if not os.path.exists(obs_path):
        print(f"OBS not found at {obs_path}. Please install OBS.")
        return None
    try:
        obs_process = subprocess.Popen([obs_path, '--disable-shutdown-check', '--portable', '--startreplaybuffer', ], cwd=os.path.dirname(obs_path))
        obs_process_pid = obs_process.pid
        with open(OBS_PID_FILE, "w") as f:
            f.write(str(obs_process_pid))
        print(f"OBS launched with PID: {obs_process_pid}")
        return obs_process_pid
    except Exception as e:
        print(f"Error launching OBS: {e}")
        return None

async def wait_for_obs_connected():
    global client
    if not client:
        return False
    for _ in range(10):
        try:
            response = client.get_version()
            if response:
                return True
        except Exception as e:
            logger.debug(f"Waiting for OBS connection: {e}")
            await asyncio.sleep(1)
    return False

async def check_obs_folder_is_correct():
    if await wait_for_obs_connected():
        obs_record_directory = get_record_directory()
        if obs_record_directory and os.path.normpath(obs_record_directory) != os.path.normpath(
                get_config().paths.folder_to_watch):
            logger.info("OBS Path wrong, Setting OBS Recording folder in GSM Config...")
            get_config().paths.folder_to_watch = os.path.normpath(obs_record_directory)
            get_master_config().sync_shared_fields()
            save_full_config(get_master_config())
        else:
            logger.debug("OBS Recording path looks correct")


def get_obs_websocket_config_values():
    config_path = os.path.join(get_app_directory(), 'obs-studio', 'config', 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json')

    if not os.path.isfile(config_path):
        raise FileNotFoundError(f"OBS WebSocket config not found at {config_path}")

    with open(config_path, 'r') as file:
        config = json.load(file)

    server_enabled = config.get("server_enabled", False)
    server_port = config.get("server_port", 7274)
    server_password = config.get("server_password", None)

    if not server_enabled:
        logger.info("OBS WebSocket server is not enabled. Enabling it now... Restart OBS for changes to take effect.")
        config["server_enabled"] = True
        with open(config_path, 'w') as file:
            json.dump(config, file, indent=4)

    if get_config().obs.password == 'your_password':
        logger.info("OBS WebSocket password is not set. Setting it now...")
        full_config = get_master_config()
        full_config.get_config().obs.port = server_port
        full_config.get_config().obs.password = server_password
        full_config.sync_shared_fields()
        full_config.save()
        reload_config()

async def connect_to_obs(retry=5):
    global client, obs_connection_manager, event_client, connecting
    if not get_config().obs.enabled:
        return

    if is_windows():
        get_obs_websocket_config_values()

    while True:
        connecting = True
        try:
            client = obs.ReqClient(
                host=get_config().obs.host,
                port=get_config().obs.port,
                password=get_config().obs.password,
                timeout=1,
            )
            event_client = obs.EventClient(
                host=get_config().obs.host,
                port=get_config().obs.port,
                password=get_config().obs.password,
                timeout=1,
            )
            gsm_status.obs_connected = True
            logger.info("Connected to OBS WebSocket.")
            if not obs_connection_manager:
                obs_connection_manager = OBSConnectionManager()
                obs_connection_manager.start()
            update_current_game()
            break  # Exit the loop once connected
        except Exception as e:
            if retry <= 0:
                gsm_status.obs_connected = False
                logger.error(f"Failed to connect to OBS WebSocket: {e}")
                client = None
                event_client = None
                connecting = False
                break
            await asyncio.sleep(1)
            retry -= 1
    connecting = False

def connect_to_obs_sync(retry=2):
    global client, obs_connection_manager, event_client
    if not get_config().obs.enabled or client:
        return

    if is_windows():
        get_obs_websocket_config_values()

    while True:
        try:
            client = obs.ReqClient(
                host=get_config().obs.host,
                port=get_config().obs.port,
                password=get_config().obs.password,
                timeout=1,
            )
            event_client = obs.EventClient(
                host=get_config().obs.host,
                port=get_config().obs.port,
                password=get_config().obs.password,
                timeout=1,
            )
            if not obs_connection_manager:
                obs_connection_manager = OBSConnectionManager()
                obs_connection_manager.start()
            update_current_game()
            logger.info("Connected to OBS WebSocket.")
            break  # Exit the loop once connected
        except Exception as e:
            if retry <= 0:
                gsm_status.obs_connected = False
                logger.error(f"Failed to connect to OBS WebSocket: {e}")
                client = None
                event_client = None
                connecting = False
                break
            time.sleep(1)
            retry -= 1


def disconnect_from_obs():
    global client
    if client:
        client.disconnect()
        client = None
        logger.info("Disconnected from OBS WebSocket.")

def do_obs_call(request, *args, from_dict=None, retry=3):
    connect_to_obs()
    if not client:
        return None
    for _ in range(retry + 1):
        try:
            response = request(*args)
            if response and response.ok:
                return from_dict(response.datain) if from_dict else response.datain
            time.sleep(0.3)
        except Exception as e:
            logger.error(f"Error calling OBS: {e}")
            if "socket is already closed" in str(e) or "object has no attribute" in str(e):
                time.sleep(0.3)
            else:
                return None
    return None

def toggle_replay_buffer():
    try:
        response = client.toggle_replay_buffer()
        if response:
            logger.info("Replay buffer Toggled.")
    except Exception as e:
        logger.error(f"Error toggling buffer: {e}")

def start_replay_buffer():
    try:
        status = get_replay_buffer_status()
        if status:
            client.start_replay_buffer()
    except Exception as e:
        logger.error(f"Error starting replay buffer: {e}")

def get_replay_buffer_status():
    try:
        return client.get_replay_buffer_status().output_active
    except Exception as e:
        logger.warning(f"Error getting replay buffer status: {e}")
        return None

def stop_replay_buffer():
    try:
        client.stop_replay_buffer()
    except Exception as e:
        logger.warning(f"Error stopping replay buffer: {e}")

def save_replay_buffer():
    status = get_replay_buffer_status()
    if status:
        response = client.save_replay_buffer()
        if response and response.ok:
            logger.info("Replay buffer saved. If your log stops here, make sure your obs output path matches \"Path To Watch\" in GSM settings.")
    else:
        raise Exception("Replay Buffer is not active, could not save Replay Buffer!")

def get_current_scene():
    try:
        response = client.get_current_program_scene()
        return response.scene_name if response else ''
    except Exception as e:
        logger.debug(f"Couldn't get scene: {e}")
        return ''

def get_source_from_scene(scene_name):
    try:
        response = client.get_scene_item_list(name=scene_name)
        return response.scene_items[0] if response and response.scene_items else ''
    except Exception as e:
        logger.error(f"Error getting source from scene: {e}")
        return ''

def get_active_source():
    current_game = get_current_game()
    if not current_game:
        return None
    return get_source_from_scene(current_game)

def get_record_directory():
    try:
        response = client.get_record_directory()
        return response.record_directory if response else ''
    except Exception as e:
        logger.error(f"Error getting recording folder: {e}")
        return ''

def get_obs_scenes():
    try:
        response = client.get_scene_list()
        return response.scenes if response else None
    except Exception as e:
        logger.error(f"Error getting scenes: {e}")
        return None

async def register_scene_change_callback(callback):
    global client
    if await wait_for_obs_connected():
        if not client:
            logger.error("OBS client is not connected.")
            return

        def on_current_program_scene_changed(data):
            scene_name = data.scene_name
            if scene_name:
                callback(scene_name)

        event_client.callback.register(on_current_program_scene_changed)

        logger.info("Scene change callback registered.")


def get_screenshot(compression=-1):
    try:
        screenshot = os.path.join(configuration.get_temporary_directory(), make_unique_file_name('screenshot.png'))
        update_current_game()
        if not configuration.current_game:
            logger.error("No active game scene found.")
            return None
        current_source = get_source_from_scene(configuration.current_game)
        current_source_name = current_source.get('sourceName') if isinstance(current_source, dict) else None
        if not current_source_name:
            logger.error("No active source found in the current scene.")
            return None
        start = time.time()
        logger.debug(f"Current source name: {current_source_name}")
        client.save_source_screenshot(name=current_source_name, img_format='png', width=None, height=None, file_path=screenshot, quality=compression)
        logger.debug(f"Screenshot took {time.time() - start:.3f} seconds to save")
        return screenshot
    except Exception as e:
        logger.error(f"Error getting screenshot: {e}")
        return None

def get_screenshot_base64(compression=75, width=None, height=None):
    try:
        update_current_game()
        current_game = get_current_game()
        if not current_game:
            logger.error("No active game scene found.")
            return None
        current_source = get_source_from_scene(current_game)
        current_source_name = current_source.get('sourceName') if isinstance(current_source, dict) else None
        if not current_source_name:
            logger.error("No active source found in the current scene.")
            return None
        # version = client.send("GetVersion", raw=True)
        # pprint(version)
        # responseraw = client.send("GetSourceScreenshot", {"sourceName": current_source_name, "imageFormat": "png", "imageWidth": width, "imageHeight": height, "compressionQuality": compression}, raw=True)
        response = client.get_source_screenshot(name=current_source_name, img_format='png', quality=compression, width=width, height=height)
        # print(responseraw)
        if response and response.image_data:
            return response.image_data.split(',', 1)[-1]  # Remove data:image/png;base64, prefix if present
        else:
            logger.error(f"Error getting base64 screenshot: {response}")
            return None
    except Exception as e:
        logger.error(f"Error getting screenshot: {e}")
        return None
    

def get_screenshot_PIL(source_name=None, compression=75, img_format='png', width=None, height=None, retry=3):
    import io
    import base64
    from PIL import Image
    if not source_name:
        source_name = get_active_source().get('sourceName', None)
    if not source_name:
        logger.error("No active source found in the current scene.")
        return None
    while True:
        response = client.get_source_screenshot(name=source_name, img_format=img_format, quality=compression, width=width, height=height)
        try:
            response.image_data = response.image_data.split(',', 1)[-1]  # Remove data:image/png;base64, prefix if present
        except AttributeError:
            retry -= 1
            if retry <= 0:
                logger.error(f"Error getting screenshot: {response}")
                return None
            continue
        if response and response.image_data:
            image_data = response.image_data.split(',', 1)[-1]  # Remove data:image/png;base64, prefix if present
            image_data = base64.b64decode(image_data)
            img = Image.open(io.BytesIO(image_data)).convert("RGBA")
        # if width and height:
            # img = img.resize((width, height), Image.Resampling.LANCZOS)
            return img
    return None

    
    

def update_current_game():
    gsm_state.current_game = get_current_scene()

def get_current_game(sanitize=False, update=True):
    if not gsm_state.current_game or update:
        update_current_game()

    if sanitize:
        return sanitize_filename(gsm_state.current_game)
    return gsm_state.current_game


def main():
    start_obs()
    connect_to_obs()
    # Test each method
    print("Testing `get_obs_path`:", get_obs_path())
    print("Testing `is_process_running` with PID 1:", is_process_running(1))
    print("Testing `check_obs_folder_is_correct`:")
    check_obs_folder_is_correct()
    print("Testing `get_obs_websocket_config_values`:")
    try:
        get_obs_websocket_config_values()
    except FileNotFoundError as e:
        print(e)
    print("Testing `toggle_replay_buffer`:")
    toggle_replay_buffer()
    print("Testing `start_replay_buffer`:")
    start_replay_buffer()
    print("Testing `get_replay_buffer_status`:", get_replay_buffer_status())
    print("Testing `stop_replay_buffer`:")
    stop_replay_buffer()
    print("Testing `save_replay_buffer`:")
    save_replay_buffer()
    current_scene = get_current_scene()
    print("Testing `get_current_scene`:", current_scene)
    print("Testing `get_source_from_scene` with dummy scene:", get_source_from_scene(current_scene))
    print("Testing `get_record_directory`:", get_record_directory())
    print("Testing `get_obs_scenes`:", get_obs_scenes())
    print("Testing `get_screenshot`:", get_screenshot())
    print("Testing `get_screenshot_base64`:")
    get_screenshot_base64()
    print("Testing `update_current_game`:")
    update_current_game()
    print("Testing `get_current_game`:", get_current_game())
    disconnect_from_obs()

if __name__ == '__main__':
    from mss import mss
    logging.basicConfig(level=logging.INFO)
    # main()
    connect_to_obs_sync()
    # i = 100
    # for i in range(1, 100):
    #     print(f"Getting screenshot {i}")
    #     start = time.time()
    # # get_screenshot(compression=95)
    # # get_screenshot_base64(compression=95, width=1280, height=720)
    
    #     img = get_screenshot_PIL(compression=i, img_format='jpg', width=1280, height=720)
    #     end = time.time()
    #     print(f"Time taken to get screenshot with compression {i}: {end - start} seconds")
        
    # for i in range(1, 100):
    #     print(f"Getting screenshot {i}")
    #     start = time.time()
    # # get_screenshot(compression=95)
    # # get_screenshot_base64(compression=95, width=1280, height=720)
    
    #     img = get_screenshot_PIL(compression=i, img_format='jpg', width=2560, height=1440)
    #     end = time.time()
    #     print(f"Time taken to get screenshot full sized jpg with compression {i}: {end - start} seconds")

    # png_img = get_screenshot_PIL(compression=75, img_format='png', width=1280, height=720)

    # jpg_img = get_screenshot_PIL(compression=100, img_format='jpg', width=2560, height=1440)

    # png_img.show()
    # jpg_img.show()
    
    # start = time.time()
    # with mss() as sct:
    #     monitor = sct.monitors[1]
    #     sct_img = sct.grab(monitor)
    #     img = Image.frombytes('RGB', sct_img.size, sct_img.bgra, 'raw', 'BGRX')
    #     img.show()
    # end = time.time()
    # print(f"Time taken to get screenshot with mss: {end - start} seconds")

    
    # print(get_screenshot_base64(compression=75, width=1280, height=720))

