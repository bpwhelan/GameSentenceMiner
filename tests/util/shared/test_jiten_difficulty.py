import pytest

from GameSentenceMiner.util.jiten_difficulty import get_jiten_difficulty_label


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
    ],
)
def test_get_jiten_difficulty_label_matches_jiten_bucket_names(
    difficulty, expected_label
):
    assert get_jiten_difficulty_label(difficulty) == expected_label
