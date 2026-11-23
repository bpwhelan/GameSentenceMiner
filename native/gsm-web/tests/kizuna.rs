use gsm_web::Reports;
use serde_json::json;

const HEADER: &str = "vndb_id,name,date,duration_seconds,chars,lines\r\n";
const ONE: &str = "V58562,Imported,2025-10-20T16:04:42Z,682,2095,102\r\n";

#[test]
fn retries_match_existing_python_ids_and_keep_conflicting_games_separate() {
    let dir = tempfile::tempdir().unwrap();
    let db = gsm_db::open_profile(&dir.path().join("gsm.db"), "ja").unwrap();
    let reports = Reports::new(dir.path(), Default::default());
    let generation = reports.begin_file_import().unwrap();
    db.execute_batch("INSERT INTO games(id,title_original,vndb_id,description) VALUES('known','Original','v58562','Keep'),('conflict','同名','v999','Keep');
        INSERT INTO third_party_stats(source,source_id,date) VALUES('kizuna','1b7dd928ebcca662f8194e8ad4de275c283385028998bcb3ee25d30d202fcd56','2025-10-20'),('manual','','2025-10-21')").unwrap();
    let csv=format!("\u{feff}{HEADER}{ONE}{ONE},\"名,台詞\",1970-01-01T00:00:00Z,1e-5,12,3\r\nv1,同名,1969-12-31T23:59:58.75Z,1e16,2,1\r\n");
    let result = reports
        .import_kizuna(generation, csv.as_bytes(), false)
        .unwrap();
    assert_eq!(result["skipped_count"], 2);
    assert_eq!(result["imported_count"], 2);
    let result = reports
        .import_kizuna(generation, csv.as_bytes(), true)
        .unwrap();
    assert_eq!(result["games_count"], 3);
    assert_eq!(result["vndb_games_count"], 2);
    assert_eq!(result["total_characters"], 2109);
    assert_eq!(result["total_time_seconds"], 10000000000000682.0);
    assert_eq!(result["cleared_count"], 3);
    let mut ids = db
        .prepare("SELECT source_id FROM third_party_stats WHERE source='kizuna' ORDER BY source_id")
        .unwrap();
    let saved: Vec<String> = ids
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        saved,
        [
            "1ad53b8025754213fb210ef4403a938ec745b569f6d74bec41d471e4bb7b5f5a",
            "1b7dd928ebcca662f8194e8ad4de275c283385028998bcb3ee25d30d202fcd56",
            "bf6a7e68c80545a31f9527a9dd7d9720339b0521d66c062ebedb5eab5802c986"
        ]
    );
    assert_eq!(
        db.query_row(
            "SELECT game_id FROM third_party_stats WHERE label='Imported'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "known"
    );
    assert_ne!(
        db.query_row(
            "SELECT game_id FROM third_party_stats WHERE label='同名'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "conflict"
    );
    let again = reports
        .import_kizuna(generation, csv.as_bytes(), false)
        .unwrap();
    assert_eq!(again["date_range"], json!({"min":null,"max":null}));
    assert_eq!(again["skipped_count"], 4);
}

#[test]
fn invalid_data_and_database_errors_restore_the_previous_import() {
    let dir = tempfile::tempdir().unwrap();
    let db = gsm_db::open_profile(&dir.path().join("gsm.db"), "ja").unwrap();
    let reports = Reports::new(dir.path(), Default::default());
    let generation = reports.begin_file_import().unwrap();
    db.execute_batch("INSERT INTO third_party_stats(source,label) VALUES('kizuna','existing')")
        .unwrap();
    for invalid in [
        "",
        HEADER,
        "vndb_id,name,date,duration_seconds,chars,chars",
        &format!("{HEADER}{ONE}bad,game,2025-01-01,1,10,1"),
        &format!("{HEADER}{ONE}v1,game,2025-01-01,1,10,\"15"),
    ] {
        assert_eq!(
            reports
                .import_kizuna(generation, invalid.as_bytes(), true)
                .unwrap_err()
                .status,
            400
        );
    }
    db.execute_batch("CREATE TRIGGER fail_insert BEFORE INSERT ON third_party_stats BEGIN SELECT RAISE(ABORT,'failed'); END;").unwrap();
    assert_eq!(
        reports
            .import_kizuna(generation, format!("{HEADER}{ONE}").as_bytes(), true)
            .unwrap_err()
            .status,
        500
    );
    assert_eq!(
        db.query_row("SELECT label FROM third_party_stats", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "existing"
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM games", [], |r| r.get::<_, usize>(0))
            .unwrap(),
        0
    );
}

#[test]
fn sums_fractional_session_durations_like_existing_exports() {
    let dir = tempfile::tempdir().unwrap();
    gsm_db::open_profile(&dir.path().join("gsm.db"), "ja").unwrap();
    let reports = Reports::new(dir.path(), Default::default());
    let mut data = format!("{HEADER},Book,2020-01-01,1,1,0\n");
    for i in 1..=100 {
        data.push_str(&format!(",Book,2020-01-01,1e-16,1,{i}\n"));
    }
    let result = reports
        .import_kizuna(reports.begin_file_import().unwrap(), data.as_bytes(), false)
        .unwrap();
    assert_eq!(result["imported_count"], 101);
    assert_eq!(result["total_time_seconds"], 1.00000000000001);
}
