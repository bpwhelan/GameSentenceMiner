import pytest

from GameSentenceMiner.util.config.configuration import Advanced


def test_existing_configs_leave_background_muting_disabled():
    advanced = Advanced.from_dict({"mute_game_on_minimize": True})

    assert advanced.mute_game_on_minimize is True
    assert advanced.mute_game_on_background is False


@pytest.mark.parametrize("mute_minimized", [False, True])
@pytest.mark.parametrize("mute_background", [False, True])
def test_window_audio_settings_round_trip_independently(mute_minimized, mute_background):
    advanced = Advanced(mute_game_on_minimize=mute_minimized, mute_game_on_background=mute_background)

    restored = Advanced.from_json(advanced.to_json())

    assert restored.mute_game_on_minimize is mute_minimized
    assert restored.mute_game_on_background is mute_background
