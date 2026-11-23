use super::{dashboard::fallback, *};
use std::collections::HashSet;

fn display(value: f64, metric: Metric) -> String {
    let integer = value as i64;
    match metric {
        Metric::Hours => {
            let minutes = ((value - integer as f64) * 60.).round_ties_even() as i64;
            match (integer, minutes) {
                (h, m) if h > 0 && m > 0 => format!("{h}h {m}m"),
                (h, _) if h > 0 => format!("{h}h"),
                (_, m) => format!("{m}m"),
            }
        }
        Metric::Characters if integer >= 1_000_000 => format!("{:.1}M", integer as f64 / 1e6),
        Metric::Characters if integer >= 1000 => format!("{:.1}K", integer as f64 / 1e3),
        _ => integer.to_string(),
    }
}
impl Context<'_> {
    pub(super) fn goals_for_date(&self, source: &Value, day: NaiveDate) -> Result<Value> {
        let mut rows = Vec::new();
        for params in source["current_goals"].as_array().into_iter().flatten() {
            let goal = Goal::read(params, &source["goals_settings"]);
            if goal.name == "custom" || goal.name.is_empty() {
                continue;
            }
            let daily = if goal.timed() {
                let window = bound(Some(goal.start), &self.zone, false).ok()
                    .zip(bound(Some(goal.end), &self.zone, true).ok());
                if !goal.valid_metric() || !window.is_some_and(|(start,end)| start < end) {
                    continue;
                }
                goal.exact(self, day, true)?.1
            } else if goal.target == 0. {
                continue;
            } else if goal.name.ends_with("_static") {
                goal.fixed(self, day, false)?.1
            } else {
                match goal.calendar(self, View::Daily, day) {
                    Ok(daily) => daily,
                    Err(reply) if reply.status < 500 => continue,
                    Err(_) => return Err("Could not read daily goal progress".into()),
                }
            };
            if daily["has_target"] == true {
                rows.push(json!({"goal_name":fallback(params,"name","Unknown Goal"),"goal_icon":fallback(params,"icon","🎯"),
                    "metric_type":goal.name,"progress_today":daily["progress"],"progress_needed":daily["required"]}));
            }
        }
        Ok(json!({"date":day,"goals":rows}))
    }
    pub(super) fn tomorrow(&self, source: &Value) -> Result<Value> {
        let tomorrow = self.today.succ_opt().ok_or("Invalid goal date")?;
        let mut rows = Vec::new();
        for params in source["current_goals"].as_array().into_iter().flatten() {
            let goal = Goal::read(params, &source["goals_settings"]);
            if goal.name.is_empty() || goal.name == "custom" {
                continue;
            }
            let value = if goal.timed() {
                let Ok((_, daily)) = goal.exact(self, tomorrow, true) else {
                    continue;
                };
                if daily["has_target"] != true {
                    continue;
                }
                daily["required"].as_f64().unwrap_or(0.)
            } else if goal.name.ends_with("_static") {
                goal.target
            } else {
                let (Ok(start), Ok(end)) = (str_date(goal.start), str_date(goal.end)) else {
                    continue;
                };
                if tomorrow < start || tomorrow > end || goal.target == 0. {
                    continue;
                }
                let q = goal.query(self)?;
                let total = if start > self.today && !matches!(q.scope, Scope::Game { .. }) {
                    // The tomorrow view includes live activity when a non-game goal starts tomorrow.
                    self.stats(&q, self.today, self.today, self.today)?.today
                } else {
                    self.stats(&q, start, self.today, self.today)?.total
                };
                (goal.target - total).max(0.) / ((end - tomorrow).num_days() + 1) as f64
                    * goal.multiplier(tomorrow)
            };
            if value > 0. || goal.name.ends_with("_static") {
                rows.push(json!({"goal_name":fallback(params,"name","Unknown Goal"),"goal_icon":fallback(params,"icon","🎯"),"metric_type":goal.name,
                    "required_tomorrow":formatted(value,goal.metric),"formatted_required":display(value,goal.metric)}));
            }
        }
        Ok(json!({"requirements":rows}))
    }
    pub(super) fn achieved(&self, source: &Value) -> Result<Value> {
        let mut rows = Vec::new();
        let mut seen = HashSet::new();
        let mut count = 0;
        for params in source["current_goals"].as_array().into_iter().flatten() {
            let id = &params["id"];
            if let Some(id) = id.as_str().filter(|s| !s.is_empty()) {
                if !seen.insert(id) {
                    continue;
                }
            }
            let g = Goal::read(params, &source["goals_settings"]);
            let custom = g.name == "custom";
            let fixed = g.name.ends_with("_static");
            let (target, value, expired) = if custom {
                if source["goals_settings"]["customCheckboxes"][id.as_str().unwrap_or("")]
                    ["lastCheckedDate"]
                    != self.today.to_string()
                {
                    continue;
                }
                (1., 1., false)
            } else if g.target <= 0. || g.name.is_empty() {
                continue;
            } else if g.timed() {
                let Ok((overall, daily)) = g.exact(self, self.today, false) else {
                    continue;
                };
                (
                    g.target,
                    overall["progress"].as_f64().unwrap_or(0.),
                    daily["expired"] == true,
                )
            } else if fixed {
                let value = self
                    .stats(&g.query(self)?, self.today, self.today, self.today)?
                    .today;
                (g.target, value, false)
            } else {
                let (Ok(start), Ok(end)) = (str_date(g.start), str_date(g.end)) else {
                    continue;
                };
                if self.today < start {
                    continue;
                }
                let total = self
                    .stats(&g.query(self)?, start, end.min(self.today), self.today)?
                    .total;
                (g.target, total, end < self.today)
            };
            let met = value >= target;
            if !met && !expired {
                continue;
            }
            count += usize::from(met);
            let dates = !custom && !fixed;
            rows.push(json!({"goal_id":id,"goal_name":fallback(params,"name","Unknown Goal"),"goal_icon":fallback(params,"icon","🎯"),
                "metric_type":g.name,"media_type":fallback(params,"mediaType","ALL"),"target_value":if g.timed(){json!(target)}else{formatted(target,g.metric)},
                "current_progress":formatted(value,g.metric),"completion_percentage":format!("{:.1}",value/target*100.).parse::<f64>()?,
                "start_date":dates.then_some(g.start),"end_date":dates.then_some(g.end),"is_static":fixed,"is_custom":custom,
                "completed_today":custom||fixed,"achieved":met,"expired":expired}));
        }
        Ok(json!({"achieved_goals":rows,"total_achieved":count}))
    }
}
impl Reports {
    /// Evaluate the last active day before today so a late reading session earns its snapshot.
    pub fn scheduled_goals(&self, generation: u64) -> Result<bool> {
        let Some(current) = self.history.current_goals(&self.database, true)? else {
            return Ok(true);
        };
        let zone = current["goals_settings"]["timezone"]
            .as_str()
            .and_then(|s| TimeZone::get(s).ok())
            .unwrap_or_else(TimeZone::system);
        let ctx = Context::new(self, zone)?;
        if ctx.prefs.cleaner.is_none() {
            return Ok(false);
        }
        let previous = self
            .history
            .goal_cron_last_run(&self.database)?
            .and_then(|v| Timestamp::from_microsecond((v * 1e6) as i64).ok())
            .and_then(|t| naive(t.to_zoned(ctx.zone.clone()).date()).ok())
            .filter(|day| *day < ctx.today);
        for date in previous.into_iter().chain(std::iter::once(ctx.today)) {
            if self.history.goals_completed_on(&self.database, date)? {
                continue;
            }
            let Some(source) = self.history.current_goals(&self.database, true)? else {
                return Ok(true);
            };
            let evaluated = ctx.goals_for_date(&source, date)?;
            let rows = evaluated["goals"].as_array().ok_or("Missing daily goals")?;
            if !rows.is_empty()
                && rows.iter().all(|v| {
                    v["progress_today"]
                        .as_f64()
                        .zip(v["progress_needed"].as_f64())
                        .is_some_and(|(progress, target)| progress >= target)
                })
                && !self.history.complete_scheduled_goals(
                    &self.database,
                    generation,
                    date,
                    &source,
                )?
            {
                return Ok(false);
            }
        }
        Ok(true)
    }
    pub fn tomorrow_goals(&self, body: &Value, timezone: Option<&str>) -> Option<Reply> {
        if !body.as_object().is_some_and(|m| !m.is_empty()) {
            return Some(Reply::error(400, "No data provided"));
        }
        let ctx = match Context::new(self, goal_zone(timezone)) {
            Ok(ctx) => ctx,
            Err(e) => return Some(Reply::error(500, &e.to_string())),
        };
        ctx.prefs.cleaner.as_ref()?;
        Some(match ctx.tomorrow(body) {
            Ok(body) => Reply { status: 200, body },
            Err(_) => Reply::error(500, "Failed to calculate tomorrow's requirements"),
        })
    }
}
