//! Measure hook ranking in an isolated worker.
use serde_json::Value;
use std::io::{self, BufRead};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut lines = io::stdin().lock().lines();
    let request: Value = serde_json::from_str(&lines.next().ok_or("Missing workload")??)?;
    let blocks = serde_json::from_value::<Vec<String>>(request["blocks"].clone())?;
    let mut finder = gsm_text_preview::HookFinder::new(
        request["profile"]
            .as_str()
            .ok_or("Missing benchmark profile")?
            .into(),
    );
    let mut run = || finder.rank(&request["snapshot"], &blocks, || false);
    println!("{}", std::process::id());
    for line in lines {
        let count: usize = line?.parse()?;
        if count == 0 {
            println!("{}", run()?);
        } else {
            for _ in 0..count {
                std::hint::black_box(run()?);
            }
            println!("done");
        }
    }
    Ok(())
}
