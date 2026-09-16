"""Check scoring errors that could reverse an SBD adoption decision."""

from scripts.benchmark_sentence_segmenters import score_case, summarize_scores


def test_unspaced_japanese_is_scored_by_character_positions():
    result = score_case("今日は晴れ。明日は雨。", ["今日は晴れ。", "明日は雨。"], ["今日は晴れ。明日は雨。"])
    assert (result["tp"], result["fp"], result["fn"]) == (0, 0, 1)
    assert not result["exact_nonspace"]


def test_the_automatic_end_of_input_is_not_counted_as_a_correct_boundary():
    result = score_case("One. Two.", ["One.", "Two."], ["One. Two."])
    assert result["tp"] == 0
    assert result["fn"] == 1


def test_content_mutation_is_reported_and_not_arbitrarily_realigned():
    result = score_case("Ａ。Ｂ。", ["Ａ。", "Ｂ。"], ["A。", "B。"])
    assert result["content_changed"]
    assert result["tp"] is None
    assert not result["exact_nonspace"]
    summary = summarize_scores([result])
    assert summary["content_changed"] == 1
    assert summary["boundary_scored_cases"] == 0
    assert summary["boundary_f1"] is None


def test_newline_and_space_changes_do_not_masquerade_as_boundary_errors():
    result = score_case("Go\nnow.  Wait!", ["Go\nnow.", "Wait!"], ["Go now. ", "Wait!"])
    assert result["exact_nonspace"]
    assert not result["content_changed"]
    assert (result["tp"], result["fp"], result["fn"]) == (1, 0, 0)


def test_invented_boundary_is_a_false_positive():
    result = score_case("Dr. Stone arrived.", ["Dr. Stone arrived."], ["Dr.", "Stone arrived."])
    assert (result["tp"], result["fp"], result["fn"]) == (0, 1, 0)
