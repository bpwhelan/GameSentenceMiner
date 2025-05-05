import uuid
from dataclasses import dataclass
from datetime import datetime
from difflib import SequenceMatcher
from typing import Optional

from GameSentenceMiner.configuration import logger, get_config
from GameSentenceMiner.model import AnkiCard
from GameSentenceMiner.util import remove_html_and_cloze_tags

initial_time = datetime.now()


@dataclass
class GameLine:
    id: str
    text: str
    time: datetime
    prev: 'GameLine | None'
    next: 'GameLine | None'
    index: int = 0

    def get_previous_time(self):
        if self.prev:
            return self.prev.time
        return initial_time

    def get_next_time(self):
        if self.next:
            return self.next.time
        return 0

    def __str__(self):
        return str({"text": self.text, "time": self.time})


@dataclass
class GameText:
    values: list[GameLine]
    values_dict: dict[str, GameLine]
    game_line_index = 0

    def __init__(self):
        self.values = []
        self.values_dict = {}

    def __getitem__(self, index):
        return self.values[index]

    def get_by_id(self, line_id: str) -> Optional[GameLine]:
        if not self.values_dict:
            return None
        return self.values_dict.get(line_id)

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

    def add_line(self, line_text, line_time=None):
        if not line_text:
            return
        line_id = str(uuid.uuid1())
        new_line = GameLine(
            id=line_id,  # Time-based UUID as an integer
            text=line_text,
            time=line_time if line_time else datetime.now(),
            prev=self.values[-1] if self.values else None,
            next=None,
            index=self.game_line_index
        )
        self.values_dict[line_id] = new_line
        logger.debug(f"Adding line: {new_line}")
        self.game_line_index += 1
        if self.values:
            self.values[-1].next = new_line
        self.values.append(new_line)
        # self.remove_old_events(datetime.now() - timedelta(minutes=10))

    def has_line(self, line_text) -> bool:
        for game_line in self.values:
            if game_line.text == line_text:
                return True
        return False


text_log = GameText()


def similar(a, b):
    return SequenceMatcher(None, a, b).ratio()


def one_contains_the_other(a, b):
    return a in b or b in a


def lines_match(a, b):
    similarity = similar(a, b)
    logger.debug(f"Comparing: {a} with {b} - Similarity: {similarity}, Or One contains the other: {one_contains_the_other(a, b)}")
    return similar(a, b) >= 0.60 or one_contains_the_other(a, b)


def get_text_event(last_note) -> GameLine:
    lines = text_log.values

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
        for line in text_log.values:
            if found:
                found_lines.append(line.text)
            if lines_match(line.text, remove_html_and_cloze_tags(sentence)):  # 80% similarity threshold
                found = True
                found_lines.append(line.text)
    return found_lines


def get_mined_line(last_note: AnkiCard, lines):
    if not last_note:
        return lines[-1]
    if not lines:
        lines = get_all_lines()

    sentence = last_note.get_field(get_config().anki.sentence_field)
    for line in lines:
        if lines_match(line.text, remove_html_and_cloze_tags(sentence)):
            return line
    return lines[-1]


def get_time_of_line(line):
    return text_log.get_time(line)


def get_all_lines():
    return text_log.values


def get_text_log() -> GameText:
    return text_log

def add_line(current_line_after_regex, line_time):
    text_log.add_line(current_line_after_regex, line_time)

def get_line_by_id(line_id: str) -> Optional[GameLine]:
    """
    Retrieve a GameLine by its unique ID.

    Args:
        line_id (str): The unique identifier of the GameLine.

    Returns:
        Optional[GameLine]: The GameLine object if found, otherwise None.
    """
    return text_log.get_by_id(line_id)
