use gsm_db::{frequency, migrate, vocabulary};
use rusqlite::Connection;
use std::{fs, path::Path};
use tempfile::tempdir;

fn source(dir: &Path, name: &str, json: &str) {
    fs::write(dir.join(name), json).unwrap();
}

fn scalar<T: rusqlite::types::FromSql>(db: &Connection, sql: &str) -> T {
    db.query_row(sql, [], |r| r.get(0)).unwrap()
}

#[test]
fn refresh_is_atomic_preserves_best_ranks_and_updates_existing_words() {
    let dir = tempdir().unwrap();
    let mut db = Connection::open_in_memory().unwrap();
    migrate(&mut db, "ja").unwrap();
    vocabulary::configure(&mut db, true).unwrap();
    db.execute_batch(
        "INSERT INTO words(id,word) VALUES(1,'読む');
        INSERT INTO word_stats_cache(word_id,occurrence_count) VALUES(1,4);",
    )
    .unwrap();
    source(
        dir.path(),
        "a.json",
        r#"{"id":"a","entries":[["読む",20],[" 読む ","10"],["x",false],[0,4],[null,1],["z",-3],["unused",7],["bad"],["a\u0062",3]],"version":"v1"}"#,
    );
    frequency::sync(&mut db, dir.path()).unwrap();
    assert_eq!(
        scalar::<i64>(&db, "SELECT entry_count FROM global_frequency_sources"),
        3
    );
    assert_eq!(
        scalar::<i64>(&db, "SELECT max_rank FROM global_frequency_sources"),
        10
    );
    assert_eq!(
        scalar::<i64>(
            &db,
            "SELECT active_global_rank FROM word_stats_cache WHERE word_id=1"
        ),
        10
    );
    assert_eq!(
        scalar::<i64>(
            &db,
            "SELECT rank FROM word_global_frequencies WHERE word='ab'"
        ),
        3
    );
    let writes = db.total_changes();
    frequency::sync(&mut db, dir.path()).unwrap();
    assert_eq!(writes, db.total_changes());
    source(
        dir.path(),
        "b.json",
        r#"{"id":"b","default":true,"entries":[["読む",2]]}"#,
    );
    frequency::sync(&mut db, dir.path()).unwrap();
    assert_eq!(
        scalar::<String>(
            &db,
            "SELECT id FROM global_frequency_sources WHERE is_default=1"
        ),
        "b"
    );
    assert_eq!(
        scalar::<i64>(&db, "SELECT active_global_rank FROM word_stats_cache"),
        2
    );
    source(
        dir.path(),
        "b.json",
        r#"{"id":"b","version":"2","default":true,"entries":[["other",1]]}"#,
    );
    db.execute_batch(
        "CREATE TRIGGER fail BEFORE INSERT ON word_global_frequencies WHEN new.word='other'
        BEGIN SELECT RAISE(ABORT,'fixture'); END;",
    )
    .unwrap();
    assert!(frequency::sync(&mut db, dir.path()).is_err());
    assert_eq!(
        scalar::<i64>(
            &db,
            "SELECT rank FROM word_global_frequencies WHERE source_id='b'"
        ),
        2
    );
    db.execute_batch("DROP TRIGGER fail;").unwrap();
    frequency::sync(&mut db, dir.path()).unwrap();
    assert_eq!(
        scalar::<Option<i64>>(&db, "SELECT active_global_rank FROM word_stats_cache"),
        None
    );
    source(
        dir.path(),
        "b.json",
        r#"{"version":"3","id":"b","entries":[]}"#,
    );
    frequency::sync(&mut db, dir.path()).unwrap();
    assert_eq!(
        scalar::<String>(
            &db,
            "SELECT id FROM global_frequency_sources WHERE is_default=1"
        ),
        "b"
    );
    assert_eq!(
        scalar::<String>(
            &db,
            "SELECT version FROM global_frequency_sources WHERE id='b'"
        ),
        "2"
    );
    source(
        dir.path(),
        "b.json",
        r#"{"id":"b","version":"4","entries":[["late",7]]}"#,
    );
    let pending = frequency::prepare(&db, dir.path()).unwrap();
    vocabulary::configure(&mut db, false).unwrap();
    assert_eq!(pending.apply(&mut db).unwrap(), 0);
    frequency::sync(&mut db, dir.path()).unwrap();
    assert_eq!(
        scalar::<i64>(
            &db,
            "SELECT count(*) FROM sqlite_schema WHERE name='word_global_frequencies'"
        ),
        0
    );
}

#[test]
fn failed_job_registration_rolls_back_the_optional_schema() {
    let mut db = Connection::open_in_memory().unwrap();
    migrate(&mut db, "ja").unwrap();
    db.execute_batch(
        "CREATE TRIGGER refuse_job BEFORE INSERT ON cron_table
        WHEN NEW.name='anki_card_sync' BEGIN SELECT RAISE(ABORT,'fixture'); END;",
    )
    .unwrap();
    assert!(vocabulary::configure_desktop(&mut db, true).is_err());
    assert_eq!(
        scalar::<i64>(&db, "SELECT count(*) FROM sqlite_schema WHERE name='words'"),
        0
    );
    assert_eq!(scalar::<i64>(&db, "SELECT count(*) FROM cron_table"), 0);
}

#[test]
fn optional_jobs_enable_disable_and_resume_with_the_original_deadlines() {
    let mut db = Connection::open_in_memory().unwrap();
    migrate(&mut db, "").unwrap();
    db.execute_batch("INSERT INTO cron_table(name,enabled) VALUES('anki_word_sync',1);")
        .unwrap();
    vocabulary::configure_desktop_at(&mut db, true, 1000.).unwrap();
    assert_eq!(
        scalar::<i64>(&db, "SELECT count(*) FROM cron_table WHERE enabled=1"),
        2
    );
    assert_eq!(
        scalar::<f64>(
            &db,
            "SELECT CAST(next_run AS REAL) FROM cron_table WHERE name='anki_card_sync'"
        ),
        940.
    );
    let writes = db.total_changes();
    vocabulary::configure_desktop_at(&mut db, true, 2000.).unwrap();
    assert_eq!(db.total_changes(), writes);
    vocabulary::configure_desktop_at(&mut db, false, 3000.).unwrap();
    assert_eq!(
        scalar::<i64>(&db, "SELECT count(*) FROM cron_table WHERE enabled=1"),
        0
    );
    vocabulary::configure_desktop_at(&mut db, true, 4000.).unwrap();
    assert_eq!(
        scalar::<f64>(
            &db,
            "SELECT CAST(next_run AS REAL) FROM cron_table WHERE name='tokenize_backfill'"
        ),
        3940.
    );
}

#[test]
fn upgrading_keeps_unchanged_rows_and_their_rowids() {
    let dir = tempdir().unwrap();
    let mut db = Connection::open_in_memory().unwrap();
    migrate(&mut db, "").unwrap();
    vocabulary::configure(&mut db, true).unwrap();
    source(
        dir.path(),
        "s.json",
        r#"{"version":"1","entries":[["stable",1],["changed",2],["gone",3]]}"#,
    );
    frequency::sync(&mut db, dir.path()).unwrap();
    let stable = scalar::<i64>(
        &db,
        "SELECT rowid FROM word_global_frequencies WHERE word='stable'",
    );
    db.execute_batch("CREATE TRIGGER preserve_delete BEFORE DELETE ON word_global_frequencies WHEN old.word='stable' BEGIN SELECT RAISE(ABORT,'unnecessary deletion'); END;
        CREATE TRIGGER preserve_update BEFORE UPDATE ON word_global_frequencies WHEN old.word='stable' BEGIN SELECT RAISE(ABORT,'unnecessary update'); END;").unwrap();
    source(
        dir.path(),
        "s.json",
        r#"{"version":"2","entries":[["new",2],["changed",3],["stable",1]]}"#,
    );
    frequency::sync(&mut db, dir.path()).unwrap();
    assert_eq!(
        scalar::<i64>(
            &db,
            "SELECT rowid FROM word_global_frequencies WHERE word='stable'"
        ),
        stable
    );
    assert_eq!(
        scalar::<i64>(
            &db,
            "SELECT rank FROM word_global_frequencies WHERE word='changed'"
        ),
        3
    );
    assert_eq!(
        scalar::<i64>(
            &db,
            "SELECT count(*) FROM word_global_frequencies WHERE word='gone'"
        ),
        0
    );
}
