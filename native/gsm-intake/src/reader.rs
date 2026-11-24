//! Session history and selection for reader and mining clients.
use crate::{Event, Record};
use chrono::{DateTime, Local, Utc};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;

/// The session reader keeps expired lines selectable. Large OCR geometry, raw observations and
/// intermediate revisions have the shorter lifetime of the intake journal.
#[derive(Clone)]
pub struct Line {
    pub id: Arc<str>,
    pub session: Arc<str>,
    pub text: Arc<str>,
    pub scene: Arc<str>,
    pub source: &'static str,
    pub instance: Arc<str>,
    pub captured: DateTime<Utc>,
    pub first_seen: DateTime<Utc>,
    pub finalized: Option<DateTime<Utc>>,
    pub sequence: u64,
    pub revision: u64,
    pub state: &'static str,
    pub excluded: bool,
    pub mined: Option<f64>,
    pub translation: Option<Arc<str>>,
}

impl Line {
    fn from_record(r: &Record) -> Self {
        Self {
            id: r.line_id.as_str().into(),
            session: r.session_id.clone(),
            text: r.text.clone(),
            scene: r.scene.clone(),
            source: r.source_kind,
            instance: r.source_instance.clone(),
            captured: r.captured_at_utc,
            first_seen: r.first_seen_at_utc,
            finalized: r.finalized_at_utc,
            sequence: r.stream_sequence,
            revision: r.revision,
            state: r.state,
            excluded: r.excluded_from_stats || r.stats_status == "skipped",
            mined: None,
            translation: None,
        }
    }
    pub fn legacy(&self, checked: bool) -> Value {
        json!({"id":self.id,"text":self.text,"time":self.captured.with_timezone(&Local).naive_local(),
            "checked":checked,"history":false,"excluded_from_stats":self.excluded,
            "session_id":self.session,"stream_sequence":self.sequence,"revision":self.revision,"state":self.state})
    }
}

pub fn wire_record(r: &Record) -> Value {
    json!({"id":r.line_id,"session_id":r.session_id,"stream_sequence":r.stream_sequence,"revision":r.revision,
        "state":r.state,"raw_text":r.raw_text,"text":r.text,"source":r.source_kind,"source_instance":r.source_instance,
        "source_display_name":r.source_display_name,"observation_ids":r.observation_ids,"captured_at":r.captured_at_utc,
        "first_seen_at":r.first_seen_at_utc,"finalized_at":r.finalized_at_utc,"scene":r.scene,
        "excluded_from_stats":r.excluded_from_stats || r.stats_status=="skipped","stats_status":r.stats_status,"relay_only":r.relay_only})
}

pub fn snapshot_limit(request: &Value) -> usize {
    let n = &request["max_lines"];
    n.as_i64()
        .or_else(|| n.as_str()?.parse().ok())
        .unwrap_or(1000)
        .clamp(1, 1000) as usize
}

const MAX_EXPIRED_ROWS: usize = 2000;

#[derive(Default)]
pub struct Reader {
    rows: Vec<Line>,
    by_id: HashMap<Arc<str>, usize>,
    active: BTreeSet<usize>,
    selected: BTreeSet<usize>,
    remaining: u8,
}

impl Reader {
    fn compact_expired(&mut self) {
        let expired = self.rows.len().saturating_sub(self.active.len());
        if expired <= MAX_EXPIRED_ROWS {
            return;
        }
        let target_expired = MAX_EXPIRED_ROWS.saturating_sub(256);
        let mut unselected_expired = Vec::with_capacity(expired);
        for i in 0..self.rows.len() {
            if !self.active.contains(&i) && !self.selected.contains(&i) {
                unselected_expired.push(i);
            }
        }
        let drop_count = unselected_expired.len().saturating_sub(target_expired);
        if drop_count == 0 {
            return;
        }
        let mut keep = vec![true; self.rows.len()];
        for idx in unselected_expired.into_iter().take(drop_count) {
            keep[idx] = false;
        }
        let old_rows = std::mem::take(&mut self.rows);
        let old_active = std::mem::take(&mut self.active);
        let old_selected = std::mem::take(&mut self.selected);
        self.by_id.clear();
        self.rows.reserve(old_rows.len() - drop_count);
        for (old_idx, line) in old_rows.into_iter().enumerate() {
            if !keep[old_idx] {
                continue;
            }
            let new_idx = self.rows.len();
            self.by_id.insert(line.id.clone(), new_idx);
            if old_active.contains(&old_idx) {
                self.active.insert(new_idx);
            }
            if old_selected.contains(&old_idx) {
                self.selected.insert(new_idx);
            }
            self.rows.push(line);
        }
    }

    /// Returns true when the second distinct append expires a selection.
    pub fn observe(&mut self, event: &Event) -> bool {
        let r = match event {
            Event::Append(r) => {
                let index = self.rows.len();
                let line = Line::from_record(r);
                self.by_id.insert(line.id.clone(), index);
                self.rows.push(line);
                self.active.insert(index);
                if self.remaining > 0 {
                    self.remaining -= 1;
                    if self.remaining == 0 {
                        self.selected.clear();
                        return true;
                    }
                }
                return false;
            }
            Event::Freeze(r)
            | Event::Update(r)
            | Event::StatsReady(r)
            | Event::StatsExcluded(r)
            | Event::Expire(r) => r,
            _ => return false,
        };
        if let Some(&i) = self.by_id.get(r.line_id.as_str()) {
            let line = &mut self.rows[i];
            if line.revision <= r.revision {
                if line.text != r.text {
                    line.translation = None;
                }
                line.text = r.text.clone();
                line.captured = r.captured_at_utc;
                line.first_seen = r.first_seen_at_utc;
                line.source = r.source_kind;
                line.instance = r.source_instance.clone();
                line.finalized = r.finalized_at_utc;
                line.revision = r.revision;
                line.state = r.state;
                line.excluded = r.excluded_from_stats || r.stats_status == "skipped";
                if matches!(event, Event::Expire(_)) {
                    self.active.remove(&i);
                    self.compact_expired();
                }
            }
        }
        false
    }

    pub fn select(&mut self, id: &str, checked: bool) -> bool {
        let Some(&i) = self.by_id.get(id) else {
            return false;
        };
        let changed = if checked {
            self.selected.insert(i)
        } else {
            self.selected.remove(&i)
        };
        if changed {
            self.remaining = if self.selected.is_empty() { 0 } else { 2 };
        }
        true
    }
    pub fn reset_selection(&mut self) -> bool {
        self.remaining = 0;
        let changed = !self.selected.is_empty();
        self.selected.clear();
        changed
    }
    pub fn mark_mined(&mut self, id: &str, time: f64, translation: &str) {
        if let Some(&i) = self.by_id.get(id) {
            self.rows[i].mined = Some(time);
            if !translation.is_empty() {
                self.rows[i].translation = Some(translation.into());
            }
        }
    }
    pub fn get(&self, id: &str) -> Option<usize> {
        self.by_id.get(id).copied()
    }
    pub fn remember_translation(&mut self, id: &str, source: &str, translation: &str) {
        if let Some(&i) = self.by_id.get(id) {
            let row = &mut self.rows[i];
            if row.text.as_ref() == source && row.translation.as_deref() != Some(translation) {
                row.translation = Some(translation.into());
            }
        }
    }
    pub fn row(&self, index: usize) -> &Line {
        &self.rows[index]
    }
    pub fn checked(&self, index: usize) -> bool {
        self.selected.contains(&index)
    }
    pub fn selected(&self) -> impl Iterator<Item = usize> + '_ {
        self.selected.iter().copied()
    }
    pub fn selected_ids(&self) -> Vec<&str> {
        self.selected().map(|i| self.rows[i].id.as_ref()).collect()
    }
    pub fn active(&self) -> impl DoubleEndedIterator<Item = usize> + '_ {
        self.active.iter().copied()
    }
    /// Return just the active neighbours used by the configured AI dialogue prompt.
    pub fn dialogue_indices(&self, anchor: Option<usize>, length: i32) -> Vec<usize> {
        if length == -1 {
            return self.active().collect();
        }
        if length <= 0 {
            return Vec::new();
        }
        let count = length as usize;
        if let Some(i) = anchor.filter(|i| self.active.contains(i)) {
            let mut result: Vec<_> = self.active.range(..i).rev().take(count).copied().collect();
            result.reverse();
            result.extend(self.active.range(i..).take(count + 1).copied());
            result
        } else {
            let mut tail: Vec<_> = self.active().rev().take(count).collect();
            tail.reverse();
            tail
        }
    }
    pub fn adjacent(&self, i: usize) -> (Option<usize>, Option<usize>) {
        if !self.active.contains(&i) {
            return (None, None);
        }
        (
            self.active.range(..i).next_back().copied(),
            self.active.range(i + 1..).next().copied(),
        )
    }
    pub fn mining_indices(&self) -> Vec<usize> {
        let mut tail: Vec<_> = self.active().rev().take(256).collect();
        tail.reverse();
        if self.selected.is_empty() {
            return tail;
        }
        for i in self.selected().filter(|i| self.active.contains(i)) {
            let (before, after) = self.adjacent(i);
            tail.extend(before);
            tail.push(i);
            tail.extend(after);
        }
        tail.sort_unstable();
        tail.dedup();
        tail
    }
    pub fn rows(&self) -> impl Iterator<Item = (usize, &Line)> {
        self.rows.iter().enumerate()
    }
    pub fn state(&self, session: &str, paused: bool) -> Value {
        json!({"session_id":session,"ids":self.active().map(|i|&self.rows[i].id).collect::<Vec<_>>(),
            "selected_ids":self.selected_ids(),"timed_out_ids":self.rows().filter(|(_,r)|r.state=="expired").map(|(_,r)|&r.id).collect::<Vec<_>>(),
            "text_intake_paused":paused})
    }
    pub fn sync(&self, session: &str, request: &Value) -> Value {
        let known: HashSet<_> = request["sessions"][session]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let count = if request["max_lines"]
            .as_i64()
            .or_else(|| request["max_lines"].as_str()?.parse().ok())
            .is_some_and(|n| n <= 0)
        {
            1000
        } else {
            snapshot_limit(request)
        };
        let mut ordered = vec![];
        let mut active = vec![];
        let mut expired = vec![];
        let mut missing = vec![];
        for (i, r) in self.rows().skip(self.rows.len().saturating_sub(count)) {
            ordered.push(&r.id);
            if r.state == "expired" {
                expired.push(&r.id);
            } else {
                active.push(&r.id);
            }
            if !known.contains(r.id.as_ref()) {
                missing.push(json!({"sentence":r.text,"data":r.legacy(self.checked(i))}));
            }
        }
        json!({"event":"textfeed_session_sync","session_id":session,"ordered_ids":ordered,"active_ids":active,"timed_out_ids":expired,"lines":missing})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Clock, Policy, Stream};
    use chrono::Utc;
    use serde_json::json;

    #[test]
    fn dialogue_context_respects_expiry_and_the_configured_window() {
        let reader = Reader {
            active: [2, 4, 7, 10, 12].into_iter().collect(),
            ..Default::default()
        };
        assert_eq!(reader.dialogue_indices(Some(7), 1), [4, 7, 10]);
        assert_eq!(reader.dialogue_indices(Some(2), 2), [2, 4, 7]);
        assert_eq!(reader.dialogue_indices(Some(8), 2), [10, 12]);
        assert_eq!(reader.dialogue_indices(None, -1), [2, 4, 7, 10, 12]);
        assert!(reader.dialogue_indices(Some(4), 0).is_empty());
    }

    #[test]
    fn selection_survives_retries_and_revisions_then_expires_after_two_appends() {
        let mut history = Reader::default();
        let mut stream = Stream::default();
        let mut push = |history: &mut Reader, text: &str, ns: i64| {
            let mut events = vec![];
            let ack = stream.ingest(
                &json!({"source":"manual","text":text}),
                &Policy::default(),
                Clock {
                    wall: Utc::now(),
                    ns,
                },
                &mut events,
            );
            for e in &events {
                history.observe(e);
            }
            ack["line_id"].as_str().unwrap().to_owned()
        };
        let a = push(&mut history, "a", 1);
        assert!(history.select(&a, true));
        push(&mut history, "b", 2);
        assert!(history.select(&a, true));
        assert_eq!(history.selected_ids(), vec![a.as_str()]);
        push(&mut history, "c", 3);
        assert!(history.selected_ids().is_empty());
    }

    #[test]
    fn expired_rows_compact_while_preserving_active_and_selected_lines() {
        let mut history = Reader::default();
        let mut stream = Stream::default();
        let mut append = |i: i64| -> Arc<Record> {
            let mut events = vec![];
            let ack = stream.ingest(
                &json!({"source":"manual","text":format!("line-{i}")}),
                &Policy::default(),
                Clock {
                    wall: Utc::now(),
                    ns: i * 1_000_000,
                },
                &mut events,
            );
            for e in &events {
                history.observe(e);
            }
            Arc::clone(stream.record(ack["line_id"].as_str().unwrap()).unwrap())
        };

        let records: Vec<_> = (1..=2100).map(&mut append).collect();
        let selected = &records[0].line_id;
        assert!(history.select(selected, true));
        // Expire older rows except the last 50 (stay active).
        for record in &records[..2050] {
            let mut expired = (**record).clone();
            expired.revision += 1;
            expired.state = "expired";
            history.observe(&Event::Expire(Arc::new(expired)));
        }
        assert!(history.get(&records.last().unwrap().line_id).is_some());
        assert_eq!(history.active().count(), 50);
        let expired_count = history.rows.len().saturating_sub(history.active.len());
        assert!(expired_count <= MAX_EXPIRED_ROWS);
        assert_eq!(history.selected_ids(), vec![selected.as_str()]);
        assert!(history.get(&records[1].line_id).is_none());
        assert!(history.get(&records[2049].line_id).is_some());
    }
}
