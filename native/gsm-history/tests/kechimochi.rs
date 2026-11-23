use gsm_history::{History, ReportCleaner};

#[test]
fn raw_history_wins_over_rollups_and_removed_event_days_stay_removed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = gsm_db::open_profile(&path, "ja").unwrap();
    db.execute_batch("INSERT INTO games(id,title_english,type) VALUES('g','Sea','Visual Novel');
        INSERT INTO game_lines(id,game_id,line_text,timestamp) VALUES('b','g','日本語。',1600000000);
        INSERT INTO game_daily_rollup(date,game_id,total_characters,total_reading_time_seconds) VALUES
        (date(1600000000,'unixepoch','localtime'),'g',990,990),('2019-01-01','g',40,150);
        INSERT INTO daily_stats_rollup(date,total_characters,total_reading_time_seconds) VALUES('2018-01-01',10,60);
        INSERT INTO third_party_stats(date,source,label,characters_read,time_read_seconds) VALUES('2017-01-01','mokuro','本',9,61);").unwrap();
    let history = History::default();
    let opts = gsm_history::kechimochi::SnapshotOptions {
        language: "JAPANESE",
        include_external: true,
        session_gap: 1800.,
        cleaner: &ReportCleaner::default(),
    };
    let snapshot = history.kechimochi_snapshot(&path, 0, &opts).unwrap();
    let view = snapshot.preview();
    assert_eq!(view["characters"], 62);
    assert_eq!(view["activity_count"], 4);
    assert_eq!(view["duration_minutes"], 4);
    assert_eq!(view["entries"][1]["title"], "GSM historical activity");
    history
        .remember_kechimochi_days(&path, 0, &snapshot.observed)
        .unwrap();
    db.execute("DELETE FROM game_lines WHERE id='b'", [])
        .unwrap();
    let after = history.kechimochi_snapshot(&path, 0, &opts).unwrap();
    assert_eq!(after.preview()["characters"], 59);
}
