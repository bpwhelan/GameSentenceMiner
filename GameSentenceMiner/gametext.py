import asyncio
import re
import threading
import time
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

reconnecting = False
multi_mine_event_bus: Callable[[str, datetime], None] = None

@dataclass
class GameLine:
    text: str
    time: datetime

@dataclass
class GameText:
    values: list[GameLine]

    def __init__(self):
        self.values = []

    def __getitem__(self, key):
        return self.values[key]

    def get_time(self, line_text):
        for game_line in self.values:
            if game_line.text == line_text:
                return game_line.time
        raise KeyError(f"Line {line_text} not found")

    def get_event(self, line_text):
        for game_line in self.values:
            if game_line.text == line_text:
                return game_line
        raise KeyError(f"Line {line_text} not found")

    def add_line(self, line_text):
        self.values.append(GameLine(line_text, datetime.now()))

line_history = GameText()

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
    line_history.add_line(current_line_after_regex)
    multi_mine_event_bus(current_line_after_regex, current_line_time)
    logger.debug(f"New Line: {current_clipboard}")


def reset_line_hotkey_pressed():
    global current_line_time
    logger.info("LINE RESET HOTKEY PRESSED")
    current_line_time = datetime.now()
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

    lines = line_history.values

    line_time = current_line_time
    next_line = 0
    prev_clip_time = 0

    try:
        sentence = last_note['fields'][get_config().anki.sentence_field]['value']
        if sentence:
            for line in reversed(lines):
                similarity = similar(remove_html_tags(sentence), line.text)
                if similarity >= 0.60 or line in remove_html_tags(sentence):  # 80% similarity threshold
                    line_time = line.time
                    next_line = prev_clip_time
                    break
                prev_clip_time = line.time
    except Exception as e:
        logger.error(f"Using Default clipboard/websocket timing - reason: {e}")

    return line_time, next_line


def get_last_two_sentences(last_note):
    def similar(a, b):
        return SequenceMatcher(None, a, b).ratio()

    lines = line_history.values

    if not last_note:
        return lines[-1].text if lines else '', lines[-2].text if len(lines) > 1 else ''

    sentence = last_note['fields'][get_config().anki.sentence_field]['value']
    if not sentence:
        return lines[-1].text if lines else '', lines[-2].text if len(lines) > 1 else ''

    current, previous = "", ""
    found = False

    for line in reversed(lines):
        similarity = similar(remove_html_tags(sentence), line.text)
        logger.debug(f"Comparing: {remove_html_tags(sentence)} with {line.text} - Similarity: {similarity}")
        if found:
            previous = line.text
            break
        if similarity >= 0.60 or line.text in remove_html_tags(sentence):
            found = True
            current = line.text

    if not current or not previous:
        logger.debug("Couldn't find lines in history, using last two lines")
        return lines[-1].text if lines else '', lines[-2].text if len(lines) > 1 else ''

    return current, previous


def get_line_and_future_lines(last_note):
    def similar(a, b):
        return SequenceMatcher(None, a, b).ratio()

    if not last_note:
        return []

    sentence = last_note['fields'][get_config().anki.sentence_field]['value']
    found_lines = []
    if sentence:
        found = False
        for line in line_history.values:
            similarity = similar(remove_html_tags(sentence), line.text)
            logger.debug(f"Comparing: {remove_html_tags(sentence)} with {line.text} - Similarity: {similarity}")
            if found:
                found_lines.append(line.text)
            if similarity >= 0.60 or line in remove_html_tags(sentence):  # 80% similarity threshold
                found = True
                found_lines.append(line.text)
    return found_lines


def get_time_of_line(line):
    if line and line in line_history:
        return line_history.get_time(line)
    return initial_time
