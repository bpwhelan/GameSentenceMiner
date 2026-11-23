use gsm_web::{Reports, Route};
use serde_json::json;

#[test]
fn saves_only_validated_settings_and_keeps_credentials_private() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config.json");
    gsm_settings::write_atomic(&config,&json!({"other":42,"stats":{"private_future":true,"tadoku_session_cookie":"old","easy_days_settings":{"future":80}}})).unwrap();
    let reports = Reports::new(dir.path(), Default::default());
    let view = || {
        reports
            .read(Route::StatsSettings, "")
            .unwrap()
            .unwrap()
            .body
    };
    assert_eq!(view()["easy_days_monday"], 100);
    assert_eq!(view()["tadoku_configured"], false);
    assert!(view().get("private_future").is_none());
    let call = |body| reports.save_stats_settings(body).unwrap();
    let response = call(
        json!({"tadoku_username":" name ","tadoku_password":" pass ","easy_days_friday":"45","session_gap_seconds":60.5,"tadoku_daily_sync_game_ids":[" a","b","a"]}),
    );
    assert_eq!(response.status, 200);
    assert_eq!(
        response.body,
        json!({"message":"Settings saved successfully","tadoku_configured":true,"tadoku_username":"name","session_gap_seconds":60,"tadoku_daily_sync_game_ids":["a","b"]})
    );
    assert_eq!(view()["easy_days_friday"], 45);
    assert!(view().get("tadoku_password").is_none());
    assert!(view().get("tadoku_session_cookie").is_none());
    let stored = gsm_settings::read_object(&config).unwrap();
    assert_eq!(stored["other"], 42);
    assert_eq!(stored["stats"]["easy_days_settings"]["future"], 80);
    assert_eq!(stored["stats"]["tadoku_session_cookie"], "");
    assert_eq!(stored["stats"]["tadoku_password"], " pass ");
    for body in [
        json!({}),
        json!({"unknown":1}),
        json!({"tadoku_clear_credentials":false}),
        json!({"reading_hours_target":3,"tadoku_daily_sync_time":"9:99"}),
        json!({"games_target_date":"2025-02-29"}),
        json!({"easy_days_friday":101}),
    ] {
        assert_eq!(call(body).status, 400);
        assert_eq!(gsm_settings::read_object(&config).unwrap(), stored);
    }
    assert_eq!(
        call(json!({"tadoku_clear_credentials":true})).body["tadoku_configured"],
        false
    );
}

#[test]
fn changing_tadoku_time_or_enablement_reconciles_the_existing_job() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let db = gsm_db::open_profile(&path, "ja").unwrap();
    let reports = Reports::new(dir.path(), Default::default());
    let save = |body| assert_eq!(reports.save_stats_settings(body).unwrap().status, 200);
    save(json!({"tadoku_daily_sync_enabled":true,"tadoku_daily_sync_time":"22:53"}));
    let row = || {
        db.query_row(
            "SELECT count(*),enabled=1,strftime('%H:%M',next_run,'unixepoch','localtime')
             FROM cron_table WHERE name='tadoku_sync'",
            [],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, bool>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .unwrap()
    };
    assert_eq!(row(), (1, true, "22:53".into()));
    db.execute("DELETE FROM cron_table WHERE name='tadoku_sync'", [])
        .unwrap();
    save(json!({"tadoku_daily_sync_enabled":true}));
    assert_eq!(row(), (1, true, "22:53".into()));
    save(json!({"tadoku_daily_sync_enabled":false}));
    assert_eq!(row(), (1, false, "22:53".into()));
}
