use gsm_intake::{Clock, Policy, Stream};
use serde_json::json;

#[test]
fn every_source_shares_receipts_and_history_and_speech_revises_in_place() {
    let mut stream = Stream::default();
    let policy = Policy::default();
    let mut events = Vec::new();
    for (i, (source, text, expected)) in [
        ("clipboard", "こんにちは", "accepted"),
        ("ocr", "こんにちは", "duplicate"),
        ("websocket", "明日は晴れる。", "accepted"),
        ("speech", "また", "accepted"),
        ("speech", "また明日", "accepted"),
        ("manual", "違う文章", "accepted"),
    ]
    .iter()
    .enumerate()
    {
        let payload = json!({"source":source,"text":text,"observationId":i.to_string(),"revisionWindowMs":1000});
        let now = Clock::at(i as i64 * 10_000_000);
        let ack = stream.ingest(&payload, &policy, now, &mut events);
        assert_eq!(ack["status"], *expected);
        assert_eq!(
            stream.ingest(&payload, &policy, now, &mut events)["status"],
            "duplicate"
        );
    }
    stream.maintain(Clock::at(3_000_000_000), 60, &mut events);
    let snapshot = stream.snapshot(None);
    let rows = snapshot["records"].as_array().unwrap();
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[2]["revision"], 4); // speech revision, freeze, stats commit
    assert_eq!(rows[2]["state"], "frozen");
    assert_eq!(rows[2]["text"], "また明日");
    assert_eq!(rows[2]["observation_ids"], json!(["3", "4"]));
}

#[test]
fn guard_counts_characters_and_rejects_quote_backlogs_even_beyond_limit() {
    let policy: Policy = serde_json::from_value(json!({"max_chars":2})).unwrap();
    let mut stream = Stream::default();
    let mut events = Vec::new();
    let now = Clock::at(0);
    assert_eq!(
        stream.ingest(&json!({"text":"😀猫a"}), &policy, now, &mut events)["raw_text"],
        "😀猫"
    );
    assert_eq!(
        stream.ingest(
            &json!({"text":format!("abc{}", "「」".repeat(11))}),
            &policy,
            now,
            &mut events
        )["status"],
        "rejected"
    );
}

#[test]
fn profile_changes_invalidate_filters_and_pause_is_applied_before_acceptance() {
    let mut s = Stream::default();
    let mut e = Vec::new();
    let mut p = Policy::default();
    let line = json!({"text":"","sentence":"abc","source":"manual","observationId":"one"});
    p.processing=json!({"processor_order":["string_replacement"],"string_replacement":{"enabled":true,"rules":[{"find":"abc","replace":"first"}]}}).into();
    assert_eq!(
        s.ingest(&line, &p, Clock::at(1), &mut e)["processed_text"],
        "first"
    );
    p.processing = json!({"processor_order":[]}).into();
    p.paused = true;
    let next = json!({"text":"abc","source":"manual","observationId":"two"});
    assert_eq!(
        s.ingest(&next, &p, Clock::at(3), &mut e)["processed_text"],
        "abc"
    );
    let snapshot = s.snapshot(Some(1));
    assert_eq!(snapshot["records"][0]["relay_only"], true);
    assert_eq!(snapshot["records"][0]["excluded_from_stats"], true);
}

#[test]
fn late_speech_freezes_without_a_projection_poll() {
    let mut s = Stream::default();
    let mut e = Vec::new();
    let p = Policy::default();
    let first = s.ingest(
        &json!({"text":"one","source":"speech","revisionWindowMs":10}),
        &p,
        Clock::at(1),
        &mut e,
    );
    let next = s.ingest(
        &json!({"text":"two","source":"speech"}),
        &p,
        Clock::at(20_000_000),
        &mut e,
    );
    assert_ne!(first["line_id"], next["line_id"]);
    assert_eq!(s.snapshot(None)["records"][0]["state"], "frozen");
}

#[test]
fn internal_sources_preserve_labels_and_capture_metadata() {
    let mut stream = Stream::default();
    let policy = Policy::default();
    for (i, (name, kind)) in [
        ("luna", "texthook"),
        ("OCR", "ocr"),
        ("ocr_manual", "ocr_manual"),
        ("screen_cropper", "screen_cropper"),
        ("secondary", "secondary"),
        ("hotkey", "hotkey"),
        ("overlay", "overlay"),
        ("manual", "manual"),
        ("windows-speech", "speech_recognition"),
    ]
    .into_iter()
    .enumerate()
    {
        let payload = json!({"source":name, "text":format!("line {i}"), "sourceDisplayName":"Game input",
            "capturedAt":"2026-11-20T12:00:00Z","dict_from_ocr":{"x":23}});
        let ack = stream.ingest(
            &payload,
            &policy,
            Clock::at(i as i64 * 6_000_000_000),
            &mut Vec::new(),
        );
        assert_eq!(ack["status"], "accepted");
        let snapshot = stream.snapshot(Some(1));
        let record = &snapshot["records"][0];
        assert_eq!(record["source_kind"], kind);
        assert_eq!(record["source_display_name"], "Game input");
        assert_eq!(record["metadata"]["dict_from_ocr"]["x"], 23);
        assert_eq!(record["captured_at_utc"], "2026-11-20T12:00:00Z");
    }
}

#[test]
fn exclusions_are_per_game_and_ocr_benchmark_samples_precede_filtering() {
    let mut stream = Stream::default();
    let mut p = Policy {
        scene: "A".into(),
        benchmark: true,
        ..Default::default()
    };
    p.exclusions
        .insert("A".into(), ["first\nsecond".to_owned()].into());
    let payload = json!({"source":"ocr","text":"first\r\nsecond","observationId":"ocr"});
    let mut events = Vec::new();
    assert_eq!(
        stream.ingest(&payload, &p, Clock::at(1), &mut events)["reason"],
        "sentence excluded for this game"
    );
    assert!(events.is_empty());
    p.scene = "B".into();
    assert_eq!(
        stream.ingest(&payload, &p, Clock::at(2), &mut events)["reason"],
        "automatic OCR recorded for benchmark"
    );
    assert!(matches!(
        events.as_slice(),
        [gsm_intake::Event::Benchmark(_)]
    ));
    assert_eq!(stream.snapshot(None)["records"], json!([]));
    p.benchmark = false;
    assert_eq!(
        stream.ingest(&payload, &p, Clock::at(3), &mut events)["status"],
        "accepted"
    );
}
