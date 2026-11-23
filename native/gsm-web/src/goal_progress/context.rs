use super::*;
use gsm_history::goal_metrics::CalendarProgress;
use std::{cell::RefCell, collections::HashMap};

#[derive(Hash, PartialEq, Eq)]
enum Target {
    All,
    Media(String),
    Game(String, String),
}
#[derive(Hash, PartialEq, Eq)]
struct Selection {
    metric: Metric,
    target: Target,
    deck: String,
}
impl From<&Query<'_>> for Selection {
    fn from(q: &Query<'_>) -> Self {
        Self {
            metric: q.metric,
            target: match q.scope {
                Scope::All => Target::All,
                Scope::Media(s) => Target::Media(s.into()),
                Scope::Game { id, name } => Target::Game(id.into(), name.into()),
            },
            deck: q.deck.into(),
        }
    }
}
#[derive(Default)]
pub(super) struct Cache {
    values: RefCell<HashMap<(Selection, NaiveDate, NaiveDate, NaiveDate), CalendarProgress>>,
    rates: RefCell<HashMap<Selection, f64>>,
}
impl Context<'_> {
    fn dates(&self, start: NaiveDate, end: NaiveDate, day: NaiveDate) -> Result<CalendarRange> {
        let next = day.succ_opt().ok_or("Invalid goal date")?;
        Ok(CalendarRange {
            start,
            end,
            today: day,
            day_start: seconds(self.midnight(day)?),
            day_end: seconds(self.midnight(next)?),
        })
    }
    pub(super) fn stats(
        &self,
        q: &Query<'_>,
        start: NaiveDate,
        end: NaiveDate,
        day: NaiveDate,
    ) -> Result<CalendarProgress> {
        let key = (Selection::from(q), start, end, day);
        if let Some(value) = self.cache.values.borrow().get(&key) {
            return Ok(*value);
        }
        let range = self.dates(start, end, day)?;
        let value = self
            .reports
            .history
            .calendar_goal_values(&self.reports.database, q, &range)?;
        self.cache.values.borrow_mut().insert(key, value);
        Ok(value)
    }
    pub(super) fn rate(&self, q: &Query<'_>) -> Result<f64> {
        let key = Selection::from(q);
        if let Some(value) = self.cache.rates.borrow().get(&key) {
            return Ok(*value);
        }
        let range = self.dates(self.today, self.today, self.today)?;
        let value = self
            .reports
            .history
            .goal_daily_rate(&self.reports.database, q, &range)?;
        self.cache.rates.borrow_mut().insert(key, value);
        Ok(value)
    }
}
