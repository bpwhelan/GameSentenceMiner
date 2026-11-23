//! Compare reading frequencies with the configured Anki word field.
use crate::{anki_notes, game_stats::timestamp_expression, kanji, stats, ReportCleaner, Result};
use chrono::{Datelike, NaiveDate};
use indexmap::IndexMap;
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::cmp::Reverse;

#[derive(Deserialize)]
pub struct Report {
    pub today: NaiveDate,
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub word_field: String,
    pub parent_tag: String,
    /// Supplied by the HTTP layer when the collection cache is empty.
    pub live_kanji: String,
}

type Counts = IndexMap<String, u64>;

fn add_text(counts: &mut Counts, text: &str) {
    let mut buffer = [0; 4];
    for ch in text.chars().filter(kanji::is_kanji) {
        kanji::increment(counts, ch.encode_utf8(&mut buffer), 1);
    }
}

pub(super) fn date_from_ms(ms: i64) -> Option<NaiveDate> {
    let seconds = ms.max(0) as f64 / 1000.0;
    #[cfg(windows)]
    if seconds > 32_536_799_999.999 {
        return None;
    }
    stats::local_date(seconds)
        .ok()
        .filter(|d| (1..=9999).contains(&d.year()))
}

// Archived character counts belong to the first matching event in the day.
// A partial-day query can select an event after the archived day's first line.
fn archived_counts(conn: &Connection, start: f64, end: f64) -> Result<Vec<(f64, Counts)>> {
    let mut days = Vec::new();
    if stats::table_exists(conn, "archived_game_days")? {
        let mut stmt = conn.prepare_cached(
            "SELECT first_timestamp,kanji,
            CASE WHEN first_timestamp<?1 THEN events END FROM archived_game_days
            WHERE last_timestamp>=?1 AND first_timestamp<=?2 ORDER BY date,game_id",
        )?;
        let mut rows = stmt.query(params![start, end])?;
        while let Some(row) = rows.next()? {
            let at = if let Some(blob) = row.get_ref(2)?.as_blob_or_null()? {
                let Some(at) = stats::first_archive_event_in_range(blob, start, end)? else {
                    continue;
                };
                at
            } else {
                row.get(0)?
            };
            days.push((at, serde_json::from_str(row.get_ref(1)?.as_str()?)?));
        }
        days.sort_by(|a, b| a.0.total_cmp(&b.0));
    }
    Ok(days)
}

impl Report {
    fn raw_counts(&self, conn: &Connection, cleaner: &ReportCleaner) -> Result<Counts> {
        let mut counts = Counts::new();
        if self.start.is_none() && self.end.is_none() {
            // The unfiltered Python fallback reads original dialogue in insertion order.
            let mut stmt =
                conn.prepare_cached("SELECT line_text FROM game_lines ORDER BY rowid")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                if let Some(text) = row.get_ref(0)?.as_str_or_null()? {
                    add_text(&mut counts, text);
                }
            }
            return Ok(counts);
        }
        let seconds = |ms: i64| ms.max(0) as f64 / 1000.;
        let start = self.start.map(seconds).unwrap_or(f64::MIN);
        let end = self.end.map(seconds).unwrap_or(f64::MAX);
        let mut archived = archived_counts(conn, start, end)?.into_iter().peekable();
        let timestamp = timestamp_expression(conn)?;
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT CAST(timestamp AS REAL),line_text FROM game_lines
            WHERE {timestamp} BETWEEN ? AND ? ORDER BY {timestamp},rowid"
        ))?;
        let mut rows = stmt.query(params![start, end])?;
        let add_archive = |counts: &mut Counts, day: Counts| {
            for (ch, n) in day {
                kanji::increment(counts, &ch, n);
            }
        };
        while let Some(row) = rows.next()? {
            let at: f64 = row.get(0)?;
            while let Some((_, day)) = archived.next_if(|a| a.0 < at) {
                add_archive(&mut counts, day);
            }
            if let Some(text) = row.get_ref(1)?.as_str_or_null()? {
                if cleaner.changes_kanji() {
                    cleaner.visit(text, |s| add_text(&mut counts, s))?;
                } else {
                    add_text(&mut counts, text);
                }
            }
        }
        for (_, day) in archived {
            add_archive(&mut counts, day);
        }
        Ok(counts)
    }

    pub(super) fn read(&self, conn: &Connection, cleaner: &ReportCleaner) -> Result<Value> {
        let start = self.start.and_then(date_from_ms);
        let end = self.end.and_then(date_from_ms);
        let (start, end) =
            if self.start.is_some() && start.is_none() || self.end.is_some() && end.is_none() {
                // Skip historical dates when the supplied timestamp cannot be represented.
                (Some(self.today), Some(self.today))
            } else {
                (start, end)
            };
        let day_start = gsm_db::local_timestamp(self.today.and_time(chrono::NaiveTime::MIN))?;
        let day_end = gsm_db::local_timestamp(
            self.today
                .and_hms_micro_opt(23, 59, 59, 999_999)
                .ok_or("Invalid day end")?,
        )?;
        let mut counts =
            kanji::dashboard_counts(conn, self.today, start, end, day_start, day_end, cleaner)?;
        if counts.is_empty() {
            counts = self.raw_counts(conn, cleaner)?;
        }
        let populated = stats::table_exists(conn, "anki_notes")?
            && conn
                .prepare_cached("SELECT 1 FROM anki_notes LIMIT 1")?
                .exists([])?;
        let known = if populated {
            anki_notes::character_set(
                conn,
                &self.parent_tag,
                &self.word_field,
                self.start,
                self.end,
            )?
        } else {
            self.live_kanji.chars().collect()
        };
        let total = counts.len();
        counts.sort_by_cached_key(|_, n| Reverse(*n));
        let missing: Vec<_> = counts
            .into_iter()
            .filter(|(s, _)| {
                let mut chars = s.chars();
                !chars
                    .next()
                    .is_some_and(|c| known.contains(&c) && chars.next().is_none())
            })
            .map(|(ch, n)| json!({"kanji":ch,"frequency":n}))
            .collect();
        let percent = if total == 0 {
            0.0
        } else {
            (total - missing.len()) as f64 / total as f64 * 100.0
        };
        Ok(
            json!({"anki_kanji_count":known.len(),"gsm_kanji_count":total,"missing_kanji":missing,"coverage_percent":format!("{percent:.1}").parse::<f64>()?}),
        )
    }
}
