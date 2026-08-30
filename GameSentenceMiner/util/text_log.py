import threading
import unicodedata
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from html.parser import HTMLParser
from typing import Optional

import rapidfuzz

from GameSentenceMiner.util.config.configuration import get_config, gsm_state, logger
from GameSentenceMiner.util.gsm_utils import remove_html_and_cloze_tags
from GameSentenceMiner.util.models.model import AnkiCard

initial_time = datetime.now()
MAX_IN_MEMORY_GAME_LINES = 10_000
MAX_PREVIOUS_LINES = 10_000


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

    def __init__(self, max_lines: int = MAX_IN_MEMORY_GAME_LINES):
        self.values = []
        self.values_dict = {}
        self.previous_lines = set()
        self._previous_line_order = deque()
        self.game_line_index = 0
        self.max_lines = max(1, int(max_lines))
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
                    self._remember_previous_line_locked(normalized_previous_line)
            self._prune_to_limit_locked()
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
                        self._remember_previous_line_locked(normalized)
            self._prune_to_limit_locked()
            return line

    def remove_by_id(self, line_id: str) -> GameLine | None:
        """Remove one projected line and detach it from the compatibility chain."""
        with self._lock:
            line = self.values_dict.pop(line_id, None)
            if line is None:
                return None
            try:
                self.values.remove(line)
            except ValueError:
                pass
            if line.prev is not None:
                line.prev.next = line.next
            if line.next is not None:
                line.next.prev = line.prev
            line.prev = None
            line.next = None
            return line

    def replace_previous_lines(self, lines) -> None:
        """Replace the recycle cache while retaining only the newest bounded entries."""
        with self._lock:
            self.previous_lines = set()
            self._previous_line_order = deque()
            for line in lines:
                self._remember_previous_line_locked(str(line))

    def clear_previous_lines(self) -> None:
        self.replace_previous_lines(())

    def _remember_previous_line_locked(self, line: str) -> None:
        if not line or line in self.previous_lines:
            return
        self.previous_lines.add(line)
        self._previous_line_order.append(line)
        while len(self._previous_line_order) > MAX_PREVIOUS_LINES:
            self.previous_lines.discard(self._previous_line_order.popleft())

    def _prune_to_limit_locked(self) -> None:
        remove_count = len(self.values) - self.max_lines
        if remove_count <= 0:
            return
        if self.max_lines >= 1_000:
            remove_count += self.max_lines // 10
        removed = self.values[:remove_count]
        del self.values[:remove_count]
        for line in removed:
            if self.values_dict.get(line.id) is line:
                self.values_dict.pop(line.id, None)
            line.prev = None
            line.next = None
        if self.values:
            self.values[0].prev = None

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
HIGHLIGHT_CONTEXT_MIN_SCORE = 80


class _HighlightedTextParser(HTMLParser):
    """Collect plain Anki text and the exact spans wrapped in bold tags."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.length = 0
        self.bold_depth = 0
        self.bold_start = None
        self.bold_spans = []

    def handle_starttag(self, tag, attrs):
        if tag.casefold() not in {"b", "strong"}:
            return
        if self.bold_depth == 0:
            self.bold_start = self.length
        self.bold_depth += 1

    def handle_endtag(self, tag):
        if tag.casefold() not in {"b", "strong"} or self.bold_depth == 0:
            return
        self.bold_depth -= 1
        if self.bold_depth == 0 and self.bold_start is not None:
            self.bold_spans.append((self.bold_start, self.length))
            self.bold_start = None

    def handle_data(self, data):
        self.parts.append(data)
        self.length += len(data)


def _find_term_spans(text: str, term: str) -> list[tuple[int, int]]:
    if not text or not term:
        return []
    spans = []
    start = 0
    while True:
        index = text.find(term, start)
        if index < 0:
            return spans
        spans.append((index, index + len(term)))
        start = index + max(1, len(term))


def _get_mined_expression_spans(
    sentence_html: str,
    expression: str,
) -> tuple[str, list[tuple[int, int]], bool]:
    """Return normalized sentence text and the mined expression's exact occurrence.

    Yomitan marks the clicked expression with ``<b>``. That occurrence is more
    reliable than looking for the same word anywhere in a combined NVL block. If
    bold markup is unavailable, fall back to every occurrence of the word field.
    """
    parser = _HighlightedTextParser()
    parser.feed(str(sentence_html or ""))
    parser.close()
    plain_sentence = "".join(parser.parts)
    normalized_sentence = normalize_text_for_comparison(plain_sentence)

    highlighted_spans = []
    for raw_start, raw_end in parser.bold_spans:
        normalized_start = len(normalize_text_for_comparison(plain_sentence[:raw_start]))
        normalized_end = len(normalize_text_for_comparison(plain_sentence[:raw_end]))
        if normalized_end > normalized_start:
            highlighted_spans.append((normalized_start, normalized_end))
    if highlighted_spans:
        return normalized_sentence, highlighted_spans, True

    normalized_expression = normalize_text_for_comparison(expression)
    return normalized_sentence, _find_term_spans(normalized_sentence, normalized_expression), False


def _highlight_context_score(
    line_text: str,
    normalized_sentence: str,
    expression_spans: list[tuple[int, int]],
) -> float:
    """Score a line aligned around the exact expression occurrence in Anki.

    Anchoring the comparison at the bold word isolates the relevant portion of a
    combined NVL block without using ``partial_ratio``. It also tolerates OCR/text
    hook substitutions such as ``Mystic Eyes`` versus ``魔眼``.
    """
    normalized_line = normalize_text_for_comparison(line_text)
    if not normalized_line or not normalized_sentence:
        return 0.0

    best_score = 0.0
    for sentence_start, sentence_end in expression_spans:
        expression = normalized_sentence[sentence_start:sentence_end]
        for line_start, _line_end in _find_term_spans(normalized_line, expression):
            aligned_sentence_start = sentence_start - line_start
            compared_line_start = max(0, -aligned_sentence_start)
            compared_sentence_start = max(0, aligned_sentence_start)
            compared_line = normalized_line[compared_line_start:]
            compared_sentence = normalized_sentence[
                compared_sentence_start : compared_sentence_start + len(compared_line)
            ]
            if min(len(compared_line), len(compared_sentence)) < max(CONTAINMENT_MIN_CHARS, len(expression)):
                continue
            best_score = max(best_score, rapidfuzz.fuzz.ratio(compared_line, compared_sentence))
    return best_score


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
        prefer_recent: Prefer the newest valid match before applying expression or
            text-similarity ranking. Overlay mines use this because an NVL block can
            contain several recent text events and older dialogue remains on screen.

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
    normalized_context_sentence, mined_expression_spans, has_bold_expression = _get_mined_expression_spans(
        sentence,
        expression,
    )
    time_window = datetime.now() - timedelta(seconds=gsm_state.replay_buffer_length) - timedelta(seconds=5)

    # Collect every valid candidate before ranking. A short recycled fragment
    # (e.g. "性質を……入れ替える？") can be contained in a longer mined sentence,
    # while an NVL sentence can legitimately contain several sequential events.
    candidates = []
    expression_context_candidates = []
    expression_context_scores = {}
    for line in reversed(lines):
        if line.time < time_window:
            # Authoritative stream order is independent of capture time. A slow
            # source can legitimately append an older media timestamp after a newer
            # line, so never assume the remaining list is timestamp-sorted.
            continue
        if lines_match(line.text, anki_sentence):
            candidates.append(line)
        context_score = _highlight_context_score(
            line.text,
            normalized_context_sentence,
            mined_expression_spans,
        )
        if context_score >= HIGHLIGHT_CONTEXT_MIN_SCORE:
            expression_context_candidates.append(line)
            expression_context_scores[line.id] = context_score

    # Overlay scans of NVL games often put every visible line into the Anki sentence.
    # First isolate lines fitting the exact bold expression occurrence, including
    # OCR/text-hook variants that fail the whole-block similarity threshold. Within
    # that strong match class stream recency is decisive. Only then fall back to the
    # newest ordinary sentence match.
    if prefer_recent:
        if has_bold_expression and expression_context_candidates:
            return expression_context_candidates[0]
        if candidates:
            return candidates[0]
        if expression_context_candidates:
            return expression_context_candidates[0]

    # Outside overlay mode, the bold word and its surrounding text remain the
    # strongest discriminator. This also admits a context-aligned candidate that
    # could not match an entire combined NVL block on its own.
    if has_bold_expression and expression_context_candidates:
        candidates = expression_context_candidates

    # For normal mining, the clicked expression is the strongest discriminator. Only
    # enforce it when it occurs literally in the Anki sentence and at least one
    # candidate, so dictionary-form expressions do not discard a valid inflected line.
    if normalized_expression and normalized_expression in normalized_anki_sentence:
        expression_candidates = [
            line for line in candidates if normalized_expression in normalize_text_for_comparison(line.text)
        ]
        if expression_candidates:
            candidates = expression_candidates

    best_line = None
    best_score = -1.0
    for line in candidates:
        score = expression_context_scores.get(line.id, _match_score(line.text, anki_sentence))
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
