import asyncio
import io
import json
import logging
import os
import queue
import threading
import time
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from tkinter import messagebox

import mss
import mss.tools
import websockets
from PIL import Image
from rapidfuzz import fuzz

from GameSentenceMiner import obs
from GameSentenceMiner.ocr.ss_picker import ScreenCropper
from GameSentenceMiner.owocr.owocr.run import TextFiltering
from GameSentenceMiner.util.configuration import get_config, get_app_directory, get_temporary_directory
from GameSentenceMiner.util.electron_config import get_ocr_scan_rate, get_requires_open_window
from GameSentenceMiner.ocr.gsm_ocr_config import OCRConfig, set_dpi_awareness, get_window
from GameSentenceMiner.owocr.owocr import screen_coordinate_picker, run
from GameSentenceMiner.util.gsm_utils import sanitize_filename, do_text_replacements, OCR_REPLACEMENTS_FILE

CONFIG_FILE = Path("ocr_config.json")
DEFAULT_IMAGE_PATH = r"C:\Users\Beangate\Pictures\msedge_acbl8GL7Ax.jpg"  # CHANGE THIS
logger = logging.getLogger("GSM_OCR")
logger.setLevel(logging.DEBUG)
# Create a file handler for logging
log_file = os.path.join(get_app_directory(), "logs", "ocr_log.txt")
os.makedirs(os.path.join(get_app_directory(), "logs"), exist_ok=True)
file_handler = RotatingFileHandler(log_file, maxBytes=1024 * 1024, backupCount=5, encoding='utf-8')
file_handler.setLevel(logging.DEBUG)
# Create a formatter and set it for the handler
formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
file_handler.setFormatter(formatter)
# Add the handler to the logger
logger.addHandler(file_handler)

console_handler = logging.StreamHandler()
console_handler.setLevel(logging.INFO)
console_handler.setFormatter(formatter)
logger.addHandler(console_handler)


def get_ocr_config(window=None, use_window_for_config=False) -> OCRConfig:
    """Loads and updates screen capture areas from the corresponding JSON file."""
    app_dir = Path.home() / "AppData" / "Roaming" / "GameSentenceMiner"
    ocr_config_dir = app_dir / "ocr_config"
    os.makedirs(ocr_config_dir, exist_ok=True)
    obs.connect_to_obs_sync(retry=0)
    if use_window_for_config and window:
        scene = sanitize_filename(window)
    else:
        scene = sanitize_filename(obs.get_current_scene())
    config_path = ocr_config_dir / f"{scene}.json"
    if not config_path.exists():
        ocr_config = OCRConfig(scene=scene, window=window, rectangles=[], coordinate_system="percentage")
        with open(config_path, 'w', encoding="utf-8") as f:
            json.dump(ocr_config.to_dict(), f, indent=4)
        return ocr_config
    try:
        with open(config_path, 'r', encoding="utf-8") as f:
            config_data = json.load(f)
        if "rectangles" in config_data and isinstance(config_data["rectangles"], list) and all(
                isinstance(item, list) and len(item) == 4 for item in config_data["rectangles"]):
            # Old config format, convert to new
            new_rectangles = []
            with mss.mss() as sct:
                monitors = sct.monitors
                default_monitor = monitors[1] if len(monitors) > 1 else monitors[0]
                for rect in config_data["rectangles"]:
                    new_rectangles.append({
                        "monitor": {
                            "left": default_monitor["left"],
                            "top": default_monitor["top"],
                            "width": default_monitor["width"],
                            "height": default_monitor["height"],
                            "index": 0  # Assuming single monitor for old config
                        },
                        "coordinates": rect,
                        "is_excluded": False
                    })
                if 'excluded_rectangles' in config_data:
                    for rect in config_data['excluded_rectangles']:
                        new_rectangles.append({
                            "monitor": {
                                "left": default_monitor["left"],
                                "top": default_monitor["top"],
                                "width": default_monitor["width"],
                                "height": default_monitor["height"],
                                "index": 0  # Assuming single monitor for old config
                            },
                            "coordinates": rect,
                            "is_excluded": True
                        })
            new_config_data = {"scene": config_data.get("scene", scene), "window": config_data.get("window", None),
                               "rectangles": new_rectangles, "coordinate_system": "absolute"}
            with open(config_path, 'w', encoding="utf-8") as f:
                json.dump(new_config_data, f, indent=4)
            return OCRConfig.from_dict(new_config_data)
        elif "rectangles" in config_data and isinstance(config_data["rectangles"], list) and all(
                isinstance(item, dict) and "coordinates" in item for item in config_data["rectangles"]):
            return OCRConfig.from_dict(config_data)
        else:
            raise Exception(f"Invalid config format in {config_path}.")
    except json.JSONDecodeError:
        print("Error decoding JSON. Please check your config file.")
        return None
    except Exception as e:
        print(f"Error loading config: {e}")
        return None


websocket_server_thread = None
websocket_queue = queue.Queue()
paused = False


class WebsocketServerThread(threading.Thread):
    def __init__(self, read):
        super().__init__(daemon=True)
        self._loop = None
        self.read = read
        self.clients = set()
        self._event = threading.Event()

    @property
    def loop(self):
        self._event.wait()
        return self._loop

    async def send_text_coroutine(self, message):
        for client in self.clients:
            await client.send(message)

    async def server_handler(self, websocket):
        self.clients.add(websocket)
        try:
            async for message in websocket:
                if self.read and not paused:
                    websocket_queue.put(message)
                    try:
                        await websocket.send('True')
                    except websockets.exceptions.ConnectionClosedOK:
                        pass
                else:
                    try:
                        await websocket.send('False')
                    except websockets.exceptions.ConnectionClosedOK:
                        pass
        except websockets.exceptions.ConnectionClosedError:
            pass
        finally:
            self.clients.remove(websocket)

    async def send_text(self, text, line_time: datetime):
        if text:
            return asyncio.run_coroutine_threadsafe(
                self.send_text_coroutine(json.dumps({"sentence": text, "time": line_time.isoformat()})), self.loop)

    def stop_server(self):
        self.loop.call_soon_threadsafe(self._stop_event.set)

    def run(self):
        async def main():
            self._loop = asyncio.get_running_loop()
            self._stop_event = stop_event = asyncio.Event()
            self._event.set()
            self.server = start_server = websockets.serve(self.server_handler,
                                                          "0.0.0.0",
                                                          get_config().advanced.ocr_websocket_port,
                                                          max_size=1000000000)
            async with start_server:
                await stop_event.wait()

        asyncio.run(main())


def compare_ocr_results(prev_text, new_text, threshold=90):
    if not prev_text or not new_text:
        return False
    if isinstance(prev_text, list):
        prev_text = ''.join([item for item in prev_text if item is not None]) if prev_text else ""
    if isinstance(new_text, list):
        new_text = ''.join([item for item in new_text if item is not None]) if new_text else ""
    similarity = fuzz.ratio(prev_text, new_text)
    return similarity >= threshold

all_cords = None
rectangles = None
last_ocr2_result = []

def do_second_ocr(ocr1_text, time, img, filtering, ignore_furigana_filter=False):
    global twopassocr, ocr2, last_ocr2_result
    try:
        orig_text, text = run.process_and_write_results(img, None, last_ocr2_result, filtering, None,
                                                        engine=ocr2, furigana_filter_sensitivity=furigana_filter_sensitivity if not ignore_furigana_filter else 0)

        if compare_ocr_results(last_ocr2_result, orig_text):
            logger.info("Detected similar text from previous OCR2 result, not sending")
            return
        save_result_image(img)
        last_ocr2_result = orig_text
        asyncio.run(send_result(text, time))
    except json.JSONDecodeError:
        print("Invalid JSON received.")
    except Exception as e:
        logger.exception(e)
        print(f"Error processing message: {e}")


def save_result_image(img):
    if isinstance(img, bytes):
        with open(os.path.join(get_temporary_directory(), "last_successful_ocr.png"), "wb") as f:
            f.write(img)
    else:
        img.save(os.path.join(get_temporary_directory(), "last_successful_ocr.png"))
        img.close()


async def send_result(text, time):
    if text:
        text = do_text_replacements(text, OCR_REPLACEMENTS_FILE)
        if clipboard_output:
            import pyperclip
            pyperclip.copy(text)
        try:
            await websocket_server_thread.send_text(text, time)
        except Exception as e:
            logger.debug(f"Error sending text to websocket: {e}")


previous_text_list = []
previous_text = ""  # Store last OCR result
previous_ocr1_result = ""  # Store last OCR1 result
last_oneocr_time = None  # Store last OCR time
text_stable_start_time = None  # Store the start time when text becomes stable
previous_img = None
previous_orig_text = ""  # Store original text result
TEXT_APPEARENCE_DELAY = get_ocr_scan_rate() * 1000 + 500  # Adjust as needed
force_stable = False

def text_callback(text, orig_text, time, img=None, came_from_ss=False, filtering=None, crop_coords=None):
    global twopassocr, ocr2, previous_text, last_oneocr_time, text_stable_start_time, previous_orig_text, previous_img, force_stable, previous_ocr1_result, previous_text_list
    orig_text_string = ''.join([item for item in orig_text if item is not None]) if orig_text else ""
    if came_from_ss:
        save_result_image(img)
        asyncio.run(send_result(text, time))
        return

    line_start_time = time if time else datetime.now()

    if manual or not twopassocr:
        if compare_ocr_results(previous_orig_text, orig_text_string):
            logger.info("Seems like Text we already sent, not doing anything.")
            return
        save_result_image(img)
        asyncio.run(send_result(text, line_start_time))
        previous_orig_text = orig_text_string
        previous_text = None
        previous_img = None
        text_stable_start_time = None
        last_oneocr_time = None
        return
    if not text or force_stable:
            # or FUTURE ATTEMPT, I THINK THIS IS CLOSE?
            # (orig_text and previous_text and len(orig_text) == len(previous_text_list) and len(orig_text[0] < len(previous_text_list)))):
        force_stable = False
        if previous_text and text_stable_start_time:
            stable_time = text_stable_start_time
            previous_img_local = previous_img
            if compare_ocr_results(previous_orig_text, orig_text_string):
                logger.info("Seems like Text we already sent, not doing anything.")
                previous_text = None
                return
            previous_orig_text = orig_text_string
            previous_ocr1_result = previous_text
            if crop_coords and optimize_second_scan:
                previous_img_local.save(os.path.join(get_temporary_directory(), "pre_oneocrcrop.png"))
                previous_img_local = previous_img_local.crop(crop_coords)
            second_ocr_queue.put((previous_text, stable_time, previous_img_local, filtering))
            # threading.Thread(target=do_second_ocr, args=(previous_text, stable_time, previous_img_local, filtering), daemon=True).start()
            previous_img = None
            previous_text = None
            text_stable_start_time = None
            last_oneocr_time = None
        previous_text = None
        return

    if not text_stable_start_time:
        text_stable_start_time = line_start_time
    previous_text = text
    previous_text_list = orig_text
    last_oneocr_time = line_start_time
    previous_img = img

done = False

# Create a queue for tasks
second_ocr_queue = queue.Queue()

def process_task_queue():
    while True:
        try:
            task = second_ocr_queue.get()
            if task is None:  # Exit signal
                break
            ocr1_text, stable_time, previous_img_local, filtering = task
            do_second_ocr(ocr1_text, stable_time, previous_img_local, filtering)
        except Exception as e:
            logger.exception(f"Error processing task: {e}")
        finally:
            second_ocr_queue.task_done()


def run_oneocr(ocr_config: OCRConfig, rectangles):
    global done
    print("Running OneOCR")
    screen_area = None
    screen_areas = [",".join(str(c) for c in rect_config.coordinates) for rect_config in rectangles if not rect_config.is_excluded]
    exclusions = list(rect.coordinates for rect in list(filter(lambda x: x.is_excluded, rectangles)))

    run.init_config(False)
    try:
        run.run(read_from="screencapture" if window else "",
                read_from_secondary="clipboard" if ss_clipboard else None,
                write_to="callback",
                screen_capture_area=screen_area,
                # screen_capture_monitor=monitor_config['index'],
                screen_capture_window=ocr_config.window if ocr_config and ocr_config.window else None,
                screen_capture_only_active_windows=get_requires_open_window(),
                screen_capture_delay_secs=get_ocr_scan_rate(), engine=ocr1,
                text_callback=text_callback,
                screen_capture_exclusions=exclusions,
                language=language,
                monitor_index=None,
                ocr1=ocr1,
                ocr2=ocr2,
                gsm_ocr_config=ocr_config,
                screen_capture_areas=screen_areas,
                furigana_filter_sensitivity=furigana_filter_sensitivity,
                screen_capture_combo=manual_ocr_hotkey if manual_ocr_hotkey and manual else None)
    except Exception as e:
        logger.exception(f"Error running OneOCR: {e}")
    done = True



def add_ss_hotkey(ss_hotkey="ctrl+shift+g"):
    import keyboard
    secret_ss_hotkey = "F14"
    filtering = TextFiltering(lang=language)
    cropper = ScreenCropper()
    def capture():
        print("Taking screenshot...")
        img = cropper.run()
        do_second_ocr("", datetime.now(), img, filtering, ignore_furigana_filter=True)
    def capture_main_monitor():
        print("Taking screenshot of main monitor...")
        with mss.mss() as sct:
            main_monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
            img = sct.grab(main_monitor)
            img_bytes = mss.tools.to_png(img.rgb, img.size)
            do_second_ocr("", datetime.now(), img_bytes, filtering, ignore_furigana_filter=True)
    hotkey_reg = None
    try:
        hotkey_reg = keyboard.add_hotkey(ss_hotkey, capture)
        if "f13" in ss_hotkey.lower():
            keyboard.add_hotkey(secret_ss_hotkey, capture_main_monitor)
        print(f"Press {ss_hotkey} to take a screenshot.")
    except Exception as e:
        if hotkey_reg:
            keyboard.remove_hotkey(hotkey_reg)
        logger.error(f"Error setting up screenshot hotkey with keyboard, Attempting Backup: {e}")
        logger.debug(e)
        pynput_hotkey = ss_hotkey.replace("ctrl", "<ctrl>").replace("shift", "<shift>").replace("alt", "<alt>")
        try:
            from pynput import keyboard as pynput_keyboard
            listener = pynput_keyboard.GlobalHotKeys({
                pynput_hotkey: capture
            })
            listener.start()
            print(f"Press {pynput_hotkey} to take a screenshot.")
        except Exception as e:
            logger.error(f"Error setting up screenshot hotkey with pynput, Screenshot Hotkey Will not work: {e}")

def set_force_stable_hotkey():
    import keyboard
    global force_stable
    def toggle_force_stable():
        global force_stable
        force_stable = not force_stable
        if force_stable:
            print("Force stable mode enabled.")
        else:
            print("Force stable mode disabled.")
    keyboard.add_hotkey('p', toggle_force_stable)
    print("Press Ctrl+Shift+F to toggle force stable mode.")

if __name__ == "__main__":
    try:
        global ocr1, ocr2, twopassocr, language, ss_clipboard, ss, ocr_config, furigana_filter_sensitivity, area_select_ocr_hotkey, window, optimize_second_scan, use_window_for_config
        import sys

        import argparse

        parser = argparse.ArgumentParser(description="OCR Configuration")
        parser.add_argument("--language", type=str, default="ja", help="Language for OCR (default: ja)")
        parser.add_argument("--ocr1", type=str, default="oneocr", help="Primary OCR engine (default: oneocr)")
        parser.add_argument("--ocr2", type=str, default="glens", help="Secondary OCR engine (default: glens)")
        parser.add_argument("--twopassocr", type=int, choices=[0, 1], default=1,
                            help="Enable two-pass OCR (default: 1)")
        parser.add_argument("--manual", action="store_true", help="Use screenshot-only mode")
        parser.add_argument("--clipboard", action="store_true", help="Use clipboard for input")
        parser.add_argument("--clipboard-output", action="store_true", default=False, help="Use clipboard for output")
        parser.add_argument("--window", type=str, help="Specify the window name for OCR")
        parser.add_argument("--furigana_filter_sensitivity", type=float, default=0,
                            help="Furigana Filter Sensitivity for OCR (default: 0)")
        parser.add_argument("--manual_ocr_hotkey", type=str, default=None, help="Hotkey for manual OCR (default: None)")
        parser.add_argument("--area_select_ocr_hotkey", type=str, default="ctrl+shift+o",
                            help="Hotkey for area selection OCR (default: ctrl+shift+o)")
        parser.add_argument("--optimize_second_scan", action="store_true",
                            help="Optimize second scan by cropping based on first scan results")
        parser.add_argument("--use_window_for_config", action="store_true",
                            help="Use the specified window for loading OCR configuration")

        args = parser.parse_args()

        language = args.language
        ocr1 = args.ocr1
        ocr2 = args.ocr2 if args.ocr2 else None
        twopassocr = bool(args.twopassocr)
        manual = args.manual
        ss_clipboard = args.clipboard
        window_name = args.window
        furigana_filter_sensitivity = args.furigana_filter_sensitivity
        ss_hotkey = args.area_select_ocr_hotkey.lower()
        manual_ocr_hotkey = args.manual_ocr_hotkey.lower().replace("ctrl", "<ctrl>").replace("shift",
                                                                                             "<shift>").replace(
            "alt", "<alt>") if args.manual_ocr_hotkey else None
        clipboard_output = args.clipboard_output
        optimize_second_scan = args.optimize_second_scan
        use_window_for_config = args.use_window_for_config

        window = None
        logger.info(f"Received arguments: {vars(args)}")
        # set_force_stable_hotkey()
        ocr_config: OCRConfig = get_ocr_config(window=window_name, use_window_for_config=use_window_for_config)
        if ocr_config:
            if ocr_config.window:
                start_time = time.time()
                while time.time() - start_time < 30:
                    window = get_window(ocr_config.window)
                    if window or manual:
                        if window:
                            ocr_config.scale_coords()
                        break
                    logger.info(f"Window: {ocr_config.window} Could not be found, retrying in 1 second...")
                    time.sleep(1)
                else:
                    logger.error(f"Window '{ocr_config.window}' not found within 30 seconds.")
                    sys.exit(1)
            logger.info(
                f"Starting OCR with configuration: Window: {ocr_config.window}, Rectangles: {ocr_config.rectangles}, Engine 1: {ocr1}, Engine 2: {ocr2}, Two-pass OCR: {twopassocr}")
        set_dpi_awareness()
        if manual or ocr_config:
            rectangles = ocr_config.rectangles if ocr_config and ocr_config.rectangles else []
            oneocr_threads = []
            ocr_thread = threading.Thread(target=run_oneocr, args=(ocr_config, rectangles), daemon=True)
            ocr_thread.start()
            if not manual:
                worker_thread = threading.Thread(target=process_task_queue, daemon=True)
                worker_thread.start()
            websocket_server_thread = WebsocketServerThread(read=True)
            websocket_server_thread.start()
            add_ss_hotkey(ss_hotkey)
            try:
                while not done:
                    time.sleep(1)
            except KeyboardInterrupt as e:
                pass
        else:
            print("Failed to load OCR configuration. Please check the logs.")
    except Exception as e:
        logger.info(e, exc_info=True)
        logger.debug(e, exc_info=True)
        logger.info("Closing in 5 seconds...")
        time.sleep(5)
