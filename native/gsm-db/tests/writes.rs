use flate2::read::GzDecoder;
use gsm_db::imports::{import, Entry};
use rusqlite::Connection;
use std::{fs::File, io::Read};

#[test]
fn failed_batch_preserves_previous_source() {
    let mut db = Connection::open_in_memory().unwrap();
    gsm_db::migrate(&mut db, "").unwrap();
    db.execute_batch("INSERT INTO third_party_stats(label,source) VALUES('original','s');
        CREATE TRIGGER deny_bad BEFORE INSERT ON third_party_stats WHEN NEW.label='bad' BEGIN SELECT RAISE(ABORT,'bad row'); END;").unwrap();
    let entries = ["good", "bad"].map(|label| Entry {
        date: "2026-01-01".into(),
        characters: 100,
        seconds: 25.,
        source: "s".into(),
        label: label.into(),
    });
    assert!(import(&mut db, Some("s"), &entries).is_err());
    let row: (i64, String) = db
        .query_row(
            "SELECT count(*),max(label) FROM third_party_stats",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(row, (1, "original".into()));
}

#[test]
fn backup_includes_wal_and_preserves_destination_on_failure() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("gsm.db");
    let target = dir.path().join("backup.db.gz");
    let db = Connection::open(&source).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE diary(value); INSERT INTO diary VALUES('日本語');").unwrap();
    gsm_db::backup::compressed_snapshot(&source, &target).unwrap();
    let mut bytes = Vec::new();
    GzDecoder::new(File::open(&target).unwrap())
        .read_to_end(&mut bytes)
        .unwrap();
    let restored = dir.path().join("restored.db");
    std::fs::write(&restored, bytes).unwrap();
    assert_eq!(
        Connection::open(&restored)
            .unwrap()
            .query_row("SELECT value FROM diary", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "日本語"
    );
    let saved = std::fs::read(&target).unwrap();
    let corrupt = dir.path().join("corrupt.db");
    std::fs::write(&corrupt, b"invalid sqlite fixture").unwrap();
    assert!(gsm_db::backup::compressed_snapshot(&corrupt, &target).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), saved);
}
