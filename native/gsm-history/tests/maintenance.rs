use gsm_history::{History, Request};
use rusqlite::Connection;
use serde_json::{json, Value};
use tempfile::TempDir;

fn setup_db() -> (TempDir, std::path::PathBuf, Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("gsm.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE game_lines (
            id TEXT PRIMARY KEY,
            game_name TEXT,
            line_text TEXT,
            timestamp REAL
        );",
    )
    .unwrap();
    (dir, path, conn)
}

fn run(history: &History, path: &std::path::Path, payload: Value) -> Value {
    let req: Request = serde_json::from_value(payload).unwrap();
    history.run(path, req).unwrap()
}

#[test]
fn games_list_aggregates_and_sorts_by_characters_descending() {
    let (_dir, path, conn) = setup_db();
    conn.execute(
        "INSERT INTO game_lines VALUES ('1', 'SmallGame', 'abc', 1700000000.0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO game_lines VALUES ('2', 'BigGame', 'あいうえおかきくけこ', 1700000000.0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO game_lines VALUES ('3', 'BigGame', 'さしすせそ', 1700200000.0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO game_lines VALUES ('4', '', 'ignored', 1700000000.0)",
        [],
    )
    .unwrap();
    drop(conn);

    let history = History::default();
    let res = run(&history, &path, json!({ "operation": "gamesList" }));
    let games = res["games"].as_array().unwrap();
    assert_eq!(games.len(), 2);
    assert_eq!(games[0]["name"], "BigGame");
    assert_eq!(games[0]["sentence_count"], 2);
    assert_eq!(games[0]["total_characters"], 15);
    assert!(games[0]["date_range"].as_str().unwrap().contains(" to "));
    assert_eq!(games[1]["name"], "SmallGame");
    assert_eq!(games[1]["total_characters"], 3);
    assert!(!games[1]["date_range"].as_str().unwrap().contains(" to "));
}

#[test]
fn preview_and_delete_text_lines_handle_exact_and_regex_and_affected_dates() {
    let (_dir, path, conn) = setup_db();
    conn.execute(
        "INSERT INTO game_lines VALUES ('1', 'G1', 'System: Save', 1700000000.0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO game_lines VALUES ('2', 'G1', 'System: Save', 1700000100.0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO game_lines VALUES ('3', 'G1', 'system: load', 1700100000.0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO game_lines VALUES ('4', 'G1', 'Real dialogue', 1700100100.0)",
        [],
    )
    .unwrap();
    drop(conn);

    let history = History::default();
    // Case-insensitive exact preview deduplicates matching strings
    let preview = run(
        &history,
        &path,
        json!({
            "operation": "previewTextDeletion",
            "exact_text": ["SYSTEM:"],
            "case_sensitive": false,
            "use_regex": false
        }),
    );
    assert_eq!(preview["count"], 2);
    assert_eq!(preview["samples"], json!(["System: Save", "system: load"]));

    // Invalid regex triggers clean fallback signal
    let invalid = run(
        &history,
        &path,
        json!({
            "operation": "previewTextDeletion",
            "regex_pattern": "[bad",
            "use_regex": true
        }),
    );
    assert_eq!(invalid["fallback"], "invalidRegex");

    // Delete matching lines via regex and return affected local dates
    let deleted = run(
        &history,
        &path,
        json!({
            "operation": "deleteTextLines",
            "regex_pattern": "^system:",
            "case_sensitive": false,
            "use_regex": true
        }),
    );
    assert_eq!(deleted["deleted_count"], 3);
    assert!(!deleted["affected_dates"].as_array().unwrap().is_empty());

    let conn = Connection::open(&path).unwrap();
    let remaining: i64 = conn
        .query_row("SELECT COUNT(*) FROM game_lines", [], |r| r.get(0))
        .unwrap();
    assert_eq!(remaining, 1);
}

#[test]
fn preview_and_execute_deduplication_respect_window_and_preserve_newest() {
    let (_dir, path, conn) = setup_db();
    conn.execute("INSERT INTO game_lines VALUES ('a1', 'G1', 'Hello', 100.0)", [])
        .unwrap();
    conn.execute("INSERT INTO game_lines VALUES ('a2', 'G1', 'hello', 200.0)", [])
        .unwrap();
    conn.execute("INSERT INTO game_lines VALUES ('a3', 'G1', 'HELLO', 900.0)", [])
        .unwrap();
    conn.execute("INSERT INTO game_lines VALUES ('b1', 'G2', 'Other', 100.0)", [])
        .unwrap();
    drop(conn);

    let history = History::default();
    let preview = run(
        &history,
        &path,
        json!({
            "operation": "previewDeduplication",
            "games": ["all"],
            "time_window_minutes": 5,
            "case_sensitive": false,
            "ignore_time_window": false
        }),
    );
    assert_eq!(preview["duplicates_count"], 1);
    assert_eq!(preview["games_affected"], 1);
    assert_eq!(preview["samples"][0]["occurrences"], 2);

    // Deduplicate with preserve_newest=true keeps a2 (ts=200) and a3 (ts=900), removes a1 (ts=100)
    let res = run(
        &history,
        &path,
        json!({
            "operation": "deduplicateLines",
            "games": ["G1"],
            "time_window_minutes": 5,
            "case_sensitive": false,
            "preserve_newest": true,
            "ignore_time_window": false
        }),
    );
    assert_eq!(res["deleted_count"], 1);

    let conn = Connection::open(&path).unwrap();
    let mut stmt = conn
        .prepare("SELECT id FROM game_lines WHERE game_name = 'G1' ORDER BY timestamp ASC")
        .unwrap();
    let remaining: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(remaining, vec!["a2", "a3"]);
}
