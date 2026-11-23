//! Measure only the Windows notification path without reading or changing the clipboard.
#[cfg(windows)]
mod pump {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../src-tauri/src/text_intake/clipboard_windows.rs"
    ));

    pub async fn measure() {
        use std::time::{Duration, Instant};
        let mut listener = Listener::start().await.expect("Windows clipboard listener");
        let mut samples = Vec::new();
        for _ in 0..1024 {
            let start = Instant::now();
            unsafe {
                PostThreadMessageW(listener._pump.0, WM_CLIPBOARDUPDATE, WPARAM(0), LPARAM(0))
                    .unwrap()
            }
            tokio::time::timeout(Duration::from_secs(2), listener.changed())
                .await
                .unwrap()
                .unwrap();
            samples.push(start.elapsed().as_secs_f64() * 1e6);
        }
        samples.sort_by(f64::total_cmp);
        println!(
            "{}",
            serde_json::json!({"p50_us": samples[512], "p95_us": samples[972]})
        );
    }
}

fn main() {
    #[cfg(windows)]
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
        .block_on(pump::measure());
    #[cfg(not(windows))]
    panic!("This benchmark requires Windows");
}
