use crate::{Reply, Reports};
use chrono::{DateTime, NaiveDate, NaiveDateTime};
use gsm_history::ReadingEntry;
use serde::{
    de::{self, IgnoredAny, MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    io::BufRead,
};

struct Turn {
    timestamp: f64,
    characters: i64,
}

impl<'de> Deserialize<'de> for Turn {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Fields;
        impl<'de> Visitor<'de> for Fields {
            type Value = Turn;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a Mokuro page turn")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Turn, A::Error> {
                let timestamp = seq
                    .next_element()?
                    .ok_or_else(|| de::Error::custom("Missing page turn timestamp"))?;
                let _ = seq.next_element::<IgnoredAny>()?;
                let characters = seq.next_element()?.unwrap_or(0);
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Turn {
                    timestamp,
                    characters,
                })
            }
        }
        deserializer.deserialize_seq(Fields)
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Volume {
    #[serde(rename = "deletedOn")]
    deleted: Option<Value>,
    series_title: Option<String>,
    volume_title: Option<String>,
    chars: Option<i64>,
    #[serde(rename = "timeReadInMinutes")]
    minutes: Option<f64>,
    #[serde(rename = "addedOn")]
    added: Option<String>,
    #[serde(rename = "lastProgressUpdate")]
    updated: Option<String>,
    #[serde(rename = "recentPageTurns")]
    turns: Option<Vec<Turn>>,
}

// Mokuro stores its metadata dates in local or offset form. Its page-turn
// timestamps are UTC milliseconds. Preserve the written calendar day for metadata.
fn metadata_date(s: Option<&str>) -> Option<NaiveDate> {
    let s = s?;
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .or_else(|| DateTime::parse_from_rfc3339(s).ok().map(|t| t.date_naive()))
        .or_else(|| s.parse::<NaiveDateTime>().ok().map(|t| t.date()))
        .or_else(|| {
            NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f")
                .ok()
                .map(|t| t.date())
        })
}

fn turn_date(ts: f64) -> Result<NaiveDate, &'static str> {
    let micros = (ts * 1000.).round_ties_even();
    if !micros.is_finite() || micros.abs() >= i64::MAX as f64 {
        return Err("Invalid page turn timestamp");
    }
    DateTime::from_timestamp_micros(micros as i64)
        .map(|d| d.date_naive())
        .ok_or("Invalid page turn timestamp")
}

fn tenth(value: f64) -> f64 {
    // One decimal place with Python round's ties-to-even behavior.
    format!("{value:.1}").parse().unwrap_or(value)
}

impl Volume {
    fn append(self, rows: &mut Vec<ReadingEntry>) -> Result<(), &'static str> {
        if self.deleted.as_ref().is_some_and(|v| match v {
            Value::String(s) => !s.is_empty(),
            Value::Number(n) => n.as_f64() != Some(0.),
            Value::Bool(b) => *b,
            _ => false,
        }) {
            return Ok(());
        }
        let series = self.series_title.unwrap_or_default();
        let volume = self.volume_title.unwrap_or_default();
        let chars = self.chars.unwrap_or(0);
        let seconds = self.minutes.unwrap_or(0.) * 60.;
        if !seconds.is_finite() {
            return Err("Invalid reading duration");
        }
        if (series.is_empty() && volume.is_empty()) || (chars == 0 && seconds == 0.) {
            return Ok(());
        }
        let label = match (series.is_empty(), volume.is_empty()) {
            (true, _) => volume,
            (_, true) => series,
            _ => format!("{series} - {volume}"),
        };
        let mut append = |day: NaiveDate, characters, seconds| {
            if characters > 0 || seconds > 0. {
                rows.push(ReadingEntry {
                    date: day.to_string(),
                    characters,
                    seconds,
                    source: "mokuro".into(),
                    label: label.clone(),
                });
            }
        };
        let mut turns = self.turns.unwrap_or_default();
        if turns.is_empty() {
            if let Some(day) = metadata_date(self.updated.as_deref())
                .or_else(|| metadata_date(self.added.as_deref()))
            {
                append(day, chars, seconds);
            }
            return Ok(());
        }
        turns.sort_by(|a, b| a.timestamp.total_cmp(&b.timestamp));
        let first = &turns[0];
        let mut high = first.characters;
        let mut days = BTreeMap::<NaiveDate, i64>::new();
        if high > 0 {
            let day = match metadata_date(self.added.as_deref()) {
                Some(day) => day,
                None => turn_date(first.timestamp)?,
            };
            days.insert(day, high);
        }
        for turn in &turns[1..] {
            if turn.characters > high {
                let delta = turn
                    .characters
                    .checked_sub(high)
                    .ok_or("Character count is too large")?;
                let day = days.entry(turn_date(turn.timestamp)?).or_default();
                *day = day
                    .checked_add(delta)
                    .ok_or("Character count is too large")?;
                high = turn.characters;
            }
        }
        let counted: i128 = days.values().map(|v| i128::from(*v)).sum();
        if counted == 0 {
            append(turn_date(first.timestamp)?, 0, seconds);
        } else {
            for (day, num) in days {
                append(day, num, tenth(seconds * (num as f64 / counted as f64)));
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct Import {
    volumes: usize,
    entries: Vec<ReadingEntry>,
}
struct Volumes;
impl<'de> Visitor<'de> for Volumes {
    type Value = Import;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON object with volume UUIDs as keys")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut data = Import::default();
        while map.next_key::<IgnoredAny>()?.is_some() {
            map.next_value::<Volume>()?
                .append(&mut data.entries)
                .map_err(de::Error::custom)?;
            data.volumes += 1;
        }
        Ok(data)
    }
}

impl Reports {
    pub fn import_mokuro(&self, generation: u64, mut file: impl BufRead, clear: bool) -> Reply {
        match file.fill_buf() {
            Ok(bytes) if bytes.starts_with(&[0xef, 0xbb, 0xbf]) => file.consume(3),
            Err(e) => return Reply::error(500, &e.to_string()),
            _ => {}
        }
        let mut de = serde_json::Deserializer::from_reader(file);
        let data = match (&mut de)
            .deserialize_any(Volumes)
            .and_then(|v| de.end().map(|()| v))
        {
            Ok(data) => data,
            Err(e) => {
                let error = e.to_string();
                return if error.contains("expected a JSON object with volume UUIDs as keys") {
                    Reply::error(400, "Expected a JSON object with volume UUIDs as keys")
                } else {
                    Reply::error(400, &format!("Invalid JSON file: {e}"))
                };
            }
        };
        let count = data.entries.len();
        let mut body = if count == 0 {
            json!({"message":"No valid reading data found in the file"})
        } else {
            let mut labels = BTreeSet::new();
            let (mut first, mut last) =
                (data.entries[0].date.as_str(), data.entries[0].date.as_str());
            let (mut chars, mut time) = (0_i128, 0.);
            for row in &data.entries {
                labels.insert(&row.label);
                first = first.min(&row.date);
                last = last.max(&row.date);
                chars += i128::from(row.characters);
                time += row.seconds;
            }
            let chars = i64::try_from(chars)
                .map(Value::from)
                .unwrap_or_else(|_| json!(chars as f64));
            json!({"message":format!("Successfully imported {count} daily entries from {} volumes",labels.len()),"volumes_with_data":labels.len(),
                "total_characters":chars,"total_time_minutes":tenth(time/60.),"date_range":{"min":first,"max":last},"volumes":labels})
        };
        let cleared = match self.history.import_reading_at(
            &self.database,
            generation,
            clear.then_some("mokuro"),
            &data.entries,
        ) {
            Ok(value) => value,
            Err(e) => return Reply::error(500, &format!("Import failed: {e}")),
        };
        body["cleared_count"] = cleared.into();
        body["imported_count"] = count.into();
        body["volumes_processed"] = data.volumes.into();
        Reply { status: 200, body }
    }
}
