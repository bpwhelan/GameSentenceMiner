"""
Property-based tests for FrequencyDictBuilder.

Feature: yomitan-frequency-dict
Uses hypothesis to verify correctness properties across generated inputs.
"""

from __future__ import annotations

import io
import json
import time
import zipfile

import hypothesis.strategies as st
from hypothesis import given, settings

from GameSentenceMiner.util.yomitan_dict.freq_dict_builder import FrequencyDictBuilder


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

# Japanese-ish words: mix of hiragana, katakana, and kanji-range chars
_word_chars = st.sampled_from(
    list("あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん")
    + list("食飲走読書見聞話思知行来出入立座開閉")
)
words = st.text(_word_chars, min_size=1, max_size=8)
readings = st.text(
    st.sampled_from(
        list("あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん")
    ),
    min_size=0,
    max_size=8,
)
counts = st.integers(min_value=1, max_value=100_000)

# A single (word, reading, count) triple
entry_triple = st.tuples(words, readings, counts)

# A list of triples (non-empty for most tests)
entry_triples = st.lists(entry_triple, min_size=1, max_size=200)


# ---------------------------------------------------------------------------
# Property 1: Round-trip serialization
# Validates: Requirement 6.4
# ---------------------------------------------------------------------------


@settings(max_examples=100)
@given(triples=entry_triples)
def test_property_1_round_trip_serialization(triples):
    """Serializing entries to ZIP then reading back produces equivalent data."""
    builder = FrequencyDictBuilder(download_url="http://localhost:9000/api/yomitan-freq-dict")
    builder.entries = [FrequencyDictBuilder._build_entry(w, r, c) for w, r, c in triples]

    zip_bytes = builder.export_bytes()

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        # Reconstruct all entries from all term_meta_bank files
        recovered = []
        bank_idx = 1
        while True:
            fname = f"term_meta_bank_{bank_idx}.json"
            if fname not in zf.namelist():
                break
            recovered.extend(json.loads(zf.read(fname)))
            bank_idx += 1

        assert recovered == builder.entries

        # Verify index metadata round-trips
        index = json.loads(zf.read("index.json"))
        assert index["title"] == "GSM Frequency Dictionary"
        assert index["format"] == 3
        assert index["frequencyMode"] == "occurrence-based"


# ---------------------------------------------------------------------------
# Property 2: Index metadata completeness
# Validates: Requirements 1.3, 1.4, 1.5, 6.3
# ---------------------------------------------------------------------------


@settings(max_examples=100)
@given(url=st.one_of(st.none(), st.just("http://127.0.0.1:9000/api/yomitan-freq-dict")))
def test_property_2_index_metadata_completeness(url):
    """Index always has required fields; updatable fields present iff download_url given."""
    builder = FrequencyDictBuilder(download_url=url)
    index = builder._create_index()

    assert index["title"] == "GSM Frequency Dictionary"
    assert index["format"] == 3
    assert index["frequencyMode"] == "occurrence-based"
    assert index["author"] == "GameSentenceMiner"

    if url is not None:
        assert "downloadUrl" in index
        assert "indexUrl" in index
        assert index["isUpdatable"] is True
    else:
        assert "downloadUrl" not in index
        assert "isUpdatable" not in index


# ---------------------------------------------------------------------------
# Property 3: Entry format correctness
# Validates: Requirements 1.2, 5.2
# ---------------------------------------------------------------------------


@settings(max_examples=100)
@given(word=words, reading=readings, count=counts)
def test_property_3_entry_format_correctness(word, reading, count):
    """Non-empty reading → dict payload; empty reading → bare count."""
    entry = FrequencyDictBuilder._build_entry(word, reading, count)

    assert entry[0] == word
    assert entry[1] == "freq"

    if reading:
        assert isinstance(entry[2], dict)
        assert entry[2]["frequency"] == count
        assert entry[2]["reading"] == reading
    else:
        assert entry[2] == count


# ---------------------------------------------------------------------------
# Property 5: UNIX timestamp revision (frequency dictionary)
# Validates: Requirement 3.1
# ---------------------------------------------------------------------------


@settings(max_examples=50)
@given(st.just(None))  # no varying input needed, just repeated runs
def test_property_5_unix_timestamp_revision(_):
    """Revision is a valid UNIX timestamp close to current time."""
    before = int(time.time())
    builder = FrequencyDictBuilder()
    after = int(time.time())

    rev = int(builder.revision)
    assert before <= rev <= after


# ---------------------------------------------------------------------------
# Property 7: Entry chunking
# Validates: Requirement 6.2
# ---------------------------------------------------------------------------


@settings(max_examples=30)
@given(n=st.integers(min_value=10_001, max_value=25_000))
def test_property_7_entry_chunking(n):
    """More than 10k entries → multiple files, each ≤ 10k, union equals original."""
    builder = FrequencyDictBuilder()
    builder.entries = [["w", "freq", i] for i in range(n)]

    zip_bytes = builder.export_bytes()

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        recovered = []
        bank_idx = 1
        while True:
            fname = f"term_meta_bank_{bank_idx}.json"
            if fname not in zf.namelist():
                break
            chunk = json.loads(zf.read(fname))
            assert len(chunk) <= 10_000
            recovered.extend(chunk)
            bank_idx += 1

        assert bank_idx > 2  # at least 2 files were created
        assert recovered == builder.entries
