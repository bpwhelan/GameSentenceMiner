//! Per-session reading totals. Credit a line only when the next line arrives; speech corrections
//! revise its original gap. Reprice gaps lazily when a consumer requests the current pace.
use crate::sessions::{live_count, pace_adjusted_seconds, PunctuationRegex};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};

mod today;
pub use today::Today;

pub struct Cleaner {
    pattern: String,
    extra: Option<PunctuationRegex>,
    repeat: bool,
}
impl Default for Cleaner {
    fn default() -> Self {
        Self {
            pattern: String::new(),
            extra: None,
            repeat: false,
        }
    }
}
impl Cleaner {
    pub fn configure(&mut self, pattern: &str, repeat: bool) {
        self.repeat = repeat;
        if self.pattern != pattern {
            self.extra = PunctuationRegex::compile(pattern.trim());
            self.pattern = pattern.into();
        }
    }
    pub fn count(&self, text: &str) -> usize {
        live_count(text, self.extra.as_ref(), self.repeat)
    }
}
struct Entry {
    id: Arc<str>,
    text: Arc<str>,
    time: f64,
    count: usize,
    revision: u64,
    gap: Option<(f64, bool)>,
}
#[derive(Default)]
pub struct Live {
    pub scene: Arc<str>,
    entries: Vec<Entry>,
    indices: HashMap<Arc<str>, usize>,
    breaks: Vec<f64>,
    total: usize,
    cards: u64,
    seconds: Option<f64>,
}
impl Live {
    pub fn set_scene(&mut self, scene: &str) -> bool {
        let scene = scene.trim();
        if self.scene.as_ref() == scene {
            return false;
        }
        *self = Self {
            scene: scene.into(),
            ..Default::default()
        };
        true
    }
    pub fn expire(&mut self, now: f64, timeout: f64) -> bool {
        if self.entries.last().is_some_and(|e| now - e.time > timeout) {
            *self = Self {
                scene: self.scene.clone(),
                ..Default::default()
            };
            true
        } else {
            false
        }
    }
    pub fn interrupt(&mut self, time: f64) {
        let i = self.breaks.partition_point(|v| *v <= time);
        self.breaks.insert(i, time);
    }
    pub fn mined(&mut self, scene: &str) {
        if scene.trim() == self.scene.as_ref() {
            self.cards += 1;
        }
    }
    pub fn observe(
        &mut self,
        id: &str,
        text: &Arc<str>,
        scene: &str,
        time: f64,
        revision: u64,
        clean: &Cleaner,
        timeout: f64,
    ) -> Option<&'static str> {
        self.set_scene(scene);
        if let Some(&i) = self.indices.get(id) {
            let e = &mut self.entries[i];
            if revision <= e.revision {
                return None;
            }
            let count = clean.count(text);
            if e.gap.is_some() {
                self.total = self.total - e.count + count;
                self.seconds = None;
            }
            e.revision = revision;
            e.count = count;
            e.text = text.clone();
            return Some("line_revision");
        }
        self.expire(time, timeout);
        if let Some(prev) = self.entries.last_mut() {
            let j = self.breaks.partition_point(|b| *b < prev.time);
            let interrupted = self.breaks.get(j).is_some_and(|b| *b < time);
            prev.gap = Some(((time - prev.time).max(0.), interrupted));
            self.total += prev.count;
        }
        self.seconds = None;
        let id: Arc<str> = id.into();
        self.indices.insert(id.clone(), self.entries.len());
        self.entries.push(Entry {
            id,
            text: text.clone(),
            time,
            count: clean.count(text),
            revision,
            gap: None,
        });
        Some("line")
    }
    pub fn lines(&self) -> Value {
        Value::Array(
            self.entries
                .iter()
                .map(|e| json!([e.id.as_ref(), e.text.as_ref(), e.time, self.scene.as_ref()]))
                .collect(),
        )
    }
    pub fn values(&mut self) -> Value {
        let seconds = *self.seconds.get_or_insert_with(|| {
            pace_adjusted_seconds(self.entries.iter().filter_map(|e| {
                e.gap
                    .filter(|(_, interrupted)| !*interrupted)
                    .map(|(gap, _)| (gap, e.count as f64))
            }))
        });
        let start = self.entries.first().map(|e| e.time);
        let last = self.entries.last().map(|e| e.time);
        json!({"game_name":self.scene.as_ref(),"session_active":last.is_some(),"session_start_time":start,"last_line_time":last,
            "values":{"total_characters":self.total,"cards_mined":self.cards,
            "active_reading_time":(seconds*10.).round_ties_even()/10.,
            "raw_reading_time":((last.unwrap_or(0.)-start.unwrap_or(0.)).max(0.)*10.).round_ties_even()/10.,
            "chars_per_hour":if seconds>5. && self.entries.len()>=5{(self.total as f64*3600./seconds) as u64}else{0}}})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revised_credited_text_reprices_time_and_explicit_breaks_survive() {
        let mut live = Live::default();
        let clean = Cleaner::default();
        let add = |live: &mut Live, id: &str, text: &str, time: f64, rev: u64| {
            live.observe(id, &text.into(), "Game", time, rev, &clean, 60.)
        };
        add(&mut live, "1", "一二三四五", 1., 1);
        add(&mut live, "2", "一二三四五", 11., 1);
        live.interrupt(12.);
        add(&mut live, "3", "本", 21., 1);
        assert_eq!(live.values()["values"]["active_reading_time"], 10.);
        assert_eq!(live.values()["values"]["total_characters"], 10);
        add(&mut live, "1", "一二三四五六", 1., 2);
        assert_eq!(live.values()["values"]["total_characters"], 11);
        assert!(add(&mut live, "1", "一二三四五六", 1., 2).is_none());
        live.mined("Game");
        assert_eq!(live.values()["values"]["cards_mined"], 1);
        assert!(!live.expire(81., 60.));
        assert!(live.expire(82., 60.));
        assert_eq!(live.values()["values"]["cards_mined"], 0);
    }
}
