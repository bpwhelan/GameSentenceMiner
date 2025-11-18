import asyncio
import datetime
import json
import os.path
import subprocess
import threading
import time
import logging
import contextlib
import shutil
import queue

import psutil

import obsws_python as obs
import numpy as np

from GameSentenceMiner.util import configuration
from GameSentenceMiner.util.configuration import get_app_directory, get_config, get_master_config, is_windows, save_full_config, reload_config, logger, gsm_status, gsm_state
from GameSentenceMiner.util.gsm_utils import sanitize_filename, make_unique_file_name, make_unique_temp_file

# Thread-safe queue for GUI error messages
_gui_error_queue = queue.Queue()

def _queue_error_for_gui(title, message, recheck_function=None):
    _gui_error_queue.put((title, message, recheck_function))

def get_queued_gui_errors():
    errors = []
    try:
        while True:
            errors.append(_gui_error_queue.get_nowait())
    except queue.Empty:
        pass
    return errors

connection_pool: 'OBSConnectionPool' = None
event_client: obs.EventClient = None
obs_process_pid = None
OBS_PID_FILE = os.path.join(configuration.get_app_directory(), 'obs_pid.txt')
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
        self.connected_once = False
        self.last_error_shown = [None] * self.size
        logger.info(f"Initialized OBSConnectionPool with size {self.size}")

    def connect_all(self):
        """Initializes all client objects in the pool."""
        for i in range(self.size):
            try:
                self._clients[i] = obs.ReqClient(**self.connection_kwargs)
                self.connected_once = True
            except Exception as e:
                if str(e) == self.last_error_shown[i]:
                    continue
                if self.connected_once:
                    logger.error(f"Failed to create client {i} in pool during initial connection: {e}")
                self.last_error_shown[i] = str(e)
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
    def get_client(self) -> obs.ReqClient:
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
            except Exception as e:
                logger.error(f"Failed to create healthcheck client: {e}")
                self._healthcheck_client = None
        return self._healthcheck_client


class OBSConnectionManager(threading.Thread):
    def __init__(self, check_output=False):
        super().__init__()
        self.daemon = True
        self.running = True
        self.should_check_output = check_output
        self.check_connection_interval = 5
        self.counter = 0
        self.last_replay_buffer_status = None
        self.no_output_timestamp = None
        self.NO_OUTPUT_SHUTDOWN_SECONDS = 300
        self.last_errors = []
        self.previous_image = None

    def _check_obs_connection(self):
        try:
            client = connection_pool.get_healthcheck_client() if connection_pool else None
            if client and not connecting:
                client.get_version()
                gsm_status.obs_connected = True
                return True
            else:
                raise ConnectionError("Healthcheck client not available or connection in progress")
        except Exception as e:
            logger.debug(f"OBS WebSocket not connected. Attempting to reconnect... {e}")
            gsm_status.obs_connected = False
            asyncio.run(connect_to_obs())
            return False
        
    def check_replay_buffer_enabled(self):
        if not self.should_check_output:
            return 300, ""
        buffer_seconds = get_replay_buffer_max_time_seconds()
        if not buffer_seconds:
            replay_output = get_replay_buffer_output()
            if not replay_output:
                return 0, "Replay Buffer output not found in OBS. Please enable Replay Buffer In OBS Settings -> Output -> Replay Buffer. I recommend 300 seconds (5 minutes) or higher."
            return 300, ""
        return buffer_seconds, ""

    def _manage_replay_buffer_and_utils(self):
        errors = []
        
        if not self.should_check_output:
            return errors
        
        set_fit_to_screen_for_scene_items(get_current_scene())
            
        if not get_config().obs.automatically_manage_replay_buffer:
            errors.append("Automatic Replay Buffer management is disabled in GSM settings.")
            return errors

        buffer_seconds, error_message = self.check_replay_buffer_enabled()
        
        if not buffer_seconds:
            # Queue the error message to be shown safely in the main thread
            _queue_error_for_gui("OBS Replay Buffer Error", error_message + "\n\nTo disable this message, turn off 'Automatically Manage Replay Buffer' in GSM settings.", recheck_function=get_replay_buffer_output)
            return errors

        gsm_state.replay_buffer_length = buffer_seconds or 300

        if not buffer_seconds:
            errors.append(error_message)
            return errors

        self.NO_OUTPUT_SHUTDOWN_SECONDS = min(max(300, buffer_seconds * 1.10), 1800)  # At least 5 minutes or 10% more than buffer, but no more than 30 minutes

        current_status = get_replay_buffer_status()

        if self.last_replay_buffer_status is None:
            self.last_replay_buffer_status = current_status
            return errors

        if current_status != self.last_replay_buffer_status:
            errors.append("Replay Buffer Changed Externally, Not Managing Automatically.")
            self.no_output_timestamp = None
            return errors
        
        img = get_screenshot_PIL(compression=50, img_format='jpg', width=640, height=360)
        is_empty = self.is_image_empty(img) if img else True

        if not is_empty:
            self.no_output_timestamp = None
            if not current_status:
                start_replay_buffer()
                self.last_replay_buffer_status = True
        else: # is_empty
            if current_status:
                if self.no_output_timestamp is None:
                    self.no_output_timestamp = time.time()
                elif time.time() - self.no_output_timestamp >= self.NO_OUTPUT_SHUTDOWN_SECONDS:
                    stop_replay_buffer()
                    self.last_replay_buffer_status = False
                    self.no_output_timestamp = None

    def is_image_empty(self, img):
        try:
            extrema = img.getextrema()
            if isinstance(extrema[0], tuple):
                is_empty = all(e[0] == e[1] for e in extrema)
            else:
                is_empty = extrema[0] == extrema[1]
            return is_empty
        except Exception:
            logger.warning("Failed to check image extrema for emptiness.")
            return False

    def run(self):
        time.sleep(5)  # Initial delay to allow OBS to start
        while self.running:
            time.sleep(self.check_connection_interval)

            if not self._check_obs_connection():
                continue

            if self.counter % 2 == 0:
                try:
                    errors = self._manage_replay_buffer_and_utils()
                    if errors != self.last_errors:
                        if errors:
                            for error in errors:
                                logger.error(f"OBS Health Check: {error}")
                    self.last_errors = errors
                except Exception as e:
                    logger.error(f"Error when running Extra Utils in OBS Health Check, Keeping ConnectionManager Alive: {e}")
            self.counter += 1

    def stop(self):
        self.running = False
        
def get_base_obs_dir():
    return os.path.join(configuration.get_app_directory(), 'obs-studio')
    
def get_obs_path():
    config = get_config()
    if config.obs.obs_path:
        return config.obs.obs_path
    return os.path.join(configuration.get_app_directory(), 'obs-studio/bin/64bit/obs64.exe')

def is_process_running(pid):
    try:
        process = psutil.Process(pid)
        return 'obs' in process.exe().lower()
    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
        if os.path.exists(OBS_PID_FILE):
            os.remove(OBS_PID_FILE)
        return False

def start_obs(force_restart=False):
    global obs_process_pid
    if os.path.exists(OBS_PID_FILE):
        with open(OBS_PID_FILE, "r") as f:
            try:
                obs_process_pid = int(f.read().strip())
                if is_process_running(obs_process_pid):
                    if force_restart:
                        try:
                            process = psutil.Process(obs_process_pid)
                            process.terminate()
                            process.wait(timeout=10)
                            print("OBS process terminated for restart.")
                        except Exception as e:
                            print(f"Error terminating OBS process: {e}")
                    else:
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
        sentinel_folder = os.path.join(configuration.get_app_directory(), 'obs-studio', 'config', 'obs-studio', '.sentinel')
        if os.path.exists(sentinel_folder):
            try:
                if os.path.isdir(sentinel_folder):
                    shutil.rmtree(sentinel_folder)
                else:
                    os.remove(sentinel_folder)
                print(f"Deleted sentinel folder: {sentinel_folder}")
            except Exception as e:
                print(f"Failed to delete sentinel folder: {e}")
        
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
                client: obs.ReqClient
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
    if connection_pool:
        return
    
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
            if get_config().features.generate_longplay and check_output:
                start_recording(True)
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
    global connection_pool, obs_connection_manager, event_client, connecting
    if connection_pool:
        return
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
            if get_config().features.generate_longplay and check_output:
                start_recording(True)
            break  # Exit the loop once connected
        except Exception as e:
            if retry <= 0:
                gsm_status.obs_connected = False
                logger.error(f"Failed to connect to OBS WebSocket: {e}")
                connection_pool = None
                event_client = None
                connecting = False
                break
            time.sleep(1)
            retry -= 1
    connecting = False


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
            client: obs.ReqClient
            client.toggle_replay_buffer()
            logger.info("Replay buffer Toggled.")
    except Exception as e:
        logger.error(f"Error toggling buffer: {e}")

def start_replay_buffer():
    try:
        with connection_pool.get_client() as client:
            client: obs.ReqClient
            client.start_replay_buffer()
            if get_config().features.generate_longplay:
                start_recording(True)
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
            client: obs.ReqClient
            client.stop_replay_buffer()
            if get_config().features.generate_longplay:
                stop_recording()
            logger.info("Replay buffer stopped.")
    except Exception as e:
        logger.warning(f"Error stopping replay buffer: {e}")

def save_replay_buffer():
    try:
        with connection_pool.get_client() as client:
            client: obs.ReqClient
            client.save_replay_buffer()
            logger.info("Replay buffer saved. If your log stops here, make sure your obs output path matches \"Path To Watch\" in GSM settings.")
    except Exception as e:
        raise Exception(f"Error saving replay buffer: {e}")

def start_recording(longplay=False):
    try:
        with connection_pool.get_client() as client:
            client: obs.ReqClient
            if longplay:
                gsm_state.recording_started_time = datetime.datetime.now()
                gsm_state.current_srt = make_unique_temp_file(f"{get_current_game(sanitize=True)}.srt")
                gsm_state.srt_index = 1
            client.start_record()
            logger.info("Recording started.")
    except Exception as e:
        logger.error(f"Error starting recording: {e}")
        return None
    
def stop_recording():
    try:
        with connection_pool.get_client() as client:
            client: obs.ReqClient
            client.stop_record()
            logger.info("Recording stopped.")
    except Exception as e:
        logger.error(f"Error stopping recording: {e}")
        
def get_last_recording_filename():
    try:
        with connection_pool.get_client() as client:
            client: obs.ReqClient
            response = client.get_record_status()
        return response.recording_filename if response else ''
    except Exception as e:
        logger.error(f"Error getting last recording filename: {e}")
        return ''

def get_current_scene():
    try:
        with connection_pool.get_client() as client:
            client: obs.ReqClient
            response = client.get_current_program_scene()
        return response.scene_name if response else ''
    except Exception as e:
        logger.debug(f"Couldn't get scene: {e}")
        return ''

def get_source_from_scene(scene_name):
    try:
        with connection_pool.get_client() as client:
            client: obs.ReqClient
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

def get_active_video_sources():
    current_game = get_current_game()
    if not current_game:
        return None
    scene_items_response = []
    try:
        with connection_pool.get_client() as client:
            client: obs.ReqClient
            response = client.get_scene_item_list(name=current_game)
            scene_items_response = response.scene_items if response else []
    except Exception as e:
        logger.error(f"Error getting scene items for active video source: {e}")
        return None
    if not scene_items_response:
        return None
    video_sources = ['window_capture', 'game_capture', 'monitor_capture']
    active_video_sources = [item for item in scene_items_response if item.get('inputKind') in video_sources]
    # active_video_sources = []
    
    return active_video_sources if active_video_sources else [scene_items_response[0]]

def get_record_directory():
    try:
        with connection_pool.get_client() as client:
            client: obs.ReqClient
            response = client.get_record_directory()
        return response.record_directory if response else ''
    except Exception as e:
        logger.error(f"Error getting recording folder: {e}")
        return ''
    
def get_replay_buffer_max_time_seconds():
    """
    Gets the configured maximum replay buffer time in seconds using the v5 protocol.
    """
    try:
        # Assumes a connection_pool object that provides a connected client
        with connection_pool.get_client() as client:
            client: obs.ReqClient
            # For v5, we get settings for the 'replay_buffer' output
            response = client.get_output_settings(name='Replay Buffer')
            
            # The response object contains a dict of the actual settings
            if response:
                # The key for replay buffer length in seconds is 'max_time_sec'
                settings = response.output_settings
                if settings and 'max_time_sec' in settings:
                    return settings['max_time_sec']
                else:
                    return 300
            else:
                logger.warning(f"get_output_settings for replay_buffer failed: {response.status}")
                return 0
    except Exception as e:
        # logger.error(f"Exception while fetching replay buffer settings: {e}")
        return 0
    
def enable_replay_buffer():
    try:
        with connection_pool.get_client() as client:
            client: obs.ReqClient
            response = client.set_output_settings(name='Replay Buffer', settings={'outputFlags': {'OBS_OUTPUT_AUDIO': True, 'OBS_OUTPUT_ENCODED': True, 'OBS_OUTPUT_MULTI_TRACK': True, 'OBS_OUTPUT_SERVICE': False, 'OBS_OUTPUT_VIDEO': True}})
        if response and response.ok:
            logger.info("Replay buffer enabled.")
            return True
        else:
            logger.error(f"Failed to enable replay buffer: {response.status if response else 'No response'}")
            return False
    except Exception as e:
        logger.error(f"Error enabling replay buffer: {e}")
        return False
    
def get_output_list():
    try:
        with connection_pool.get_client() as client:
            client: obs.ReqClient
            response = client.get_output_list()
        return response.outputs if response else None
    except Exception as e:
        logger.error(f"Error getting output list: {e}")
        return None
    
def get_replay_buffer_output():
    outputs = get_output_list()
    if not outputs:
        return None
    for output in outputs:
        if output.get('outputKind') == 'replay_buffer':
            return output
    return None

def get_obs_scenes():
    try:
        with connection_pool.get_client() as client:
            client: obs.ReqClient
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
    

def get_screenshot_PIL_from_source(source_name, compression=75, img_format='png', width=None, height=None, retry=3):
    """
    Get a PIL Image screenshot from a specific OBS source.
    
    Args:
        source_name: The name of the OBS source to capture
        compression: Image quality (0-100)
        img_format: Image format ('png' or 'jpg')
        width: Optional width to resize
        height: Optional height to resize
        retry: Number of retry attempts
        
    Returns:
        PIL.Image or None if failed
    """
    import io
    import base64
    from PIL import Image
    
    if not source_name:
        logger.error("No source name provided.")
        return None
        
    for attempt in range(retry):
        try:
            with connection_pool.get_client() as client:
                client: obs.ReqClient
                response = client.get_source_screenshot(name=source_name, img_format=img_format, quality=compression, width=width, height=height)
            
            if response and hasattr(response, 'image_data') and response.image_data:
                image_data = response.image_data.split(',', 1)[-1]  # Remove data:image/png;base64, prefix if present
                image_data = base64.b64decode(image_data)
                img = Image.open(io.BytesIO(image_data)).convert("RGBA")
                return img
        except AttributeError:
            if attempt >= retry - 1:
                logger.error(f"Error getting screenshot from source '{source_name}': Invalid response")
                return None
            time.sleep(0.1)
        except Exception as e:
            # logger.error(f"Error getting screenshot from source '{source_name}': {e}")
            return None
    
    return None


def get_best_source_for_screenshot():
    """
    Get the best available video source dict based on priority and image validation.
    
    Priority order: window_capture > game_capture > monitor_capture
    
    Returns:
        The source dict of the best available source, or None if no valid source found.
    """
    return get_screenshot_PIL(return_source_dict=True)


def get_screenshot_PIL(source_name=None, compression=75, img_format='png', width=None, height=None, retry=3, return_source_dict=False):
    """
    Get a PIL Image screenshot. If no source_name is provided, automatically selects
    the best available source based on priority and validates it has actual image data.
    
    Priority order: window_capture > game_capture > monitor_capture
    
    Args:
        source_name: Optional specific OBS source name. If None, auto-selects best source.
        compression: Image quality (0-100)
        img_format: Image format ('png' or 'jpg')
        width: Optional width to resize
        height: Optional height to resize
        retry: Number of retry attempts
        return_source_dict: If True, returns only the source dict. If False, returns only the PIL.Image.
        
    Returns:
        PIL.Image if return_source_dict=False, or source dict if return_source_dict=True.
        Returns None if failed.
    """
    import io
    import base64
    from PIL import Image
    
    # If source_name is provided, use it directly
    if source_name:
        if return_source_dict:
            # Need to find the source dict for this source_name
            current_sources = get_active_video_sources()
            if current_sources:
                for src in current_sources:
                    if src.get('sourceName') == source_name:
                        return src
            return None
        img = get_screenshot_PIL_from_source(source_name, compression, img_format, width, height, retry)
        return img
    
    # Get all available video sources
    current_sources = get_active_video_sources()
    if not current_sources:
        logger.error("No active video sources found in the current scene.")
        return None
    
    # Priority: window_capture (0) > game_capture (1) > monitor_capture (2)
    priority_map = {'window_capture': 0, 'game_capture': 1, 'monitor_capture': 2}
    
    # Sort sources by priority
    sorted_sources = sorted(
        current_sources,
        key=lambda x: priority_map.get(x.get('inputKind'), 999)
    )
    
    if len(sorted_sources) == 1:
        only_source = sorted_sources[0]
        if return_source_dict:
            return only_source
        img = get_screenshot_PIL_from_source(only_source.get('sourceName'), compression, img_format, width, height, retry)
        return img
    
    # Try each source in priority order
    for source in sorted_sources:
        found_source_name = source.get('sourceName')
        if not found_source_name:
            continue
            
        img = get_screenshot_PIL_from_source(found_source_name, compression, img_format, width, height, retry)
        
        if img:
            # Validate that the image has actual content (not completely empty/black)
            try:
                extrema = img.getextrema()
                if isinstance(extrema[0], tuple):
                    is_empty = all(e[0] == e[1] for e in extrema)
                else:
                    is_empty = extrema[0] == extrema[1]
                
                if not is_empty:
                    return source if return_source_dict else img
            except Exception as e:
                logger.warning(f"Failed to validate image from source '{found_source_name}': {e}")
                # If validation fails, still return the image as it might be valid
                return source if return_source_dict else img
    
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
            client: obs.ReqClient
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
                
                if not True:
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

def get_current_source_input_settings():
    with connection_pool.get_client() as client:
        client: obs.ReqClient
        current_scene = get_current_scene()
        if not current_scene:
            return None
        scene_items_response = client.get_scene_item_list(name=current_scene)
        items = scene_items_response.scene_items if scene_items_response and scene_items_response.scene_items else []
        if not items:
            return None
        first_item = items[0]
        source_name = first_item.get('sourceName')
        if not source_name:
            return None
        input_settings_response = client.get_input_settings(name=source_name)
        return input_settings_response.input_settings if input_settings_response else None


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
    
def create_scene():
    with connection_pool.get_client() as client:
        client: obs.ReqClient
        # Extract fields from request_json
        request_json = r'{"sceneName":"SILENT HILL f","inputName":"SILENT HILL f - Capture","inputKind":"window_capture","inputSettings":{"mode":"window","window":"SILENT HILL f  :UnrealWindow:SHf-Win64-Shipping.exe","capture_audio":true,"cursor":false,"method":"2"}}'
        request_dict = json.loads(request_json)
        scene_name = request_dict.get('sceneName')
        input_name = request_dict.get('inputName')
        input_kind = request_dict.get('inputKind')
        input_settings = request_dict.get('inputSettings')
        input_settings['method'] = 2
        # Remove sceneName from request_dict if needed for create_input
        request_dict.pop('sceneName', None)
        response = client.create_input(inputName=input_name, inputKind=input_kind, sceneName=scene_name, inputSettings=input_settings, sceneItemEnabled=True)

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    connect_to_obs_sync()
    try:
        with connection_pool.get_client() as client:
            client: obs.ReqClient
            resp = client.get_scene_item_list(get_current_scene())
            print(resp.scene_items)
    except Exception as e:
        print(f"Error: {e}")
    
    # outputs = get_output_list()
    # print(outputs)
    
    # output = get_replay_buffer_output()
    # print(output)
    
    # save_replay_buffer()
    # img = get_screenshot_PIL(source_name='Display Capture 2', compression=100, img_format='jpg', width=2560, height=1440)
    # img.show()
    # source = get_current_source_input_settings()
    # print(source)
    
    # response = enable_replay_buffer()
    # print(response)
    
    # response = get_replay_buffer_max_time_seconds()
    # response is dataclass with attributes, print attributes
    # print(response)
    
    # response = enable_replay_buffer()
    # print(response)
    # # set_fit_to_screen_for_scene_items(get_current_scene())
    # create_scene()