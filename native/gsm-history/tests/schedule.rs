use gsm_history::{schedule::Job, History};
use rusqlite::Connection;

#[test]
fn recurring_jobs_preserve_wall_clock_rules_and_service_retry_overrides() {
    use chrono::{DateTime, Duration, Local, TimeZone};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE cron_table(id INTEGER PRIMARY KEY,name TEXT,enabled TEXT,next_run TEXT,schedule TEXT,last_run TEXT)").unwrap();
    for schedule in [
        "minutely",
        "quarter_hourly",
        "hourly",
        "daily",
        "weekly",
        "monthly",
        "yearly",
        "legacy",
        "special",
    ] {
        conn.execute(
            "INSERT INTO cron_table (name,enabled,next_run,schedule) VALUES ('sample',1,1,?)",
            [schedule],
        )
        .unwrap();
    }
    let history = History::default();
    for job in history.scheduled_jobs(&path, 0).unwrap() {
        history
            .finish_scheduled_job(
                &path,
                0,
                &job,
                (job.schedule == "special").then_some(42.125),
            )
            .unwrap();
        let (last,next,enabled):(f64,f64,bool)=conn.query_row("SELECT CAST(last_run AS REAL),CAST(next_run AS REAL),CAST(enabled AS INTEGER) FROM cron_table WHERE id=?", [job.id],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        let local = DateTime::from_timestamp_micros((last * 1e6).round() as i64)
            .unwrap()
            .with_timezone(&Local)
            .naive_local();
        let desired = match job.schedule.as_str() {
            "minutely" => local + Duration::minutes(1),
            "quarter_hourly" => local + Duration::minutes(15),
            "hourly" => local + Duration::hours(1),
            "daily" => (local.date() + Duration::days(1))
                .and_hms_opt(0, 1, 0)
                .unwrap(),
            "weekly" => (local.date() + Duration::days(7))
                .and_hms_opt(3, 0, 0)
                .unwrap(),
            "monthly" => (local.date() + Duration::days(30))
                .and_hms_opt(3, 0, 0)
                .unwrap(),
            "yearly" => (local.date() + Duration::days(365))
                .and_hms_opt(3, 0, 0)
                .unwrap(),
            "special" => {
                assert!(enabled);
                assert_eq!(next, 42.125);
                continue;
            }
            _ => {
                assert!(!enabled);
                assert_eq!(last, next);
                continue;
            }
        };
        assert!(enabled);
        if let Some(instant) = Local.from_local_datetime(&desired).earliest() {
            assert!((instant.timestamp_micros() as f64 / 1e6 - next).abs() < 0.00002);
        }
    }
}

#[test]
fn legacy_deadlines_sort_by_instant_and_ignore_missing_values() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE cron_table(id INTEGER PRIMARY KEY,name TEXT,enabled INTEGER,next_run,schedule TEXT,last_run);
        INSERT INTO cron_table VALUES
        (1,'anki_word_sync',1,'1970-01-01T01:00:03+01:00','once',NULL),
        (2,'anki_word_sync',1,NULL,'once',NULL),
        (3,'anki_word_sync',1,'broken','once',NULL),
        (4,'anki_word_sync',1,0,'once',NULL),
        (5,'anki_word_sync',1,'2.75','once',NULL);").unwrap();
    let history = History::default();
    let jobs = history.scheduled_jobs(&path, 0).unwrap();
    assert_eq!(
        jobs.iter().map(|j| j.deadline).collect::<Vec<_>>(),
        [0., 2.75, 3.]
    );
    let iso = jobs.last().unwrap();
    assert!(history.scheduled_job_current(&path, 0, iso).unwrap());
    history.run_direct_job(&path, 0, iso).unwrap();
    assert!(!history.scheduled_job_current(&path, 0, iso).unwrap());
    conn.execute("UPDATE cron_table SET next_run='2.751' WHERE id=5", [])
        .unwrap();
    history.run_direct_job(&path, 0, &jobs[1]).unwrap();
    let pending: i64 = conn
        .query_row(
            "SELECT count(*) FROM cron_table WHERE last_run IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(pending, 4);
}

#[test]
fn scheduled_native_task_observes_edits_and_commits_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE cron_table(id INTEGER PRIMARY KEY, name TEXT, enabled TEXT, next_run TEXT, schedule TEXT, last_run TEXT);
        INSERT INTO cron_table VALUES (1,'anki_word_sync','1','42.125','once',NULL),
        (2,'retired_plugin','1','1','once',NULL), (3,'daily_stats_rollup','0','1','daily',NULL);").unwrap();
    let history = History::default();
    let jobs = history.scheduled_jobs(&path, 0).unwrap();
    assert_eq!(jobs.len(), 2);
    let job = jobs.iter().find(|j| j.name == "anki_word_sync").unwrap();
    conn.execute("UPDATE cron_table SET next_run='43' WHERE id=1", [])
        .unwrap();
    history.run_direct_job(&path, 0, job).unwrap();
    assert_eq!(
        conn.query_row("SELECT last_run FROM cron_table WHERE id=1", [], |r| r
            .get::<_, Option<
            String,
        >>(
            0
        ))
        .unwrap(),
        None
    );
    let current = history
        .scheduled_jobs(&path, 0)
        .unwrap()
        .into_iter()
        .find(|j| j.name == "anki_word_sync")
        .unwrap();
    history.run_direct_job(&path, 0, &current).unwrap();
    assert!(conn
        .query_row(
            "SELECT enabled='0' AND last_run=next_run FROM cron_table WHERE id=1",
            [],
            |r| r.get::<_, bool>(0)
        )
        .unwrap());
    history
        .run_direct_job(&path, 0, &Job::forced("anki_word_sync".into()))
        .unwrap();
    history.close().unwrap();
    assert!(history.scheduled_jobs(&path, 0).is_err());
}

#[test]
fn scheduled_rollup_uses_saved_settings_and_preserves_a_pending_compatibility_job() {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("gsm.db");
    let db = gsm_db::open_profile(&path, "ja").unwrap();
    db.execute_batch("INSERT INTO game_lines(id,game_name,line_text,timestamp) VALUES
        ('a','game','猫猫猫猫猫。犬',1600000000);
        INSERT INTO cron_table(name,enabled,next_run,schedule) VALUES ('daily_stats_rollup',1,1,'once');").unwrap();
    let history = History::default();
    let job = history.scheduled_jobs(&path, 0).unwrap().pop().unwrap();
    let stats = serde_json::json!({"session_gap_seconds":300,"regex_out_repetitions":true,"extra_punctuation_regex":"(?<=。)犬"});
    assert!(history
        .try_scheduled_rollup(&path, 0, &job, &stats, false)
        .unwrap());
    let chars: u64 = db
        .query_row(
            "SELECT CAST(total_characters AS INTEGER) FROM daily_stats_rollup",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(chars, 3);
    assert!(!history.scheduled_job_current(&path, 0, &job).unwrap());
    history.close().unwrap();
    assert!(history
        .try_scheduled_rollup(&path, 0, &job, &stats, false)
        .is_err());
}
