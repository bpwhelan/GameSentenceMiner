//! Benchmark the same SQLite loader and exact lookup used by the desktop in a fresh process.
use gsm_history::recycled::Lines;
use serde_json::json;
use std::{hint::black_box, io, path::Path, time::Instant};

fn main() -> gsm_history::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let [_, path, scene, mode] = args.as_slice() else {
        return Err("expected DATABASE SCENE recent|full".into());
    };
    let mut input = String::new();
    io::stdin().read_line(&mut input)?;
    let probes: Vec<String> = serde_json::from_str(&input)?;
    println!("{}", std::process::id());
    input.clear();
    io::stdin().read_line(&mut input)?;
    let start = Instant::now();
    let lines = Lines::load(Path::new(path), scene, mode == "full")?;
    let load_ms = start.elapsed().as_secs_f64() * 1000.;
    let hits: Vec<bool> = probes.iter().map(|p| lines.contains(p)).collect();
    let mut times = [0.; 5];
    for us in &mut times {
        let start = Instant::now();
        for _ in 0..16 {
            for probe in &probes {
                black_box(lines.contains(black_box(probe)));
            }
        }
        *us = start.elapsed().as_secs_f64() * 1e6 / (16 * probes.len().max(1)) as f64;
    }
    times.sort_by(f64::total_cmp);
    println!(
        "{}",
        json!({"load_ms":load_ms,"lookup_us":times[2],"count":lines.len(),"hits":hits})
    );
    io::stdin().read_line(&mut input)?;
    black_box(lines);
    Ok(())
}
