use chrono::{Local, TimeZone};
use gsm_history::History;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;

fn report(path: &Path, weeks: Value) -> Value {
    let request = json!({"operation":"maturityHistory", "word_field":"Expression",
        "today":"2024-01-10", "weeks":weeks});
    History::default()
        .run(path, serde_json::from_value(request).unwrap())
        .unwrap()
}

fn noon(day: u32) -> i64 {
    Local
        .with_ymd_and_hms(2024, 1, day, 12, 0, 0)
        .unwrap()
        .timestamp()
}

#[test]
fn maturity_merges_both_note_sources_and_prefers_reviews_before_collapsing_words() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(r#"
        CREATE TABLE anki_notes(note_id INTEGER PRIMARY KEY, fields_json TEXT);
        CREATE TABLE anki_cards(card_id INTEGER PRIMARY KEY, note_id INTEGER, interval INTEGER, synced_at REAL);
        CREATE TABLE anki_reviews(card_id INTEGER, note_id INTEGER, interval INTEGER, review_time INTEGER);
        CREATE TABLE card_kanji_links(card_id INTEGER, kanji_id INTEGER);
        INSERT INTO anki_notes VALUES
          (1,'{"Old":{"value":"ignore"},"Expression":{"value":"　猫　"}}'),
          (2,'{"Z":{"value":"猫"},"A":{"value":"ignore"}}'),
          (3,'{"Expression":{"value":"　"},"Old":{"value":"犬"}}'),
          (4,'malformed'),(5,'{"Expression":{"value":"鳥"}}'),(6,'{"Expression":{"value":"亀"}}');
        INSERT INTO card_kanji_links VALUES (101,1),(102,1),(102,2),(103,2),(104,3),(105,NULL);
    "#).unwrap();
    db.execute_batch(&format!("INSERT INTO anki_cards VALUES (101,1,21,{early}), (102,2,22,{early}), (103,3,21,{early}), (104,4,21,NULL), (105,5,21,{future}), (106,6,20,{early});
        INSERT INTO anki_reviews VALUES (101,0,21,{later}), (102,3,21,{first}), (102,2,20,{ignored});",
        early=noon(2), later=noon(8)*1000, first=noon(7)*1000, ignored=noon(1)*1000, future=noon(11))).unwrap();
    let daily = report(&path, Value::Null);
    assert_eq!(
        daily["labels"],
        json!(["2024-01-07", "2024-01-08", "2024-01-09", "2024-01-10"])
    );
    assert_eq!(
        daily["series"]["mature_words"],
        json!({"label":"Mature Words","total":3,"daily_new":[2,0,0,0],"cumulative":[2,2,2,2]})
    );
    assert_eq!(
        daily["series"]["unique_kanji"],
        json!({"label":"Unique Kanji","total":3,"daily_new":[2,0,0,1],"cumulative":[2,2,2,3]})
    );
    assert_eq!(
        report(&path, json!({"start":"2024-01-05","end":"2024-01-09"})),
        json!({"mature_words":[2,0],"mature_kanji":[2,0]})
    );
    assert_eq!(
        report(&path, json!({"start":"2024-01-08","end":"2024-01-10"})),
        json!({"mature_words":[0],"mature_kanji":[1]})
    );
}

#[test]
fn maturity_accepts_partial_caches_and_counts_reviews_without_cards() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = Connection::open(&path).unwrap();
    assert_eq!(report(&path, Value::Null)["labels"], json!([]));
    db.execute_batch(r#"CREATE TABLE anki_notes(note_id INTEGER PRIMARY KEY, fields_json TEXT);
        CREATE TABLE anki_reviews(card_id INTEGER, note_id INTEGER, interval INTEGER, review_time INTEGER);
        INSERT INTO anki_notes VALUES(42,'{"Other":{"value":"雨"}}');
        INSERT INTO anki_reviews VALUES(100,42,21,'unknown');"#).unwrap();
    let daily = report(&path, Value::Null);
    assert_eq!(daily["labels"], json!(["2024-01-10"]));
    assert_eq!(daily["series"]["mature_words"]["daily_new"], json!([1]));
    assert_eq!(daily["series"]["unique_kanji"]["daily_new"], json!([0]));
}

#[test]
fn card_only_text_cache_keeps_future_totals_out_of_todays_chart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(r#"CREATE TABLE anki_notes(note_id TEXT PRIMARY KEY, fields_json TEXT);
        CREATE TABLE anki_cards(card_id TEXT PRIMARY KEY, note_id TEXT, interval TEXT, synced_at TEXT);
        CREATE TABLE card_kanji_links(card_id TEXT, kanji_id TEXT);
        INSERT INTO anki_notes VALUES ('2','{"Expression":{"value":"未来"}}');
        INSERT INTO card_kanji_links VALUES ('3','1');"#).unwrap();
    db.execute("INSERT INTO anki_cards VALUES ('3','2','21',?)", [noon(11)])
        .unwrap();
    let daily = report(&path, Value::Null);
    assert_eq!(daily["labels"], json!([]));
    for key in ["mature_words", "unique_kanji"] {
        assert_eq!(daily["series"][key]["total"], 1);
        assert_eq!(daily["series"][key]["daily_new"], json!([]));
    }
}
