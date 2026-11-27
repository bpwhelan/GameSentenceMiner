//! Benchmark profile file operations against a fixture directory.
use chrono::Local;
use gsm_db::{profile, Result};
use serde_json::json;
use std::{
    io::{self, BufRead},
    path::PathBuf,
    time::Instant,
};

fn main() -> Result<()> {
    let root = PathBuf::from(std::env::args_os().nth(1).ok_or("fixture root required")?);
    let selected = root.join("selected");
    let source = root.join("gsm.db");
    let mut jobs = gsm_db::open_writer(&root.join("jobs.db"))?;
    let pointer = root.join("bootstrap/home/.config/GameSentenceMiner/data_dir.json");
    println!("ready {}", std::process::id());
    for input in io::stdin().lock().lines() {
        let (op, count, _): (String, usize, bool) = serde_json::from_str(&input?)?;
        let start = Instant::now();
        let mut path = None;
        for _ in 0..count {
            path = match op.as_str() {
                "seed-jobs" | "existing-jobs" => {
                    gsm_db::startup_jobs::initialize(
                        &mut jobs,
                        &serde_json::Value::Null,
                        Local::now(),
                    )?;
                    Some(root.join("jobs.db"))
                }
                "relocate" | "reopen" => {
                    profile::recover_legacy_database(&pointer, &selected, false)?;
                    Some(selected.join("gsm.db"))
                }
                "manual" => Some(profile::manual_backup(&source)?.0),
                "daily" | "already-backed-up" => profile::daily_backup(
                    &source,
                    &root.join("daily"),
                    Local::now().date_naive(),
                    2,
                )?,
                _ => return Err("unknown benchmark case".into()),
            };
        }
        println!(
            "{}",
            json!({"ms":start.elapsed().as_secs_f64()*1000.0/count as f64,"result":path})
        );
    }
    Ok(())
}
