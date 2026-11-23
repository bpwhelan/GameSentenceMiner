use gsm_web::Reports;
use serde_json::json;

const HEADER: &str = "uuid,given_identifier,name,line,time\r\n";

#[test]
fn preserves_legacy_ids_and_repeated_dialogue_across_imports() {
    let dir = tempfile::tempdir().unwrap();
    let db = gsm_db::open_profile(&dir.path().join("gsm.db"), "ja").unwrap();
    std::fs::write(dir.path().join("config.json"),json!({
        "current_profile":"Chinese","configs":{"Chinese":{"general":{"target_language":"zh"}}},
        "experimental":{"enable_experimental_features":true,"enable_tokenization":true,"tokenization_sudachi_dictionary":"CORE"}
    }).to_string()).unwrap();
    db.execute_batch("INSERT INTO games(id,title_original,obs_scene_name) VALUES('g','Original','Scene');
        INSERT INTO game_lines(id,game_name,line_text,timestamp,game_id) VALUES('u|old','Scene','old',123,'g')").unwrap();
    let reports = Reports::new(dir.path(), Default::default());
    let generation = reports.begin_file_import().unwrap();
    let csv = format!("\u{feff}{HEADER}u,one,Scene,old,1600000000\r\nu,two,Scene,old,1600000000.25\r\nu,two,Scene,old,0\r\nu,three,Scene, \"before, there\r\nafter \"\"quotes\"\"\",1600000001\r\nu,four,second,Other,1600000002\r\nu,x,Scene,,100\r\nu,y,Scene,bad,no\r\n");
    let mut imported = reports.import_exstatic(generation, csv.as_bytes()).unwrap();
    assert_eq!(
        imported.take_index_ids(),
        (
            "core",
            vec!["u|two".into(), "u|three".into(), "u|four".into()]
        )
    );
    let body = imported.reply(true).body;
    assert_eq!(body["imported_count"], 3);
    assert_eq!(body["games"], json!(["Scene", "second"]));
    assert_eq!(
        body["warnings"],
        json!(["Row 5: Missing line text", "Row 6: Invalid time format: no"])
    );
    let row = db
        .query_row(
            "SELECT line_text, game_id,language FROM game_lines WHERE id='u|three'",
            [],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        row,
        (
            "before, there\r\nafter \"quotes\"".into(),
            "g".into(),
            "zh".into()
        )
    );
    assert_eq!(
        db.query_row(
            "SELECT timestamp FROM game_lines WHERE id='u|two'",
            [],
            |r| r.get::<_, f64>(0)
        )
        .unwrap(),
        1600000000.25
    );
    let again = reports
        .import_exstatic(generation, csv.as_bytes())
        .unwrap()
        .reply(false);
    assert_eq!(again.body["imported_count"], 0);
    assert_eq!(again.body["rollup_status"], "failed");
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM game_lines", [], |r| r
            .get::<_, usize>(0))
            .unwrap(),
        4
    );
}

#[test]
fn rejects_malformed_uploads_and_rolls_back_inserts_and_new_games() {
    let dir = tempfile::tempdir().unwrap();
    let db = gsm_db::open_profile(&dir.path().join("gsm.db"), "ja").unwrap();
    let history = std::sync::Arc::<gsm_history::History>::default();
    let reports = Reports::new(dir.path(), history.clone());
    let generation = reports.begin_file_import().unwrap();
    let valid = format!("{HEADER}u,1,new,yes,1600000000\n");
    let mut malformed = valid.as_bytes().to_vec();
    malformed.extend_from_slice(b"u,2,new,\xff,1600000000\n");
    for csv in [b"".as_slice(), b"client,chars_read", &malformed] {
        assert_eq!(
            reports
                .import_exstatic(generation, csv)
                .err()
                .unwrap()
                .status,
            400
        );
    }
    db.execute_batch("CREATE TRIGGER fail_line BEFORE INSERT ON game_lines WHEN NEW.id='u|2' BEGIN SELECT RAISE(ABORT,'blocked'); END;").unwrap();
    let second = format!("{valid}u,2,new,next,1600000001\n");
    assert_eq!(
        reports
            .import_exstatic(generation, second.as_bytes())
            .err()
            .unwrap()
            .status,
        500
    );
    history.close().unwrap();
    assert_eq!(
        reports
            .import_exstatic(generation, valid.as_bytes())
            .err()
            .unwrap()
            .status,
        500
    );
    for table in ["games", "game_lines"] {
        assert_eq!(
            db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                .get::<_, usize>(0))
                .unwrap(),
            0
        );
    }
}
