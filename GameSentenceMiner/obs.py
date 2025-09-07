import asyncio
import json
import os.path
import subprocess
import threading
import time
import logging
import contextlib

import psutil

import obsws_python as obs

from GameSentenceMiner.util import configuration
from GameSentenceMiner.util.configuration import get_app_directory, get_config, get_master_config, is_windows, save_full_config, reload_config, logger, gsm_status, gsm_state
from GameSentenceMiner.util.gsm_utils import sanitize_filename, make_unique_file_name
import tkinter as tk
from tkinter import messagebox

connection_pool: 'OBSConnectionPool' = None
event_client: obs.EventClient = None
obs_process_pid = None
OBS_PID_FILE = os.path.join(configuration.get_app_directory(), 'obs-studio', 'obs_pid.txt')
obs_connection_manager = None
logging.getLogger("obsws_python").setLevel(logging.CRITICAL)
connecting = False

class OBSConnectionPool:
    """Manages a pool of thread-safe connections to the OBS WebSocket."""
    def __init__(self, size=3, **kwargs):
        self.size = size
        self.connection_kwargs = kwargs
        self._clients = [None] * self.size
        self._locks = [threading.Lock() for _ in range(self.size)]
        self._next_idx = 0
        self._idx_lock = threading.Lock()
        logger.info(f"Initialized OBSConnectionPool with size {self.size}")

    def connect_all(self):
        """Initializes all client objects in the pool."""
        for i in range(self.size):
            try:
                self._clients[i] = obs.ReqClient(**self.connection_kwargs)
            except Exception as e:
                logger.error(f"Failed to create client {i} in pool: {e}")
        return True

    def disconnect_all(self):
        """Disconnects all clients in the pool."""
        for client in self._clients:
            if client:
                try:
                    client.disconnect()
                except Exception:
                    pass
        self._clients = [None] * self.size
        logger.info("Disconnected all clients in OBSConnectionPool.")

    def _check_and_reconnect(self, index):
        """Checks a specific client and reconnects if necessary."""
        client = self._clients[index]
        if not client:
            self._clients[index] = obs.ReqClient(**self.connection_kwargs)
            logger.info(f"Re-initialized client {index} in pool.")
            return
        try:
            client.get_version()
        except Exception:
            logger.info(f"Reconnecting client {index} in pool.")
            try:
                client.disconnect()
            except Exception:
                pass
            self._clients[index] = obs.ReqClient(**self.connection_kwargs)

    @contextlib.contextmanager
    def get_client(self):
        """A context manager to safely get a client from the pool."""
        with self._idx_lock:
            idx = self._next_idx
            self._next_idx = (self._next_idx + 1) % self.size

        lock = self._locks[idx]
        lock.acquire()
        try:
            self._check_and_reconnect(idx)
            yield self._clients[idx]
        finally:
            lock.release()

    def get_healthcheck_client(self):
        """Returns a dedicated client for health checks, separate from the main pool."""
        if not hasattr(self, '_healthcheck_client') or self._healthcheck_client is None:
            try:
                self._healthcheck_client = obs.ReqClient(**self.connection_kwargs)
                logger.info("Initialized dedicated healthcheck client.")
            except Exception as e:
                logger.error(f"Failed to create healthcheck client: {e}")
                self._healthcheck_client = None
        return self._healthcheck_client


class OBSConnectionManager(threading.Thread):
    def __init__(self, check_output=False):
        super().__init__()
        self.daemon = True
        self.running = True
        self.check_connection_interval = 1
        self.said_no_to_replay_buffer = False
        self.counter = 0
        self.check_output = check_output

    def run(self):
        while self.running:
            time.sleep(self.check_connection_interval)
            try:
                client = connection_pool.get_healthcheck_client() if connection_pool else None
                if client and not connecting:
                    client.get_version()
                else:
                    raise ConnectionError("Healthcheck client not healthy or not initialized")
            except Exception as e:
                logger.info(f"OBS WebSocket not connected. Attempting to reconnect... {e}")
                gsm_status.obs_connected = False
                asyncio.run(connect_to_obs())
            if self.counter % 5 == 0:
                try:
                    set_fit_to_screen_for_scene_items(get_current_scene())
                    if get_config().obs.turn_off_output_check and self.check_output:
                        replay_buffer_status = get_replay_buffer_status()
                        if replay_buffer_status and self.said_no_to_replay_buffer:
                            self.said_no_to_replay_buffer = False
                            self.counter = 0
                        if gsm_status.obs_connected and not replay_buffer_status and not self.said_no_to_replay_buffer:
                            try:
                                self.check_output()
                            except Exception:
                                pass
                except Exception as e:
                    logger.error(f"Error when running Extra Utils in OBS Health Check, Keeping ConnectionManager Alive: {e}")
            self.counter += 1

    def stop(self):
        self.running = False
    
    def check_output(self):
        img = get_screenshot_PIL(compression=100, img_format='jpg', width=1280, height=720)
        extrema = img.getextrema()
        if isinstance(extrema[0], tuple):
            is_empty = all(e[0] == e[1] for e in extrema)
        else:
            is_empty = extrema[0] == extrema[1]
        if is_empty:
            return
        else:
            root = tk.Tk()
            root.attributes('-topmost', True)
            root.withdraw()
            root.deiconify()
            result = messagebox.askyesno("GSM - Replay Buffer", "The replay buffer is not running, but there seems to be output in OBS. Do you want to start it? (If you click 'No', you won't be asked until you either restart GSM or start/stop replay buffer manually.)")
            root.destroy()
            if not result:
                self.said_no_to_replay_buffer = True
                self.counter = 0
                return
            start_replay_buffer()

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
    if not connection_pool:
        return False
    for _ in range(10):
        try:
            with connection_pool.get_client() as client:
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

async def connect_to_obs(retry=5, connections=2, check_output=False):
    global connection_pool, obs_connection_manager, event_client, connecting
    if is_windows():
        get_obs_websocket_config_values()

    while True:
        connecting = True
        try:
            pool_kwargs = {
                'host': get_config().obs.host,
                'port': get_config().obs.port,
                'password': get_config().obs.password,
                'timeout': 3,
            }
            connection_pool = OBSConnectionPool(size=connections, **pool_kwargs)
            connection_pool.connect_all()

            with connection_pool.get_client() as client:
                client.get_version() # Test one connection to confirm it works

            event_client = obs.EventClient(
                host=get_config().obs.host,
                port=get_config().obs.port,
                password=get_config().obs.password,
                timeout=1,
            )
            gsm_status.obs_connected = True
            logger.info("Connected to OBS WebSocket.")
            if not obs_connection_manager:
                obs_connection_manager = OBSConnectionManager(check_output=check_output)
                obs_connection_manager.start()
            update_current_game()
            break  # Exit the loop once connected
        except Exception as e:
            if retry <= 0:
                gsm_status.obs_connected = False
                logger.error(f"Failed to connect to OBS WebSocket: {e}")
                connection_pool = None
                event_client = None
                connecting = False
                break
            await asyncio.sleep(1)
            retry -= 1
    connecting = False

def connect_to_obs_sync(retry=2, connections=2, check_output=False):
    asyncio.run(connect_to_obs(retry=retry, connections=connections, check_output=check_output))


def disconnect_from_obs():
    global connection_pool
    if connection_pool:
        connection_pool.disconnect_all()
        connection_pool = None
        logger.info("Disconnected from OBS WebSocket.")

def do_obs_call(method_name: str, from_dict=None, retry=3, **kwargs):
    if not connection_pool:
        connect_to_obs_sync(retry=1)
    if not connection_pool:
        return None

    last_exception = None
    for _ in range(retry + 1):
        try:
            with connection_pool.get_client() as client:
                method_to_call = getattr(client, method_name)
                response = method_to_call(**kwargs)
                if response and response.ok:
                    return from_dict(response.datain) if from_dict else response.datain
            time.sleep(0.3)
        except AttributeError:
             logger.error(f"OBS client has no method '{method_name}'")
             return None
        except Exception as e:
            last_exception = e
            logger.error(f"Error calling OBS ('{method_name}'): {e}")
            if "socket is already closed" in str(e) or "object has no attribute" in str(e):
                time.sleep(0.3)
            else:
                return None
    logger.error(f"OBS call '{method_name}' failed after retries. Last error: {last_exception}")
    return None

def toggle_replay_buffer():
    try:
        with connection_pool.get_client() as client:
            response = client.toggle_replay_buffer()
        if response:
            logger.info("Replay buffer Toggled.")
    except Exception as e:
        logger.error(f"Error toggling buffer: {e}")

def start_replay_buffer():
    try:
        with connection_pool.get_client() as client:
            response = client.start_replay_buffer()
        if response and response.ok:
            logger.info("Replay buffer started.")
    except Exception as e:
        logger.error(f"Error starting replay buffer: {e}")

def get_replay_buffer_status():
    try:
        with connection_pool.get_client() as client:
            return client.get_replay_buffer_status().output_active
    except Exception as e:
        logger.debug(f"Error getting replay buffer status: {e}")
        return None

def stop_replay_buffer():
    try:
        with connection_pool.get_client() as client:
            response = client.stop_replay_buffer()
        if response and response.ok:
            logger.info("Replay buffer stopped.")
    except Exception as e:
        logger.warning(f"Error stopping replay buffer: {e}")

def save_replay_buffer():
    try:
        with connection_pool.get_client() as client:
            response = client.save_replay_buffer()
        if response and response.ok:
            logger.info("Replay buffer saved. If your log stops here, make sure your obs output path matches \"Path To Watch\" in GSM settings.")
    except Exception as e:
        raise Exception(f"Error saving replay buffer: {e}")

def get_current_scene():
    try:
        with connection_pool.get_client() as client:
            response = client.get_current_program_scene()
        return response.scene_name if response else ''
    except Exception as e:
        logger.debug(f"Couldn't get scene: {e}")
        return ''

def get_source_from_scene(scene_name):
    try:
        with connection_pool.get_client() as client:
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
        with connection_pool.get_client() as client:
            response = client.get_record_directory()
        return response.record_directory if response else ''
    except Exception as e:
        logger.error(f"Error getting recording folder: {e}")
        return ''

def get_obs_scenes():
    try:
        with connection_pool.get_client() as client:
            response = client.get_scene_list()
        return response.scenes if response else None
    except Exception as e:
        logger.error(f"Error getting scenes: {e}")
        return None

async def register_scene_change_callback(callback):
    if await wait_for_obs_connected():
        if not connection_pool:
            logger.error("OBS connection pool is not connected.")
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
        with connection_pool.get_client() as client:
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

        with connection_pool.get_client() as client:
            response = client.get_source_screenshot(name=current_source_name, img_format='png', quality=compression, width=width, height=height)

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
        with connection_pool.get_client() as client:
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



def set_fit_to_screen_for_scene_items(scene_name: str):
    """
    Sets all sources in a given scene to "Fit to Screen" (like Ctrl+F in OBS).
    """
    if not scene_name:
        return
        
    try:
        with connection_pool.get_client() as client:
            # 1. Get the canvas (base) resolution from OBS video settings
            video_settings = client.get_video_settings()
            if not hasattr(video_settings, 'base_width') or not hasattr(video_settings, 'base_height'):
                logger.debug("Video settings do not have base_width or base_height attributes, probably weird websocket error issue? Idk what causes it..")
                return
            canvas_width = video_settings.base_width
            canvas_height = video_settings.base_height

            # 2. Get the list of items in the specified scene
            scene_items_response = client.get_scene_item_list(scene_name)
            items = scene_items_response.scene_items if scene_items_response.scene_items else []

            if not items:
                logger.warning(f"No items found in scene '{scene_name}'.")
                return

            # 3. Loop through each item and apply the "Fit to Screen" transform
            for item in items:
                item_id = item['sceneItemId']
                source_name = item['sourceName']
                
                scene_item_transform = item.get('sceneItemTransform', {})
                
                source_width = scene_item_transform.get('sourceWidth', None)
                source_height = scene_item_transform.get('sourceHeight', None)

                aspect_ratio_different = False
                already_cropped = any([
                    scene_item_transform.get('cropLeft', 0) != 0,
                    scene_item_transform.get('cropRight', 0) != 0,
                    scene_item_transform.get('cropTop', 0) != 0,
                    scene_item_transform.get('cropBottom', 0) != 0,
                ])
                
                if source_width and source_height and not already_cropped:
                    source_aspect_ratio = source_width / source_height
                    canvas_aspect_ratio = canvas_width / canvas_height
                    aspect_ratio_different = abs(source_aspect_ratio - canvas_aspect_ratio) > 0.01

                    standard_ratios = [4 / 3, 16 / 9, 16 / 10, 21 / 9, 32 / 9, 5 / 4, 3 / 2]

                    def is_standard_ratio(ratio):
                        return any(abs(ratio - std) < 0.02 for std in standard_ratios)

                    if aspect_ratio_different:
                        if not (is_standard_ratio(source_aspect_ratio) and is_standard_ratio(canvas_aspect_ratio)):
                            aspect_ratio_different = False
                
                fit_to_screen_transform = {
                    'boundsType': 'OBS_BOUNDS_SCALE_INNER', 'alignment': 5,
                    'boundsWidth': canvas_width, 'boundsHeight': canvas_height,
                    'positionX': 0, 'positionY': 0,
                }
                
                if not already_cropped:
                    fit_to_screen_transform.update({
                        'cropLeft': 0 if not aspect_ratio_different or canvas_width > source_width else (source_width - canvas_width) // 2,
                        'cropRight': 0 if not aspect_ratio_different or canvas_width > source_width else (source_width - canvas_width) // 2,
                        'cropTop': 0 if not aspect_ratio_different or canvas_height > source_height else (source_height - canvas_height) // 2,
                        'cropBottom': 0 if not aspect_ratio_different or canvas_height > source_height else (source_height - canvas_height) // 2,
                    })

                try:
                    client.set_scene_item_transform(
                        scene_name=scene_name,
                        item_id=item_id,
                        transform=fit_to_screen_transform
                    )
                except obs.error.OBSSDKError as e:
                    logger.error(f"Failed to set transform for source '{source_name}': {e}")

    except obs.error.OBSSDKError as e:
        logger.error(f"An OBS error occurred: {e}")
    except Exception as e:
        logger.error(f"An unexpected error occurred: {e}")


def main():
    start_obs()
    # connect_to_obs() is async, main is not. Use the sync version.
    connect_to_obs_sync()
    # Test each method
    print("Testing `get_obs_path`:", get_obs_path())
    print("Testing `is_process_running` with PID 1:", is_process_running(1))
    print("Testing `check_obs_folder_is_correct`:")
    # This is async, need to run it in an event loop if testing from main
    asyncio.run(check_obs_folder_is_correct())
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
    try:
        save_replay_buffer()
    except Exception as e:
        print(f"Could not save replay buffer: {e}")
    current_scene = get_current_scene()
    print("Testing `get_current_scene`:", current_scene)
    print("Testing `get_source_from_scene` with current scene:", get_source_from_scene(current_scene))
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
    logging.basicConfig(level=logging.INFO)
    connect_to_obs_sync()
    set_fit_to_screen_for_scene_items(get_current_scene())