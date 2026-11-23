use super::Live;
use crate::{
    game_stats::{count_cards_raw, timestamp_expression},
    sessions::{median_pace, reading_breaks, reading_cap, DurationSum},
    stats::archive_events,
    History, ReportCleaner, Result,
};
use chrono::{DateTime, Days, Local, NaiveDate, TimeZone};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path, sync::Arc};

const RAW_GAP_LIMIT: f64 = 1800.;

/// Cheap snapshot of provisional dialogue. The query runs outside the intake lock.
pub struct Today {
    scene: Arc<str>,
    lines: Vec<(Arc<str>, Arc<str>, f64)>,
}

impl Live {
    pub fn today(&self) -> Today {
        Today {
            scene: self.scene.clone(),
            lines: self
                .entries
                .iter()
                .map(|e| (e.id.clone(), e.text.clone(), e.time))
                .collect(),
        }
    }
}

struct Sample {
    time: f64,
    scene: String,
    game_id: String,
    chars: usize,
    cards: usize,
}

fn boundary(date: NaiveDate, hour: u32) -> Result<f64> {
    let local = date
        .and_hms_opt(hour, 0, 0)
        .ok_or("Invalid stats rollover hour")?;
    // A DST jump can skip the configured local hour.
    (0..=180)
        .find_map(|minutes| {
            Local
                .from_local_datetime(&(local + chrono::Duration::minutes(minutes)))
                .earliest()
        })
        .map(|t| t.timestamp() as f64)
        .ok_or_else(|| "Missing local stats day boundary".into())
}

impl Today {
    pub fn restore(
        &self,
        history: &History,
        path: &Path,
        scene: &str,
        at: DateTime<Local>,
        settings: &Value,
    ) -> Result<Value> {
        let now = at.timestamp_micros() as f64 / 1e6;
        let hour = settings["day_rollover_hour"]
            .as_i64()
            .unwrap_or(4)
            .clamp(0, 23) as u32;
        let mut date = at.date_naive();
        if now < boundary(date, hour)? {
            date = date
                .checked_sub_days(Days::new(1))
                .ok_or("Invalid stats date")?;
        }
        let start = boundary(date, hour)?;
        let end = boundary(date.succ_opt().ok_or("Invalid stats date")?, hour)?;
        let gap = settings["session_gap_seconds"].as_f64().unwrap_or(1800.);
        let cleaner = ReportCleaner::from_saved(
            settings["extra_punctuation_regex"].as_str().unwrap_or(""),
            settings["regex_out_repetitions"] == true,
        );
        history.with_reader(path, |conn| {
            let tx = conn.transaction()?;
            let mut payload = self.read(&tx, scene, start, now, gap, &cleaner)?;
            payload["period_start"] = json!(start);
            payload["period_end"] = json!(end);
            Ok(payload)
        })
    }

    fn read(
        &self,
        conn: &Connection,
        scene: &str,
        start: f64,
        now: f64,
        gap: f64,
        cleaner: &ReportCleaner,
    ) -> Result<Value> {
        let mut timeline = Vec::new();
        let mut live: HashMap<_, _> = self
            .lines
            .iter()
            .filter(|(_, _, t)| (start..=now).contains(t))
            .map(|(id, text, t)| (id.as_ref(), (text, *t)))
            .collect();
        let game: Option<(String, String, String)> = conn
            .query_row(
                "SELECT id, coalesce(obs_scene_name,''), coalesce(title_original,'') FROM games
             WHERE ?1 <> '' AND (obs_scene_name=?1 OR title_original=?1)
             ORDER BY (obs_scene_name=?1) DESC LIMIT 1",
                [scene],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let (mut id, obs_name, title) = game.unwrap_or_default();
        if !scene.is_empty() {
            let ts = timestamp_expression(conn)?;
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT id, {ts}, coalesce(game_name,''), coalesce(game_id,''),
                        coalesce(line_text,''), coalesce(note_ids,''),
                        coalesce(screenshot_in_anki,''), coalesce(audio_in_anki,'')
                 FROM game_lines WHERE {ts} BETWEEN ?1 AND ?2 ORDER BY {ts}"
            ))?;
            let mut rows = stmt.query((start, now))?;
            while let Some(r) = rows.next()? {
                let key = r.get_ref(0)?.as_str()?;
                let text = live
                    .remove(key)
                    .map_or(r.get_ref(4)?.as_str()?, |(text, _)| text.as_ref());
                timeline.push(Sample {
                    time: r.get(1)?,
                    scene: r.get(2)?,
                    game_id: r.get(3)?,
                    chars: cleaner.count(text)?,
                    cards: count_cards_raw(
                        r.get_ref(5)?.as_str()?,
                        r.get_ref(6)?.as_str()?,
                        r.get_ref(7)?.as_str()?,
                    )? as usize,
                });
            }
            archive_events(
                conn,
                Some(start),
                Some(now),
                |time, chars, cards, name, game_id| {
                    timeline.push(Sample {
                        time,
                        chars,
                        cards: cards as usize,
                        scene: name.into(),
                        game_id: game_id.into(),
                    });
                    Ok(())
                },
            )?;
            if id.is_empty() {
                if let Some(sample) = timeline
                    .iter()
                    .find(|s| s.scene == scene && !s.game_id.is_empty())
                {
                    id.clone_from(&sample.game_id);
                }
            }
            for (text, time) in live.into_values() {
                timeline.push(Sample {
                    time,
                    scene: self.scene.to_string(),
                    game_id: String::new(),
                    chars: cleaner.count(text)?,
                    cards: 0,
                });
            }
            timeline.sort_by(|a, b| a.time.total_cmp(&b.time));
        }
        let matches_name =
            |name: &str| !name.is_empty() && [scene, &obs_name, &title].contains(&name);
        let matches = |s: &Sample| {
            if !id.is_empty() && !s.game_id.is_empty() {
                s.game_id == id
            } else {
                matches_name(&s.scene)
            }
        };
        let breaks = reading_breaks(conn, start, now)?;
        let interrupted = |a, b| {
            breaks
                .get(breaks.partition_point(|t| *t < a))
                .is_some_and(|t| *t < b)
        };
        let current_game = matches_name(&self.scene);
        let last = self.lines.last().filter(|_| current_game).map(|l| l.2);
        let active = last.is_some_and(|t| (start..=now).contains(&t) && now - t <= gap);
        let mut pending = 0.;
        let mut active_time = DurationSum::default();
        let mut raw_time = 0.;
        let (mut chars, mut cards, mut lines) = (0, 0, 0);
        for group in timeline.chunk_by(|a, b| matches(a) == matches(b) && b.time - a.time <= gap) {
            if !matches(&group[0]) {
                continue;
            }
            lines += group.len();
            chars += group.iter().map(|s| s.chars).sum::<usize>();
            cards += group.iter().map(|s| s.cards).sum::<usize>();
            let pairs = group.windows(2).map(|w| {
                (
                    w[1].time - w[0].time,
                    w[0].chars as f64,
                    interrupted(w[0].time, w[1].time),
                )
            });
            let pace = median_pace(pairs.clone().filter(|p| !p.2).map(|(dt, n, _)| (dt, n)));
            for (dt, n, cut) in pairs {
                let credit = if cut {
                    0.
                } else {
                    dt.min(reading_cap(n, pace))
                };
                active_time.add(credit);
                raw_time += if dt <= RAW_GAP_LIMIT { dt } else { credit };
            }
            let tail = group.last().unwrap();
            if Some(tail.time) == last && !interrupted(tail.time, now) {
                pending = reading_cap(tail.chars as f64, pace);
            }
        }
        if let Some(t) = last.filter(|_| active) {
            let dt = now - t;
            raw_time += if dt <= RAW_GAP_LIMIT {
                dt
            } else {
                dt.min(pending)
            };
        }
        let seconds = active_time.seconds();
        let round = |v: f64| (v * 10.).round_ties_even() / 10.;
        Ok(
            json!({"scope":"today","updated_at":now,"game_name":scene,"game_id":id,"session_active":active,
            "session_start_time":self.lines.first().filter(|_| current_game).map(|l| l.2),
            "last_line_time":last,"session_expires_at":last.filter(|_|active).map(|t|t+gap),
            "raw_time_gap_limit_seconds":RAW_GAP_LIMIT,"raw_time_pending_active_seconds":pending,
            "values":{"chars_per_hour":if lines>=5 && seconds>5. {(chars as f64*3600./seconds) as u64} else {0},
            "total_characters":chars,"active_reading_time":round(seconds),"raw_reading_time":round(raw_time),"cards_mined":cards}}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daily_totals_restore_saved_and_provisional_lines_across_game_switches() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "
            CREATE TABLE games(id TEXT, obs_scene_name TEXT, title_original TEXT);
            INSERT INTO games VALUES('g', 'Scene A', 'Title A');
            CREATE TABLE game_lines(id TEXT, timestamp REAL, game_name TEXT, game_id TEXT,
                line_text TEXT, note_ids TEXT, audio_in_anki TEXT, screenshot_in_anki TEXT);
            INSERT INTO game_lines VALUES
                ('early', 90, 'Scene A','g','前日',NULL,NULL,NULL),
                ('1',100,'Title A','g','学校です','[123,456]',NULL,NULL),
                ('2',105,'Scene A','g','猫',NULL,NULL,NULL),
                ('b',110,'B','b','別のゲーム',NULL,NULL,NULL),
                ('3',150,'Scene A','g','木',NULL,NULL,NULL);
            CREATE TABLE stats_reading_breaks(timestamp REAL);
            INSERT INTO stats_reading_breaks VALUES(152);",
        )
        .unwrap();
        let snapshot = Today {
            scene: "Scene A".into(),
            lines: vec![
                ("3".into(), "山と川".into(), 150.),
                ("4".into(), "空".into(), 155.),
            ],
        };
        let payload = snapshot
            .read(
                &db,
                "Scene A",
                100.,
                160.,
                1800.,
                &ReportCleaner::from_saved("", false),
            )
            .unwrap();
        assert_eq!(payload["scope"], "today");
        // 4+1 saved characters, 3 revised characters, and 1 provisional character.
        assert_eq!(payload["values"]["total_characters"], 9);
        assert_eq!(payload["values"]["cards_mined"], 2);
        assert_eq!(payload["values"]["active_reading_time"], 5.);
        assert_eq!(payload["values"]["raw_reading_time"], 15.);
        assert_eq!(payload["session_expires_at"], 1955.);
        let other = snapshot
            .read(
                &db,
                "B",
                100.,
                160.,
                1800.,
                &ReportCleaner::from_saved("", false),
            )
            .unwrap();
        assert_eq!(other["session_active"], false);
        assert_eq!(other["values"]["raw_reading_time"], 0.);
    }
}
