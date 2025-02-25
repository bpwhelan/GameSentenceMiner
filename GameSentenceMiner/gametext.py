import asyncio
import re
import threading
import time
from collections import OrderedDict
from datetime import datetime
from typing import Callable

import pyperclip
import websockets

from GameSentenceMiner import util
from GameSentenceMiner.configuration import *
from GameSentenceMiner.configuration import get_config, logger
from GameSentenceMiner.util import remove_html_tags
from difflib import SequenceMatcher


initial_time = datetime.now()
current_line = ''
current_line_after_regex = ''
current_line_time = datetime.now()

line_history = OrderedDict()
reconnecting = False
multi_mine_event_bus: Callable[[str, datetime], None] = None


class ClipboardMonitor(threading.Thread):

    def __init__(self):
        threading.Thread.__init__(self)
        self.daemon = True

    def run(self):
        global current_line_time, current_line, line_history

        # Initial clipboard content
        current_line = pyperclip.paste()

        while True:
            current_clipboard = pyperclip.paste()

            if current_clipboard != current_line:
                handle_new_text_event(current_clipboard)

            time.sleep(0.05)


async def listen_websocket():
    global current_line, current_line_time, line_history, reconnecting
    while True:
        try:
            async with websockets.connect(f'ws://{get_config().general.websocket_uri}', ping_interval=None) as websocket:
                if reconnecting:
                    logger.info(f"Texthooker WebSocket connected Successfully!")
                    reconnecting = False
                while True:
                    message = await websocket.recv()

                    try:
                        data = json.loads(message)
                        if "sentence" in data:
                            current_clipboard = data["sentence"]
                    except json.JSONDecodeError:
                        current_clipboard = message
                    if current_clipboard != current_line:
                        handle_new_text_event(current_clipboard)
        except (websockets.ConnectionClosed, ConnectionError) as e:
            if not reconnecting:
                logger.warning(f"Texthooker WebSocket connection lost: {e}. Attempting to Reconnect...")
            reconnecting = True
            await asyncio.sleep(5)

def handle_new_text_event(current_clipboard):
    global current_line, current_line_time, line_history, current_line_after_regex
    current_line = current_clipboard
    if get_config().general.texthook_replacement_regex:
        current_line_after_regex = re.sub(get_config().general.texthook_replacement_regex, '', current_line)
    else:
        current_line_after_regex = current_line
    current_line_time = datetime.now()
    line_history[current_line_after_regex] = current_line_time
    multi_mine_event_bus(current_line_after_regex, current_line_time)
    logger.debug(f"New Line: {current_clipboard}")


def reset_line_hotkey_pressed():
    global current_line_time
    logger.info("LINE RESET HOTKEY PRESSED")
    current_line_time = datetime.now()
    line_history[current_line_after_regex] = current_line_time
    util.set_last_mined_line("")


def run_websocket_listener():
    asyncio.run(listen_websocket())


def start_text_monitor(send_to_mine_event_bus):
    global multi_mine_event_bus
    multi_mine_event_bus = send_to_mine_event_bus
    if get_config().general.use_websocket:
        text_thread = threading.Thread(target=run_websocket_listener, daemon=True)
    else:
        text_thread = ClipboardMonitor()
    text_thread.start()


def get_line_timing(last_note):
    def similar(a, b):
        return SequenceMatcher(None, a, b).ratio()

    if not last_note:
        return current_line_time, 0

    line_time = current_line_time
    next_line = 0
    prev_clip_time = 0

    try:
        sentence = last_note['fields'][get_config().anki.sentence_field]['value']
        if sentence:
            for i, (line, clip_time) in enumerate(reversed(line_history.items())):
                similarity = similar(remove_html_tags(sentence), line)
                if similarity >= 0.60 or line in remove_html_tags(sentence):  # 80% similarity threshold
                    line_time = clip_time
                    next_line = prev_clip_time
                    break
                prev_clip_time = clip_time
    except Exception as e:
        logger.error(f"Using Default clipboard/websocket timing - reason: {e}")

    return line_time, next_line


def get_last_two_sentences(last_note):
    def similar(a, b):
        return SequenceMatcher(None, a, b).ratio()
    lines = list(line_history.items())

    if not last_note:
        return lines[-1][0] if lines else '', lines[-2][0] if len(lines) > 1 else ''

    current = ""
    previous = ""

    sentence = last_note['fields'][get_config().anki.sentence_field]['value']
    if sentence:
        found = False
        for i, (line, clip_time) in enumerate(reversed(lines)):
            similarity = similar(remove_html_tags(sentence), line)
            logger.debug(f"Comparing: {remove_html_tags(sentence)} with {line} - Similarity: {similarity}")
            if found:
                previous = line
                break
            if similarity >= 0.60 or line in remove_html_tags(sentence):  # 80% similarity threshold
                found = True
                current = line

    logger.debug(f"Current Line: {current}")
    logger.debug(f"Previous Line: {previous}")

    if not current or not previous:
        logger.debug("Couldn't find lines in history, using last two lines")
        return lines[-1][0] if lines else '', lines[-2][0] if len(lines) > 1 else ''

    return current, previous


def get_line_and_future_lines(last_note):
    def similar(a, b):
        return SequenceMatcher(None, a, b).ratio()
    lines = list(line_history.items())

    if not last_note:
        return []

    sentence = last_note['fields'][get_config().anki.sentence_field]['value']
    found_lines = []
    if sentence:
        found = False
        for i, (line, clip_time) in enumerate(lines):
            similarity = similar(remove_html_tags(sentence), line)
            logger.debug(f"Comparing: {remove_html_tags(sentence)} with {line} - Similarity: {similarity}")
            if found:
                found_lines.append(line)
            if similarity >= 0.60 or line in remove_html_tags(sentence):  # 80% similarity threshold
                found = True
                found_lines.append(line)
    return found_lines


def get_time_of_line(line):
    if line and line in line_history:
        return line_history[line]
    return initial_time
