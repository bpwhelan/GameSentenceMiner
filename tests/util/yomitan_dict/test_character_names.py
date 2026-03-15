from GameSentenceMiner.util.yomitan_dict.character_names import (
    CharacterNameCandidate,
    build_character_name_candidates,
    build_character_name_index,
    merge_tokens_with_character_names,
    tokens_to_furigana_segments,
)


def test_build_character_name_candidates_matches_dictionary_variants(monkeypatch):
    from GameSentenceMiner.util.yomitan_dict import character_names

    parser = character_names._get_name_parser()
    monkeypatch.setattr(
        parser,
        "generate_mixed_name_readings",
        lambda *_args, **_kwargs: {"full": "ふる", "family": "かぞく", "given": "なまえ"},
    )
    monkeypatch.setattr(
        parser,
        "split_japanese_name",
        lambda *_args, **_kwargs: {
            "has_space": True,
            "original": "星野 ルビー",
            "combined": "星野ルビー",
            "family": "星野",
            "given": "ルビー",
        },
    )
    monkeypatch.setattr(parser, "HONORIFIC_SUFFIXES", [("さん", "さん")])

    candidates = build_character_name_candidates(
        {
            "name_original": "星野 ルビー",
            "name": "Ruby Hoshino",
            "aliases": ["アイドル"],
        }
    )

    by_term = {candidate.term: candidate for candidate in candidates}
    assert set(by_term) == {
        "星野 ルビー",
        "星野ルビー",
        "星野",
        "ルビー",
        "星野さん",
        "ルビーさん",
        "星野ルビーさん",
        "星野 ルビーさん",
        "アイドル",
        "アイドルさん",
    }
    assert by_term["星野ルビー"].reading_hiragana == "ふる"
    assert by_term["星野ルビー"].reading_katakana == "フル"
    assert by_term["アイドル"].headword == "星野ルビー"


def test_merge_tokens_with_character_names_prefers_longest_recent_match():
    tokens = [
        {"word": "星野", "start": 0, "end": 2, "reading": "ホシノ"},
        {"word": "ルビー", "start": 2, "end": 5, "reading": "ルビー"},
        {"word": "が", "start": 5, "end": 6},
    ]
    candidates = [
        CharacterNameCandidate(
            term="星野ルビー",
            reading_hiragana="ほしのるびー",
            reading_katakana="ホシノルビー",
            headword="星野ルビー",
        ),
        CharacterNameCandidate(
            term="星野",
            reading_hiragana="ほしの",
            reading_katakana="ホシノ",
            headword="星野ルビー",
        ),
    ]

    merged = merge_tokens_with_character_names(
        "星野ルビーが",
        tokens,
        build_character_name_index(candidates),
    )

    assert merged == [
        {
            "word": "星野ルビー",
            "start": 0,
            "end": 5,
            "reading": "ホシノルビー",
            "headword": "星野ルビー",
            "pos": "character-name",
        },
        {"word": "が", "start": 5, "end": 6},
    ]


def test_tokens_to_furigana_segments_uses_character_name_readings():
    segments = tokens_to_furigana_segments(
        [
            {
                "word": "星野ルビー",
                "start": 0,
                "end": 5,
                "reading": "ホシノルビー",
            },
            {
                "word": "ルビー",
                "start": 5,
                "end": 8,
                "reading": "ルビー",
            },
        ]
    )

    assert segments == [
        {
            "text": "星野ルビー",
            "start": 0,
            "end": 5,
            "hasReading": True,
            "reading": "ほしのるびー",
        },
        {
            "text": "ルビー",
            "start": 5,
            "end": 8,
            "hasReading": False,
            "reading": None,
        },
    ]
