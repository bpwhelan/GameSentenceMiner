use super::{Intake, Session};
use gsm_mining::text::{source_padding_seconds, GameLine};
use serde_json::Value;
use tauri::{AppHandle, Manager};

pub(crate) struct MiningContext {
    pub lines: Vec<GameLine>,
    pub selected_lines: Vec<GameLine>,
    pub last_overlay_scan_line: Option<GameLine>,
    pub replay_buffer_length: f64,
    pub current_game: String,
}
impl Session {
    pub(super) fn line_rows(&self, scope: &str, id: &str) -> Value {
        let indices: Vec<usize> = match scope {
            "active" => self.reader.active().collect(),
            "selected" => self.reader.selected().collect(),
            "last" => self
                .reader
                .rows()
                .last()
                .map(|(i, _)| i)
                .into_iter()
                .collect(),
            "line" => self.reader.get(id).into_iter().collect(),
            _ => Vec::new(),
        };
        let mut wanted = indices.clone();
        if scope != "active" {
            for &i in &indices {
                let (before, after) = self.reader.adjacent(i);
                wanted.extend(before);
                wanted.extend(after);
            }
            wanted.sort_unstable();
            wanted.dedup();
        }
        let lines = wanted
            .into_iter()
            .map(|i| {
                let r = self.reader.row(i);
                let mut v = serde_json::to_value(self.game_line(i)).unwrap();
                v["source_instance"] = serde_json::json!(r.instance);
                v["state"] = serde_json::json!(r.state);
                v["revision"] = serde_json::json!(r.revision);
                v["stream_sequence"] = serde_json::json!(r.sequence);
                v["finalized_at"] = serde_json::json!(r.finalized);
                v
            })
            .collect::<Vec<_>>();
        serde_json::json!({"ids":indices.iter().map(|&i|&self.reader.row(i).id).collect::<Vec<_>>(),"lines":lines})
    }

    pub(super) fn game_line(&self, i: usize) -> GameLine {
        let r = self.reader.row(i);
        let (prev, next) = self.reader.adjacent(i);
        GameLine {
            id: r.id.to_string(),
            text: r.text.to_string(),
            time_epoch: r.captured.timestamp_micros() as f64 / 1e6,
            index: i as i64,
            scene: r.scene.to_string(),
            source: Some(r.source.to_owned()),
            source_padding: Some(source_padding_seconds(Some(r.source))),
            mined_time_epoch: r.mined,
            excluded_from_stats: r.excluded,
            session_id: r.session.to_string(),
            first_seen_time_epoch: Some(r.first_seen.timestamp_micros() as f64 / 1e6),
            translation: r.translation.as_deref().unwrap_or_default().to_owned(),
            prev_id: prev.map(|j| self.reader.row(j).id.to_string()),
            next_id: next.map(|j| self.reader.row(j).id.to_string()),
            clip_folder: None,
            clip_path: None,
            clip_end_time_epoch: None,
        }
    }
}
impl Intake {
    pub(crate) fn review_neighbor(&self, id: &str, next: bool) -> Option<GameLine> {
        let state = self.state.lock().unwrap();
        let (before, after) = state.reader.adjacent(state.reader.get(id)?);
        (if next { after } else { before }).map(|index| state.game_line(index))
    }

    pub fn translated(&self, target: &GameLine, text: &str) {
        self.state
            .lock()
            .unwrap()
            .reader
            .remember_translation(&target.id, &target.text, text);
    }
    pub fn reader_targets(
        &self,
        app: &AppHandle,
        ids: &[&str],
    ) -> std::collections::HashMap<String, GameLine> {
        let mut state = self.state.lock().unwrap();
        let mut events = Vec::new();
        let clock = self.now();
        for id in ids {
            state.stream.freeze(id, clock, &mut events);
        }
        if !events.is_empty() {
            state.publish(app, events, None);
        }
        ids.iter()
            .filter_map(|id| {
                let index = state.reader.get(id)?;
                Some(((*id).to_owned(), state.game_line(index)))
            })
            .collect()
    }

    pub fn dialogue_context(&self, id: &str, length: i32) -> (String, Vec<GameLine>) {
        let state = self.state.lock().unwrap();
        let indices = state.reader.dialogue_indices(state.reader.get(id), length);
        (
            state.policy.scene.clone(),
            indices.into_iter().map(|i| state.game_line(i)).collect(),
        )
    }
    pub(crate) fn overlay_dialogue(
        &self,
        length: i32,
        anchored: bool,
    ) -> (String, Vec<GameLine>, Option<GameLine>) {
        let state = self.state.lock().unwrap();
        let last = anchored
            .then(|| state.reader.active().next_back())
            .flatten();
        let indices = state.reader.dialogue_indices(last, length);
        let lines = indices.into_iter().map(|i| state.game_line(i)).collect();
        (
            state.policy.scene.clone(),
            lines,
            last.map(|i| state.game_line(i)),
        )
    }

    pub(crate) fn last_overlay_text(&self) -> Option<String> {
        self.scan
            .lock()
            .unwrap()
            .as_ref()
            .map(|line| line.text.clone())
    }
    pub fn clip_updates(&self) -> tokio::sync::watch::Receiver<()> {
        self.state.lock().unwrap().feed.clip_changes.subscribe()
    }
    pub fn clip_event(&self, payload: &Value) {
        self.state.lock().unwrap().feed.control(payload);
    }
    pub fn default_media_ids(&self)->Vec<String> {
        let state=self.state.lock().unwrap();
        let mut ids=state.reader.selected_ids().into_iter().map(str::to_owned).collect::<Vec<_>>();
        if ids.is_empty() {
            ids.extend(state.reader.rows().last().map(|(_,line)|line.id.to_string()));
        }
        ids
    }
    pub fn media_lines(&self,app:&AppHandle,ids:&[&str])->Vec<Option<(GameLine,Option<f64>)>>{
        let mut state=self.state.lock().unwrap();
        let mut events=Vec::new();
        let now=self.now();
        for id in ids {state.stream.freeze(id,now,&mut events);}
        if !events.is_empty() {state.publish(app,events,None);}
        ids.iter().map(|id|{
            let i=state.reader.get(id)?;
            let next=state.reader.adjacent(i).1.map(|n|state.reader.row(n).captured.timestamp_micros() as f64/1e6);
            Some((state.game_line(i),next))
        }).collect()
    }
    pub fn clip_window(
        &self,
        app: &AppHandle,
        id: &str,
        freeze: bool,
    ) -> Option<gsm_mining::clips::ClipWindow> {
        let mut s = self.state.lock().unwrap();
        if freeze {
            let mut events = Vec::new();
            if s.stream.freeze(id, self.now(), &mut events) {
                s.publish(app, events, None);
            }
        }
        let i = s.reader.get(id)?;
        let (prev, next) = s.reader.adjacent(i);
        let earlier = prev.and_then(|p| s.reader.adjacent(p).0);
        let later = next.and_then(|n| s.reader.adjacent(n).1);
        let lines = |pair: [Option<usize>; 2]| {
            pair.into_iter()
                .flatten()
                .map(|index| s.game_line(index))
                .collect()
        };
        Some(gsm_mining::clips::ClipWindow {
            selected: s.game_line(i),
            before: lines([earlier, prev]),
            after: lines([next, later]),
        })
    }
    pub fn mining_context(&self) -> MiningContext {
        let mut s = self.state.lock().unwrap();
        let lines = s
            .reader
            .mining_indices()
            .into_iter()
            .map(|i| s.game_line(i))
            .collect();
        let selected_lines = s.reader.selected().map(|i| s.game_line(i)).collect();
        if s.reader.reset_selection() {
            s.feed
                .control(&serde_json::json!({"event":"reset_checkboxes"}));
        }
        MiningContext {
            lines,
            selected_lines,
            last_overlay_scan_line: self.scan.lock().unwrap().clone(),
            replay_buffer_length: s.retention.saturating_sub(5) as f64,
            current_game: s.policy.scene.clone(),
        }
    }
    pub fn persist_card(&self, update: gsm_history::mining::MinedLine) {
        let mut s = self.state.lock().unwrap();
        let pending = s.projection.collect
            && s.stream.record(&update.line_id).is_some_and(|r| {
                !r.excluded_from_stats && (r.stats_status == "pending" || r.state == "provisional")
            });
        if pending {
            s.projection
                .pending_mined
                .entry(update.line_id.clone())
                .or_default()
                .push(update);
        } else if let Some(writer) = &s.projection.writer {
            writer.mined(update);
        }
    }
    pub fn mined(&self, id: &str, now: f64, translation: &str, scene: &str, excluded: bool) {
        let mut s = self.state.lock().unwrap();
        s.reader.mark_mined(id, now, translation);
        if !excluded {
            s.projection.live.mined(scene);
            s.stats_changed("mined");
        }
    }
    pub fn remember_scan(&self, scene: String, text: String, now: f64) {
        let mut scan = self.scan.lock().unwrap();
        let time = scan
            .as_ref()
            .filter(|p| {
                p.scene == scene
                    && (0.0..=30.).contains(&(now - p.time_epoch))
                    && gsm_history::recycled::same_scan(&text, &p.text)
            })
            .map_or(now, |p| p.time_epoch);
        *scan = Some(GameLine {
            id: uuid::Uuid::new_v4().to_string(),
            text,
            scene,
            time_epoch: time,
            index: -1,
            source: Some("overlay".into()),
            source_padding: Some(3.),
            excluded_from_stats: true,
            session_id: String::new(),
            first_seen_time_epoch: None,
            mined_time_epoch: None,
            translation: String::new(),
            prev_id: None,
            next_id: None,
            clip_folder: None,
            clip_path: None,
            clip_end_time_epoch: None,
        });
    }
}
pub fn remember_overlay(app: &AppHandle, config: &Value, payload: &Value) {
    let Some(rows) = payload["data"].as_array().filter(|v| v.len() <= 4096) else {
        return;
    };
    let text = rows
        .iter()
        .filter_map(|v| v["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() || text.chars().count() > 100_000 {
        return;
    }
    let scene = config["scene"].as_str().unwrap_or_default().to_owned();
    let recovery = payload["source"] == "skip_recovery";
    let inject = config["settings"]["inject_scanned_lines"] == true;
    let intake = app.state::<Intake>();
    let now = intake.now();
    intake.remember_scan(
        scene.clone(),
        text.clone(),
        now.wall.timestamp_micros() as f64 / 1e6,
    );
    if !recovery && !inject {
        return;
    }
    let manual = matches!(
        payload["source"].as_str(),
        Some("hotkey" | "manual" | "ocr_manual" | "screen_cropper" | "secondary")
    );
    let app = app.clone();
    // The overlay validates its generation under its own lock. Re-enter intake only after
    // dispatching to another thread, since intake can itself schedule the next scan.
    tauri::async_runtime::spawn_blocking(move || {
        if recovery {
            let intake = app.state::<Intake>();
            let mut guard = intake.state.lock().unwrap();
            let s = &mut *guard;
            if s.finished || s.policy.scene != scene {
                return;
            }
            if let Ok(permit) = s.reserve_output() {
                let mut events = vec![];
                s.stream.recover(&text, &s.policy, now, &mut events);
                s.publish(&app, events, permit);
            }
        } else {
            let msg = serde_json::json!({"text":text,"source":"overlay","skip_overlay":true,"ocr_scene":scene,
                "metadata":{"overlay_stage":"injection","overlay_manual":manual}});
            if let Err(e) = super::ingest(&app, msg, None) {
                crate::desktop_log::warn(&app, "text-intake", e);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use gsm_intake::{Clock, Event, Policy};
    use serde_json::json;

    fn append(s: &mut Session, text: &str, ts: i64) -> String {
        let mut events = vec![];
        let ack = s.stream.ingest(
            &json!({"text":text,"source":"manual"}),
            &Policy::default(),
            Clock {
                wall: chrono::Utc.timestamp_opt(ts, 0).unwrap(),
                ns: ts * 1_000_000_000,
            },
            &mut events,
        );
        for e in &events {
            s.reader.observe(e);
        }
        ack["line_id"].as_str().unwrap().into()
    }

    #[test]
    fn expired_selection_and_overlay_survive_until_mining_consumes_selection() {
        let intake = Intake::default();
        let mut s = intake.state.lock().unwrap();
        let old = append(&mut s, "昨日の文章", 10);
        let mut events = vec![];
        s.stream.maintain(
            Clock {
                wall: chrono::Utc.timestamp_opt(100, 0).unwrap(),
                ns: 100_000_000_000,
            },
            5,
            &mut events,
        );
        assert!(events.iter().any(|e| matches!(e, Event::Expire(_))));
        for e in &events {
            s.reader.observe(e);
        }
        let fresh = append(&mut s, "今日の文章", 100);
        assert!(s.reader.select(&old, true));
        drop(s);
        intake.remember_scan("Game".into(), "猫".into(), 95.);
        intake.remember_scan("Game".into(), "猫".into(), 100.);
        let context = intake.mining_context();
        assert_eq!(
            context
                .selected_lines
                .iter()
                .map(|r| r.id.as_str())
                .collect::<Vec<_>>(),
            [old.as_str()]
        );
        assert_eq!(context.last_overlay_scan_line.unwrap().time_epoch, 95.);
        let next = intake.mining_context();
        assert!(next.selected_lines.is_empty());
        assert_eq!(next.lines.len(), 1);
        assert_eq!(next.lines[0].id, fresh);
    }

    #[test]
    fn speech_updates_keep_identity_and_neighbors_in_mining_context() {
        let intake = Intake::default();
        let mut s = intake.state.lock().unwrap();
        let prev = append(&mut s, "前の文章", 10);
        for (i, text) in ["こ", "こんにちは"].into_iter().enumerate() {
            let mut events = vec![];
            s.stream.ingest(
                &json!({"source":"speech","text":text,"revision_window_ms":5000}),
                &Policy::default(),
                Clock {
                    wall: chrono::Utc.timestamp_opt(11, 0).unwrap(),
                    ns: 11_000_000_000 + i as i64,
                },
                &mut events,
            );
            for event in events {
                s.reader.observe(&event);
            }
        }
        let next = append(&mut s, "次の文章", 12);
        drop(s);
        let lines = intake.mining_context().lines;
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[1].text, "こんにちは");
        assert_eq!(lines[1].prev_id.as_deref(), Some(prev.as_str()));
        assert_eq!(lines[1].next_id.as_deref(), Some(next.as_str()));
    }
    #[test]
    #[ignore = "local timing harness for the production mining context"]
    fn benchmark_reader_mining_context() {
        let intake = Intake::default();
        let selected = {
            let mut s = intake.state.lock().unwrap();
            let mut selected = String::new();
            for i in 0..1024 {
                let id = append(&mut s, &format!("日本語の文章番号{i}です。"), i + 10);
                if i == 64 {
                    selected = id;
                }
            }
            selected
        };
        let mut samples = vec![];
        for _ in 0..300 {
            intake.state.lock().unwrap().reader.select(&selected, true);
            let start = std::time::Instant::now();
            let ctx = std::hint::black_box(intake.mining_context());
            samples.push(start.elapsed().as_nanos());
            assert_eq!(ctx.lines.len(), 259);
            assert_eq!(ctx.selected_lines.len(), 1);
        }
        samples.sort_unstable();
        println!(
            "mining_context_p50_us={} p95_us={}",
            samples[150] as f64 / 1000.,
            samples[285] as f64 / 1000.
        );
    }
}
