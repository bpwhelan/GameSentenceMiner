import asyncio
import re
import threading
import time
from datetime import datetime

import pyperclip
import websockets
from websockets import InvalidStatusCode

from GameSentenceMiner import util
from GameSentenceMiner.model import AnkiCard
from GameSentenceMiner.configuration import *
from GameSentenceMiner.configuration import get_config, logger
from GameSentenceMiner.util import remove_html_and_cloze_tags
from difflib import SequenceMatcher

from GameSentenceMiner.utility_gui import get_utility_window

initial_time = datetime.now()
current_line = ''
current_line_after_regex = ''
current_line_time = datetime.now()

reconnecting = False
websocket_connected = False

@dataclass
class GameLine:
    text: str
    time: datetime
    prev: 'GameLine'
    next: 'GameLine'
    index: int = 0

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
    game_line_index = 0

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
        new_line = GameLine(line_text, datetime.now(), self.values[-1] if self.values else None, None, self.game_line_index)
        self.game_line_index += 1
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

        skip_next_clipboard = False
        while True:
            if websocket_connected:
                time.sleep(1)
                skip_next_clipboard = True
                continue
            current_clipboard = pyperclip.paste()

            if current_clipboard != current_line and not skip_next_clipboard:
                handle_new_text_event(current_clipboard)
                skip_next_clipboard = False

            time.sleep(0.05)


async def listen_websocket():
    global current_line, current_line_time, line_history, reconnecting, websocket_connected
    try_other = False
    websocket_url = f'ws://{get_config().general.websocket_uri}'
    while True:
        if try_other:
            websocket_url = f'ws://{get_config().general.websocket_uri}/api/ws/text/origin'
        try:
            async with websockets.connect(websocket_url, ping_interval=None) as websocket:
                logger.info("TextHooker Websocket Connected!")
                if reconnecting:
                    logger.info(f"Texthooker WebSocket connected Successfully!" + " Disabling Clipboard Monitor." if get_config().general.use_clipboard else "")
                    reconnecting = False
                websocket_connected = True
                try_other = True
                while True:
                    message = await websocket.recv()
                    logger.debug(message)
                    try:
                        data = json.loads(message)
                        if "sentence" in data:
                            current_clipboard = data["sentence"]
                    except json.JSONDecodeError or TypeError:
                        current_clipboard = message
                    if current_clipboard != current_line:
                        handle_new_text_event(current_clipboard)
        except (websockets.ConnectionClosed, ConnectionError, InvalidStatusCode) as e:
            if isinstance(e, InvalidStatusCode):
                e: InvalidStatusCode
                if e.status_code == 404:
                    logger.info("Texthooker WebSocket connection failed. Attempting some fixes...")
                    try_other = True

                logger.error(f"Texthooker WebSocket connection failed. Please check if the Texthooker is running and the WebSocket URI is correct.")
            websocket_connected = False
            if not reconnecting:
                logger.warning(f"Texthooker WebSocket connection lost, Defaulting to clipboard if enabled. Attempting to Reconnect...")
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
    get_utility_window().add_text(line_history[-1])


def reset_line_hotkey_pressed():
    global current_line_time
    logger.info("LINE RESET HOTKEY PRESSED")
    current_line_time = datetime.now()
    util.set_last_mined_line("")


def run_websocket_listener():
    asyncio.run(listen_websocket())


def start_text_monitor():
    if get_config().general.use_websocket:
        threading.Thread(target=run_websocket_listener, daemon=True).start()
    if get_config().general.use_clipboard:
        if get_config().general.use_websocket:
            logger.info("Both WebSocket and Clipboard monitoring are enabled. WebSocket will take precedence if connected.")
        ClipboardMonitor().start()


def similar(a, b):
    return SequenceMatcher(None, a, b).ratio()

def one_contains_the_other(a, b):
    return a in b or b in a

def lines_match(a, b):
    similarity = similar(a, b)
    logger.debug(f"Comparing: {a} with {b} - Similarity: {similarity}, Or One contains the other: {one_contains_the_other(a, b)}")
    return similar(a, b) >= 0.60 or one_contains_the_other(a, b)

def get_text_event(last_note) -> GameLine:
    lines = line_history.values

    if not lines:
        raise Exception("No lines in history. Text is required from either clipboard or websocket for GSM to work. Please check your setup/config.")

    if not last_note:
        return lines[-1]

    sentence = last_note.get_field(get_config().anki.sentence_field)
    if not sentence:
        return lines[-1]

    for line in reversed(lines):
        if lines_match(line.text, remove_html_and_cloze_tags(sentence)):
            return line

    logger.debug("Couldn't find a match in history, using last event")
    return lines[-1]


def get_line_and_future_lines(last_note):
    if not last_note:
        return []

    sentence = last_note.get_field(get_config().anki.sentence_field)
    found_lines = []
    if sentence:
        found = False
        for line in line_history.values:
            if found:
                found_lines.append(line.text)
            if lines_match(line.text, remove_html_and_cloze_tags(sentence)):  # 80% similarity threshold
                found = True
                found_lines.append(line.text)
    return found_lines

def get_mined_line(last_note: AnkiCard, lines):
    if not last_note:
        return lines[-1]

    sentence = last_note.get_field(get_config().anki.sentence_field)
    for line in lines:
        if lines_match(line.text, remove_html_and_cloze_tags(sentence)):
            return line
    return lines[-1]


def get_time_of_line(line):
    return line_history.get_time(line)


def get_all_lines():
    return line_history.values


def get_line_history():
    return line_history
