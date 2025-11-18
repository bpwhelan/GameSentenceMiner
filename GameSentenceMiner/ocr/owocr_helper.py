import asyncio
from copy import copy
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
from GameSentenceMiner.owocr.owocr.run import TextFiltering
from GameSentenceMiner.util.configuration import get_config, get_app_directory, get_temporary_directory, is_windows
from GameSentenceMiner.ocr.gsm_ocr_config import OCRConfig, has_config_changed, set_dpi_awareness, get_window, get_ocr_config_path
from GameSentenceMiner.owocr.owocr import run
from GameSentenceMiner.util.electron_config import get_ocr_ocr2, get_ocr_send_to_clipboard, get_ocr_scan_rate, \
    has_ocr_config_changed, reload_electron_config, get_ocr_two_pass_ocr, get_ocr_optimize_second_scan, \
    get_ocr_language, get_ocr_manual_ocr_hotkey
from GameSentenceMiner.util.gsm_utils import sanitize_filename

CONFIG_FILE = Path("ocr_config.json")
DEFAULT_IMAGE_PATH = r"C:\Users\Beangate\Pictures\msedge_acbl8GL7Ax.jpg"  # CHANGE THIS
logger = logging.getLogger("GSM_OCR")
logger.setLevel(logging.DEBUG)
# Create a file handler for logging
log_file = os.path.join(get_app_directory(), "logs", "ocr_log.txt")
os.makedirs(os.path.join(get_app_directory(), "logs"), exist_ok=True)
file_handler = RotatingFileHandler(log_file, maxBytes=1024 * 1024, backupCount=2, encoding='utf-8')
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
    ocr_config_dir = get_ocr_config_path()
    obs.update_current_game()
    if use_window_for_config and window:
        scene = sanitize_filename(window)
    else:
        scene = sanitize_filename(obs.get_current_scene())
    config_path = Path(ocr_config_dir) / f"{scene}.json"
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
                self.send_text_coroutine(json.dumps({"sentence": text, "time": line_time.isoformat(), "process_path": obs.get_current_game()})), self.loop)

    def stop_server(self):
        self.loop.call_soon_threadsafe(self._stop_event.set)

    def run(self):
        async def main():
            self._loop = asyncio.get_running_loop()
            self._stop_event = stop_event = asyncio.Event()
            self._event.set()
            self.server = start_server = websockets.serve(self.server_handler,
                                                          get_config().advanced.localhost_bind_address,
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
last_sent_result = ""

class OCRProcessor():
    def __init__(self):
        self.filtering = TextFiltering(lang=get_ocr_language())
        pass

    def do_second_ocr(self, ocr1_text, time, img, filtering, pre_crop_image=None, ignore_furigana_filter=False, ignore_previous_result=False):
        global twopassocr, ocr2, last_ocr2_result, last_sent_result
        try:
            orig_text, text = run.process_and_write_results(img, None, last_ocr2_result if not ignore_previous_result else None, self.filtering, None,
                                                            engine=get_ocr_ocr2(), furigana_filter_sensitivity=furigana_filter_sensitivity if not ignore_furigana_filter else 0)
            
            if compare_ocr_results(last_sent_result, text, threshold=80):
                if text:
                    logger.info("Seems like Text we already sent, not doing anything.")
                return
            save_result_image(img, pre_crop_image=pre_crop_image)
            last_ocr2_result = orig_text
            last_sent_result = text
            asyncio.run(send_result(text, time))
        except json.JSONDecodeError:
            print("Invalid JSON received.")
        except Exception as e:
            logger.exception(e)
            print(f"Error processing message: {e}")


def save_result_image(img, pre_crop_image=None):
    if isinstance(img, bytes):
        with open(os.path.join(get_temporary_directory(), "last_successful_ocr.png"), "wb") as f:
            f.write(img)
    else:
        img.save(os.path.join(get_temporary_directory(), "last_successful_ocr.png"))
    run.set_last_image(pre_crop_image if pre_crop_image else img)


async def send_result(text, time):
    if text:
        if get_ocr_send_to_clipboard():
            from GameSentenceMiner.ui.qt_main import send_to_clipboard
            send_to_clipboard(text)
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
second_ocr_processor = OCRProcessor()

class ConfigChangeCheckThread(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.last_changes = None
        self.config_callbacks = []
        self.area_callbacks = []

    def run(self):
        global ocr_config
        while True:
            try:
                section_changed, changes = has_ocr_config_changed()
                if section_changed:
                    reload_electron_config()
                    self.last_changes = changes
                # Only run this block after a change has occurred and then the section is stable (no change)
                if self.last_changes is not None and not section_changed:
                    logger.info(f"Detected config changes: {self.last_changes}")
                    for cb in self.config_callbacks:
                        cb(self.last_changes)
                    if hasattr(run, 'handle_config_change'):
                        run.handle_config_change()
                    if any(c in self.last_changes for c in ('ocr1', 'ocr2', 'language', 'furigana_filter_sensitivity')):
                        reset_callback_vars()
                    self.last_changes = None
                ocr_config_changed = has_config_changed(ocr_config)
                if ocr_config_changed:
                    logger.info("OCR config has changed, reloading...")
                    ocr_config = get_ocr_config(use_window_for_config=True, window=obs.get_current_game())
                    for cb in self.area_callbacks:
                        cb(ocr_config)
                    if hasattr(run, 'handle_area_config_changes'):
                        run.handle_area_config_changes(ocr_config)
                    reset_callback_vars()
            except Exception as e:
                logger.debug(f"ConfigChangeCheckThread error: {e}")
            time.sleep(0.25)  # Lowered to 0.25s for more responsiveness

    def add_config_callback(self, callback):
        self.config_callbacks.append(callback)

    def add_area_callback(self, callback):
        self.area_callbacks.append(callback)
    
def reset_callback_vars():
    global previous_text, last_oneocr_time, text_stable_start_time, previous_orig_text, previous_img, force_stable, previous_ocr1_result, previous_text_list, last_ocr2_result
    previous_text = None
    previous_orig_text = ""
    previous_img = None
    text_stable_start_time = None
    last_oneocr_time = None
    force_stable = False
    previous_ocr1_result = ""
    previous_text_list = []
    last_ocr2_result = ""
    run.set_last_image(None)
    
# class TwoPassOCRHandler:
#     def __init__(self, ocr1, ocr2):
#         self.ocr1 = ocr1
#         self.ocr2 = ocr2
#         self.second_ocr_queue = queue.Queue()
#         self.previous_text = None
#         self.previous_orig_text = ""
#         self.previous_img = None
#         self.text_stable_start_time = None
#         self.last_oneocr_time = None
#         self.force_stable = False
#         self.previous_ocr1_result = ""
#         self.last_sent_result = ""
#         self.previous_text_list = []
        
#     def check_first_ocr(self, text, orig_text, time, img=None, came_from_ss=False, filtering=None, crop_coords=None):
#         if not twopassocr or not ocr2:
#             return text_callback(text, orig_text, time, img=img, came_from_ss=came_from_ss, filtering=filtering, crop_coords=crop_coords)
        
#         text_callback(text, orig_text, time, img=img, came_from_ss=came_from_ss, filtering=filtering, crop_coords=crop_coords)
        
#     def set_ocr_ocr1(self, ocr1):
#         self.ocr1 = ocr1
#     def set_ocr_ocr2(self, ocr2):
#         self.ocr2 = ocr2

#     def get_ocr_ocr1(self):
#         return self.ocr1

#     def get_ocr_ocr2(self):
#         return self.ocr2
last_meiki_crop_coords = None
last_meiki_crop_time = None
last_meiki_success = None


def text_callback(text, orig_text, time, img=None, came_from_ss=False, filtering=None, crop_coords=None, meiki_boxes=None):
    global twopassocr, ocr2, previous_text, last_oneocr_time, text_stable_start_time, previous_orig_text, previous_img, force_stable, previous_ocr1_result, previous_text_list, last_sent_result, last_meiki_crop_coords, last_meiki_success, last_meiki_crop_time
    orig_text_string = ''.join([item for item in orig_text if item is not None]) if orig_text else ""
    if came_from_ss:
        save_result_image(img)
        asyncio.run(send_result(text, time))
        return
        
    if meiki_boxes:
        # If we don't have a previous meiki crop coords, store this one and wait for the next run
        try:
            if last_meiki_crop_coords is None:
                last_meiki_crop_coords = crop_coords
                last_meiki_crop_time = time
                previous_img = img
                return

            # Ensure both coords exist
            if not crop_coords or not last_meiki_crop_coords:
                last_meiki_crop_coords = crop_coords
                last_meiki_crop_time = time
                return

            # Compare coordinates within tolerance (pixels)
            tol = 5
            try:
                close = all(abs(int(crop_coords[i]) - int(last_meiki_crop_coords[i])) <= tol for i in range(4))
            except Exception:
                # Fallback: if values not int-convertible, set not close
                close = False
                
            if close:
                if all(last_meiki_success and abs(int(crop_coords[i]) - int(last_meiki_success[i])) <= tol for i in range(4)):
                    # Reset last_meiki_crop_coords and time so we require another matching pair for a future queue
                    last_meiki_crop_coords = None
                    last_meiki_crop_time = None
                    return
                # Stable crop: queue second OCR immediately
                try:
                    stable_time = last_meiki_crop_time
                    previous_img_local = previous_img
                    pre_crop_image = previous_img_local
                    ocr2_image = get_ocr2_image(crop_coords, og_image=previous_img_local, ocr2_engine=get_ocr_ocr2(), extra_padding=10)
                    # Use the earlier timestamp for when the stable crop started if available
                    # ocr2_image.show()
                    second_ocr_queue.put((text, stable_time, ocr2_image, filtering, pre_crop_image))
                    run.set_last_image(img)
                    last_meiki_success = crop_coords
                except Exception as e:
                    logger.info(f"Failed to queue second OCR task: {e}", exc_info=True)
                # Reset last_meiki_crop_coords and time so we require another matching pair for a future queue
                last_meiki_crop_coords = None
                last_meiki_crop_time = None
                return
            else:
                # Not stable: replace last and wait for the next run
                last_meiki_crop_coords = crop_coords
                last_meiki_success = None
                previous_img = img
                return
        except Exception as e:
            logger.debug(f"Error handling meiki crop coords stability check: {e}")
            last_meiki_crop_coords = crop_coords
            
    if not text:
        run.set_last_image(img)

    line_start_time = time if time else datetime.now()

    if manual or not get_ocr_two_pass_ocr():
        if compare_ocr_results(last_sent_result, text, 80):
            if text:
                logger.info("Seems like Text we already sent, not doing anything.")
            return
        save_result_image(img)
        asyncio.run(send_result(text, line_start_time))
        last_sent_result = text
        previous_orig_text = orig_text_string
        previous_text = None
        previous_img = None
        text_stable_start_time = None
        last_oneocr_time = None
        return
    if not text or force_stable:
        force_stable = False
        if previous_text and text_stable_start_time:
            stable_time = text_stable_start_time
            previous_img_local = previous_img
            pre_crop_image = previous_img_local
            if compare_ocr_results(previous_orig_text, orig_text_string):
                if text:
                    logger.info("Seems like Text we already sent, not doing anything.")
                previous_text = None
                return
            previous_orig_text = orig_text_string
            previous_ocr1_result = previous_text
            ocr2_image = get_ocr2_image(crop_coords, og_image=previous_img_local, ocr2_engine=get_ocr_ocr2())
            # if crop_coords and get_ocr_optimize_second_scan():
            #     x1, y1, x2, y2 = crop_coords
            #     x1 = max(0, min(x1, img.width))
            #     y1 = max(0, min(y1, img.height))
            #     x2 = max(x1, min(x2, img.width))
            #     y2 = max(y1, min(y2, img.height))
            #     previous_img_local.save(os.path.join(get_temporary_directory(), "pre_oneocrcrop.png"))
            #     try:
            #         previous_img_local = previous_img_local.crop((x1, y1, x2, y2))
            #     except ValueError:
            #         logger.warning("Error cropping image, using original image")
            second_ocr_queue.put((previous_text, stable_time, ocr2_image, filtering, pre_crop_image))
            # threading.Thread(target=do_second_ocr, args=(previous_text, stable_time, previous_img_local, filtering), daemon=True).start()
            previous_img = None
            previous_text = None
            text_stable_start_time = None
            last_oneocr_time = None
        previous_text = None
        return

    # Make sure it's an actual new line before starting the timer
    if text and compare_ocr_results(orig_text_string, previous_orig_text):
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

def get_ocr2_image(crop_coords, og_image: Image.Image, ocr2_engine=None, extra_padding=0):
    """
    Returns the image to use for the second OCR pass, cropping and scaling as needed.
    Logic is unchanged, but code is refactored for clarity and maintainability.
    """
    def return_original_image():
        """Return a (possibly cropped) PIL.Image based on the original image and padding."""
        logger.debug("Returning original image for OCR2 (no cropping or optimization).")
        # Convert bytes to PIL.Image if necessary
        img = og_image
        if isinstance(og_image, (bytes, bytearray)):
            try:
                img = Image.open(io.BytesIO(og_image)).convert('RGB')
            except Exception:
                # If conversion fails, just return og_image as-is
                return og_image

        if not crop_coords or not get_ocr_optimize_second_scan():
            return img

        x1, y1, x2, y2 = crop_coords
        # Apply integer padding (can be negative to shrink)
        pad = int(extra_padding or 0)
        x1 = x1 - pad
        y1 = y1 - pad
        x2 = x2 + pad
        y2 = y2 + pad

        # Clamp coordinates to image bounds
        x1 = min(max(0, int(x1)), img.width)
        y1 = min(max(0, int(y1)), img.height)
        x2 = min(max(0, int(x2)), img.width)
        y2 = min(max(0, int(y2)), img.height)

        # Ensure at least a 1-pixel width/height
        if x2 <= x1:
            x2 = min(img.width, x1 + 1)
            x1 = max(0, x2 - 1)
        if y2 <= y1:
            y2 = min(img.height, y1 + 1)
            y1 = max(0, y2 - 1)

        try:
            img.save(os.path.join(get_temporary_directory(), "pre_oneocrcrop.png"))
        except Exception:
            # don't fail just because we couldn't save a debug image
            logger.debug("Could not save pre_oneocrcrop.png for debugging")
        return img.crop((x1, y1, x2, y2))
    
    # TODO Get rid of this check, and just always convert to full res
    LOCAL_OCR_ENGINES = ['easyocr', 'oneocr', 'rapidocr', 'mangaocr', 'winrtocr']
    local_ocr = ocr2_engine in LOCAL_OCR_ENGINES
    ocr_config_local = copy(ocr_config)

    # Non-local OCR: just crop the original image if needed
    if not local_ocr:
        return return_original_image()

    # Local OCR: get fresh screenshot and apply config/cropping
    obs_width = getattr(run.obs_screenshot_thread, 'width', None)
    obs_height = getattr(run.obs_screenshot_thread, 'height', None)
    if not obs_width or not obs_height:
        return return_original_image()
    
    logger.debug(f"Getting OCR2 image with OBS dimensions: {obs_width}x{obs_height}")

    img = obs.get_screenshot_PIL(compression=100, img_format="jpg")
    
    ocr_config_local.scale_to_custom_size(img.width, img.height)
    
    # If img.width and height is the same as obs, no need to scale coords, tolerance of .1%
    if abs(img.width - obs_width) <= 0.1 * obs_width and abs(img.height - obs_height) <= 0.1 * obs_height:
        logger.info("Image size matches OBS size, no need to scale coordinates.")
        return return_original_image()

    # If no crop or optimization, just apply config and return
    if not crop_coords or not get_ocr_optimize_second_scan():
        img = run.apply_ocr_config_to_image(img, ocr_config_local, is_secondary=False)
        return img

    # Calculate scaling ratios
    width_ratio = img.width / obs_width if obs_width else 1
    height_ratio = img.height / obs_height if obs_height else 1
    logger.debug(f"Cropping OCR2 image with crop coordinates: {crop_coords} and ratios: {width_ratio}, {height_ratio}")

    # Scale crop_coords
    x1 = int(crop_coords[0] * width_ratio)
    y1 = int(crop_coords[1] * height_ratio)
    x2 = int(crop_coords[2] * width_ratio)
    y2 = int(crop_coords[3] * height_ratio)

    # Scale padding separately for X and Y
    pad_x = int(round((extra_padding or 0) * width_ratio))
    pad_y = int(round((extra_padding or 0) * height_ratio))

    x1 = x1 - pad_x
    y1 = y1 - pad_y
    x2 = x2 + pad_x
    y2 = y2 + pad_y

    # Clamp coordinates to image bounds
    x1 = min(max(0, int(x1)), img.width)
    y1 = min(max(0, int(y1)), img.height)
    x2 = min(max(0, int(x2)), img.width)
    y2 = min(max(0, int(y2)), img.height)

    # Ensure at least a 1-pixel width/height
    if x2 <= x1:
        x2 = min(img.width, x1 + 1)
        x1 = max(0, x2 - 1)
    if y2 <= y1:
        y2 = min(img.height, y1 + 1)
        y1 = max(0, y2 - 1)

    logger.debug(f"Scaled crop coordinates: {(x1, y1, x2, y2)}")

    img = run.apply_ocr_config_to_image(img, ocr_config_local, is_secondary=False)

    ret = img.crop((x1, y1, x2, y2))
    return ret

def process_task_queue():
    while True:
        try:
            task = second_ocr_queue.get()
            if task is None:  # Exit signal
                break
            ignore_furigana_filter = False
            ignore_previous_result = False
            if len(task) == 7:
                ocr1_text, stable_time, previous_img_local, filtering, pre_crop_image, ignore_furigana_filter, ignore_previous_result = task
            else:
                ocr1_text, stable_time, previous_img_local, filtering, pre_crop_image = task
            second_ocr_processor.do_second_ocr(ocr1_text, stable_time, previous_img_local, filtering, pre_crop_image, ignore_furigana_filter, ignore_previous_result)
        except Exception as e:
            logger.exception(f"Error processing task: {e}")
        finally:
            second_ocr_queue.task_done()


def run_oneocr(ocr_config: OCRConfig, rectangles, config_check_thread):
    global done
    screen_area = None
    screen_areas = [",".join(str(c) for c in rect_config.coordinates) for rect_config in rectangles if not rect_config.is_excluded]
    exclusions = list(rect.coordinates for rect in list(filter(lambda x: x.is_excluded, rectangles)))

    run.init_config(False)
    try:
        read_from = ""
        if obs_ocr:
            read_from = "obs"
        elif window:
            read_from = "screencapture"
        read_from_secondary = "clipboard" if ss_clipboard else None
        run.run(read_from=read_from,
                read_from_secondary=read_from_secondary,
                write_to="callback",
                screen_capture_area=screen_area,
                # screen_capture_monitor=monitor_config['index'],
                screen_capture_window=ocr_config.window if ocr_config and ocr_config.window else None,
                screen_capture_delay_secs=get_ocr_scan_rate(), engine=ocr1,
                text_callback=text_callback,
                screen_capture_exclusions=exclusions,
                monitor_index=None,
                ocr1=ocr1,
                ocr2=ocr2,
                gsm_ocr_config=ocr_config,
                screen_capture_areas=screen_areas,
                furigana_filter_sensitivity=furigana_filter_sensitivity,
                screen_capture_combo=manual_ocr_hotkey.upper() if manual_ocr_hotkey and manual else None,
                config_check_thread=config_check_thread)
    except Exception as e:
        logger.exception(f"Error running OneOCR: {e}")
    done = True
    # Quit Qt app if running
    try:
        from PyQt6.QtWidgets import QApplication
        app = QApplication.instance()
        if app:
            app.quit()
    except Exception:
        pass


def add_ss_hotkey(ss_hotkey="ctrl+shift+g"):
    import keyboard
    
    # We'll create the signal helper when the Qt app is available
    global _screen_cropper_signals

    def ocr_secondary_rectangles():
        logger.info("Running secondary OCR rectangles...")
        ocr_config = get_ocr_config()
        img = obs.get_screenshot_PIL(compression=80, img_format="jpg")
        ocr_config.scale_to_custom_size(img.width, img.height)
        for rectangle in [rectangle for rectangle in ocr_config.rectangles if rectangle.is_secondary]:
            new_img = run.apply_ocr_config_to_image(img, ocr_config, is_secondary=True, rectangles=[rectangle])
            second_ocr_processor.do_second_ocr("", datetime.now(), new_img, TextFiltering(lang=get_ocr_language()), ignore_furigana_filter=True, ignore_previous_result=True)

    filtering = TextFiltering(lang=get_ocr_language())
    
    def capture():
        from GameSentenceMiner.ui.qt_main import launch_screen_cropper
        print("Taking screenshot via screen cropper...")
        
        # Use the dialog manager's synchronous method
        cropped_img = launch_screen_cropper(transparent_mode=False)
        
        global second_ocr_queue
        if cropped_img:
            second_ocr_queue.put(("", datetime.now(), cropped_img, filtering, None, True, True))
        else:
            logger.info("Screen cropper cancelled")
    def capture_main_monitor():
        print("Taking screenshot of main monitor...")
        with mss.mss() as sct:
            main_monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]
            img = sct.grab(main_monitor)
            img_bytes = mss.tools.to_png(img.rgb, img.size)
            second_ocr_processor.do_second_ocr("", datetime.now(), img_bytes, filtering, ignore_furigana_filter=True, ignore_previous_result=True)
    hotkey_reg = None
    secondary_hotkey_reg = None
    try:
        hotkey_reg = keyboard.add_hotkey(ss_hotkey, capture)
        if not manual:
            secondary_hotkey_reg = keyboard.add_hotkey(get_ocr_manual_ocr_hotkey().lower(), ocr_secondary_rectangles)
        print(f"Press {ss_hotkey} to take a screenshot.")
    except Exception as e:
        if hotkey_reg:
            keyboard.remove_hotkey(hotkey_reg)
        if secondary_hotkey_reg:
            keyboard.remove_hotkey(secondary_hotkey_reg)
        logger.error(f"Error setting up screenshot hotkey with keyboard, Attempting Backup: {e}")
        logger.debug(e)
        pynput_hotkey = ss_hotkey.replace("ctrl", "<ctrl>").replace("shift", "<shift>").replace("alt", "<alt>")
        secondary_ss_hotkey = get_ocr_manual_ocr_hotkey().lower().replace("ctrl", "<ctrl>").replace("shift", "<shift>").replace("alt", "<alt>")
        try:
            from pynput import keyboard as pynput_keyboard
            listener = pynput_keyboard.GlobalHotKeys({
                pynput_hotkey: capture,
                secondary_ss_hotkey: ocr_secondary_rectangles,
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
        global ocr1, ocr2, twopassocr, language, ss_clipboard, ss, ocr_config, furigana_filter_sensitivity, area_select_ocr_hotkey, window, optimize_second_scan, use_window_for_config, keep_newline, obs_ocr, manual, settings_window
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
        parser.add_argument("--keep_newline", action="store_true", help="Keep new lines in OCR output")
        parser.add_argument('--obs_ocr', action='store_true', help='Use OBS for Picture Source (not implemented)')

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
        keep_newline = args.keep_newline
        obs_ocr = args.obs_ocr
        
        obs.connect_to_obs_sync(check_output=False)
    
        # Start config change checker thread
        config_check_thread = ConfigChangeCheckThread()
        config_check_thread.start()
        # Example: add a callback to config_check_thread if needed
        # config_check_thread.add_callback(lambda: print("Config changed!"))

        window = None
        logger.info(f"Received arguments: {vars(args)}")
        # set_force_stable_hotkey()
        ocr_config: OCRConfig = get_ocr_config(window=window_name, use_window_for_config=use_window_for_config)
        if ocr_config and not obs_ocr:
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
            ocr_thread = threading.Thread(target=run_oneocr, args=(ocr_config, rectangles, config_check_thread), daemon=True)
            ocr_thread.start()
            # Always start worker thread to process manual screenshots from screen cropper
            worker_thread = threading.Thread(target=process_task_queue, daemon=True)
            worker_thread.start()
            websocket_server_thread = WebsocketServerThread(read=True)
            websocket_server_thread.start()
            if is_windows():
                add_ss_hotkey(ss_hotkey)
            try:
                # Run Qt event loop instead of sleep loop - this allows Qt dialogs to work
                import GameSentenceMiner.ui.qt_main as qt_main
                settings_window = qt_main.get_config_window()
                qt_main.start_qt_app(show_config_immediately=get_config().general.open_config_on_startup)
            except KeyboardInterrupt:
                pass
        else:
            print("Failed to load OCR configuration. Please check the logs.")
    except Exception as e:
        logger.info(e, exc_info=True)
        logger.debug(e, exc_info=True)
        logger.info("Closing in 5 seconds...")
        time.sleep(5)
