import json

from GameSentenceMiner.ocr.auto_regions import (
    AutoRegionManager,
    LineObservation,
    NormalizedRect,
)
from GameSentenceMiner.owocr.owocr import ocr_runtime


def _line(text: str, x=0.25, y=0.78, w=0.5, h=0.08) -> LineObservation:
    return LineObservation(text=text, rect=NormalizedRect(x, y, w, h))


def test_changing_text_confirms_a_region_but_static_hud_does_not(tmp_path):
    manager = AutoRegionManager(
        scene="test",
        language="ja",
        state_path=tmp_path / "test_auto_regions.json",
    )

    for frame, dialogue in enumerate(("これは最初の台詞です", "これは次の台詞です", "さらに別の台詞です"), start=1):
        decision = manager.observe(
            [
                _line(dialogue),
                _line("ミニマップ", x=0.85, y=0.05, w=0.12, h=0.04),
            ],
            frame_id=frame,
            discovery=True,
        )

    assert decision.phase == "active"
    assert decision.accepted_indexes == [0]
    assert len(manager.learned_regions) == 1
    assert manager.learned_regions[0].contains_point(0.5, 0.82)
    assert not manager.learned_regions[0].contains_point(0.9, 0.07)


def test_static_text_never_confirms_even_after_many_frames(tmp_path):
    manager = AutoRegionManager("test", "ja", tmp_path / "state.json")

    for frame in range(1, 12):
        decision = manager.observe(
            [_line("常時表示される案内", x=0.8, y=0.05, w=0.18, h=0.04)],
            frame_id=frame,
            discovery=True,
        )

    assert decision.phase == "learning"
    assert decision.accepted_indexes == []
    assert manager.learned_regions == []


def test_changing_short_ui_labels_do_not_confirm_a_region(tmp_path):
    manager = AutoRegionManager("test", "ja", tmp_path / "state.json")

    for frame, label in enumerate(("地図", "設定", "装備", "保存"), start=1):
        manager.observe(
            [_line(label, x=0.8, y=0.05, w=0.1, h=0.04)],
            frame_id=frame,
            discovery=True,
        )

    assert manager.phase == "learning"
    assert manager.learned_regions == []


def test_green_hint_is_immediately_accepted_and_can_be_deactivated(tmp_path):
    hint = NormalizedRect(0.05, 0.05, 0.25, 0.12)
    manager = AutoRegionManager("test", "ja", tmp_path / "state.json", primary_hints=[hint])

    first = manager.observe(
        [_line("ヒント内の台詞です", x=0.08, y=0.07, w=0.18, h=0.06)],
        frame_id=1,
        discovery=True,
    )
    assert first.accepted_indexes == [0]

    # Confirm a better region while the hinted location remains empty.
    for frame in range(2, 35):
        text = f"別の場所に表示される台詞{frame}"
        manager.observe([_line(text)], frame_id=frame, discovery=True)

    assert manager.learned_regions
    assert hint not in manager.effective_regions


def test_purple_lines_are_not_learned_or_emitted(tmp_path):
    purple = NormalizedRect(0.1, 0.7, 0.8, 0.25)
    manager = AutoRegionManager("test", "ja", tmp_path / "state.json", secondary_regions=[purple])

    for frame, text in enumerate(("メニュー項目一", "メニュー項目二", "メニュー項目三"), start=1):
        decision = manager.observe([_line(text)], frame_id=frame, discovery=True)

    assert decision.accepted_indexes == []
    assert manager.learned_regions == []


def test_black_hole_frame_does_not_contribute_evidence(tmp_path):
    black_hole = NormalizedRect(0.75, 0.05, 0.2, 0.15)
    manager = AutoRegionManager("test", "ja", tmp_path / "state.json", black_holes=[black_hole])

    decision = manager.observe(
        [
            _line("本来なら学習される台詞です"),
            _line("設定", x=0.8, y=0.08, w=0.1, h=0.05),
        ],
        frame_id=1,
        discovery=True,
    )

    assert decision.vetoed
    assert decision.accepted_indexes == []
    assert manager.observation_count == 0


def test_dense_text_above_dialogue_recommends_a_secondary_area(tmp_path):
    dialogue = NormalizedRect(0.08, 0.72, 0.84, 0.22)
    manager = AutoRegionManager(
        "test",
        "ja",
        tmp_path / "state.json",
        primary_hints=[dialogue],
    )

    decision = manager.observe(
        [
            _line("古代の王国には忘れられた伝承がありました", x=0.18, y=0.18, w=0.62, h=0.045),
            _line("その記録は長い年月の間ひそかに守られていました", x=0.18, y=0.24, w=0.66, h=0.045),
            _line("しかし災厄の日に多くの書物が失われました", x=0.18, y=0.30, w=0.61, h=0.045),
            _line("残された断片だけが真実への道を示しています", x=0.18, y=0.36, w=0.63, h=0.045),
            _line("会話文はここに表示されます", x=0.16, y=0.78, w=0.68, h=0.06),
        ],
        frame_id=1,
        discovery=True,
    )

    assert decision.accepted_indexes == [4]
    assert manager.learned_regions == []
    assert manager.status()["recommendations"] == [
        {
            "id": manager.status()["recommendations"][0]["id"],
            "kind": "secondary",
            "reason": "dense_text",
            "confidence": 1.0,
            "line_count": 4,
        }
    ]


def test_two_long_lines_do_not_trigger_a_lore_recommendation(tmp_path):
    manager = AutoRegionManager(
        "test",
        "ja",
        tmp_path / "state.json",
        primary_hints=[NormalizedRect(0.08, 0.72, 0.84, 0.22)],
    )

    manager.observe(
        [
            _line("これは比較的長い説明文の一行目です", x=0.2, y=0.2, w=0.6, h=0.05),
            _line("しかし二行だけでは通常の字幕かもしれません", x=0.2, y=0.27, w=0.6, h=0.05),
        ],
        frame_id=1,
        discovery=True,
    )

    assert manager.status()["recommendations"] == []


def test_recurring_stacked_short_labels_recommend_a_black_hole(tmp_path):
    manager = AutoRegionManager(
        "test",
        "ja",
        tmp_path / "state.json",
        primary_hints=[NormalizedRect(0.08, 0.72, 0.84, 0.22)],
    )

    for frame in range(1, 4):
        decision = manager.observe(
            [
                _line("装備", x=0.68, y=0.18, w=0.12, h=0.04),
                _line("道具", x=0.68, y=0.25, w=0.12, h=0.04),
                _line("技能", x=0.68, y=0.32, w=0.12, h=0.04),
                _line("設定", x=0.68, y=0.39, w=0.12, h=0.04),
                _line(f"会話文はフレーム{frame}です", x=0.16, y=0.78, w=0.68, h=0.06),
            ],
            frame_id=frame,
            discovery=True,
        )

    recommendations = manager.status()["recommendations"]
    assert len(recommendations) == 1
    assert recommendations[0]["kind"] == "black_hole"
    assert recommendations[0]["reason"] == "recurring_ui"
    assert recommendations[0]["line_count"] == 4
    assert decision.accepted_indexes == [4]


def test_one_recurring_hud_label_does_not_recommend_a_black_hole(tmp_path):
    manager = AutoRegionManager("test", "ja", tmp_path / "state.json")

    for frame in range(1, 8):
        manager.observe(
            [_line("地図", x=0.85, y=0.05, w=0.08, h=0.03)],
            frame_id=frame,
            discovery=True,
        )

    assert manager.status()["recommendations"] == []


def test_reset_clears_area_recommendations(tmp_path):
    manager = AutoRegionManager(
        "test",
        "ja",
        tmp_path / "state.json",
        primary_hints=[NormalizedRect(0.08, 0.72, 0.84, 0.22)],
    )
    manager.observe(
        [
            _line("古代の王国には忘れられた伝承がありました", x=0.18, y=0.18, w=0.62, h=0.045),
            _line("その記録は長い年月の間ひそかに守られていました", x=0.18, y=0.24, w=0.66, h=0.045),
            _line("しかし災厄の日に多くの書物が失われました", x=0.18, y=0.30, w=0.61, h=0.045),
            _line("残された断片だけが真実への道を示しています", x=0.18, y=0.36, w=0.63, h=0.045),
        ],
        frame_id=1,
        discovery=True,
    )
    assert manager.status()["recommendations"]

    manager.reset()

    assert manager.status()["recommendations"] == []


def test_large_learned_region_thrashing_is_suppressed_and_recommends_black_hole(tmp_path):
    state_path = tmp_path / "state.json"
    state_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "scene": "test",
                "aspect_ratio": 16 / 9,
                "regions": [
                    {
                        "rect": [0.02, 0.08, 0.96, 0.84],
                        "confidence": 1.0,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    manager = AutoRegionManager(
        "test",
        "ja",
        state_path,
        aspect_ratio=16 / 9,
    )
    anchors = [
        _line("２０コイン", x=0.10, y=0.86, w=0.12, h=0.04),
        _line("履歴を表示", x=0.48, y=0.86, w=0.14, h=0.04),
        _line("目標マーカーの非表示", x=0.65, y=0.86, w=0.22, h=0.04),
    ]
    dense_frames = [
        [
            _line("ハブロックたちに裏切られたあなたは廃虚で目を覚ました", x=0.58, y=0.48, w=0.34, h=0.05),
            _line("暗殺者があなたをかくまい装備品を取り戻すよう告げた", x=0.58, y=0.54, w=0.34, h=0.05),
            _line("浸水地区から抜け出る方法を見つけなければならない", x=0.58, y=0.60, w=0.34, h=0.05),
            _line("グリーブス精製所に戻り任務を完了しよう", x=0.20, y=0.66, w=0.38, h=0.05),
        ],
        [],
        [],
        [],
        [],
    ]

    for frame, dense_lines in enumerate(dense_frames, start=1):
        decision = manager.observe(
            [*dense_lines, *anchors],
            frame_id=frame,
            discovery=False,
        )

    assert decision.accepted_indexes == []
    assert decision.suppressed_reason == "unstable_large_text"
    assert manager.status()["thrashing"] is True
    recommendations = manager.status()["recommendations"]
    assert len(recommendations) == 1
    assert recommendations[0]["kind"] == "black_hole"
    assert recommendations[0]["reason"] == "unstable_large_text"

    # Once the persistent menu anchors disappear for two frames, normal OCR
    # resumes automatically instead of leaving the scene permanently muted.
    dialogue = [_line("通常の会話に戻りました", x=0.20, y=0.78, w=0.50, h=0.06)]
    first_dialogue = manager.observe(dialogue, frame_id=6, discovery=False)
    second_dialogue = manager.observe(dialogue, frame_id=7, discovery=False)

    assert first_dialogue.suppressed_reason == "unstable_large_text"
    assert second_dialogue.suppressed_reason is None
    assert second_dialogue.accepted_indexes == [0]
    assert manager.status()["thrashing"] is False


def test_strong_single_candidate_can_emit_during_cold_start(tmp_path):
    manager = AutoRegionManager("test", "ja", tmp_path / "state.json")

    decision = manager.observe(
        [
            _line("十分に長い単独の台詞候補です"),
            _line("短文", x=0.85, y=0.05, w=0.08, h=0.03),
        ],
        frame_id=1,
        discovery=True,
    )

    assert decision.accepted_indexes == [0]
    assert decision.phase == "learning"


def test_state_round_trip_persists_regions_without_raw_text(tmp_path):
    state_path = tmp_path / "test_auto_regions.json"
    manager = AutoRegionManager("test", "ja", state_path)
    for frame, text in enumerate(("最初の文章です", "次の文章です", "三番目の文章です"), start=1):
        manager.observe([_line(text)], frame_id=frame, discovery=True)
    manager.save()

    raw = state_path.read_text(encoding="utf-8")
    assert "最初の文章です" not in raw
    assert json.loads(raw)["schema_version"] == 1

    restored = AutoRegionManager("test", "ja", state_path)
    assert restored.phase == "active"
    assert restored.learned_regions == manager.learned_regions

    restored.observe(
        [_line("再起動後の最初の文章です", x=0.1, y=0.1, w=0.3, h=0.08)],
        frame_id="after-restart",
        discovery=True,
    )
    assert restored.phase == "active"
    assert restored.learned_regions == manager.learned_regions


def test_aspect_ratio_change_invalidates_saved_regions(tmp_path):
    state_path = tmp_path / "test_auto_regions.json"
    manager = AutoRegionManager("test", "ja", state_path, aspect_ratio=16 / 9)
    for frame, text in enumerate(("最初の文章です", "次の文章です", "三番目の文章です"), start=1):
        manager.observe([_line(text)], frame_id=frame, discovery=True)
    manager.save()

    restored = AutoRegionManager("test", "ja", state_path, aspect_ratio=4 / 3)
    assert restored.phase == "learning"
    assert restored.learned_regions == []


def test_corrupt_state_falls_back_to_learning(tmp_path):
    state_path = tmp_path / "test_auto_regions.json"
    state_path.write_text("not json", encoding="utf-8")

    manager = AutoRegionManager("test", "ja", state_path)

    assert manager.phase == "learning"
    assert manager.learned_regions == []


def test_runtime_filter_maps_source_coordinates_and_keeps_hint_lines(monkeypatch, tmp_path):
    manager = AutoRegionManager(
        "test",
        "ja",
        tmp_path / "state.json",
        primary_hints=[NormalizedRect(0.1, 0.65, 0.8, 0.3)],
    )
    monkeypatch.setattr(ocr_runtime, "auto_region_manager", manager)

    result = ocr_runtime.apply_auto_ocr_region_filter(
        "下側の会話です\nミニマップ",
        [],
        [
            (95, 695, 905, 905, "下側の会話です"),
            (795, 45, 955, 105, "ミニマップ"),
        ],
        (95, 45, 955, 905),
        {"raw": "must not escape"},
        crop_offset=(0, 0),
        original_width=1000,
        original_height=1000,
        frame_id=1,
        discovery=True,
    )

    text, _coords, crop_coords_list, crop_coords, raw_response, decision = result
    assert text == "下側の会話です"
    assert crop_coords_list == [(95, 695, 905, 905, "下側の会話です")]
    assert crop_coords == (95, 695, 905, 905)
    assert raw_response is None
    assert decision.accepted_indexes == [0]


def test_runtime_filter_drops_a_frame_from_the_previous_scene(monkeypatch, tmp_path):
    manager = AutoRegionManager("new-scene", "ja", tmp_path / "state.json")
    monkeypatch.setattr(ocr_runtime, "auto_region_manager", manager)

    result = ocr_runtime.apply_auto_ocr_region_filter(
        "前のシーンの文章です",
        [],
        [(95, 695, 905, 905, "前のシーンの文章です")],
        (95, 695, 905, 905),
        None,
        crop_offset=(0, 0),
        original_width=1000,
        original_height=1000,
        frame_id=1,
        discovery=True,
        expected_scene="old-scene",
    )

    assert result[:5] == ("", [], [], None, None)
    assert manager.observation_count == 0
