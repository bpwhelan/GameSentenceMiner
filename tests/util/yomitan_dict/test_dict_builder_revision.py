"""
Property test for YomitanDictBuilder UNIX timestamp revision.

Feature: yomitan-frequency-dict, Property 6: UNIX timestamp revision (character dictionary)
Validates: Requirement 3.2
"""

from __future__ import annotations

import time

from hypothesis import given, settings
import hypothesis.strategies as st

from GameSentenceMiner.util.yomitan_dict.dict_builder import YomitanDictBuilder


@settings(max_examples=50)
@given(st.just(None))
def test_property_6_char_dict_unix_timestamp_revision(_):
    """Character dict revision is a UNIX timestamp when no explicit revision given."""
    before = int(time.time())
    builder = YomitanDictBuilder()
    after = int(time.time())

    rev = int(builder.revision)
    assert before <= rev <= after


def test_explicit_revision_preserved():
    """When an explicit revision is passed, it should be used as-is."""
    builder = YomitanDictBuilder(revision="custom-42")
    assert builder.revision == "custom-42"
