use gsm_history::History;
use gsm_web::{
    pages::{asset, Page},
    Reports, Route,
};
use rusqlite::Connection;
use serde_json::json;
use std::sync::Arc;

#[test]
fn maintenance_previews_share_the_desktop_queries_and_leave_history_intact() {
    use gsm_web::Maintenance;
    let dir = tempfile::tempdir().unwrap();
    let db = gsm_db::open_profile(&dir.path().join("gsm.db"), "ja").unwrap();
    db.execute_batch("INSERT INTO game_lines(id,game_name,line_text,timestamp) VALUES ('a','Game','猫',10),('b','Game','猫',12),('c','Other','猫犬',13)").unwrap();
    let reports = Reports::new(dir.path(),Arc::new(History::default()));
    let call = |path,body| reports.maintenance(Maintenance::route(path).unwrap(),body).unwrap();
    let names = call("/api/preview-text-deletion",json!({"exact_text":"猫"}));
    assert_eq!(names.body,json!({"count":2,"samples":["猫","猫犬"]}));
    let dup = call("/api/preview-deduplication",json!({"games":["Game"]}));
    assert_eq!(dup.body["duplicates_count"],1);
    assert_eq!(dup.body["games_affected"],1);
    let hits = call("/api/search-duplicates",json!({"game":"Game","time_window_minutes":"5"}));
    assert_eq!(hits.body["duplicates_found"],1);
    assert_eq!(call("/api/preview-deduplication",json!({"games":[]})).status,400);
    assert_eq!(call("/api/preview-text-deletion",json!({"exact_text":42})).status,400);
    assert_eq!(call("/api/search-duplicates",json!({})).body,json!({"error":"No data provided"}));
    assert_eq!(db.query_row("SELECT count(*) FROM game_lines",[],|r| r.get::<_,u32>(0)).unwrap(),3);
    let rewrite = |pattern: &str| call("/api/delete-regex-in-game-lines", json!({"regex_pattern":pattern}));
    assert_eq!(rewrite("(").status, 400);
    assert_eq!(rewrite("(?<=猫)犬").body, json!({"updated_count":1}));
    assert_eq!(rewrite("(?<=猫)犬").body, json!({"updated_count":0}));
    assert_eq!(db.query_row("SELECT line_text FROM game_lines WHERE id='c'", [], |r| r.get::<_,String>(0)).unwrap(), "猫");
}

#[test]
fn removing_lines_commits_history_and_affected_rollups_together() {
    use gsm_web::Maintenance;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = gsm_db::open_profile(&path,"ja").unwrap();
    db.execute_batch("INSERT INTO game_lines(id,game_name,line_text,timestamp) VALUES
        ('old','A','猫',1600000000),('new','A','猫',1600000800),('different','A','犬',1600000900);
        CREATE TRIGGER simulate_disk_error BEFORE INSERT ON daily_stats_rollup
        BEGIN SELECT RAISE(ABORT,'Unable to write rollup'); END;").unwrap();
    let reports = Reports::new(dir.path(),Arc::new(History::default()));
    let remove = || reports.maintenance(Maintenance::DeduplicateEntireGame,json!({"games":["A"],"preserve_newest":true})).unwrap();
    let count = || db.query_row("SELECT count(*) FROM game_lines",[],|r|r.get::<_,i64>(0)).unwrap();
    assert_eq!(remove().status,500);
    assert_eq!(count(),3);
    db.execute_batch("DROP TRIGGER simulate_disk_error;").unwrap();
    assert_eq!(remove().body,json!({"deleted_count":1,"message":"Successfully removed 1 duplicate sentences"}));
    assert_eq!(remove().body["deleted_count"],0);
    assert_eq!(db.query_row("SELECT id FROM game_lines WHERE line_text='猫'",[],|r|r.get::<_,String>(0)).unwrap(),"new");
    assert_eq!(db.query_row("SELECT CAST(total_lines AS INTEGER) FROM daily_stats_rollup",[],|r|r.get::<_,i64>(0)).unwrap(),2);
    std::fs::write(dir.path().join("config.json"),r#"{"stats":{"extra_punctuation_regex":"("}}"#).unwrap();
    let criteria = json!({"exact_text":["猫","犬"]});
    assert_eq!(reports.maintenance(Maintenance::DeleteText,criteria).unwrap().body["deleted_count"],2);
    assert_eq!(db.query_row("SELECT count(*) FROM daily_stats_rollup",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(count(),0);
}

#[test]
fn selected_line_deletion_reports_missing_ids_and_partial_failures_like_the_tools_page() {
    use gsm_web::Maintenance;
    let dir = tempfile::tempdir().unwrap();
    let db = gsm_db::open_profile(&dir.path().join("gsm.db"),"ja").unwrap();
    db.execute_batch("INSERT INTO game_lines(id,line_text,timestamp) VALUES('keep','猫',1600000000),('remove','犬',1600000001);
        CREATE TRIGGER fail_one BEFORE DELETE ON game_lines WHEN OLD.id='keep' BEGIN SELECT RAISE(ABORT,'locked row'); END;").unwrap();
    let reports = Reports::new(dir.path(),Arc::default());
    let op = Maintenance::route("/api/delete-sentence-lines").unwrap();
    let response = reports.maintenance(op,json!({"line_ids":["keep","remove","absent","remove",""]})).unwrap();
    assert_eq!(response.body,json!({"deleted_count":2,"message":"Successfully deleted 2 sentences","warning":"1 lines failed to delete","failed_ids":["keep"]}));
    assert_eq!(db.query_row("SELECT id FROM game_lines",[],|r|r.get::<_,String>(0)).unwrap(),"keep");
    assert_eq!(reports.maintenance(op,json!({"line_ids":"id"})).unwrap().body["error"],"line_ids must be a list");
    assert_eq!(reports.maintenance(op,json!({})).unwrap().body["error"],"No line IDs provided");
}

#[test]
fn combined_anki_page_handles_sections_and_kanji_without_rollups() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = gsm_db::open_profile(&dir.path().join("gsm.db"), "ja").unwrap();
    gsm_db::vocabulary::configure_desktop(&mut db, true).unwrap();
    db.execute_batch(r#"INSERT INTO game_lines(id,line_text,timestamp) VALUES('first','山山海',1600000000),('second','森',1600000001);
        INSERT INTO anki_notes(note_id,fields_json,tags) VALUES('1600000000100','{"Expression":{"value":"森海"}}','["Game::VN"]');"#).unwrap();
    let reports = Reports::new(dir.path(), Arc::new(History::default()));
    let read = |url, q| {
        reports
            .read(Route::parse(url).expect("native Anki page route"), q)
            .unwrap()
            .unwrap()
    };
    let all = read("/api/anki_stats_combined", "");
    assert_eq!(all.body.as_object().unwrap().len(), 6);
    assert_eq!(all.body["earliest_date"], 1600000000.1);
    assert_eq!(
        all.body["kanji_stats"],
        json!({"anki_kanji_count":2,"gsm_kanji_count":3,"coverage_percent":66.7,"missing_kanji":[{"kanji":"山","frequency":2}]})
    );
    assert_eq!(all.body["reading_impact"]["lagged_pairs"], json!([]));
    let single = read(
        "/api/anki_kanji_stats",
        "start_timestamp=1600000000500&end_timestamp=1600000001100",
    );
    assert_eq!(
        single.body,
        json!({"anki_kanji_count":0,"gsm_kanji_count":1,"coverage_percent":0.0,"missing_kanji":[{"kanji":"森","frequency":1}]})
    );
    assert_eq!(
        read(
            "/api/anki_stats_combined",
            "sections=kanji_stats,kanji_stats"
        )
        .body,
        json!({"kanji_stats":all.body["kanji_stats"]})
    );
    assert_eq!(read("/api/anki_stats_combined", "sections=,").status, 400);
    assert_eq!(
        read("/api/anki_stats_combined", "sections=z,a").body["error"],
        "Unsupported Anki stats sections: a, z"
    );
}

#[test]
fn reading_impact_joins_weekly_totals_maturity_and_unicode_game_titles() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = gsm_db::open_profile(&dir.path().join("gsm.db"), "ja").unwrap();
    gsm_db::vocabulary::configure_desktop(&mut db, true).unwrap();
    let reports = Reports::new(dir.path(), Arc::new(History::default()));
    db.execute_batch(r#"INSERT INTO daily_stats_rollup(date,total_characters,total_reading_time_seconds,anki_cards_created,game_activity_data)
        VALUES('2024-01-07',12,1800,1,'{"g":{"title":"Straße！読","chars":12,"time":1800}}'),
        ('2024-01-15',60,3600,2,'{"g":{"title":"renamed","chars":50,"time":1800},"x":{"title":"STRASSE 読","chars":10,"time":1800}}');
        INSERT INTO anki_notes(note_id,tags,fields_json) VALUES('1705320000000','["Game::Strasse-読"]','{"Expression":{"value":"読む"}}');
        INSERT INTO anki_cards(card_id,note_id,interval,synced_at) VALUES('9','1705320000000',22,1705320000);"#).unwrap();
    std::fs::write(
        dir.path().join("config.json"),
        r#"{"experimental":{"enable_experimental_features":true,"enable_tokenization":true}}"#,
    )
    .unwrap();
    let route = || Route::parse("/api/anki-reading-impact").expect("native reading impact");
    let to_ms = |day: &str| {
        chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d")
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
            .and_local_timezone(chrono::Local)
            .unwrap()
            .timestamp_millis()
    };
    let query = format!(
        "start_timestamp={}&end_timestamp={}&lag_weeks=2",
        to_ms("2024-01-07"),
        to_ms("2024-01-16")
    );
    let body = reports.read(route(), &query).unwrap().unwrap().body;
    assert_eq!(
        body["labels"],
        json!(["2024-01-01", "2024-01-08", "2024-01-15"])
    );
    assert_eq!(body["reading_chars"], json!([12, 0, 60]));
    assert_eq!(body["reading_hours"], json!([0.5, 0.0, 1.0]));
    assert_eq!(body["cards_mined"], json!([1, 0, 2]));
    assert_eq!(body["mature_words"], json!([0, 0, 1]));
    assert_eq!(body["lagged_mature_words"], json!([1, null, null]));
    assert_eq!(body["lagged_pairs"][0]["source_label"], "2024-01-01");
    assert_eq!(body["per_game"][0]["reading_chars"], 72);
    assert_eq!(body["per_game"][0]["reading_hours"], 1.5);
    let reversed = format!(
        "start_timestamp={}&end_timestamp={}&lag_weeks=-8",
        to_ms("2024-01-16"),
        to_ms("2024-01-07")
    );
    let reversed = reports.read(route(), &reversed).unwrap().unwrap().body;
    assert_eq!(reversed["labels"], body["labels"]);
    assert_eq!(reversed["per_game"], json!([]));
    assert_eq!(reversed["lag_weeks"], 1);
}

#[test]
fn anki_sync_status_preserves_old_schedule_dates_and_probes_only_an_empty_cache() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = Connection::open(path).unwrap();
    let reports = Reports::new(dir.path(), Arc::new(History::default()));
    let (missing, probe) = reports.anki_sync_status();
    assert!(probe.is_none() && !missing.cache_populated);
    db.execute_batch("CREATE TABLE anki_notes(synced_at TEXT); CREATE TABLE anki_cards(card_id TEXT);
        CREATE TABLE cron_table(id INTEGER PRIMARY KEY, name, enabled TEXT, schedule, next_run);
        INSERT INTO cron_table VALUES (1,'anki_card_sync','0','custom','1970-01-01T01:00:00.123456+01:00');").unwrap();
    std::fs::write(dir.path().join("config.json"), r#"{"current_profile":"test","configs":{"test":{"anki":{"url":"http://localhost:1234/fixture"}}}}"#).unwrap();
    let (empty, probe) = reports.anki_sync_status();
    assert!(!empty.cache_populated);
    assert_eq!(probe.as_deref(), Some("http://localhost:1234/fixture"));
    db.execute_batch("INSERT INTO anki_notes VALUES ('1600000000.25'), (NULL); INSERT INTO anki_cards VALUES ('1');").unwrap();
    let reply = reports.read(Route::AnkiSyncStatus, "").unwrap().unwrap();
    assert_eq!(
        reply.body,
        json!({"last_synced":"2020-09-13T12:26:40.250000+00:00",
        "cache_populated":true,"anki_connect_available":false,"note_count":2,"card_count":1,
        "auto_sync_enabled":false,"auto_sync_schedule":"custom","next_auto_sync":"1970-01-01T00:00:00.123456+00:00"})
    );
    db.execute("UPDATE cron_table SET next_run=NULL", [])
        .unwrap();
    assert!(json!(reports.anki_sync_status().0)["next_auto_sync"].is_null());
}

#[test]
fn speaker_labels_are_removed_by_native_reports() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    gsm_db::create_profile_if_missing(&path).unwrap();
    let db = Connection::open(&path).unwrap();
    let now = chrono::Local::now().timestamp() as f64;
    db.execute_batch("INSERT INTO games(id,title_original) VALUES('a','Story')")
        .unwrap();
    db.execute("INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp) VALUES('1','a','Story','【話者】読む。【心】次',?)",[now]).unwrap();
    std::fs::write(
        dir.path().join("config.json"),
        r#"{"stats":{"day_rollover_hour":0,"extra_punctuation_regex":"【.*?】"}}"#,
    )
    .unwrap();
    let reports = Reports::new(dir.path(), Arc::new(History::default()));
    let call = |route| {
        reports
            .read(route, "")
            .unwrap()
            .expect("native response")
            .body
    };
    assert_eq!(call(Route::Today)["todayTotalChars"], 3);
    assert_eq!(call(Route::Overview)[0]["characters"], 3);
    assert_eq!(call(Route::KanjiGrid)["unique_count"], 2);
    assert_eq!(
        call(Route::Dashboard)["allGamesStats"]["total_characters"],
        3
    );
    assert_eq!(
        call(Route::GameStats("a".into()))["stats"]["total_characters"],
        3
    );
    assert!(reports.read(Route::GoalsProjection, "").unwrap().is_some());
    db.execute(
        "UPDATE game_lines SET line_text='【話者】読め読め読め読め'",
        [],
    )
    .unwrap();
    std::fs::write(
        dir.path().join("config.json"),
        r#"{"stats":{"day_rollover_hour":0,"extra_punctuation_regex":"【.*?】","regex_out_repetitions":true}}"#,
    ).unwrap();
    assert_eq!(call(Route::Today)["todayTotalChars"], 6);
}

#[test]
fn custom_goal_history_preserves_defaults_dates_and_duplicate_days() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    gsm_db::create_profile_if_missing(&path).unwrap();
    let reports = Reports::new(dir.path(), Arc::new(History::default()));
    let read = |path| {
        reports
            .read(Route::parse(path).expect("native goal route"), "")
            .unwrap()
            .unwrap()
            .body
    };
    assert_eq!(read("/api/goals/latest_goals")["versions"]["goals"], 0);
    assert_eq!(
        read("/api/goals/current_streak")["last_completion_date"],
        serde_json::Value::Null
    );
    let current = read("/api/goals/current");
    assert_eq!(current["goals_settings"]["easyDays"]["sunday"], 100);
    assert!(current["last_updated"].as_f64().unwrap() > 0.);
    assert_eq!(read("/api/goals/current"), current);
    let db = Connection::open(&path).unwrap();
    let today = chrono::Utc::now().date_naive();
    for age in [0, 1, 1, 2, 7] {
        let day = (today - chrono::Days::new(age)).to_string();
        db.execute("INSERT INTO goals(date,current_goals,goals_settings,goals_version) VALUES(?,'bad','{\"longestStreak\":8}','bad')",[day]).unwrap();
    }
    assert_eq!(
        read("/api/goals/latest_goals"),
        json!({"date":today,"current_goals":[],"goals_settings":{"longestStreak":8},"versions":{"goals":1,"easyDays":1,"ankiConnect":1}})
    );
    assert_eq!(
        read("/api/goals/current_streak"),
        json!({"streak":2,"longest_streak":8,"last_completion_date":today})
    );
    db.execute("UPDATE goals SET goals_settings='{\"easyDays\":{\"monday\":25},\"custom\":1}' WHERE date='current'",[]).unwrap();
    assert_eq!(
        read("/api/goals/current")["goals_settings"],
        json!({"easyDays":{"monday":25},"ankiConnect":{"deckName":""},"customCheckboxes":{},"custom":1})
    );
    db.execute(
        "DELETE FROM goals WHERE date>=? AND date!='current'",
        [(today - chrono::Days::new(1)).to_string()],
    )
    .unwrap();
    assert_eq!(read("/api/goals/current_streak")["streak"], 0);
}

#[test]
fn goal_edit_preserves_versions_and_merges_concurrent_settings() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    gsm_db::create_profile_if_missing(&path).unwrap();
    let reports = Reports::new(dir.path(), Arc::new(History::default()));
    let read = || reports.read(Route::CurrentGoals, "").unwrap().unwrap().body;
    let db = Connection::open(&path).unwrap();
    for (start, end, message) in [
        (
            "2025-03-09T02:30",
            "2025-03-09",
            "This local time needs an explicit UTC offset",
        ),
        (
            "2025-11-02T01:30",
            "2025-11-03",
            "This local time needs an explicit UTC offset",
        ),
        (
            "2025-06-02T15:00",
            "2025-06-02T14:59",
            "End date and time must be after start date and time",
        ),
        (
            "2025-06-02T15:00:00.0000009Z",
            "2025-06-02T15:00:00.0000001Z",
            "End date and time must be after start date and time",
        ),
        ("2025-06-02T15:00", "bad", "Invalid date or time format"),
    ] {
        let r = reports.update_goals(
            json!({"current_goals":[{"startDate":start,"endDate":end}]}),
            Some("America/New_York"),
        );
        assert_eq!(r.status, 400);
        assert_eq!(r.body["error"], message);
    }
    assert_eq!(
        db.query_row("SELECT count(*) FROM goals", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    let goals = json!([
        {"metricType":"characters","start_date":"2025-11-02T01:30:00-04:00","end_date":"2025-11-02T01:15:00-05:00"},
        {"startDate":"2025-03-09T23:59","endDate":"2025-03-09"},
        {"metricType":"custom","startDate":"badTime"}
    ]);
    let r = reports.update_goals(
        json!({"current_goals":goals,"partial_settings":{"easyDays":{"monday":25}}}),
        Some("America/New_York"),
    );
    assert_eq!(r.status, 200);
    let current = read();
    assert_eq!(current["current_goals"], goals);
    assert_eq!(current["last_updated"], r.body["last_updated"]);
    assert_eq!(current["goals_settings"]["easyDays"]["monday"], 25);
    assert_eq!(current["goals_settings"]["easyDays"]["sunday"], 100);
    db.execute(r#"UPDATE goals SET goals_version='{"custom":99}',last_updated='2025-01-01T01:00:00+01:00'"#,[]).unwrap();
    assert_eq!(read()["last_updated"], 1735689600.0);
    let r = reports.update_goals(
        json!({"goals_settings":{"ui":{"nested":{"old":1}}},"partial_settings":{"skip":true}}),
        None,
    );
    assert_eq!(r.status, 200);
    std::thread::scope(|scope| {
        for i in 0..8 {
            let reports = &reports;
            scope.spawn(move || {
                assert_eq!(
                    reports
                        .update_goals(
                            json!({"partial_settings":{"ui":{format!("key{i}"):i}}}),
                            None
                        )
                        .status,
                    200
                );
            });
        }
    });
    reports.update_goals(
        json!({"partial_settings":{"ui":{"nested":{"new":2}}}}),
        None,
    );
    let current = read();
    assert_eq!(current["current_goals"], goals);
    assert_eq!(current["goals_settings"]["ui"]["nested"], json!({"new":2}));
    assert!(current["goals_settings"].get("skip").is_none());
    assert_eq!(
        current["goals_settings"]["ui"].as_object().unwrap().len(),
        9
    );
    assert_eq!(
        db.query_row("SELECT goals_version FROM goals", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        r#"{"custom":99}"#
    );
    db.execute_batch("CREATE TRIGGER refuse BEFORE UPDATE ON goals BEGIN SELECT RAISE(ABORT,'test rollback'); END").unwrap();
    assert_eq!(
        reports
            .update_goals(json!({"current_goals":[]}), None)
            .status,
        500
    );
    assert_eq!(read(), current);
}

#[test]
fn goal_reading_pace_counts_live_and_imported_data_on_the_requested_day() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    gsm_db::create_profile_if_missing(&path).unwrap();
    let reports = Reports::new(dir.path(), Arc::new(History::default()));
    let zone = jiff::tz::TimeZone::get("Pacific/Kiritimati").unwrap();
    let today = jiff::Timestamp::now().to_zoned(zone.clone()).date();
    let start = today
        .yesterday()
        .unwrap()
        .at(23, 59, 0, 0)
        .to_zoned(zone.clone())
        .unwrap()
        .timestamp()
        .as_second();
    let now = today
        .at(0, 1, 0, 0)
        .to_zoned(zone)
        .unwrap()
        .timestamp()
        .as_second();
    let db = Connection::open(&path).unwrap();
    let route = || {
        reports
            .read_with_timezone(
                Route::parse("/api/goals/reading-pace").expect("native reading pace"),
                "",
                Some("Pacific/Kiritimati"),
            )
            .unwrap()
            .unwrap()
            .body
    };
    assert_eq!(route()["pace_cph"], 0);
    db.execute("INSERT INTO game_lines(id,line_text,timestamp) VALUES('old','exclude',?),('a','猫犬猫犬猫',?),('b','本',?)", (start, now, now + 10)).unwrap();
    db.execute("INSERT INTO daily_stats_rollup(date,total_characters,total_reading_time_seconds) VALUES(?,3000,3600),(?,99999,10000)", [today.yesterday().unwrap().to_string(),today.to_string()]).unwrap();
    db.execute("INSERT INTO third_party_stats(date,characters_read,time_read_seconds,source,label) VALUES(?,900,1800,'fixture','test')", [today.to_string()]).unwrap();
    assert_eq!(
        route(),
        json!({"pace_cph":2599,"total_characters":3906,"total_hours":1.5,"days_analyzed":30,"average_characters_per_day":130,"average_hours_per_day":0.05})
    );
}

#[test]
fn completing_goals_commits_both_rows_once_under_contention() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    gsm_db::create_profile_if_missing(&path).unwrap();
    let reports = Reports::new(dir.path(), Arc::new(History::default()));
    assert_eq!(reports.complete_goals(None).unwrap().status, 400);
    reports.read(Route::CurrentGoals, "").unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER reject_current BEFORE UPDATE ON goals BEGIN SELECT RAISE(ABORT,'test rollback'); END;").unwrap();
    assert!(reports.complete_goals(None).is_err());
    assert_eq!(
        db.query_row("SELECT count(*) FROM goals", [], |r| r.get::<_, i32>(0))
            .unwrap(),
        1
    );
    db.execute_batch("DROP TRIGGER reject_current").unwrap();
    let gate = std::sync::Barrier::new(2);
    let mut results = std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            gate.wait();
            reports.complete_goals(None).unwrap()
        });
        let other = Reports::new(dir.path(), Arc::new(History::default()));
        gate.wait();
        let second = other.complete_goals(None).unwrap();
        [first.join().unwrap(), second]
    });
    results.sort_by_key(|r| r.status);
    assert_eq!(results[0].body["streak"], 1);
    assert_eq!(results[0].body["longest_streak"], 1);
    assert_eq!(results[1].status, 400);
    assert_eq!(
        results[1].body["error"],
        "Dailies already completed for today"
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM goals", [], |r| r.get::<_, i32>(0))
            .unwrap(),
        2
    );
}

#[test]
fn fresh_profile_serves_stats_before_python_starts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    assert!(gsm_db::create_profile_if_missing(&path).unwrap());
    let reports = Reports::new(dir.path(), Arc::new(History::default()));
    let reply = reports.read(Route::Today, "").unwrap().unwrap();
    assert_eq!(reply.body["todaySessions"], 0);
    assert!(Page::parse("/stats")
        .unwrap()
        .render(&reports)
        .unwrap()
        .is_some());
    assert!(!gsm_db::create_profile_if_missing(&path).unwrap());
}

#[test]
fn goal_projection_keeps_lifetime_totals_and_thirty_day_averages() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    gsm_db::create_profile_if_missing(&path).unwrap();
    let reports = Reports::new(dir.path(), Arc::new(History::default()));
    let target = chrono::Local::now().date_naive() + chrono::Days::new(30);
    std::fs::write(dir.path().join("config.json"),json!({"stats":{
        "reading_hours_target_date":target, "character_count_target_date":target, "games_target_date":target
    }}).to_string()).unwrap();
    let call = || {
        reports
            .read(Route::GoalsProjection, "")
            .unwrap()
            .unwrap()
            .body
    };
    assert_eq!(call()["hours"], json!({"projection":0,"daily_average":0}));
    let db = Connection::open(path).unwrap();
    let today = chrono::Local::now().date_naive();
    for (age, chars, seconds, games) in
        [(60, 900, 3600, r#"["a"]"#), (1, 300, 1800, r#"["a","b"]"#)]
    {
        db.execute("INSERT INTO daily_stats_rollup(date,total_characters,total_reading_time_seconds,games_played_ids)
            VALUES(?,?,?,?)", ((today - chrono::Days::new(age)).to_string(), chars, seconds,games)).unwrap();
    }
    let reply = call();
    assert_eq!(reply["hours"]["current"], 1.5);
    assert_eq!(reply["hours"]["projection"], 2.0);
    assert_eq!(reply["characters"]["projection"], 1500);
    assert_eq!(reply["games"]["current"], 2);
    assert_eq!(reply["games"]["projection"], 4);
}

#[test]
fn dashboard_pages_and_reports_run_without_a_python_upstream() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = Connection::open(dir.path().join("gsm.db")).unwrap();
    gsm_db::migrate(&mut db, "ja").unwrap();
    let cfg = dir.path().join("config.json");
    std::fs::write(&cfg, r#"{"stats":{"session_gap_seconds":1234}}"#).unwrap();
    db.execute_batch("INSERT INTO games(id,title_original) VALUES('g','Game');
        INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp) VALUES('l','g','Game','日本語',1577836800);
        INSERT INTO third_party_stats(date) VALUES('2020-01-02');").unwrap();
    let reports = Reports::new(dir.path(), Arc::new(History::default()));
    for path in [
        "/stats",
        "/overview",
        "/goals",
        "/games",
        "/game/g",
        "/anki_stats",
        "/tools",
        "/search",
    ] {
        let html = Page::parse(path)
            .unwrap()
            .render(&reports)
            .unwrap_or_else(|e| panic!("{path}: {e}"))
            .unwrap();
        assert!(
            html.contains("/static/js/shared.js") && !html.contains("{%"),
            "{path}"
        );
        if path == "/stats" {
            assert!(html.contains("1234") && html.contains("2020-01-02"));
        }
    }
    let selector = Page::parse("/select_areas").unwrap().render(&reports).unwrap().unwrap();
    assert!(selector.contains("id=\"areaCanvas\""));
    assert!(selector.replace("&#x2f;", "/").contains("/static/js/ocr-area-selector.js"));
    assert!(Page::parse("/game/missing")
        .unwrap()
        .render(&reports)
        .unwrap()
        .is_none());
    let call = |p, q| reports.read(Route::parse(p).unwrap(), q).unwrap().unwrap();
    let request = serde_json::from_value(json!({"operation":"importReadingStats", "clear_source":"test",
        "rows":[["2020-02-01", 10, 1.5, "test", "First"], ["2020-01-31", 2, 1, "test", "Earlier"]]})).unwrap();
    assert_eq!(
        History::default()
            .run(&dir.path().join("gsm.db"), request)
            .unwrap(),
        0
    );
    assert_eq!(
        call("/api/third-party-stats", "source=test").body["entries"][0]["label"],
        "Earlier"
    );
    assert_eq!(
        call("/api/third-party-stats/summary", "").body["by_source"]["test"],
        json!({"count":2, "characters":12, "time_seconds":2.5})
    );
    assert_eq!(call("/api/stats/game-milestones", "").body, json!(null));
    assert_eq!(call("/api/games/g/archive", "").body["raw_lines"], 1);
    assert_eq!(
        call("/api/database/maintenance", "").body["storage"]["raw_lines"],
        1
    );
    assert_eq!(call("/api/anki_game_stats", "").body, json!([]));
    assert_eq!(
        call("/api/anki_earliest_date", "").body["cache_empty"],
        true
    );
    assert_eq!(
        call("/api/anki_nsfw_sfw_retention", "").body["cache_empty"],
        true
    );
    assert_eq!(
        call("/api/kanji-frequency", "kanji=%E6%97%A5").body,
        json!({"kanji":"日","count":0})
    );
    assert_eq!(call("/api/kanji-frequency", "kanji=two").status, 400);
    assert_eq!(
        call("/api/search-sentences", "q=%E6%97%A5&page_size=0").body["results"][0]["id"],
        "l"
    );
    assert_eq!(call("/api/game/no/kanji-grid", "").status, 404);
    assert_eq!(call("/api/tokenization/words", "").status, 404);
    assert_eq!(call("/api/tokenization/status", "").body["enabled"], false);
    assert!(call("/api/stats", "").body.is_object());
    gsm_db::vocabulary::configure(&mut db, true).unwrap();
    std::fs::write(
        &cfg,
        r#"{"experimental":{"enable_experimental_features":true,"enable_tokenization":true}}"#,
    )
    .unwrap();
    assert!(call("/api/tokenization/maturity-history", "").body["series"].is_object());
    let exported = call(
        "/api/tokenization/words/not-in-anki/export",
        "game_scope=selected",
    );
    assert_eq!(
        exported.body["csv"],
        "\u{feff}word,reading,pos,frequency,global_rank\n"
    );
    assert_eq!(
        call(
            "/api/tokenization/words/not-in-anki",
            "limit=5&global_rank_min=20&global_rank_max=9"
        )
        .body["words"],
        json!([])
    );
    std::fs::write(
        cfg,
        r#"{"stats":{"extra_punctuation_regex":"(?<=speaker)name"}}"#,
    )
    .unwrap();
    assert!(reports.read(Route::Dashboard, "").unwrap().is_some());
    assert!(asset("/static/js/shared.js").unwrap().gzip.is_some());
    assert!(asset("/static/../templates/stats.html").is_none());
    assert!(Route::parse("/api/game/a%2fb/kanji-grid").is_none());
}
