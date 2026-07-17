from __future__ import annotations

import re


HIRAGANA = "ぁあぃいぅうぇえぉおかがか゚きぎき゚くぐく゚けげけ゚こごこ゚さざしじすずせぜそぞただちぢっつづてでとどなにぬねのはばぱひびぴふぶぷへべぺほぼぽまみむめもゃやゅゆょよらりるれろゎわゐゑをんゔゕゖゝゞ"
KATAKANA = "ァアィイゥウェエォオカガカ゚キギキ゚クグク゚ケゲケ゚コゴコ゚サザシジスズセゼソゾタダチヂッツヅテデトドナニヌネノハバパヒビピフブプヘベペホボポマミムメモャヤュユョヨラリルレロヮワヰヱヲンヴヵヶヽヾ"

KATAKANA_TO_HIRAGANA = str.maketrans(KATAKANA, HIRAGANA)
HIRAGANA_TO_KATAKANA = str.maketrans(HIRAGANA, KATAKANA)
RE_ONE_MORA = re.compile(r".゚?[ァィゥェォャュョぁぃぅぇぉゃゅょ]?")


def kana_to_moras(kana: str) -> list[str]:
    return re.findall(RE_ONE_MORA, kana)


def to_hiragana(kana: str) -> str:
    return kana.translate(KATAKANA_TO_HIRAGANA)


def to_katakana(kana: str) -> str:
    return kana.translate(HIRAGANA_TO_KATAKANA)


def is_kana_char(char: str) -> bool:
    if len(char) != 1:
        raise ValueError("string must contain one character")
    return char in HIRAGANA or char in KATAKANA or char == "ー"


def is_kana_str(word: str) -> bool:
    if not word:
        raise ValueError("string can't be empty")
    return all(map(is_kana_char, word))
