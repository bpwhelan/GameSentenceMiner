use gsm_settings::{profiles::Profiles, read_object, write_atomic};
use serde_json::json;

#[cfg(windows)]
#[test]
fn atomic_write_survives_a_short_lived_windows_reader() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("manifest.json");
    write_atomic(&path, &json!({"version": 1})).unwrap();
    let reader = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(&path)
        .unwrap();
    std::thread::scope(|scope| {
        scope.spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(120));
            drop(reader);
        });
        write_atomic(&path, &json!({"version": 2})).unwrap();
    });
    assert_eq!(read_object(&path).unwrap()["version"], 2);
}

#[test]
fn preserves_every_unedited_field_and_read_is_byte_identical() {
    let dir = tempfile::tempdir().unwrap();
    let profiles = Profiles::new(dir.path());
    let original = json!({"Game.EXE":{"exeName":"Game.EXE","engine":"mages","future":{"x":1}},"broken":"retain", "other.exe":{"exeName":"other.exe","unknown":42}});
    write_atomic(&profiles.file, &original).unwrap();
    let bytes = std::fs::read(&profiles.file).unwrap();
    assert_eq!(profiles.get("GAME.EXE", None).unwrap()["engine"], "mages");
    assert_eq!(std::fs::read(&profiles.file).unwrap(), bytes);
    profiles
        .upsert(json!({"exeName":"other.exe","flushDelayMs":250}))
        .unwrap();
    let saved = read_object(&profiles.file).unwrap();
    assert_eq!(saved["Game.EXE"], original["Game.EXE"]);
    assert_eq!(saved["broken"], "retain");
    assert_eq!(saved["other.exe"]["unknown"], 42);
}
#[test]
fn damaged_document_cannot_be_replaced_by_a_profile_edit() {
    let dir = tempfile::tempdir().unwrap();
    let profiles = Profiles::new(dir.path());
    std::fs::create_dir_all(profiles.file.parent().unwrap()).unwrap();
    std::fs::write(&profiles.file, b"{broken").unwrap();
    assert!(profiles.upsert(json!({"exeName":"new.exe"})).is_err());
    assert_eq!(std::fs::read(&profiles.file).unwrap(), b"{broken");
}
#[test]
fn scene_identity_and_parallel_writes_survive() {
    let dir = tempfile::tempdir().unwrap();
    std::thread::scope(|scope| {
        for i in 0..12 {
            let path = dir.path();
            scope.spawn(move || {
                Profiles::new(path)
                    .upsert(json!({"exeName":"game.exe","sceneId":format!("s{i}")}))
                    .unwrap();
            });
        }
    });
    let profiles = Profiles::new(dir.path());
    assert_eq!(profiles.list().unwrap().as_object().unwrap().len(), 12);
    assert!(profiles.get("game.exe", None).unwrap().is_null());
    profiles.delete("game.exe", Some("S3")).unwrap();
    assert_eq!(profiles.list().unwrap().as_object().unwrap().len(), 11);
}
