use gsm_history::{History, Request};
use rusqlite::Connection;
use serde_json::{json, Value};
use tempfile::TempDir;

fn setup_db(with_tokenization: bool) -> (TempDir, std::path::PathBuf, Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("gsm.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE game_lines (
            id TEXT PRIMARY KEY,
            game_name TEXT,
            line_text TEXT,
            screenshot_in_anki TEXT,
            audio_in_anki TEXT,
            screenshot_path TEXT,
            audio_path TEXT,
            replay_path TEXT,
            translation TEXT,
            timestamp REAL,
            original_game_name TEXT,
            game_id TEXT,
            note_ids TEXT,
            last_modified REAL,
            tokenized INTEGER DEFAULT 0
        );",
    )
    .unwrap();
    if with_tokenization {
        conn.execute_batch(
            "CREATE TABLE words (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                word TEXT UNIQUE NOT NULL,
                reading TEXT DEFAULT '',
                pos TEXT DEFAULT '',
                first_seen REAL,
                last_seen REAL
            );
            CREATE TABLE word_occurrences (
                word_id INTEGER NOT NULL,
                line_id TEXT NOT NULL,
                PRIMARY KEY (word_id, line_id)
            );",
        )
        .unwrap();
    }
    (dir, path, conn)
}

#[derive(Default)]
struct LineSeed<'a> {
    id: &'a str,
    game_name: Option<&'a str>,
    line_text: Option<&'a str>,
    ts: Option<f64>,
    translation: Option<&'a str>,
    audio: Option<&'a str>,
    screenshot: Option<&'a str>,
}

fn insert_line(conn: &Connection, line: LineSeed<'_>) {
    conn.execute(
        "INSERT INTO game_lines (id, game_name, line_text, timestamp, translation, audio_path, screenshot_path)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        rusqlite::params![
            line.id,
            line.game_name,
            line.line_text,
            line.ts,
            line.translation,
            line.audio,
            line.screenshot
        ],
    )
    .unwrap();
}

fn run(history: &History, path: &std::path::Path, payload: Value) -> Value {
    let req: Request = serde_json::from_value(payload).unwrap();
    history.run(path, req).unwrap()
}

#[test]
fn like_and_regex_search_handle_sorting_truncation_lookahead_and_filters() {
    let (_dir, path, conn) = setup_db(false);
    let long_jp = "あ".repeat(4010);
    insert_line(
        &conn,
        LineSeed {
            id: "l1",
            game_name: Some("GameA"),
            line_text: Some("Hello World 1"),
            ts: Some(100.0),
            translation: Some("trans1"),
            audio: Some("/a.mp3"),
            screenshot: None,
        },
    );
    insert_line(
        &conn,
        LineSeed {
            id: "l2",
            game_name: Some("GameB"),
            line_text: Some("hello japan"),
            ts: Some(200.0),
            translation: Some(""),
            audio: None,
            screenshot: Some("/s.png"),
        },
    );
    insert_line(
        &conn,
        LineSeed {
            id: "l3",
            game_name: Some(""),
            line_text: Some(&long_jp),
            ts: Some(0.0),
            ..Default::default()
        },
    );
    insert_line(
        &conn,
        LineSeed {
            id: "l4",
            game_name: Some("GameA"),
            line_text: Some("aabbaa"),
            ts: Some(150.0),
            ..Default::default()
        },
    );
    drop(conn);

    let history = History::default();

    // LIKE search with pagination and sort
    let res = run(
        &history,
        &path,
        json!({
            "operation": "searchSentences",
            "query": "hello",
            "sort": "date_asc",
            "page": 1,
            "page_size": 10
        }),
    );
    assert_eq!(res["total"], 2);
    assert_eq!(res["total_pages"], 1);
    assert_eq!(res["results"][0]["id"], "l1");
    assert_eq!(res["results"][0]["has_audio"], true);
    assert_eq!(res["results"][0]["has_screenshot"], false);
    assert_eq!(res["results"][0]["translation"], "trans1");
    assert_eq!(res["results"][1]["id"], "l2");
    assert_eq!(res["results"][1]["translation"], Value::Null);
    assert_eq!(res["results"][1]["has_screenshot"], true);

    // Match-all regex shortcut `.*` includes truncated Japanese line and Unknown Game + timestamp 0
    let all = run(
        &history,
        &path,
        json!({
            "operation": "searchSentences",
            "query": ".*",
            "use_regex": true,
            "sort": "length_desc",
            "page": 1,
            "page_size": 2
        }),
    );
    assert_eq!(all["total"], 4);
    assert_eq!(all["total_pages"], 2);
    assert_eq!(all["results"][0]["id"], "l3");
    assert_eq!(all["results"][0]["game_name"], "Unknown Game");
    assert_eq!(all["results"][0]["timestamp"], 0);
    assert_eq!(all["results"][0]["sentence_length"], 4010);
    assert_eq!(all["results"][0]["sentence_truncated"], true);
    assert_eq!(
        all["results"][0]["sentence"].as_str().unwrap().chars().count(),
        4000
    );

    // Regex search with date range skips timestamp == 0.0
    let dated = run(
        &history,
        &path,
        json!({
            "operation": "searchSentences",
            "query": "hello|あ",
            "use_regex": true,
            "start": 50.0,
            "end": 180.0,
            "sort": "date_desc",
            "page": 1,
            "page_size": 10
        }),
    );
    assert_eq!(dated["total"], 1);
    assert_eq!(dated["results"][0]["id"], "l1");

    // Fancy regex (backreference) works seamlessly
    let fancy = run(
        &history,
        &path,
        json!({
            "operation": "searchSentences",
            "query": "(.)\\1bb",
            "use_regex": true,
            "page": 1,
            "page_size": 10
        }),
    );
    assert_eq!(fancy["total"], 1);
    assert_eq!(fancy["results"][0]["id"], "l4");

    // Invalid regex triggers clean fallback signal
    let invalid = run(
        &history,
        &path,
        json!({
            "operation": "searchSentences",
            "query": "[unclosed",
            "use_regex": true,
            "page": 1,
            "page_size": 10
        }),
    );
    assert_eq!(invalid["fallback"], "invalidRegex");
}

#[test]
fn tokenized_search_matches_words_and_falls_back_when_schema_missing() {
    let (_dir, path, conn) = setup_db(true);
    insert_line(&conn, LineSeed { id: "t1", game_name: Some("G1"), line_text: Some("猫が好き"), ts: Some(10.0), ..Default::default() });
    insert_line(&conn, LineSeed { id: "t2", game_name: Some("G2"), line_text: Some("猫と犬"), ts: Some(20.0), ..Default::default() });
    conn.execute(
        "INSERT INTO words (id, word, reading, pos, first_seen, last_seen) VALUES (1, '猫', 'ネコ', '名詞', 10.0, 20.0)",
        [],
    )
    .unwrap();
    conn.execute("INSERT INTO word_occurrences (word_id, line_id) VALUES (1, 't1')", [])
        .unwrap();
    conn.execute("INSERT INTO word_occurrences (word_id, line_id) VALUES (1, 't2')", [])
        .unwrap();
    drop(conn);

    let history = History::default();
    let res = run(
        &history,
        &path,
        json!({
            "operation": "searchSentences",
            "query": "猫",
            "use_tokenized": true,
            "game": "G2",
            "page": 1,
            "page_size": 10
        }),
    );
    assert_eq!(res["total"], 1);
    assert_eq!(res["results"][0]["id"], "t2");

    let missing_word = run(
        &history,
        &path,
        json!({
            "operation": "searchSentences",
            "query": "鳥",
            "use_tokenized": true,
            "page": 1,
            "page_size": 10
        }),
    );
    assert_eq!(missing_word["total"], 0);
    assert_eq!(missing_word["results"].as_array().unwrap().len(), 0);

    // Without tokenization tables, use_tokenized falls back to LIKE
    let (_dir2, path2, conn2) = setup_db(false);
    insert_line(&conn2, LineSeed { id: "f1", game_name: Some("G1"), line_text: Some("猫が好き"), ts: Some(10.0), ..Default::default() });
    drop(conn2);
    let fallback = run(
        &history,
        &path2,
        json!({
            "operation": "searchSentences",
            "query": "猫",
            "use_tokenized": true,
            "page": 1,
            "page_size": 10
        }),
    );
    assert_eq!(fallback["total"], 1);
    assert_eq!(fallback["results"][0]["id"], "f1");
}

#[test]
fn duplicate_search_handles_time_window_chaining_case_sensitivity_and_empty_db() {
    let (_dir, path, conn) = setup_db(false);
    let history = History::default();

    // Empty database omits search_mode just like Python
    let empty = run(
        &history,
        &path,
        json!({
            "operation": "searchDuplicates",
            "time_window_minutes": 5
        }),
    );
    assert_eq!(empty["total"], 0);
    assert_eq!(empty["duplicates_found"], 0);
    assert!(empty.get("search_mode").is_none());

    // Chain within 5-minute window: t=0, t=200, t=400 -> both d2 and d3 are duplicates.
    // Then gap > 300s at t=800 -> NOT a duplicate in window mode, IS a duplicate in ignore_time_window mode.
    insert_line(&conn, LineSeed { id: "d1", game_name: Some("G1"), line_text: Some("Repeat"), ts: Some(0.0), ..Default::default() });
    insert_line(&conn, LineSeed { id: "d2", game_name: Some("G1"), line_text: Some("repeat"), ts: Some(200.0), ..Default::default() });
    insert_line(&conn, LineSeed { id: "d3", game_name: Some("G1"), line_text: Some("REPEAT"), ts: Some(400.0), ..Default::default() });
    insert_line(&conn, LineSeed { id: "d4", game_name: Some("G1"), line_text: Some("repeat"), ts: Some(800.0), ..Default::default() });
    // Same text in different game is NOT a duplicate
    insert_line(&conn, LineSeed { id: "d5", game_name: Some("G2"), line_text: Some("repeat"), ts: Some(10.0), ..Default::default() });
    // Whitespace-only lines are ignored
    insert_line(&conn, LineSeed { id: "w1", game_name: Some("G1"), line_text: Some("   "), ts: Some(1.0), ..Default::default() });
    insert_line(&conn, LineSeed { id: "w2", game_name: Some("G1"), line_text: Some("   "), ts: Some(2.0), ..Default::default() });
    drop(conn);

    let windowed = run(
        &history,
        &path,
        json!({
            "operation": "searchDuplicates",
            "time_window_minutes": 5,
            "case_sensitive": false,
            "ignore_time_window": false
        }),
    );
    assert_eq!(windowed["search_mode"], "duplicates");
    assert_eq!(windowed["total"], 2);
    let ids: Vec<&str> = windowed["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["d2", "d3"]);

    let all_time = run(
        &history,
        &path,
        json!({
            "operation": "searchDuplicates",
            "case_sensitive": false,
            "ignore_time_window": true
        }),
    );
    assert_eq!(all_time["total"], 3);
    let all_ids: Vec<&str> = all_time["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(all_ids, vec!["d2", "d3", "d4"]);

    let case_sens = run(
        &history,
        &path,
        json!({
            "operation": "searchDuplicates",
            "case_sensitive": true,
            "ignore_time_window": true
        }),
    );
    // Only d2 ("repeat") and d4 ("repeat") match case-sensitively within G1
    assert_eq!(case_sens["total"], 1);
    assert_eq!(case_sens["results"][0]["id"], "d4");
}
