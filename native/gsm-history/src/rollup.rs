//! Daily and per-game rollups from one SQLite snapshot. Keep numeric timing
//! samples for the adaptive pace calculation, and release each dialogue string
//! as soon as its characters and kanji have been counted.
use crate::{
    kanji::is_kanji,
    sessions::{reading_breaks, reading_seconds, visit_normalized, PunctuationRegex},
    stats::table_exists,
    Result,
};
use chrono::{DateTime, Local, NaiveDate, NaiveTime, Timelike};
use flate2::read::ZlibDecoder;
use indexmap::IndexMap;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{de::IgnoredAny, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    cmp::Reverse,
    io::BufReader,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Default, Deserialize)]
#[serde(from = "String")]
enum Punctuation {
    #[default]
    Default,
    Custom(Arc<PunctuationRegex>),
    Unsupported,
}

impl From<String> for Punctuation {
    fn from(pattern: String) -> Self {
        match crate::ReportCleaner::compile(&pattern, false) {
            Some(cleaner) => cleaner.extra.map_or(Self::Default, Self::Custom),
            None => Self::Unsupported,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Day {
    date: NaiveDate,
    today: NaiveDate,
    start: f64,
    end: f64,
    session_gap: f64,
    tokenized: bool,
    #[serde(default)]
    reduce_repetitions: bool,
    #[serde(default)]
    extra_punctuation: Punctuation,
}

fn dates(conn: &Connection) -> Result<Vec<NaiveDate>> {
    let mut sql = String::from(
        "SELECT DISTINCT date(timestamp,'unixepoch','localtime') AS date FROM game_lines",
    );
    if table_exists(conn, "archived_game_days")? {
        sql.push_str(" UNION SELECT date FROM archived_game_days");
    }
    sql.push_str(" ORDER BY date");
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    let mut dates = Vec::new();
    while let Some(row) = rows.next()? {
        if let Some(date) = row.get::<_, Option<String>>(0)? {
            dates.push(date.parse()?);
        }
    }
    Ok(dates)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rebuild {
    generation: u64,
    today: NaiveDate,
    session_gap: f64,
    tokenized: bool,
    #[serde(default)]
    reduce_repetitions: bool,
    #[serde(default)]
    extra_punctuation: Punctuation,
}

fn midnight(date: NaiveDate) -> Result<f64> {
    local_timestamp(date.and_time(NaiveTime::MIN))
}

pub(crate) use gsm_db::local_timestamp;

pub(super) fn replace_dates(
    tx: &rusqlite::Transaction<'_>,
    dates: impl IntoIterator<Item = NaiveDate>,
    cleaner: &crate::ReportCleaner,
    gap: f64,
    tokenized: bool,
) -> Result<()> {
    let today = Local::now().date_naive();
    for date in dates {
        let day = Day {
            date,
            today,
            start: midnight(date)?,
            end: midnight(date.succ_opt().ok_or("Invalid rollup date")?)?,
            session_gap: gap,
            tokenized,
            reduce_repetitions: cleaner.repeat,
            extra_punctuation: cleaner.extra.clone().map_or(Punctuation::Default, Punctuation::Custom),
        };
        day.replace_in(tx)?;
    }
    Ok(())
}

impl crate::History {
    /// A changed reading day and its source rows become visible to other
    /// connections together. A failed regex or write rolls back every change.
    pub fn remove_lines(
        &self,
        path: &std::path::Path,
        removal: crate::reports::LineRemoval,
        cleaner: &crate::ReportCleaner,
        gap: f64,
        tokenized: bool,
    ) -> Result<Option<crate::reports::RemovalSummary>> {
        self.with_writer(path, |conn| {
            let mut tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let Some(deleted) = removal.apply(&mut tx)? else {
                return Ok(None);
            };
            replace_dates(&tx, deleted.dates, cleaner, gap, tokenized)?;
            tx.commit()?;
            Ok(Some(crate::reports::RemovalSummary {
                deleted_count: deleted.count,
                failed_ids: deleted.failed_ids,
            }))
        })
    }
    /// A false result leaves the deadline intact for a compatibility worker.
    /// Each day commits independently and checks the restore generation.
    pub fn try_scheduled_rollup(
        &self,
        path: &std::path::Path,
        generation: u64,
        job: &crate::schedule::Job,
        stats: &Value,
        tokenized: bool,
    ) -> Result<bool> {
        if !self.scheduled_job_current(path, generation, job)? {
            return Ok(true);
        }
        let reduce_repetitions = stats["regex_out_repetitions"] == true;
        let cleaner = crate::ReportCleaner::from_saved(
            stats["extra_punctuation_regex"].as_str().unwrap_or(""),
            reduce_repetitions,
        );
        let result = Rebuild {
            generation,
            today: Local::now().date_naive(),
            session_gap: stats["session_gap_seconds"].as_f64().unwrap_or(1800.0),
            tokenized,
            reduce_repetitions,
            extra_punctuation: cleaner
                .extra
                .map_or(Punctuation::Default, Punctuation::Custom),
        }
        .run(self, path)?;
        if result["fallback_dates"]
            .as_array()
            .is_some_and(|days| !days.is_empty())
        {
            return Ok(false);
        }
        self.finish_scheduled_job(path, generation, job, None)?;
        Ok(true)
    }
}

impl Rebuild {
    pub(super) fn run(self, history: &crate::History, path: &std::path::Path) -> Result<Value> {
        let start = std::time::Instant::now();
        let generation = Some(self.generation);
        let dates = history.with_writer_generation(path, generation, |conn| {
            let tx = conn.transaction()?;
            dates(&tx)
        })?;
        let first = dates.first().copied();
        let mut processed = 0;
        let mut overwritten = 0;
        let mut errors = 0;
        let mut fallback = Vec::new();
        let past = dates.partition_point(|date| *date < self.today);
        for &date in &dates[..past] {
            // Release the shared writer after every day. Close or restore
            // invalidates this generation before it can reopen another file.
            let outcome = history.with_writer_generation(path, generation, |conn| {
                let day = Day {
                    date,
                    today: self.today,
                    start: midnight(date)?,
                    end: midnight(date.succ_opt().ok_or("Invalid rollup date")?)?,
                    session_gap: self.session_gap,
                    tokenized: self.tokenized,
                    reduce_repetitions: self.reduce_repetitions,
                    extra_punctuation: self.extra_punctuation.clone(),
                };
                Ok(allow_regex_fallback(day.replace(conn)))
            })?;
            match outcome {
                Ok(Value::Null) => fallback.push(date),
                Ok(done) => {
                    processed += usize::from(done["created"] == true);
                    overwritten += usize::from(done["updated"] == true);
                }
                Err(error) => {
                    errors += 1;
                    eprintln!("[daily-rollup] {date}: {error}");
                }
            }
        }
        Ok(
            json!({"success":true,"start_date":first,"end_date":first.and(self.today.pred_opt()),
            "total_dates":past,"processed":processed,"overwritten":overwritten,"errors":errors,
            "elapsed_time":start.elapsed().as_secs_f64(),"error_message":null,"fallback_dates":fallback}),
        )
    }
}

/// The Python regex engine can finish expressions that exceed the native
/// backtracking limit. A failed replacement has already rolled back its writer.
pub(super) fn allow_regex_fallback(result: Result<Value>) -> Result<Value> {
    match result {
        Err(error) if error.is::<fancy_regex::Error>() => Ok(Value::Null),
        other => other,
    }
}

#[derive(Clone, Copy)]
struct Sample {
    time: f64,
    chars: usize,
}

fn duration(lines: &[Sample], breaks: &[f64]) -> f64 {
    reading_seconds(
        lines.windows(2).map(|p| (p[0].time, p[1].time, p[0].chars)),
        breaks,
    )
}

fn active_time(lines: &[Sample], gap: f64, breaks: &[f64]) -> f64 {
    lines
        .chunk_by(|a, b| b.time - a.time <= gap)
        .map(|part| duration(part, breaks))
        .sum()
}

#[derive(Default, Serialize)]
struct Totals {
    chars: usize,
    time: f64,
    cards: usize,
}

impl Totals {
    fn add(&mut self, other: &Self) {
        self.chars += other.chars;
        self.time += other.time;
        self.cards += other.cards;
    }
}

#[derive(Default)]
struct Game {
    scene: String,
    samples: Vec<Sample>,
    cards: usize,
}

type Frequencies = IndexMap<String, u64>;

fn add_count(counts: &mut Frequencies, key: &str, n: u64) {
    if let Some(old) = counts.get_mut(key) {
        *old += n;
    } else {
        counts.insert(key.to_owned(), n);
    }
}

#[derive(Default)]
struct Activity {
    lines: Vec<Sample>,
    hours: [Vec<Sample>; 24],
    games: IndexMap<String, Game>,
    kanji: Frequencies,
    cards: usize,
    screenshots: usize,
    audio: usize,
    translations: usize,
}

impl Activity {
    fn add(
        &mut self,
        sample: Sample,
        cards: usize,
        flags: u8,
        id: &str,
        scene: &str,
    ) -> Result<()> {
        let hour = DateTime::from_timestamp(sample.time.floor() as i64, 0)
            .ok_or("Invalid rollup timestamp")?
            .with_timezone(&Local)
            .hour();
        self.lines.push(sample);
        self.hours[hour as usize].push(sample);
        self.cards += cards;
        self.screenshots += usize::from(flags & 1 != 0);
        self.audio += usize::from(flags & 2 != 0);
        self.translations += usize::from(flags & 4 != 0);
        if !id.trim().is_empty() {
            let game = match self.games.get_mut(id) {
                Some(game) => game,
                None => self.games.entry(id.to_owned()).or_default(),
            };
            if game.scene.is_empty() {
                game.scene.push_str(scene);
            }
            game.cards += cards;
            game.samples.push(sample);
        }
        Ok(())
    }
}

fn text_column<'a>(row: &'a rusqlite::Row<'_>, index: usize) -> rusqlite::Result<&'a str> {
    Ok(row.get_ref(index)?.as_str_or_null()?.unwrap_or(""))
}

pub(super) fn count_cards(notes: &str, flags: u8) -> Result<usize> {
    let fallback = usize::from(flags & 3 != 0);
    if matches!(notes.trim(), "" | "[]" | "null") {
        return Ok(fallback);
    }
    let count = match serde_json::from_str::<Value>(notes) {
        Ok(Value::Array(ids)) => ids.len(),
        Ok(Value::Object(ids)) => ids.len(),
        Ok(Value::String(ids)) => ids.chars().count(),
        Ok(Value::Number(n)) if n.as_f64() != Some(0.0) => {
            return Err("Invalid note ID collection".into())
        }
        Ok(Value::Bool(true)) => return Err("Invalid note ID collection".into()),
        _ => 0,
    };
    Ok(if count == 0 { fallback } else { count })
}

#[derive(Deserialize)]
struct ArchiveEvent(f64, usize, usize, u8, IgnoredAny, ArchiveToken, IgnoredAny);

#[derive(Deserialize)]
#[serde(untagged)]
enum ArchiveToken {
    Number(u8),
    Bool(bool),
    Null,
}

impl ArchiveToken {
    fn complete(&self) -> bool {
        matches!(self, Self::Bool(true) | Self::Number(1..))
    }
}

struct ArchiveGame {
    id: String,
    name: String,
    kanji: Frequencies,
    token_kanji: Frequencies,
}
struct Archived {
    event: ArchiveEvent,
    game: usize,
    first: bool,
}

impl Day {
    fn archives(&self, conn: &Connection) -> Result<(Vec<ArchiveGame>, Vec<Archived>)> {
        let mut games = Vec::new();
        let mut lines = Vec::new();
        if table_exists(conn, "archived_game_days")? {
            let mut query = conn.prepare("SELECT game_id,game_name,events,kanji,token_kanji FROM archived_game_days WHERE date=? ORDER BY game_id")?;
            let mut rows = query.query([self.date.to_string()])?;
            while let Some(row) = rows.next()? {
                let blob = row.get_ref(2)?.as_blob()?;
                let events: Vec<ArchiveEvent> =
                    serde_json::from_reader(BufReader::new(ZlibDecoder::new(blob)))?;
                for (n, event) in events
                    .into_iter()
                    .filter(|e| e.0 >= self.start && e.0 <= self.end - 0.000001)
                    .enumerate()
                {
                    lines.push(Archived {
                        event,
                        game: games.len(),
                        first: n == 0,
                    });
                }
                games.push(ArchiveGame {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    kanji: serde_json::from_str(text_column(row, 3)?)?,
                    token_kanji: serde_json::from_str(text_column(row, 4)?)?,
                });
            }
            lines.sort_by(|a, b| a.event.0.total_cmp(&b.event.0));
        }
        Ok((games, lines))
    }

    fn activity(&self, conn: &Connection) -> Result<(Activity, Frequencies)> {
        let punctuation = match &self.extra_punctuation {
            Punctuation::Custom(regex) => Some(regex.as_ref()),
            Punctuation::Default => None,
            Punctuation::Unsupported => return Err("Unsupported punctuation rule".into()),
        };
        let mut day = Activity::default();
        let (archives, events) = self.archives(conn)?;
        let mut select = conn.prepare_cached("SELECT CAST(timestamp AS REAL),line_text,game_id,game_name,note_ids,screenshot_in_anki,audio_in_anki,translation
            FROM game_lines WHERE timestamp BETWEEN ? AND ? ORDER BY CAST(timestamp AS REAL),timestamp")?;
        let mut rows = select.query(params![self.start, self.end - 0.000001])?;
        let mut live = rows.next()?;
        if live.is_none() && events.is_empty() {
            return Ok((day, Frequencies::new()));
        }
        let live_indexed = self.tokenized && !conn.prepare_cached(
            "SELECT 1 FROM game_lines WHERE timestamp>=? AND timestamp<? AND tokenized=0 LIMIT 1"
        )?.exists(params![self.start,self.end])?;
        let indexed_kanji = live_indexed && events.iter().all(|e| e.event.5.complete());
        let add_archive = |day: &mut Activity, line: &Archived| -> Result<()> {
            let game = &archives[line.game];
            if !indexed_kanji && line.first {
                for (key, &count) in &game.kanji {
                    add_count(&mut day.kanji, key, count);
                }
            }
            let ArchiveEvent(time, chars, cards, flags, ..) = line.event;
            day.add(Sample { time, chars }, cards, flags, &game.id, &game.name)
        };
        let mut archived = events.iter().peekable();
        let mut utf8 = [0; 4];
        while let Some(row) = live {
            let time = row.get(0)?;
            // Live lines precede archived ones on timestamp ties, as in the
            // stable merge used when a game is archived from the stats screen.
            while archived.peek().is_some_and(|l| l.event.0 < time) {
                if let Some(line) = archived.next() {
                    add_archive(&mut day, line)?;
                }
            }
            let chars = visit_normalized(
                text_column(row, 1)?,
                punctuation,
                self.reduce_repetitions,
                |normalized| {
                    if !indexed_kanji {
                        for c in normalized.chars().filter(is_kanji) {
                            add_count(&mut day.kanji, c.encode_utf8(&mut utf8), 1);
                        }
                    }
                    normalized.chars().count()
                },
            )?;
            let mut flags = 0;
            for n in 0..3 {
                if !text_column(row, n + 5)?
                    .trim_matches(python_space)
                    .is_empty()
                {
                    flags |= 1 << n;
                }
            }
            day.add(
                Sample { time, chars },
                count_cards(text_column(row, 4)?, flags)?,
                flags,
                text_column(row, 2)?,
                text_column(row, 3)?,
            )?;
            live = rows.next()?;
        }
        for line in archived {
            add_archive(&mut day, line)?;
        }
        if day.lines.is_empty() {
            return Ok((day, Frequencies::new()));
        }
        if indexed_kanji {
            self.index_counts(conn,"SELECT k.character,COUNT(*) AS freq FROM kanji_occurrences ko JOIN kanji k ON k.id=ko.kanji_id JOIN game_lines gl ON gl.id=ko.line_id
                WHERE gl.timestamp>=? AND gl.timestamp<? GROUP BY k.character ORDER BY freq DESC",&mut day.kanji)?;
            for game in &archives {
                for (key, &n) in &game.token_kanji {
                    add_count(&mut day.kanji, key, n);
                }
            }
        } else {
            day.kanji.sort_by_cached_key(|_, n| Reverse(*n));
        }
        let mut words = Frequencies::new();
        if live_indexed {
            self.index_counts(conn, "SELECT w.word,COUNT(*) AS freq FROM word_occurrences wo JOIN words w ON w.id=wo.word_id JOIN game_lines gl ON gl.id=wo.line_id
                WHERE gl.timestamp>=? AND gl.timestamp<? AND w.pos NOT IN ('記号','その他') GROUP BY w.word ORDER BY freq DESC",&mut words)?;
        }
        if (self.tokenized
            || table_exists(conn, "archived_game_days")?
                && conn
                    .prepare("SELECT 1 FROM archived_game_days LIMIT 1")?
                    .exists([])?)
            && table_exists(conn, "archived_word_stats")?
        {
            let mut stmt = conn.prepare("SELECT word,SUM(frequency) FROM archived_word_stats WHERE date=? AND pos NOT IN ('記号','その他') GROUP BY word")?;
            let mut rows = stmt.query([self.date.to_string()])?;
            while let Some(row) = rows.next()? {
                add_count(&mut words, text_column(row, 0)?, row.get(1)?);
            }
        }
        Ok((day, words))
    }

    fn index_counts(&self, conn: &Connection, sql: &str, counts: &mut Frequencies) -> Result<()> {
        let mut stmt = conn.prepare_cached(sql)?;
        let mut rows = stmt.query(params![self.start, self.end])?;
        while let Some(row) = rows.next()? {
            add_count(counts, text_column(row, 0)?, row.get(1)?);
        }
        Ok(())
    }
}

pub(super) fn python_space(c: char) -> bool {
    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
}

#[derive(Serialize)]
struct Detail {
    title: String,
    #[serde(flatten)]
    totals: Totals,
    lines: usize,
}

#[derive(Serialize)]
struct Daily {
    date: NaiveDate,
    total_lines: usize,
    total_characters: usize,
    total_sessions: usize,
    unique_games_played: usize,
    total_reading_time_seconds: f64,
    total_active_time_seconds: f64,
    longest_session_seconds: f64,
    shortest_session_seconds: f64,
    average_session_seconds: f64,
    average_reading_speed_chars_per_hour: f64,
    peak_reading_speed_chars_per_hour: u64,
    games_completed: usize,
    games_started: usize,
    anki_cards_created: usize,
    lines_with_screenshots: usize,
    lines_with_audio: usize,
    lines_with_translations: usize,
    unique_kanji_seen: usize,
    kanji_frequency_data: String,
    hourly_activity_data: String,
    hourly_reading_speed_data: String,
    game_activity_data: String,
    games_played_ids: String,
    max_chars_in_session: usize,
    max_time_in_session_seconds: f64,
    unique_words_seen: usize,
    word_frequency_data: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    genre_activity_data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    type_activity_data: Option<String>,
}

#[derive(Serialize)]
struct Computed {
    #[serde(flatten)]
    fields: Daily,
    #[serde(rename = "per_game_daily_rollups")]
    games: IndexMap<String, Detail>,
}

impl Day {
    fn compute(&self, conn: &Connection) -> Result<Computed> {
        let (day, words) = self.activity(conn)?;
        let breaks = reading_breaks(conn, self.start, self.end)?;
        let total_chars: usize = day.lines.iter().map(|p| p.chars).sum();
        let mut sessions = 0usize;
        let (mut time, mut longest, mut shortest, mut max_chars) = (0.0, 0.0_f64, 0.0_f64, 0usize);
        for span in day
            .lines
            .chunk_by(|a, b| b.time - a.time <= self.session_gap)
        {
            sessions += 1;
            let seconds = duration(span, &breaks);
            time += seconds;
            longest = longest.max(seconds);
            if seconds > 0.0 && (shortest == 0.0 || seconds < shortest) {
                shortest = seconds;
            }
            max_chars = max_chars.max(span.iter().map(|l| l.chars).sum());
        }

        let mut hourly_chars = IndexMap::new();
        let mut hourly_speeds = IndexMap::new();
        for (hour, samples) in day.hours.iter().enumerate() {
            let chars: usize = samples.iter().map(|l| l.chars).sum();
            if chars > 0 {
                hourly_chars.insert(hour, chars);
                let seconds = active_time(samples, self.session_gap, &breaks);
                if seconds > 0.0 {
                    let speed = (chars as f64 / (seconds / 3600.0)) as u64;
                    if speed > 0 {
                        hourly_speeds.insert(hour, speed);
                    }
                }
            }
        }

        let mut details = IndexMap::new();
        let mut genres = IndexMap::<String, Totals>::new();
        let mut types = IndexMap::<String, Totals>::new();
        let mut game_metadata =
            conn.prepare_cached("SELECT title_original,genres,type FROM games WHERE id=?")?;
        for (id, game) in day.games {
            let mut rows = game_metadata.query([&id])?;
            let metadata = rows.next()?;
            let totals = Totals {
                chars: game.samples.iter().map(|s| s.chars).sum(),
                time: active_time(&game.samples, self.session_gap, &breaks),
                cards: game.cards,
            };
            let mut title = game.scene;
            if let Some(row) = metadata {
                let original = text_column(row, 0)?;
                if !original.is_empty() {
                    title = original.to_owned();
                }
                let raw = text_column(row, 1)?;
                let mut value: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
                if let Value::String(inner) = value {
                    value = serde_json::from_str(&inner).unwrap_or(Value::Null);
                }
                if let Value::Array(names) = value {
                    for name in names.into_iter().filter_map(|v| match v {
                        Value::String(s) if !s.is_empty() => Some(s),
                        _ => None,
                    }) {
                        genres.entry(name).or_default().add(&totals);
                    }
                }
                let kind = text_column(row, 2)?;
                if !kind.is_empty() {
                    types
                        .entry(kind.trim_matches(python_space).to_owned())
                        .or_default()
                        .add(&totals);
                }
            }
            if title.is_empty() {
                title = format!("Game {}", id.chars().take(8).collect::<String>());
            }
            details.insert(
                id,
                Detail {
                    title,
                    totals,
                    lines: game.samples.len(),
                },
            );
        }

        let fields = Daily {
            date: self.date,
            total_lines: day.lines.len(),
            total_characters: total_chars,
            total_sessions: sessions,
            unique_games_played: details.len(),
            total_reading_time_seconds: time,
            total_active_time_seconds: time,
            longest_session_seconds: longest,
            shortest_session_seconds: shortest,
            average_session_seconds: if sessions > 0 {
                time / sessions as f64
            } else {
                0.0
            },
            average_reading_speed_chars_per_hour: if time > 0.0 {
                total_chars as f64 / (time / 3600.0)
            } else {
                0.0
            },
            peak_reading_speed_chars_per_hour: hourly_speeds.values().copied().max().unwrap_or(0),
            games_completed: 0,
            games_started: details.len(),
            anki_cards_created: day.cards,
            lines_with_screenshots: day.screenshots,
            lines_with_audio: day.audio,
            lines_with_translations: day.translations,
            unique_kanji_seen: day.kanji.len(),
            kanji_frequency_data: serde_json::to_string(&day.kanji)?,
            hourly_activity_data: serde_json::to_string(&hourly_chars)?,
            hourly_reading_speed_data: serde_json::to_string(&hourly_speeds)?,
            game_activity_data: serde_json::to_string(&details)?,
            games_played_ids: serde_json::to_string(&details.keys().collect::<Vec<_>>())?,
            max_chars_in_session: max_chars,
            max_time_in_session_seconds: longest,
            unique_words_seen: words.len(),
            word_frequency_data: serde_json::to_string(&words)?,
            genre_activity_data: (sessions > 0)
                .then(|| serde_json::to_string(&genres))
                .transpose()?,
            type_activity_data: (sessions > 0)
                .then(|| serde_json::to_string(&types))
                .transpose()?,
        };
        Ok(Computed {
            fields,
            games: details,
        })
    }

    pub(super) fn calculate(&self, conn: &Connection) -> Result<Value> {
        if matches!(self.extra_punctuation, Punctuation::Unsupported) {
            return Ok(Value::Null);
        }
        Ok(serde_json::to_value(self.compute(conn)?)?)
    }

    pub(super) fn replace(&self, conn: &mut Connection) -> Result<Value> {
        if matches!(self.extra_punctuation, Punctuation::Unsupported) {
            return Ok(Value::Null);
        }
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = self.replace_in(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    fn replace_in(&self, tx: &rusqlite::Transaction<'_>) -> Result<Value> {
        let date = self.date.to_string();
        let existing: Option<i64> = tx
            .query_row(
                "SELECT id FROM daily_stats_rollup WHERE date=? LIMIT 1",
                [&date],
                |row| row.get(0),
            )
            .optional()?;
        let mut result = json!({"date":date,"created":false,"updated":false,"deleted":false});
        tx.execute("DELETE FROM game_daily_rollup WHERE date=?", [&date])?;
        if self.date >= self.today {
            result["skipped_current_or_future_date"] = Value::Bool(true);
        } else {
            let day = self.compute(&tx)?;
            if day.fields.total_lines > 0 {
                let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64();
                let mut per_game = tx.prepare_cached("INSERT INTO game_daily_rollup(date,game_id,total_characters,total_lines,total_cards_mined,total_reading_time_seconds,created_at,updated_at)
                    VALUES(?1,?2,?3,?4,?5,?6,?7,?7)")?;
                for (id, game) in &day.games {
                    per_game.execute(params![
                        date,
                        id,
                        game.totals.chars,
                        game.lines,
                        game.totals.cards,
                        game.totals.time,
                        now
                    ])?;
                }
                drop(per_game);
                day.persist(&tx, existing, now)?;
                result[if existing.is_some() {
                    "updated"
                } else {
                    "created"
                }] = Value::Bool(true);
                return Ok(result);
            }
        }
        if existing.is_some() {
            tx.execute("DELETE FROM daily_stats_rollup WHERE date=?", [&date])?;
            result["deleted"] = Value::Bool(true);
        }
        Ok(result)
    }
}

impl Computed {
    fn persist(self, conn: &Connection, existing: Option<i64>, now: f64) -> Result<()> {
        use rusqlite::types::Value as Sql;
        // Column names come solely from Daily. Preserve the row ID and
        // creation time when rebuilding an existing historical day.
        let Value::Object(mut fields) = serde_json::to_value(self.fields)? else {
            return Err("Invalid daily statistics record".into());
        };
        fields.insert("updated_at".into(), json!(now));
        if existing.is_none() {
            fields.insert("created_at".into(), json!(now));
        }
        let columns = fields
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join(",");
        let parameters = vec!["?"; fields.len()].join(",");
        let sql = if existing.is_some() {
            format!("UPDATE daily_stats_rollup SET ({columns})=({parameters}) WHERE id=?")
        } else {
            format!("INSERT INTO daily_stats_rollup({columns}) VALUES({parameters})")
        };
        let mut values = Vec::with_capacity(fields.len() + 1);
        for (_, value) in fields {
            values.push(match value {
                Value::String(s) => Sql::Text(s),
                Value::Number(n) => match n.as_i64() {
                    Some(i) => Sql::Integer(i),
                    None => Sql::Real(n.as_f64().ok_or("Invalid rollup number")?),
                },
                _ => return Err("Invalid rollup column type".into()),
            });
        }
        if let Some(id) = existing {
            values.push(Sql::Integer(id));
        }
        conn.prepare_cached(&sql)?
            .execute(rusqlite::params_from_iter(values))?;
        Ok(())
    }
}
