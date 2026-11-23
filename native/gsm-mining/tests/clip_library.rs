use gsm_mining::clips::{catalog, ClipFolders};
use serde_json::json;
use std::fs;

#[test]
fn catalogue_orders_clips_and_handles_missing_media_and_malformed_manifests() {
    let root = tempfile::tempdir().unwrap();
    for (id, text) in [
        ("a/one", "古い"),
        ("b/two", "新しい"),
        ("b/unreadable", "broken"),
    ] {
        let folder = root.path().join(id);
        fs::create_dir_all(&folder).unwrap();
        let manifest = json!({"clip":{"file":"clip.mkv","end_time":"2026-09-01T00:00:05"},
            "lines":[{"id":"previous","role":"previous","time":"2026-09-01T00:00:00","text":"前"},
            {"id":"selected","role":"selected","time":"2026-09-01T00:00:02","text":text}]});
        fs::write(
            folder.join("manifest.json"),
            if text == "broken" {
                String::from("{}")
            } else {
                manifest.to_string()
            },
        )
        .unwrap();
    }
    fs::write(root.path().join("a/one/clip.mkv"), b"abcd").unwrap();
    let result = catalog(Some(root.path()));
    assert_eq!(
        result,
        json!({"clips":[{"id":"b/two","size_bytes":0,"lines":[{"id":"selected","text":"新しい"}]},
        {"id":"a/one","size_bytes":4,"lines":[{"id":"selected","text":"古い"}]}]})
    );
    assert!(catalog(None)["error"].is_string());
    let library = ClipFolders::open(root.path()).unwrap();
    assert!(library.resolve("b/two").is_some());
    for invalid in [
        "",
        ".",
        "..",
        "../outside",
        "b",
        "b/../b/two",
        "b/two/child",
        "b/missing",
        "/outside",
        "C:/outside",
    ] {
        assert!(library.resolve(invalid).is_none(), "{invalid}");
    }
}
