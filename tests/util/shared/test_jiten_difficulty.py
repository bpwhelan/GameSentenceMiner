import importlib.util
from pathlib import Path

import pytest

from GameSentenceMiner.util.jiten_difficulty import get_jiten_difficulty_label

JITEN_API_CLIENT_PATH = (
    Path(__file__).resolve().parents[3] / "GameSentenceMiner" / "util" / "clients" / "jiten_api_client.py"
)
JITEN_API_CLIENT_SPEC = importlib.util.spec_from_file_location(
    "jiten_api_client_test_module",
    JITEN_API_CLIENT_PATH,
)
assert JITEN_API_CLIENT_SPEC and JITEN_API_CLIENT_SPEC.loader
JITEN_API_CLIENT_MODULE = importlib.util.module_from_spec(JITEN_API_CLIENT_SPEC)
JITEN_API_CLIENT_SPEC.loader.exec_module(JITEN_API_CLIENT_MODULE)
JitenApiClient = JITEN_API_CLIENT_MODULE.JitenApiClient


@pytest.mark.parametrize(
    ("difficulty", "expected_label"),
    [
        (0, "Beginner"),
        (1, "Easy"),
        (2, "Average"),
        (3, "Hard"),
        (4, "Expert"),
        (5, "Insane"),
        (2.7, "Average"),
        (4.9, "Expert"),
        (-1, "Beginner"),
        (8, "Insane"),
        (None, None),
    ],
)
def test_get_jiten_difficulty_label_matches_jiten_bucket_names(difficulty, expected_label):
    assert get_jiten_difficulty_label(difficulty) == expected_label


def test_normalize_deck_data_keeps_missing_difficulty_empty():
    normalized = JitenApiClient.normalize_deck_data(
        {
            "deckId": 7,
            "originalTitle": "No Difficulty Title",
            "mediaType": 7,
        }
    )

    assert normalized["difficulty"] is None
    assert normalized["difficulty_raw"] is None
    assert normalized["difficulty_label"] is None


def test_normalize_deck_data_preserves_beginner_bucket():
    normalized = JitenApiClient.normalize_deck_data(
        {
            "deckId": 8,
            "originalTitle": "Beginner Title",
            "mediaType": 7,
            "difficulty": 0,
            "difficultyRaw": 0.4,
        }
    )

    assert normalized["difficulty"] == 0
    assert normalized["difficulty_raw"] == 0.4
    assert normalized["difficulty_label"] == "Beginner"
