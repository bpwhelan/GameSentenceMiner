use gsm_mining::{
    clips::{find_saved_folder, ClipWindow},
    text::GameLine,
};
use serde_json::json;
use std::fs;

fn line(id: &str, time: f64) -> GameLine {
    serde_json::from_value(json!({"id":id,"text":id,"time_epoch":time})).unwrap()
}

#[test]
fn recording_window_waits_for_context_and_clamps_to_the_replay() {
    let mut w = ClipWindow {
        selected: line("選", 100.),
        before: vec![line("前", 93.)],
        after: vec![],
    };
    assert_eq!(w.wait_seconds(100.), 20.);
    w.after = vec![line("次", 104.), line("終", 106.)];
    assert_eq!(w.wait_seconds(105.), 3.);
    assert_eq!(w.offsets(110., 15.).unwrap(), (0., 13.));
    assert!(w.offsets(130., 15.).is_err());
    assert_eq!(w.entries(95., 100.).len(), 1);
}

#[test]
fn finds_legacy_manifest_by_selected_id_only() {
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().join("2026-11-21").join("01-02-03-456_台詞");
    fs::create_dir_all(&folder).unwrap();
    fs::write(
        folder.join("manifest.json"),
        r#"{"lines":[{"role":"previous","id":"context"},{"role":"selected","id":"saved"}]}"#,
    )
    .unwrap();
    assert_eq!(find_saved_folder(root.path(), "saved"), Some(folder));
    assert!(find_saved_folder(root.path(), "context").is_none());
}
