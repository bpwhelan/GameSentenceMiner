//! Replay the same timed observations used by scripts/benchmark_intake_stream.py.
use gsm_intake::{Clock, Event, Policy, Stream};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, Write},
    time::Instant,
};

#[derive(Deserialize)]
struct Sample {
    ns: i64,
    scene: String,
    payload: Value,
}

fn cycle(rows: &[Sample], verify: bool) -> Vec<Value> {
    let mut stream = Stream::default();
    // The archived correlation trace is post-filter. Preserve its exact strings.
    let mut policy = Policy {
        processing: json!({"processor_order":[]}).into(),
        ..Default::default()
    };
    let mut results = Vec::new();
    let mut events = Vec::new();
    for sample in rows {
        policy.scene.clone_from(&sample.scene);
        let ack = stream.ingest(&sample.payload, &policy, Clock::at(sample.ns), &mut events);
        if verify {
            let domain: Vec<_> = events
                .iter()
                .filter_map(|e| {
                    let (kind, r) = match e {
                        Event::Append(r) => ("append", r),
                        Event::Update(r) => ("update", r),
                        Event::Freeze(r) => ("freeze", r),
                        Event::StatsReady(r) => ("stats_ready", r),
                        Event::StatsExcluded(r) => ("stats_excluded", r),
                        Event::SkipStarted(r) => ("skip_started", r),
                        Event::SkipEnded(r) => ("skip_ended", r),
                        Event::Expire(r) => ("expire", r),
                        _ => return None,
                    };
                    Some(json!([
                        kind,
                        r.stream_sequence,
                        r.revision,
                        r.text,
                        r.stats_status,
                        r.observation_ids
                    ]))
                })
                .collect();
            results.push(json!([
                ack["status"],
                ack["reason"],
                ack["stream_sequence"],
                ack["revision"],
                ack["matched_source"],
                domain
            ]));
        }
        events.clear();
        std::hint::black_box(ack);
    }
    results
}
fn main() {
    let args: Vec<_> = env::args().collect();
    if args[1] == "--filters" {
        let settings = std::sync::Arc::new(
            json!({"processor_order":["string_replacement"],"string_replacement":{"enabled":true,
            "rules":[{"mode":"regex","find":"[0-9]+","replace":"…"},{"mode":"plain","find":"字幕","replace":"台詞"}]}}),
        );
        let filters = gsm_text_preview::LineFilters::new(settings.clone(), "ja").unwrap();
        let mut result = json!({});
        for cached in [false, true] {
            let start = Instant::now();
            for _ in 0..2048 {
                let fresh;
                let filter = if cached {
                    &filters
                } else {
                    fresh = gsm_text_preview::LineFilters::new(settings.clone(), "ja").unwrap();
                    &fresh
                };
                assert_eq!(
                    filter
                        .process(std::hint::black_box("字幕123"), &Value::Null)
                        .unwrap(),
                    "台詞…"
                );
            }
            result[if cached { "reuse_us" } else { "recompile_us" }] =
                json!(start.elapsed().as_secs_f64() * 1e6 / 2048.);
        }
        println!("{result}");
        return;
    }
    let rows: Vec<Sample> = serde_json::from_slice(&fs::read(&args[1]).unwrap()).unwrap();
    let runs: usize = args[2].parse().unwrap();
    println!(
        "{}",
        serde_json::to_string(&(std::process::id(), cycle(&rows, true))).unwrap()
    );
    io::stdout().flush().unwrap();
    io::stdin().read_line(&mut String::new()).unwrap();
    let start = Instant::now();
    for _ in 0..runs {
        std::hint::black_box(cycle(&rows, false));
    }
    println!(
        "{}",
        start.elapsed().as_secs_f64() * 1e6 / (runs * rows.len()) as f64
    );
    io::stdout().flush().unwrap();
    io::stdin().read_line(&mut String::new()).unwrap();
}
