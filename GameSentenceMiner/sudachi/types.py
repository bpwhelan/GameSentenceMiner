from __future__ import annotations

import enum
from dataclasses import dataclass


class PartOfSpeech(enum.Enum):
    """Top-level Sudachi/UniDic part-of-speech categories used by GSM."""

    unknown = None
    noun = "名詞"
    verb = "動詞"
    i_adjective = "形容詞"
    adjectival_noun = "形状詞"
    adverb = "副詞"
    bound_auxiliary = "助動詞"
    particle = "助詞"
    interjection = "感動詞"
    filler = "フィラー"
    conjunction = "接続詞"
    prefix = "接頭辞"
    suffix = "接尾辞"
    adnominal_adjective = "連体詞"
    pronoun = "代名詞"
    symbol = "補助記号"
    whitespace = "空白"
    other = "その他"

    @classmethod
    def from_sudachi(cls, value: str | None) -> "PartOfSpeech":
        parts = str(value or "").split(",")
        primary = parts[0]
        if primary == cls.interjection.value and len(parts) > 1 and parts[1] == cls.filler.value:
            return cls.filler
        aliases = {
            "記号": cls.symbol,
            "接頭詞": cls.prefix,
            "フィラー": cls.interjection,
        }
        if primary in aliases:
            return aliases[primary]
        try:
            return cls(primary or None)
        except ValueError:
            return cls.unknown

    @property
    def is_word(self) -> bool:
        return self not in {self.symbol, self.whitespace, self.other}


@dataclass(frozen=True)
class SudachiToken:
    word: str
    headword: str
    katakana_reading: str | None
    part_of_speech: PartOfSpeech
    start: int
    end: int
