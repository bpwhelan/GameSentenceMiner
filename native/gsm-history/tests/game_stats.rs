use chrono::{Local, NaiveDate, TimeZone};
use gsm_history::{History, Request};
use rusqlite::Connection;
use serde_json::{json, Value};
use tempfile::TempDir;

fn setup_db() -> (TempDir, std::path::PathBuf, Connection) {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("gsm.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE games (
            id TEXT PRIMARY KEY,
            deck_id INTEGER,
            title_original TEXT,
            title_romaji TEXT,
            title_english TEXT,
            obs_scene_name TEXT,
            type TEXT,
            description TEXT,
            image TEXT,
            genres TEXT,
            tags TEXT,
            links TEXT,
            completed INTEGER DEFAULT 0,
            status TEXT DEFAULT '',
            character_count INTEGER DEFAULT 0,
            difficulty INTEGER,
            release_date TEXT,
            manual_overrides TEXT,
            character_summary TEXT,
            vndb_id TEXT,
            anilist_id TEXT
        );
        CREATE TABLE game_lines (
            id TEXT PRIMARY KEY,
            game_id TEXT,
            game_name TEXT,
            line_text TEXT,
            timestamp REAL,
            note_ids TEXT,
            screenshot_in_anki TEXT,
            audio_in_anki TEXT,
            translation TEXT,
            tokenized INTEGER DEFAULT 0
        );
        CREATE TABLE words (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            word TEXT UNIQUE NOT NULL,
            reading TEXT DEFAULT '',
            pos TEXT DEFAULT '',
            first_seen REAL,
            first_seen_line_id TEXT
        );
        CREATE TABLE word_occurrences (
            word_id INTEGER NOT NULL,
            line_id TEXT NOT NULL,
            PRIMARY KEY (word_id, line_id)
        );
        CREATE TABLE daily_stats_rollup (
            date TEXT PRIMARY KEY,
            total_lines INTEGER DEFAULT 0,
            total_characters INTEGER DEFAULT 0,
            total_sessions INTEGER DEFAULT 0,
            total_reading_time_seconds REAL DEFAULT 0,
            total_active_time_seconds REAL DEFAULT 0,
            longest_session_seconds REAL DEFAULT 0,
            shortest_session_seconds REAL DEFAULT 0,
            average_session_seconds REAL DEFAULT 0,
            average_reading_speed_chars_per_hour REAL DEFAULT 0,
            peak_reading_speed_chars_per_hour REAL DEFAULT 0,
            games_completed INTEGER DEFAULT 0,
            anki_cards_created INTEGER DEFAULT 0,
            hourly_activity_data TEXT DEFAULT '{}',
            hourly_reading_speed_data TEXT DEFAULT '{}',
            game_activity_data TEXT DEFAULT '{}',
            genre_activity_data TEXT DEFAULT '{}',
            type_activity_data TEXT DEFAULT '{}',
            max_chars_in_session INTEGER DEFAULT 0
        );
        CREATE TABLE game_daily_rollup (
            date TEXT NOT NULL,
            game_id TEXT NOT NULL,
            total_characters INTEGER DEFAULT 0,
            total_lines INTEGER DEFAULT 0,
            total_cards_mined INTEGER DEFAULT 0,
            total_reading_time_seconds REAL DEFAULT 0,
            PRIMARY KEY (date, game_id)
        );
        CREATE TABLE third_party_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            source TEXT,
            source_id TEXT,
            game_id TEXT,
            label TEXT,
            characters_read INTEGER DEFAULT 0,
            time_read_seconds REAL DEFAULT 0,
            lines_read INTEGER DEFAULT 0
        );",
    )
    .unwrap();
    (dir, path, conn)
}

fn local_ts(date: &str, hour: u32, min: u32) -> f64 {
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap();
    let naive = d.and_hms_opt(hour, min, 0).unwrap();
    Local
        .from_local_datetime(&naive)
        .earliest()
        .unwrap()
        .timestamp() as f64
}

fn run(history: &History, path: &std::path::Path, payload: Value) -> Value {
    let req: Request = serde_json::from_value(payload).unwrap();
    history.run(path, req).unwrap()
}

#[test]
fn game_stats_word_novelty_and_dashboard_stats_produce_consistent_aggregates() {
    let (_dir, path, conn) = setup_db();
    let t1 = local_ts("2026-11-18", 12, 0);
    let t2 = local_ts("2026-11-19", 10, 0);
    let t3 = local_ts("2026-11-19", 10, 1);

    conn.execute(
        "INSERT INTO games (id, title_original, obs_scene_name, type, genres, tags, completed, character_count, difficulty)
         VALUES ('g1', '魔法少女', 'Scene1', 'Visual Novel', '[\"Fantasy\"]', '[\"Magic\"]', 1, 10000, 2)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO game_lines (id, game_id, game_name, line_text, timestamp, note_ids, tokenized)
         VALUES ('l1', 'g1', 'Scene1', '魔法を使う世界', ?1, '[101]', 1)",
        [t1],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO game_lines (id, game_id, game_name, line_text, timestamp, note_ids, tokenized)
         VALUES ('l2', 'g1', 'Scene1', '新しい冒険の始まりです', ?1, '[]', 1)",
        [t2],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO game_lines (id, game_id, game_name, line_text, timestamp, note_ids, tokenized)
         VALUES ('l3', 'g1', 'Scene1', '剣と魔法の物語', ?1, '[102]', 1)",
        [t3],
    )
    .unwrap();

    conn.execute(
        "INSERT INTO words VALUES (1, '魔法', 'マホウ', '名詞', ?1, 'l1')",
        [t1],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO words VALUES (2, '冒険', 'ボウケン', '名詞', ?1, 'l2')",
        [t2],
    )
    .unwrap();
    conn.execute_batch(
        "INSERT INTO word_occurrences VALUES (1, 'l1');
         INSERT INTO word_occurrences VALUES (2, 'l2');
         INSERT INTO word_occurrences VALUES (1, 'l3');

         INSERT INTO daily_stats_rollup (
            date, total_lines, total_characters, total_sessions,
            total_reading_time_seconds, total_active_time_seconds,
            longest_session_seconds, shortest_session_seconds,
            average_session_seconds, average_reading_speed_chars_per_hour,
            anki_cards_created, hourly_activity_data, hourly_reading_speed_data,
            game_activity_data, genre_activity_data, type_activity_data, max_chars_in_session
         ) VALUES (
            '2026-11-18', 1, 7, 1, 360.0, 360.0, 360.0, 360.0, 360.0, 70.0, 1,
            '{\"12\": 7}', '{\"12\": 70}',
            '{\"g1\": {\"title\": \"魔法少女\", \"chars\": 7, \"time\": 360.0, \"lines\": 1, \"cards\": 1}}',
            '{\"Fantasy\": {\"chars\": 7, \"time\": 360.0, \"cards\": 1}}',
            '{\"Visual Novel\": {\"chars\": 7, \"time\": 360.0, \"cards\": 1}}',
            7
         );
         INSERT INTO game_daily_rollup VALUES ('2026-11-18', 'g1', 7, 1, 1, 360.0);",
    )
    .unwrap();
    drop(conn);

    let history = History::default();

    // Game stats
    let gs = run(
        &history,
        &path,
        json!({
            "operation": "gameStats",
            "game_id": "g1",
            "today": "2026-11-19",
            "session_gap": 300.0,
            "tokenization_enabled": true
        }),
    );
    assert_eq!(gs["game"]["title_original"], "魔法少女");
    assert_eq!(gs["game"]["status"], "completed");
    assert_eq!(gs["stats"]["total_sentences"], 3);
    assert_eq!(gs["stats"]["total_cards_mined"], 2);
    assert_eq!(gs["vocabulary"]["uniqueWordsInGame"], 2);
    assert_eq!(gs["vocabulary"]["globallyNewWordsFromGame"], 2);
    assert_eq!(gs["vocabulary"]["newWordCharacterPositions"], json!([7, 18]));

    // Missing game returns not_found
    let missing = run(
        &history,
        &path,
        json!({
            "operation": "gameStats",
            "game_id": "does-not-exist",
            "today": "2026-11-19",
            "session_gap": 300.0,
            "tokenization_enabled": false
        }),
    );
    assert_eq!(missing["not_found"], true);

    // Dashboard stats
    let dash = run(
        &history,
        &path,
        json!({
            "operation": "dashboardStats",
            "today": "2026-11-19",
            "session_gap": 300.0,
            "include_tokenization": true,
            "tokenization_enabled": true
        }),
    );
    assert_eq!(dash["labels"], json!(["2026-11-18", "2026-11-19"]));
    assert_eq!(dash["allGamesStats"]["completed_games"], 1);
    assert_eq!(dash["allGamesStats"]["total_sentences"], 3);
    assert_eq!(dash["currentGameStats"]["game_id"], "g1");
    assert_eq!(dash["vocabularyStats"]["uniqueWordsSeen"], 2);
    assert_eq!(dash["vocabularyStats"]["newWordsFirstSeen"], 2);
    assert_eq!(dash["newWordsByGame"]["labels"], json!(["魔法少女"]));
    assert_eq!(dash["difficultySpeedData"]["labels"], json!(["Difficulty 2"]));
    assert_eq!(dash["gameTypeData"]["labels"], json!(["Visual Novel"]));
}
