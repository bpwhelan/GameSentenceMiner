import pytest

from GameSentenceMiner.util.config.configuration import Advanced


def test_existing_configs_leave_background_muting_disabled():
    advanced = Advanced.from_dict({"mute_game_on_minimize": True})

    assert advanced.mute_game_on_minimize is True
    assert advanced.mute_game_on_background is False
    assert advanced.mute_game_on_background_delay_seconds == 5


@pytest.mark.parametrize("mute_minimized", [False, True])
@pytest.mark.parametrize("mute_background", [False, True])
@pytest.mark.parametrize("delay_seconds", [0, 5, 10, 300])
def test_window_audio_settings_round_trip_independently(mute_minimized, mute_background, delay_seconds):
    advanced = Advanced(
        mute_game_on_minimize=mute_minimized,
        mute_game_on_background=mute_background,
        mute_game_on_background_delay_seconds=delay_seconds,
    )

    restored = Advanced.from_json(advanced.to_json())

    assert restored.mute_game_on_minimize is mute_minimized
    assert restored.mute_game_on_background is mute_background
    assert restored.mute_game_on_background_delay_seconds == delay_seconds


@pytest.mark.parametrize(
    ("value", "expected"),
    [(-1, 0), (301, 300), ("10", 10), (None, 5), ("invalid", 5), (float("inf"), 5), (float("nan"), 5)],
)
def test_background_mute_delay_normalizes_invalid_values(value, expected):
    assert Advanced(mute_game_on_background_delay_seconds=value).mute_game_on_background_delay_seconds == expected
