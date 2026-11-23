use gsm_web::{Maintenance, MaintenanceJob, Reports, Route};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::{fs, io::Write};

#[test]
fn scheduled_maintenance_archives_only_completed_inactive_games_and_runs_vacuum_when_due() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("gsm.db");
    let db = gsm_db::open_profile(&path, "ja").unwrap();
    db.execute_batch("INSERT INTO games(id,title_original,status) VALUES ('old','Old','completed'),('live','Live','in_progress'),('recent','Recent','completed');
        INSERT INTO game_lines(id,game_id,line_text,timestamp) VALUES ('a','old','古',1600000000),('b','live','新',1600000000),('c','recent','近',1699999990)").unwrap();
    let history = Arc::new(gsm_history::History::default());
    let reports = Arc::new(Reports::new(temp.path(), history.clone()));
    let run = || {
        reports
            .clone()
            .scheduled_maintenance(history.generation().unwrap(), 1700000000.0, |_, _| {
                panic!("disabled index")
            })
            .unwrap()
            .unwrap()
    };
    assert_eq!(run()["archived_games"], 0);
    assert_eq!(
        reports
            .save_maintenance_settings(json!({"archive_after_days":14,"vacuum_interval_days":30}))
            .status,
        200
    );
    let guard = history.try_maintenance(&path).unwrap().unwrap();
    assert_eq!(run()["skipped"], true);
    drop(guard);
    let result = run();
    assert_eq!(result["archived_games"], 1);
    assert_eq!(result["archived_lines"], 1);
    assert_eq!(result["success"], true);
    assert!(result["vacuum"]["after_bytes"].as_u64().is_some());
    assert_eq!(run()["vacuum"], serde_json::Value::Null);
    assert_eq!(
        db.query_row(
            "SELECT group_concat(id,'') FROM (SELECT id FROM game_lines ORDER BY id)",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "bc"
    );
}

#[test]
fn batch_job_reports_per_game_progress_and_continues_after_a_failed_game() {
    let temp = tempfile::tempdir().unwrap();
    let db = gsm_db::open_profile(&temp.path().join("gsm.db"), "ja").unwrap();
    db.execute_batch("INSERT INTO games(id,title_original) VALUES('a','A'),('b','B'),('c','C');
        INSERT INTO game_lines(id,game_id,line_text,timestamp) VALUES('one','a','文',1600000000),('two','b','本',1600000000);
        CREATE TRIGGER fail_a BEFORE DELETE ON game_lines WHEN OLD.game_id='a' BEGIN SELECT raise(ABORT,'injected'); END").unwrap();
    let reports = Arc::new(Reports::new(temp.path(), Default::default()));
    let reserve = |body| MaintenanceJob::ArchiveSelected.reserve(reports.clone(), &body);
    assert!(matches!(reserve(json!({"confirm":false,"game_ids":["a"]})),Err(r) if r.status==400));
    let work = reserve(json!({"confirm":true,"game_ids":["a","b","c","b"]}))
        .ok()
        .unwrap();
    let steps = std::cell::RefCell::new(Vec::new());
    let result = work
        .run_with(
            |_, _| panic!("unexpected dictionary work"),
            |p| steps.borrow_mut().push(p),
        )
        .unwrap();
    assert_eq!(result["archived_lines"], 1);
    assert_eq!(result["successful_game_ids"], json!(["b", "c"]));
    assert_eq!(result["skipped_games"], 1);
    assert_eq!(result["failed_games"][0]["game_id"], "a");
    assert_eq!(steps.into_inner().last().unwrap()["completed_games"], 3);
    assert_eq!(
        db.query_row("SELECT id FROM game_lines", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "one"
    );
}

#[test]
fn vacuum_holds_profile_lock_and_preserves_surviving_rows() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("gsm.db");
    let db = gsm_db::open_profile(&path, "ja").unwrap();
    db.execute_batch(
        "CREATE TABLE payload(id INTEGER PRIMARY KEY,value BLOB);
        WITH RECURSIVE i(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM i WHERE n<128)
        INSERT INTO payload SELECT n,zeroblob(8192) FROM i;
        DELETE FROM payload WHERE id>1",
    )
    .unwrap();
    let history = Arc::new(gsm_history::History::default());
    let reports = Arc::new(Reports::new(temp.path(), history.clone()));
    let reserve = || MaintenanceJob::Vacuum.reserve(reports.clone(), &json!(null));
    let work = reserve().ok().unwrap();
    assert!(matches!(reserve(),Err(reply) if reply.status==409));
    let result = work.run().unwrap();
    assert!(result["reclaimed_bytes"].as_u64().unwrap() > 1024 * 512);
    assert_eq!(
        db.query_row("SELECT length(value) FROM payload WHERE id=1", [], |r| {
            r.get::<_, usize>(0)
        })
        .unwrap(),
        8192
    );
    assert!(
        db.query_row("SELECT last_vacuum FROM database_maintenance", [], |r| r
            .get::<_, f64>(0))
            .unwrap()
            > 0.0
    );
    let stale = reserve().ok().unwrap();
    history.close().unwrap();
    assert!(stale.run().unwrap_err().to_string().contains("cancelled"));
    assert!(reserve().is_ok());
}

#[test]
fn catalog_validates_each_identity_and_lists_damaged_archives() {
    let temp = tempfile::tempdir().unwrap();
    let reports = Reports::new(temp.path(), Default::default());
    let list = || reports.read(Route::ArchiveFiles, "").unwrap().unwrap().body;
    assert_eq!(list()["archives"], json!([]));
    let directory = temp.path().join("archives/games");
    fs::create_dir_all(&directory).unwrap();
    let id = format!("{:x}", Sha256::digest("game"));
    let good = directory.join(format!("game-猫--{id}.gsm-archive.zip"));
    let mut zip = zip::ZipWriter::new(fs::File::create(&good).unwrap());
    zip.start_file("manifest.json", zip::write::SimpleFileOptions::default())
        .unwrap();
    serde_json::to_writer(&mut zip,&json!({"format":"gsm-game-archive","version":1,"game_id":"game","game":{"id":"game","image":"x".repeat(65536)},"game_name":"猫","line_count":3})).unwrap();
    zip.start_file("game_lines.jsonl", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"not needed for listing").unwrap();
    drop(zip.finish().unwrap());
    let corrupt = "0".repeat(64);
    fs::write(
        directory.join(format!("game-other--{corrupt}.gsm-archive.zip")),
        "broken zip",
    )
    .unwrap();
    let catalog = list();
    let files = catalog["archives"].as_array().unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!(
        files.iter().find(|x| x["file_id"] == id).unwrap()["line_count"],
        3
    );
    assert_eq!(
        files.iter().find(|x| x["file_id"] == corrupt).unwrap()["can_restore"],
        false
    );
    let download = reports.archive_download(&id).unwrap();
    assert_eq!(download.path, good.canonicalize().unwrap());
    assert!(download.disposition().contains("filename*=UTF-8''"));
    assert!(matches!(reports.archive_download("../file"), Err((400, _))));
    assert!(matches!(
        reports.archive_download(&"a".repeat(64)),
        Err((404, _))
    ));
    fs::copy(&good, directory.join(format!("copy--{id}.gsm-archive.zip"))).unwrap();
    assert!(matches!(reports.archive_download(&id), Err((400, _))));
    assert_eq!(list()["archives"].as_array().unwrap().len(), 1);
}

#[test]
fn batch_preview_and_retention_settings_use_the_existing_profile() {
    let temp = tempfile::tempdir().unwrap();
    let db = gsm_db::open_profile(&temp.path().join("gsm.db"), "ja").unwrap();
    db.execute_batch(
        "INSERT INTO games(id,title_original) VALUES('a','A'),('b','B');
        INSERT INTO game_lines(id,game_id,line_text,timestamp) VALUES('1','a','文',1);",
    )
    .unwrap();
    let reports = Reports::new(temp.path(), Default::default());
    let preview = |ids| {
        reports
            .maintenance(Maintenance::PreviewArchive, json!({"game_ids":ids}))
            .unwrap()
    };
    assert_eq!(
        preview(json!(["b", "a", "a"])).body,
        json!({"game_count":2,"raw_lines":1})
    );
    for ids in [json!([]), json!(["missing"]), json!([" "]), json!("a")] {
        assert_eq!(preview(ids).status, 400);
    }
    let save = |v| reports.save_maintenance_settings(v);
    assert_eq!(
        save(json!({"vacuum_interval_days":21})).body["settings"]["vacuum_interval_days"],
        21
    );
    assert_eq!(
        save(json!({"archive_after_days":30})).body["settings"],
        json!({"vacuum_interval_days":21,"archive_after_days":30,"last_vacuum":null})
    );
    for v in [
        json!({"unknown":0}),
        json!({"vacuum_interval_days":false}),
        json!({"archive_after_days":-1}),
        json!({"archive_after_days":12.5}),
        json!({"archive_after_days":3651}),
    ] {
        assert_eq!(save(v).status, 400);
    }
    assert_eq!(
        reports
            .read(Route::DatabaseStatus, "")
            .unwrap()
            .unwrap()
            .body["settings"],
        save(json!({})).body["settings"]
    );
}
