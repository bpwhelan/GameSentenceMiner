use gsm_db::migrate;
use rusqlite::Connection;

#[test]
fn removes_persisted_provider_errors_and_keeps_character_summaries() {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE games(id TEXT PRIMARY KEY, character_summary TEXT);
         INSERT INTO games VALUES
         ('error', 'Processing failed: Processing failed: context_length_exceeded'),
         ('manual', 'Takeru: the protagonist'),
         ('context', 'The phrase Processing failed: appears in the dialogue');",
    )
    .unwrap();
    migrate(&mut db, "ja").unwrap();
    let mut query = db
        .prepare("SELECT character_summary FROM games ORDER BY id")
        .unwrap();
    let summaries = query
        .query_map([], |row| row.get::<_, Option<String>>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        summaries,
        [
            Some("The phrase Processing failed: appears in the dialogue".into()),
            None,
            Some("Takeru: the protagonist".into()),
        ]
    );
}

#[test]
fn interrupted_legacy_upgrade_keeps_finished_timestamps_and_repairs_pending_rows() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE game_lines(id TEXT PRIMARY KEY,timestamp_old TEXT,timestamp REAL);
        INSERT INTO game_lines VALUES('a','1.25',NULL),('b','1.00',2.5);
        CREATE TABLE cron_table(id INTEGER PRIMARY KEY, last_run TEXT, next_run TEXT, created_at TEXT);
        INSERT INTO cron_table VALUES(1,'1970-01-01T01:00:02.500+01:00','invalid','100.25');").unwrap();
    migrate(&mut conn, "").unwrap();
    let times: (f64, f64) = conn
        .query_row(
            "SELECT min(timestamp),max(timestamp) FROM game_lines",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(times, (1.25, 2.5));
    let cron: (f64, f64, String) = conn
        .query_row(
            "SELECT CAST(last_run AS REAL),CAST(next_run AS REAL),created_at FROM cron_table",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(cron.0, 2.5);
    assert!(cron.1 > 1_000_000_000.);
    assert_eq!(cron.2, "100.25");
}

#[test]
fn adopting_legacy_genres_queues_one_refresh_for_linked_games() {
    for (deck, expected) in [(Some(12), 1_i64), (None, 0)] {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE games(id TEXT PRIMARY KEY,deck_id INTEGER,completed INTEGER,genres TEXT)",
        )
        .unwrap();
        db.execute("INSERT INTO games VALUES('old',?,1,'[]')", [deck])
            .unwrap();
        for _ in 0..2 {
            migrate(&mut db, "ja").unwrap();
            let jobs: i64 = db
                .query_row(
                    "SELECT count(*) FROM cron_table WHERE name='jiten_genre_backfill'
                AND schedule='once' AND enabled=1 AND CAST(next_run AS REAL)<=unixepoch()+1",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(jobs, expected);
        }
    }
}

#[test]
fn simultaneous_openers_share_one_migration() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("gsm.db");
    let gate = std::sync::Barrier::new(4);
    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| {
                gate.wait();
                gsm_db::migrate_file(&path, "ja").unwrap();
            });
        }
    });
    let conn = Connection::open(path).unwrap();
    assert_eq!(
        conn.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}

#[test]
fn adopts_partial_schema_without_losing_data_and_marks_version_atomically() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE game_lines(id TEXT PRIMARY KEY, timestamp TEXT, game_name TEXT, user_column TEXT);
        INSERT INTO game_lines VALUES('x','1234.75','Scene','preserved');").unwrap();
    migrate(&mut conn, "Japanese").unwrap();
    let row: (f64, String, String) = conn
        .query_row(
            "SELECT timestamp,language,user_column FROM game_lines",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(row, (1234.75, "Japanese".into(), "preserved".into()));
    assert_eq!(
        conn.query_row(
            "SELECT change_type FROM sync_game_line_changes WHERE line_id='x'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "upsert"
    );
    let changes = conn.total_changes();
    migrate(&mut conn, "English").unwrap();
    assert_eq!(conn.total_changes(), changes);
}

#[test]
fn rejects_newer_schema_before_modifying_it() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA user_version=9999").unwrap();
    assert!(migrate(&mut conn, "ja").is_err());
    assert_eq!(
        conn.query_row("SELECT count(*) FROM sqlite_schema", [], |r| r
            .get::<_, usize>(0))
            .unwrap(),
        0
    );
}

#[test]
fn conflicting_indexes_roll_back_entire_adoption_and_allow_retry() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE game_daily_rollup(id INTEGER PRIMARY KEY, date TEXT, game_id TEXT);
        INSERT INTO game_daily_rollup VALUES(1,'2026-10-01','a'),(2,'2026-10-01','a');",
    )
    .unwrap();
    assert!(migrate(&mut conn, "").is_err());
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, usize>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE name='game_lines'",
            [],
            |r| r.get::<_, usize>(0)
        )
        .unwrap(),
        0
    );
    conn.execute("DELETE FROM game_daily_rollup WHERE id=2", [])
        .unwrap();
    migrate(&mut conn, "").unwrap();
}
