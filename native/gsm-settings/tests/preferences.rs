use gsm_settings::{preferences::Preferences, write_atomic};
use serde_json::json;
#[test]
fn patches_preserve_unrelated_values_and_distinguish_null_from_missing() {
    let dir = tempfile::tempdir().unwrap();
    let store = Preferences::new(dir.path());
    let original = json!({"OCR":{"ocr1":"custom","future":42},"unknown":[1,2],"nullable":null});
    write_atomic(&store.file, &original).unwrap();
    let before = std::fs::read(&store.file).unwrap();
    assert_eq!(store.get("nullable").unwrap(), Some(json!(null)));
    assert_eq!(store.get("missing").unwrap(), None);
    assert_eq!(std::fs::read(&store.file).unwrap(), before);
    store
        .patch(&json!({"OCR.ocr1":"oneocr","autoUpdateTexthook":false}))
        .unwrap();
    assert_eq!(store.get("OCR.future").unwrap(), Some(json!(42)));
    assert_eq!(store.get("unknown").unwrap(), Some(json!([1, 2])));
    store.delete("OCR.ocr1").unwrap();
    assert_eq!(store.get("OCR.future").unwrap(), Some(json!(42)));
}
#[test]
fn simultaneous_native_clients_do_not_lose_independent_edits() {
    let dir = tempfile::tempdir().unwrap();
    std::thread::scope(|scope| {
        for i in 0..20 {
            let root = dir.path();
            scope.spawn(move || {
                Preferences::new(root)
                    .patch(&json!({format!("group.key{i}"):i}))
                    .unwrap();
            });
        }
    });
    assert_eq!(
        Preferences::new(dir.path()).snapshot().unwrap()["group"]
            .as_object()
            .unwrap()
            .len(),
        20
    );
}
#[test]
fn invalid_patch_and_damaged_documents_are_left_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let store = Preferences::new(dir.path());
    write_atomic(&store.file, &json!({"saved":true})).unwrap();
    let before = std::fs::read(&store.file).unwrap();
    assert!(store.patch(&json!({"valid":1,"__proto__.x":2})).is_err());
    assert_eq!(std::fs::read(&store.file).unwrap(), before);
    std::fs::write(&store.file, b"{damaged").unwrap();
    assert!(store.patch(&json!({"saved":false})).is_err());
    assert_eq!(std::fs::read(&store.file).unwrap(), b"{damaged");
}
