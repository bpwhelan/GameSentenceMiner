use gsm_text_preview::HookFinder;
use serde_json::Value;

#[test]
fn matches_python_hook_finder_results() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/hook_ranking.json")).unwrap();
    for case in cases {
        let blocks: Vec<String> = serde_json::from_value(case["blocks"].clone()).unwrap();
        let profile = tempfile::tempdir().unwrap();
        std::fs::write(profile.path().join("config.json"), serde_json::json!({
            "current_profile": "Default", "configs": {"Default": {
                "text_processing": case["settings"], "general": {"target_language": case["language"]}
            }}
        }).to_string()).unwrap();
        let result = HookFinder::new(profile.path().to_owned())
            .rank(&case["snapshot"], &blocks, || false)
            .unwrap();
        assert_eq!(result, case["expected"], "{}", case["name"]);
    }
}

#[test]
fn stops_a_cancelled_filter_search() {
    let checks = std::cell::Cell::new(0);
    let profile = tempfile::tempdir().unwrap();
    let error = HookFinder::new(profile.path().to_owned())
        .rank(
            &serde_json::json!({"hooks":[{"id":"1", "samples":["<long-tag>日本語</long-tag>"]}]}),
            &["日本語".to_string()],
            || {
                checks.set(checks.get() + 1);
                checks.get() > 12
            },
        )
        .unwrap_err();
    assert!(error.contains("cancelled"));
}
