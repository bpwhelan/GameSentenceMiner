from datetime import UTC, datetime, timedelta

from GameSentenceMiner.text_pipeline.coordinator import TextCoordinatorState
from GameSentenceMiner.text_pipeline.models import SourceKind, TextEventKind, TextObservation

BASE = datetime(2026, 10, 31, tzinfo=UTC)


def observation(text, seconds, *, source=SourceKind.TEXTHOOK, scene="game", merge=False, skip_control=False):
    stamp = BASE + timedelta(seconds=seconds)
    return TextObservation(
        observation_id=f"{source.value}-{scene}-{seconds}",
        source_kind=source,
        source_instance=source.value,
        raw_text=text,
        captured_at_utc=stamp,
        emitted_at_utc=stamp,
        received_at_utc=stamp,
        received_monotonic_ns=int((seconds + 100) * 1e9),
        merge_fragments=merge,
        revision_window_ms=250,
        metadata={"scene": scene, "skip_control_active": skip_control},
    )


def ingest(state, text, seconds, **kwargs):
    item = observation(text, seconds, **kwargs)
    return state.ingest(item, now=item.received_at_utc, now_monotonic_ns=item.received_monotonic_ns)


def settle(state, seconds):
    ns = int((seconds + 100) * 1e9)
    return state.freeze_due(now=BASE + timedelta(seconds=seconds), now_monotonic_ns=ns) + state.poll_skip_detection(ns)


def test_batched_skip_excludes_first_batches_before_stats_commit():
    state = TextCoordinatorState(skip_detection=True)
    for i in range(8):
        ingest(state, chr(0x3041 + i) * 250, i * 0.25)
    assert all(r.stats_status == "skipped" for r in state.snapshot().records)
    assert not any(e.kind is TextEventKind.STATS_READY for e in settle(state, 4))


def test_large_single_line_and_name_are_not_skipping():
    state = TextCoordinatorState(skip_detection=True)
    ingest(state, "太郎", 0)
    ingest(state, "長い文章" * 200, 0.1)
    settle(state, 3)
    assert all(r.stats_status == "accepted" for r in state.snapshot().records)


def test_typewriter_prefixes_do_not_count_as_replaced_dialogue():
    state = TextCoordinatorState(skip_detection=True)
    text = "普通に文字が少しずつ表示されている文章を読んでいる。" * 3
    for i in range(1, len(text) + 1):
        ingest(state, text[:i], i * 0.05, merge=True)
    settle(state, 8)
    assert all(r.stats_status == "accepted" for r in state.snapshot().records)


def test_duplicate_redraws_do_not_extend_skip_or_inflate_volume():
    state = TextCoordinatorState(skip_detection=True)
    for i in range(30):
        ingest(state, "表示中の普通の文章。" * 10, i * 0.05)
    settle(state, 4)
    assert len(state.snapshot().records) == 1
    assert state.snapshot().records[0].stats_status == "accepted"


def test_short_replies_and_manual_input_remain_eligible():
    state = TextCoordinatorState(skip_detection=True)
    for i, text in enumerate(["え？", "うん。", "はい。", "どうして？", "そうか。"]):
        ingest(state, text, i * 0.3)
    manual = ingest(state, "明示的に選択した文章" * 100, 1.3, source=SourceKind.MANUAL)
    assert manual.events[-1].record.stats_status == "pending_manual"
    settle(state, 4)
    assert all(r.stats_status == "accepted" for r in state.snapshot().records)


def test_quiet_recovery_fires_without_new_text_and_keeps_final_batch_excluded():
    state = TextCoordinatorState(skip_detection=True)
    for i in range(4):
        ingest(state, chr(0x3041 + i) * 300, i * 0.25)
    events = settle(state, 3)
    assert sum(e.kind is TextEventKind.SKIP_ENDED for e in events) == 1
    assert not any(e.kind is TextEventKind.SKIP_ENDED for e in settle(state, 4))
    assert all(r.stats_status == "skipped" for r in state.snapshot().records)
    ingest(state, "ここからは普通の文章に戻る。", 5)
    settle(state, 8)
    assert state.snapshot().records[-1].stats_status == "accepted"


def test_scene_change_does_not_carry_skip_into_next_game():
    state = TextCoordinatorState(skip_detection=True)
    for i in range(4):
        ingest(state, chr(0x3041 + i) * 300, i * 0.25)
    ingest(state, "別のゲームの普通の文章。", 1, scene="other")
    settle(state, 4)
    assert state.snapshot().records[-1].stats_status == "accepted"


def test_fragment_merging_does_not_hide_batched_skip_volume():
    state = TextCoordinatorState(skip_detection=True)
    for i in range(8):
        ingest(state, chr(0x3041 + i) * 250, i * 0.15, merge=True)
    settle(state, 4)
    assert all(r.stats_status == "skipped" for r in state.snapshot().records)


def test_same_frame_fragments_are_not_fast_forward():
    state = TextCoordinatorState(skip_detection=True)
    for i in range(5):
        ingest(state, chr(0x3041 + i) * 50, i * 0.001)
    settle(state, 4)
    assert all(r.stats_status == "accepted" for r in state.snapshot().records)


def test_only_verified_landing_suffix_is_counted_once():
    state = TextCoordinatorState(skip_detection=True)
    visible = "ここで止まって読む最後の文章。"
    for i in range(4):
        ingest(state, chr(0x3041 + i) * 300 + visible, i * 0.25)
    settle(state, 3)
    assert not state.recover_skip_landing("関係のないメニューや背景の文章", "game", now_monotonic_ns=104_000_000_000)
    events = state.recover_skip_landing(
        visible, "game", now=BASE + timedelta(seconds=4), now_monotonic_ns=104_000_000_000
    )
    assert events
    eligible = [r for r in state.snapshot().records if r.stats_status == "accepted"]
    assert [r.text for r in eligible] == [visible]
    assert eligible[0].skip_overlay
    assert not state.recover_skip_landing(visible, "game", now_monotonic_ns=105_000_000_000)


def test_exact_visible_landing_can_be_restored_without_a_second_record():
    state = TextCoordinatorState(skip_detection=True)
    for i in range(4):
        ingest(state, chr(0x3041 + i) * 200, i * 0.25)
    settle(state, 3)
    last = state.snapshot().records[-1]
    assert state.recover_skip_landing(last.text, "game", now_monotonic_ns=104_000_000_000)
    assert len(state.snapshot().records) == 4
    assert state.snapshot().records[-1].stats_status == "accepted"


def test_new_activity_invalidates_old_landing_scan():
    state = TextCoordinatorState(skip_detection=True)
    for i in range(4):
        ingest(state, chr(0x3041 + i) * 200, i * 0.25)
    settle(state, 3)
    last = state.snapshot().records[-1]
    ingest(state, "新しい場面の普通の文章", 4)
    assert not state.recover_skip_landing(last.text, "game", now_monotonic_ns=104_000_000_000)


def test_shutdown_commits_normal_pending_text_without_waiting():
    state = TextCoordinatorState(skip_detection=True)
    ingest(state, "通常の終了前の最後の文章", 0)
    events = state.finish_stats()
    assert events[-1].kind is TextEventKind.STATS_READY
    assert state.snapshot().records[-1].stats_status == "accepted"


def test_ctrl_supports_detection_when_hook_samples_fast_forward_sparsely():
    state = TextCoordinatorState(skip_detection=True)
    for i in range(4):
        ingest(state, chr(0x3041 + i) * 40, i * 0.6, skip_control=True)
    assert all(r.stats_status == "skipped" for r in state.snapshot().records)
    # Holding Ctrl at a choice produces no new text: the timer still recovers.
    assert any(e.kind is TextEventKind.SKIP_ENDED for e in settle(state, 5))


def test_ctrl_held_on_one_stationary_line_does_not_exclude_it():
    state = TextCoordinatorState(skip_detection=True)
    for i in range(20):
        ingest(state, "操作を待っている選択肢の文章。", i * 0.1, skip_control=True)
    settle(state, 5)
    assert state.snapshot().records[0].stats_status == "accepted"


def test_suspicion_expires_when_dialogue_returns_to_normal_cadence():
    state = TextCoordinatorState(skip_detection=True)
    ingest(state, "あ" * 80, 0)
    events = ingest(state, "い" * 80, 0.2).events
    assert any(e.kind is TextEventKind.SKIP_STARTED for e in events)
    ingest(state, "う" * 16, 1.2)
    events = ingest(state, "え" * 16, 1.8).events
    assert any(e.kind is TextEventKind.SKIP_ENDED for e in events)
    settle(state, 5)
    assert all(r.stats_status == "accepted" for r in state.snapshot().records)


def test_manual_stats_wait_for_earlier_automatic_text_without_being_skip_classified():
    state = TextCoordinatorState(skip_detection=True)
    first = ingest(state, "先に到着した自動取り込みの文章。", 0)
    second = ingest(state, "後から手動で取り込んだ文章。", 0.1, source=SourceKind.MANUAL)
    events = settle(state, 3)
    ready = [e.record.line_id for e in events if e.kind is TextEventKind.STATS_READY]
    assert ready == [first.ack.line_id, second.ack.line_id]


def test_batched_two_flush_skip_is_excluded():
    state = TextCoordinatorState(skip_detection=True)
    ingest(state, "あ" * 97, 0.0)
    ingest(state, "い" * 153, 1.07)
    settle(state, 5.0)
    assert all(r.stats_status == "skipped" for r in state.snapshot().records)


def test_fast_asymmetric_batched_burst_is_excluded():
    state = TextCoordinatorState(skip_detection=True)
    ingest(state, "あ" * 59, 0.0)
    ingest(state, "い" * 373, 0.57)
    settle(state, 5.0)
    assert all(r.stats_status == "skipped" for r in state.snapshot().records)


def test_three_batched_rapid_replacements_are_excluded():
    state = TextCoordinatorState(skip_detection=True)
    ingest(state, "あ" * 112, 0.0)
    ingest(state, "い" * 33, 0.11)
    ingest(state, "う" * 28, 0.23)
    settle(state, 5.0)
    assert all(r.stats_status == "skipped" for r in state.snapshot().records)


def test_sustained_multi_second_batched_skip_is_excluded():
    state = TextCoordinatorState(skip_detection=True)
    # Batches spaced ~0.7-1.1s apart never cross the 1.5s short-window volume bar alone,
    # yet deliver >270 compact chars across 4 replacements in <2.5s.
    ingest(state, "あ" * 70, 0.0)
    ingest(state, "い" * 69, 1.05)
    ingest(state, "う" * 61, 1.70)
    ingest(state, "え" * 75, 2.35)
    settle(state, 6.0)
    records = state.snapshot().records
    assert all(r.stats_status == "skipped" for r in records[1:])
    assert sum(r.stats_status == "skipped" for r in records) >= 3


def test_confirmed_skip_does_not_reset_mid_streak_during_continuation_or_brief_fade():
    state = TextCoordinatorState(skip_detection=True)
    # Initial confirmed skip burst
    ingest(state, "あ" * 120, 0.0)
    ingest(state, "い" * 130, 0.25)
    assert all(r.stats_status == "skipped" for r in state.snapshot().records)
    # Continued batched skip for >3s at moderate per-flush sizes that stay below entry bar
    ingest(state, "う" * 65, 1.20)
    ingest(state, "え" * 60, 2.10)
    ingest(state, "お" * 65, 3.00)
    # Brief 1.7s scene fade during skip, followed by another skip batch
    ingest(state, "か" * 110, 4.70)
    settle(state, 8.0)
    assert all(r.stats_status == "skipped" for r in state.snapshot().records)


def test_suspended_suspicion_holds_first_batch_until_confirmation():
    state = TextCoordinatorState(skip_detection=True)
    # Suspicious burst starts at t=0..0.25, then confirms at t=1.65 (past the 1.5s window).
    ingest(state, "あ" * 80, 0.0)
    events = ingest(state, "い" * 80, 0.25).events
    assert any(e.kind is TextEventKind.SKIP_STARTED for e in events)
    ingest(state, "う" * 110, 1.65)
    settle(state, 5.0)
    assert all(r.stats_status == "skipped" for r in state.snapshot().records)


def test_fast_real_reading_is_not_classified_as_skipping():
    # Fast Japanese skimming (~90k chars/hr: 35 compact chars every 1.4s)
    state = TextCoordinatorState(skip_detection=True)
    for i in range(12):
        ingest(state, chr(0x3041 + (i % 40)) * 35, i * 1.4)
    settle(state, 20.0)
    assert all(r.stats_status == "accepted" for r in state.snapshot().records)

    # Rapid short emotional dialogue (18 compact chars every 0.55s)
    state = TextCoordinatorState(skip_detection=True)
    for i in range(8):
        ingest(state, chr(0x3041 + (i % 40)) * 18, i * 0.55)
    settle(state, 10.0)
    assert all(r.stats_status == "accepted" for r in state.snapshot().records)

    # Fast English reading (~500 WPM: 65 alphanumeric chars every 2.0s)
    state = TextCoordinatorState(skip_detection=True)
    for i in range(10):
        ingest(state, chr(ord("a") + (i % 26)) * 65, i * 2.0)
    settle(state, 25.0)
    assert all(r.stats_status == "accepted" for r in state.snapshot().records)


def test_normal_line_before_large_nvl_wall_and_two_short_clicks_are_accepted():
    # Fast read of a 55-char line (1.3s) followed by a large 280-char narration wall
    state = TextCoordinatorState(skip_detection=True)
    ingest(state, "あ" * 55, 0.0)
    ingest(state, "い" * 280, 1.3)
    settle(state, 5.0)
    assert all(r.stats_status == "accepted" for r in state.snapshot().records)

    # Two quick 15-char lines landing on a 180-char narration wall
    state = TextCoordinatorState(skip_detection=True)
    ingest(state, "あ" * 15, 0.0)
    ingest(state, "い" * 15, 0.2)
    ingest(state, "う" * 180, 0.4)
    settle(state, 5.0)
    assert all(r.stats_status == "accepted" for r in state.snapshot().records)

    # Two 140-char NVL pages 2.5s apart
    state = TextCoordinatorState(skip_detection=True)
    ingest(state, "あ" * 140, 0.0)
    ingest(state, "い" * 140, 2.5)
    settle(state, 7.0)
    assert all(r.stats_status == "accepted" for r in state.snapshot().records)
