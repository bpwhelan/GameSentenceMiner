use gsm_history::anki_sync::{cached_fields, Cache, Note};
use rusqlite::Connection;
use serde_json::json;
use tempfile::{tempdir, TempDir};

fn fixture() -> (TempDir, Cache, Connection) {
    let dir = tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE anki_notes(note_id TEXT PRIMARY KEY, model_name TEXT, fields_json TEXT,
          tags TEXT, mod TEXT, synced_at TEXT);
         CREATE TABLE anki_cards(card_id TEXT PRIMARY KEY, note_id TEXT);
         CREATE TABLE anki_reviews(review_id TEXT PRIMARY KEY, card_id TEXT, note_id TEXT,
          review_time TEXT, ease TEXT, interval TEXT, last_interval TEXT, time_taken TEXT, synced_at TEXT);
         CREATE TABLE words(id INTEGER PRIMARY KEY, word TEXT UNIQUE, in_anki INTEGER);
         CREATE TABLE kanji(id INTEGER PRIMARY KEY, character TEXT UNIQUE);
         CREATE TABLE word_anki_links(id INTEGER PRIMARY KEY, word_id TEXT, note_id TEXT,
          UNIQUE(word_id,note_id));
         CREATE TABLE card_kanji_links(id INTEGER PRIMARY KEY, card_id TEXT, kanji_id TEXT,
          UNIQUE(card_id,kanji_id));",
    ).unwrap();
    let cache = Cache {
        path,
        history: Default::default(),
        generation: 0,
    };
    (dir, cache, db)
}

fn note(id: i64, text: &str) -> Note {
    Note {
        id,
        model: "Mining".into(),
        tags: vec![],
        modified: 1,
        fields_json: cached_fields("word", Some(text)),
    }
}

fn count(db: &Connection, sql: &str) -> i64 {
    db.query_row(sql, [], |r| r.get(0)).unwrap()
}

#[test]
fn failed_pages_roll_back_and_stale_generations_cannot_reopen_the_writer() {
    let (_dir, cache, db) = fixture();
    cache.notes(vec![note(1, "旧")]).unwrap();
    db.execute_batch(
        "CREATE TRIGGER fail BEFORE INSERT ON anki_notes WHEN NEW.note_id='99'
        BEGIN SELECT RAISE(ABORT,'injected'); END;",
    )
    .unwrap();
    assert!(cache.notes(vec![note(1, "新"), note(99, "猫")]).is_err());
    let fields: String = db
        .query_row("SELECT fields_json FROM anki_notes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(fields, cached_fields("word", Some("旧")));
    cache.history.close().unwrap();
    assert!(cache.check().is_err());
    assert!(cache.prune(&[], &[]).is_err());
    assert_eq!(count(&db, "SELECT count(*) FROM anki_notes"), 1);
}

#[test]
fn scoped_links_survive_repeats_and_reconcile_edits_and_dangling_rows() {
    let (_dir, cache, db) = fixture();
    db.execute_batch(
        "INSERT INTO words VALUES(1,'猫猫',0),(2,'犬',0);
         INSERT INTO anki_cards VALUES(10,1),(20,2);
         INSERT INTO card_kanji_links VALUES(50,10,NULL),(51,10,'abc');
         INSERT INTO word_anki_links VALUES(50,NULL,1);",
    )
    .unwrap();
    cache
        .notes(vec![note(1, "　猫猫 "), note(2, "犬")])
        .unwrap();
    assert_eq!(cache.links(&[1, 2], "word").unwrap(), (2, 2));
    let stable = count(&db, "SELECT id FROM card_kanji_links WHERE card_id='10'");
    assert_eq!(cache.links(&[1], "word").unwrap(), (1, 1));
    assert_eq!(
        count(&db, "SELECT id FROM card_kanji_links WHERE card_id='10'"),
        stable
    );
    assert_eq!(cache.flags().unwrap(), 2);
    assert_eq!(count(&db, "SELECT count(*) FROM words WHERE in_anki=1"), 2);
    cache.notes(vec![note(1, "𠀀あ")]).unwrap();
    assert_eq!(cache.links(&[1], "word").unwrap(), (0, 1));
    cache.flags().unwrap();
    assert_eq!(count(&db, "SELECT in_anki FROM words WHERE id=1"), 0);
    assert_eq!(count(&db, "SELECT in_anki FROM words WHERE id=2"), 1);
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM card_kanji_links l JOIN kanji k ON k.id=l.kanji_id
        WHERE (l.card_id=10 AND k.character='𠀀') OR (l.card_id=20 AND k.character='犬')"
        ),
        2
    );
    assert_eq!(count(&db, "SELECT count(*) FROM card_kanji_links"), 2);
}

#[test]
fn stale_note_pruning_is_child_first_atomic_and_retryable() {
    let (_dir, cache, db) = fixture();
    cache.notes(vec![note(1, "猫"), note(2, "犬")]).unwrap();
    db.execute_batch(
        "INSERT INTO anki_cards VALUES(10,1),(20,2);
         INSERT INTO word_anki_links VALUES(1,1,1),(2,2,2),(3,3,404);
         INSERT INTO card_kanji_links VALUES(1,10,1),(2,20,2),(3,404,3);
         CREATE TRIGGER fail BEFORE DELETE ON anki_notes BEGIN SELECT RAISE(ABORT,'injected'); END;",
    ).unwrap();
    let reviews = serde_json::from_value(json!({"20":[{"id":"345","ivl":-3}]})).unwrap();
    assert_eq!(cache.reviews(reviews, true).unwrap(), 1);
    assert!(cache.prune(&[1], &[10, 20]).is_err());
    assert_eq!(count(&db, "SELECT count(*) FROM anki_reviews"), 1);
    db.execute_batch("DROP TRIGGER fail").unwrap();
    let deleted = cache.prune(&[1], &[10, 20]).unwrap();
    assert_eq!(
        serde_json::to_value(deleted).unwrap(),
        json!({
            "stale_notes":1,"stale_cards":1,"deleted_word_anki_links":1,"deleted_card_kanji_links":1,
            "deleted_reviews":1,"deleted_notes":1,"deleted_cards":1
        })
    );
    assert_eq!(count(&db, "SELECT count(*) FROM word_anki_links"), 1);
    assert_eq!(count(&db, "SELECT count(*) FROM card_kanji_links"), 1);
}
