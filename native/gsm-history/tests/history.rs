use gsm_history::{History, Request};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::Path;

#[test]
fn sessions_preserve_aliases_pause_boundaries_and_independent_daily_pace() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("gsm.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TABLE game_lines(timestamp REAL, line_text TEXT,id TEXT,game_name TEXT,game_id TEXT);
        CREATE TABLE games(id TEXT,obs_scene_name TEXT,title_original TEXT);
        INSERT INTO games VALUES ('id','Scene','Title');
        CREATE TABLE stats_reading_breaks(timestamp TEXT);
        INSERT INTO stats_reading_breaks VALUES ('15');
        INSERT INTO game_lines VALUES (10,' 「日本語」 ','a','Scene','id'),
            (20,'あいうえお','b','Title',''),(25,'𠀀','c','Another',''),(3025,'？','d','Another','');").unwrap();
    let result = call(
        &db,
        json!({"operation":"todaySessions","start":0,"end":4000,"session_gap":1800}),
    );
    assert_eq!(result["todayTotalChars"], 9);
    assert_eq!(result["todayCharsPerHour"], 6480);
    assert_eq!(result["todaySessions"], 3);
    assert_eq!(result["sessions"][0]["gameName"], "Title");
    assert_eq!(result["sessions"][0]["gameId"], "id");
    assert_eq!(result["sessions"][0]["lines"], json!(["a", "b"]));
    assert_eq!(result["sessions"][0]["totalSeconds"], 0.0);
}

fn call(db: &Path, request: Value) -> Value {
    History::default()
        .run(db, serde_json::from_value::<Request>(request).unwrap())
        .unwrap()
}

#[test]
fn orphan_repair_respects_alias_precedence_and_rolls_back_failed_updates() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("gsm.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TABLE games(id PRIMARY KEY,title_original,title_romaji,title_english,type,description,image,character_count,links,completed,manual_overrides,obs_scene_name,genres,tags,character_summary,anilist_id,status);
        CREATE TABLE game_lines(id PRIMARY KEY,game_name,game_id);
        INSERT INTO games(id,title_original,obs_scene_name) VALUES ('first','Title','Alias'),('second','Alias','Other');
        INSERT INTO game_lines VALUES (1,'Alias',NULL),(2,'Other',''),(3,'Brand new',NULL),(4,'Alias','keep'),(5,'',NULL);
        CREATE TRIGGER reject_link BEFORE UPDATE ON game_lines WHEN new.id=2 BEGIN SELECT RAISE(ABORT,'rejected'); END;").unwrap();
    let request = json!({"operation":"linkGameLines"});
    let operation = serde_json::from_value(request.clone()).unwrap();
    assert!(History::default().run(&db, operation).is_err());
    assert_eq!(
        conn.query_row("SELECT count(*) FROM games", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    conn.execute_batch("DROP TRIGGER reject_link").unwrap();
    let result = call(&db, request.clone());
    assert_eq!(result, json!({"created":2,"linked":3}));
    assert_eq!(conn.query_row("SELECT group_concat(game_id) FROM (SELECT game_id FROM game_lines WHERE id IN (1,2,4) ORDER BY id)",[],|r|r.get::<_,String>(0)).unwrap(),"first,second,keep");
    assert_eq!(call(&db, request), json!({"created":1,"linked":0}));
}

#[test]
fn milestones_keep_release_day_ties_and_read_only_the_selected_games() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("gsm.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE games(id, title_original, title_romaji, title_english, type, image, release_date, difficulty);
        CREATE TABLE game_lines(game_id,timestamp);
        INSERT INTO games(id,release_date) VALUES ('ignored','　');").unwrap();
    let request = json!({"operation":"gameMilestones"});
    assert_eq!(call(&path, request.clone()), json!({}));
    conn.execute_batch(
        "INSERT INTO games(id,title_original,release_date,difficulty) VALUES
        ('a','First','2000-01-03T20:00',-1);
        INSERT INTO game_lines VALUES ('a',1700000000);",
    )
    .unwrap();
    let single = call(&path, request.clone());
    assert_eq!(single["oldest_game"], single["newest_game"]);
    assert_eq!(single["oldest_game"]["release_date"], "2000-01-03");
    assert_eq!(single["oldest_game"]["difficulty_label"], "Beginner");
    assert_ne!(single["oldest_game"]["first_played"], "Unknown");
    conn.execute_batch(
        "INSERT INTO games(id,title_original,release_date,difficulty) VALUES
        ('b','Middle','2000-01-03T12:00',null),('c','Last','2000-01-03T01:00',9);",
    )
    .unwrap();
    let tied = call(&path, request);
    assert_eq!(tied["oldest_game"], single["oldest_game"]);
    assert_eq!(tied["newest_game"]["title_original"], "Last");
    assert_eq!(tied["newest_game"]["first_played"], "Unknown");
    assert_eq!(tied["newest_game"]["difficulty_label"], "Insane");
}

#[test]
fn overview_combines_external_reading_with_rollups_and_live_sessions() {
    use chrono::{Local, TimeZone};
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("gsm.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TABLE daily_stats_rollup(date TEXT, total_characters TEXT,total_reading_time_seconds TEXT);
        INSERT INTO daily_stats_rollup VALUES ('2025-01-01',100,25),('2025-01-03',999,999);
        CREATE TABLE third_party_stats(date TEXT,characters_read INTEGER,time_read_seconds REAL);
        INSERT INTO third_party_stats VALUES ('2025-01-01',2,2.5),('2025-01-02',3,1),('2025-01-03',4,3);
        CREATE TABLE game_lines(timestamp REAL,line_text TEXT);
        CREATE TABLE stats_reading_breaks(timestamp REAL);").unwrap();
    let start = Local
        .with_ymd_and_hms(2025, 1, 3, 0, 0, 0)
        .unwrap()
        .timestamp();
    for (delta, text) in [(1, "日本語"), (5, "語。"), (11, "本"), (800, "猫")] {
        conn.execute(
            "INSERT INTO game_lines VALUES (?,?)",
            params![start + delta, text],
        )
        .unwrap();
    }
    conn.execute("INSERT INTO stats_reading_breaks VALUES (?)", [start + 3])
        .unwrap();
    let request = json!({"operation":"readingOverview","today":"2025-01-03","day_start":start,
        "day_end":start+86399,"start":null,"end":null,"session_gap":600});
    let results = call(&db, request.clone());
    assert_eq!(results.as_array().unwrap().len(), 3);
    assert_eq!(results[0]["characters"], 102);
    assert_eq!(results[0]["reading_time_seconds"], 27.5);
    assert_eq!(results[1]["characters"], 3);
    assert_eq!(results[2]["characters"], 10);
    assert_eq!(results[2]["reading_time_seconds"], 6.0);
    assert_eq!(results[2]["timestamp"].as_f64().unwrap(), start as f64);
    let mut previous = request;
    previous["start"] = json!("2025-01-02");
    previous["end"] = json!("2025-01-02");
    assert_eq!(call(&db, previous), json!([results[1]]));
}

#[test]
fn kanji_reports_merge_archive_counts_preserving_ties_and_unicode() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("gsm.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(r#"CREATE TABLE games(id TEXT PRIMARY KEY); INSERT INTO games VALUES ('game');
        CREATE TABLE game_lines(game_id,line_text); INSERT INTO game_lines VALUES ('game','𠀀猫ねこ'),('game','空猫𠀀'),('other','猫');
        CREATE TABLE archived_game_days(game_id,date,raw_kanji); INSERT INTO archived_game_days VALUES ('game','2025-01-01','{"空":1,"鳥":2}');
        CREATE TABLE daily_stats_rollup(date,kanji_frequency_data); INSERT INTO daily_stats_rollup VALUES ('2025-01-01','{"𠀀":5}'),('2025-01-02','invalid'),('2030-01-01','{"𠀀":9}');"#).unwrap();
    let grid = call(&db, json!({"operation":"gameKanji","game_id":"game"}));
    assert_eq!(
        grid["kanji_data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["kanji"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["空", "鳥", "𠀀", "猫"]
    );
    assert_eq!(
        (
            grid["unique_count"].as_u64(),
            grid["max_frequency"].as_u64()
        ),
        (Some(4), Some(2))
    );
    assert_eq!(grid["kanji_data"][0]["color"], "#2ee6e0");
    assert_eq!(
        call(
            &db,
            json!({"operation":"kanjiFrequency","kanji":"𠀀","today":"2026-01-01"})
        )["count"],
        5
    );
}

#[test]
fn capture_retries_preserve_card_fields_and_failed_imports_roll_back() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("gsm.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TABLE games(id TEXT PRIMARY KEY,deck_id,title_original,title_romaji,title_english,type,description,image,character_count,difficulty,links,completed,release_date,manual_overrides,obs_scene_name,genres,tags,vndb_character_data,character_summary,vndb_id,anilist_id,status);
        CREATE TABLE game_lines(id TEXT PRIMARY KEY,game_name,line_text,timestamp,game_id,language,last_modified,created_at,screenshot_in_anki,audio_in_anki,screenshot_path,audio_path,replay_path,translation,original_game_name,note_ids,tokenized INTEGER DEFAULT 0);").unwrap();
    let request = json!({"operation":"captureLines","mode":"capture","language":"ja","lines":[
        {"id":"one","scene":"Game","text":"日本語","timestamp":100.25}]});
    call(&db, request.clone());
    conn.execute_batch("UPDATE game_lines SET note_ids='[42]',tokenized=1; UPDATE games SET title_original='Renamed'").unwrap();
    call(&db, request.clone());
    let (n, id, notes, tokenized): (i64, String, String, i64) = conn
        .query_row(
            "SELECT (SELECT count(*) FROM games),game_id,note_ids,tokenized FROM game_lines",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!((n, id.len(), notes.as_str(), tokenized), (1, 36, "[42]", 1));
    conn.execute_batch(
        "UPDATE game_lines SET created_at=123;
         CREATE TABLE word_occurrences(line_id TEXT);
         CREATE TABLE kanji_occurrences(line_id TEXT);
         INSERT INTO word_occurrences VALUES ('one'),('another');
         INSERT INTO kanji_occurrences VALUES ('one'),('another');
         CREATE TRIGGER reject_revision BEFORE UPDATE OF line_text ON game_lines
         BEGIN SELECT RAISE(ABORT,'rejected revision'); END;",
    )
    .unwrap();
    let mut revision = request.clone();
    revision["lines"][0]["text"] = json!("新しい台詞");
    assert!(History::default()
        .run(&db, serde_json::from_value(revision.clone()).unwrap())
        .is_err());
    let token_counts = || {
        conn.query_row(
            "SELECT (SELECT count(*) FROM word_occurrences),(SELECT count(*) FROM kanji_occurrences),tokenized
             FROM game_lines WHERE id='one'",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)),
        )
        .unwrap()
    };
    assert_eq!(token_counts(), (2, 2, 1));
    conn.execute_batch("DROP TRIGGER reject_revision").unwrap();
    call(&db, revision);
    assert_eq!(token_counts(), (1, 1, 0));
    assert!(conn
        .prepare(
            "SELECT 1 FROM game_lines
         WHERE id='one' AND line_text='新しい台詞' AND note_ids='[42]' AND created_at=123
         AND EXISTS (SELECT 1 FROM word_occurrences WHERE line_id='another')
         AND EXISTS (SELECT 1 FROM kanji_occurrences WHERE line_id='another')",
        )
        .unwrap()
        .exists([])
        .unwrap());
    let mut import = request;
    import["mode"] = json!("import");
    import["lines"].as_array_mut().unwrap().insert(
        0,
        json!({"id":"two","scene":"Other","text":"new","timestamp":10}),
    );
    assert!(History::default()
        .run(&db, serde_json::from_value(import).unwrap())
        .is_err());
    assert_eq!(
        conn.query_row("SELECT count(*) FROM games", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row("SELECT count(*) FROM game_lines", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn updates_only_supplied_fields_and_merges_concurrent_notes() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("gsm.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TABLE game_lines(id TEXT PRIMARY KEY, screenshot_in_anki TEXT, audio_in_anki TEXT,
        translation TEXT, screenshot_path TEXT, audio_path TEXT, replay_path TEXT, note_ids TEXT, last_modified REAL, tokenized INTEGER);
        INSERT INTO game_lines(id, translation, note_ids, tokenized) VALUES ('one','old','[123]',1);
        CREATE TABLE changes(id TEXT);
        CREATE TRIGGER sync_update AFTER UPDATE ON game_lines BEGIN INSERT INTO changes VALUES (new.id); END;").unwrap();
    std::thread::scope(|scope| {
        for note in [
            json!("a"),
            json!("b"),
            json!("a"),
            json!(123),
            json!(456),
            json!("123"),
        ] {
            let db = &db;
            scope.spawn(move || {
                assert_eq!(
                    call(
                        db,
                        json!({"operation":"updateMinedLine","line_id":"one","note_id":note})
                    ),
                    true
                )
            });
        }
    });
    assert_eq!(
        call(
            &db,
            json!({"operation":"updateMinedLine","line_id":"one","audio_path":""})
        ),
        true
    );
    assert_eq!(
        call(
            &db,
            json!({"operation":"updateMinedLine","line_id":"absent"})
        ),
        false
    );
    let (ids, text, audio, tokenized, changes): (String,String,String,i64,i64) = conn.query_row(
        "SELECT note_ids, translation, audio_path, tokenized, (SELECT COUNT(*) FROM changes) FROM game_lines", [],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
    let ids: Vec<Value> = serde_json::from_str(&ids).unwrap();
    assert_eq!(ids.len(), 5);
    assert!(
        [json!(123), json!(456), json!("123"), json!("a"), json!("b")]
            .iter()
            .all(|id| ids.contains(id))
    );
    assert_eq!(
        (text.as_str(), audio.as_str(), tokenized, changes),
        ("old", "", 1, 7)
    );
}

#[test]
fn counts_mined_lines_across_archive_and_live_rows_with_inclusive_bounds() {
    use flate2::{write::ZlibEncoder, Compression};
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("gsm.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TABLE game_lines(timestamp REAL, note_ids TEXT, audio_in_anki TEXT, screenshot_in_anki TEXT);
        INSERT INTO game_lines VALUES (1620000000,'[1,2]', '', ''),(1620000000, 'invalid', '　', ''),(1620000000,'[]','a','');
        CREATE TABLE archived_game_days(date TEXT, events BLOB, game_name TEXT DEFAULT 'Game', game_id TEXT DEFAULT 'a');").unwrap();
    let mut z = ZlibEncoder::new(Vec::new(), Compression::default());
    z.write_all(br#"[[1620000000,1,3,0,4,false,"a"],[1620000001,1,2,0,1,true,"b"]]"#)
        .unwrap();
    let day = chrono::DateTime::from_timestamp(1620000000, 0)
        .unwrap()
        .with_timezone(&chrono::Local)
        .date_naive();
    conn.execute(
        "INSERT INTO archived_game_days(date,events) VALUES (?,?)",
        params![day.to_string(), z.finish().unwrap()],
    )
    .unwrap();
    let result = call(
        &db,
        json!({"operation":"miningHeatmap","start":1620000000.0,"end":1620000000.0}),
    );
    assert_eq!(result["2021"][day.to_string()], 3);
    conn.execute_batch("DROP TABLE archived_game_days").unwrap();
    assert_eq!(
        call(&db, json!({"operation":"miningHeatmap"}))["2021"][day.to_string()],
        2
    );
}

#[test]
fn daily_activity_uses_first_imported_date_and_fills_empty_days() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("gsm.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TABLE daily_stats_rollup(date TEXT, total_characters TEXT, total_reading_time_seconds TEXT);
        CREATE TABLE third_party_stats(date TEXT);
        INSERT INTO third_party_stats VALUES ('2026-02-28');
        INSERT INTO daily_stats_rollup VALUES ('2026-03-01',1200,1800);").unwrap();
    assert_eq!(
        call(
            &db,
            json!({"operation":"dailyActivity","today":"2026-03-02","all_time":true})
        ),
        json!({"labels":["2026-02-28","2026-03-01","2026-03-02"],"charsData":[0,1200,0],"timeData":[0.0,0.5,0.0],"speedData":[0,2400,0]})
    );
}

#[test]
fn closing_the_writer_allows_a_database_to_be_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gsm.db");
    let store = History::default();
    let init = || {
        Connection::open(&path).unwrap().execute_batch("CREATE TABLE game_lines(id TEXT PRIMARY KEY, screenshot_in_anki, audio_in_anki, screenshot_path, audio_path,replay_path, translation,note_ids,last_modified); INSERT INTO game_lines(id) VALUES ('one');").unwrap();
    };
    let write = || {
        serde_json::from_value(
            json!({"operation":"updateMinedLine","line_id":"one","translation":"translated"}),
        )
        .unwrap()
    };
    init();
    store.run(&path, write()).unwrap();
    store.run(&path, Request::CloseWriter).unwrap();
    std::fs::rename(&path, dir.path().join("previous.db")).unwrap();
    init();
    store.run(&path, write()).unwrap();
    assert_eq!(
        Connection::open(&path)
            .unwrap()
            .query_row("SELECT translation FROM game_lines", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "translated"
    );
}

#[test]
fn dashboard_grid_uses_rollups_before_today_and_live_counts_today() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("gsm.db");
    let conn = Connection::open(&db).unwrap();
    conn.execute_batch(r#"CREATE TABLE daily_stats_rollup(date,kanji_frequency_data);
        INSERT INTO daily_stats_rollup VALUES ('2026-01-01','{"地":2,"天":1}'),('2026-01-02','{"余":30}');
        CREATE TABLE game_lines(timestamp REAL,line_text); INSERT INTO game_lines VALUES (8,'鳥鳥');
        CREATE TABLE archived_game_days(game_id,date,first_timestamp,kanji); INSERT INTO archived_game_days VALUES ('g','2026-01-02',7,'{"海":2}');"#).unwrap();
    let q = json!({"operation":"kanjiGrid","today":"2026-01-02","day_start":5.0,"day_end":9.0});
    let grid = call(&db, q);
    let ordered: Vec<_> = grid["kanji_data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["kanji"].as_str().unwrap())
        .collect();
    assert_eq!(ordered, ["地", "海", "鳥", "天"]);
}
