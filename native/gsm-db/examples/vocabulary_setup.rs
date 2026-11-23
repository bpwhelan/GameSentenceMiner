//! Persistent worker for scripts/benchmark_vocabulary_setup.py.
use gsm_db::{frequency, Result};
use serde::Deserialize;
use serde_json::json;
use std::{
    io::{self, BufRead},
    path::PathBuf,
    time::Instant,
};

#[derive(Deserialize)]
struct Case {
    op: String,
    db: PathBuf,
}

fn main() -> Result<()> {
    let dir = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("source directory required")?,
    );
    println!("ready {}", std::process::id());
    for line in io::stdin().lock().lines() {
        let (case, count, _): (Case, usize, bool) = serde_json::from_str(&line?)?;
        let mut db = gsm_db::open_writer(&case.db)?;
        let start = Instant::now();
        for _ in 0..count {
            match case.op.as_str() {
                "enable" | "enabled" => gsm_db::vocabulary::configure_desktop(&mut db, true)?,
                "disable" => gsm_db::vocabulary::configure_desktop(&mut db, false)?,
                "fresh" | "reopen" | "upgrade" | "warm" => {
                    frequency::sync(&mut db, &dir)?;
                }
                _ => return Err("Unknown benchmark case".into()),
            }
        }
        println!(
            "{}",
            json!({"ms":start.elapsed().as_secs_f64()*1000./count as f64})
        );
    }
    Ok(())
}
