# Copyright: Ren Tatsumoto <tatsu at autistici.org> and contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

try:
    from .compound_furigana import break_compound_furigana
    from .kana_conv import is_kana_char
except ImportError:
    from compound_furigana import break_compound_furigana
    from kana_conv import is_kana_char


def find_kanji_boundaries(word: str) -> tuple[int, int]:
    """
    Return the number of kana characters before the first kanji
    and the number of kana characters after the last kanji.
    """
    len_kana_before = 0
    len_kana_after = 0
    for idx, char in enumerate(word):
        if not is_kana_char(char):
            break
        len_kana_before += 1
    for idx, char in enumerate(reversed(word)):
        if not is_kana_char(char):
            break
        len_kana_after += 1
    return len_kana_before, len_kana_after


def format_output(kanji: str, reading: str) -> str:
    """Convert (kanji, reading) input to output that Anki understands: kanji[reading]"""
    # strip matching characters and beginning and end of reading and kanji
    # reading should always be at least as long as the kanji
    n_before, n_after = find_kanji_boundaries(kanji)
    if n_before == 0:
        if n_after == 0:
            out_expr = f" {kanji}[{reading}]"
        else:
            out_expr = f" {kanji[:-n_after]}[{reading[:-n_after]}]{kanji[-n_after:]}"
    else:
        if n_after == 0:
            out_expr = f"{kanji[:n_before]} {kanji[n_before:]}[{reading[n_before:]}]"
        else:
            out_expr = f"{kanji[:n_before]} {kanji[n_before:-n_after]}[{reading[n_before:-n_after]}]{kanji[-n_after:]}"

    return break_compound_furigana(out_expr)


if __name__ == "__main__":
    assert find_kanji_boundaries("秘訣") == (0, 0)
    assert find_kanji_boundaries("食べた") == (0, 2)
    assert find_kanji_boundaries("サイン会") == (3, 0)
    assert find_kanji_boundaries("取って置き") == (0, 1)
    assert find_kanji_boundaries("ほほ笑む") == (2, 1)
    assert find_kanji_boundaries("相合い傘") == (0, 0)
    print("1 Done.")
    assert format_output("秘訣", "ひけつ") == " 秘訣[ひけつ]"
    assert format_output("食べた", "たべた") == " 食[た]べた"
    assert format_output("高級レストラン", "こうきゅうれすとらん") == " 高級[こうきゅう]レストラン"
    assert format_output("サイン会", "さいんかい") == "サイン 会[かい]"
    assert format_output("あり得る", "ありえる") == "あり 得[え]る"
    assert format_output("取って置き", "とっておき") == " 取[と]って 置[お]き"
    assert format_output("あなた方", "あなたがた") == "あなた 方[がた]"
    assert format_output("突っ込んだ", "つっこんだ") == " 突[つ]っ 込[こ]んだ"
    assert format_output("相合い傘", "あいあいがさ") == " 相合[あいあ]い 傘[がさ]"
    assert format_output("あいあい傘", "あいあいがさ") == "あいあい 傘[がさ]"
    assert format_output("今は", "いまわ") == " 今[いま]は"
    assert format_output("ほほ笑む", "ほおえむ") == "ほほ 笑[え]む"
    assert format_output("ほほ笑む", "ほほえむ") == "ほほ 笑[え]む"
    print("2 Done.")
