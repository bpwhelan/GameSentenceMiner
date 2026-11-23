use gsm_history::History;
use gsm_web::{yomitan_frequency::Response, Reports};
use serde_json::{json, Value};
use std::{fs, io::Cursor, sync::Arc};

fn metadata(response: Response, status: u16) -> Value {
    match response {
        Response::Json(reply) => {
            assert_eq!(reply.status, status);
            reply.body
        }
        _ => panic!("Expected JSON response"),
    }
}

#[test]
fn exports_readings_live_and_archived_frequencies_and_advertises_the_profile_port() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let mut db = gsm_db::open_profile(&path, "ja").unwrap();
    let reports = Reports::new(dir.path(), Arc::new(History::default()));
    for index_only in [true, false] {
        assert_eq!(
            metadata(reports.yomitan_frequency(index_only), 404)["error"],
            "Tokenization must be enabled to use the frequency dictionary"
        );
    }
    fs::write(dir.path().join("config.json"),r#"{"current_profile":"JP","configs":{"JP":{"general":{"single_port":8123}}},"experimental":{"enable_experimental_features":true,"enable_tokenization":true}}"#).unwrap();
    gsm_db::vocabulary::configure_desktop(&mut db, true).unwrap();
    let index = metadata(reports.yomitan_frequency(true), 200);
    assert_eq!(
        index["indexUrl"],
        "http://127.0.0.1:8123/api/yomitan-freq-index"
    );
    assert!(index["revision"].as_str().unwrap().parse::<i64>().is_ok());
    assert_eq!(
        metadata(reports.yomitan_frequency(false), 404)["error"],
        "No frequency data available. Play some games with tokenization enabled."
    );
    db.execute_batch(
        "INSERT INTO game_lines(id,game_name,timestamp) VALUES('a','G',1);
        INSERT INTO words(id,word,reading) VALUES(1,'猫','ねこ'),(2,'見る',NULL),(3,'unused',NULL);
        INSERT INTO word_occurrences(word_id,line_id) VALUES(1,'a'),(2,'a'),(2,'missing');
        INSERT INTO archived_game_days VALUES('G','2020-01-01','G',X'','{}','{}',0,1,1,0,1,1,'{}');
        INSERT INTO archived_word_stats VALUES('G','2020-01-01',1,'猫','ねこ','',3,0,1,'old')",
    )
    .unwrap();
    let Response::Archive(bytes) = reports.yomitan_frequency(false) else {
        panic!("Expected dictionary");
    };
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    assert_eq!(zip.len(), 2);
    let manifest: Value = serde_json::from_reader(zip.by_name("index.json").unwrap()).unwrap();
    assert_eq!(
        manifest["downloadUrl"],
        "http://127.0.0.1:8123/api/yomitan-freq-dict"
    );
    let terms: Value =
        serde_json::from_reader(zip.by_name("term_meta_bank_1.json").unwrap()).unwrap();
    assert_eq!(
        terms,
        json!([["猫","freq",{"reading":"ねこ","frequency":4}],["見る","freq",1]])
    );
}
