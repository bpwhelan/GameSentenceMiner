use crate::{stats::local_date, stats::table_exists, Result};
use chrono::{Datelike, NaiveDate};
use indexmap::IndexMap;
use rusqlite::{types::ValueRef, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    word_field: String,
    today: NaiveDate,
    weeks: Option<WeekRange>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WeekRange {
    start: NaiveDate,
    end: NaiveDate,
}

type Counts = BTreeMap<NaiveDate, usize>;

// Keep SQLite's MIN semantics on legacy columns with mixed storage classes.
// A review wins even when its timestamp is NULL. The card's sync time is
// used only when the item has no mature review at all.
const EMPTY: &str = "SELECT NULL AS id, NULL AS t WHERE 0";
const NOTE_REVIEWS: &str = "SELECT CAST(note_id AS INTEGER) AS id, MIN(review_time) AS t
    FROM anki_reviews WHERE CAST(interval AS INTEGER)>=21 AND CAST(note_id AS INTEGER)>0 GROUP BY id";
const NOTE_CARD_REVIEWS: &str = "SELECT CAST(c.note_id AS INTEGER) AS id, MIN(r.review_time) AS t
    FROM anki_cards c JOIN anki_reviews r ON r.card_id=c.card_id
    WHERE CAST(r.interval AS INTEGER)>=21 AND CAST(c.note_id AS INTEGER)>0
    AND CAST(c.note_id AS INTEGER) IS NOT CAST(r.note_id AS INTEGER) GROUP BY id";
const NOTE_CARDS: &str = "SELECT CAST(note_id AS INTEGER) AS id, MIN(synced_at) AS t
    FROM anki_cards WHERE CAST(interval AS INTEGER)>=21 AND CAST(note_id AS INTEGER)>0 GROUP BY id";
const KANJI_REVIEWS: &str = "SELECT k.kanji_id AS id, MIN(r.t) AS t FROM
    (SELECT card_id, MIN(review_time) AS t FROM anki_reviews WHERE interval>=21 GROUP BY card_id) r
    JOIN card_kanji_links k ON k.card_id=r.card_id WHERE k.kanji_id IS NOT NULL GROUP BY k.kanji_id";
const KANJI_CARDS: &str = "SELECT k.kanji_id AS id, MIN(c.synced_at) AS t
    FROM anki_cards c JOIN card_kanji_links k ON k.card_id=c.card_id
    WHERE c.interval>=21 AND k.kanji_id IS NOT NULL GROUP BY k.kanji_id";

fn first_dates_query(reviews: &str, cards: &str, select: &str) -> String {
    format!("WITH reviewed AS ({reviews}), synced AS ({cards}), first_dates AS (
        SELECT id,t,1000 AS divisor FROM reviewed UNION ALL
        SELECT id,t,1 FROM synced WHERE NOT EXISTS (SELECT 1 FROM reviewed WHERE reviewed.id=synced.id)
    ) {select}")
}

fn note_word(raw: &str, configured: &str) -> Option<String> {
    // Old caches retained all fields. Their insertion order determines the
    // fallback when the configured field is absent or blank.
    let fields: IndexMap<String, Value> = serde_json::from_str(raw).ok()?;
    fn value(field: &Value) -> Option<&str> {
        let text = field
            .get("value")?
            .as_str()?
            .trim_matches(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c));
        (!text.is_empty()).then_some(text)
    }
    fields
        .get(configured)
        .filter(|_| !configured.is_empty())
        .and_then(value)
        .or_else(|| fields.values().find_map(value))
        .map(str::to_owned)
}

impl Report {
    fn date(&self, raw: ValueRef<'_>, divisor: f64) -> NaiveDate {
        let number = match raw {
            ValueRef::Integer(n) => Some(n as f64),
            ValueRef::Real(n) => Some(n),
            ValueRef::Text(s) | ValueRef::Blob(s) => std::str::from_utf8(s)
                .ok()
                .and_then(|s| s.trim().parse().ok()),
            ValueRef::Null => None,
        };
        number
            .and_then(|n| {
                let seconds = n / divisor;
                // datetime.fromtimestamp rounds fractional seconds to microseconds
                // before converting to the system's local calendar.
                let whole = seconds.floor();
                let micros = ((seconds - whole) * 1_000_000.0).round_ties_even();
                let seconds = if micros == 1_000_000.0 {
                    whole + 1.0
                } else {
                    whole
                };
                #[cfg(windows)]
                if !(0.0..=32_536_799_999.0).contains(&seconds) {
                    // The Windows CRT's _localtime64 range.
                    return None;
                }
                local_date(seconds)
                    .ok()
                    .filter(|d| (1..=9999).contains(&d.year()))
            })
            .unwrap_or(self.today)
    }

    fn words(&self, conn: &Connection, reviews: bool, cards: bool) -> Result<Counts> {
        let mut counts = Counts::new();
        if !table_exists(conn, "anki_notes")? {
            return Ok(counts);
        }
        let merged;
        let review_dates = match (reviews, cards) {
            (true, true) => {
                merged = format!("SELECT id, MIN(t) AS t FROM ({NOTE_REVIEWS} UNION ALL {NOTE_CARD_REVIEWS}) GROUP BY id");
                &merged
            }
            (true, false) => NOTE_REVIEWS,
            _ => EMPTY,
        };
        // The ORM stores note IDs as TEXT. Give the UNION key an explicit
        // affinity even when its review branch is empty, keeping the indexed
        // note column bare for both text and integer primary keys.
        let sql = first_dates_query(review_dates, if cards { NOTE_CARDS } else { EMPTY },
            "SELECT n.fields_json, f.t, f.divisor FROM first_dates f JOIN anki_notes n ON n.note_id=CAST(f.id AS TEXT)");
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query([])?;
        let mut words = HashMap::<String, NaiveDate>::new();
        while let Some(row) = rows.next()? {
            let ValueRef::Text(raw) = row.get_ref(0)? else {
                continue;
            };
            if let Some(word) = note_word(std::str::from_utf8(raw)?, &self.word_field) {
                let date = self.date(row.get_ref(1)?, row.get(2)?);
                let first = words.entry(word).or_insert(date);
                *first = (*first).min(date);
            }
        }
        for day in words.into_values() {
            *counts.entry(day).or_default() += 1;
        }
        Ok(counts)
    }

    fn kanji(&self, conn: &Connection, reviews: bool, cards: bool) -> Result<Counts> {
        let mut counts = Counts::new();
        if table_exists(conn, "card_kanji_links")? {
            let sql = first_dates_query(
                if reviews { KANJI_REVIEWS } else { EMPTY },
                if cards { KANJI_CARDS } else { EMPTY },
                "SELECT t, divisor FROM first_dates",
            );
            let mut stmt = conn.prepare(&sql)?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let date = self.date(row.get_ref(0)?, row.get(1)?);
                *counts.entry(date).or_default() += 1;
            }
        }
        Ok(counts)
    }

    pub(super) fn read(&self, conn: &Connection) -> Result<Value> {
        let reviews = table_exists(conn, "anki_reviews")?;
        let cards = table_exists(conn, "anki_cards")?;
        let words = self.words(conn, reviews, cards)?;
        let kanji = self.kanji(conn, reviews, cards)?;
        if let Some(weeks) = &self.weeks {
            return Ok(
                json!({"mature_words":weeks.bucket(&words)?, "mature_kanji":weeks.bucket(&kanji)?}),
            );
        }
        let start = [words.keys().next(), kanji.keys().next()]
            .into_iter()
            .flatten()
            .min();
        // Each day adds a quoted ISO label and four numbers with delimiters
        // (at least 21 bytes). Decline guaranteed-oversize replies before allocating.
        if start.is_some_and(|day| (self.today - *day).num_days() > 7 * 1024 * 1024 / 21) {
            return Ok(Value::Null);
        }
        let labels: Vec<_> = start
            .into_iter()
            .flat_map(|start| start.iter_days().take_while(|day| day <= &self.today))
            .collect();
        Ok(json!({"labels":labels, "series":{
            "mature_words":daily("Mature Words",&words,&labels),
            "unique_kanji":daily("Unique Kanji",&kanji,&labels)
        }}))
    }
}

#[derive(Serialize)]
struct DailySeries {
    label: &'static str,
    daily_new: Vec<usize>,
    cumulative: Vec<usize>,
    total: usize,
}

fn daily(label: &'static str, counts: &Counts, labels: &[NaiveDate]) -> DailySeries {
    let daily_new: Vec<_> = labels
        .iter()
        .map(|day| counts.get(day).copied().unwrap_or(0))
        .collect();
    let cumulative = daily_new
        .iter()
        .scan(0usize, |total, &n| {
            *total += n;
            Some(*total)
        })
        .collect();
    DailySeries {
        label,
        daily_new,
        cumulative,
        total: counts.values().sum(),
    }
}

impl WeekRange {
    fn bucket(&self, counts: &Counts) -> Result<Vec<usize>> {
        if self.start > self.end || self.start.year() < 1 || self.end.year() > 9999 {
            return Err("Invalid maturity week range".into());
        }
        let offset = i64::from(self.start.weekday().num_days_from_monday());
        let index = |day: NaiveDate| ((offset + (day - self.start).num_days()) / 7) as usize;
        let mut buckets = vec![0; index(self.end) + 1];
        for (&day, &count) in counts.range(self.start..=self.end) {
            buckets[index(day)] += count;
        }
        Ok(buckets)
    }
}
