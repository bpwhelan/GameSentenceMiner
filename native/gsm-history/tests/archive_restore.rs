use flate2::{write::ZlibEncoder, Compression};
use gsm_history::{game_archive::file_id, History, ReportCleaner};
use serde_json::{json, Value};
use std::{fs::File, io::Write, path::Path};

fn zip_fixture(path: &Path, rows: &[Value]) {
    let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("manifest.json", options).unwrap();
    serde_json::to_writer(
        &mut zip,
        &json!({"format":"gsm-game-archive","version":1,"game_name":"元","game_id":"a",
        "game":{"id":"a","title_original":"元"},"line_count":rows.len()}),
    )
    .unwrap();
    zip.start_file("game_lines.jsonl", options).unwrap();
    for row in rows {
        serde_json::to_writer(&mut zip, row).unwrap();
        zip.write_all(b"\n").unwrap();
    }
    zip.finish().unwrap();
}

fn sentence(id: &str) -> Value {
    json!({"line":{"id":id,"game_name":"元","game_id":"a","timestamp":"1600000000","line_text":"日本","tokenized":1,
        "saved_bytes":{"$binary":"AAEC/w=="}},"tokens_available":true,"words":[["日本","にほん","名詞",0]],"kanji":["日","本"]})
}

#[test]
fn portable_restore_preserves_tokens_and_bytes_after_a_game_merge_and_on_retry() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("gsm.db");
    let mut db = gsm_db::open_profile(&path, "ja").unwrap();
    gsm_db::vocabulary::configure(&mut db, true).unwrap();
    db.execute_batch("ALTER TABLE game_lines ADD COLUMN saved_bytes BLOB;
        INSERT INTO games(id,title_original,obs_scene_name) VALUES('merged','New title','新しい場面')").unwrap();
    let mut compressed = ZlibEncoder::new(Vec::new(), Compression::fast());
    serde_json::to_writer(
        &mut compressed,
        &json!([
            [1600000000, 2, 0, 0, 2, 1, "one"],
            [1600000000, 2, 0, 0, 2, 1, "two"]
        ]),
    )
    .unwrap();
    let date = gsm_history::reports::local_date(1600000000.0)
        .unwrap()
        .to_string();
    db.execute("INSERT INTO archived_game_days VALUES ('merged',?1,'新しい場面',?2,'{}','{}',1,2,4,1600000000,1600000000,2,'{}')",
        rusqlite::params![date,compressed.finish().unwrap()]).unwrap();
    let source = temp.path().join("restore.zip");
    let h = History::default();
    let run = |enabled| {
        let guard = h.try_maintenance(&path).unwrap().unwrap();
        h.restore_archive(
            &guard,
            &source,
            &file_id("a"),
            &ReportCleaner::default(),
            300.0,
            enabled,
        )
    };
    let first = sentence("one");
    zip_fixture(&source, std::slice::from_ref(&first));
    assert!(run(false)
        .unwrap_err()
        .to_string()
        .contains("Enable tokenization"));
    assert!(run(true)
        .unwrap_err()
        .to_string()
        .contains("part of an archived day"));
    zip_fixture(&source, &[first, sentence("two")]);
    db.execute(
        "INSERT INTO game_lines(id,game_id) VALUES('two','merged')",
        [],
    )
    .unwrap();
    assert!(run(true)
        .unwrap_err()
        .to_string()
        .contains("both live and archived"));
    assert_eq!(
        db.query_row("SELECT count(*) FROM game_lines", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    db.execute("DELETE FROM game_lines WHERE id='two'", [])
        .unwrap();
    assert_eq!(
        run(true).unwrap(),
        json!({"restored_lines":2,"skipped_lines":0})
    );
    assert_eq!(
        run(true).unwrap(),
        json!({"restored_lines":0,"skipped_lines":2})
    );
    let query = |sql| db.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
    assert_eq!(
        query(
            "SELECT count(*) FROM game_lines WHERE saved_bytes=x'000102ff' AND game_id='merged'
        AND original_game_name='元' AND game_name='新しい場面' AND tokenized=1"
        ),
        2
    );
    assert_eq!(query("SELECT count(*) FROM archived_game_days"), 0);
    assert_eq!(query("SELECT count(*) FROM words WHERE first_seen_line_id='one' AND CAST(last_seen AS REAL)=1600000000"),1);
    assert_eq!(query("SELECT count(*) FROM word_occurrences"), 2);
    assert_eq!(query("SELECT count(*) FROM kanji_occurrences"), 4);
    assert_eq!(query("SELECT count(*) FROM daily_stats_rollup"), 1);
}

#[test]
fn future_columns_and_duplicate_ids_leave_the_target_database_untouched() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("gsm.db");
    let db = gsm_db::open_profile(&path, "ja").unwrap();
    let h = History::default();
    let source = temp.path().join("restore.zip");
    let run = || {
        let guard = h.try_maintenance(&path).unwrap().unwrap();
        h.restore_archive(
            &guard,
            &source,
            &file_id("a"),
            &ReportCleaner::default(),
            300.0,
            false,
        )
    };
    let first = json!({"line":{"id":"one","game_id":"a","line_text":"犬","timestamp":1600000000}});
    let mut second = first.clone();
    second["line"]["id"] = json!("two");
    second["line"]["future_data"] = json!(123);
    zip_fixture(&source, &[first.clone(), second]);
    assert!(run()
        .unwrap_err()
        .to_string()
        .contains("unsupported columns"));
    zip_fixture(&source, &[first.clone(), first]);
    assert!(run()
        .unwrap_err()
        .to_string()
        .contains("Duplicate sentence IDs"));
    assert_eq!(
        db.query_row(
            "SELECT (SELECT count(*) FROM games)+(SELECT count(*) FROM game_lines)",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}
