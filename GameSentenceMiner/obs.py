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
import functools

import psutil

import obsws_python as obs
import numpy as np

from GameSentenceMiner.util import configuration
from GameSentenceMiner.util.configuration import get_app_directory, get_config, get_master_config, is_windows, save_full_config, reload_config, logger, gsm_status, gsm_state
from GameSentenceMiner.util.gsm_utils import add_srt_line, sanitize_filename, make_unique_file_name, make_unique_temp_file, wait_for_stable_file
from GameSentenceMiner.util.text_log import get_all_lines
# from GameSentenceMiner.discord_rpc import discord_rpc_manager


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
        self._client_locks = [threading.Lock() for _ in range(self.size)]
        self._last_connect_attempt = [0.0] * self.size  # Cooldown tracking
        self.min_reconnect_interval = 2.0  # Seconds to wait before retrying a specific slot
        
        self._next_idx = 0
        self._idx_lock = threading.Lock()
        
        self.connected_once = False
        self.last_error_shown = [None] * self.size
        logger.info(f"Initialized OBSConnectionPool with size {self.size}")

    def connect_all(self):
        """Initializes all client objects in the pool."""
        time.sleep(2)  # Initial delay to allow OBS to start
        for i in range(self.size):
            self._attempt_connect(i, initial=True)
        return True

    def _attempt_connect(self, index, initial=False):
        """Internal helper to connect a specific slot with cooldown handling."""
        now = time.time()
        # Prevent spamming connection attempts on a dead socket
        if not initial and (now - self._last_connect_attempt[index] < self.min_reconnect_interval):
            return False

        self._last_connect_attempt[index] = now
        
        try:
            # Close existing if present
            if self._clients[index]:
                try:
                    self._clients[index].disconnect()
                except Exception:
                    pass
            
            self._clients[index] = obs.ReqClient(**self.connection_kwargs)
            
            # Simple health check only on creation
            self._clients[index].get_version() 
            
            self.connected_once = True
            self.last_error_shown[index] = None # Reset error on success
            return True
        except Exception as e:
            self._clients[index] = None # Ensure it is None if failed
            err_str = str(e)
            if err_str != self.last_error_shown[index]:
                if self.connected_once:
                     # Only log if it's a new error or we thought we were connected
                    logger.error(f"Failed to create client {index} in pool: {e}")
                self.last_error_shown[index] = err_str
            time.sleep(0.5) # Small delay to avoid rapid retries
            return False

    def disconnect_all(self):
        """Disconnects all clients in the pool."""
        for i, client in enumerate(self._clients):
            if client:
                try:
                    client.disconnect()
                except Exception:
                    pass # Swallow disconnect errors to prevent lag
            self._clients[i] = None
        logger.info("Disconnected all clients in OBSConnectionPool.")

    @contextlib.contextmanager
    def get_client(self) -> obs.ReqClient:
        """A context manager to safely get a client from the pool."""
        # Round-robin selection
        with self._idx_lock:
            idx = self._next_idx
            self._next_idx = (self._next_idx + 1) % self.size

        lock = self._client_locks[idx]
        acquired = lock.acquire(timeout=5) # Prevent infinite deadlock
        
        if not acquired:
            # Fallback if specific slot is locked too long
            raise TimeoutError("Could not acquire OBS client lock.")

        try:
            # Lazy Reconnection:
            # If client is None, try to connect. 
            # We REMOVED the 'get_version()' check here. It causes massive lag.
            # If the client is stale, it will throw an error during use, which is safer
            # than pinging the network 60 times a second.
            if self._clients[idx] is None:
                self._attempt_connect(idx)
            
            # If still None (connection failed), we must raise or yield None.
            # Assuming user code expects a client object, we yield. 
            # If it's None, user code will crash, so we check valid.
            if self._clients[idx] is None:
                 raise ConnectionError("OBS Client unavailable")

            yield self._clients[idx]

        except Exception as e:
            # If an error happens *during* usage, mark client as dead for next time
            logger.debug(f"Error during OBS client usage (Slot {idx}): {e}")
            self._clients[idx] = None
            raise e
        finally:
            lock.release()

    def get_healthcheck_client(self):
        """Returns a dedicated client for health checks, separate from the main pool."""
        # Add rate limiting to healthcheck creation too
        if not hasattr(self, '_healthcheck_client') or self._healthcheck_client is None:
            try:
                self._healthcheck_client = obs.ReqClient(**self.connection_kwargs)
            except Exception as e:
                # Don't log spam here, the manager handles logging
                self._healthcheck_client = None
        return self._healthcheck_client

def with_obs_client(default=None, error_msg=None, raise_exc=False):
    """
    Decorator to automatically acquire an OBS client from the pool and pass it 
    as the first argument to the decorated function.
    """
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            if not connection_pool:
                # Most functions implicitly fail if pool is None
                return default
            try:
                with connection_pool.get_client() as client:
                    return func(client, *args, **kwargs)
            except Exception as e:
                if raise_exc:
                    raise e
                
                # Check if we should log a specific error message or a generic one
                msg = error_msg if error_msg else f"Error in {func.__name__}"
                
                # Handle specific logging levels if needed, default to error
                # For get_replay_buffer_status, existing code used debug
                if func.__name__ == 'get_replay_buffer_status' or func.__name__ == 'get_current_scene':
                     logger.debug(f"{msg}: {e}")
                else:
                     logger.error(f"{msg}: {e}")
                
                return default
        return wrapper
    return decorator


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
        self.replay_buffer_name = "Replay Buffer"
        # Add a lock to prevent concurrent checks
        self._check_lock = threading.Lock()

    def _check_obs_connection(self):
        if connecting: 
            return False # Don't check if we are currently establishing connection

        try:
            # Use healthcheck client
            client = connection_pool.get_healthcheck_client() if connection_pool else None
            
            if client:
                # This is a blocking call, but on a separate thread, so it's okay.
                client.get_version()
                gsm_status.obs_connected = True
                return True
            else:
                raise ConnectionError("Healthcheck client creation failed")
                
        except Exception as e:
            # Only log detailed info if we were previously connected
            if gsm_status.obs_connected:
                logger.info(f"OBS WebSocket connection lost: {e}")
            
            gsm_status.obs_connected = False
            
            # FIX: Do NOT use asyncio.run here inside a thread. 
            # Use the synchronous connect function or trigger it safely.
            if not connecting:
                # We spin up a thread or call sync to avoid blocking the loop forever
                threading.Thread(target=connect_to_obs_sync, kwargs={'retry': 1}, daemon=True).start()
            
            return False
        
    def check_replay_buffer_enabled(self):
        if not self.should_check_output:
            return 300, ""
        buffer_seconds = get_replay_buffer_max_time_seconds(name=self.replay_buffer_name)
        if not buffer_seconds:
            replay_output = get_replay_buffer_output()
            if not replay_output:
                return 0, "Replay Buffer output not found in OBS. Please enable Replay Buffer In OBS Settings -> Output -> Replay Buffer. I recommend 300 seconds (5 minutes) or higher."
            self.replay_buffer_name = replay_output["outputName"] if replay_output else "Replay Buffer"
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

        self.NO_OUTPUT_SHUTDOWN_SECONDS = min(max(300, buffer_seconds * 1.10), 1800) 

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
            # Low priority warning
            return False

    def run(self):
        from GameSentenceMiner.util.sleep_manager import SleepManager
        disconnect_sleep_manager = SleepManager(initial_delay=2.0, name="OBS_Disconnect")
        time.sleep(5)  # Initial delay to allow OBS to start
        replay_output = get_replay_buffer_output()
        self.replay_buffer_name = replay_output["outputName"] if replay_output else "Replay Buffer"
        while self.running:
            # If disconnected, check more frequently (every 2s), else every 5s
            # sleep_time = 2 if not gsm_status.obs_connected else self.check_connection_interval
            # time.sleep(sleep_time)
            
            if not gsm_status.obs_connected:
                disconnect_sleep_manager.sleep()
            else:
                disconnect_sleep_manager.reset()
                time.sleep(self.check_connection_interval)

            if not self._check_obs_connection():
                continue

            if self.counter % 2 == 0:
                with self._check_lock: # Prevent overlapping checks
                    try:
                        errors = self._manage_replay_buffer_and_utils()
                        if errors != self.last_errors:
                            if errors:
                                for error in errors:
                                    logger.error(f"OBS Health Check: {error}")
                        self.last_errors = errors
                    except Exception as e:
                        logger.error(f"Error when running Extra Utils in OBS Health Check: {e}")
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
            try:
                os.remove(OBS_PID_FILE)
            except OSError:
                pass
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
                logger.debug(f"Deleted sentinel folder: {sentinel_folder}")
            except Exception as e:
                logger.error(f"Failed to delete sentinel folder: {e}")
        
        obs_process = subprocess.Popen([obs_path, '--disable-shutdown-check', '--portable', '--startreplaybuffer', ], cwd=os.path.dirname(obs_path))
        obs_process_pid = obs_process.pid
        with open(OBS_PID_FILE, "w") as f:
            f.write(str(obs_process_pid))
        logger.success("OBS launched successfully!")
        return obs_process_pid
    except Exception as e:
        logger.error(f"Error launching OBS: {e}")
        return None

async def wait_for_obs_connected():
    if not connection_pool:
        return False
    # Use healthcheck to avoid checking out clients from the main pool
    for _ in range(10):
        try:
            client = connection_pool.get_healthcheck_client()
            if client:
                response = client.get_version()
                if response:
                    return True
        except Exception as e:
            logger.debug(f"Waiting for OBS connection: {e}")
            await asyncio.sleep(1)
    return False

async def check_obs_folder_is_correct():
    if await wait_for_obs_connected():
        try:
            obs_record_directory = get_record_directory()
            if obs_record_directory and os.path.normpath(obs_record_directory) != os.path.normpath(
                    get_config().paths.folder_to_watch):
                logger.info("OBS Path wrong, Setting OBS Recording folder in GSM Config...")
                get_config().paths.folder_to_watch = os.path.normpath(obs_record_directory)
                get_master_config().sync_shared_fields()
                save_full_config(get_master_config())
            else:
                logger.debug("OBS Recording path looks correct")
        except Exception as e:
            logger.error(f"Error checking OBS folder: {e}")


def get_obs_websocket_config_values():
    try:
        config_path = os.path.join(get_app_directory(), 'obs-studio', 'config', 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json')

        if not os.path.isfile(config_path):
            # Not a critical error, just return
            return

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
    except Exception as e:
        logger.error(f"Failed to check OBS WebSocket config: {e}")

async def connect_to_obs(retry=5, connections=2, check_output=False):
    # Delegate to sync version to avoid duplication, wrapping in thread if needed
    # but since this is async, we can just run the logic here
    global connection_pool, obs_connection_manager, event_client, connecting
    if connection_pool:
        return
    
    if is_windows():
        get_obs_websocket_config_values()

    connecting = True
    while retry > 0:
        try:
            pool_kwargs = {
                'host': get_config().obs.host,
                'port': get_config().obs.port,
                'password': get_config().obs.password,
                'timeout': 3,
            }
            # Create pool
            new_pool = OBSConnectionPool(size=connections, **pool_kwargs)
            if new_pool.connect_all():
                connection_pool = new_pool
            else:
                # If connect_all failed completely
                pass

            # Just verify one connection
            with connection_pool.get_client() as client:
                client.get_version() 

            event_client = obs.EventClient(
                host=get_config().obs.host,
                port=get_config().obs.port,
                password=get_config().obs.password,
                timeout=1,
            )
            gsm_status.obs_connected = True
            logger.success("Connected to OBS WebSocket.")
            
            if not obs_connection_manager:
                obs_connection_manager = OBSConnectionManager(check_output=check_output)
                obs_connection_manager.start()
            
            # Use safe wrapper if exists
            try:
                update_current_game()
            except: pass
            
            if get_config().features.generate_longplay and check_output:
                try:
                    start_recording(True)
                except: pass
                
            break
        except Exception as e:
            retry -= 1
            if retry <= 0:
                gsm_status.obs_connected = False
                logger.error(f"Failed to connect to OBS WebSocket after retries: {e}")
                connection_pool = None
                event_client = None
                break
            await asyncio.sleep(1)
            
    connecting = False

def connect_to_obs_sync(retry=2, connections=2, check_output=False):
    global connection_pool, obs_connection_manager, event_client, connecting
    
    # Critical check: if we are already connected or connecting, exit
    if connection_pool or connecting:
        return

    if is_windows():
        get_obs_websocket_config_values()
    
    connecting = True
    try:
        while retry > 0:
            try:
                pool_kwargs = {
                    'host': get_config().obs.host,
                    'port': get_config().obs.port,
                    'password': get_config().obs.password,
                    'timeout': 3,
                }
                new_pool = OBSConnectionPool(size=connections, **pool_kwargs)
                new_pool.connect_all()
                
                # Assign global pool only after success
                connection_pool = new_pool

                with connection_pool.get_client() as client:
                    client.get_version() 

                event_client = obs.EventClient(
                    host=get_config().obs.host,
                    port=get_config().obs.port,
                    password=get_config().obs.password,
                    timeout=1,
                )
                gsm_status.obs_connected = True
                logger.success("Connected to OBS WebSocket.")
                if not obs_connection_manager:
                    obs_connection_manager = OBSConnectionManager(check_output=check_output)
                    obs_connection_manager.start()
                
                try:
                    update_current_game()
                except: pass
                
                if get_config().features.generate_longplay and check_output:
                    try:
                        start_recording(True)
                    except: pass
                    
                break
            except Exception as e:
                retry -= 1
                if retry <= 0:
                    gsm_status.obs_connected = False
                    logger.error(f"Failed to connect to OBS WebSocket: {e}")
                    connection_pool = None
                    event_client = None
                    break
                time.sleep(1)
    finally:
        connecting = False


def disconnect_from_obs():
    global connection_pool, event_client
    if connection_pool:
        connection_pool.disconnect_all()
        connection_pool = None
    
    if event_client:
        try:
            event_client.disconnect()
        except: pass
        event_client = None
        
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

@with_obs_client(error_msg="Error toggling buffer")
def toggle_replay_buffer(client):
    client: obs.ReqClient
    client.toggle_replay_buffer()
    logger.info("Replay buffer Toggled.")

@with_obs_client(error_msg="Error starting replay buffer")
def start_replay_buffer(client):
    client: obs.ReqClient
    client.start_replay_buffer()
    if get_config().features.generate_longplay:
        start_recording(True)
    logger.info("Replay buffer started.")

@with_obs_client(default=None, error_msg="Error getting replay buffer status")
def get_replay_buffer_status(client):
    return client.get_replay_buffer_status().output_active

@with_obs_client(error_msg="Error stopping replay buffer")
def stop_replay_buffer(client):
    client: obs.ReqClient
    client.stop_replay_buffer()
    # discord_rpc_manager.stop()
    if get_config().features.generate_longplay:
        finalize_longplay_recording()
    logger.info("Replay buffer stopped.")

@with_obs_client(error_msg="Error saving replay buffer", raise_exc=True)
def save_replay_buffer(client):
    client: obs.ReqClient
    client.save_replay_buffer()
    logger.info("Replay buffer saved. If your log stops here, make sure your obs output path matches \"Path To Watch\" in GSM settings.")

@with_obs_client(error_msg="Error starting recording")
def start_recording(client, longplay=False):
    client: obs.ReqClient
    if longplay:
        gsm_state.recording_started_time = datetime.datetime.now()
        gsm_state.current_srt = make_unique_temp_file(f"{get_current_game(sanitize=True)}.srt")
        gsm_state.srt_index = 1
    client.start_record()
    logger.info("Recording started.")
    
@with_obs_client(error_msg="Error stopping recording")
def stop_recording(client):
    client: obs.ReqClient
    resp = client.stop_record()
    logger.info("Recording stopped.")
    return resp.output_path if resp else None
        
def finalize_longplay_recording():
    longplay_path = stop_recording()
    if gsm_state.current_srt and len(get_all_lines()) > 0:
        add_srt_line(datetime.datetime.now(), get_all_lines()[-1])
        # move srt to output folder with same name as video
        video_name = os.path.splitext(os.path.basename(longplay_path))[0]
        srt_ext = os.path.splitext(gsm_state.current_srt)[1]
        final_srt_path = os.path.join(get_config().paths.folder_to_watch, f"{video_name}{srt_ext}")
        shutil.move(gsm_state.current_srt, final_srt_path)
        
@with_obs_client(default='', error_msg="Error getting last recording filename")
def get_last_recording_filename(client):
    client: obs.ReqClient
    response = client.get_record_status()
    return response.recording_filename if response else ''

@with_obs_client(default='', error_msg="Couldn't get scene")
def get_current_scene(client):
    client: obs.ReqClient
    response = client.get_current_program_scene()
    return response.scene_name if response else ''

@with_obs_client(default='', error_msg="Error getting source from scene")
def get_source_from_scene(client, scene_name):
    client: obs.ReqClient
    response = client.get_scene_item_list(name=scene_name)
    return response.scene_items[0] if response and response.scene_items else ''

def get_active_source():
    current_game = get_current_game()
    if not current_game:
        return None
    return get_source_from_scene(current_game)

@with_obs_client(default=None, error_msg="Error getting scene items for active video source")
def get_active_video_sources(client):
    # We update current game locally or assume it's set
    # Note: get_current_game() calls get_current_scene() which uses a client.
    # To avoid nested locking issues if we called get_current_game inside the lock,
    # we should ideally call it outside. However, this function signature doesn't allow arguments easily.
    # BUT, get_active_video_sources calls get_current_game(). get_current_game() is NOT decorated with @with_obs_client
    # because it calls update_current_game() which calls get_current_scene().
    # Let's check get_current_game.
    
    # Actually, get_active_video_sources calls `get_current_game()`. 
    # `get_current_game` calls `update_current_game`.
    # `update_current_game` calls `get_current_scene`.
    # `get_current_scene` IS decorated.
    # If `get_active_video_sources` IS decorated, we have a nested lock:
    # get_active_video_sources(Lock 1) -> get_current_game -> get_current_scene(Lock 2).
    # This works if pool size >= 2.
    
    current_game = get_current_game()
    if not current_game:
        return None
    
    # We already have a client from the decorator, so we use it for the specific call
    scene_items_response = []
    response = client.get_scene_item_list(name=current_game)
    scene_items_response = response.scene_items if response else []

    if not scene_items_response:
        return None
    video_sources = ['window_capture', 'game_capture', 'monitor_capture']
    active_video_sources = [item for item in scene_items_response if item.get('inputKind') in video_sources]
    # active_video_sources = []
    
    return active_video_sources if active_video_sources else [scene_items_response[0]]

@with_obs_client(default='', error_msg="Error getting recording folder")
def get_record_directory(client):
    client: obs.ReqClient
    response = client.get_record_directory()
    return response.record_directory if response else ''
    
@with_obs_client(default=0, error_msg="Exception while fetching replay buffer settings")
def get_replay_buffer_max_time_seconds(client, name='Replay Buffer'):
    """
    Gets the configured maximum replay buffer time in seconds using the v5 protocol.
    """
    # For v5, we get settings for the 'replay_buffer' output
    response = client.get_output_settings(name=name)
    
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
    
@with_obs_client(default=False, error_msg="Error enabling replay buffer")
def enable_replay_buffer(client):
    client: obs.ReqClient
    response = client.set_output_settings(name='Replay Buffer', settings={'outputFlags': {'OBS_OUTPUT_AUDIO': True, 'OBS_OUTPUT_ENCODED': True, 'OBS_OUTPUT_MULTI_TRACK': True, 'OBS_OUTPUT_SERVICE': False, 'OBS_OUTPUT_VIDEO': True}})
    if response and response.ok:
        logger.info("Replay buffer enabled.")
        return True
    else:
        logger.error(f"Failed to enable replay buffer: {response.status if response else 'No response'}")
        return False
    
@with_obs_client(default=None, error_msg="Error getting output list")
def get_output_list(client):
    client: obs.ReqClient
    response = client.get_output_list()
    return response.outputs if response else None
    
def get_replay_buffer_output():
    outputs = get_output_list()
    if not outputs:
        return None
    for output in outputs:
        if output.get('outputKind') == 'replay_buffer':
            return output
    return None

@with_obs_client(default=None, error_msg="Error getting scenes")
def get_obs_scenes(client):
    # Note: The original code had a rate limiter on the error log.
    # The decorator handles generic error logging. 
    # If strictly needed, we could suppress the error in the decorator or handle it here, 
    # but for simplicity and cleaner code, we allow the decorator to handle the exception.
    # If the client is None (pool not initialized), decorator returns Default (None).
    if client is None:
        logger.error("OBS client is None. Skipping get_scene_list.")
        return None
    response = client.get_scene_list()
    return response.scenes if response else None

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


@with_obs_client(default=None, error_msg="Error getting screenshot")
def get_screenshot(client, compression=-1):
    # Update game first - this might take a second lock if update_current_game calls get_current_scene
    screenshot = os.path.join(configuration.get_temporary_directory(), make_unique_file_name('screenshot.png'))
    update_current_game()
    if not configuration.current_game:
        logger.error("No active game scene found.")
        return None
    
    # We can't reuse the client easily for helpers that aren't designed for it, 
    # so we rely on the helpers finding what they need (possibly reusing the pool via nested locks).
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

@with_obs_client(default=None, error_msg="Error getting screenshot")
def get_screenshot_base64(client, compression=75, width=None, height=None):
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

    response = client.get_source_screenshot(name=current_source_name, img_format='png', quality=compression, width=width, height=height)

    if response and response.image_data:
        return response.image_data.split(',', 1)[-1]  # Remove data:image/png;base64, prefix if present
    else:
        logger.error(f"Error getting base64 screenshot: {response}")
        return None
    

def get_screenshot_PIL_from_source(source_name, compression=75, img_format='png', width=None, height=None, retry=3):
    """
    Get a PIL Image screenshot from a specific OBS source.
    """
    import io
    import base64
    from PIL import Image
    
    if not source_name:
        logger.error("No source name provided.")
        return None
        
    for attempt in range(retry):
        # We manually wrap this because of the retry loop logic which is cleaner inside the function
        # than trying to decorate the loop or the whole function and retrying the whole decorated stack.
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
            pass # Silent fail on retry
    
    return None


def get_best_source_for_screenshot():
    """
    Get the best available video source dict based on priority and image validation.
    
    Priority order: window_capture > game_capture > monitor_capture
    
    Returns:
        The source dict of the best available source, or None if no valid source found.
    """
    return get_screenshot_PIL(return_source_dict=True)


def get_screenshot_PIL(
    source_name=None,
    compression=75,
    img_format='jpg',
    width=None,
    height=None,
    retry=3,
    return_source_dict=False,
    grayscale=False,
):
    """
    Get a PIL Image screenshot.
    Optionally converts to grayscale immediately to reduce compute and improve OCR stability.
    """
    from PIL import Image

    # If source_name is provided, use it directly
    if source_name:
        if return_source_dict:
            current_sources = get_active_video_sources()
            if current_sources:
                for src in current_sources:
                    if src.get('sourceName') == source_name:
                        return src
            return None

        img = get_screenshot_PIL_from_source(
            source_name, compression, img_format, width, height, retry
        )
        if img and grayscale and img.mode != "L":
            img = img.convert("L")
        return img

    # Get all available video sources
    current_sources = get_active_video_sources()
    if not current_sources:
        logger.error("No active video sources found in the current scene.")
        return None

    # Priority: window_capture (0) > game_capture (1) > monitor_capture (2)
    priority_map = {
        'window_capture': 0,
        'game_capture': 1,
        'monitor_capture': 2
    }

    sorted_sources = sorted(
        current_sources,
        key=lambda x: priority_map.get(x.get('inputKind'), 999)
    )

    if len(sorted_sources) == 1:
        only_source = sorted_sources[0]
        if return_source_dict:
            return only_source

        img = get_screenshot_PIL_from_source(
            only_source.get('sourceName'),
            compression,
            img_format,
            width,
            height,
            retry
        )
        if img and grayscale and img.mode != "L":
            img = img.convert("L")
        return img

    # Try each source in priority order
    for source in sorted_sources:
        found_source_name = source.get('sourceName')
        if not found_source_name:
            continue

        img = get_screenshot_PIL_from_source(
            found_source_name,
            compression,
            img_format,
            width,
            height,
            retry
        )

        if not img:
            continue

        # 🔥 Convert to grayscale immediately
        if grayscale and img.mode != "L":
            img = img.convert("L")

        # Validate that the image has actual content (not empty/solid)
        try:
            # Grayscale extrema is a single (min, max) tuple
            lo, hi = img.getextrema()
            if lo != hi:
                return source if return_source_dict else img
        except Exception as e:
            logger.warning(
                f"Failed to validate image from source '{found_source_name}': {e}"
            )
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


@with_obs_client(default=None, error_msg="An OBS error occurred")
def set_fit_to_screen_for_scene_items(client, scene_name: str):
    """
    Sets all sources in a given scene to "Fit to Screen" (like Ctrl+F in OBS).
    """
    if not scene_name:
        return
        
    try:
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


@with_obs_client(default=None, error_msg="Error getting current source input settings")
def get_current_source_input_settings(client):
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


@with_obs_client(default=None, error_msg="Error getting window info from source")
def get_window_info_from_source(client, scene_name: str = None):
    """
    Get window information from an OBS scene's capture source.
    """
    # Get scene items
    if scene_name:
        scene_items_response = client.get_scene_item_list(name=scene_name)
    else:
        logger.error("Either obs_scene_id or scene_name must be provided")
        return None
    
    if not scene_items_response or not scene_items_response.scene_items:
        logger.warning(f"No scene items found in scene")
        return None
    
    # Find the first input source with a window property
    for item in scene_items_response.scene_items:
        source_name = item.get('sourceName')
        if not source_name:
            continue
        
        try:
            input_settings_response = client.get_input_settings(name=source_name)
            if input_settings_response and input_settings_response.input_settings:
                window_value = input_settings_response.input_settings.get('window')
                
                if window_value:
                    parts = window_value.split(':')
                    
                    if len(parts) >= 3:
                        return {
                            'title': parts[0].strip(),
                            'window_class': parts[1].strip(),
                            'exe': parts[2].strip()
                        }
        except Exception as e:
            logger.debug(f"Error getting input settings for source {source_name}: {e}")
            continue
    
    return None


@with_obs_client(default=None, error_msg="Error calling GetInputAudioTracks")
def get_input_audio_tracks(client, input_name: str = None, input_uuid: str = None):
    """Retrieve the enable state of all audio tracks for a given input."""
    try:
        kwargs = {}
        if input_name:
            kwargs['inputName'] = input_name
        if input_uuid:
            kwargs['inputUuid'] = input_uuid
        # Fixed: Original code hardcoded name, I assume it should use kwargs
        response = client.get_input_audio_tracks(**kwargs)
        return response.input_audio_tracks if response else None
    except AttributeError:
        logger.error("OBS client does not support 'get_input_audio_tracks' (older websocket/version).")
        return None

@with_obs_client(default=False, error_msg="Error calling SetInputAudioTracks")
def set_input_audio_tracks(client, input_name: str = None, input_uuid: str = None, input_audio_tracks: dict = None):
    """Set the enable state of audio tracks for a given input."""
    if input_audio_tracks is None:
        logger.error("No `input_audio_tracks` provided to set_input_audio_tracks.")
        return False
    try:
        kwargs = {'inputAudioTracks': input_audio_tracks}
        if input_name:
            kwargs['inputName'] = input_name
        if input_uuid:
            kwargs['inputUuid'] = input_uuid
        response = client.set_input_audio_tracks(**kwargs)
        if response and getattr(response, 'ok', False):
            return True
        return False
    except AttributeError:
        logger.error("OBS client does not support 'set_input_audio_tracks' (older websocket/version).")
        return False

@with_obs_client(default=False, error_msg="Error disabling desktop audio")
def disable_desktop_audio(client):
    """Disable all audio tracks for the desktop audio input."""
    candidate_names = ['Desktop Audio', 'Desktop Audio 2', 'Desktop Audio Device', 'Desktop']

    try:
        inputs_resp = client.get_input_list()
        inputs = inputs_resp.inputs if inputs_resp else []
    except Exception:
        inputs = []

    desktop_input = None
    for inp in inputs:
        name = inp.get('inputName') or inp.get('name')
        kind = inp.get('inputKind') or inp.get('kind')
        if name in candidate_names or (isinstance(kind, str) and 'audio' in kind.lower()) or (name and 'desktop' in name.lower()):
            desktop_input = inp
            break

    if not desktop_input:
        for inp in inputs:
            kind = inp.get('inputKind') or inp.get('kind')
            if kind in ('monitor_capture', 'wasapi_output_capture', 'pulse_audio_output_capture') or (kind and 'audio' in kind.lower()):
                desktop_input = inp
                break

    if not desktop_input:
        logger.error('Desktop audio input not found in OBS inputs.')
        return False

    input_name = desktop_input.get('inputName') or desktop_input.get('name')
    input_uuid = desktop_input.get('inputId') or desktop_input.get('id')

    current_tracks = get_input_audio_tracks(input_name=input_name, input_uuid=input_uuid)
    if not current_tracks:
        tracks_payload = {str(i): False for i in range(1, 7)}
    else:
        tracks_payload = {k: False for k in current_tracks.keys()}

    success = set_input_audio_tracks(input_name=input_name, input_uuid=input_uuid, input_audio_tracks=tracks_payload)
    if success:
        logger.info(f"Disabled desktop audio for input '{input_name}'")
        return True
    else:
        logger.error('Failed to disable desktop audio via SetInputAudioTracks')
        return False


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
    
@with_obs_client()
def create_scene(client):
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
        
def pretty_print_response(resp):
    print(json.dumps(resp, indent=4))

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    connect_to_obs_sync()
    # try:
    #     # with connection_pool.get_client() as client:
    #     #    pass
    #     resp = get_window_info_from_source(scene_name=get_current_scene())
    #         # resp = client.get_scene_item_list(get_current_scene())
    #         # print(resp.scene_items)
    # except Exception as e:
    #     print(f"Error: {e}")
    
    outputs = get_output_list()
    print(outputs)
    
    output = get_replay_buffer_output()
    print(output)
    
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