//! Metrics shared by the goals dashboard, progress requests and scheduled completion.
mod calendar;
use crate::{
    game_stats::{
        calc_reading_time, fetch_live_and_archived_lines, timestamp_expression, LineSample,
    },
    sessions::reading_breaks,
    stats::table_exists,
    History, ReportCleaner, Result,
};
pub use calendar::{CalendarProgress, CalendarRange};
use chrono::NaiveDate;
use rusqlite::{Connection, OptionalExtension};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum Metric {
    Characters,
    Hours,
    Games,
    Cards,
    Mature,
    Backlog,
    Unknown,
}
impl Metric {
    pub fn parse(name: &str) -> Self {
        match name.strip_suffix("_static").unwrap_or(name) {
            "characters" | "finish_game" => Self::Characters,
            "hours" => Self::Hours,
            "games" => Self::Games,
            "cards" => Self::Cards,
            "mature_cards" => Self::Mature,
            "anki_backlog" => Self::Backlog,
            _ => Self::Unknown,
        }
    }
    fn anki(self) -> bool {
        matches!(self, Self::Mature | Self::Backlog)
    }
}
#[derive(Clone, Copy)]
pub enum Scope<'a> {
    All,
    Media(&'a str),
    Game { id: &'a str, name: &'a str },
}
pub struct Query<'a> {
    pub metric: Metric,
    pub scope: Scope<'a>,
    pub cleaner: &'a ReportCleaner,
    pub session_gap: f64,
    pub deck: &'a str,
}
pub struct ExactRange {
    pub start: f64,
    pub end: f64,
    /// Local calendar dates wholly enclosed by these instants (inclusive).
    pub whole_days: Option<(NaiveDate, NaiveDate)>,
}
fn game_id(conn: &Connection, id: &str, name: &str) -> Result<Option<String>> {
    if !id.is_empty() && conn.query_row("SELECT EXISTS(SELECT 1 FROM game_lines WHERE game_id=?1) OR EXISTS(SELECT 1 FROM games WHERE id=?1)",[id],|r|r.get::<_,bool>(0))? {return Ok(Some(id.into()));}
    let name = name.trim();
    if name.is_empty() {
        return Ok(None);
    }
    let game=conn.query_row("SELECT g.id FROM games g LEFT JOIN game_lines l ON l.game_id=g.id
        WHERE g.title_original=?1 COLLATE NOCASE OR g.title_romaji=?1 COLLATE NOCASE OR g.title_english=?1 COLLATE NOCASE OR g.obs_scene_name=?1 COLLATE NOCASE
        GROUP BY g.id ORDER BY count(l.id) DESC,coalesce(max(l.timestamp),0) DESC LIMIT 1",[name],|r|r.get(0)).optional()?;
    if game.is_some() {
        return Ok(game);
    }
    Ok(conn.query_row("SELECT game_id FROM game_lines WHERE game_id!='' AND game_name=?1 COLLATE NOCASE GROUP BY game_id
        ORDER BY count(*) DESC,coalesce(max(timestamp),0) DESC LIMIT 1",[name],|r|r.get(0)).optional()?)
}

struct Types {
    ids: HashMap<String, String>,
    titles: HashMap<String, String>,
}
impl Types {
    fn read(conn: &Connection) -> Result<Self> {
        let mut result = Self {
            ids: Default::default(),
            titles: Default::default(),
        };
        let mut stmt = conn.prepare(
            "SELECT id,coalesce(title_original,''),coalesce(type,'') FROM games ORDER BY rowid",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let kind: String = row.get(2)?;
            if !title.is_empty() {
                result.titles.entry(title).or_insert_with(|| kind.clone());
            }
            result.ids.insert(id, kind);
        }
        Ok(result)
    }
    fn matches(&self, line: &LineSample, kind: &str) -> bool {
        self.ids
            .get(&line.game_id)
            .or_else(|| self.titles.get(&line.game_name))
            .is_some_and(|t| t == kind)
    }
}
fn imports(
    conn: &Connection,
    metric: Metric,
    range: Option<(NaiveDate, NaiveDate)>,
) -> Result<f64> {
    let Some((first, last)) = range else {
        return Ok(0.);
    };
    let column = match metric {
        Metric::Hours => "time_read_seconds",
        Metric::Characters => "characters_read",
        _ => return Ok(0.),
    };
    let mut q = conn.prepare_cached(&format!(
        "SELECT coalesce(sum({column}),0) FROM third_party_stats WHERE date BETWEEN ? AND ?"
    ))?;
    let value: f64 = q.query_row([first.to_string(), last.to_string()], |r| r.get(0))?;
    Ok(if metric == Metric::Hours {
        value / 3600.
    } else {
        value
    })
}

fn anki(conn: &Connection, metric: Metric, deck: &str, bounds: Option<(i64, i64)>) -> Result<f64> {
    if !table_exists(conn, "anki_cards")? {
        return Ok(0.);
    }
    // Untimed backlog counts remaining new cards. A timed goal counts reviewed cards
    // which have left that state. Review timestamps are milliseconds since the epoch.
    let condition = match (metric, bounds.is_some()) {
        (Metric::Mature, _) => "ac.interval>=21",
        (Metric::Backlog, true) => "ac.type!=0",
        (Metric::Backlog, false) => "ac.type=0",
        _ => return Ok(0.),
    };
    let deck = deck.trim();
    let deck_filter = if deck.is_empty() {
        ""
    } else {
        " AND ac.deck_name=?"
    };
    let (sql, mut params) = if let Some((start, end)) = bounds {
        if !table_exists(conn, "anki_reviews")? {
            return Ok(0.);
        }
        (format!("SELECT count(DISTINCT ac.card_id) FROM anki_cards ac JOIN anki_reviews ar ON ar.card_id=ac.card_id WHERE ar.review_time>=? AND ar.review_time<? AND {condition}{deck_filter}"),vec![start.into(),end.into()])
    } else {
        (
            format!("SELECT count(*) FROM anki_cards ac WHERE {condition}{deck_filter}"),
            Vec::new(),
        )
    };
    if !deck.is_empty() {
        params.push(rusqlite::types::Value::from(deck.to_owned()));
    }
    Ok(conn
        .prepare_cached(&sql)?
        .query_row(rusqlite::params_from_iter(params.iter()), |r| {
            r.get::<_, i64>(0)
        })? as f64)
}
fn reading_duration<'a>(
    rows: impl Iterator<Item = &'a LineSample>,
    gap: f64,
    breaks: &[f64],
) -> f64 {
    let samples: Vec<_> = rows.map(|l| (l.ts, l.chars)).collect();
    calc_reading_time(&samples, gap, breaks) / 3600.
}
fn exact(conn: &Connection, query: &Query<'_>, ranges: &[ExactRange]) -> Result<Vec<f64>> {
    let mut values = vec![0.; ranges.len()];
    let mut valid = ranges.iter().filter(|r| r.end > r.start);
    let Some(first) = valid.next() else {
        return Ok(values);
    };
    if query.metric.anki() {
        for (value, r) in values
            .iter_mut()
            .zip(ranges)
            .filter(|(_, r)| r.end > r.start)
        {
            *value = anki(
                conn,
                query.metric,
                query.deck,
                Some(((r.start * 1000.) as i64, (r.end * 1000.) as i64)),
            )?;
        }
        return Ok(values);
    }
    let id = if let Scope::Game { id, name } = query.scope {
        let Some(id) = game_id(conn, id, name)? else {
            return Ok(values);
        };
        Some(id)
    } else {
        None
    };
    let (start, end) = valid.fold((first.start, first.end), |(s, e), r| {
        (s.min(r.start), e.max(r.end))
    });
    let mut lines = fetch_live_and_archived_lines(
        conn,
        query.cleaner,
        timestamp_expression(conn)?,
        Some(start),
        Some(end.next_down()),
        id.as_deref(),
    )?;
    if let Scope::Media(kind) = query.scope {
        let types = Types::read(conn)?;
        lines.retain(|line| types.matches(line, kind));
    }
    let breaks = if query.metric == Metric::Hours {
        reading_breaks(conn, start, end)?
    } else {
        Vec::new()
    };
    for (value, r) in values
        .iter_mut()
        .zip(ranges)
        .filter(|(_, r)| r.end > r.start)
    {
        let lines = &lines
            [lines.partition_point(|l| l.ts < r.start)..lines.partition_point(|l| l.ts < r.end)];
        *value = match query.metric {
            Metric::Characters => lines.iter().map(|l| l.chars).sum::<usize>() as f64,
            Metric::Hours => reading_duration(lines.iter(), query.session_gap, &breaks),
            Metric::Cards => lines.iter().map(|l| l.cards).sum::<i64>() as f64,
            Metric::Games => lines
                .iter()
                .map(|l| {
                    if l.game_id.is_empty() {
                        &l.game_name
                    } else {
                        &l.game_id
                    }
                })
                .collect::<HashSet<_>>()
                .len() as f64,
            _ => 0.,
        };
        if matches!(query.scope, Scope::All) {
            *value += imports(conn, query.metric, r.whole_days)?;
        }
    }
    Ok(values)
}
impl History {
    pub fn exact_goal_values(
        &self,
        path: &Path,
        query: &Query<'_>,
        ranges: &[ExactRange],
    ) -> Result<Vec<f64>> {
        self.with_reader(path, |c| {
            let tx = c.transaction()?;
            let result = exact(&tx, query, ranges)?;
            tx.commit()?;
            Ok(result)
        })
    }
}
