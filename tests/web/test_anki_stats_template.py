from __future__ import annotations

import re
from pathlib import Path


def test_words_not_in_anki_table_has_only_requested_columns():
    template_path = (
        Path(__file__).resolve().parents[2]
        / "GameSentenceMiner"
        / "web"
        / "templates"
        / "anki_stats.html"
    )
    template = template_path.read_text(encoding="utf-8")

    table_match = re.search(
        r'<table[^>]*id="wordsNotInAnkiTable"[^>]*class="stats-table"[^>]*>\s*<thead>\s*<tr>(.*?)</tr>\s*</thead>',
        template,
        flags=re.DOTALL,
    )
    assert table_match is not None

    headers = [
        re.sub(r"<[^>]+>", "", header).strip()
        for header in re.findall(
            r"<th[^>]*>(.*?)</th>", table_match.group(1), flags=re.DOTALL
        )
    ]

    assert headers == [
        "Word ⇅",
        "Reading ⇅",
        "POS ⇅",
        "Seen ▼",
        "Global Rank ⇅",
        "Details",
    ]


def test_words_not_in_anki_template_renders_new_filter_controls():
    template_path = (
        Path(__file__).resolve().parents[2]
        / "GameSentenceMiner"
        / "web"
        / "templates"
        / "anki_stats.html"
    )
    template = template_path.read_text(encoding="utf-8")

    expected_ids = [
        "wordsNotInAnkiDownloadCsv",
        "wordsNotInAnkiResetFilters",
        "wordsNotInAnkiPowerUserPanel",
        "wordsNotInAnkiPowerUserSummaryCount",
        "wordsNotInAnkiScriptFilter",
        "wordsNotInAnkiIncludeGrammar",
        "wordsNotInAnkiPosInclude",
        "wordsNotInAnkiPosExclude",
        "wordsNotInAnkiFrequencyCard",
        "wordsNotInAnkiFrequencyMin",
        "wordsNotInAnkiFrequencyMax",
        "wordsNotInAnkiFrequencyMinRange",
        "wordsNotInAnkiFrequencyMaxRange",
        "wordsNotInAnkiFrequencyReset",
        "wordsNotInAnkiPageSize",
    ]

    for element_id in expected_ids:
        assert f'id="{element_id}"' in template

    expected_layout_classes = [
        "words-filter-group",
        "words-power-user-summary-icon",
        "words-filter-checkbox-copy",
        "words-rank-slider-inner",
        "words-not-in-anki-results",
        "words-not-in-anki-table-wrap",
        "words-table-pagination",
    ]

    for class_name in expected_layout_classes:
        assert class_name in template

    assert 'id="wordsNotInAnkiCjkOnly"' not in template
