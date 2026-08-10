import rapidfuzz
import threading
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

from GameSentenceMiner.util.config.configuration import logger, get_config, gsm_state
from GameSentenceMiner.util.gsm_utils import remove_html_and_cloze_tags
from GameSentenceMiner.util.models.model import AnkiCard

initial_time = datetime.now()


def to_local_naive_datetime(value: datetime) -> datetime:
    """Convert an aware instant to GSM's legacy local-naive datetime format."""
    if value.tzinfo is None:
        return value
    return datetime.fromtimestamp(value.timestamp())


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
    session_id: str = ""
    stream_sequence: int = 0
    revision: int = 1
    state: str = "frozen"
    first_seen_time: datetime | None = None
    finalized_time: datetime | None = None
    source_instance: str = ""

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
        self._lock = threading.RLock()

    def __getitem__(self, index):
        with self._lock:
            return self.values[index]

    def get_by_id(self, line_id: str) -> Optional[GameLine]:
        with self._lock:
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
        with self._lock:
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
        with self._lock:
            if self.values:
                return self.values[-1]
            return None

    def upsert_authoritative_line(self, record) -> GameLine:
        """Project an immutable TextRecordSnapshot into the legacy GameLine facade."""
        captured_at = to_local_naive_datetime(record.captured_at_utc)
        first_seen = to_local_naive_datetime(record.first_seen_at_utc)
        finalized = to_local_naive_datetime(record.finalized_at_utc) if record.finalized_at_utc else None
        with self._lock:
            existing = self.values_dict.get(record.line_id)
            if existing is not None:
                if record.revision >= existing.revision:
                    existing.text = record.text
                    existing.time = captured_at
                    existing.scene = record.scene
                    existing.source = record.source_kind.value
                    existing.source_padding = TextSource.padding_seconds(existing.source)
                    existing.revision = record.revision
                    existing.state = record.state.value
                    existing.first_seen_time = first_seen
                    existing.finalized_time = finalized
                    existing.source_instance = record.source_instance
                    existing.excluded_from_stats = record.excluded_from_stats
                return existing

            previous = self.values[-1] if self.values else None
            line = GameLine(
                id=record.line_id,
                text=record.text,
                time=captured_at,
                prev=previous,
                next=None,
                index=self.game_line_index,
                scene=record.scene,
                source=record.source_kind.value,
                source_padding=TextSource.padding_seconds(record.source_kind.value),
                session_id=record.session_id,
                stream_sequence=record.stream_sequence,
                revision=record.revision,
                state=record.state.value,
                first_seen_time=first_seen,
                finalized_time=finalized,
                source_instance=record.source_instance,
            )
            line.excluded_from_stats = record.excluded_from_stats
            self.values_dict[line.id] = line
            self.values.append(line)
            self.game_line_index += 1
            if previous is not None:
                previous.next = line
                if is_recycled_line_detection_enabled():
                    normalized = normalize_text_for_comparison(previous.text)
                    if normalized:
                        self.previous_lines.add(normalized)
            return line

    def snapshot(self) -> tuple[GameLine, ...]:
        with self._lock:
            return tuple(self.values)


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


def get_matching_line(last_note: AnkiCard, lines=None, *, prefer_recent: bool = False) -> GameLine:
    """
    Find a matching GameLine for the given AnkiCard.

    Args:
        last_note: The AnkiCard to match against
        lines: Optional list of GameLines to search in. If None, uses all game log lines.
        prefer_recent: Prefer the newest valid match instead of the highest text-similarity
            score. Overlay mines use this because an NVL block can contain several recent
            text events, while the clicked expression usually belongs to the newest one.

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

    anki_config = get_config().anki
    sentence = last_note.get_field(anki_config.sentence_field)
    if not sentence:
        return last_line

    anki_sentence = remove_html_and_cloze_tags(sentence)
    normalized_anki_sentence = normalize_text_for_comparison(anki_sentence)
    expression = ""
    word_field = getattr(anki_config, "word_field", "")
    if word_field:
        try:
            expression = remove_html_and_cloze_tags(last_note.get_field(word_field))
        except (KeyError, TypeError, ValueError):
            # Some note types intentionally omit the configured word field. Matching the
            # sentence still provides the same fallback behavior as before.
            expression = ""
    normalized_expression = normalize_text_for_comparison(expression)
    time_window = datetime.now() - timedelta(seconds=gsm_state.replay_buffer_length) - timedelta(seconds=5)

    # Collect every valid candidate before ranking. A short recycled fragment
    # (e.g. "性質を……入れ替える？") can be contained in a longer mined sentence,
    # while an NVL sentence can legitimately contain several sequential events.
    candidates = []
    for line in reversed(lines):
        if line.time < time_window:
            # Authoritative stream order is independent of capture time. A slow
            # source can legitimately append an older media timestamp after a newer
            # line, so never assume the remaining list is timestamp-sorted.
            continue
        if lines_match(line.text, anki_sentence):
            candidates.append(line)

    # The clicked expression is the strongest discriminator in an NVL block. Only
    # enforce it when it occurs literally in the Anki sentence and at least one
    # candidate, so dictionary-form expressions do not discard a valid inflected line.
    if normalized_expression and normalized_expression in normalized_anki_sentence:
        expression_candidates = [
            line for line in candidates if normalized_expression in normalize_text_for_comparison(line.text)
        ]
        if expression_candidates:
            candidates = expression_candidates

    if prefer_recent and candidates:
        return candidates[0]

    best_line = None
    best_score = -1.0
    for line in candidates:
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
    line = get_matching_line(last_note, lines=None)
    _freeze_authoritative_line(line)
    return line


def get_mined_line(last_note: AnkiCard, lines=None, *, prefer_recent: bool = False) -> GameLine:
    """
    Legacy wrapper for get_matching_line with original behavior.
    Uses stripped text comparison and accepts custom lines.
    """
    line = get_matching_line(last_note, lines=lines, prefer_recent=prefer_recent)
    _freeze_authoritative_line(line)
    return line


def _freeze_authoritative_line(line: GameLine) -> None:
    try:
        from GameSentenceMiner.gametext import freeze_authoritative_text_line

        freeze_authoritative_text_line(line.id)
    except Exception as error:
        logger.debug(f"Unable to freeze authoritative text line {line.id}: {error}")


def get_time_of_line(line):
    return game_log.get_time(line)


def get_all_lines():
    return list(game_log.snapshot())


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
