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
    prev: 'GameLine'
    next: 'GameLine'

    def get_previous_time(self):
        if self.prev:
            return self.prev.time
        return initial_time

    def get_next_time(self):
        if self.next:
            return self.next.time
        return 0

@dataclass
class GameText:
    values: list[GameLine]

    def __init__(self):
        self.values = []

    def __getitem__(self, key):
        return self.values[key]

    def get_time(self, line_text: str, occurrence: int = -1) -> datetime:
        matches = [line for line in self.values if line.text == line_text]
        if matches:
            return matches[occurrence].time  # Default to latest
        return initial_time

    def get_event(self, line_text: str, occurrence: int = -1) -> GameLine | None:
        matches = [line for line in self.values if line.text == line_text]
        if matches:
            return matches[occurrence]
        return None

    def add_line(self, line_text):
        new_line = GameLine(line_text, datetime.now(), self.values[-1] if self.values else None, None)
        if self.values:
            self.values[-1].next = new_line
        self.values.append(new_line)

    def has_line(self, line_text) -> bool:
        for game_line in self.values:
            if game_line.text == line_text:
                return True
        return False

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
    logger.info(f"Line Received: {current_line_after_regex}")
    current_line_time = datetime.now()
    line_history.add_line(current_line_after_regex)
    multi_mine_event_bus(line_history[-1])


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


def similar(a, b):
    return SequenceMatcher(None, a, b).ratio()


def get_text_event(last_note) -> GameLine:
    lines = line_history.values

    if not last_note:
        return lines[-1]

    sentence = last_note['fields'][get_config().anki.sentence_field]['value']
    if not sentence:
        return lines[-1]

    for line in reversed(lines):
        similarity = similar(remove_html_tags(sentence), line.text)
        logger.debug(f"Comparing: {remove_html_tags(sentence)} with {line.text} - Similarity: {similarity}")
        if similarity >= 0.60 or line.text in remove_html_tags(sentence):
            return line

    logger.debug("Couldn't find a match in history, using last event")
    return lines[-1]


def get_line_and_future_lines(last_note):
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
            if similarity >= 0.60 or line.text in remove_html_tags(sentence):  # 80% similarity threshold
                found = True
                found_lines.append(line.text)
    return found_lines

def get_mined_line(last_note, lines):
    if not last_note:
        return lines[0]

    sentence = last_note['fields'][get_config().anki.sentence_field]['value']
    for line2 in lines:
        similarity = similar(remove_html_tags(sentence), line2.text)
        if similarity >= 0.60 or line2.text in remove_html_tags(sentence):
            return line2
    return lines[0]


def get_time_of_line(line):
    return line_history.get_time(line)
