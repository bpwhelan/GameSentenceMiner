from __future__ import annotations

from typing import NamedTuple

from .kana import is_kana_char


class _Dismembered(NamedTuple):
    word: str
    reading: str
    tail: str

    def assemble(self) -> str:
        return f"{self.word}[{self.reading}]{self.tail}"


class _CompoundSplit(NamedTuple):
    first: _Dismembered
    second: _Dismembered


def _dismember(expr: str) -> _Dismembered | None:
    furigana_start = expr.find("[")
    furigana_end = expr.find("]")
    if furigana_start < 1 or furigana_end < 3:
        return None
    return _Dismembered(
        expr[:furigana_start],
        expr[furigana_start + 1 : furigana_end],
        expr[furigana_end + 1 :],
    )


def _common_prefix_length(left: str, right: str) -> int:
    common_length = 0
    for left_char, right_char in zip(left, right):
        if left_char != right_char:
            break
        common_length += 1
    return common_length


def _find_common_kana(expr: _Dismembered) -> _CompoundSplit | None:
    start_index = max(1, _common_prefix_length(expr.word, expr.reading))
    for word_index in range(start_index, len(expr.word)):
        for reading_index in range(start_index, len(expr.reading)):
            if expr.word[word_index] != expr.reading[reading_index]:
                continue
            prefix_length = _common_prefix_length(expr.word[word_index:], expr.reading[reading_index:])
            if word_index > reading_index:
                continue
            return _CompoundSplit(
                first=_Dismembered(
                    expr.word[:word_index],
                    expr.reading[:reading_index],
                    expr.reading[reading_index : reading_index + prefix_length],
                ),
                second=_Dismembered(
                    expr.word[word_index + prefix_length :],
                    expr.reading[reading_index + prefix_length :],
                    expr.tail,
                ),
            )
    return None


def _break_compound_chunk(expr: str) -> str:
    dismembered = _dismember(expr)
    split = _find_common_kana(dismembered) if dismembered else None
    if not split:
        return expr
    return f"{split.first.assemble()} {_break_compound_chunk(split.second.assemble())}"


def break_compound_furigana(expr: str) -> str:
    return " ".join(map(_break_compound_chunk, expr.split(" ")))


def _kana_boundaries(word: str) -> tuple[int, int]:
    kana_before = 0
    kana_after = 0
    for char in word:
        if not is_kana_char(char):
            break
        kana_before += 1
    for char in reversed(word):
        if not is_kana_char(char):
            break
        kana_after += 1
    return kana_before, kana_after


def format_output(surface: str, reading: str) -> str:
    """Format one Sudachi morpheme using Anki's ``漢字[かんじ]`` syntax."""

    kana_before, kana_after = _kana_boundaries(surface)
    if kana_before == 0:
        if kana_after == 0:
            output = f" {surface}[{reading}]"
        else:
            output = f" {surface[:-kana_after]}[{reading[:-kana_after]}]{surface[-kana_after:]}"
    elif kana_after == 0:
        output = f"{surface[:kana_before]} {surface[kana_before:]}[{reading[kana_before:]}]"
    else:
        output = (
            f"{surface[:kana_before]} {surface[kana_before:-kana_after]}"
            f"[{reading[kana_before:-kana_after]}]{surface[-kana_after:]}"
        )
    return break_compound_furigana(output)
