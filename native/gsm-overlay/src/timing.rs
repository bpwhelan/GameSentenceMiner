//! Opt-in stage timings for the actual overlay path (no image/text contents).
use std::{sync::LazyLock, time::Instant};

static ENABLED: LazyLock<bool> =
    LazyLock::new(|| std::env::var("GSM_OVERLAY_PROFILE").as_deref() == Ok("1"));

pub struct Timer {
    name: &'static str,
    last: Option<Instant>,
}
impl Timer {
    pub fn new(name: &'static str) -> Self {
        Self {
            name,
            last: ENABLED.then(Instant::now),
        }
    }
    pub fn mark(&mut self, stage: &str) {
        if let Some(last) = &mut self.last {
            let now = Instant::now();
            eprintln!(
                "[overlay-perf] {}.{}={:.3}ms",
                self.name,
                stage,
                now.duration_since(*last).as_secs_f64() * 1000.
            );
            *last = now;
        }
    }
    pub fn input(&self, width: u32, height: u32) {
        if self.last.is_some() {
            eprintln!("[overlay-perf] {}.input={}x{}", self.name, width, height);
        }
    }
}
