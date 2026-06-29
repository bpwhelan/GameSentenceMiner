from GameSentenceMiner.util.config.configuration import Anki


def test_same_selected_lines_different_mined_line_reuse_defaults():
    config = Anki()

    assert config.reuse_audio_for_same_selected_lines_different_mined_line is True
    assert config.reuse_screenshot_for_same_selected_lines_different_mined_line is False
