use gsm_history::{word_index::Word, History};
use rusqlite::Connection;
use serde_json::json;

#[test]
fn vocabulary_refresh_imports_ranks_even_if_first_seen_repair_fails() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let mut db = gsm_db::open_profile(&path, "ja").unwrap();
    gsm_db::vocabulary::configure_desktop(&mut db, true).unwrap();
    db.execute_batch(
        "INSERT INTO words(id,word) VALUES(1,'猫');
        CREATE TRIGGER refuse_repair BEFORE UPDATE OF first_seen ON words
        BEGIN SELECT RAISE(ABORT,'fixture'); END;",
    )
    .unwrap();
    std::fs::write(
        dir.path().join("source.json"),
        r#"{"id":"test","entries":[["猫",1]]}"#,
    )
    .unwrap();
    let history = History::default();
    let generation = history.generation().unwrap();
    assert!(history
        .refresh_vocabulary(&path, dir.path(), generation)
        .is_err());
    assert_eq!(
        db.query_row(
            "SELECT rank FROM word_global_frequencies WHERE word='猫'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    history.close().unwrap();
    drop(db);
    std::fs::remove_file(&path).unwrap();
    let error = history
        .refresh_vocabulary(&path, dir.path(), generation)
        .unwrap_err()
        .to_string();
    assert_eq!(error, "Job cancelled because the database closed");
    assert!(!path.exists());
}

#[test]
fn first_seen_matches_stored_text_foreign_keys_on_legacy_profiles() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE words(id INTEGER PRIMARY KEY,first_seen TEXT,first_seen_line_id TEXT);
        CREATE TABLE game_lines(id TEXT PRIMARY KEY,timestamp TEXT);
        CREATE TABLE word_occurrences(word_id TEXT,line_id TEXT,UNIQUE(word_id,line_id));
        INSERT INTO words(id) VALUES(1);
        INSERT INTO game_lines VALUES('old','1'),('correct','2');
        INSERT INTO word_occurrences VALUES('01','old'),('1','correct');",
    )
    .unwrap();
    let request = json!({"operation":"repairWordFirstSeen","ids":[1],"only_missing":true});
    assert_eq!(
        History::default()
            .run(&path, serde_json::from_value(request).unwrap())
            .unwrap(),
        1
    );
    assert_eq!(
        db.query_row("SELECT first_seen_line_id FROM words", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "correct"
    );
}

#[test]
#[ignore = "release-profile vocabulary write batch benchmark"]
fn benchmark_word_index_batches() {
    use std::time::Instant;
    for round in 0..5 {
        let mut sizes = [1, 8, 32, 128];
        sizes.rotate_left(round % 4);
        for size in sizes {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("gsm.db");
            let mut db = Connection::open(&path).unwrap();
            db.execute_batch("PRAGMA journal_mode=WAL;
                CREATE TABLE game_lines(id TEXT PRIMARY KEY,line_text TEXT,timestamp REAL,tokenized INTEGER);
                CREATE TABLE words(id INTEGER PRIMARY KEY AUTOINCREMENT,word TEXT UNIQUE,reading TEXT,pos TEXT,in_anki TEXT,first_seen REAL,first_seen_line_id TEXT,last_seen REAL);
                CREATE TABLE kanji(id INTEGER PRIMARY KEY AUTOINCREMENT,character TEXT UNIQUE);
                CREATE TABLE word_occurrences(word_id INTEGER,line_id TEXT,UNIQUE(word_id,line_id));
                CREATE TABLE kanji_occurrences(kanji_id INTEGER,line_id TEXT,UNIQUE(kanji_id,line_id));").unwrap();
            let ids: Vec<String> = (0..1024).map(|i| i.to_string()).collect();
            let tx = db.transaction().unwrap();
            for id in &ids {
                tx.execute(
                    "INSERT INTO game_lines VALUES (?1,'今日も日本語の本を読む',?1,0)",
                    [id],
                )
                .unwrap();
            }
            tx.commit().unwrap();
            let history = History::default();
            let mut elapsed = Vec::new();
            for batch in ids.chunks(size) {
                let mut rows = history.pending_words(&path, batch, None).unwrap();
                for row in &mut rows {
                    for word in ["今日", "も", "日本語", "の", "本", "を", "読む"] {
                        row.words.push(Word {
                            headword: word.into(),
                            reading: String::new(),
                            pos: "名詞".into(),
                        });
                    }
                }
                let start = Instant::now();
                assert_eq!(history.store_words(&path, rows, None).unwrap(), 0);
                elapsed.push(start.elapsed().as_secs_f64() * 1000.);
            }
            assert_eq!(
                db.query_row("SELECT count(*) FROM word_occurrences", [], |r| r
                    .get::<_, usize>(0))
                    .unwrap(),
                7168
            );
            elapsed.sort_by(f64::total_cmp);
            println!(
                "MEASURE {}",
                json!({"round":round,"batch":size,"total_write_ms":elapsed.iter().sum::<f64>(),
                "p95_transaction_ms":elapsed[(elapsed.len()*95).div_ceil(100)-1]})
            );
        }
    }
}

#[test]
fn skips_changed_deleted_or_completed_revisions_and_rolls_back_failed_batch() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE game_lines(id TEXT PRIMARY KEY,line_text TEXT,timestamp REAL,tokenized INTEGER DEFAULT 0);
        CREATE TABLE words(id INTEGER PRIMARY KEY,word TEXT UNIQUE,reading TEXT,pos TEXT,in_anki INTEGER,first_seen REAL,first_seen_line_id TEXT,last_seen REAL);
        CREATE TABLE kanji(id INTEGER PRIMARY KEY,character TEXT UNIQUE);
        CREATE TABLE word_occurrences(word_id INTEGER,line_id TEXT, UNIQUE(word_id,line_id));
        CREATE TABLE kanji_occurrences(kanji_id INTEGER,line_id TEXT, UNIQUE(kanji_id,line_id));
        INSERT INTO game_lines VALUES ('a','𠀀猫猫',NULL,0),('b','猫',1,0),('c','猫',1,0),('d','猫',1,1),('e','猫',-1,0);
        INSERT INTO words VALUES(71,'猫','古','old',1,4,'first',8);").unwrap();
    let history = History::default();
    let ids = ["a", "b", "c", "d", "e"].map(String::from);
    let mut lines = history.pending_words(&path, &ids, None).unwrap();
    assert_eq!(lines.len(), 4);
    for line in &mut lines {
        line.words.push(Word {
            headword: "猫".into(),
            reading: "ネコ".into(),
            pos: "名詞".into(),
        });
    }
    db.execute_batch(
        "UPDATE game_lines SET line_text='犬' WHERE id='b'; DELETE FROM game_lines WHERE id='c';
        CREATE TRIGGER fail BEFORE INSERT ON word_occurrences WHEN NEW.line_id='e'
        BEGIN SELECT RAISE(ABORT,'fixture'); END;",
    )
    .unwrap();
    assert_eq!(history.store_words(&path, lines, None).unwrap(), 1);
    assert_eq!(
        db.query_row("SELECT sum(tokenized) FROM game_lines", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM word_occurrences WHERE line_id='e'",
            [],
            |r| r.get::<_, usize>(0)
        )
        .unwrap(),
        0
    );
    let mut lines = history.pending_words(&path, &ids, None).unwrap();
    for line in &mut lines {
        line.words.push(Word {
            headword: "猫".into(),
            reading: "ネコ".into(),
            pos: "名詞".into(),
        });
    }
    db.execute_batch("DROP TRIGGER fail; UPDATE game_lines SET timestamp=2 WHERE id='b';")
        .unwrap();
    assert_eq!(history.store_words(&path, lines, None).unwrap(), 0);
    assert_eq!(db.query_row("SELECT count(*) FROM words WHERE id=71 AND reading='古' AND pos='old' AND first_seen=4 AND first_seen_line_id='first' AND last_seen=8 AND in_anki=1", [], |r| r.get::<_,usize>(0)).unwrap(),1);
    assert_eq!(
        db.query_row("SELECT count(*) FROM kanji_occurrences", [], |r| r
            .get::<_, usize>(0))
            .unwrap(),
        3
    );
    // Missing timestamps form a real cursor. A failed NULL row can't trap a backfill.
    db.execute_batch("UPDATE game_lines SET tokenized=0")
        .unwrap();
    let (first, cursor) = history.next_word_page(&path, None, 1, None).unwrap();
    assert_eq!(first, ["a"]);
    assert_eq!(
        history.next_word_page(&path, cursor, 3, None).unwrap().0,
        ["e", "d", "b"]
    );
}

#[test]
fn cleanup_preserves_archive_and_anki_ids_and_repairs_cache_and_first_seen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE game_lines(id TEXT PRIMARY KEY,timestamp REAL);
        CREATE TABLE words(id INTEGER PRIMARY KEY,word TEXT,first_seen REAL,first_seen_line_id TEXT);
        CREATE TABLE word_occurrences(word_id INTEGER,line_id TEXT);
        CREATE TABLE kanji(id INTEGER PRIMARY KEY);
        CREATE TABLE kanji_occurrences(kanji_id INTEGER,line_id TEXT);
        CREATE TABLE archived_word_stats(word_id INTEGER,first_seen REAL,first_line_id TEXT);
        CREATE TABLE word_anki_links(word_id INTEGER);
        CREATE TABLE card_kanji_links(kanji_id INTEGER);
        CREATE TABLE global_frequency_sources(id TEXT,is_default INTEGER);
        CREATE TABLE word_global_frequencies(source_id TEXT,word TEXT,rank INTEGER);
        INSERT INTO game_lines VALUES('a',7),('z',7);
        INSERT INTO words VALUES(1,'猫',3,'deleted'),(2,'犬',4,'deleted'),(3,'鳥',5,'deleted'),(4,'魚',NULL,NULL);
        INSERT INTO word_occurrences VALUES(1,'deleted'),(1,'z'),(1,'a');
        INSERT INTO archived_word_stats VALUES(1,7,'b'),(2,2,'archived');
        INSERT INTO word_anki_links VALUES(3);
        INSERT INTO kanji VALUES(1),(2);
        INSERT INTO card_kanji_links VALUES(1);
        INSERT INTO kanji_occurrences VALUES(2,'deleted');
        INSERT INTO global_frequency_sources VALUES('source',1);
        INSERT INTO word_global_frequencies VALUES('source','猫',123);").unwrap();
    let history = History::default();
    let clean = || {
        history
            .run(
                &path,
                serde_json::from_value(json!({"operation":"cleanWordIndex"})).unwrap(),
            )
            .unwrap()
    };
    assert_eq!(clean(), 4);
    assert_eq!(db.query_row("SELECT count(*) FROM words WHERE (id=1 AND first_seen=7 AND first_seen_line_id='a')
        OR (id=2 AND first_seen=2 AND first_seen_line_id='archived') OR (id=3 AND first_seen_line_id IS NULL AND first_seen IS NULL)", [], |r| r.get::<_,usize>(0)).unwrap(),3);
    assert_eq!(db.query_row("SELECT occurrence_count FROM word_stats_cache WHERE word_id=1 AND active_global_rank=123", [], |r| r.get::<_,usize>(0)).unwrap(),2);
    assert_eq!(clean(), 0);
    let repair = |ids: serde_json::Value, only_missing| {
        history
            .run(
                &path,
                serde_json::from_value(json!({
                    "operation":"repairWordFirstSeen", "ids":ids,"only_missing":only_missing
                }))
                .unwrap(),
            )
            .unwrap()
    };
    db.execute(
        "UPDATE words SET first_seen=99,first_seen_line_id='override'",
        [],
    )
    .unwrap();
    assert_eq!(repair(json!([1, 2]), true), 0);
    assert_eq!(repair(json!([1, 1, 2, -2]), false), 2);
    assert_eq!(
        db.query_row("SELECT first_seen_line_id FROM words WHERE id=3", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "override"
    );
    assert_eq!(repair(serde_json::Value::Null, false), 3);
}
#[test]
fn restoring_a_profile_invalidates_every_phase_of_an_inflight_backfill() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE game_lines(id TEXT PRIMARY KEY, line_text TEXT, timestamp REAL, tokenized INTEGER);
        INSERT INTO game_lines VALUES('same-id','old',1,0);").unwrap();
    let history = gsm_history::History::default();
    let generation = history.generation().unwrap();
    let ids = vec![String::from("same-id")];
    let rows = history
        .pending_words(&path, &ids, Some(generation))
        .unwrap();
    history.close().unwrap();
    db.execute("UPDATE game_lines SET line_text='replacement'", [])
        .unwrap();
    assert!(history.prepare_word_backfill(&path, generation).is_err());
    assert!(history
        .next_word_page(&path, None, 20, Some(generation))
        .is_err());
    assert!(history
        .pending_words(&path, &ids, Some(generation))
        .is_err());
    assert!(history.store_words(&path, rows, Some(generation)).is_err());
    assert_eq!(
        db.query_row("SELECT tokenized FROM game_lines", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
