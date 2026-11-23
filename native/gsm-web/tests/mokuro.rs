use gsm_web::Reports;
use serde_json::json;

#[test]
fn imports_daily_high_water_marks_and_replaces_only_mokuro_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let db = gsm_db::open_profile(&dir.path().join("gsm.db"), "ja").unwrap();
    db.execute_batch("INSERT INTO third_party_stats(date, source, label) VALUES('2020-02-01','mokuro','old'),('2020-02-01','manual','keep')").unwrap();
    let history = std::sync::Arc::<gsm_history::History>::default();
    let reports = Reports::new(dir.path(), history.clone());
    let generation = reports.begin_file_import().unwrap();
    let file = json!({
        "a":{"series_title":"日本語","volume_title":"巻一","timeReadInMinutes":40,"chars":400,
            "addedOn":"2023-12-30T23:00:00-08:00",
            "recentPageTurns":[[1704153600000_i64,2,400],[1704067200000_i64,0,100],[1704067210000_i64,1,220],[1704067220000_i64,0,50]]},
        "b":{"volume_title":"Time only","timeReadInMinutes":10,"recentPageTurns":[[1704153600000_i64,0]]},
        "c":{"volume_title":"No turns","lastProgressUpdate":"2024-01-03T02:01:01Z","chars":120},
        "d":{"volume_title":"Deleted","deletedOn":"2024-01-02","chars":1},
        "empty":{}
    });
    let bytes = format!("\u{feff}{file}");
    let result = reports.import_mokuro(generation, bytes.as_bytes(), true);
    assert_eq!(result.status, 200);
    assert_eq!(result.body["imported_count"], 5);
    assert_eq!(result.body["cleared_count"], 1);
    assert_eq!(result.body["total_time_minutes"], 50.);
    assert_eq!(result.body["total_characters"], 520);
    assert_eq!(result.body["volumes_processed"], 5);
    assert_eq!(result.body["volumes_with_data"], 3);
    assert_eq!(
        result.body["date_range"],
        json!({"min":"2023-12-30","max":"2024-01-03"})
    );
    let rows = || {
        let mut query = db
            .prepare(
                "SELECT date,CAST(characters_read AS INTEGER),CAST(time_read_seconds AS REAL)
            FROM third_party_stats WHERE label='日本語 - 巻一' ORDER BY date",
            )
            .unwrap();
        let rows = query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, f64>(2)?,
                ))
            })
            .unwrap();
        rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
    };
    assert_eq!(
        rows(),
        vec![
            ("2023-12-30".into(), 100, 600.),
            ("2024-01-01".into(), 120, 720.),
            ("2024-01-02".into(), 180, 1080.)
        ]
    );
    for invalid in ["[]", "{", "{} false"] {
        assert_eq!(
            reports
                .import_mokuro(generation, invalid.as_bytes(), true)
                .status,
            400
        );
        assert_eq!(rows().len(), 3);
    }
    db.execute_batch("CREATE TRIGGER hold_import BEFORE INSERT ON third_party_stats WHEN NEW.date='2024-01-02' BEGIN SELECT RAISE(ABORT,'blocked'); END;").unwrap();
    assert_eq!(
        reports
            .import_mokuro(generation, bytes.as_bytes(), true)
            .status,
        500
    );
    assert_eq!(rows().len(), 3);
    history.close().unwrap();
    let stale = reports.import_mokuro(generation, "{}".as_bytes(), true);
    assert_ne!(stale.status, 200);
    assert_eq!(rows().len(), 3);
    let empty = reports.import_mokuro(reports.begin_file_import().unwrap(), "{}".as_bytes(), true);
    assert_eq!(empty.body["cleared_count"], 5);
    assert_eq!(
        db.query_row("SELECT label FROM third_party_stats", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "keep"
    );
}
