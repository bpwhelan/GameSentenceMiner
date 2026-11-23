//! Today's reading sessions. Timestamps and counts are sufficient for the
//! adaptive pace estimate, including days where the source text was archived.
use crate::{
    stats::{archive_events, table_exists},
    Result,
};
use regex::Regex;
use rusqlite::{params, Connection};
use serde::Serialize;
#[path = "sessions_fuzzy.rs"]
mod fuzzy;
use std::{
    borrow::Cow,
    collections::HashMap,
    sync::{Arc, LazyLock},
};
#[cfg(test)]
#[path = "sessions_cleaner_tests.rs"]
mod cleaner_tests;

/// Compiled once per settings revision. The accepted punctuation expressions
/// have the same matching and replacement semantics in Python and Rust.
#[derive(Clone, Default)]
pub struct ReportCleaner {
    pub(super) extra: Option<Arc<PunctuationRegex>>,
    pub(super) repeat: bool,
}

pub(super) enum PunctuationRegex {
    Regular(Regex),
    Backtracking(fancy_regex::Regex),
    Perl(pcre2::bytes::Regex),
    Fuzzy(fuzzy::Rule),
}

impl PunctuationRegex {
    pub(super) fn compile(pattern: &str) -> Option<Self> {
        if pattern.trim().is_empty() {
            return None;
        }
        let v1 = pattern.strip_prefix("(?V1)");
        let pattern = v1.unwrap_or_else(||pattern.strip_prefix("(?V0)").unwrap_or(pattern));
        if let Some(adapted) = fuzzy::adapt(pattern) {
            if let Some(literal) = fuzzy::one_edit_literal(pattern) {
                let combined = format!("(?:{literal})|{PUNCTUATION_PATTERN}");
                if let Ok(regex) = Self::perl(&combined) {
                    return Some(Self::Perl(regex));
                }
            }
            return fuzzy::Rule::compile(adapted).map(Self::Fuzzy);
        }
        let combined = format!("(?:{pattern})|{PUNCTUATION_PATTERN}");
        if v1.is_some() || PORTABLE.is_match(pattern) {
            return Regex::new(&combined).map(Self::Regular)
                .or_else(|_| fancy_regex::Regex::new(&combined).map(Self::Backtracking)).ok();
        }
        // Python's version-0 character classes treat && and -- literally.
        // Empty substitutions remove no bytes. NOTEMPTY still tries the next
        // alternative at the same offset, as regex.sub does after an empty match.
        Self::perl(&combined).map(Self::Perl)
            .or_else(|_|fancy_regex::Regex::new(&combined).map(Self::Backtracking)).ok()
    }

    fn perl(pattern: &str) -> std::result::Result<pcre2::bytes::Regex, pcre2::Error> {
        pcre2::bytes::RegexBuilder::new().utf(true).ucp(true).jit_if_available(true)
            .build(&format!("(*NOTEMPTY){pattern}"))
    }

    pub(super) fn strip<'a>(&self, text: &'a str) -> Result<Cow<'a, str>> {
        Ok(match self {
            Self::Regular(regex) => regex.replace_all(text, ""),
            Self::Backtracking(regex) => regex.try_replacen(text, 0, "")?,
            Self::Fuzzy(rule) => rule.strip(text)?,
            Self::Perl(regex) => {
                let mut matches = regex.find_iter(text.as_bytes());
                let Some(first) = matches.next().transpose()? else { return Ok(Cow::Borrowed(text)) };
                let mut result = String::with_capacity(text.len());
                let mut offset = 0;
                for found in std::iter::once(Ok(first)).chain(matches) {
                    let found = found?;
                    result.push_str(text.get(offset..found.start()).ok_or("Punctuation split a Unicode character")?);
                    offset = found.end();
                }
                result.push_str(text.get(offset..).ok_or("Punctuation split a Unicode character")?);
                Cow::Owned(result)
            }
        })
    }
}

impl ReportCleaner {
    /// Saved profiles may contain a broken expression. The historical reader
    /// keeps its standard punctuation and repetition handling in that case.
    pub fn from_saved(pattern: &str, repeat: bool) -> Self {
        Self::compile(pattern, repeat).unwrap_or_else(|| {
            eprintln!("GSM could not compile the saved punctuation expression. Using default punctuation.");
            Self { extra: None, repeat }
        })
    }

    pub fn compile(pattern: &str, repeat: bool) -> Option<Self> {
        let pattern = pattern.trim();
        let extra = if pattern.is_empty() {
            None
        } else {
            Some(Arc::new(PunctuationRegex::compile(pattern)?))
        };
        Some(Self { extra, repeat })
    }

    pub(super) fn changes_kanji(&self) -> bool {
        self.extra.is_some() || self.repeat
    }

    pub(super) fn visit<T>(&self, text: &str, visit: impl FnOnce(&str) -> T) -> Result<T> {
        visit_normalized(text, self.extra.as_deref(), self.repeat, visit)
    }

    pub(super) fn count(&self, text: &str) -> Result<usize> {
        self.visit(text, |text| text.chars().count())
    }
}

// Expressions with matching, nonempty branches can use the linear engine.
static PORTABLE: LazyLock<Regex> = LazyLock::new(|| {
    let literal = r"[^\\.^$|?*+()\[\]{}]+";
    let term = format!(r"(?:{literal}(?:\.\*\?{literal})?|\[(?:[\w ](?:-[\w ])?)+\]\+?)");
    let branch = format!(
        r"(?:{term}|\(\?<={literal}\){term}|{term}\(\?={literal}\)|\({literal}(?:\|{literal})*\)\\1)"
    );
    Regex::new(&format!(r"\A{branch}(?:\|{branch})*\z")).unwrap()
});

struct Line {
    time: f64,
    chars: usize,
    id: Option<String>,
    scene: String,
    game_id: String,
}

pub(super) fn characters(text: &str) -> usize {
    trim(&DEFAULT_PUNCTUATION.replace_all(text, ""))
        .chars()
        .count()
}

pub(super) const PUNCTUATION_PATTERN: &str = r"[\p{P}\p{S}\p{Z}]";
static DEFAULT_PUNCTUATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{P}\p{S}\p{Z}]+").unwrap());

fn trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c))
}

pub(super) fn visit_normalized<T>(
    text: &str,
    custom: Option<&PunctuationRegex>,
    repeat: bool,
    visit: impl FnOnce(&str) -> T,
) -> Result<T> {
    let stripped = strip(text, custom)?;
    let clean = trim(&stripped);
    if repeat {
        Ok(visit(&reduce(clean)?))
    } else {
        Ok(visit(clean))
    }
}

fn strip<'a>(text: &'a str, custom: Option<&PunctuationRegex>) -> Result<Cow<'a, str>> {
    match custom {
        Some(regex) => regex.strip(text),
        None => Ok(DEFAULT_PUNCTUATION.replace_all(text, "")),
    }
}

fn reduce(text: &str) -> fancy_regex::Result<Cow<'_, str>> {
    static REPETITIONS: LazyLock<fancy_regex::Regex> =
        LazyLock::new(|| fancy_regex::Regex::new(r"(.+?)\1{2,}").unwrap());
    REPETITIONS.try_replacen(text, 0, "$1$1$1")
}

pub(super) fn live_count(text: &str, custom: Option<&PunctuationRegex>, repeat: bool) -> usize {
    let Ok(stripped) = strip(text, custom) else {
        return characters(text);
    };
    let clean = trim(&stripped);
    if repeat {
        if let Ok(reduced) = reduce(clean) {
            return reduced.chars().count();
        }
    }
    clean.chars().count()
}

fn active_seconds(lines: &[Line], breaks: &[f64]) -> f64 {
    reading_seconds(
        lines.windows(2).map(|p| (p[0].time, p[1].time, p[0].chars)),
        breaks,
    )
}

/// Neumaier summation keeps duration totals consistent with Python's sum.
#[derive(Default)]
pub(super) struct DurationSum {
    sum: f64,
    correction: f64,
}

impl DurationSum {
    pub(super) fn add(&mut self, seconds: f64) {
        let next = self.sum + seconds;
        self.correction += if self.sum >= seconds {
            (self.sum - next) + seconds
        } else {
            (seconds - next) + self.sum
        };
        self.sum = next;
    }
    pub(super) fn seconds(&self) -> f64 {
        if self.correction.is_finite() { self.sum + self.correction } else { self.sum }
    }
}

pub(super) fn reading_seconds(
    pairs: impl Iterator<Item = (f64, f64, usize)> + Clone,
    breaks: &[f64],
) -> f64 {
    let mut next_break = pairs
        .clone()
        .next()
        .map_or(0, |(start, _, _)| breaks.partition_point(|&b| b < start));
    let gaps = pairs.filter_map(move |(start, end, chars)| {
        while next_break < breaks.len() && breaks[next_break] < start {
            next_break += 1;
        }
        if breaks.get(next_break).is_some_and(|&b| b < end) {
            return None;
        }
        Some((end - start, chars as f64))
    });
    pace_adjusted_seconds(gaps)
}

pub(super) fn median_pace(gaps: impl Iterator<Item = (f64, f64)>) -> f64 {
    let mut speeds: Vec<f64> = gaps
        .filter(|&(gap, chars)| (1.0..=300.0).contains(&gap) && chars >= 5.0)
        .map(|(gap, chars)| chars / gap)
        .collect();
    let n = speeds.len();
    if n == 0 {
        0.0
    } else {
        let (lower, mid, _) = speeds.select_nth_unstable_by(n / 2, f64::total_cmp);
        if n.is_multiple_of(2) {
            (lower.iter().copied().fold(0.0, f64::max) + *mid) / 2.0
        } else {
            *mid
        }
    }
}

pub(super) fn reading_cap(chars: f64, pace: f64) -> f64 {
    if chars == 0.0 {
        return 0.0;
    }
    let cap = if pace > 0.0 { chars / pace * 2.5 } else { chars * 3.0 };
    cap.clamp(2.0, 300.0)
}

pub(super) fn pace_adjusted_seconds(gaps: impl Iterator<Item = (f64, f64)> + Clone) -> f64 {
    let pace = median_pace(gaps.clone());
    let mut total = DurationSum::default();
    for (gap, chars) in gaps {
        if chars > 0.0 {
            total.add(gap.min(reading_cap(chars, pace)));
        }
    }
    total.seconds()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    start_time: f64,
    end_time: f64,
    game_name: String,
    #[serde(flatten)]
    game: SessionGame,
    total_chars: usize,
    total_seconds: f64,
    chars_per_hour: u64,
    lines: Vec<String>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum SessionGame {
    Id {
        #[serde(rename = "gameId")]
        id: Option<String>,
    },
    Metadata {
        #[serde(rename = "gameMetadata")]
        data: serde_json::Value,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Today {
    today_total_chars: usize,
    today_chars_per_hour: u64,
    today_total_hours: f64,
    today_sessions: usize,
    sessions: Vec<Session>,
}

impl Today {
    pub(super) fn resolve_games(&mut self, conn: &Connection) -> Result<()> {
        use std::collections::{hash_map::Entry, HashMap};
        let mut games = HashMap::<String, serde_json::Value>::new();
        for session in &mut self.sessions {
            let data = match &session.game {
                SessionGame::Id { id: Some(id) } => match games.entry(id.clone()) {
                    Entry::Occupied(entry) => entry.get().clone(),
                    Entry::Vacant(entry) => entry
                        .insert(super::game_stats::session_metadata(conn, id)?)
                        .clone(),
                },
                SessionGame::Id { id: None } => serde_json::Value::Null,
                SessionGame::Metadata { .. } => continue,
            };
            session.game = SessionGame::Metadata { data };
        }
        Ok(())
    }
}

fn speed(chars: usize, seconds: f64) -> u64 {
    if seconds > 0.0 {
        (chars as f64 / (seconds / 3600.0)).round_ties_even() as u64
    } else {
        0
    }
}

pub(super) fn today(
    conn: &Connection,
    start: f64,
    end: f64,
    session_gap: f64,
    cleaner: &ReportCleaner,
) -> Result<Today> {
    let mut stmt = conn.prepare("SELECT CAST(timestamp AS REAL), coalesce(line_text,''), id,
        coalesce(game_name,''), coalesce(game_id,'') FROM game_lines WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp")?;
    let mut lines = Vec::new();
    let mut rows = stmt.query(params![start, end])?;
    while let Some(r) = rows.next()? {
        lines.push(Line {
            time: r.get(0)?,
            chars: cleaner.count(r.get_ref(1)?.as_str()?)?,
            id: Some(r.get(2)?),
            scene: r.get(3)?,
            game_id: r.get(4)?,
        });
    }
    archive_events(
        conn,
        Some(start),
        Some(end),
        |time, chars, _, scene, game_id| {
            lines.push(Line {
                time,
                chars,
                id: None,
                scene: scene.into(),
                game_id: game_id.into(),
            });
            Ok(())
        },
    )?;
    lines.sort_by(|a, b| a.time.total_cmp(&b.time));

    let breaks = reading_breaks(conn, start, end)?;
    let mut games = HashMap::new();
    let mut aliases = HashMap::new();
    if !lines.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT id,coalesce(title_original,''),coalesce(obs_scene_name,'') FROM games",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let scene: String = row.get(2)?;
            for alias in [&scene, &title].into_iter().filter(|s| !s.is_empty()) {
                aliases.entry(alias.clone()).or_insert_with(|| id.clone());
            }
            games.insert(id, title);
        }
    }
    // First sighting of a scene fixes its display identity for this response.
    let mut names = HashMap::new();
    for line in &mut lines {
        let (name, id) = names.entry(line.scene.clone()).or_insert_with(|| {
            let id = (!line.scene.is_empty())
                .then(|| {
                    games.get_key_value(&line.game_id).or_else(|| {
                        aliases
                            .get(&line.scene)
                            .and_then(|id| games.get_key_value(id))
                    })
                })
                .flatten();
            let name = id
                .map(|(_, title)| title.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(&line.scene);
            (
                (if name.is_empty() {
                    "Unknown Game"
                } else {
                    name
                })
                .to_owned(),
                id.map(|(id, _)| id.clone()).unwrap_or_default(),
            )
        });
        line.scene.clone_from(name);
        line.game_id.clone_from(id);
    }
    let total_chars = lines.iter().map(|l| l.chars).sum();
    let mut total_seconds = 0.0;
    let mut sessions = vec![];
    for span in lines.chunk_by(|a, b| b.time - a.time <= session_gap) {
        // Daily pace spans game changes; displayed sessions learn their own pace.
        let seconds = active_seconds(span, &breaks);
        total_seconds += seconds;
        for group in span.chunk_by(|a, b| a.scene == b.scene) {
            let first = &group[0];
            let seconds = if group.len() == span.len() {
                seconds
            } else {
                active_seconds(group, &breaks)
            };
            let chars = group.iter().map(|l| l.chars).sum();
            sessions.push(Session {
                start_time: first.time,
                end_time: group[group.len() - 1].time,
                game_name: first.scene.clone(),
                game: SessionGame::Id {
                    id: (!first.game_id.is_empty()).then(|| first.game_id.clone()),
                },
                total_chars: chars,
                total_seconds: seconds,
                chars_per_hour: speed(chars, seconds),
                lines: group.iter().filter_map(|l| l.id.clone()).collect(),
            });
        }
    }
    Ok(Today {
        today_total_chars: total_chars,
        today_chars_per_hour: speed(total_chars, total_seconds),
        today_total_hours: format!("{:.2}", total_seconds / 3600.0).parse()?,
        today_sessions: sessions.len(),
        sessions,
    })
}

pub(super) fn reading_breaks(conn: &Connection, start: f64, end: f64) -> Result<Vec<f64>> {
    if !table_exists(conn, "stats_reading_breaks")? {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare("SELECT CAST(timestamp AS REAL) AS t FROM stats_reading_breaks WHERE CAST(timestamp AS REAL) >= ? AND CAST(timestamp AS REAL) < ? ORDER BY t")?;
    let rows = stmt.query_map(params![start, end], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
