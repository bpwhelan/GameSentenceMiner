//! Explicit, ignored benchmark against a separate real WGC window.
use crate::overlay::Capture;
use gsm_overlay::{engines::Engines, ocr};
use serde_json::{json, Value};
use std::{
    path::Path,
    time::{Duration, Instant},
};
fn cpu() -> f64 {
    use windows::Win32::{
        Foundation::FILETIME,
        System::Threading::{GetCurrentProcess, GetProcessTimes},
    };
    let (mut a, mut b, mut k, mut u) = (
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
        FILETIME::default(),
    );
    unsafe {
        GetProcessTimes(GetCurrentProcess(), &mut a, &mut b, &mut k, &mut u).unwrap();
    }
    let seconds = |t: FILETIME| {
        ((t.dwHighDateTime as u64) << 32 | t.dwLowDateTime as u64) as f64 / 10_000_000.
    };
    seconds(k) + seconds(u)
}
#[test]
#[ignore = "Requires a visible external capture fixture and local OCR models"]
fn native_ocr_real_capture_benchmark() {
    let file = std::env::var("GSM_OCR_BENCH_CONFIG").expect("benchmark configuration");
    let config: Value = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    let engine = config["engine"].as_str().unwrap_or("screenai");
    let mut engines = Engines::new(Path::new(config["profile"].as_str().unwrap()));
    let mut capture_state = Capture::default();
    let mut samples = Vec::new();
    let cold = Instant::now();
    let cold_cpu = cpu();
    let count = config["samples"].as_u64().unwrap_or(20);
    let mut wall = Instant::now();
    let mut used = cpu();
    for sample in 0..=count {
        let start = Instant::now();
        let before = cpu();
        let image = super::capture_frame(&config, &mut capture_state).unwrap();
        capture_state.set_interval(Duration::from_millis(100));
        let captured = start.elapsed().as_secs_f64() * 1000.;
        let prepared =
            ocr::prepare(&image, &config["areas"], false, false, &config["settings"]).unwrap();
        let recognized = engines.recognize(&prepared.image, engine, "ja").unwrap();
        let entry = json!({"capture_ms":captured,"total_ms":start.elapsed().as_secs_f64()*1000.,"cpu_ms":(cpu()-before)*1000.,"text":recognized.text,"image_size":image.dimensions(),"ocr_size":prepared.image.dimensions()});
        if sample == 0 {
            println!(
                "OCRBENCH_COLD {}",
                json!({"wall_ms":cold.elapsed().as_secs_f64()*1000.,"cpu_ms":(cpu()-cold_cpu)*1000.,"sample":entry})
            );
            wall = Instant::now();
            used = cpu();
        } else {
            samples.push(entry);
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let elapsed = wall.elapsed().as_secs_f64();
    let used = cpu() - used;
    let result = json!({"runtime":"rust","engine":engine,"samples":samples,"wall_seconds":elapsed,"cpu_seconds":used,"one_core_percent":used/elapsed*100.,"logical_cpus":std::thread::available_parallelism().unwrap().get(),"total_machine_percent":used/elapsed*100./std::thread::available_parallelism().unwrap().get() as f64});
    std::fs::write(
        config["result"].as_str().unwrap(),
        serde_json::to_vec_pretty(&result).unwrap(),
    )
    .unwrap();
    println!("OCRBENCH {}", result);
}
#[test]
#[ignore = "Requires visible capture fixture"]
fn shared_capture_session_benchmark() {
    use gsm_capture::{statistics, Capture, Target};
    use std::sync::Arc;
    let config: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("GSM_OCR_BENCH_CONFIG").unwrap()).unwrap(),
    )
    .unwrap();
    let target = Target::Window(config["target_id"].as_u64().unwrap());
    let (mut a, mut b) = (Capture::default(), Capture::default());
    let before = statistics();
    a.grab_shared(target, (1920, 1080)).unwrap();
    let baseline_cpu = cpu();
    let baseline_wall = Instant::now();
    let mut baseline_latencies = Vec::new();
    for _ in 0..100 {
        let start = Instant::now();
        a.grab_shared(target, (1920, 1080)).unwrap();
        baseline_latencies.push(start.elapsed().as_secs_f64() * 1000.);
        std::thread::sleep(Duration::from_millis(50));
    }
    let baseline_elapsed = baseline_wall.elapsed().as_secs_f64();
    let baseline_used = cpu() - baseline_cpu;
    let paired_before = statistics();
    let mut latencies = Vec::new();
    let mut shared = 0;
    let used = cpu();
    let wall = Instant::now();
    for _ in 0..100 {
        let start = Instant::now();
        let first = a.grab_shared(target, (1920, 1080)).unwrap();
        let first_ms = start.elapsed().as_secs_f64() * 1000.;
        let second_at = Instant::now();
        let second = b.grab_shared(target, (1920, 1080)).unwrap();
        if Arc::ptr_eq(&first, &second) {
            shared += 1;
        }
        latencies
            .push(json!({"first_ms":first_ms,"second_ms":second_at.elapsed().as_secs_f64()*1000.}));
        std::thread::sleep(Duration::from_millis(50));
    }
    let elapsed = wall.elapsed().as_secs_f64();
    let used = cpu() - used;
    let after = statistics();
    assert_eq!(
        after[0] - before[0],
        1,
        "two consumers must share one WGC session"
    );
    assert!(
        shared >= 75,
        "most adjacent consumers must reuse CPU readback"
    );
    assert!(
        after[1] - paired_before[1] >= 30,
        "fixture must produce changing GPU frames"
    );
    // Exercise the production OCR and overlay acquisition wrappers too.
    assert_eq!(
        gsm_capture::capture_window(&config, &mut a)
            .unwrap()
            .dimensions(),
        (1920, 1080)
    );
    assert_eq!(
        gsm_capture::capture(&config, false, &mut b)
            .unwrap()
            .0
            .dimensions(),
        (1920, 1080)
    );
    assert_eq!(
        statistics()[0],
        after[0],
        "production consumers must reuse the same session"
    );
    a.clear();
    assert!(
        b.grab_shared(target, (1920, 1080)).is_ok(),
        "stopping one consumer must not stop another"
    );
    b.clear();
    let processors = std::thread::available_parallelism().unwrap().get() as f64;
    let report = json!({"single_consumer":{"samples_ms":baseline_latencies,"wall_seconds":baseline_elapsed,"cpu_seconds":baseline_used,"total_machine_percent":baseline_used/baseline_elapsed*100./processors},"samples":latencies,"shared_pairs":shared,"sessions_created":after[0]-before[0],"readbacks":after[1]-paired_before[1],"reuses":after[2]-paired_before[2],"wall_seconds":elapsed,"cpu_seconds":used,"total_machine_percent":used/elapsed*100./processors});
    let out = Path::new(config["result"].as_str().unwrap())
        .parent()
        .unwrap()
        .join("shared-capture.json");
    std::fs::write(out, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    println!("SHARED_CAPTURE {report}");
}
