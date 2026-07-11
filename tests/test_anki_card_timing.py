import json

from GameSentenceMiner.util import anki_card_timing


def test_anki_card_timing_disabled_is_noop(tmp_path):
    anki_card_timing.configure_anki_card_timing_logging(False, tmp_path)

    context = anki_card_timing.new_anki_card_timing_context(note_id=1, line_id="line-1", word="単語")
    anki_card_timing.log_anki_card_timing(context, "test.disabled")

    assert context is None
    assert not (tmp_path / "anki_card_timing.log").exists()


def test_anki_card_timing_writes_json_lines_when_enabled(tmp_path):
    log_path = anki_card_timing.configure_anki_card_timing_logging(True, tmp_path)
    try:
        context = anki_card_timing.new_anki_card_timing_context(
            note_id=42,
            line_id="line-1",
            word="単語",
            selected_line_count=2,
        )
        assert context is not None
        context.mark_queued()

        anki_card_timing.log_anki_card_timing(context, "test.event", phase="start")
        with anki_card_timing.time_anki_card_block(context, "test.block"):
            pass
    finally:
        anki_card_timing.configure_anki_card_timing_logging(False, tmp_path)

    assert log_path is not None
    records = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]

    assert [record["event"] for record in records] == ["test.event", "test.block"]
    assert records[0]["timing_id"] == context.timing_id
    assert records[0]["note_id"] == "42"
    assert records[0]["line_id"] == "line-1"
    assert records[0]["word"] == "単語"
    assert records[0]["selected_line_count"] == 2
    assert records[0]["phase"] == "start"
    assert records[1]["elapsed_ms"] >= 0
