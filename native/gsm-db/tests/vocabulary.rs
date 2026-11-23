use gsm_db::{migrate, vocabulary::configure};
use rusqlite::Connection;

#[test]
fn adoption_repairs_duplicate_kanji_and_preserves_mining_history_on_disable() {
    let mut db = Connection::open_in_memory().unwrap();
    migrate(&mut db, "ja").unwrap();
    db.execute_batch("INSERT INTO game_lines(id,timestamp,line_text,tokenized) VALUES('l',100,'日',1);
        CREATE TABLE words(id INTEGER PRIMARY KEY, word TEXT);
        CREATE TABLE kanji(id INTEGER PRIMARY KEY, character TEXT);
        CREATE INDEX idx_kanji_character ON kanji(character); INSERT INTO kanji VALUES(1,'日'),(2,'日');
        CREATE TABLE kanji_occurrences(id INTEGER PRIMARY KEY,kanji_id TEXT,line_id TEXT);
        INSERT INTO kanji_occurrences VALUES(1,'1','l'),(2,'2','l');
        CREATE TABLE word_occurrences(id INTEGER PRIMARY KEY,word_id TEXT,line_id TEXT);
        INSERT INTO words VALUES(3,'日'); INSERT INTO word_occurrences VALUES(1,'3','l'),(2,'3','l');").unwrap();
    configure(&mut db, true).unwrap();
    let count = |db: &Connection, sql: &str| db.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM kanji_occurrences WHERE kanji_id=1"
        ),
        1
    );
    assert_eq!(
        count(
            &db,
            "SELECT occurrence_count FROM word_stats_cache WHERE word_id=3"
        ),
        1
    );
    assert_eq!(count(&db, "SELECT tokenized FROM game_lines"), 1);
    let changes = db.total_changes();
    configure(&mut db, true).unwrap();
    assert_eq!(db.total_changes(), changes);
    configure(&mut db, false).unwrap();
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM sqlite_schema WHERE name='anki_cards'"
        ),
        0
    );
    assert_eq!(count(&db, "SELECT count(*) FROM game_lines"), 1);
    configure(&mut db, true).unwrap();
    assert_eq!(count(&db, "SELECT tokenized FROM game_lines"), 0);
}
#[test]
fn disabling_on_a_pre_migration_profile_preserves_line_state() {
    let mut db = rusqlite::Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE game_lines(id TEXT PRIMARY KEY); INSERT INTO game_lines VALUES('before')",
    )
    .unwrap();
    gsm_db::vocabulary::configure(&mut db, false).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT tokenized FROM game_lines WHERE id='before'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}
