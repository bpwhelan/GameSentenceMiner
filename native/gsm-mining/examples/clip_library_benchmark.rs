use gsm_mining::clips::{catalog, ClipFolders};
use serde_json::json;
use std::{
    fs,
    io::{self, BufRead},
    path::PathBuf,
    time::Instant,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("fixture directory missing")?,
    );
    let root = directory.join("Clips");
    let ids: Vec<String> = serde_json::from_slice(&fs::read(directory.join("ids.json"))?)?;
    println!("ready {}", std::process::id());
    for line in io::stdin().lock().lines() {
        let (case, count, verify): (String, u32, bool) = serde_json::from_str(&line?)?;
        let start = Instant::now();
        let mut output = Vec::new();
        for _ in 0..count {
            output.clear();
            if case == "catalog" {
                serde_json::to_writer(&mut output, &catalog(Some(&root)))?;
            } else {
                let library = ClipFolders::open(&root).unwrap();
                let n = ids
                    .iter()
                    .filter(|id| library.resolve(id).is_some())
                    .count();
                serde_json::to_writer(&mut output, &n)?;
            }
        }
        let ms = start.elapsed().as_secs_f64() * 1000.0 / f64::from(count);
        if verify {
            fs::write(directory.join("rust-output.json"), &output)?;
        }
        println!("{}", json!({"ms":ms,"bytes":output.len()}));
    }
    Ok(())
}
