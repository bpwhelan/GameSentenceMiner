use super::*;
use unicode_normalization::UnicodeNormalization;

fn compact(text: &str) -> String {
    skip_detection::simple_text(text)
        .unwrap_or_else(|| text.nfkc().filter(|c| c.is_alphanumeric()).collect())
}
impl Stream {
    fn classify_stats(&mut self, row: &Record, skipped: bool, events: &mut Vec<Event>) {
        let mut row = row.clone();
        row.revision += 1;
        row.stats_status = if skipped { "skipped" } else { "accepted" };
        row.excluded_from_stats |= skipped;
        let row = self.publish(row, false, None);
        events.push(if skipped {
            Event::StatsExcluded(row)
        } else {
            Event::StatsReady(row)
        });
    }
    pub(super) fn poll_stats(&mut self, now: Clock, events: &mut Vec<Event>) {
        if self.detector.quiet(now.ns.into()) {
            if let Some(row) = self
                .skip_line
                .as_ref()
                .and_then(|id| self.journal.get(id.as_bytes()))
                .cloned()
            {
                events.push(Event::SkipEnded(row.clone()));
                if self.detector.confirmed && self.journal.sequence() == row.stream_sequence {
                    self.landing =
                        Some((row.line_id.clone(), now.ns.saturating_add(10_000_000_000)));
                }
            }
            self.detector = Default::default();
        }
        if !self.detector.suspended {
            let ready: Vec<_> = self
                .journal
                .ready(i128::from(now.ns) - 2_000_000_000)
                .cloned()
                .collect();
            for r in ready {
                self.classify_stats(&r, false, events);
            }
        }
    }
    pub(super) fn observe_skip(
        &mut self,
        row: &Arc<Record>,
        processed: &str,
        now: Clock,
        events: &mut Vec<Event>,
    ) {
        let suspended = self.detector.suspended;
        self.detector.observe(
            row.source_kind,
            row.source_instance.as_bytes(),
            compact(processed),
            now.ns.into(),
            row.metadata["skip_control_active"] == true,
        );
        self.skip_line = Some(row.line_id.clone());
        if self.detector.suspended && !suspended {
            events.push(Event::SkipStarted(row.clone()));
        }
        let skipped: Vec<_> = self
            .journal
            .for_exclusion(self.detector.confirmed)
            .cloned()
            .collect();
        for r in skipped {
            self.classify_stats(&r, true, events);
        }
    }
    pub(super) fn change_scene(&mut self, scene: &str, now: Clock, events: &mut Vec<Event>) {
        self.landing = None;
        if self.detector.suspended {
            if let Some(old) = self
                .skip_line
                .as_ref()
                .and_then(|id| self.journal.get(id.as_bytes()))
            {
                let mut row = (**old).clone();
                Arc::make_mut(&mut row.metadata)["skip_context_reset"] = json!(true);
                events.push(Event::SkipEnded(Arc::new(row)));
            }
        }
        self.finish_pending(false, now, events);
        self.detector = Default::default();
        self.scene = scene.into();
    }
    fn finish_pending(&mut self, exclude: bool, now: Clock, events: &mut Vec<Event>) {
        let pending: Vec<_> = self.journal.pending().cloned().collect();
        for mut row in pending {
            if self.freeze(&row.line_id, now, events) {
                row = self.journal.get(row.line_id.as_bytes()).unwrap().clone();
            }
            self.classify_stats(&row, exclude && row.stats_status == "pending", events);
        }
    }
    pub fn finish(&mut self, now: Clock, events: &mut Vec<Event>) {
        if let Some((id, _)) = self.speech.clone() {
            self.freeze(&id, now, events);
        }
        self.finish_pending(self.detector.confirmed, now, events);
    }
    pub fn recover(
        &mut self,
        text: &str,
        policy: &Policy,
        now: Clock,
        events: &mut Vec<Event>,
    ) -> bool {
        let Some((id, deadline)) = &self.landing else {
            return false;
        };
        let Some(row) = self.journal.get(id.as_bytes()) else {
            return false;
        };
        if self.detector.suspended
            || policy.paused
            || row.scene.as_ref() != policy.scene
            || now.ns > *deadline
        {
            return false;
        }
        let visible = compact(text);
        if !(8..=500).contains(&visible.chars().count()) {
            return false;
        }
        let old = compact(&row.text);
        if !old.ends_with(&visible) {
            return false;
        }
        self.landing = None;
        if old == visible {
            let mut row = (**row).clone();
            row.revision += 1;
            row.stats_status = "accepted";
            row.excluded_from_stats = false;
            row.source_kind = "overlay";
            row.source_instance = "skip-recovery".into();
            row.captured_at_utc = now.wall;
            row.first_seen_at_utc = now.wall;
            row.first_seen_monotonic_ns = now.ns;
            events.push(Event::StatsReady(self.publish(row, false, None)));
        } else {
            let p = json!({"text":text,"source":"overlay","source_instance":"skip-recovery","skip_overlay":true,"metadata":{"skip_landing_confirmed":true}});
            return self.ingest_inner(&p, policy, now, events, true)["status"] == "accepted";
        }
        true
    }
}
