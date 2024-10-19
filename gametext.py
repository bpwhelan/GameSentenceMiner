import asyncio
import json
import threading
import time
from collections import OrderedDict
from datetime import datetime

import pyperclip
import websockets

import util
from config_reader import *

previous_line = ''
previous_line_time = datetime.now()

line_history = OrderedDict()


def monitor_clipboard():
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
    global previous_line, previous_line_time, line_history
    while True:
        try:
            async with websockets.connect(f'ws://{websocket_uri}') as websocket:
                print("TextHook Websocket Connected")
                while True:
                    message = await websocket.recv()

                    try:
                        data = json.loads(message)
                        if "sentence" in data:
                            current_clipboard = data["sentence"]
                    except json.JSONDecodeError:
                        current_clipboard = message

                    # if current_clipboard != previous_clipboard:
                    previous_line = current_clipboard
                    previous_line_time = datetime.now()
                    line_history[previous_line] = previous_line_time
                    util.use_previous_audio = False

        except (websockets.ConnectionClosed, ConnectionError) as e:
            print(f"WebSocket connection lost: {e}. Trying again in 5 seconds...")
            await asyncio.sleep(5)


def reset_line_hotkey_pressed():
    global previous_line_time
    previous_line_time = datetime.now()
    util.use_previous_audio = False


def run_websocket_listener():
    asyncio.run(listen_websocket())


def start_text_monitor():
    if websocket_enabled:
        text_thread = threading.Thread(target=run_websocket_listener, daemon=True)
    else:
        text_thread = threading.Thread(target=monitor_clipboard, daemon=True)
    text_thread.start()
