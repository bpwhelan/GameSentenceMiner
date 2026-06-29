import rapidfuzz
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

from GameSentenceMiner.util.config.configuration import logger, get_config, gsm_state
from GameSentenceMiner.util.gsm_utils import remove_html_and_cloze_tags
from GameSentenceMiner.util.models.model import AnkiCard

initial_time = datetime.now()


class TextSource:
    OCR = "ocr"
    OCR_MANUAL = "ocr_manual"
    HOOKER = "hooker"
    MANUAL = "manual"
    SECONDARY = "secondary"
    SCREEN_CROPPER = "screen_cropper"
    HOTKEY = "hotkey"
    OVERLAY = "overlay"  # overlay periodic/mouse-move scan, no text event; audio timing is best-guess

    # How much padding in seconds to add when capturing text from different sources
    _PADDING_SECONDS = {
        OCR: 0,
        OCR_MANUAL: 2,
        HOOKER: 0,
        MANUAL: 3,
        SECONDARY: 3,
        SCREEN_CROPPER: 5,
        HOTKEY: 3,
        OVERLAY: 3,
    }

    @classmethod
    def padding_seconds(cls, source: str | None) -> float:
        return float(cls._PADDING_SECONDS.get(source, 0))


@dataclass
class GameLine:
    id: str
    text: str
    time: datetime
    prev: "GameLine | None"
    next: "GameLine | None"
    index: int = 0
    scene: str = ""
    TL: str = ""
    mined_time: datetime = datetime.min
    source: str = None
    source_padding: float = 0.0
    translation: str = ""

    def get_previous_time(self):
        if self.prev:
            return self.prev.time
        return initial_time

    def get_next_time(self):
        if self.next_line():
            return self.next_line().time
        return 0

    def set_TL(self, tl: str):
        self.TL = tl

    def __str__(self):
        return str({"text": self.text, "time": self.time})

    def next_line(self):
        return self.next if self.next and self.next.time < self.mined_time else None


@dataclass
class GameText:
    values: list[GameLine]
    values_dict: dict[str, GameLine]
    previous_lines: set = field(default_factory=set)
    game_line_index: int = 0

    def __init__(self):
        self.values = []
        self.values_dict = {}
        self.previous_lines = set()
        self.game_line_index = 0

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

    def add_line(self, line_text, line_time=None, source: str = None):
        if not line_text:
            return
        line_id = str(uuid.uuid4())
        new_line = GameLine(
            id=line_id,  # Time-based UUID as an integer
            text=line_text,
            time=line_time or datetime.now(),
            prev=self.values[-1] if self.values else None,
            next=None,
            index=self.game_line_index,
            scene=gsm_state.current_game or "",
            source=source,
            source_padding=TextSource.padding_seconds(source),
        )
        self.values_dict[line_id] = new_line
        self.game_line_index += 1
        if self.values:
            self.values[-1].next = new_line
        self.values.append(new_line)
        if new_line.prev and is_recycled_line_detection_enabled():
            normalized_previous_line = normalize_text_for_comparison(new_line.prev.text)
            if normalized_previous_line:
                self.previous_lines.add(normalized_previous_line)
        return new_line
        # self.remove_old_events(datetime.now() - timedelta(minutes=10))

    def has_line(self, line_text) -> bool:
        for game_line in self.values:
            if game_line.text == line_text:
                return True
        return False

    def get_last_line(self):
        if self.values:
            return self.values[-1]
        return None


game_log = GameText()


def strip_whitespace_and_punctuation(text: str) -> str:
    """
    Backwards-compatible alias for comparison normalization.
    """
    return normalize_text_for_comparison(text)


def normalize_text_for_comparison(text: str) -> str:
    """
    Remove all Unicode punctuation and whitespace characters from text.
    """
    if text is None:
        return ""

    normalized_characters = []
    for character in str(text):
        if character.isspace():
            continue
        if unicodedata.category(character).startswith("P"):
            continue
        normalized_characters.append(character)

    return "".join(normalized_characters)


def is_recycled_line_detection_enabled() -> bool:
    try:
        return bool(getattr(get_config().overlay, "check_previous_lines_for_recycled_indicator", True))
    except Exception:
        return True


def is_line_recycled(line_text: str) -> bool:
    normalized_line = normalize_text_for_comparison(line_text)
    if not normalized_line:
        return False
    return normalized_line in game_log.previous_lines


CONTAINMENT_MIN_RATIO = 0.3
CONTAINMENT_MIN_CHARS = 5


def _is_contained(needle: str, haystack: str) -> bool:
    if needle not in haystack:
        return False
    return len(needle) >= CONTAINMENT_MIN_CHARS or len(needle) >= CONTAINMENT_MIN_RATIO * len(haystack)


def _match_score(line_text: str, anki_sentence: str) -> float:
    """Rank how well a candidate game line matches the Anki sentence.

    Higher is better; a punctuation-insensitive exact match scores 100. Used to
    choose between several lines that all satisfy ``lines_match`` -- e.g. a full
    sentence and a short recycled fragment that is merely *contained* in it. The
    Anki sentence is the ground truth, so similarity to it separates the real
    line (high ratio) from an incidental containment hit (low ratio).
    """
    normalized_line = normalize_text_for_comparison(line_text)
    normalized_anki = normalize_text_for_comparison(anki_sentence)
    if not normalized_line or not normalized_anki:
        return 0.0
    return rapidfuzz.fuzz.ratio(normalized_line, normalized_anki)


# Do not use partial_ratio here, ever
def lines_match(texthooker_sentence, anki_sentence, similarity_threshold=80) -> bool:
    raw_texthooker_sentence = "" if texthooker_sentence is None else str(texthooker_sentence)
    raw_anki_sentence = "" if anki_sentence is None else str(anki_sentence)
    texthooker_sentence = normalize_text_for_comparison(raw_texthooker_sentence)
    anki_sentence = normalize_text_for_comparison(raw_anki_sentence)
    if not texthooker_sentence or not anki_sentence:
        compact_texthooker_sentence = "".join(
            character for character in raw_texthooker_sentence if not character.isspace()
        )
        compact_anki_sentence = "".join(character for character in raw_anki_sentence if not character.isspace())
        return bool(
            compact_texthooker_sentence
            and compact_anki_sentence
            and compact_texthooker_sentence == compact_anki_sentence
        )

    similarity = rapidfuzz.fuzz.ratio(texthooker_sentence, anki_sentence)
    # logger.debug(f"Comparing sentences: '{texthooker_sentence}' and '{anki_sentence}' - Similarity: {similarity}")
    return (
        _is_contained(anki_sentence, texthooker_sentence)
        or _is_contained(texthooker_sentence, anki_sentence)
        or (similarity >= similarity_threshold)
    )


def get_matching_line(last_note: AnkiCard, lines=None) -> GameLine:
    """
    Find a matching GameLine for the given AnkiCard.

    Args:
        last_note: The AnkiCard to match against
        lines: Optional list of GameLines to search in. If None, uses all game log lines.

    Returns:
        GameLine: The matching line or the latest line if no match found
    """
    if not lines:
        lines = get_all_lines()

    if not lines:
        raise Exception(
            "No voicelines in GSM. GSM can only do work on text that has been sent to it since it started. If you are not getting any text into GSM, please check your setup/config."
        )

    last_line = lines[-1]  # Store reference to the latest line

    if not last_note:
        return last_line

    sentence = last_note.get_field(get_config().anki.sentence_field)
    if not sentence:
        return last_line

    anki_sentence = remove_html_and_cloze_tags(sentence)
    time_window = datetime.now() - timedelta(seconds=gsm_state.replay_buffer_length) - timedelta(seconds=5)

    # Don't return the first line that merely matches: a short recycled fragment
    # (e.g. "性質を……入れ替える？") normalizes to text that is *contained* in a
    # longer sentence the user actually mined, so it would win on recency alone.
    # Instead, scan every candidate within the window and keep the best-scoring
    # one. ">" keeps the most recent line on ties; an exact match short-circuits.
    best_line = None
    best_score = -1.0
    for line in reversed(lines):
        if line.time < time_window:
            break
        if lines_match(line.text, anki_sentence):
            score = _match_score(line.text, anki_sentence)
            if score > best_score:
                best_score = score
                best_line = line
                if score >= 100:
                    break

    if best_line is not None:
        return best_line

    logger.info("Could not find matching sentence from GSM's history within the time window. Using the latest line.")
    return last_line


def get_text_event(last_note) -> GameLine:
    """
    Legacy wrapper for get_matching_line with original behavior.
    Uses raw text comparison for backward compatibility.
    """
    return get_matching_line(last_note, lines=None)


def get_mined_line(last_note: AnkiCard, lines=None) -> GameLine:
    """
    Legacy wrapper for get_matching_line with original behavior.
    Uses stripped text comparison and accepts custom lines.
    """
    return get_matching_line(last_note, lines=lines)


def get_time_of_line(line):
    return game_log.get_time(line)


def get_all_lines():
    return game_log.values


def get_text_log() -> GameText:
    return game_log


def add_line(current_line_after_regex, line_time, source: str) -> GameLine:
    return game_log.add_line(current_line_after_regex, line_time, source=source)


def get_line_by_id(line_id: str) -> Optional[GameLine]:
    """
    Retrieve a GameLine by its unique ID.

    Args:
        line_id (str): The unique identifier of the GameLine.

    Returns:
        Optional[GameLine]: The GameLine object if found, otherwise None.
    """
    return game_log.get_by_id(line_id)
