use super::{goal_zone, Reply, Reports};
use gsm_history::GoalSettingsEdit;
use jiff::{civil::Date, tz::TimeZone, Timestamp};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

const FORMAT: &str = "Invalid date or time format";
static WINDOW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\A([0-9]{4}-[0-9]{2}-[0-9]{2})(?:T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?\z").unwrap()
});

pub(crate) fn bound(value: Option<&str>, zone: &TimeZone, end: bool) -> Result<Timestamp, &'static str> {
    let text = value.ok_or("Start and end dates are required")?;
    let parts = WINDOW.captures(text).ok_or(FORMAT)?;
    // Python's datetime supports years 1–9999.
    if text.starts_with("0000") {
        return Err(FORMAT);
    }
    let mut day: Date = parts[1].parse().map_err(|_| FORMAT)?;
    let Some(hour) = parts.get(2) else {
        if end {
            day = day.tomorrow().map_err(|_| FORMAT)?;
        }
        // pytz.localize(midnight) chooses standard time at a transition.
        return zone
            .to_ambiguous_timestamp(day.at(0, 0, 0, 0))
            .later()
            .map_err(|_| FORMAT);
    };
    let hour = hour.as_str().parse().map_err(|_| FORMAT)?;
    let minute = parts[3].parse().map_err(|_| FORMAT)?;
    let second = parts
        .get(4)
        .map_or("0", |v| v.as_str())
        .parse()
        .map_err(|_| FORMAT)?;
    // Python truncates excess fractional digits at microsecond precision.
    let fraction = parts.get(5).map_or("", |v| v.as_str());
    let nanos = fraction
        .bytes()
        .take(6)
        .zip([100_000_000, 10_000_000, 1_000_000, 100_000, 10_000, 1_000])
        .map(|(digit, place)| i32::from(digit - b'0') * place)
        .sum();
    let time = jiff::civil::Time::new(hour, minute, second, nanos).map_err(|_| FORMAT)?;
    let datetime = day.to_datetime(time);
    if let Some(offset) = parts.get(6) {
        let zone = match offset.as_str() {
            "Z" => TimeZone::UTC,
            s => {
                let hours = s[1..3].parse::<i32>().map_err(|_| FORMAT)?;
                let minutes = s[4..].parse::<i32>().map_err(|_| FORMAT)?;
                let seconds = (hours * 60 + minutes) * 60;
                if seconds >= 86400 {
                    return Err(FORMAT);
                }
                TimeZone::fixed(
                    jiff::tz::Offset::from_seconds(if s.starts_with('-') {
                        -seconds
                    } else {
                        seconds
                    })
                    .map_err(|_| FORMAT)?,
                )
            }
        };
        return zone.to_timestamp(datetime).map_err(|_| FORMAT);
    }
    zone.to_ambiguous_timestamp(datetime)
        .unambiguous()
        .map_err(|_| "This local time needs an explicit UTC offset")
}

fn validate(goal: &Value, zone: &TimeZone) -> Result<(), &'static str> {
    let get = |snake, camel| {
        goal.get(snake)
            .or_else(|| goal.get(camel))
            .and_then(Value::as_str)
    };
    let metric = get("metric_type", "metricType").unwrap_or("");
    let start = get("start_date", "startDate");
    let end = get("end_date", "endDate");
    if metric == "custom"
        || metric.ends_with("_static")
        || ![start, end].into_iter().flatten().any(|s| s.contains('T'))
    {
        return Ok(());
    }
    if bound(start, zone, false)? >= bound(end, zone, true)? {
        return Err("End date and time must be after start date and time");
    }
    Ok(())
}

impl Reports {
    pub fn update_goals(&self, input: Value, timezone: Option<&str>) -> Reply {
        let Value::Object(mut body) = input else {
            return Reply::error(400, "No data provided");
        };
        if body.is_empty() {
            return Reply::error(400, "No data provided");
        }
        let goals = match body.remove("current_goals") {
            Some(Value::Array(goals)) => {
                let zone = goal_zone(timezone);
                for goal in &goals {
                    if let Err(message) = validate(goal, &zone) {
                        return Reply::error(400, message);
                    }
                }
                Some(goals)
            }
            Some(_) => return Reply::error(400, "current_goals must be an array"),
            None => None,
        };
        let settings = match (
            body.remove("goals_settings"),
            body.remove("partial_settings"),
        ) {
            (Some(Value::Object(map)), _) => Some(GoalSettingsEdit::Replace(map)),
            (None, Some(Value::Object(map))) => Some(GoalSettingsEdit::Merge(map)),
            (None, None) => None,
            _ => return Reply::error(400, "Goal settings must be an object"),
        };
        if std::env::var_os("GSM_DB_READ_ONLY").is_some_and(|v| v == "1") {
            return Reply::error(500, "Failed to update goals");
        }
        match self.history.update_goals(&self.database, goals, settings) {
            Ok(body) => Reply { status: 200, body },
            Err(_) => Reply::error(500, "Failed to update goals"),
        }
    }
}
