//! Shared, allocation-free pacing for native hover and Magpie projection.
//! Keep a slow hit-test heartbeat: OCR and popup geometry can change beneath a
//! stationary cursor without a native mouse event.
use std::time::{Duration, Instant};

pub const ACTIVE_INTERVAL: Duration = Duration::from_millis(16);
pub const IDLE_INTERVAL: Duration = Duration::from_millis(80);
const ACTIVE_GRACE: Duration = Duration::from_millis(160);
const HIT_TEST_REFRESH: Duration = Duration::from_millis(250);

pub struct PointerPacer<T> {
    observed: Option<T>,
    published: Option<T>,
    changed_at: Option<Instant>,
    published_at: Option<Instant>,
}

impl<T> Default for PointerPacer<T> {
    fn default() -> Self {
        Self {
            observed: None,
            published: None,
            changed_at: None,
            published_at: None,
        }
    }
}

impl<T: PartialEq + Clone> PointerPacer<T> {
    pub fn observe(&mut self, point: T, now: Instant) -> bool {
        if self.observed.as_ref() != Some(&point) {
            self.changed_at = Some(now);
            self.observed = Some(point);
        }
        self.published != self.observed
            || self
                .published_at
                .is_none_or(|at| now.duration_since(at) >= HIT_TEST_REFRESH)
    }

    // A busy renderer must not consume a changed sample until it can be sent.
    pub fn published(&mut self, now: Instant) {
        self.published.clone_from(&self.observed);
        self.published_at = Some(now);
    }

    pub fn interval(&self, now: Instant) -> Duration {
        if self
            .changed_at
            .is_none_or(|at| now.duration_since(at) < ACTIVE_GRACE)
        {
            ACTIVE_INTERVAL
        } else {
            IDLE_INTERVAL
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stationary_pointer_has_bounded_native_and_renderer_work() {
        let start = Instant::now();
        let mut now = start;
        let mut pacer = PointerPacer::default();
        let (mut polls, mut messages) = (0, 0);
        while now.duration_since(start) < Duration::from_secs(10) {
            polls += 1;
            if pacer.observe((100, 100, 0, false), now) {
                messages += 1;
                pacer.published(now);
            }
            now += pacer.interval(now);
        }
        assert!(polls <= 135, "Stationary native samples: {polls}");
        assert!(messages <= 40, "Stationary renderer hit tests: {messages}");
        assert!(
            messages >= 30,
            "Geometry beneath the cursor still needs refreshing"
        );
    }

    #[test]
    fn motion_buttons_and_modifiers_resume_fast_tracking_without_losing_pending_updates() {
        let start = Instant::now();
        let mut pacer = PointerPacer::default();
        assert!(pacer.observe((0, 0, 0, false), start));
        pacer.published(start);
        let idle = start + Duration::from_secs(1);
        assert_eq!(pacer.interval(idle), IDLE_INTERVAL);
        for point in [(1, 0, 0, false), (1, 0, 16, false), (1, 0, 0, true)] {
            assert!(pacer.observe(point, idle));
            assert_eq!(pacer.interval(idle), ACTIVE_INTERVAL);
            assert!(
                pacer.observe(point, idle),
                "A pending renderer reply must not drop the latest state"
            );
            pacer.published(idle);
            assert!(!pacer.observe(point, idle));
        }
    }
}
