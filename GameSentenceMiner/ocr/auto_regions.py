"""Experimental per-scene OCR region learning.

The learner intentionally stays independent from capture and OCR engine code. It
accepts normalized line observations, accumulates bounded spatial evidence, and
returns the line indexes that are safe to feed into the normal OCR pipeline.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import time
import unicodedata
from collections import Counter, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Hashable, Iterable, Sequence

logger = logging.getLogger(__name__)

AUTO_REGION_SCHEMA_VERSION = 1
GRID_COLUMNS = 12
GRID_ROWS = 8
MIN_OBSERVATIONS = 3
MIN_DISTINCT_TEXTS = 2
MIN_TARGET_CHARACTERS = 2
MIN_CONFIRMED_LINE_CHARACTERS = 6
STRONG_CANDIDATE_CHARACTERS = 8
STRONG_CANDIDATE_DOMINANCE = 2.0
STATIC_REPEAT_LIMIT = 5
HINT_MISS_LIMIT = 30
MAX_ACTIVE_REGIONS = 6
MAX_DISTINCT_HASHES_PER_CELL = 32
DISCOVERY_INTERVAL_SECONDS = 5.0
ASPECT_RATIO_TOLERANCE = 0.05
REGION_MERGE_GAP = 0.03
TEXT_BLOCK_VERTICAL_GAP = 0.06
LORE_MIN_LINES = 4
LORE_MIN_TOTAL_CHARACTERS = 32
LORE_MIN_LINE_CHARACTERS = 6
LORE_MIN_BLOCK_WIDTH = 0.2
LORE_MAX_BOTTOM_WITHOUT_DIALOGUE = 0.78
MENU_MIN_REPEATED_FRAMES = 3
MENU_MIN_LINES = 3
MENU_MIN_LINE_CHARACTERS = 2
MENU_MAX_LINE_CHARACTERS = 14
RECENT_MENU_OBSERVATION_WINDOW = 3
THRASH_WINDOW_SECONDS = 8.0
THRASH_MAX_RECENT_FRAMES = 10
THRASH_MIN_FRAMES = 5
THRASH_MIN_DISTINCT_SIGNATURES = 2
THRASH_MIN_LARGE_REGION_AREA = 0.18
THRASH_MIN_DENSE_LINE_COUNT = 6
THRASH_MIN_DENSE_CHARACTERS = 48
THRASH_MIN_CHARACTER_SPREAD = 24
THRASH_MIN_ANCHORS = 3
THRASH_MIN_ANCHOR_FRAMES = 3
THRASH_RELEASE_MISSES = 2


def _clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return max(minimum, min(maximum, float(value)))


@dataclass(frozen=True)
class NormalizedRect:
    """A clamped ``x, y, width, height`` rectangle in normalized source space."""

    x: float
    y: float
    width: float
    height: float

    def __post_init__(self):
        x = _clamp(self.x)
        y = _clamp(self.y)
        width = _clamp(self.width, 0.0, 1.0 - x)
        height = _clamp(self.height, 0.0, 1.0 - y)
        object.__setattr__(self, "x", x)
        object.__setattr__(self, "y", y)
        object.__setattr__(self, "width", width)
        object.__setattr__(self, "height", height)

    @classmethod
    def from_xyxy(cls, x1: float, y1: float, x2: float, y2: float) -> "NormalizedRect":
        left = min(float(x1), float(x2))
        top = min(float(y1), float(y2))
        right = max(float(x1), float(x2))
        bottom = max(float(y1), float(y2))
        return cls(left, top, right - left, bottom - top)

    @classmethod
    def from_sequence(cls, values: Sequence[float]) -> "NormalizedRect":
        if len(values) < 4:
            raise ValueError("A normalized rectangle requires four values")
        return cls(float(values[0]), float(values[1]), float(values[2]), float(values[3]))

    @property
    def right(self) -> float:
        return self.x + self.width

    @property
    def bottom(self) -> float:
        return self.y + self.height

    @property
    def center(self) -> tuple[float, float]:
        return self.x + self.width / 2.0, self.y + self.height / 2.0

    @property
    def area(self) -> float:
        return self.width * self.height

    def contains_point(self, x: float, y: float) -> bool:
        return self.x <= x <= self.right and self.y <= y <= self.bottom

    def contains_center_of(self, other: "NormalizedRect") -> bool:
        return self.contains_point(*other.center)

    def overlaps(self, other: "NormalizedRect") -> bool:
        return self.x < other.right and self.right > other.x and self.y < other.bottom and self.bottom > other.y

    def expanded(self, gap: float) -> "NormalizedRect":
        return NormalizedRect.from_xyxy(self.x - gap, self.y - gap, self.right + gap, self.bottom + gap)

    def union(self, other: "NormalizedRect") -> "NormalizedRect":
        return NormalizedRect.from_xyxy(
            min(self.x, other.x),
            min(self.y, other.y),
            max(self.right, other.right),
            max(self.bottom, other.bottom),
        )

    def padded(self) -> "NormalizedRect":
        padding = max(0.015, self.height * 0.35)
        return self.expanded(padding)

    def to_list(self) -> list[float]:
        return [self.x, self.y, self.width, self.height]


@dataclass(frozen=True)
class LineObservation:
    text: str
    rect: NormalizedRect


@dataclass(frozen=True)
class AutoRegionDecision:
    accepted_indexes: list[int]
    phase: str
    vetoed: bool = False
    suppressed_reason: str | None = None


@dataclass(frozen=True)
class AutoRegionRecommendation:
    id: str
    kind: str
    reason: str
    confidence: float
    line_count: int
    rect: NormalizedRect = field(repr=False, compare=False)

    def to_status(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "reason": self.reason,
            "confidence": round(_clamp(self.confidence), 3),
            "line_count": self.line_count,
        }


@dataclass
class _CellEvidence:
    rect: NormalizedRect
    observation_count: int = 0
    frame_count: int = 0
    last_frame_id: Hashable | None = None
    distinct_hashes: set[str] = field(default_factory=set)
    text_counts: Counter = field(default_factory=Counter)
    hinted_observations: int = 0
    max_target_characters: int = 0

    def add(
        self,
        observation: LineObservation,
        frame_id: Hashable,
        text_hash: str,
        hinted: bool,
        target_characters: int,
    ) -> None:
        self.rect = self.rect.union(observation.rect)
        self.observation_count += 1
        if frame_id != self.last_frame_id:
            self.frame_count += 1
            self.last_frame_id = frame_id
        if len(self.distinct_hashes) < MAX_DISTINCT_HASHES_PER_CELL or text_hash in self.distinct_hashes:
            self.distinct_hashes.add(text_hash)
            self.text_counts[text_hash] += 1
        if hinted:
            self.hinted_observations += 1
        self.max_target_characters = max(self.max_target_characters, int(target_characters))

    @property
    def max_repeat_count(self) -> int:
        return max(self.text_counts.values(), default=0)

    @property
    def confirmed(self) -> bool:
        return (
            self.frame_count >= MIN_OBSERVATIONS
            and len(self.distinct_hashes) >= MIN_DISTINCT_TEXTS
            and self.max_target_characters >= MIN_CONFIRMED_LINE_CHARACTERS
        )

    @property
    def confidence(self) -> float:
        repeat_penalty = max(0, self.max_repeat_count - STATIC_REPEAT_LIMIT)
        raw = self.frame_count + 2 * len(self.distinct_hashes) + self.hinted_observations - repeat_penalty
        return _clamp(raw / 12.0)


@dataclass
class _HintState:
    rect: NormalizedRect
    misses: int = 0
    text_hashes: set[str] = field(default_factory=set)
    active: bool = True


@dataclass
class _RecurringUiEvidence:
    rect: NormalizedRect
    text_hash: str
    frame_count: int = 0
    last_frame_id: Hashable | None = None
    last_observation: int = 0
    target_characters: int = 0

    def add(
        self,
        rect: NormalizedRect,
        *,
        frame_id: Hashable,
        observation_number: int,
        target_characters: int,
    ) -> None:
        self.rect = self.rect.union(rect)
        if frame_id != self.last_frame_id:
            self.frame_count += 1
            self.last_frame_id = frame_id
        self.last_observation = observation_number
        self.target_characters = max(self.target_characters, int(target_characters))


@dataclass(frozen=True)
class _RecentAutoFrame:
    observed_at: float
    signature: str
    target_characters: int
    line_count: int
    short_line_keys: frozenset[tuple[int, int, str]]


def _hash_text(text: str) -> str:
    normalized = "".join(char for char in str(text or "").casefold() if char.isalnum())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def target_character_count(text: str, language: str) -> int:
    """Count characters belonging to the configured OCR language/script."""

    language = str(language or "").lower().split("-")[0]
    count = 0
    for char in str(text or ""):
        code = ord(char)
        name = unicodedata.name(char, "")
        if language == "ja":
            matches = 0x3040 <= code <= 0x30FF or 0x3400 <= code <= 0x9FFF or 0xFF66 <= code <= 0xFF9D
        elif language == "zh":
            matches = 0x3400 <= code <= 0x9FFF
        elif language == "ko":
            matches = 0x1100 <= code <= 0x11FF or 0x3130 <= code <= 0x318F or 0xAC00 <= code <= 0xD7AF
        elif language == "ru":
            matches = "CYRILLIC" in name
        elif language == "ar":
            matches = "ARABIC" in name
        elif language == "hi":
            matches = "DEVANAGARI" in name
        else:
            matches = char.isalpha()
        if matches:
            count += 1
    return count


def _horizontal_affinity(first: NormalizedRect, second: NormalizedRect) -> bool:
    overlap = max(0.0, min(first.right, second.right) - max(first.x, second.x))
    minimum_width = max(0.01, min(first.width, second.width))
    return overlap >= minimum_width * 0.2 or abs(first.center[0] - second.center[0]) <= 0.18


def _vertical_gap(first: NormalizedRect, second: NormalizedRect) -> float:
    if first.overlaps(second):
        return 0.0
    return max(0.0, max(first.y, second.y) - min(first.bottom, second.bottom))


def _cluster_spatial_items(items, rect_getter) -> list[list]:
    """Group vertically adjacent, horizontally aligned OCR lines."""

    remaining = set(range(len(items)))
    groups = []
    while remaining:
        seed = remaining.pop()
        indexes = [seed]
        pending = [seed]
        while pending:
            current_index = pending.pop()
            current_rect = rect_getter(items[current_index])
            neighbors = []
            for candidate_index in remaining:
                candidate_rect = rect_getter(items[candidate_index])
                if _vertical_gap(current_rect, candidate_rect) <= TEXT_BLOCK_VERTICAL_GAP and _horizontal_affinity(
                    current_rect, candidate_rect
                ):
                    neighbors.append(candidate_index)
            for neighbor in neighbors:
                remaining.remove(neighbor)
                indexes.append(neighbor)
                pending.append(neighbor)
        groups.append([items[index] for index in indexes])
    return groups


def _union_rectangles(rectangles: Iterable[NormalizedRect]) -> NormalizedRect | None:
    iterator = iter(rectangles)
    try:
        result = next(iterator)
    except StopIteration:
        return None
    for rectangle in iterator:
        result = result.union(rectangle)
    return result


def _recommendation_id(kind: str, rect: NormalizedRect) -> str:
    quantized = [round(value * 20) for value in rect.to_list()]
    return f"{kind}:{':'.join(str(value) for value in quantized)}"


def _spatial_text_key(observation: LineObservation) -> tuple[int, int, str]:
    center_x, center_y = observation.rect.center
    return round(center_x * 24), round(center_y * 18), _hash_text(observation.text)


def _merge_rectangles(rectangles: Iterable[tuple[NormalizedRect, float]]) -> list[tuple[NormalizedRect, float]]:
    merged: list[tuple[NormalizedRect, float]] = []
    for rect, confidence in sorted(rectangles, key=lambda item: item[1], reverse=True):
        for index, (existing, existing_confidence) in enumerate(merged):
            if existing.expanded(REGION_MERGE_GAP).overlaps(rect.expanded(REGION_MERGE_GAP)):
                merged[index] = (existing.union(rect), max(confidence, existing_confidence))
                break
        else:
            merged.append((rect, confidence))
    return merged[:MAX_ACTIVE_REGIONS]


class AutoRegionManager:
    """Accumulates and persists likely automatic OCR regions for one scene."""

    def __init__(
        self,
        scene: str,
        language: str,
        state_path: str | Path,
        *,
        aspect_ratio: float | None = None,
        primary_hints: Sequence[NormalizedRect] | None = None,
        secondary_regions: Sequence[NormalizedRect] | None = None,
        black_holes: Sequence[NormalizedRect] | None = None,
        supported: bool = True,
    ):
        self.scene = str(scene or "Default")
        self.language = str(language or "ja")
        self.state_path = Path(state_path)
        self.aspect_ratio = float(aspect_ratio) if aspect_ratio else None
        self.supported = bool(supported)
        self._hints = [_HintState(rect) for rect in (primary_hints or [])]
        self.secondary_regions = list(secondary_regions or [])
        self.black_holes = list(black_holes or [])
        self._cells: dict[tuple[int, int], _CellEvidence] = {}
        self._learned: list[tuple[NormalizedRect, float]] = []
        self._recurring_ui: dict[tuple[int, int, str], _RecurringUiEvidence] = {}
        self._recommendations: dict[str, AutoRegionRecommendation] = {}
        self._recent_auto_frames: deque[_RecentAutoFrame] = deque(maxlen=THRASH_MAX_RECENT_FRAMES)
        self._thrash_anchor_rects: dict[tuple[int, int, str], NormalizedRect] = {}
        self._thrash_anchor_keys: set[tuple[int, int, str]] = set()
        self._thrash_release_misses = 0
        self._thrashing = False
        self.observation_count = 0
        self.last_discovery_monotonic = 0.0
        self._last_saved_monotonic = 0.0
        self._dirty = False
        self._load()

    @property
    def phase(self) -> str:
        if not self.supported:
            return "unsupported"
        return "active" if self._learned else "learning"

    @property
    def learned_regions(self) -> list[NormalizedRect]:
        return [rect for rect, _confidence in self._learned]

    @property
    def effective_regions(self) -> list[NormalizedRect]:
        regions = [hint.rect for hint in self._hints if hint.active]
        regions.extend(self.learned_regions)
        return [rect for rect, _confidence in _merge_rectangles((rect, 1.0) for rect in regions)]

    @property
    def confidence(self) -> float:
        return max((confidence for _rect, confidence in self._learned), default=0.0)

    def status(self) -> dict:
        return {
            "enabled": True,
            "supported": self.supported,
            "phase": self.phase,
            "learned_region_count": len(self._learned),
            "confidence": round(self.confidence, 3),
            "thrashing": self._thrashing,
            "recommendations": [
                recommendation.to_status()
                for recommendation in sorted(self._recommendations.values(), key=lambda item: item.kind)
            ],
        }

    def should_discover(self, now: float | None = None) -> bool:
        if not self.supported:
            return False
        now = time.monotonic() if now is None else float(now)
        if not self.effective_regions:
            return True
        return now - self.last_discovery_monotonic >= DISCOVERY_INTERVAL_SECONDS

    def mark_discovery(self, now: float | None = None) -> None:
        self.last_discovery_monotonic = time.monotonic() if now is None else float(now)

    def observe(
        self,
        observations: Sequence[LineObservation],
        *,
        frame_id: Hashable,
        discovery: bool,
    ) -> AutoRegionDecision:
        if not self.supported:
            return AutoRegionDecision([], self.phase)

        valid = [
            (index, observation, target_character_count(observation.text, self.language))
            for index, observation in enumerate(observations)
            if target_character_count(observation.text, self.language) >= MIN_TARGET_CHARACTERS
        ]

        if any(
            black_hole.overlaps(observation.rect)
            for _index, observation, _char_count in valid
            for black_hole in self.black_holes
        ):
            return AutoRegionDecision([], self.phase, vetoed=True)

        valid = [
            item
            for item in valid
            if not any(region.contains_center_of(item[1].rect) for region in self.secondary_regions)
        ]

        suppress_unstable_large_text = self._observe_large_region_thrashing(valid)

        if discovery:
            self.observation_count += 1
            self.mark_discovery()
            if not suppress_unstable_large_text:
                self._update_recurring_ui(valid, frame_id)
                self._refresh_recommendations(valid)
                learning_valid = [
                    item
                    for item in valid
                    if not any(
                        recommendation.rect.contains_center_of(item[1].rect)
                        for recommendation in self._recommendations.values()
                    )
                ]
                self._update_hints(valid)
                for _index, observation, char_count in learning_valid:
                    center_x, center_y = observation.rect.center
                    cell_key = (
                        min(GRID_COLUMNS - 1, int(center_x * GRID_COLUMNS)),
                        min(GRID_ROWS - 1, int(center_y * GRID_ROWS)),
                    )
                    text_hash = _hash_text(observation.text)
                    hinted = any(hint.active and hint.rect.contains_center_of(observation.rect) for hint in self._hints)
                    evidence = self._cells.setdefault(cell_key, _CellEvidence(observation.rect))
                    evidence.add(observation, frame_id, text_hash, hinted, char_count)
                self._refresh_regions()
                self._dirty = True

        if suppress_unstable_large_text:
            return AutoRegionDecision([], self.phase, suppressed_reason="unstable_large_text")

        valid = [
            item
            for item in valid
            if not any(
                recommendation.rect.contains_center_of(item[1].rect)
                for recommendation in self._recommendations.values()
            )
        ]

        accepted = [
            index
            for index, observation, _char_count in valid
            if any(region.contains_center_of(observation.rect) for region in self.effective_regions)
        ]
        if not accepted:
            tentative = self._strong_candidate(valid)
            if tentative is not None:
                accepted = [tentative]
        return AutoRegionDecision(sorted(set(accepted)), self.phase)

    def save(self) -> None:
        if not self._dirty and self.state_path.exists():
            return
        payload = {
            "schema_version": AUTO_REGION_SCHEMA_VERSION,
            "scene": self.scene,
            "aspect_ratio": self.aspect_ratio,
            "regions": [
                {
                    "rect": rect.to_list(),
                    "confidence": round(confidence, 6),
                }
                for rect, confidence in self._learned
            ],
        }
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(
            prefix=f".{self.state_path.name}.",
            suffix=".tmp",
            dir=str(self.state_path.parent),
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                json.dump(payload, file, indent=2, ensure_ascii=False)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temp_name, self.state_path)
            self._dirty = False
            self._last_saved_monotonic = time.monotonic()
        finally:
            try:
                if os.path.exists(temp_name):
                    os.unlink(temp_name)
            except OSError:
                pass

    def save_if_due(self, now: float | None = None, interval_seconds: float = 2.0) -> None:
        now = time.monotonic() if now is None else float(now)
        if self._dirty and now - self._last_saved_monotonic >= interval_seconds:
            self.save()

    def reset(self) -> None:
        self._cells.clear()
        self._learned.clear()
        self._recurring_ui.clear()
        self._recommendations.clear()
        self._recent_auto_frames.clear()
        self._thrash_anchor_rects.clear()
        self._thrash_anchor_keys.clear()
        self._thrash_release_misses = 0
        self._thrashing = False
        self.observation_count = 0
        self._dirty = False
        for hint in self._hints:
            hint.active = True
            hint.misses = 0
            hint.text_hashes.clear()
        try:
            self.state_path.unlink(missing_ok=True)
        except OSError as exc:
            logger.warning("Failed to remove auto OCR region state %s: %s", self.state_path, exc)

    def _update_hints(self, valid) -> None:
        for hint in self._hints:
            if not hint.active:
                continue
            inside_hashes = {
                _hash_text(observation.text)
                for _index, observation, _char_count in valid
                if hint.rect.contains_center_of(observation.rect)
            }
            novel = inside_hashes - hint.text_hashes
            hint.text_hashes.update(inside_hashes)
            if novel:
                hint.misses = 0
            else:
                hint.misses += 1

        if self._learned:
            for hint in self._hints:
                if hint.misses >= HINT_MISS_LIMIT:
                    hint.active = False

    def _refresh_regions(self) -> None:
        confirmed = [
            (evidence.rect.padded(), evidence.confidence) for evidence in self._cells.values() if evidence.confirmed
        ]
        # Keep regions loaded from disk while fresh evidence accumulates. Without
        # this, the first discovery frame after restart would erase the saved map
        # because its new cells have not reached the confirmation threshold yet.
        self._learned = _merge_rectangles([*self._learned, *confirmed])

    def _outside_effective_regions(self, rect: NormalizedRect) -> bool:
        return not any(region.contains_center_of(rect) for region in self.effective_regions)

    def _update_recurring_ui(self, valid, frame_id: Hashable) -> None:
        for _index, observation, char_count in valid:
            if not MENU_MIN_LINE_CHARACTERS <= char_count <= MENU_MAX_LINE_CHARACTERS:
                continue
            if not self._outside_effective_regions(observation.rect):
                continue
            text_hash = _hash_text(observation.text)
            spatial_x, spatial_y, _text_hash = _spatial_text_key(observation)
            key = (spatial_x, spatial_y, text_hash)
            evidence = self._recurring_ui.setdefault(
                key,
                _RecurringUiEvidence(observation.rect, text_hash),
            )
            evidence.add(
                observation.rect,
                frame_id=frame_id,
                observation_number=self.observation_count,
                target_characters=char_count,
            )

    def _observe_large_region_thrashing(self, valid) -> bool:
        """Detect hallucination churn inside a large learned region.

        A static menu often has several small labels which remain stable while
        OCR alternates between radically different readings of a dense text
        block. Once that pattern is established, frames containing those anchor
        labels are muted until the anchors disappear for a short grace period.
        """

        large_regions = [region for region in self.learned_regions if region.area >= THRASH_MIN_LARGE_REGION_AREA]
        if not large_regions:
            return False

        region_items = max(
            ([item for item in valid if region.contains_center_of(item[1].rect)] for region in large_regions),
            key=lambda items: sum(item[2] for item in items),
            default=[],
        )
        short_line_keys = frozenset(
            _spatial_text_key(observation)
            for _index, observation, char_count in region_items
            if MENU_MIN_LINE_CHARACTERS <= char_count <= MENU_MAX_LINE_CHARACTERS
        )
        for _index, observation, char_count in region_items:
            if MENU_MIN_LINE_CHARACTERS <= char_count <= MENU_MAX_LINE_CHARACTERS:
                self._thrash_anchor_rects[_spatial_text_key(observation)] = observation.rect

        signature_parts = [
            f"{key[0]}:{key[1]}:{key[2]}" for key in sorted(_spatial_text_key(item[1]) for item in region_items)
        ]
        signature = hashlib.sha256("|".join(signature_parts).encode("utf-8")).hexdigest()
        now = time.monotonic()
        self._recent_auto_frames.append(
            _RecentAutoFrame(
                observed_at=now,
                signature=signature,
                target_characters=sum(item[2] for item in region_items),
                line_count=len(region_items),
                short_line_keys=short_line_keys,
            )
        )
        while self._recent_auto_frames and now - self._recent_auto_frames[0].observed_at > THRASH_WINDOW_SECONDS:
            self._recent_auto_frames.popleft()

        if self._thrashing:
            if short_line_keys & self._thrash_anchor_keys:
                self._thrash_release_misses = 0
                return True
            self._thrash_release_misses += 1
            if self._thrash_release_misses < THRASH_RELEASE_MISSES:
                return True
            self._thrashing = False
            self._thrash_release_misses = 0
            self._thrash_anchor_keys.clear()
            self._recent_auto_frames.clear()
            return False

        frames = list(self._recent_auto_frames)
        if len(frames) < THRASH_MIN_FRAMES:
            return False
        if len({frame.signature for frame in frames}) < THRASH_MIN_DISTINCT_SIGNATURES:
            return False
        character_counts = [frame.target_characters for frame in frames]
        if max(character_counts, default=0) < THRASH_MIN_DENSE_CHARACTERS:
            return False
        if max(character_counts, default=0) - min(character_counts, default=0) < THRASH_MIN_CHARACTER_SPREAD:
            return False
        if max((frame.line_count for frame in frames), default=0) < THRASH_MIN_DENSE_LINE_COUNT:
            return False

        anchor_counts = Counter(key for frame in frames for key in frame.short_line_keys)
        stable_anchors = {key for key, count in anchor_counts.items() if count >= THRASH_MIN_ANCHOR_FRAMES}
        if len(stable_anchors) < THRASH_MIN_ANCHORS or not (short_line_keys & stable_anchors):
            return False

        self._thrashing = True
        self._thrash_anchor_keys = stable_anchors
        self._thrash_release_misses = 0
        best_anchor = max(
            stable_anchors,
            key=lambda key: (
                anchor_counts[key],
                -self._thrash_anchor_rects.get(key, NormalizedRect(0, 0, 1, 1)).area,
            ),
        )
        anchor_rect = self._thrash_anchor_rects[best_anchor]
        self._recommendations["black_hole"] = AutoRegionRecommendation(
            id=_recommendation_id("black_hole", anchor_rect),
            kind="black_hole",
            reason="unstable_large_text",
            confidence=_clamp(0.7 + 0.05 * len(stable_anchors)),
            line_count=len(stable_anchors),
            rect=anchor_rect.padded(),
        )
        logger.warning(
            "Suppressing unstable OCR text in a large learned region; "
            "a black-hole area over a persistent menu label is recommended."
        )
        return True

    def _refresh_recommendations(self, valid) -> None:
        if "secondary" not in self._recommendations:
            lore = self._find_lore_recommendation(valid)
            if lore is not None:
                self._recommendations[lore.kind] = lore

        if "black_hole" not in self._recommendations:
            menu = self._find_menu_recommendation()
            if menu is not None and not any(
                recommendation.rect.overlaps(menu.rect) for recommendation in self._recommendations.values()
            ):
                self._recommendations[menu.kind] = menu

    def _find_lore_recommendation(self, valid) -> AutoRegionRecommendation | None:
        candidates = [
            item
            for item in valid
            if item[2] >= LORE_MIN_LINE_CHARACTERS and self._outside_effective_regions(item[1].rect)
        ]
        dialogue_regions = self.effective_regions
        dialogue_anchor = max(dialogue_regions, key=lambda rect: rect.center[1], default=None)
        ranked = []
        for group in _cluster_spatial_items(candidates, lambda item: item[1].rect):
            if len(group) < LORE_MIN_LINES:
                continue
            total_characters = sum(item[2] for item in group)
            if total_characters < LORE_MIN_TOTAL_CHARACTERS:
                continue
            rect = _union_rectangles(item[1].rect for item in group)
            if rect is None or rect.width < LORE_MIN_BLOCK_WIDTH:
                continue
            if dialogue_anchor is not None:
                if rect.center[1] >= dialogue_anchor.center[1] - 0.08:
                    continue
            elif rect.bottom > LORE_MAX_BOTTOM_WITHOUT_DIALOGUE:
                continue
            ranked.append((total_characters, len(group), rect))

        if not ranked:
            return None
        total_characters, line_count, rect = max(ranked, key=lambda item: (item[0], item[1]))
        confidence = _clamp(total_characters / 48.0 + line_count / 8.0)
        return AutoRegionRecommendation(
            id=_recommendation_id("secondary", rect),
            kind="secondary",
            reason="dense_text",
            confidence=confidence,
            line_count=line_count,
            rect=rect.padded(),
        )

    def _find_menu_recommendation(self) -> AutoRegionRecommendation | None:
        repeated = [
            evidence
            for evidence in self._recurring_ui.values()
            if evidence.frame_count >= MENU_MIN_REPEATED_FRAMES
            and self.observation_count - evidence.last_observation <= RECENT_MENU_OBSERVATION_WINDOW
            and self._outside_effective_regions(evidence.rect)
        ]
        ranked = []
        for group in _cluster_spatial_items(repeated, lambda item: item.rect):
            distinct_texts = {item.text_hash for item in group}
            if len(group) < MENU_MIN_LINES or len(distinct_texts) < MENU_MIN_LINES:
                continue
            rect = _union_rectangles(item.rect for item in group)
            if rect is None or rect.height < 0.1:
                continue
            repeat_strength = min(item.frame_count for item in group)
            ranked.append((len(group), repeat_strength, rect))

        if not ranked:
            return None
        line_count, repeat_strength, rect = max(ranked, key=lambda item: (item[0], item[1]))
        confidence = _clamp(0.45 + 0.1 * line_count + 0.05 * (repeat_strength - MENU_MIN_REPEATED_FRAMES))
        return AutoRegionRecommendation(
            id=_recommendation_id("black_hole", rect),
            kind="black_hole",
            reason="recurring_ui",
            confidence=confidence,
            line_count=line_count,
            rect=rect.padded(),
        )

    def _strong_candidate(self, valid) -> int | None:
        if not valid:
            return None
        ranked = sorted(valid, key=lambda item: item[2], reverse=True)
        best_index, _best_observation, best_chars = ranked[0]
        second_chars = ranked[1][2] if len(ranked) > 1 else 0
        if best_chars < STRONG_CANDIDATE_CHARACTERS:
            return None
        if second_chars and best_chars < second_chars * STRONG_CANDIDATE_DOMINANCE:
            return None
        center_x, center_y = ranked[0][1].rect.center
        evidence = self._cells.get(
            (
                min(GRID_COLUMNS - 1, int(center_x * GRID_COLUMNS)),
                min(GRID_ROWS - 1, int(center_y * GRID_ROWS)),
            )
        )
        if evidence and len(evidence.distinct_hashes) == 1 and evidence.max_repeat_count > STATIC_REPEAT_LIMIT:
            return None
        return best_index

    def _load(self) -> None:
        if not self.state_path.exists():
            return
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
            if data.get("schema_version") != AUTO_REGION_SCHEMA_VERSION:
                return
            saved_ratio = data.get("aspect_ratio")
            if self.aspect_ratio and saved_ratio:
                relative_difference = abs(float(saved_ratio) - self.aspect_ratio) / max(float(saved_ratio), 0.01)
                if relative_difference > ASPECT_RATIO_TOLERANCE:
                    return
            learned = []
            for item in data.get("regions") or []:
                if not isinstance(item, dict):
                    continue
                rect = NormalizedRect.from_sequence(item.get("rect") or [])
                confidence = _clamp(float(item.get("confidence", 0.0)))
                if rect.area > 0:
                    learned.append((rect, confidence))
            self._learned = learned[:MAX_ACTIVE_REGIONS]
        except Exception as exc:
            logger.warning("Ignoring invalid auto OCR region state %s: %s", self.state_path, exc)


def normalized_rectangles_from_config(rectangles, width: int, height: int, predicate) -> list[NormalizedRect]:
    """Convert matching runtime OCR rectangles to normalized source coordinates."""

    if width <= 0 or height <= 0:
        return []
    result = []
    for rectangle in rectangles or []:
        if not predicate(rectangle):
            continue
        coords = list(getattr(rectangle, "coordinates", []) or [])
        if len(coords) < 4:
            continue
        try:
            x, y, rect_width, rect_height = [float(value) for value in coords[:4]]
        except (TypeError, ValueError):
            continue
        if all(0.0 <= value <= 1.0 for value in (x, y, rect_width, rect_height)):
            rect = NormalizedRect(x, y, rect_width, rect_height)
        else:
            rect = NormalizedRect(x / width, y / height, rect_width / width, rect_height / height)
        if rect.area > 0:
            result.append(rect)
    return result
