import json
import os
import secrets
import shutil
import urllib.request
import platform
import zipfile

from GameSentenceMiner.util.downloader.Untitled_json import scenes
from GameSentenceMiner.util.configuration import get_app_directory, get_config, get_ffmpeg_path, logger
from GameSentenceMiner.util.configuration import get_ffprobe_path
from GameSentenceMiner.obs import get_obs_path
from GameSentenceMiner.util.downloader.oneocr_dl import Downloader
import tempfile

script_dir = os.path.dirname(os.path.abspath(__file__))

def cleanup_temp_files(func):
    def wrapper(*args, **kwargs):
        temp_files = []

        # Patch tempfile.NamedTemporaryFile to track created temp files
        orig_named_tempfile = tempfile.NamedTemporaryFile
        def tracked_named_tempfile(*a, **kw):
            tmp = orig_named_tempfile(*a, **kw)
            temp_files.append(tmp.name)
            return tmp
        tempfile.NamedTemporaryFile = tracked_named_tempfile

        try:
            result = func(*args, **kwargs)
        finally:
            # Restore original NamedTemporaryFile
            tempfile.NamedTemporaryFile = orig_named_tempfile
            # Remove tracked temp files
            for f in temp_files:
                try:
                    if os.path.exists(f):
                        os.remove(f)
                except Exception:
                    pass
        return result
    return wrapper

def copy_obs_settings(src, dest):

    if os.path.exists(src):
        user_input = input(f"Existng OBS install located. Do you want to copy OBS settings from {src} to {dest}? (y/n): ").strip().lower() or "y"
        if user_input in ['y', 'yes', '1']:
            logger.info(f"Copying OBS settings from {src} to {dest}...")
            shutil.copytree(src, dest, dirs_exist_ok=True)
            logger.info("OBS settings copied successfully.")
            return True
        else:
            logger.info("Not copying settings!")
            return False
    logger.warning(f"OBS settings directory {src} does not exist. Skipping copy.")
    return False


def download_obs_if_needed():
    obs_path = os.path.join(get_app_directory(), 'obs-studio')
    obs_exe_path = get_obs_path()
    if os.path.exists(obs_path) and os.path.exists(obs_exe_path):
        logger.debug(f"OBS already installed at {obs_path}.")
        return

    if os.path.exists(obs_path) and not os.path.exists(obs_exe_path):
        logger.info("OBS directory exists but executable is missing. Re-downloading OBS...")
        shutil.rmtree(obs_path)

    def get_windows_obs_url():
        machine = platform.machine().lower()
        if machine in ['arm64', 'aarch64']:
            logger.info("Detected Windows on ARM64. Getting ARM64 version of OBS Studio.")
            return next(asset['browser_download_url'] for asset in latest_release['assets'] if
                        asset['name'].endswith('Windows-arm64.zip'))
        return next(asset['browser_download_url'] for asset in latest_release['assets'] if 
                    asset['name'].endswith('Windows-x64.zip'))

    latest_release_url = "https://api.github.com/repos/obsproject/obs-studio/releases/latest"
    with urllib.request.urlopen(latest_release_url) as response:
        latest_release = json.load(response)
        obs_url = {
            "Windows": get_windows_obs_url,
            # "Linux": lambda: next(asset['browser_download_url'] for asset in latest_release['assets'] if
            #                       asset['name'].endswith('Ubuntu-24.04-x86_64.deb')),
            # "Darwin": lambda: next(asset['browser_download_url'] for asset in latest_release['assets'] if
            #                        asset['name'].endswith('macOS-Intel.dmg'))
        }.get(platform.system(), lambda: None)()

    if obs_url is None:
        logger.error("Unsupported OS. Please install OBS manually.")
        return

    download_dir = os.path.join(get_app_directory(), "downloads")
    os.makedirs(download_dir, exist_ok=True)
    obs_installer = os.path.join(download_dir, "OBS.zip")

    logger.info(f"Downloading OBS from {obs_url}...")
    urllib.request.urlretrieve(obs_url, obs_installer)

    os.makedirs(obs_path, exist_ok=True)

    if platform.system() == "Windows":


        logger.info(f"OBS downloaded. Extracting to {obs_path}...")
        with zipfile.ZipFile(obs_installer, 'r') as zip_ref:
            zip_ref.extractall(obs_path)
        open(os.path.join(obs_path, "portable_mode"), 'a').close()
        # websocket_config_path = os.path.join(obs_path, 'config', 'obs-studio')
        # if not copy_obs_settings(os.path.join(os.getenv('APPDATA'), 'obs-studio'), websocket_config_path):
        write_obs_configs(obs_path)
        logger.info(f"OBS extracted to {obs_path}.")
        
        # remove zip
        os.unlink(obs_installer)
    else:
        logger.error(f"Please install OBS manually from {obs_installer}")
        
def write_websocket_configs(obs_path):
    websocket_config_path = os.path.join(obs_path, 'config', 'obs-studio', 'plugin_config', 'obs-websocket')
    os.makedirs(websocket_config_path, exist_ok=True)
    obs_config = get_config().obs
    
    if os.path.exists(os.path.join(websocket_config_path, 'config.json')):
        with open(os.path.join(websocket_config_path, 'config.json'), 'r') as existing_config_file:
            existing_config = json.load(existing_config_file)
            if obs_config.port != existing_config.get('server_port', 7274):
                logger.info(f"OBS WebSocket port changed from {existing_config.get('server_port', 7274)} to {obs_config.port}. Updating config.")
                existing_config['server_port'] = obs_config.port
                existing_config['server_password'] = obs_config.password
                existing_config['auth_required'] = False
                existing_config['server_enabled'] = True
                with open(os.path.join(websocket_config_path, 'config.json'), 'w') as config_file:
                    json.dump(existing_config, config_file, indent=4)
    else:
        websocket_config = {
            "alerts_enabled": False,
            "auth_required": False,
            "first_load": False,
            "server_enabled": True,
            "server_password": secrets.token_urlsafe(16),
            "server_port": obs_config.port
        }
        with open(os.path.join(websocket_config_path, 'config.json'), 'w') as config_file:
            json.dump(websocket_config, config_file, indent=4)
            
def write_replay_buffer_configs(obs_path):
    basic_ini_path = os.path.join(obs_path, 'config', 'obs-studio', 'basic', 'profiles', 'GSM')
    if os.path.exists(os.path.join(basic_ini_path, 'basic.ini')):
        return
    os.makedirs(basic_ini_path, exist_ok=True)
    with open(os.path.join(basic_ini_path, 'basic.ini'), 'w') as basic_ini_file:
        basic_ini_file.write(
            "[SimpleOutput]\n"
            f"FilePath={os.path.expanduser('~')}/Videos/GSM\n"
            "RecRB=true\n"
            "RecRBTime=300\n"
            "RecRBSize=512\n"
            "RecAudioEncoder=opus\n"
            "RecRBPrefix=GSM\n"
        )

def write_obs_configs(obs_path):
    write_websocket_configs(obs_path)
    write_replay_buffer_configs(obs_path)

def download_ffmpeg_if_needed():
    ffmpeg_dir = os.path.join(get_app_directory(), 'ffmpeg')
    ffmpeg_exe_path = get_ffmpeg_path()
    ffprobe_exe_path = get_ffprobe_path()
    # python_dir = os.path.join(get_app_directory(), 'python')
    # ffmpeg_in_python = os.path.join(python_dir, "ffmpeg.exe")
    
    if os.path.exists(ffmpeg_dir) and os.path.exists(ffmpeg_exe_path) and os.path.exists(ffprobe_exe_path):
        logger.debug(f"FFmpeg already installed at {ffmpeg_dir}.")
        # if not os.path.exists(ffmpeg_in_python):
        #     shutil.copy2(ffmpeg_exe_path, ffmpeg_in_python)
        #     logger.info(f"Copied ffmpeg.exe to Python folder: {ffmpeg_in_python}")
        return

    if os.path.exists(ffmpeg_dir) and (not os.path.exists(ffmpeg_exe_path) or not os.path.exists(ffprobe_exe_path)):
        logger.info("FFmpeg directory exists but executables are missing. Re-downloading FFmpeg...")
        shutil.rmtree(ffmpeg_dir)

    system = platform.system()
    ffmpeg_url = None
    compressed_format = "zip"
    if system == "Windows":
        machine = platform.machine().lower()
        if machine in ['arm64', 'aarch64']:
            ffmpeg_url = "https://gsm.beangate.us/ffmpeg-8.0-essentials-shared-win-arm64.zip"
            compressed_format = "zip"
        else:
            ffmpeg_url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
            compressed_format = "zip"
    # elif system == "Linux":
    #     ffmpeg_url = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
    # elif system == "Darwin":
    #     ffmpeg_url = "https://evermeet.cx/ffmpeg/ffmpeg.zip"

    if ffmpeg_url is None:
        logger.error("Unsupported OS/architecture. Please install FFmpeg manually.")
        return

    download_dir = os.path.join(get_app_directory(), "downloads")
    os.makedirs(download_dir, exist_ok=True)
    ffmpeg_archive = os.path.join(download_dir, f"ffmpeg.{compressed_format}")

    logger.info(f"Downloading FFmpeg from {ffmpeg_url}...")
    urllib.request.urlretrieve(ffmpeg_url, ffmpeg_archive)
    logger.info(f"FFmpeg downloaded. Extracting to {ffmpeg_dir}...")

    os.makedirs(ffmpeg_dir, exist_ok=True)
    
    # Extract 7z
    # Extract archive
    if ffmpeg_url.endswith('.7z'):
        with py7zr.SevenZipFile(ffmpeg_archive, mode='r') as z:
            z.extractall(ffmpeg_dir)
    else:
        with zipfile.ZipFile(ffmpeg_archive, 'r') as zip_ref:
            zip_ref.extractall(ffmpeg_dir)
    
    # Flatten directory structure - move all files to root ffmpeg_dir
    def flatten_directory(directory):
        for root, dirs, files in os.walk(directory):
            for file in files:
                file_path = os.path.join(root, file)
                if root != directory:  # Only move files from subdirectories
                    target_path = os.path.join(directory, file)
                    # Handle name conflicts by keeping the first occurrence
                    if not os.path.exists(target_path):
                        shutil.move(file_path, target_path)
        # Remove empty subdirectories
        for root, dirs, files in os.walk(directory, topdown=False):
            for dir_name in dirs:
                dir_path = os.path.join(root, dir_name)
                try:
                    os.rmdir(dir_path)
                except OSError:
                    pass  # Directory not empty
    
    flatten_directory(ffmpeg_dir)
                    
    # Copy ffmpeg.exe to the python folder
    if os.path.exists(ffmpeg_exe_path):
        shutil.copy2(ffmpeg_exe_path, ffmpeg_in_python)
        logger.info(f"Copied ffmpeg.exe to Python folder: {ffmpeg_in_python}")
    else:
        logger.warning(f"ffmpeg.exe not found in {ffmpeg_dir}. Extraction might have failed.")
    logger.info(f"FFmpeg extracted to {ffmpeg_dir}.")


def download_ocenaudio_if_needed():
    ocenaudio_dir = os.path.join(get_app_directory(), 'ocenaudio')
    ocenaudio_exe_path = os.path.join(ocenaudio_dir, 'ocenaudio.exe')
    if os.path.exists(ocenaudio_dir) and os.path.exists(ocenaudio_exe_path):
        logger.info(f"Ocenaudio already installed at {ocenaudio_dir}.")
        return ocenaudio_exe_path

    if os.path.exists(ocenaudio_dir) and not os.path.exists(ocenaudio_exe_path):
        logger.info("Ocenaudio directory exists but executable is missing. Re-downloading Ocenaudio...")
        shutil.rmtree(ocenaudio_dir)

    ocenaudio_url = "https://www.ocenaudio.com/downloads/ocenaudio_windows64.zip"

    download_dir = os.path.join(get_app_directory(), "downloads")
    os.makedirs(download_dir, exist_ok=True)
    ocenaudio_archive = os.path.join(download_dir, "ocenaudio.zip")

    logger.info(f"Downloading Ocenaudio from {ocenaudio_url}...")
    urllib.request.urlretrieve(ocenaudio_url, ocenaudio_archive)
    logger.info(f"Ocenaudio downloaded. Extracting to {ocenaudio_dir}...")

    os.makedirs(ocenaudio_dir, exist_ok=True)
    with zipfile.ZipFile(ocenaudio_archive, 'r') as zip_ref:
        zip_ref.extractall(get_app_directory())

    logger.info(f"Ocenaudio extracted to {ocenaudio_dir}.")
    return ocenaudio_exe_path

def download_oneocr_dlls_if_needed():
    downloader = Downloader()
    downloader.download_and_extract()

def main():
    download_obs_if_needed()
    download_ffmpeg_if_needed()
    download_ocenaudio_if_needed()
    download_oneocr_dlls_if_needed()

if __name__ == "__main__":
    main()