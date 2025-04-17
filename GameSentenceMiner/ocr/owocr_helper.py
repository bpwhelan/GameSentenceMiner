# area_selector.py
import asyncio
import base64
import difflib
import logging
import os
import queue
import threading
import time
from datetime import datetime
from logging.handlers import RotatingFileHandler
from tkinter import messagebox

import mss
import websockets
from PIL import Image, ImageDraw
import json
from pathlib import Path

from GameSentenceMiner import obs, util
from GameSentenceMiner.configuration import get_config, get_app_directory
from GameSentenceMiner.gametext import get_line_history
from GameSentenceMiner.owocr.owocr import screen_coordinate_picker, run
from GameSentenceMiner.owocr.owocr.run import TextFiltering

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

def get_new_game_cords():
    """Allows multiple coordinate selections."""
    coords_list = []
    while True:
        cords = screen_coordinate_picker.get_screen_selection()
        coords_list.append({"coordinates": cords})
        if messagebox.askyesno("Add Another Region", "Do you want to add another region?"):
            continue
        else:
            break

    app_dir = Path.home() / "AppData" / "Roaming" / "GameSentenceMiner"
    ocr_config_dir = app_dir / "ocr_config"
    ocr_config_dir.mkdir(parents=True, exist_ok=True)
    obs.connect_to_obs()
    scene = util.sanitize_filename(obs.get_current_scene())
    config_path = ocr_config_dir / f"{scene}.json"
    with open(config_path, 'w') as f:
        json.dump(coords_list, f, indent=4)
    print(f"Saved OCR config to {config_path}")
    return coords_list


def get_ocr_config():
    """Loads multiple screen capture areas from the corresponding JSON file."""
    app_dir = Path.home() / "AppData" / "Roaming" / "GameSentenceMiner"
    ocr_config_dir = app_dir / "ocr_config"
    obs.connect_to_obs()
    scene = util.sanitize_filename(obs.get_current_scene())
    config_path = ocr_config_dir / f"{scene}.json"
    if not config_path.exists():
        raise Exception(f"No config file found at {config_path}.")

    if not config_path.exists():
        print("Config Screen picker failed to make file. Please run again.")
        return

    with open(config_path, 'r') as f:
        coords_list = json.load(f)
        return coords_list


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

    def send_text(self, text, line_time: datetime):
        if text:
            return asyncio.run_coroutine_threadsafe(self.send_text_coroutine(json.dumps({"sentence": text, "time": line_time.isoformat()})), self.loop)

    def stop_server(self):
        self.loop.call_soon_threadsafe(self._stop_event.set)

    def run(self):
        async def main():
            self._loop = asyncio.get_running_loop()
            self._stop_event = stop_event = asyncio.Event()
            self._event.set()
            self.server = start_server = websockets.serve(self.server_handler, get_config().general.websocket_uri.split(":")[0], get_config().general.websocket_uri.split(":")[1], max_size=1000000000)
            async with start_server:
                await stop_event.wait()
        asyncio.run(main())

all_cords = None
rectangles = None

def text_callback(text, rectangle):
    global twopassocr, ocr2, last_oneocr_results
    if not text:
        return
    if not twopassocr or not ocr2:
        websocket_server_thread.send_text(text, datetime.now())
        return
    with mss.mss() as sct:
        line_time = datetime.now()
        logger.info(f"Received message: {text}, ATTEMPTING LENS OCR")
        if rectangles:
            cords = rectangles[rectangle]
            i = rectangle
        else:
            i = 0
            mon = sct.monitors
            cords = [mon[1]['left'], mon[1]['top'], mon[1]['width'], mon[1]['height']]
        similarity = difflib.SequenceMatcher(None, last_oneocr_results[i], text).ratio()
        if similarity > .8:
            return
        logger.debug(f"Similarity for region {i}: {similarity}")
        last_oneocr_results[i] = text
        last_result = ([], -1)
        try:
            sct_params = {'left': cords[0], 'top': cords[1], 'width': cords[2], 'height': cords[3]}
            sct_img = sct.grab(sct_params)
            img = Image.frombytes('RGB', sct_img.size, sct_img.bgra, 'raw', 'BGRX')
            img = img.convert("RGBA")
            draw = ImageDraw.Draw(img)
            for exclusion in ocr_config.get("excluded_rectangles", []):
                left, top, right, bottom = exclusion
                draw.rectangle((left, top, right, bottom), fill=(0, 0, 0, 0))
                # draw.rectangle((left, top, right, bottom), fill=(0,0,0))
            orig_text, text = run.process_and_write_results(img, None, None, last_result, TextFiltering(),
                                                            engine=ocr2)
            if ":gsm_prefix:" in text:
                text = text.split(":gsm_prefix:")[1]
            websocket_server_thread.send_text(text, line_time)
        except json.JSONDecodeError:
            print("Invalid JSON received.")
        except Exception as e:
            logger.exception(e)
            print(f"Error processing message: {e}")

done = False

def run_oneocr(ocr_config, i):
    global done
    run.run(read_from="screencapture", write_to="callback",
            screen_capture_area=",".join(str(c) for c in ocr_config['rectangles'][i]) if ocr_config['rectangles'] else 'screen_1',
            screen_capture_window=ocr_config.get("window", None),
            screen_capture_only_active_windows=True if ocr_config.get("window", None) else False,
            screen_capture_delay_secs=.25, engine=ocr1,
            text_callback=text_callback,
            screen_capture_exclusions=ocr_config.get('excluded_rectangles', None),
            rectangle=i)
    done = True


# async def websocket_client():
#     uri = "ws://localhost:7331"  # Replace with your hosted websocket address
#     print("Connecting to WebSocket...")
#     async with websockets.connect(uri) as websocket:
#         print("Connected to WebSocket.")
#
#         try:
#             while True:
#                 message = await websocket.recv()
#                 if not message:
#                     continue
#                 line_time = datetime.now()
#                 get_line_history().add_secondary_line(message)
#                 print(f"Received message: {message}, ATTEMPTING LENS OCR")
#                 if ":gsm_prefix:" in message:
#                     i = int(message.split(":gsm_prefix:")[0])
#                 cords = all_cords[i] if i else all_cords[0]
#                 similarity = difflib.SequenceMatcher(None, last_oneocr_results[i], message).ratio()
#                 if similarity > .8:
#                     continue
#                 print(f"Similarity for region {i}: {similarity}")
#                 last_oneocr_results[i] = message
#                 last_result = ([], -1)
#                 try:
#                     sct_params = {'top': cords[1], 'left': cords[0], 'width': cords[2], 'height': cords[3]}
#                     with mss.mss() as sct:
#                         sct_img = sct.grab(sct_params)
#                     img = Image.frombytes('RGB', sct_img.size, sct_img.bgra, 'raw', 'BGRX')
#                     draw = ImageDraw.Draw(img)
#                     for exclusion in ocr_config.get("excluded_rectangles", []):
#                         exclusion = tuple(exclusion)
#                         draw.rectangle(exclusion, fill="black")
#                     orig_text, text = run.process_and_write_results(img, "results.txt", None, last_result, TextFiltering(), engine="glens")
#                     if ":gsm_prefix:" in text:
#                         text = text.split(":gsm_prefix:")[1]
#                     websocket_server_thread.send_text(text, line_time)
#                 except json.JSONDecodeError:
#                     print("Invalid JSON received.")
#                 except Exception as e:
#                     logger.exception(e)
#                     print(f"Error processing message: {e}")
#         except websockets.exceptions.ConnectionClosed:
#             print("WebSocket connection closed.")
#         except Exception as e:
#             print(f"WebSocket error: {e}")


if __name__ == "__main__":
    global ocr1, ocr2, twopassocr
    import sys

    args = sys.argv[1:]

    if len(args) == 3:
        ocr1 = args[0]
        ocr2 = args[1]
        twopassocr = bool(int(args[2]))
    elif len(args) == 2:
        ocr1 = args[0]
        ocr2 = args[1]
        twopassocr = True
    elif len(args) == 1:
        ocr1 = args[0]
        ocr2 = None
        twopassocr = False
    else:
        ocr1 = "oneocr"

    logger.info(f"Received arguments: ocr1={ocr1}, ocr2={ocr2}, twopassocr={twopassocr}")
    global ocr_config
    ocr_config = get_ocr_config()
    rectangles = ocr_config['rectangles']
    last_oneocr_results = [""] * len(rectangles) if rectangles else [""]
    oneocr_threads = []
    run.init_config(False)
    if rectangles:
        for i, rectangle in enumerate(rectangles):
            thread = threading.Thread(target=run_oneocr, args=(ocr_config,i,), daemon=True)
            oneocr_threads.append(thread)
            thread.start()
    else:
        single_ocr_thread = threading.Thread(target=run_oneocr, args=(ocr_config, 0,), daemon=True)
        oneocr_threads.append(single_ocr_thread)
        single_ocr_thread.start()

    websocket_server_thread = WebsocketServerThread(read=True)
    websocket_server_thread.start()

    try:
        while not done:
            time.sleep(1)
    except KeyboardInterrupt as e:
        pass

    for thread in oneocr_threads:
        thread.join()

    # asyncio.run(websocket_client())