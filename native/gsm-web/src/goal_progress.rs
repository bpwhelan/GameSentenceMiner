mod context;
mod daily;
mod dashboard;
mod projection;
use crate::{goal_edit::bound, goal_zone, Preferences, Reply, Reports, Result};
use chrono::{Datelike, NaiveDate};
use gsm_history::goal_metrics::{CalendarRange, ExactRange, Metric, Query, Scope};
use jiff::{civil::Date, tz::TimeZone, Timestamp};
use serde_json::{json, Value};
use std::sync::Arc;

const ALLOWED:&str="Invalid metric_type. Must be one of: hours, characters, games, cards, mature_cards, hours_static, characters_static, cards_static, anki_backlog";
#[derive(Clone, Copy, PartialEq)]
pub enum View {
    Overall,
    Daily,
    Projection,
}
pub(super) struct Context<'a> {
    reports: &'a Reports,
    prefs: Arc<Preferences>,
    zone: TimeZone,
    now: Timestamp,
    today: NaiveDate,
    cache: context::Cache,
}
impl<'a> Context<'a> {
    pub fn new(reports: &'a Reports, zone: TimeZone) -> Result<Self> {
        let now = Timestamp::now();
        let today = naive(now.to_zoned(zone.clone()).date())?;
        Ok(Self {
            reports,
            prefs: reports.preferences()?,
            zone,
            now,
            today,
            cache: Default::default(),
        })
    }
    fn midnight(&self, date: NaiveDate) -> Result<Timestamp> {
        let date = Date::new(
            date.year().try_into()?,
            date.month().try_into()?,
            date.day().try_into()?,
        )?;
        Ok(self
            .zone
            .to_ambiguous_timestamp(date.at(0, 0, 0, 0))
            .later()?)
    }
    fn range(&self, start: Timestamp, end: Timestamp) -> Result<ExactRange> {
        let mut first = naive(start.to_zoned(self.zone.clone()).date())?;
        let end_date = naive(end.to_zoned(self.zone.clone()).date())?;
        if start > self.midnight(first)? {
            first = first.succ_opt().ok_or("Invalid goal start date")?;
        }
        let whole_days = end_date
            .pred_opt()
            .filter(|last| first <= *last)
            .map(|last| (first, last));
        Ok(ExactRange {
            start: seconds(start),
            end: seconds(end),
            whole_days,
        })
    }
}
fn seconds(t: Timestamp) -> f64 {
    t.as_microsecond() as f64 / 1e6
}
fn duration(start: Timestamp, end: Timestamp) -> f64 {
    (end.as_microsecond() - start.as_microsecond()) as f64 / 1e6
}
fn naive(d: Date) -> Result<NaiveDate> {
    NaiveDate::from_ymd_opt(d.year().into(), d.month() as u32, d.day() as u32)
        .ok_or_else(|| "Invalid goal date".into())
}
fn str_date(s: &str) -> std::result::Result<NaiveDate, Reply> {
    if let Ok(day) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        if (1..=9999).contains(&day.year()) {
            return Ok(day);
        }
    }
    let message = if s.len() == 10
        && s.as_bytes()[4] == b'-'
        && s.as_bytes()[7] == b'-'
        && s[8..].parse::<u32>().is_ok()
        && s.get(5..7)
            .and_then(|s| s.parse::<u32>().ok())
            .is_some_and(|v| (1..=12).contains(&v))
    {
        "Invalid date format: day is out of range for month".into()
    } else {
        format!("Invalid date format: time data '{s}' does not match format '%Y-%m-%d'")
    };
    Err(Reply::error(400, &message))
}
fn formatted(value: f64, metric: Metric) -> Value {
    if metric == Metric::Hours {
        json!(format!("{value:.2}").parse::<f64>().unwrap_or(0.))
    } else {
        json!(value as i64)
    }
}
pub(super) fn multiplier(day: NaiveDate, settings: &Value) -> f64 {
    let days = [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
    ];
    let percentages = days.map(|day| settings["easyDays"][day].as_f64().unwrap_or(100.));
    let total: f64 = percentages.iter().sum();
    if total == 0. {
        0.
    } else {
        percentages[day.weekday().num_days_from_monday() as usize] / 100. * (700. / total)
    }
}
fn inactive(expired: bool, not_started: bool) -> Value {
    json!({"required":0,"progress":0,"has_target":false,"expired":expired,"not_started":not_started})
}
pub(super) fn field<'a>(goal: &'a Value, snake: &str, camel: &str) -> &'a Value {
    goal.get(snake)
        .or_else(|| goal.get(camel))
        .unwrap_or(&Value::Null)
}
pub(super) struct Goal<'a> {
    name: &'a str,
    metric: Metric,
    start: &'a str,
    end: &'a str,
    scope: Scope<'a>,
    target: f64,
    settings: &'a Value,
}
impl<'a> Goal<'a> {
    pub fn read(data: &'a Value, settings: &'a Value) -> Self {
        let get = |a, b| field(data, a, b).as_str().unwrap_or("");
        let name = get("metric_type", "metricType");
        let id = get("game_id", "gameId");
        let media = get("media_type", "mediaType");
        let scope = if name == "finish_game" || !id.is_empty() {
            Scope::Game {
                id,
                name: get("game_name", "gameName"),
            }
        } else if media.is_empty() || media == "ALL" {
            Scope::All
        } else {
            Scope::Media(media)
        };
        Self {
            name,
            metric: Metric::parse(name),
            start: get("start_date", "startDate"),
            end: get("end_date", "endDate"),
            scope,
            target: field(data, "target_value", "targetValue")
                .as_f64()
                .unwrap_or(0.),
            settings,
        }
    }
    fn timed(&self) -> bool {
        self.name != "custom"
            && !self.name.ends_with("_static")
            && (self.start.contains('T') || self.end.contains('T'))
    }
    fn valid_metric(&self) -> bool {
        matches!(
            self.name,
            "hours"
                | "characters"
                | "games"
                | "cards"
                | "mature_cards"
                | "hours_static"
                | "characters_static"
                | "cards_static"
                | "anki_backlog"
                | "finish_game"
        )
    }
    fn query<'b>(&'b self, ctx: &'b Context<'_>) -> Result<Query<'b>> {
        Ok(Query {
            metric: self.metric,
            scope: self.scope,
            cleaner: ctx
                .prefs
                .cleaner
                .as_ref()
                .ok_or("Invalid reading history expression")?,
            session_gap: ctx.prefs.gap,
            deck: self.settings["ankiConnect"]["deckName"]
                .as_str()
                .unwrap_or(""),
        })
    }
    fn multiplier(&self, date: NaiveDate) -> f64 {
        if self.name == "finish_game" {
            1.
        } else {
            multiplier(date, self.settings)
        }
    }
    fn exact(&self, ctx: &Context<'_>, day: NaiveDate, historical: bool) -> Result<(Value, Value)> {
        let start = bound(Some(self.start), &ctx.zone, false)?;
        let end = bound(Some(self.end), &ctx.zone, true)?;
        if end <= start {
            return Err("End date and time must be after start date and time".into());
        }
        if !self.valid_metric() {
            return Err(ALLOWED.into());
        }
        let day_start = ctx.midnight(day)?;
        let day_end = ctx.midnight(day.succ_opt().ok_or("Invalid date")?)?;
        let stop = if historical {
            ctx.now.min(end).min(day_end)
        } else {
            ctx.now.min(end)
        };
        let begin = day_start.max(start);
        let finish = day_end.min(end);
        let ranges = [
            ctx.range(start, stop)?,
            ctx.range(start, stop.min(day_start))?,
            ctx.range(begin, finish.min(stop))?,
        ];
        let values = ctx.reports.history.exact_goal_values(
            &ctx.reports.database,
            &self.query(ctx)?,
            &ranges,
        )?;
        let days = duration(start, end) / 86400.;
        let overall = json!({"progress":formatted(values[0],self.metric),"days_in_range":days,"daily_average":formatted(values[0]/days,self.metric)});
        let daily = if finish <= begin || (day == ctx.today && (ctx.now >= end || ctx.now < start))
        {
            inactive(ctx.now >= end, ctx.now < start)
        } else {
            let factor = self.multiplier(day);
            let remaining = duration(begin, end);
            let required =
                (self.target - values[1]).max(0.) * (duration(begin, finish) / remaining) * factor;
            json!({"required":formatted(required,self.metric),"progress":formatted(values[2],self.metric),"has_target":true,
                "days_remaining":remaining/86400.,"total_progress":formatted(values[0],self.metric),"easy_day_percentage":(factor*100.) as i64})
        };
        Ok((overall, daily))
    }
    fn calendar(
        &self,
        ctx: &Context<'_>,
        view: View,
        day: NaiveDate,
    ) -> std::result::Result<Value, Reply> {
        let specific = matches!(self.scope, Scope::Game { .. });
        let fixed = self.name.ends_with("_static") && !specific && view == View::Daily;
        if !specific && !self.valid_metric() {
            return Err(Reply::error(400, ALLOWED));
        }
        let (start, end) = if fixed {
            (day, day)
        } else {
            (str_date(self.start)?, str_date(self.end)?)
        };
        let days = (end - start).num_days() + 1;
        if view == View::Overall && days <= 0 && !specific {
            return Err(Reply::error(
                400,
                "start_date must be before or equal to end_date",
            ));
        }
        if view == View::Daily && (day < start || day > end) {
            return Ok(inactive(day > end, day < start));
        }
        if view == View::Overall && day < start {
            return Ok(json!({"progress":0,"daily_average":0,"days_in_range":days.max(1)}));
        }
        let work = self.query(ctx).and_then(|q| {
            ctx.stats(
                &q,
                start,
                if view == View::Daily {
                    end.min(day)
                } else {
                    end
                },
                day,
            )
        });
        let stats = work.map_err(|_| {
            Reply::error(
                500,
                if view == View::Overall {
                    "Failed to calculate goal progress"
                } else {
                    "Failed to calculate today's progress"
                },
            )
        })?;
        if view == View::Overall {
            return Ok(
                json!({"progress":formatted(stats.total,self.metric),"daily_average":formatted(if days>0{stats.total/days as f64}else{0.},self.metric),"days_in_range":days}),
            );
        }
        if fixed {
            return Ok(
                json!({"required":formatted(self.target,self.metric),"progress":formatted(stats.today,self.metric),"has_target":true,"days_remaining":null,"total_progress":null,"easy_day_percentage":100,"is_static":true}),
            );
        }
        let left = (end - day).num_days() + 1;
        let factor = self.multiplier(day);
        let required = (self.target - stats.before).max(0.) / left.max(1) as f64 * factor;
        Ok(
            json!({"required":formatted(required,self.metric),"progress":formatted(stats.today,self.metric),"has_target":true,
            "days_remaining":left,"total_progress":formatted(stats.total,self.metric),"easy_day_percentage":(factor*100.) as i64}),
        )
    }
}
impl Reports {
    pub fn goal_progress(&self, view: View, body: &Value, timezone: Option<&str>) -> Option<Reply> {
        if !body.as_object().is_some_and(|m| !m.is_empty()) {
            return Some(Reply::error(400, "No data provided"));
        }
        let ctx = match Context::new(self, goal_zone(timezone)) {
            Ok(ctx) => ctx,
            Err(e) => return Some(Reply::error(500, &e.to_string())),
        };
        if ctx.prefs.cleaner.is_none() {
            return None;
        }
        let goal = Goal::read(body, &body["goals_settings"]);
        let has_dates = !goal.start.is_empty() && !goal.end.is_empty();
        if view == View::Overall && (goal.name.is_empty() || !has_dates) {
            return Some(Reply::error(
                400,
                "Missing required fields: metric_type, start_date, end_date",
            ));
        }
        if view != View::Overall
            && (body["goal_id"].as_str().unwrap_or("").is_empty()
                || goal.name.is_empty()
                || goal.target == 0.
                || (!has_dates
                    && (view == View::Projection
                        || !goal.name.ends_with("_static")
                        || matches!(goal.scope, Scope::Game { .. }))))
        {
            return Some(Reply::error(400, "Missing required fields"));
        }
        let response = if view == View::Projection {
            goal.projection(&ctx, None)
        } else if goal.timed() {
            goal.exact(&ctx, ctx.today, false)
                .map(|(overall, daily)| {
                    if view == View::Overall {
                        overall
                    } else {
                        daily
                    }
                })
                .map_err(|e| Reply::error(400, &e.to_string()))
        } else {
            goal.calendar(&ctx, view, ctx.today)
        };
        Some(match response {
            Ok(body) => Reply { status: 200, body },
            Err(reply) => reply,
        })
    }
}
