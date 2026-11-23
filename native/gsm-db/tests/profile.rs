use chrono::NaiveDate;
use gsm_db::profile::{daily_backup, manual_backup, recover_legacy_database};
use rusqlite::Connection;
use std::{fs, path::Path};
use tempfile::tempdir;

fn stored(path: &Path) -> String {
    Connection::open(path)
        .unwrap()
        .query_row("SELECT text FROM lines", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn recovery_preserves_wal_archive_pointer_and_later_edits() {
    let root = tempdir().unwrap();
    let target = root.path().join("selected");
    fs::create_dir(&target).unwrap();
    let pointer = root.path().join("data_dir.json");
    gsm_settings::write_atomic(
        &pointer,
        &serde_json::json!({
            "version": 2, "dataDir": target, "legacyDatabaseDir": root.path(), "extra":"keep"
        }),
    )
    .unwrap();
    let source = root.path().join("gsm.db");
    let dest = target.join("gsm.db");
    fs::write(&dest, "archived verbatim").unwrap();
    fs::write(&source, "corrupt").unwrap();
    assert!(recover_legacy_database(&pointer, &target, true).is_ok());
    assert!(recover_legacy_database(&pointer, &target, false).is_err());
    assert_eq!(fs::read(&dest).unwrap(), b"archived verbatim");
    assert!(gsm_settings::read_object(&pointer)
        .unwrap()
        .get("legacyDatabaseDir")
        .is_some());
    fs::remove_file(&source).unwrap();
    let conn = Connection::open(&source).unwrap();
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; CREATE TABLE lines(text); INSERT INTO lines VALUES('WAL');",
    )
    .unwrap();
    let recovered = std::thread::scope(|scope| {
        let other = scope.spawn(|| recover_legacy_database(&pointer, &target, false).unwrap());
        usize::from(recover_legacy_database(&pointer, &target, false).unwrap())
            + usize::from(other.join().unwrap())
    });
    assert_eq!(recovered, 1);
    assert_eq!(stored(&dest), "WAL");
    let mut archives = fs::read_dir(target.join("backup/data-directory-migration")).unwrap();
    assert_eq!(
        fs::read(archives.next().unwrap().unwrap().path().join("gsm.db")).unwrap(),
        b"archived verbatim"
    );
    assert!(archives.next().is_none());
    assert_eq!(
        gsm_settings::read_object(&pointer).unwrap(),
        serde_json::json!({"version":2,"dataDir":target,"extra":"keep"})
    );
    Connection::open(&dest)
        .unwrap()
        .execute("UPDATE lines SET text='new'", [])
        .unwrap();
    assert!(!recover_legacy_database(&pointer, &target, false).unwrap());
    assert_eq!(stored(&dest), "new");
}

#[test]
fn backups_coordinate_with_legacy_lock_and_keep_unrelated_files() {
    let root = tempdir().unwrap();
    let source = root.path().join("gsm.db");
    let backups = root.path().join("backup");
    let day = NaiveDate::from_ymd_opt(2026, 11, 21).unwrap();
    let conn = Connection::open(&source).unwrap();
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; CREATE TABLE lines(text); INSERT INTO lines VALUES('last');",
    )
    .unwrap();
    fs::create_dir(&backups).unwrap();
    let lock = backups.join(".gsm_backup.lock");
    fs::write(&lock, b"legacy writer").unwrap();
    assert!(daily_backup(&source, &backups, day, 1).unwrap().is_none());
    let abandoned = std::time::SystemTime::now() - std::time::Duration::from_secs(7 * 3600);
    fs::OpenOptions::new()
        .write(true)
        .open(&lock)
        .unwrap()
        .set_modified(abandoned)
        .unwrap();
    let active = fs::File::options()
        .read(true)
        .write(true)
        .open(backups.join(".gsm_backup.guard"))
        .unwrap();
    active.lock().unwrap();
    assert!(daily_backup(&source, &backups, day, 1).unwrap().is_none());
    assert!(lock.exists());
    drop(active);
    fs::write(backups.join("gsm_2026-11-19.db.gz"), "").unwrap();
    fs::write(backups.join("keep.gz"), "").unwrap();
    let outputs = std::thread::scope(|scope| {
        let other = scope.spawn(|| daily_backup(&source, &backups, day, 1).unwrap());
        [
            daily_backup(&source, &backups, day, 1).unwrap(),
            other.join().unwrap(),
        ]
    });
    let mut saved = outputs.into_iter().flatten();
    let output = saved.next().unwrap();
    assert!(saved.next().is_none());
    assert_eq!(output.file_name().unwrap(), "gsm_2026-11-21.db.gz");
    assert!(daily_backup(&source, &backups, day, 1).unwrap().is_none());
    assert!(!backups.join("gsm_2026-11-19.db.gz").exists());
    assert!(backups.join("keep.gz").exists());
    let restored = root.path().join("restored.db");
    std::io::copy(
        &mut flate2::read::GzDecoder::new(fs::File::open(output).unwrap()),
        &mut fs::File::create(&restored).unwrap(),
    )
    .unwrap();
    assert_eq!(stored(&restored), "last");
    let (a, b) = std::thread::scope(|scope| {
        let other = scope.spawn(|| manual_backup(&source).unwrap().0);
        (manual_backup(&source).unwrap().0, other.join().unwrap())
    });
    assert_ne!(a, b);
    assert_eq!(stored(&a), "last");
    assert_eq!(stored(&b), "last");
}

#[test]
fn absent_source_and_unselected_profiles_preserve_existing_files() {
    let root = tempdir().unwrap();
    let selected = root.path().join("selected");
    fs::create_dir(&selected).unwrap();
    fs::write(selected.join("gsm.db"), b"only copy").unwrap();
    let pointer = root.path().join("data_dir.json");
    let doc = serde_json::json!({"version":2, "dataDir":selected, "legacyDatabaseDir":root.path().join("missing")});
    gsm_settings::write_atomic(&pointer, &doc).unwrap();
    assert!(!recover_legacy_database(&pointer, &root.path().join("override"), false).unwrap());
    assert!(!recover_legacy_database(&pointer, &selected, true).unwrap());
    assert_eq!(gsm_settings::read_object(&pointer).unwrap(), doc);
    assert!(recover_legacy_database(&pointer, &selected, false).unwrap());
    assert_eq!(fs::read(selected.join("gsm.db")).unwrap(), b"only copy");
    assert!(!selected.join("backup").exists());
}

#[test]
fn archived_destination_can_replay_its_own_wal() {
    let root = tempdir().unwrap();
    let selected = root.path().join("selected");
    let old = root.path().join("old");
    let prior = root.path().join("prior");
    for path in [&selected, &old, &prior] {
        fs::create_dir(path).unwrap();
    }
    Connection::open(old.join("gsm.db"))
        .unwrap()
        .execute_batch("CREATE TABLE lines(text); INSERT INTO lines VALUES('recovered');")
        .unwrap();
    let writer = Connection::open(prior.join("gsm.db")).unwrap();
    writer
        .execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        CREATE TABLE lines(text); INSERT INTO lines VALUES('archived');",
        )
        .unwrap();
    for name in ["gsm.db", "gsm.db-shm", "gsm.db-wal"] {
        fs::copy(prior.join(name), selected.join(name)).unwrap();
    }
    let pointer = root.path().join("data_dir.json");
    gsm_settings::write_atomic(
        &pointer,
        &serde_json::json!({
            "version":2,"dataDir":selected,"legacyDatabaseDir":old
        }),
    )
    .unwrap();
    recover_legacy_database(&pointer, &selected, false).unwrap();
    assert_eq!(stored(&selected.join("gsm.db")), "recovered");
    let archive = fs::read_dir(selected.join("backup/data-directory-migration"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(stored(&archive.join("gsm.db")), "archived");
}
