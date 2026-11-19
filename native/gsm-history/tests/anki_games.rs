use gsm_history::History;
use rusqlite::Connection;
use serde_json::{json, Value};

#[test]
fn content_reports_keep_distinct_tag_rules_and_numeric_date_bounds() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch(
        r#"CREATE TABLE anki_notes(note_id TEXT PRIMARY KEY,tags TEXT,fields_json TEXT);
        CREATE TABLE anki_cards(card_id TEXT PRIMARY KEY,note_id TEXT);
        CREATE TABLE anki_reviews(card_id TEXT,ease TEXT,time_taken TEXT,review_time TEXT);
        INSERT INTO anki_notes VALUES
        ('20','["G_%::A","NSFW"]','{"a.b":{"value":"猫𠀀猫"},"other":{"value":"犬"}}'),
        ('3','["G_%::B"]','{"a.b":{"value":"本"}}'),
        ('1','["G_%suffix","nsfw"]','{"a.b":{"value":"字"}}'),
        ('2','["Gzz::X"]','{}'),('4','invalid','{}');
        INSERT INTO anki_cards VALUES(10,20),(11,20),(12,3),(14,1);
        INSERT INTO anki_reviews VALUES(10,1,1000,20),(11,3,2000,21),(12,1,500,3),
        (14,3,800,1),(14,3,800,2),(14,3,800,3);"#,
    )
    .unwrap();
    let history = History::default();
    let read = |q| {
        history
            .run(&path, serde_json::from_value(q).unwrap())
            .unwrap()
    };
    assert_eq!(
        read(json!({"operation":"ankiEarliestNote","parent_tag":"G_%"})),
        json!({"earliest_date":0.003})
    );
    assert_eq!(
        read(
            json!({"operation":"ankiNoteKanji","parent_tag":"G_%","word_field":"a.b",
        "start":20,"end":20})
        ),
        json!("猫𠀀")
    );
    assert_eq!(
        read(json!({"operation":"ankiContentRetention","parent_tag":"G_%"})),
        json!({
            "nsfw_retention":50.0,"nsfw_reviews":2,"nsfw_avg_time":1.5,
            "sfw_retention":50.0,"sfw_reviews":4,"sfw_avg_time":0.72
        })
    );
    let bounded =
        read(json!({"operation":"ankiContentRetention","parent_tag":"G_%","start":3,"end":20}));
    assert_eq!(bounded["nsfw_reviews"], 1);
    assert_eq!(bounded["sfw_reviews"], 1);
    assert_eq!(bounded["nsfw_retention"], 0.0);
    let earliest = || read(json!({"operation":"ankiEarliestNote","parent_tag":"G_%"}));
    assert_eq!(earliest()["earliest_date"], 0.003);
    conn.execute("UPDATE anki_notes SET tags='[]' WHERE note_id='3'", [])
        .unwrap();
    assert_eq!(earliest()["earliest_date"], 0.02);
    history.close().unwrap();
    drop(conn);
    // Restoring to the same path drops the observer and its cached reports.
    std::fs::rename(&path, dir.path().join("old.db")).unwrap();
    Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE anki_notes(note_id TEXT,tags TEXT);
        INSERT INTO anki_notes VALUES('45','[\"G_%::restored\"]');",
        )
        .unwrap();
    assert_eq!(earliest()["earliest_date"], 0.045);
}

#[test]
fn game_reviews_filter_both_clocks_and_weight_retention_by_note() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("gsm.db");
    let conn = Connection::open(&path).unwrap();
    let read = |start: Option<i64>, end: Option<i64>| {
        let request =
            json!({"operation":"ankiGameStats","parent_tag":"Game","start":start,"end":end});
        History::default()
            .run(&path, serde_json::from_value(request).unwrap())
            .unwrap()
    };
    assert_eq!(read(None, None), json!([]));
    conn.execute_batch(
        r#"CREATE TABLE anki_notes(note_id TEXT PRIMARY KEY,tags TEXT);
        CREATE TABLE anki_cards(card_id TEXT PRIMARY KEY,note_id TEXT);
        CREATE TABLE anki_reviews(card_id TEXT,ease TEXT,time_taken TEXT,review_time TEXT);
        INSERT INTO anki_notes VALUES (10,'["Other","Game::猫::child","Game::unused"]'),
          (20,'["Game::猫"]'),(21,'["Game::猫"]'),(15,'["Game::Bird"]'),(16,'invalid');
        INSERT INTO anki_cards VALUES (1,10),(2,10),(3,20),(4,21),(5,15),(6,16),(7,404);
        INSERT INTO anki_reviews VALUES (1,3,500,10),(1,2,1500,19),(2,4,1000,20),(2,1,1800,21),
          (3,1,2000,17),(4,3,9000,15),(5,3,5000,30),(7,3,5000,15);"#,
    )
    .unwrap();
    assert_eq!(
        read(Some(10), Some(20)),
        json!([
            {"game_name":"Bird","card_count":1,"avg_time_per_card":0,"retention_pct":0,"total_reviews":0,"mined_lines":0},
            {"game_name":"猫","card_count":3,"avg_time_per_card":1.25,"retention_pct":50.0,"total_reviews":4,"mined_lines":0}
        ])
    );
    assert_eq!(read(Some(21), None)[0]["total_reviews"], json!(0));
    assert_eq!(read(None, Some(10))[0]["total_reviews"], json!(1));
    let all: Value = read(None, None);
    assert_eq!(all[1]["total_reviews"], json!(6));
    assert_eq!(all[1]["card_count"], json!(4));
    assert_eq!(all[1]["retention_pct"], json!(58.3));
    conn.execute(
        "UPDATE anki_reviews SET time_taken=2675 WHERE card_id='5'",
        [],
    )
    .unwrap();
    assert_eq!(read(None, None)[0]["avg_time_per_card"], json!(2.67));
}
