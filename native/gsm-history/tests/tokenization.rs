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
            game_id TEXT,
            game_name TEXT,
            line_text TEXT,
            timestamp REAL,
            tokenized INTEGER DEFAULT 0
        );
        CREATE TABLE words (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            word TEXT UNIQUE NOT NULL,
            reading TEXT DEFAULT '',
            pos TEXT DEFAULT '',
            in_anki INTEGER DEFAULT 0
        );
        CREATE TABLE kanji (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            character TEXT UNIQUE NOT NULL
        );
        CREATE TABLE word_occurrences (
            word_id INTEGER NOT NULL,
            line_id TEXT NOT NULL,
            PRIMARY KEY (word_id, line_id)
        );
        CREATE TABLE kanji_occurrences (
            kanji_id INTEGER NOT NULL,
            line_id TEXT NOT NULL,
            PRIMARY KEY (kanji_id, line_id)
        );
        CREATE TABLE word_stats_cache (
            word_id INTEGER PRIMARY KEY,
            occurrence_count INTEGER NOT NULL DEFAULT 0,
            active_global_rank INTEGER
        );
        CREATE TABLE global_frequency_sources (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            version TEXT NOT NULL,
            source_url TEXT DEFAULT '',
            max_rank INTEGER DEFAULT 0,
            is_default INTEGER DEFAULT 0
        );
        CREATE TABLE word_global_frequencies (
            source_id TEXT NOT NULL,
            word TEXT NOT NULL,
            rank INTEGER NOT NULL
        );
        CREATE TABLE word_anki_links (
            word_id INTEGER NOT NULL,
            note_id INTEGER NOT NULL
        );
        CREATE TABLE anki_cards (
            card_id INTEGER PRIMARY KEY,
            note_id INTEGER NOT NULL,
            deck_name TEXT,
            interval INTEGER,
            due INTEGER
        );
        CREATE TABLE anki_notes (
            note_id TEXT PRIMARY KEY,
            fields_json TEXT,
            tags TEXT
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
fn tokenization_explorer_endpoints_match_expected_counts_filters_and_csv() {
    let (_dir, path, conn) = setup_db();
    conn.execute_batch(
        "INSERT INTO game_lines VALUES ('l1', 'g1', 'Game1', '魔法を使う', 1700000000.0, 1);
         INSERT INTO game_lines VALUES ('l2', 'g1', 'Game1', '魔法と剣', 1700000100.0, 1);
         INSERT INTO game_lines VALUES ('l3', 'g2', 'Game2', '猫を見る', 1700000200.0, 0);

         INSERT INTO words VALUES (1, '魔法', 'マホウ', '名詞', 0);
         INSERT INTO words VALUES (2, '剣', 'ケン', '名詞', 1);
         INSERT INTO words VALUES (3, 'の', 'ノ', '助詞', 0);
         INSERT INTO words VALUES (4, 'abc', 'abc', '名詞', 0);

         INSERT INTO word_occurrences VALUES (1, 'l1');
         INSERT INTO word_occurrences VALUES (1, 'l2');
         INSERT INTO word_occurrences VALUES (2, 'l2');
         INSERT INTO word_occurrences VALUES (3, 'l1');
         INSERT INTO word_occurrences VALUES (4, 'l2');

         INSERT INTO word_stats_cache VALUES (1, 2, 120);
         INSERT INTO word_stats_cache VALUES (2, 1, 50);
         INSERT INTO word_stats_cache VALUES (3, 1, 1);
         INSERT INTO word_stats_cache VALUES (4, 1, NULL);

         INSERT INTO kanji VALUES (1, '魔');
         INSERT INTO kanji VALUES (2, '剣');
         INSERT INTO kanji_occurrences VALUES (1, 'l1');
         INSERT INTO kanji_occurrences VALUES (1, 'l2');
         INSERT INTO kanji_occurrences VALUES (2, 'l2');

         INSERT INTO global_frequency_sources VALUES ('jpdb', 'JPDB', 'v2', 'https://jpdb.io', 50000, 1);
         INSERT INTO word_global_frequencies VALUES ('jpdb', '魔法', 120);
         INSERT INTO word_global_frequencies VALUES ('jpdb', '剣', 50);
         INSERT INTO word_global_frequencies VALUES ('jpdb', 'の', 1);

         INSERT INTO word_anki_links VALUES (2, 9001);
         INSERT INTO anki_cards VALUES (101, 9001, 'CoreDeck', 42, 1000);
         INSERT INTO anki_notes VALUES ('9001', '{\"Expression\":{\"value\":\"剣\"}}', '[\"Game::Game1\"]');",
    )
    .unwrap();
    drop(conn);

    let history = History::default();

    // Status
    let status = run(&history, &path, json!({ "operation": "tokenizationStatus" }));
    assert_eq!(status["total_lines"], 3);
    assert_eq!(status["tokenized_lines"], 2);
    assert_eq!(status["untokenized_lines"], 1);
    assert_eq!(status["total_words"], 4);
    assert_eq!(status["total_kanji"], 2);

    // Words with POS shorthand + Anki enrichment
    let words = run(
        &history,
        &path,
        json!({
            "operation": "tokenizationWords",
            "limit": 10,
            "offset": 0,
            "pos": "content"
        }),
    );
    assert_eq!(words["total"], 3);
    assert_eq!(words["words"][0]["word"], "魔法");
    assert_eq!(words["words"][0]["frequency"], 2);
    let sword = words["words"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["word"] == "剣")
        .unwrap();
    assert_eq!(sword["deck_name"], "CoreDeck");
    assert_eq!(sword["interval"], 42);

    // Kanji
    let kanji = run(
        &history,
        &path,
        json!({ "operation": "tokenizationKanji", "limit": 10, "offset": 0 }),
    );
    assert_eq!(kanji["total"], 2);
    assert_eq!(kanji["kanji"][0]["character"], "魔");
    assert_eq!(kanji["kanji"][0]["frequency"], 2);

    // Search
    let search = run(
        &history,
        &path,
        json!({
            "operation": "tokenizationSearch",
            "query": "魔法",
            "limit": 10,
            "offset": 0,
            "game_ids": ["g1"],
            "has_game_scope": true
        }),
    );
    assert_eq!(search["total"], 2);
    assert_eq!(search["lines"][0]["id"], "l2");

    // Word card data
    let cards = run(
        &history,
        &path,
        json!({ "operation": "tokenizationWordCardData", "word_ids": [1, 2] }),
    );
    assert_eq!(cards["cards"].as_array().unwrap().len(), 1);
    assert_eq!(cards["cards"][0]["word_id"], 2);

    // Word detail + not_found
    let detail = run(
        &history,
        &path,
        json!({ "operation": "tokenizationWordDetail", "word": "剣" }),
    );
    assert_eq!(detail["total_occurrences"], 1);
    assert_eq!(detail["deck_name"], "CoreDeck");
    let missing = run(
        &history,
        &path,
        json!({ "operation": "tokenizationWordDetail", "word": "存在しない" }),
    );
    assert_eq!(missing["not_found"], true);

    // Words by game
    let by_game = run(
        &history,
        &path,
        json!({ "operation": "tokenizationWordsByGame", "limit": 10 }),
    );
    assert_eq!(by_game["games"][0]["game_name"], "Game1");
    assert_eq!(by_game["games"][0]["unique_words"], 4);

    // Words not in Anki with vocab_only + script_filter=cjk + missing_anki_kanji
    let not_in_anki = run(
        &history,
        &path,
        json!({
            "operation": "tokenizationWordsNotInAnki",
            "limit": 50,
            "offset": 0,
            "vocab_only": true,
            "script_filter": "cjk",
            "has_missing_anki_kanji": true,
            "parent_tag": "Game",
            "word_field": "Expression",
            "today": "2026-11-19"
        }),
    );
    assert_eq!(not_in_anki["total"], 1);
    assert_eq!(not_in_anki["words"][0]["word"], "魔法");
    assert_eq!(not_in_anki["words"][0]["global_rank"], 120);
    assert_eq!(not_in_anki["frequency_bounds"]["min"], 2);

    // CSV export
    let csv = run(
        &history,
        &path,
        json!({
            "operation": "tokenizationWordsNotInAnki",
            "vocab_only": true,
            "script_filter": "cjk",
            "today": "2026-11-19",
            "export_csv": true
        }),
    );
    let body = csv["csv"].as_str().unwrap();
    assert!(body.starts_with('\u{feff}'));
    assert!(body.contains("word,reading,pos,frequency,global_rank,Game1\n"));
    assert!(body.contains("魔法,マホウ,名詞,2,120,\"魔法と剣\n魔法を使う\""));
}
