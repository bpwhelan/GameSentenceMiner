# Copyright: Ren Tatsumoto <tatsu at autistici.org> and contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

from typing import NamedTuple, Optional

__all__ = [
    "break_compound_furigana",
]


class Dismembered(NamedTuple):
    word: str
    reading: str
    tail: str

    def assemble(self):
        return f"{self.word}[{self.reading}]{self.tail}"


class CompoundSplit(NamedTuple):
    first: Dismembered
    second: Dismembered


def dismember(expr: str) -> Optional[Dismembered]:
    if (furigana_start := expr.find("[")) < 1:
        return None
    elif (furigana_end := expr.find("]")) < 3:
        return None
    else:
        return Dismembered(
            expr[:furigana_start],
            expr[furigana_start + 1 : furigana_end],
            expr[furigana_end + 1 :],
        )


def find_common_prefix_len(common_stem: str, common_reading: str):
    common_len = 0
    for c1, c2 in zip(common_stem, common_reading):
        if c1 != c2:
            break
        common_len += 1
    return common_len


def find_common_kana(expr: Dismembered) -> Optional[CompoundSplit]:
    start_index = max(1, find_common_prefix_len(expr.word, expr.reading))

    for word_idx in range(start_index, len(expr.word)):
        for reading_idx in range(start_index, len(expr.reading)):
            if expr.word[word_idx] == expr.reading[reading_idx]:
                prefix_len = find_common_prefix_len(expr.word[word_idx:], expr.reading[reading_idx:])
                if word_idx > reading_idx:
                    # a situation where there are more kanji than kana, e.g. 相合[あ]
                    # which might(?) indicate that we have to look further.
                    continue
                return CompoundSplit(
                    first=Dismembered(
                        expr.word[:word_idx],
                        expr.reading[:reading_idx],
                        expr.reading[reading_idx : reading_idx + prefix_len],
                    ),
                    second=Dismembered(
                        expr.word[word_idx + prefix_len :],
                        expr.reading[reading_idx + prefix_len :],
                        expr.tail,
                    ),
                )
    return None


def break_compound_furigana_chunk(expr: str) -> str:
    if (d := dismember(expr)) and (c := find_common_kana(d)):
        return f"{c.first.assemble()} {break_compound_furigana_chunk(c.second.assemble())}"
    else:
        return expr


def break_compound_furigana(expr: str) -> str:
    return " ".join(map(break_compound_furigana_chunk, expr.split(" ")))


if __name__ == "__main__":
    assert dismember("相合い傘[あいあいがさ]") == Dismembered(word="相合い傘", reading="あいあいがさ", tail="")
    assert break_compound_furigana(" 取って置[とってお]き") == " 取[と]って 置[お]き"
    assert break_compound_furigana("言い方[いいかた]") == "言[い]い 方[かた]"
    assert break_compound_furigana("丸め込[まるめこ]む") == "丸[まる]め 込[こ]む"
    assert break_compound_furigana("繋[つなが]る") == "繋[つなが]る"
    assert break_compound_furigana("お 問い合[といあ]わせ") == "お 問[と]い 合[あ]わせ"
    assert break_compound_furigana("あなた 方[がた]") == "あなた 方[がた]"
    assert break_compound_furigana("相合い傘[あいあいがさ]") == "相合[あいあ]い 傘[がさ]"
    print("Done.")
