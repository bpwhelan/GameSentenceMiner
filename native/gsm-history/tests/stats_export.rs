use gsm_history::{
    stats_export::{ExportFormat, ExportOptions, ExportPreferences},
    History, ReportCleaner,
};
use std::path::Path;

fn export(path: &Path, history: &History, format: ExportFormat, scope: &str) -> String {
    let options = ExportOptions {
        format,
        scope: scope.into(),
        start_date: None,
        end_date: None,
        include_external_stats: true,
    };
    let cleaner = ReportCleaner::default();
    let prefs = ExportPreferences {
        language: "JAPANESE",
        session_gap: 1800.,
        cleaner: &cleaner,
    };
    let file = history
        .write_stats_export(path, 0, &options, &prefs, |_, _| {})
        .unwrap();
    std::fs::read_to_string(file.path).unwrap()
}

#[test]
fn library_preserves_csv_and_json_quoting_status_and_cover_payload() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = gsm_db::open_profile(&path, "ja").unwrap();
    db.execute_batch(r#"INSERT INTO games(id,title_original,type,deck_id,links,description,image,completed,status)
        VALUES ('a','海,"空"','Visual Novel','42','["ONE", {"url":"one"}, {"url":"TWO"}]',
        '二行','data:image/png;base64,YWJj','1','planned'), ('z','First','Light Novel',NULL,NULL,'','',0,'completed');
        INSERT INTO game_lines(id,game_id,timestamp) VALUES ('1','a',123);"#).unwrap();
    let history = History::default();
    let csv = export(&path, &history, ExportFormat::Library, "all_time");
    assert!(csv.starts_with("\u{feff}Title,Media Type,Status,Language,Description,Content Type,Extra Data,Cover Image (Base64)\n"));
    let rows = csv::Reader::from_reader(csv.as_bytes())
        .records()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!((&rows[0][0], &rows[0][2]), ("First", "Complete"));
    assert_eq!(
        rows[1].iter().collect::<Vec<_>>(),
        [
            "海,\"空\"",
            "Playing",
            "Ongoing",
            "JAPANESE",
            "二行",
            "Visual Novel",
            r#"{"deck_id": 42, "links": ["ONE", "TWO"]}"#,
            "YWJj"
        ]
    );
}

#[test]
fn incremental_exports_advance_after_success_and_keep_independent_cursors() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = gsm_db::open_profile(&path, "ja").unwrap();
    db.execute_batch("INSERT INTO games(id,title_english,type) VALUES('g','Game','RPG');
        INSERT INTO game_lines(id,game_id,line_text,timestamp,last_modified) VALUES('a','g','昨日。',1600000000,1600000000);
        INSERT INTO third_party_stats(date,source,label,characters_read,time_read_seconds,created_at)
        VALUES('2020-09-14','mokuro','本',12,150,1600000000);").unwrap();
    let history = History::default();
    let first = export(&path, &history, ExportFormat::Activity, "since_last_export");
    assert!(
        first.contains(",Game,Playing,0,JAPANESE,2,RPG\n"),
        "{first}"
    );
    assert!(first.contains("2020-09-14,本,Reading,2,JAPANESE,12,Book\n"));
    assert_eq!(
        export(&path, &history, ExportFormat::Activity, "since_last_export")
            .lines()
            .count(),
        1
    );
    db.execute("UPDATE game_lines SET line_text='更新です',last_modified=CAST(strftime('%s','now') AS REAL)+2", []).unwrap();
    let again = export(&path, &history, ExportFormat::Activity, "since_last_export");
    assert!(again.contains(",Game,Playing,0,JAPANESE,4,RPG\n"));
    assert_eq!(again.lines().count(), 2);
    assert_eq!(
        db.query_row("SELECT count(*) FROM stats_export_state", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn switching_profiles_during_csv_generation_does_not_advance_the_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = gsm_db::open_profile(&path, "ja").unwrap();
    db.execute("INSERT INTO games(id) VALUES('g')", []).unwrap();
    let history = History::default();
    let opts = ExportOptions {
        format: ExportFormat::Library,
        scope: "all_time".into(),
        start_date: None,
        end_date: None,
        include_external_stats: false,
    };
    let cleaner = ReportCleaner::default();
    let prefs = ExportPreferences {
        language: "JAPANESE",
        session_gap: 1800.,
        cleaner: &cleaner,
    };
    let result =
        history.write_stats_export(&path, 0, &opts, &prefs, |_, _| history.close().unwrap());
    assert!(result
        .err()
        .unwrap()
        .to_string()
        .contains("database closed"));
    let cursors: i64 = db
        .query_row("SELECT count(*) FROM stats_export_state", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cursors, 0);
}
