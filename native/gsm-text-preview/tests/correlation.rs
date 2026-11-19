use gsm_text_preview::correlation::{classify, Decision, Incoming, Line, Windows};

#[test]
fn preserves_source_specific_suffix_and_open_speech_after_another_line() {
    let windows = Windows {
        same_ns: 2_000_000_000,
        cross_ns: 5_000_000_000,
        similarity: 70.0,
    };
    let line = Line {
        text: "昨日",
        source: "ocr",
        instance: "A",
        scene: "game",
        first_ns: 10,
        relay: false,
        frozen: true,
        skipped: false,
    };
    let input = Incoming {
        text: "昨日\u{1c}明日",
        source: "ocr",
        instance: "A",
        scene: "game",
        now_ns: 20,
        relay: false,
        prefix: true,
        merge: false,
        final_speech: false,
        landing: false,
    };
    assert_eq!(
        classify(
            &input,
            Some(&line),
            None,
            Some(("昨日", true)),
            None,
            &windows
        ),
        Decision::Append(Some("明日"))
    );
    let speech = Line {
        text: "good morning",
        source: "speech_recognition",
        frozen: false,
        ..line
    };
    let input = Incoming {
        text: "good",
        source: "speech_recognition",
        merge: true,
        ..input
    };
    assert_eq!(
        classify(&input, Some(&line), Some(&speech), None, Some(20), &windows),
        Decision::ShorterSpeech
    );
}
