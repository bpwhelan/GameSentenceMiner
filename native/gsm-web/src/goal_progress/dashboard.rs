use super::*;
use gsm_history::Request;
use serde_json::Map;

pub(super) fn fallback<'a>(v: &'a Value, key: &str, default: &'a str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or(default)
}
impl Goal<'_> {
    pub(super) fn fixed(
        &self,
        ctx: &Context<'_>,
        day: NaiveDate,
        lifetime: bool,
    ) -> Result<(Value, Value)> {
        let q = self.query(ctx)?;
        let today = ctx.stats(&q, day, day, day)?.today;
        let total = if lifetime && matches!(self.scope, Scope::Game { .. }) {
            ctx.reports.history.exact_goal_values(
                &ctx.reports.database,
                &q,
                &[ExactRange {
                    start: -f64::MAX,
                    end: f64::MAX,
                    whole_days: None,
                }],
            )?[0]
        } else {
            today
        };
        Ok((
            json!({"progress":formatted(total,self.metric),"daily_average":0,"days_in_range":1}),
            json!({"required":formatted(self.target,self.metric),"progress":formatted(today,self.metric),"has_target":true,"days_remaining":null,"total_progress":null,"easy_day_percentage":100,"is_static":true}),
        ))
    }
    fn views(&self, ctx: &Context<'_>) -> Result<Option<(Value, Value)>> {
        if self.timed() {
            return self.exact(ctx, ctx.today, false).map(Some);
        }
        if self.target == 0. || self.name == "custom" || self.name.is_empty() {
            return Ok(None);
        }
        if self.name.ends_with("_static") {
            return self.fixed(ctx, ctx.today, true).map(Some);
        }
        let Ok(overall) = self.calendar(ctx, View::Overall, ctx.today) else {
            return Ok(None);
        };
        let Ok(daily) = self.calendar(ctx, View::Daily, ctx.today) else {
            return Ok(None);
        };
        Ok(Some((overall, daily)))
    }
    fn active(&self, ctx: &Context<'_>) -> bool {
        if matches!(
            self.name,
            "custom" | "characters_static" | "hours_static" | "cards_static"
        ) {
            return true;
        }
        if self.end.contains('T') {
            return bound(Some(self.start), &ctx.zone, false)
                .ok()
                .zip(bound(Some(self.end), &ctx.zone, true).ok())
                .is_some_and(|(start, end)| start < end && ctx.now < end);
        }
        !self.end.is_empty() && self.end >= ctx.today.to_string().as_str()
    }
}
impl Context<'_> {
    fn snapshot(&self, data: &Value) -> Result<Value> {
        let mut overall = Map::new();
        let mut today = Map::new();
        let mut projections = Map::new();
        for params in data["current_goals"].as_array().into_iter().flatten() {
            let Some(id) = field(params, "goal_id", "id")
                .as_str()
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let goal = Goal::read(params, &data["goals_settings"]);
            let views = goal.views(self);
            // Old saved timed goals can carry invalid wall-clock windows.
            if goal.timed() && views.is_err() {
                continue;
            }
            let Some((progress, daily)) = views? else {
                continue;
            };
            if !matches!(goal.scope, Scope::Game { .. })
                && (goal.timed()
                    || matches!(
                        goal.name,
                        "hours" | "characters" | "games" | "cards" | "mature_cards"
                    ))
            {
                if let Ok(value) = goal.projection(self, Some(&progress)) {
                    projections.insert(id.into(), value);
                }
            }
            overall.insert(id.into(), progress);
            today.insert(id.into(), daily);
        }
        let mut out = data.clone();
        out["today_date"] = self.today.to_string().into();
        out["current_streak"] = self.reports.history.run(
            &self.reports.database,
            Request::GoalStreak { today: self.today },
        )?;
        out["goal_progress"] = overall.into();
        out["today_progress"] = today.into();
        out["projections"] = projections.into();
        Ok(out)
    }
    fn active(&self, data: &Value) -> Result<Value> {
        let mut rows = Vec::new();
        for params in data["current_goals"].as_array().into_iter().flatten() {
            let Some(id) = field(params, "goal_id", "id")
                .as_str()
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let goal = Goal::read(params, &data["goals_settings"]);
            if !goal.active(self) {
                continue;
            }
            let (overall, daily) = goal.views(self)?.unwrap_or_default();
            let progress = overall["progress"].as_f64().unwrap_or(0.);
            let percent = if goal.target > 0. {
                (progress / goal.target * 100.)
                    .clamp(0., 100.)
                    .round_ties_even() as i64
            } else {
                0
            };
            rows.push(json!({"id":id,"name":fallback(params,"name","Goal"),"icon":fallback(params,"icon","🎯"),"metric_type":goal.name,
                "today":{"progress":daily.get("progress").cloned().unwrap_or(0.into()),"required":daily.get("required").cloned().unwrap_or(0.into()),"has_target":daily["has_target"]==true},
                "overall":{"progress":overall.get("progress").cloned().unwrap_or(0.into()),"target":field(params,"target_value","targetValue"),"percent":percent}}));
        }
        Ok(json!({"goals":rows}))
    }
}
impl Reports {
    pub fn live_goals(&self) -> Result<Option<Value>> {
        let generation = self.history.generation()?;
        let Some(mut reply) = self.goals_page(&crate::Route::ActiveGoals, None)? else {
            return Ok(None);
        };
        if self.history.generation()? != generation {
            return Ok(None);
        }
        reply.body["type"] = "live_goals_update".into();
        reply.body["updated_at"] = (chrono::Utc::now().timestamp_micros() as f64 / 1e6).into();
        Ok(Some(reply.body))
    }

    pub(crate) fn goals_page(
        &self,
        route: &crate::Route,
        timezone: Option<&str>,
    ) -> Result<Option<Reply>> {
        let active = matches!(route, crate::Route::ActiveGoals);
        let zone = if active {
            TimeZone::fixed(jiff::tz::Offset::from_seconds(
                chrono::Local::now().offset().local_minus_utc(),
            )?)
        } else {
            goal_zone(timezone)
        };
        let ctx = Context::new(self, zone)?;
        if ctx.prefs.cleaner.is_none() {
            return Ok(None);
        }
        let read_only = std::env::var("GSM_DB_READ_ONLY").as_deref() == Ok("1");
        let read_existing = matches!(
            route,
            crate::Route::TodaysGoals | crate::Route::AchievedGoals
        );
        let source = self
            .history
            .current_goals(&self.database, read_only || read_existing)?
            .unwrap_or_else(|| json!({"current_goals":[],"goals_settings":{}}));
        let body = match route {
            crate::Route::ActiveGoals => ctx.active(&source)?,
            crate::Route::TodaysGoals => ctx.goals_for_date(&source, ctx.today)?,
            crate::Route::AchievedGoals => ctx.achieved(&source)?,
            _ => ctx.snapshot(&source)?,
        };
        Ok(Some(Reply { status: 200, body }))
    }
}
