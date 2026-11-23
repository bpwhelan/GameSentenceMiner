use super::*;
use crate::game_stats::local_day_range;
use serde_json::Value;

pub struct CalendarRange {
    pub start: NaiveDate,
    pub end: NaiveDate,
    pub today: NaiveDate,
    /// Midnight boundaries in the reader's timezone, exclusive at the end.
    pub day_start: f64,
    pub day_end: f64,
}
#[derive(Default,Clone,Copy)]
pub struct CalendarProgress {
    pub total: f64,
    pub before: f64,
    pub today: f64,
    pub has_live: bool,
}
fn game(conn: &Connection, q: &Query<'_>, r: &CalendarRange) -> Result<CalendarProgress> {
    if q.metric.anki() {
        return Ok(Default::default());
    }
    let start = local_day_range(r.start).0;
    let midnight = local_day_range(r.today).0;
    let end = local_day_range(r.end.min(r.today).succ_opt().ok_or("Invalid end date")?).0;
    let ranges = [
        (start, end),
        (start, end.min(midnight)),
        (start.max(midnight), end),
    ]
    .map(|(start, end)| ExactRange {
        start,
        end,
        whole_days: None,
    });
    let values = exact(conn, q, &ranges)?;
    Ok(CalendarProgress {
        total: values[0],
        before: values[1],
        today: values[2],
        has_live: values[2] != 0.,
    })
}

fn past(
    conn: &Connection,
    q: &Query<'_>,
    start: NaiveDate,
    end: NaiveDate,
    ids: &mut HashSet<String>,
) -> Result<f64> {
    if start > end {
        return Ok(0.);
    }
    let dates = [start.to_string(), end.to_string()];
    if q.metric == Metric::Games {
        let mut stmt = conn.prepare_cached(
            "SELECT games_played_ids FROM daily_stats_rollup WHERE date BETWEEN ? AND ?",
        )?;
        let mut rows = stmt.query(dates)?;
        while let Some(row) = rows.next()? {
            if let Some(raw) = row.get_ref(0)?.as_str_or_null()? {
                if let Ok(list) = serde_json::from_str::<Vec<String>>(raw) {
                    ids.extend(list);
                }
            }
        }
        return Ok(ids.len() as f64);
    }
    let (column, key, scale) = match q.metric {
        Metric::Hours => ("total_reading_time_seconds", "time", 3600.),
        Metric::Characters => ("total_characters", "chars", 1.),
        Metric::Cards => ("anki_cards_created", "cards", 1.),
        _ => return Ok(0.),
    };
    if let Scope::Media(kind) = q.scope {
        let mut stmt = conn.prepare_cached(
            "SELECT type_activity_data FROM daily_stats_rollup WHERE date BETWEEN ? AND ?",
        )?;
        let mut rows = stmt.query(dates)?;
        let mut sum = 0.;
        while let Some(row) = rows.next()? {
            if let Some(raw) = row.get_ref(0)?.as_str_or_null()? {
                if let Ok(data) = serde_json::from_str::<Value>(raw) {
                    sum += data[kind][key].as_f64().unwrap_or(0.);
                }
            }
        }
        return Ok(sum / scale);
    }
    let total: f64 = conn
        .prepare_cached(&format!(
            "SELECT coalesce(sum({column}),0) FROM daily_stats_rollup WHERE date BETWEEN ? AND ?"
        ))?
        .query_row(dates, |r| r.get(0))?;
    Ok(total / scale)
}

fn live(
    conn: &Connection,
    q: &Query<'_>,
    r: &CalendarRange,
    ids: &mut HashSet<String>,
) -> Result<(f64, bool)> {
    let lines = fetch_live_and_archived_lines(
        conn,
        q.cleaner,
        timestamp_expression(conn)?,
        Some(r.day_start),
        Some(r.day_end.next_down()),
        None,
    )?;
    if lines.is_empty() {
        return Ok((0., false));
    }
    if q.metric == Metric::Games {
        let live: HashSet<_> = lines
            .iter()
            .map(|l| l.game_id.as_str())
            .filter(|s| !s.trim().is_empty())
            .collect();
        let n = live.len();
        ids.extend(live.into_iter().map(str::to_owned));
        return Ok((n as f64, true));
    }
    let types = if matches!(q.scope, Scope::Media(_)) {
        Some(Types::read(conn)?)
    } else {
        None
    };
    let matches = |line: &&LineSample| match (q.scope, &types) {
        (Scope::Media(kind), Some(types)) if q.metric == Metric::Cards => types.matches(line, kind),
        (Scope::Media(kind), Some(types)) => {
            types.ids.get(&line.game_id).is_some_and(|s| s == kind)
        }
        _ => true,
    };
    let filtered = lines.iter().filter(matches);
    let value = match q.metric {
        Metric::Characters => filtered.map(|l| l.chars).sum::<usize>() as f64,
        Metric::Cards => filtered.map(|l| l.cards).sum::<i64>() as f64,
        Metric::Hours => {
            let breaks = reading_breaks(conn, r.day_start, r.day_end)?;
            if types.is_some() {
                let mut groups = HashMap::<&str, Vec<(f64, usize)>>::new();
                for line in filtered {
                    groups
                        .entry(&line.game_id)
                        .or_default()
                        .push((line.ts, line.chars));
                }
                groups
                    .values()
                    .map(|samples| calc_reading_time(samples, q.session_gap, &breaks))
                    .sum::<f64>()
                    / 3600.
            } else {
                reading_duration(filtered, q.session_gap, &breaks)
            }
        }
        Metric::Mature => {
            let local = local_day_range(chrono::Local::now().date_naive()).0;
            anki(
                conn,
                q.metric,
                q.deck,
                Some(((local * 1000.) as i64, i64::MAX)),
            )?
        }
        Metric::Backlog => anki(conn, q.metric, q.deck, None)?,
        _ => 0.,
    };
    Ok((value, true))
}
pub(super) fn calculate(
    conn: &Connection,
    q: &Query<'_>,
    r: &CalendarRange,
) -> Result<CalendarProgress> {
    if r.start > r.today || r.start > r.end {
        return Ok(Default::default());
    }
    if matches!(q.scope, Scope::Game { .. }) {
        return game(conn, q, r);
    }
    let yesterday = r.today.pred_opt().ok_or("Invalid calendar day")?;
    let past_end = yesterday.min(r.end);
    let mut ids = HashSet::new();
    let rollup = past(conn, q, r.start, past_end, &mut ids)?;
    let (today, has_live) = if r.end >= r.today {
        live(conn, q, r, &mut ids)?
    } else {
        (0., false)
    };
    let imported = |end| -> Result<f64> {
        if matches!(q.scope, Scope::All) && r.start <= end {
            imports(conn, q.metric, Some((r.start, end)))
        } else {
            Ok(0.)
        }
    };
    let (total, before) = if q.metric.anki() {
        let value = anki(conn, q.metric, q.deck, None)?;
        (value, if r.start <= past_end { value } else { 0. })
    } else if q.metric == Metric::Games {
        (ids.len() as f64, rollup)
    } else {
        let prior = imported(past_end)?;
        let added = if past_end == r.end {
            prior
        } else {
            imported(r.end)?
        };
        (rollup + today + added, rollup + prior)
    };
    Ok(CalendarProgress {
        today,
        total,
        before,
        has_live,
    })
}
impl History {
    pub fn goal_daily_rate(&self, path: &Path, q: &Query<'_>, r: &CalendarRange) -> Result<f64> {
        self.with_reader(path,|c|{
            let tx=c.transaction()?;
            let value=if q.metric.anki(){
                let local=chrono::Local::now().date_naive();let mut sum=0.;
                for days in [0,7,14,21] {
                    let date=local-chrono::Days::new(days);
                    let (start,end)=local_day_range(date);
                    sum+=anki(&tx,q.metric,q.deck,Some((start as i64*1000,end as i64*1000+1)))?;
                }
                sum/4.
            }else{
                let start=r.today-chrono::Days::new(30);
                let end=r.today-chrono::Days::new(1);
                let mut ids=HashSet::new();
                let historical=if q.metric==Metric::Games && matches!(q.scope,Scope::All){
                    // Projection counts games per day. Reading the same game on two
                    // different days contributes twice to the thirty-day pace.
                    let mut stmt=tx.prepare_cached("SELECT games_played_ids FROM daily_stats_rollup WHERE date BETWEEN ? AND ?")?;
                    let mut rows=stmt.query([start.to_string(),end.to_string()])?;
                    let mut count=0;
                    while let Some(row)=rows.next()?{
                        if let Some(list)=row.get_ref(0)?.as_str_or_null()?.and_then(|s|serde_json::from_str::<HashSet<String>>(s).ok()){count+=list.len();}
                    }
                    count as f64
                }else{past(&tx,q,start,end,&mut ids)?};
                let (current,_)=live(&tx,q,r,&mut ids)?;
                (if q.metric==Metric::Games && matches!(q.scope,Scope::Media(_)){ids.len() as f64}else{historical+current})/30.
            };
            tx.commit()?;Ok(value)
        })
    }
    pub fn calendar_goal_values(
        &self,
        path: &Path,
        query: &Query<'_>,
        range: &CalendarRange,
    ) -> Result<CalendarProgress> {
        self.with_reader(path, |c| {
            let tx = c.transaction()?;
            let result = calculate(&tx, query, range)?;
            tx.commit()?;
            Ok(result)
        })
    }
}
