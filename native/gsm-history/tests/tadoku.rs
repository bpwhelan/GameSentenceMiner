use gsm_history::{tadoku::TitleSource, History, ReportCleaner};

#[test]
fn a_failed_checkpoint_keeps_every_game_and_the_global_cursor_retryable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = gsm_db::open_profile(&path, "ja").unwrap();
    db.execute_batch("INSERT INTO stats_export_state(format_key,last_successful_export_at) VALUES('tadoku_incremental',50);
        CREATE TRIGGER reject_cursor BEFORE INSERT ON stats_export_state WHEN new.format_key='tadoku_incremental:game:b'
        BEGIN SELECT RAISE(ABORT,'failed write'); END;").unwrap();
    let history = History::default();
    assert!(history
        .finish_tadoku(&path, 0, 80., &["a", "b"], true)
        .is_err());
    let count: i64 = db
        .query_row("SELECT count(*) FROM stats_export_state", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 1);
    db.execute_batch("DROP TRIGGER reject_cursor").unwrap();
    history
        .finish_tadoku(&path, 0, 80., &["a", "b"], false)
        .unwrap();
    let cursor:f64=db.query_row("SELECT CAST(last_successful_export_at AS REAL) FROM stats_export_state WHERE format_key='tadoku_incremental'",[],|row|row.get(0)).unwrap();
    assert_eq!(cursor, 50.);
    history.close().unwrap();
    assert!(history.finish_tadoku(&path, 0, 90., &[], true).is_err());
}

#[test]
fn preview_uses_per_game_cursors_and_keeps_the_oldest_pending_spelling() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let conn = gsm_db::open_profile(&path, "ja").unwrap();
    conn.execute_batch("INSERT INTO games(id,title_original,title_romaji,title_english,type) VALUES('g','海','Umi','Sea','Visual Novel');
        INSERT INTO stats_export_state(format_key,last_successful_export_at) VALUES('tadoku_incremental',50),('tadoku_incremental:game:g',60);
        INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp,created_at) VALUES
        ('old','g','Overlay','猫。',1,57), ('again','g','Overlay','猫。',2,65),
        ('newer','g','Overlay','i̇',6,78), ('older','g','Overlay','İ',5,91),
        ('scene','','漫画','猫',1,77), ('hidden','','Unknown Game','内容',1,70), ('future','g','Overlay','未来',3,102);").unwrap();
    let history = History::default();
    let preview = history
        .tadoku_preview(
            &path,
            0,
            100.,
            TitleSource::Romaji,
            true,
            &ReportCleaner::default(),
        )
        .unwrap();
    let value = serde_json::to_value(preview).unwrap();
    assert_eq!(value["cursor"], 50.);
    assert_eq!(
        value["entries"],
        serde_json::json!([
        {"game_key":"g","game_name":"Umi","media_tag":"vn","characters":2,"lines":2},
        {"game_key":"scene:漫画","game_name":"漫画","media_tag":"game","characters":1,"lines":1}])
    );
    assert_eq!(
        value["game_character_totals"],
        serde_json::json!({"g":5,"scene:漫画":1})
    );
    assert_eq!(value["total_characters"], 3);
    assert_eq!(value["duplicates_excluded"], 1);
    let unfiltered = history
        .tadoku_preview(
            &path,
            0,
            100.,
            TitleSource::English,
            false,
            &ReportCleaner::default(),
        )
        .unwrap();
    assert_eq!(unfiltered.entries[0].game_name, "Sea");
    assert_eq!(unfiltered.total_characters, 5);
}
