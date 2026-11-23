use gsm_history::{game_archive, History, ReportCleaner};
use serde_json::{json, Value};
use std::{fs, io::Read, path::Path};

fn rows(path: &Path) -> Vec<Value> {
    let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    let mut text = String::new();
    zip.by_name("game_lines.jsonl")
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    text.lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect()
}

#[test]
fn rearchive_and_restore_preserve_portable_rows_day_counts_and_saved_words() {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("gsm.db");
    let mut db = gsm_db::open_profile(&db_path, "ja").unwrap();
    gsm_db::vocabulary::configure(&mut db, true).unwrap();
    db.execute_batch(
        "INSERT INTO games(id,title_original) VALUES('a','一/二');
        INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp,tokenized,note_ids) VALUES
        ('one','a','旧名','日本。',1600000000,1,'[3,4]'),('two','a','旧名','本',1600000030,1,'[]');
        INSERT INTO words(id,word,reading,pos,in_anki) VALUES(10,'日本','にほん','名詞',1);
        INSERT INTO word_occurrences(word_id,line_id) VALUES(10,'one'),(10,'two');
        INSERT INTO kanji(id,character) VALUES(1,'本');
        INSERT INTO kanji_occurrences(kanji_id,line_id) VALUES(1,'one'),(1,'two');",
    )
    .unwrap();
    let history = History::default();
    let guard = history.try_maintenance(&db_path).unwrap().unwrap();
    let cleaner = ReportCleaner::default();
    let archive = || history.archive_game(&guard, "a", None, &cleaner, 300.0, true);
    let first = archive().unwrap();
    assert_eq!(first["archived_lines"], 2);
    let file = temp
        .path()
        .join("archives/games")
        .join(first["archive_file"]["filename"].as_str().unwrap());
    assert!(file
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("game-一_二--"));
    assert_eq!(rows(&file)[0]["words"][0][0], "日本");
    let archived = || {
        db.query_row(
            "SELECT line_count,character_count,tokenized_lines FROM archived_game_days",
            [],
            |r| {
                Ok((
                    r.get::<_, u64>(0)?,
                    r.get::<_, u64>(1)?,
                    r.get::<_, u64>(2)?,
                ))
            },
        )
        .unwrap()
    };
    assert_eq!(archived(), (2, 3, 2));
    db.execute_batch(
        "INSERT INTO game_lines(id,game_id,game_name,line_text,timestamp,tokenized) VALUES
        ('three','a','旧名','紙',1600000040,0);",
    )
    .unwrap();
    let original = fs::read(&file).unwrap();
    assert!(archive()
        .unwrap_err()
        .to_string()
        .contains("Tokenization failed"));
    assert_eq!(original, fs::read(&file).unwrap());
    db.execute_batch("UPDATE game_lines SET tokenized=1 WHERE id='three';
        CREATE TRIGGER injected BEFORE DELETE ON game_lines BEGIN SELECT raise(ABORT,'injected'); END;").unwrap();
    assert!(archive().unwrap_err().to_string().contains("injected"));
    assert_eq!(archived(), (2, 3, 2));
    assert_eq!(rows(&file).len(), 3);
    db.execute_batch("DROP TRIGGER injected").unwrap();
    let second = archive().unwrap();
    assert_eq!(second["archive_file"]["line_count"], 3);
    assert_eq!(archived(), (3, 4, 3));
    let saved = rows(&file);
    assert_eq!(
        saved.iter().map(|r| &r["line"]["id"]).collect::<Vec<_>>(),
        vec!["one", "two", "three"]
    );
    let result = history
        .restore_archive(
            &guard,
            &file,
            &game_archive::file_id("a"),
            &cleaner,
            300.0,
            true,
        )
        .unwrap();
    assert_eq!(result, json!({"restored_lines":3,"skipped_lines":0}));
    assert_eq!(
        db.query_row("SELECT count(*) FROM word_occurrences", [], |r| r
            .get::<_, usize>(0))
            .unwrap(),
        2
    );
}

#[test]
fn invalid_existing_zip_and_resumed_game_leave_live_sentences_intact() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("gsm.db");
    let db = gsm_db::open_profile(&path, "ja").unwrap();
    db.execute_batch(
        "INSERT INTO games(id,title_original,status) VALUES('a','a','in_progress');
        INSERT INTO game_lines(id,game_id,line_text,timestamp) VALUES('one','a','文',1600000000)",
    )
    .unwrap();
    let h = History::default();
    let guard = h.try_maintenance(&path).unwrap().unwrap();
    let directory = temp.path().join("archives/games");
    fs::create_dir_all(&directory).unwrap();
    let zip = directory.join(format!(
        "old--{}.gsm-archive.zip",
        game_archive::file_id("a")
    ));
    fs::write(&zip, b"damaged").unwrap();
    let run = |cutoff| h.archive_game(&guard, "a", cutoff, &ReportCleaner::default(), 300.0, false);
    assert_eq!(run(Some(1700000000.0)).unwrap()["archived_lines"], 0);
    assert!(run(None).is_err());
    assert_eq!(fs::read(&zip).unwrap(), b"damaged");
    assert_eq!(
        db.query_row("SELECT count(*) FROM game_lines", [], |r| r
            .get::<_, usize>(0))
            .unwrap(),
        1
    );
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
}
