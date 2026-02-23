from GameSentenceMiner.util.yomitan_dict import name_parser


def test_contains_kanji_detects_cjk_range():
    parser = name_parser.NameParser()
    assert parser.contains_kanji("\u6f22a") is True
    assert parser.contains_kanji("kana") is False
    assert parser.contains_kanji("") is False


def test_split_japanese_name_with_and_without_space():
    parser = name_parser.NameParser()
    with_space = parser.split_japanese_name("family given")
    assert with_space["has_space"] is True
    assert with_space["family"] == "family"
    assert with_space["given"] == "given"
    assert with_space["combined"] == "familygiven"

    without_space = parser.split_japanese_name("single")
    assert without_space["has_space"] is False
    assert without_space["combined"] == "single"
    assert without_space["family"] is None


def test_split_romanized_name_to_hiragana_swaps_western_order(monkeypatch):
    parser = name_parser.NameParser()
    monkeypatch.setattr(name_parser.jaconv, "alphabet2kana", lambda text: f"kana({text})")

    result = parser.split_romanized_name_to_hiragana("Given Family")

    assert result["has_space"] is True
    assert result["given"] == "kana(given)"
    assert result["family"] == "kana(family)"
    assert result["full"] == "kana(family)kana(given)"


def test_generate_kana_readings_uses_kata2hira(monkeypatch):
    parser = name_parser.NameParser()
    monkeypatch.setattr(name_parser.jaconv, "kata2hira", lambda text: f"hira({text})")

    result = parser.generate_kana_readings("FA MI")

    assert result["has_space"] is True
    assert result["family"] == "hira(FA)"
    assert result["given"] == "hira(MI)"
    assert result["full"] == "hira(FAMI)"


def test_generate_mixed_name_readings_single_word_with_kanji(monkeypatch):
    parser = name_parser.NameParser()
    monkeypatch.setattr(name_parser.jaconv, "alphabet2kana", lambda text: f"kana({text})")

    result = parser.generate_mixed_name_readings("\u6f22", "Kan")

    assert result["has_space"] is False
    assert result["full"] == "kana(kan)"
    assert result["family"] == "kana(kan)"


def test_generate_mixed_name_readings_single_word_without_kanji_uses_kana_path(monkeypatch):
    parser = name_parser.NameParser()
    called = {}

    def fake_generate_kana_readings(name):
        called["name"] = name
        return {"has_space": False, "original": name, "full": "x", "family": "x", "given": "x"}

    monkeypatch.setattr(parser, "generate_kana_readings", fake_generate_kana_readings)
    result = parser.generate_mixed_name_readings("kana", "unused")

    assert called["name"] == "kana"
    assert result["full"] == "x"


def test_generate_mixed_name_readings_mixed_two_part_name(monkeypatch):
    parser = name_parser.NameParser()
    monkeypatch.setattr(name_parser.jaconv, "alphabet2kana", lambda text: f"kana({text})")
    monkeypatch.setattr(name_parser.jaconv, "kata2hira", lambda text: f"hira({text})")

    # Japanese order: family given
    # Romanized western order: Given Family
    result = parser.generate_mixed_name_readings("\u6f22 kana", "Given Family")

    assert result["has_space"] is True
    assert result["family"] == "kana(given)"
    assert result["given"] == "hira(kana)"
    assert result["full"] == "kana(given)hira(kana)"


def test_generate_mixed_name_readings_empty_input():
    parser = name_parser.NameParser()
    result = parser.generate_mixed_name_readings("", "")
    assert result == {"has_space": False, "original": "", "full": "", "family": "", "given": ""}
