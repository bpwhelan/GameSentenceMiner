// Application-layer benchmark worker. The driver creates a disposable fixture
// and compares response bodies before measuring repeated calls on each stack.
use gsm_history::{History, Result};
use gsm_web::{
    pages::{asset, Page},
    Reports, Route,
};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead},
    path::PathBuf,
    sync::Arc,
    time::Instant,
};

fn main() -> Result<()> {
    let directory = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("fixture directory required")?,
    );
    let reports = Reports::new(&directory, Arc::new(History::default()));
    let fixture = rusqlite::Connection::open(directory.join("gsm.db"))?;
    println!("ready {}", std::process::id());
    for line in io::stdin().lock().lines() {
        let (url, count, verify): (String, usize, bool) = serde_json::from_str(&line?)?;
        let (path, query) = url.split_once('?').unwrap_or((&url, ""));
        let edit = matches!(
            path,
            "goal-edit-partial" | "goal-edit-settings" | "goal-edit-timed" | "import-stats-500"
        )
        .then(|| std::fs::read(directory.join(format!("{path}.json"))))
        .transpose()?;
        let start = Instant::now();
        let mut fixture_reset_time = std::time::Duration::ZERO;
        let mut body = Vec::new();
        for _ in 0..count {
            if let Some(edit) = edit.as_deref() {
                let input = serde_json::from_slice(edit)?;
                let reply = if path == "import-stats-500" {
                    reports.edit_reading_stats(gsm_web::ReadingEdit::Import, input)
                } else {
                    reports.update_goals(input, Some("America/New_York"))
                };
                if reply.status != 200 {
                    return Err(reply.body.to_string().into());
                }
                body = serde_json::to_vec(&reply.body)?;
            } else if matches!(path, "/api/yomitan-freq-dict" | "/api/yomitan-dict") {
                let response = if path == "/api/yomitan-dict" {
                    reports.character_dictionary(query)?
                } else {
                    reports.yomitan_frequency(false)
                };
                body = match response {
                    gsm_web::yomitan_frequency::Response::Archive(bytes) => bytes,
                    gsm_web::yomitan_frequency::Response::Json(reply) => {
                        return Err(reply.body.to_string().into())
                    }
                };
            } else if path == "schema" {
                gsm_db::migrate_file(&directory.join("gsm.db"), "ja")?;
                body = b"null".to_vec();
            } else if path == "vocabulary-schema" {
                gsm_db::vocabulary::configure(
                    &mut gsm_db::open_writer(&directory.join("gsm.db"))?,
                    true,
                )?;
                body = b"null".to_vec();
            } else if path == "complete-dailies" {
                let reset = Instant::now();
                fixture.execute(
                    "DELETE FROM goals WHERE date=?",
                    [chrono::Utc::now().date_naive().to_string()],
                )?;
                fixture_reset_time += reset.elapsed();
                let reply = reports.complete_goals(None)?;
                if reply.status != 200 {
                    return Err(format!("Goal completion failed: {}", reply.body).into());
                }
                body = serde_json::to_vec(&reply.body)?;
            } else if path == "backup" {
                gsm_db::backup::compressed_snapshot(
                    &directory.join("gsm.db"),
                    &directory.join("snapshot.db.gz"),
                )?;
                body = b"null".to_vec();
            } else if path == "replace-500" {
                let rows = (0..500)
                    .map(|i| gsm_db::imports::Entry {
                        date: "2026-01-01".into(),
                        characters: i + 1,
                        seconds: 60.,
                        source: "bench".into(),
                        label: "fixture".into(),
                    })
                    .collect::<Vec<_>>();
                let cleared =
                    gsm_db::imports::import_file(&directory.join("gsm.db"), Some("bench"), &rows)?;
                body = serde_json::to_vec(&json!({"imported":rows.len(),"cleared":cleared}))?;
            } else if let Some(item) = asset(path) {
                body = item.bytes.to_vec();
            } else if let Some(page) = Page::parse(path) {
                body = page.render(&reports)?.ok_or("page missing")?.into_bytes();
            } else {
                let r = reports
                    .read(Route::parse(path).ok_or("unknown route")?, query)?
                    .ok_or("unexpected fallback")?;
                if r.status != 200 {
                    return Err(format!("HTTP {}", r.status).into());
                }
                body = serde_json::to_vec(&r.body)?;
            }
            std::hint::black_box(&body);
        }
        let ms = (start.elapsed() - fixture_reset_time).as_secs_f64() * 1000. / count as f64;
        let result = if verify && matches!(path, "/api/yomitan-freq-dict" | "/api/yomitan-dict") {
            std::fs::write(directory.join("rust.zip"), &body)?;
            Value::Null
        } else if verify && !matches!(path, "/stats" | "/search") {
            serde_json::from_slice(&body)?
        } else {
            Value::Null
        };
        println!("{}", json!({"ms":ms,"bytes":body.len(),"result":result}));
    }
    Ok(())
}
