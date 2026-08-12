from __future__ import annotations

from dataclasses import dataclass
from typing import TypeAlias

_EXPECTED_API_VERSION = 1

try:
    from GameSentenceMiner import _native as _extension

    if int(_extension.api_version()) != _EXPECTED_API_VERSION:
        raise ImportError(
            f"Unsupported GameSentenceMiner native API version: {_extension.api_version()} "
            f"(expected {_EXPECTED_API_VERSION})"
        )
except (ImportError, OSError, AttributeError, RuntimeError, TypeError, ValueError) as exc:
    # Source checkouts and incompatible packaged binaries intentionally fall back.
    _extension = None
    _IMPORT_ERROR: Exception | None = exc
else:
    _IMPORT_ERROR = None


@dataclass(frozen=True, slots=True)
class TextFilterResult:
    text: str
    all_blocks: list[str]
    compare_blocks: list[str | None]


@dataclass(frozen=True, slots=True)
class LayoutLine:
    text: str
    bounding_box: tuple[float, float, float, float]
    source_ids: list[int]


@dataclass(frozen=True, slots=True)
class LayoutParagraph:
    bounding_box: tuple[float, float, float, float]
    writing_direction: str
    lines: list[LayoutLine]


@dataclass(frozen=True, slots=True)
class OverlayFilterDecision:
    source_id: int
    use_words: bool
    source_word_ids: list[int]


LayoutInput: TypeAlias = tuple[
    int,
    str,
    float,
    float,
    float,
    float,
    str | None,
    str | None,
]
SpatialLineInput: TypeAlias = tuple[str, float, float, float, float, bool]
OverlayFilterInput: TypeAlias = tuple[int, str, list[tuple[int, str]]]


class NativeOcrUnavailable(RuntimeError):
    pass


def is_available() -> bool:
    return _extension is not None


def has_overlay_language_filter() -> bool:
    return _extension is not None and hasattr(_extension, "filter_overlay_language")


def import_error() -> Exception | None:
    return _IMPORT_ERROR


def _require_extension():
    if _extension is None:
        raise NativeOcrUnavailable("The GameSentenceMiner native extension is not installed") from _IMPORT_ERROR
    return _extension


def api_version() -> int:
    return int(_require_extension().api_version())


def filter_text(
    *,
    source_text: str,
    blocks: list[str],
    language: str,
    previous_blocks: list[str],
    historic_compare_blocks: list[str],
) -> TextFilterResult:
    text, all_blocks, compare_blocks = _require_extension().filter_ocr_text(
        source_text,
        blocks,
        language,
        previous_blocks,
        historic_compare_blocks,
    )
    return TextFilterResult(text=text, all_blocks=all_blocks, compare_blocks=compare_blocks)


def order_layout(
    *,
    lines: list[LayoutInput],
    image_width: float,
    image_height: float,
    language: str,
    furigana_filter: bool,
    support_center_aligned_text: bool,
    merge_close_paragraphs: bool,
) -> list[LayoutParagraph]:
    raw_paragraphs = _require_extension().order_ocr_layout(
        lines,
        image_width,
        image_height,
        language,
        furigana_filter,
        support_center_aligned_text,
        merge_close_paragraphs,
    )
    return [
        LayoutParagraph(
            bounding_box=tuple(bounding_box),
            writing_direction=writing_direction,
            lines=[
                LayoutLine(text=text, bounding_box=tuple(line_bbox), source_ids=source_ids)
                for text, line_bbox, source_ids in paragraph_lines
            ],
        )
        for bounding_box, writing_direction, paragraph_lines in raw_paragraphs
    ]


def build_spatial_text(
    lines: list[SpatialLineInput],
    *,
    same_axis_height_ratio: float = 0.6,
    blank_line_height_ratio: float = 2.0,
    blank_line_token: str | None = None,
) -> str:
    return str(
        _require_extension().build_spatial_text(
            lines,
            same_axis_height_ratio,
            blank_line_height_ratio,
            blank_line_token,
        )
    )


def filter_overlay_language(
    *,
    language: str,
    lines: list[OverlayFilterInput],
) -> list[OverlayFilterDecision]:
    return [
        OverlayFilterDecision(
            source_id=source_id,
            use_words=use_words,
            source_word_ids=source_word_ids,
        )
        for source_id, use_words, source_word_ids in _require_extension().filter_overlay_language(
            lines,
            language,
        )
    ]
