use gsm_history::History;
use rusqlite::Connection;
use serde_json::{json, Value};

#[test]
fn rebuild_continues_after_a_corrupt_day_and_keeps_its_previous_summary() {
    use chrono::{Local, TimeZone};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE game_lines(timestamp REAL,line_text TEXT,game_id TEXT,game_name TEXT,note_ids TEXT,screenshot_in_anki TEXT,audio_in_anki TEXT,translation TEXT);
        CREATE TABLE games(id TEXT,title_original TEXT,genres TEXT,type TEXT);
        CREATE TABLE game_daily_rollup(date TEXT,game_id TEXT,total_characters INTEGER,total_lines INTEGER,total_cards_mined INTEGER,total_reading_time_seconds REAL,created_at REAL,updated_at REAL);
        INSERT INTO game_daily_rollup(date,game_id) VALUES ('2024-06-13','unchanged');").unwrap();
    let time = |day| {
        Local
            .with_ymd_and_hms(2024, 6, day, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp()
    };
    for day in 12..=14 {
        db.execute(
            "INSERT INTO game_lines VALUES(?,'日本語','x','scene',?,'','','')",
            rusqlite::params![time(day), if day == 13 { "true" } else { "[1]" }],
        )
        .unwrap();
    }
    let history = History::default();
    let run = |request| {
        history
            .run(&path, serde_json::from_value(request).unwrap())
            .unwrap()
    };
    let fields = run(
        json!({"operation":"calculateRollupDay","date":"2024-06-12","today":"2024-06-16",
        "start":time(12)-60,"end":time(12)+60,"session_gap":30,"tokenized":false}),
    );
    let columns = fields
        .as_object()
        .unwrap()
        .keys()
        .filter(|key| *key != "per_game_daily_rollups")
        .map(|key| format!("{key} TEXT"))
        .collect::<Vec<_>>()
        .join(",");
    db.execute_batch(&format!("CREATE TABLE daily_stats_rollup(id INTEGER PRIMARY KEY,{columns},created_at REAL,updated_at REAL);
        INSERT INTO daily_stats_rollup(id,date,total_characters,created_at) VALUES(55,'2024-06-13','100',1),(70,'2024-06-14','100',2);")).unwrap();
    let result = run(
        json!({"operation":"rebuildRollups","generation":run(json!({"operation":"beginRollup"})),
        "today":"2024-06-16","session_gap":30,"tokenized":false}),
    );
    assert_eq!(result["total_dates"], 3);
    assert_eq!(result["processed"], 1);
    assert_eq!(result["overwritten"], 1);
    assert_eq!(result["errors"], 1);
    assert_eq!(db.query_row("SELECT count(*) FROM daily_stats_rollup WHERE (id=55 AND total_characters='100') OR (id=70 AND total_characters='3' AND created_at=2)",[],|r| r.get::<_,usize>(0)).unwrap(),2);
    assert_eq!(
        db.query_row(
            "SELECT game_id FROM game_daily_rollup WHERE date='2024-06-13'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "unchanged"
    );
}

#[test]
fn reads_legacy_archive_booleans_and_applies_live_cleaning_rules_once() {
    use chrono::{Local, TimeZone};
    use flate2::{write::ZlibEncoder, Compression};
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE game_lines(timestamp TEXT,line_text TEXT,game_id TEXT,game_name TEXT,note_ids TEXT,screenshot_in_anki TEXT,audio_in_anki TEXT,translation TEXT,tokenized INTEGER);
        CREATE TABLE games(id TEXT,title_original TEXT,genres TEXT,type TEXT);
        CREATE TABLE archived_game_days(date TEXT,game_id TEXT,game_name TEXT,events BLOB,kanji TEXT,token_kanji TEXT);
        CREATE TABLE word_occurrences(word_id INTEGER,line_id TEXT);
        CREATE TABLE words(id INTEGER,word TEXT,pos TEXT);
        ALTER TABLE game_lines ADD COLUMN id TEXT;").unwrap();
    let start = Local
        .with_ymd_and_hms(2024, 1, 14, 0, 0, 0)
        .single()
        .unwrap()
        .timestamp();
    let event = json!([[start + 10, 5, 3, 7, 6, false, "archived"]]);
    let mut z = ZlibEncoder::new(Vec::new(), Compression::default());
    z.write_all(event.to_string().as_bytes()).unwrap();
    db.execute(
        "INSERT INTO archived_game_days VALUES('2024-01-14','a','Old',?,'{\"旧\":4}','{\"旧\":1}')",
        [z.finish().unwrap()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO game_lines(timestamp,line_text,tokenized) VALUES(?,'123本猫猫猫猫猫犬！',1)",
        [start as f64],
    )
    .unwrap();
    let history = History::default();
    let calc = |start, date: &str| {
        history
            .run(
                &path,
                serde_json::from_value(json!({"operation":"calculateRollupDay",
        "date":date,"today":"2025-01-01","start":start,"end":start+86400,"session_gap":300,
        "tokenized":true,"reduce_repetitions":true,"extra_punctuation":"[0-9本]+"}))
                .unwrap(),
            )
            .unwrap()
    };
    let result = calc(start, "2024-01-14");
    assert_eq!(result["total_lines"], 2);
    assert_eq!(result["total_characters"], 9);
    let kanji: Value =
        serde_json::from_str(result["kanji_frequency_data"].as_str().unwrap()).unwrap();
    assert_eq!(kanji, json!({"旧":4,"猫":3,"犬":1}));
    assert_eq!(result["anki_cards_created"], 3);
    assert_eq!(result["lines_with_screenshots"], 1);
    db.execute_batch("DROP TABLE words; DROP TABLE word_occurrences;")
        .unwrap();
    let empty = calc(start + 86400, "2024-01-15");
    assert_eq!(empty["total_lines"], 0);
    assert!(empty.get("genre_activity_data").is_none());
}

#[test]
fn closed_generation_cannot_reopen_or_modify_a_restored_profile() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let history = History::default();
    let begin = || {
        history
            .run(
                &path,
                serde_json::from_value(json!({"operation":"beginRollup"})).unwrap(),
            )
            .unwrap()
    };
    let generation = begin();
    history.close().unwrap();
    assert_ne!(begin(), generation);
    let error = history
        .run(
            &path,
            serde_json::from_value(json!({"operation":"rebuildRollups","generation":generation,
        "today":"2026-01-10","session_gap":300,"tokenized":false}))
            .unwrap(),
        )
        .unwrap_err();
    assert!(error.to_string().contains("cancelled"));
    assert!(!path.exists());
}

#[test]
fn replacement_rolls_back_both_tables_and_skips_unfinished_days() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE game_lines(timestamp REAL,line_text TEXT,game_id TEXT,game_name TEXT,note_ids TEXT,screenshot_in_anki TEXT,audio_in_anki TEXT,translation TEXT);
        CREATE TABLE games(id TEXT, title_original TEXT, genres TEXT,type TEXT);
        CREATE TABLE daily_stats_rollup(id INTEGER PRIMARY KEY,date TEXT);
        CREATE TABLE game_daily_rollup(date TEXT,game_id TEXT,total_characters INTEGER,total_lines INTEGER,total_cards_mined INTEGER,total_reading_time_seconds REAL,created_at REAL,updated_at REAL);
        INSERT INTO game_lines VALUES(1700000000,'今日。','game','Game','[10,11]','','',''),(1700000004,'猫','game','Game','[]','prev','','');
        INSERT INTO game_daily_rollup(date,game_id) VALUES('2023-11-14','old');
        INSERT INTO daily_stats_rollup VALUES(71,'2023-11-14');
        ").unwrap();
    let history = History::default();
    let call = |operation: &str, today: &str| {
        history.run(
            &path,
            serde_json::from_value(
                json!({"operation":operation,"date":"2023-11-14","today":today,
            "start":1699999900.0,"end":1700000050.0,"session_gap":300,"tokenized":false}),
            )
            .unwrap(),
        )
    };
    let stats = call("calculateRollupDay", "2023-11-15").unwrap();
    assert_eq!(stats["total_characters"], 3);
    assert_eq!(stats["anki_cards_created"], 3);
    assert_eq!(stats["total_reading_time_seconds"], 4.0);
    // The per-game insert succeeds. A legacy aggregate table missing a
    // required column then rejects the update; the old game row must survive.
    assert!(call("replaceRollupDay", "2023-11-15").is_err());
    assert_eq!(
        db.query_row("SELECT game_id FROM game_daily_rollup", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "old"
    );
    let skipped = call("replaceRollupDay", "2023-11-14").unwrap();
    assert_eq!(skipped["skipped_current_or_future_date"], Value::Bool(true));
    assert_eq!(skipped["deleted"], true);
    assert_eq!(db.query_row("SELECT (SELECT count(*) FROM game_daily_rollup)+(SELECT count(*) FROM daily_stats_rollup)",[],|r|r.get::<_,usize>(0)).unwrap(),0);
}
