use gsm_web::{GameEdit, GameRemoval, Reports, Route, SceneOperation};
use rusqlite::Connection;
use serde_json::{json, Value};

#[test]
fn library_combines_rollups_imports_live_and_archived_days_without_double_counting() {
    let dir = tempfile::tempdir().unwrap();
    let db = gsm_db::open_profile(&dir.path().join("gsm.db"), "ja").unwrap();
    db.execute_batch("INSERT INTO games(id,title_original,links,image,character_count,completed) VALUES
        ('a','漢字','[{\"url\":\"https://www.igdb.com/games/demo\"}]','image bytes',NULL,1);
        INSERT INTO game_lines(id,game_id,game_name,timestamp,line_text) VALUES
          ('a1','a','Scene',1600000000,'過去'),('a2','a','Renamed',1700000000,'現在。'),('unlinked',NULL,'Other',1700000010,'文');
        INSERT INTO daily_stats_rollup(date,game_activity_data) VALUES('2020-09-13','{\"a\":{\"lines\":1,\"chars\":2}}');
        INSERT INTO archived_game_days VALUES('a','2021-01-01','Scene',x'', '{}','{}',1650000001,4,30,1609513200,1609513800,0,'{}');
        INSERT INTO third_party_stats(game_id,date,timestamp,characters_read,lines_read) VALUES('a','2023-11-15',1700100000,13,2);").unwrap();
    let reports = Reports::new(dir.path(), Default::default());
    let data = reports
        .read(Route::GamesManagement, "sort=character_count")
        .unwrap()
        .unwrap()
        .body;
    let game = &data["games"][0];
    assert_eq!(game["id"], "a");
    assert_eq!(game["mined_character_count"], 48);
    assert_eq!(game["line_count"], 8);
    assert_eq!(game["game_names"], json!(["Renamed", "Scene"]));
    assert_eq!(game["raw_line_count"], 2);
    assert_eq!(game["archived_line_count"], 4);
    assert_eq!(game["jiten_character_count"], Value::Null);
    assert_eq!(game["last_played"], 1700100000.0);
    assert_eq!(game["start_date"], 1600000000.0);
    assert_eq!(game["has_image"], true);
    assert_eq!(game["is_linked"], true);
    assert_eq!(game["status"], "completed");
    assert!(game.get("image").is_none());
    assert_eq!(
        data["summary"],
        json!({"total_games":2,"linked_games":1,"unlinked_games":1})
    );
    assert_eq!(
        db.query_row(
            "SELECT game_id IS NOT NULL FROM game_lines WHERE id='unlinked'",
            [],
            |r| r.get::<_, bool>(0)
        )
        .unwrap(),
        true
    );
}

#[test]
fn sorted_library_sees_commits_from_another_connection_on_the_next_read() {
    let dir = tempfile::tempdir().unwrap();
    let db = gsm_db::open_profile(&dir.path().join("gsm.db"), "ja").unwrap();
    db.execute_batch(
        "INSERT INTO games(id,title_original) VALUES ('z','Alpha'),('a','Beta');
        INSERT INTO game_lines(id,game_id,line_text,timestamp) VALUES('one','a','本',1)",
    )
    .unwrap();
    let reports = Reports::new(dir.path(), Default::default());
    let list = |query| {
        reports
            .read(Route::GamesManagement, query)
            .unwrap()
            .unwrap()
            .body
    };
    assert_eq!(list("sort=title")["games"][0]["id"], "z");
    assert_eq!(list("sort=line_count")["games"][0]["id"], "a");
    assert_eq!(list("sort=line_count")["games"][0]["line_count"], 1);
    db.execute_batch(
        "INSERT INTO game_lines(id,game_id,line_text,timestamp) VALUES
        ('two','z','猫',2),('three','z','犬',3)",
    )
    .unwrap();
    let updated = list("sort=line_count");
    assert_eq!(updated["games"][0]["id"], "z");
    assert_eq!(updated["games"][0]["line_count"], 2);
}

#[test]
fn merging_archived_games_preserves_shared_day_and_word_counts() {
    use gsm_web::MaintenanceJob;
    use std::sync::Arc;
    let dir = tempfile::tempdir().unwrap();
    let mut db = gsm_db::open_profile(&dir.path().join("gsm.db"), "ja").unwrap();
    gsm_db::vocabulary::configure(&mut db, true).unwrap();
    std::fs::write(
        dir.path().join("config.json"),
        r#"{"experimental":{"enable_experimental_features":true,"enable_tokenization":true}}"#,
    )
    .unwrap();
    db.execute_batch(
        "INSERT INTO games(id,title_original) VALUES('target','Target'),('source','Source');
        INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp,tokenized) VALUES
        ('one','source','Source','猫',1600000000,1),('two','target','Target','猫犬',1600000060,1);
        INSERT INTO words(id,word,reading,pos) VALUES(5,'猫','ねこ','noun');
        INSERT INTO word_occurrences(word_id,line_id) VALUES(5,'one'),(5,'two');",
    )
    .unwrap();
    let reports = Arc::new(Reports::new(dir.path(), Default::default()));
    for id in ["source", "target"] {
        MaintenanceJob::ArchiveGame(id.into())
            .reserve(reports.clone(), &json!({"confirm":true}))
            .ok()
            .unwrap()
            .run()
            .unwrap();
    }
    db.execute_batch("INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp) VALUES('three','source','Source','本',1600000120)").unwrap();
    let edit = |sources| {
        reports
            .edit_scenes(
                SceneOperation::Merge,
                &json!({"target_game":"Target","games_to_merge":sources}),
            )
            .unwrap()
    };
    assert_eq!(edit(json!(["Source", "Source"])).status, 400);
    assert_eq!(edit(json!(["Target"])).status, 400);
    let result = edit(json!(["Source"]));
    assert_eq!(result.status, 200);
    assert_eq!(result.body["lines_moved"], 2);
    assert_eq!(result.body["total_lines_in_primary"], 3);
    assert_eq!(
        db.query_row(
            "SELECT frequency FROM archived_word_stats WHERE game_id='target' AND word_id=5",
            [],
            |r| r.get::<_, u64>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(
        db.query_row(
            "SELECT json_extract(raw_kanji,'$.猫') FROM archived_game_days WHERE game_id='target'",
            [],
            |r| r.get::<_, u64>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(
        db.query_row(
            "SELECT original_game_name FROM game_lines WHERE game_id='target'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "Source"
    );
    let restore = MaintenanceJob::RestoreArchive(gsm_history::game_archive::file_id("source"))
        .reserve(reports, &json!({"confirm":true}))
        .ok()
        .unwrap();
    assert!(restore
        .run()
        .unwrap_err()
        .to_string()
        .contains("part of an archived day"));
}

#[test]
fn moving_and_deleting_scenes_preserve_original_names_and_failed_game_records() {
    let temp = tempfile::tempdir().unwrap();
    let db = gsm_db::open_profile(&temp.path().join("gsm.db"), "ja").unwrap();
    db.execute_batch("INSERT INTO games(id,title_original,obs_scene_name) VALUES('a','Archived','Original'),('b','Target','Target'),('c','Empty','Empty scene');
        INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp) VALUES('one','a','Original','文',1600000000),
        ('two','a','Original','字',1600000002),('three','b','Target','猫',1600000040);
        CREATE TRIGGER hold_line BEFORE UPDATE ON game_lines WHEN OLD.id='two' BEGIN SELECT raise(ABORT,'protected update'); END;").unwrap();
    let reports = Reports::new(temp.path(), Default::default());
    let moved = reports
        .edit_scenes(
            SceneOperation::Migrate,
            &json!({"line_ids":["one","two","absent","one"],"target_game":"Target"}),
        )
        .unwrap();
    assert_eq!(moved.status, 200);
    assert_eq!(moved.body["migrated_count"], 2);
    assert_eq!(moved.body["failed_ids"], json!(["two", "absent"]));
    assert_eq!(db.query_row("SELECT count(*) FROM game_lines WHERE id='one' AND game_id='b' AND original_game_name='Original'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    db.execute_batch("CREATE TRIGGER retain BEFORE DELETE ON game_lines WHEN OLD.id='two' BEGIN SELECT raise(ABORT,'protected delete'); END;").unwrap();
    let remove = |names| {
        reports
            .edit_scenes(SceneOperation::Delete, &json!({"game_names":names}))
            .unwrap()
    };
    assert_eq!(remove(json!(["missing", "Target"])).status, 400);
    let result = remove(json!(["Empty scene", "Original", "Target"]));
    assert_eq!(result.status, 207);
    assert_eq!(result.body["total_sentences_deleted"], 2);
    assert_eq!(result.body["deleted_game_records"], 2);
    assert_eq!(result.body["failed_games"], json!(["Original"]));
    assert_eq!(
        db.query_row("SELECT id FROM games", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "a"
    );
    assert_eq!(
        db.query_row("SELECT id FROM game_lines", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "two"
    );
}

#[test]
fn manages_legacy_lines_and_preserves_original_scene_and_manual_overrides() {
    let dir = tempfile::tempdir().unwrap();
    let db = gsm_db::open_profile(&dir.path().join("gsm.db"), "ja").unwrap();
    db.execute_batch(
        "INSERT INTO game_lines(id,game_name,line_text,timestamp) VALUES
        ('a','台本','朝。',10),('b','台本','犬',12),('c','Unrelated','猫',20);
        INSERT INTO games(id,title_original) VALUES('other','Unrelated');",
    )
    .unwrap();
    let reports = Reports::new(dir.path(), Default::default());
    let orphaned = || {
        reports
            .read(Route::OrphanedGames, "")
            .unwrap()
            .unwrap()
            .body
    };
    assert_eq!(
        orphaned()["orphaned_games"],
        json!([{"game_name":"台本","line_count":2,"character_count":3,"first_seen":10.0,"last_seen":12.0}])
    );
    let create = || {
        reports.edit_game(GameEdit::Create,json!({"title_original":" 台本 ","status":"planned","links":[{"url":"https://example.org"}]}))
    };
    let created = create();
    assert_eq!(created.status, 201);
    assert_eq!(created.body["game"]["lines_linked"], 2);
    assert_eq!(created.body["game"]["status"], "planned");
    assert_eq!(create().status, 400);
    assert_eq!(orphaned()["total_orphaned"], 0);
    let id = created.body["game"]["id"].as_str().unwrap();
    let edit = |body| reports.edit_game(GameEdit::Update(id.into()), body);
    assert_eq!(edit(json!({"status":"unknown"})).status, 400);
    assert_eq!(edit(json!({"irrelevant":true})).status, 400);
    let edited = edit(
        json!({"title_original":"New title","type":"Visual Novel","vndb_id":" 123 ","completed":false,"tags":["historical"]}),
    );
    assert_eq!(edited.status, 200);
    assert_eq!(
        edited.body["updated_fields"],
        json!([
            "title_original",
            "game_type",
            "completed",
            "vndb_id",
            "tags"
        ])
    );
    assert_eq!(
        edited.body["manual_overrides"],
        json!(["title_original", "type", "completed", "tags", "vndb_id"])
    );
    let query = |db: &Connection| {
        db.query_row(
            "SELECT title_original,vndb_id,status,completed=1 FROM games WHERE id=?",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, bool>(3)?,
                ))
            },
        )
        .unwrap()
    };
    assert_eq!(
        query(&db),
        ("New title".into(), "v123".into(), "planned".into(), false)
    );
    assert_eq!(
        reports
            .edit_game(GameEdit::Complete(id.into()), Value::Null)
            .body["completed"],
        true
    );
    assert_eq!(query(&db).2, "completed");
    assert_eq!(edit(json!({"completed":false})).status, 200);
    assert_eq!(query(&db).2, "in_progress");
    assert_eq!(
        reports
            .edit_game(GameEdit::Complete("missing".into()), Value::Null)
            .status,
        404
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM game_lines WHERE game_name='台本' AND game_id=?",
            [id],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
}

#[test]
fn unlink_preserves_archives_and_delete_rebuilds_old_aggregates_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let db = gsm_db::open_profile(&dir.path().join("gsm.db"), "ja").unwrap();
    db.execute_batch("INSERT INTO games(id,title_original,deck_id,vndb_id,links) VALUES
      ('archived','Archived',5,'v7','[1]'),('live','Live',NULL,NULL,'[]');
      INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp) VALUES
        ('a','archived','Archived','日',1600000000),('b','live','Live','本',1600000001);
      INSERT INTO archived_game_days VALUES('archived','2020-09-10','Archived',x'00','','',0,3,9,1,2,0,'{}');
      INSERT INTO daily_stats_rollup(date,game_activity_data,games_played_ids) VALUES('2020-08-01','{\"archived\":{\"lines\":1}}','[]');
      INSERT INTO game_daily_rollup(date,game_id) VALUES('2020-08-02','archived');").unwrap();
    let reports = Reports::new(dir.path(), Default::default());
    let remove = |id, kind| reports.remove_game(id, kind).unwrap();
    assert_eq!(
        remove("archived", GameRemoval::Unlink).body,
        json!({"success":true,"game_name":"Archived","unlinked_lines":0})
    );
    assert_eq!(db.query_row("SELECT deck_id IS NULL AND vndb_id IS NULL AND links='[]' FROM games WHERE id='archived'",[],|r|r.get::<_,bool>(0)).unwrap(),true);
    db.execute_batch(
        "CREATE TRIGGER fail_delete BEFORE DELETE ON games WHEN OLD.id='archived'
        BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
    )
    .unwrap();
    assert_eq!(remove("archived", GameRemoval::DeleteLines).status, 500);
    assert_eq!(
        db.query_row("SELECT count(*) FROM game_lines", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    db.execute_batch("DROP TRIGGER fail_delete;").unwrap();
    assert_eq!(
        remove("archived", GameRemoval::DeleteLines).body["deleted_lines"],
        1
    );
    for table in [
        "archived_game_days",
        "game_daily_rollup",
        "daily_stats_rollup",
    ] {
        let query = if table == "archived_game_days" {
            format!("SELECT count(*) FROM {table}")
        } else {
            format!("SELECT count(*) FROM {table} WHERE date<'2020-09-01'")
        };
        assert_eq!(db.query_row(&query, [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }
    assert_eq!(
        remove("live", GameRemoval::Unlink).body["unlinked_lines"],
        1
    );
    assert_eq!(
        db.query_row(
            "SELECT game_id IS NULL FROM game_lines WHERE id='b'",
            [],
            |r| r.get::<_, bool>(0)
        )
        .unwrap(),
        true
    );
    assert_eq!(remove("missing", GameRemoval::Unlink).status, 404);
}
