use gsm_mining::{
    beacon::{BeaconEventOutcome, BeaconReceiver},
    longplay::Recorder,
};
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, BufRead},
    path::PathBuf,
    sync::Arc,
    time::Instant,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("missing fixture directory")?,
    );
    let input = fs::read_to_string(dir.join("fixture.json"))?;
    let fixture: Value = serde_json::from_str(&input)?;
    let lines: Vec<Arc<str>> = fixture["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|text| Arc::from(text.as_str().unwrap()))
        .collect();
    let events: Vec<String> = serde_json::from_value(fixture["events"].clone())?;
    let video = dir.join("rust.mkv");
    let srt = video.with_extension("srt");
    println!("ready {}", std::process::id());
    for command in io::stdin().lock().lines() {
        let (case, count, _verify): (String, u32, bool) = serde_json::from_str(&command?)?;
        let start = Instant::now();
        let mut added = 0;
        for _ in 0..count {
            if case == "beacon" {
                let (beacon, mut rx) = BeaconReceiver::new(16);
                for event in &events {
                    if beacon.handle_event(serde_json::from_str(event)?).unwrap()
                        == BeaconEventOutcome::NoteAdded
                    {
                        rx.try_recv()?;
                        added += 1;
                    }
                }
            } else {
                if srt.exists() {
                    fs::remove_file(&srt)?;
                }
                let mut recorder = Recorder::new(dir.clone());
                recorder.start(0);
                if case == "known" {
                    recorder.file(0, &video, "")?;
                }
                for (i, text) in lines.iter().enumerate() {
                    recorder.line(i as i64 * 2_500_000, text.clone())?;
                }
                recorder.stop(lines.len() as i64 * 2_500_000, Some(&video), "")?;
            }
        }
        let ms = start.elapsed().as_secs_f64() * 1000.0 / f64::from(count);
        println!(
            "{}",
            json!({"ms":ms, "added":added/count, "bytes":if case=="beacon"{0}else{srt.metadata()?.len()}})
        );
    }
    Ok(())
}
