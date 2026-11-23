use chrono::{Local, TimeZone};
use gsm_db::startup_jobs::initialize;
use rusqlite::Connection;
use serde_json::json;

#[test]
fn seed_jobs_preserves_user_choices_and_resumes_due_work() {
    let mut conn = Connection::open_in_memory().unwrap();
    gsm_db::migrate(&mut conn, "ja").unwrap();
    let now = Local
        .with_ymd_and_hms(2026, 11, 21, 9, 42, 0)
        .single()
        .unwrap();
    initialize(&mut conn, &json!({}), now).unwrap();
    let count = |c: &Connection| {
        c.query_row("SELECT count(*) FROM cron_table", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap()
    };
    assert_eq!(count(&conn), 8);
    let job = |c: &Connection, name: &str| {
        c.query_row(
            "SELECT schedule,CAST(next_run AS REAL),enabled=1 FROM cron_table WHERE name=?",
            [name],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, f64>(1)?,
                    r.get::<_, bool>(2)?,
                ))
            },
        )
        .unwrap()
    };
    assert_eq!(
        job(&conn, "jiten_upgrader"),
        (
            "weekly".into(),
            Local
                .with_ymd_and_hms(2026, 11, 22, 3, 0, 0)
                .unwrap()
                .timestamp() as f64,
            true
        )
    );
    let changes = conn.total_changes();
    initialize(&mut conn, &json!({}), now).unwrap();
    assert_eq!(conn.total_changes(), changes);
    conn.execute_batch(
        "UPDATE cron_table SET next_run=0,enabled=0 WHERE name='populate_games';
        UPDATE cron_table SET enabled=0,schedule='weekly' WHERE name='jiten_sync';
        INSERT INTO cron_table(name) VALUES('plugins'),('user_plugins'),('custom');
        UPDATE stats_export_state SET last_successful_export_at=91;",
    )
    .unwrap();
    let cfg = json!({"tadoku_daily_sync_enabled":true,"tadoku_daily_sync_time":"08:35",
        "kechimochi_sync_schedule":"daily","kechimochi_sync_time":"04:15","kechimochi_sync_enabled":true});
    initialize(&mut conn, &cfg, now).unwrap();
    assert_eq!(count(&conn), 9);
    assert_eq!(job(&conn, "populate_games"), ("weekly".into(), 0., false));
    assert_eq!(
        job(&conn, "jiten_sync"),
        ("daily".into(), now.timestamp() as f64 - 86400., false)
    );
    assert_eq!(
        job(&conn, "tadoku_sync"),
        (
            "daily".into(),
            Local
                .with_ymd_and_hms(2026, 11, 22, 8, 35, 0)
                .unwrap()
                .timestamp() as f64,
            true
        )
    );
    assert_eq!(
        job(&conn, "kechimochi_sync"),
        ("daily".into(), now.timestamp() as f64, true)
    );
    conn.execute(
        "UPDATE cron_table SET next_run=7 WHERE name='kechimochi_sync'",
        [],
    )
    .unwrap();
    initialize(&mut conn, &cfg, now).unwrap();
    assert_eq!(job(&conn, "kechimochi_sync").1, 7.);
    assert_eq!(
        conn.query_row(
            "SELECT CAST(last_successful_export_at AS REAL) FROM stats_export_state",
            [],
            |r| r.get::<_, f64>(0)
        )
        .unwrap(),
        91.
    );
}
