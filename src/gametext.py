import asyncio
import threading
import time
from collections import OrderedDict
from datetime import datetime

import pyperclip
import websockets

from . import util
from .configuration import *
from .configuration import get_config, logger
from .util import remove_html_tags
from difflib import SequenceMatcher


previous_line = ''
previous_line_time = datetime.now()

line_history = OrderedDict()
reconnecting = False


class ClipboardMonitor(threading.Thread):

    def __init__(self):
        threading.Thread.__init__(self)
        self.daemon = True

    def run(self):
        global previous_line_time, previous_line, line_history

        # Initial clipboard content
        previous_line = pyperclip.paste()

        while True:
            current_clipboard = pyperclip.paste()

            if current_clipboard != previous_line:
                previous_line = current_clipboard
                previous_line_time = datetime.now()
                line_history[previous_line] = previous_line_time
                util.use_previous_audio = False

            time.sleep(0.05)


async def listen_websocket():
    global previous_line, previous_line_time, line_history, reconnecting
    while True:
        try:
            async with websockets.connect(f'ws://{get_config().general.websocket_uri}', ping_interval=None) as websocket:
                if reconnecting:
                    print(f"Texthooker WebSocket connected Successfully!")
                    reconnecting = False
                while True:
                    message = await websocket.recv()

                    try:
                        data = json.loads(message)
                        if "sentence" in data:
                            current_clipboard = data["sentence"]
                    except json.JSONDecodeError:
                        current_clipboard = message

                    if current_clipboard != previous_line:
                        previous_line = current_clipboard
                        previous_line_time = datetime.now()
                        line_history[previous_line] = previous_line_time
                        util.use_previous_audio = False

        except (websockets.ConnectionClosed, ConnectionError) as e:
            if not reconnecting:
                print(f"Texthooker WebSocket connection lost: {e}. Attempting to Reconnect...")
            reconnecting = True
            await asyncio.sleep(5)


def reset_line_hotkey_pressed():
    global previous_line_time
    logger.info("LINE RESET HOTKEY PRESSED")
    previous_line_time = datetime.now()
    line_history[previous_line] = previous_line_time
    util.use_previous_audio = False


def run_websocket_listener():
    asyncio.run(listen_websocket())


def start_text_monitor():
    if get_config().general.use_websocket:
        text_thread = threading.Thread(target=run_websocket_listener, daemon=True)
    else:
        text_thread = ClipboardMonitor()
    text_thread.start()


def get_line_timing(last_note):
    def similar(a, b):
        return SequenceMatcher(None, a, b).ratio()

    if not last_note:
        return previous_line_time, 0

    line_time = previous_line_time
    next_line = 0
    prev_clip_time = 0

    try:
        sentence = last_note['fields'][get_config().anki.sentence_field]['value']
        if sentence:
            for i, (line, clip_time) in enumerate(reversed(line_history.items())):
                similarity = similar(remove_html_tags(sentence), line)
                if similarity >= 0.60:  # 80% similarity threshold
                    line_time = clip_time
                    next_line = prev_clip_time
                    break
                prev_clip_time = clip_time
    except Exception as e:
        logger.error(f"Using Default clipboard/websocket timing - reason: {e}")

    return line_time, next_line


def get_last_two_sentences():
    lines = list(line_history.items())
    return lines[-1][0] if lines else '', lines[-2][0] if len(lines) > 1 else ''
