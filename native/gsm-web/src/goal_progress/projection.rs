use super::*;

impl Goal<'_> {
    pub(super) fn projection(
        &self,
        ctx: &Context<'_>,
        overall: Option<&Value>,
    ) -> std::result::Result<Value, Reply> {
        if self.name == "finish_game" || !self.valid_metric() {
            return Err(Reply::error(400, ALLOWED));
        }
        let failure = |_: Box<dyn std::error::Error + Send + Sync>| {
            Reply::error(500, "Failed to calculate projection")
        };
        let timed = self.timed();
        let mut query = self.query(ctx).map_err(failure)?;
        if matches!(query.scope, Scope::Game { .. }) {
            if timed {
                return Err(Reply::error(400, "Invalid timed goal"));
            }
            query.scope = Scope::All;
        }
        let pace = if self.name.ends_with("_static") || (timed && self.metric == Metric::Backlog) {
            0.
        } else {
            ctx.rate(&query).map_err(failure)?
        };
        let (current, days, projected) = if timed {
            let value = if let Some(v) = overall {
                v["progress"].as_f64().unwrap_or(0.)
            } else {
                self.exact(ctx, ctx.today, false)
                    .map_err(|e| Reply::error(400, &e.to_string()))?
                    .0["progress"]
                    .as_f64()
                    .unwrap_or(0.)
            };
            let invalid = |e: &str| Reply::error(400, e);
            let start = bound(Some(self.start), &ctx.zone, false).map_err(invalid)?;
            let end = bound(Some(self.end), &ctx.zone, true).map_err(invalid)?;
            let days = (duration(ctx.now.max(start), end) / 86400.).max(0.);
            (value, json!(days), value + pace * days)
        } else {
            let start = str_date(self.start)?;
            let end = str_date(self.end)?;
            let future = ctx.today < start;
            let days = if future {
                (end - start).num_days() + 1
            } else {
                (end - ctx.today).num_days()
            };
            let current = if future {
                0.
            } else {
                ctx.stats(&query, start, ctx.today, ctx.today)
                    .map_err(failure)?
                    .total
            };
            let change = pace * days as f64;
            let projected = if self.metric == Metric::Backlog && !future {
                (current - change).max(0.)
            } else {
                current + change
            };
            (current, json!(days), projected)
        };
        let diff = if self.target > 0. {
            let sign = if self.metric == Metric::Backlog && !timed {
                -1.
            } else {
                1.
            };
            sign * (projected - self.target) / self.target * 100.
        } else if self.metric == Metric::Backlog && current > 0. && !timed {
            (current - projected) / current * 100.
        } else {
            0.
        };
        Ok(
            json!({"projection":formatted(projected,self.metric),"target":self.target,"current":formatted(current,self.metric),
            "daily_average":formatted(pace,self.metric),"end_date":self.end,"days_until_target":days,"percent_difference":formatted(diff,Metric::Hours)}),
        )
    }
}
