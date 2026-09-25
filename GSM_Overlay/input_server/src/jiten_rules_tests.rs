use super::*;

fn fixture_engine(rules: Value) -> Engine {
    Engine::load(
        &json!({ "notice": "GSM test fixture", "upstreamCommit": "test", "rules": rules })
            .to_string(),
    )
    .unwrap()
}

fn tokens(parts: &[(&str, &str, &str, &str)]) -> (String, Vec<Token>) {
    let mut text = String::new();
    let mut output = Vec::new();
    for (surface, headword, reading, pos) in parts {
        let start = text.len();
        text.push_str(surface);
        output.push(Token {
            surface: surface.to_string(),
            headword: headword.to_string(),
            normalized: headword.to_string(),
            reading: reading.to_string(),
            pos: vec![pos.to_string(), "*".into()],
            start,
            end: text.len(),
            pin: None,
            lookup_lemma: true,
            applied_rules: Vec::new(),
        });
    }
    (text, output)
}

#[test]
fn imported_rules_recut_boundaries_without_changing_text() {
    let (text, input) = tokens(&[
        ("主人", "主人", "シュジン", "名詞"),
        ("格", "格", "カク", "名詞"),
    ]);
    let output = apply(input, &text).unwrap();
    assert_eq!(
        output
            .iter()
            .map(|t| t.surface.as_str())
            .collect::<Vec<_>>(),
        ["主", "人格"]
    );
    assert_eq!(output[1].reading, "ジンカク");
    assert_eq!(output[1].pin.unwrap().word_id, 1366730);
    assert_eq!(output[1].pin.unwrap().reading_index, None);
    assert_eq!(&text[output[1].start..output[1].end], "人格");
}

#[test]
fn clause_context_distinguishes_listen_from_a_question() {
    let (text, input) = tokens(&[
        ("いい", "いい", "イイ", "形容詞"),
        ("か", "か", "カ", "助詞"),
        ("！", "！", "！", "補助記号"),
    ]);
    let output = apply(input.clone(), &text).unwrap();
    assert_eq!(output[0].surface, "いいか");
    assert_eq!(output[0].pin.unwrap().word_id, 2555520);
    let mut question = input;
    question[2].surface = "？".into();
    assert_eq!(apply(question, "いいか？").unwrap().len(), 3);
    let (text, input) = tokens(&[
        ("行って", "行く", "イッテ", "動詞"),
        ("いい", "いい", "イイ", "形容詞"),
        ("か", "か", "カ", "助詞"),
        ("！", "！", "！", "補助記号"),
    ]);
    assert_eq!(apply(input, &text).unwrap().len(), 4);
}

#[test]
fn negative_context_prevents_body_noun_from_being_split() {
    let (text, input) = tokens(&[
        ("いる", "いる", "イル", "動詞"),
        ("からだ", "体", "カラダ", "名詞"),
    ]);
    assert_eq!(
        apply(input, &text)
            .unwrap()
            .iter()
            .map(|t| t.surface.as_str())
            .collect::<Vec<_>>(),
        ["いる", "から", "だ"]
    );
    let (text, input) = tokens(&[
        ("いる", "いる", "イル", "動詞"),
        ("からだ", "体", "カラダ", "名詞"),
        ("を", "を", "ヲ", "助詞"),
    ]);
    assert_eq!(apply(input, &text).unwrap().len(), 3);
}

#[test]
fn pin_only_rewrite_does_not_trust_the_rejected_sudachi_lemma() {
    let (text, input) = tokens(&[("クズ", "葛", "クズ", "名詞")]);
    let output = apply(input, &text).unwrap();
    assert_eq!(output[0].pin.unwrap().word_id, 1246510);
    assert!(!output[0].lookup_lemma);
}

#[test]
fn a_pin_that_explicitly_confirms_the_lemma_keeps_it_for_anki_matching() {
    let (text, input) = tokens(&[("す", "する", "ス", "動詞"), ("ん", "ぬ", "ン", "助動詞")]);
    let output = apply(input, &text).unwrap();
    assert_eq!(output[0].pin.unwrap().word_id, 1157170);
    assert_eq!(output[0].pin.unwrap().reading_index, Some(1));
    assert!(output[0].lookup_lemma);
}

#[test]
fn window_condition_requires_nearby_evidence() {
    let (text, input) = tokens(&[
        ("被害", "被害", "ヒガイ", "名詞"),
        ("を", "を", "ヲ", "助詞"),
        ("被った", "被る", "カブッタ", "動詞"),
    ]);
    let output = apply(input, &text).unwrap();
    assert_eq!(output[2].pin.unwrap().word_id, 1484340);
    let (text, input) = tokens(&[
        ("帽子", "帽子", "ボウシ", "名詞"),
        ("を", "を", "ヲ", "助詞"),
        ("被った", "被る", "カブッタ", "動詞"),
    ]);
    assert_eq!(apply(input, &text).unwrap()[2].pin, None);
}

#[test]
fn absent_dictionary_guards_and_noncontiguous_spans_do_not_rewrite() {
    let (text, input) = tokens(&[
        ("こん", "こん", "コン", "連体詞"),
        ("なの", "なの", "ナノ", "助詞"),
    ]);
    assert_eq!(apply(input, &text).unwrap().len(), 2);
    let (_, mut input) = tokens(&[
        ("主人", "主人", "シュジン", "名詞"),
        ("格", "格", "カク", "名詞"),
    ]);
    input[1].start += 1;
    input[1].end += 1;
    assert_eq!(apply(input, "主人 格").unwrap()[0].surface, "主人");
}

#[test]
fn exact_rules_have_priority_and_a_phase_does_not_reprocess_its_output() {
    let engine = fixture_engine(json!([
        {"id":"residual", "phase":"Early", "match":[{"textStartsWith":"あ"}], "replace":[{"text":"", "dictForm":"residual"}]},
        {"id":"exact", "phase":"Early", "match":[{"textAnyOf":["あ", "い"]}], "replace":[{"text":"", "dictForm":"exact", "pin":123}]},
        {"id":"second", "phase":"Early", "match":[{"text":"あ", "requireUnpinned":false}], "replace":[{"text":"", "dictForm":"second"}]},
        {"id":"pinned", "phase":"Late", "match":[{"text":"あ"}], "replace":[{"text":"", "dictForm":"overwritten"}]}
    ]));
    let (text, input) = tokens(&[("あ", "あ", "ア", "感動詞")]);
    let output = engine.run_phase(input, &text, Phase::Early);
    assert_eq!(output[0].headword, "exact");
    let output = engine.run_phase(output, &text, Phase::Late);
    assert_eq!(output[0].headword, "exact");
    assert_eq!(output[0].applied_rules, ["exact"]);
}

#[test]
fn reading_and_normalized_form_constraints_are_conjunctive() {
    let engine = fixture_engine(json!([{ "id":"constrained", "phase":"Early",
        "match":[{"textEndsWith":"事", "pos":["Noun"], "dictFormAnyOf":["事"],
            "normalizedFormAnyOf":["事"], "readingPrefix":"ゴ", "notReadingPrefix":"ゴトウ"}],
        "replace":[{"text":"", "dictForm":"こと"}]
    }]));
    let (text, input) = tokens(&[("事", "事", "ゴト", "名詞")]);
    assert_eq!(
        engine.run_phase(input.clone(), &text, Phase::Early)[0].headword,
        "こと"
    );
    for (reading, normalized) in [("コト", "事"), ("ゴトウ", "事"), ("ゴト", "別")] {
        let mut input = input.clone();
        input[0].reading = reading.into();
        input[0].normalized = normalized.into();
        assert!(engine.run_phase(input, &text, Phase::Early)[0]
            .applied_rules
            .is_empty());
    }
}

#[test]
fn unavailable_dictionary_is_unknown_even_for_absence_guards() {
    for kind in [
        "CompoundExists",
        "NonNameCompoundExists",
        "CompoundAbsent",
        "FrequencyRankUnder",
    ] {
        let engine = fixture_engine(
            json!([{ "id":"guard", "phase":"Early", "match":[{"text":"あ"}],
            "replace":[{"text":"", "dictForm":"changed"}], "guard":{"kind":kind,"pattern":"{0}","rank":1000} }]),
        );
        let (text, input) = tokens(&[("あ", "あ", "ア", "感動詞")]);
        assert!(engine.run_phase(input, &text, Phase::Early)[0]
            .applied_rules
            .is_empty());
    }
}

#[test]
fn malformed_rewrites_cannot_replace_or_drop_original_characters() {
    for outputs in [
        json!([{"text":"別", "reading":"ベツ"}]),
        json!([{"text":"あ", "reading":"ア"}]),
    ] {
        let engine = fixture_engine(
            json!([{ "id":"bad-output", "phase":"Early", "match":[{"text":"あい"}], "replace":outputs }]),
        );
        let (text, input) = tokens(&[("あい", "あい", "アイ", "名詞")]);
        let output = engine.run_phase(input, &text, Phase::Early);
        assert_eq!(output[0].surface, "あい");
        assert!(output[0].applied_rules.is_empty());
    }
    assert!(Engine::load(r#"{"notice":"test","upstreamCommit":"test","rules":[{"id":"x","phase":"Early","match":[{"unknownConstraint":true}],"replace":[{"text":""}]}]}"#).is_err());
}

#[test]
fn rule_metadata_identifies_the_import_and_its_limits() {
    let metadata = metadata().unwrap();
    assert_eq!(metadata["importedRules"], 133);
    assert_eq!(metadata["enabledRules"], 128);
    assert_eq!(
        metadata["unavailableDictionaryRules"],
        json!(["kariru", "konna-no", "sonna-no", "anna-no", "donna-no"])
    );
}
