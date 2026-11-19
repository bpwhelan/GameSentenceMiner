use crate::{stats::table_exists, Result};
use indexmap::IndexMap;
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    parent_tag: String,
    start: Option<i64>,
    end: Option<i64>,
}

#[derive(Default)]
struct Game {
    cards: i64,
    reviews: i64,
    milliseconds: i64,
    notes: IndexMap<i64, NoteReviews>,
}

#[derive(Default)]
struct NoteReviews {
    passed: i64,
    total: i64,
}

impl Game {
    fn averages(&self) -> Result<(Value, Value)> {
        Ok(if self.notes.is_empty() {
            (json!(0), json!(0))
        } else {
            // Format directly at the displayed precision. Multiplying by a
            // power of ten before rounding can change halfway cases.
            let time = self.milliseconds as f64 / self.reviews as f64 / 1000.0;
            let retention_sum: f64 = self
                .notes
                .values()
                .map(|note| note.passed as f64 / note.total as f64)
                .sum();
            let percent = retention_sum / self.notes.len() as f64 * 100.0;
            (
                json!(format!("{time:.2}").parse::<f64>()?),
                json!(format!("{percent:.1}").parse::<f64>()?),
            )
        })
    }

    fn finish(self, name: String) -> Result<Value> {
        let (time, retention) = self.averages()?;
        Ok(
            json!({"game_name":name, "card_count":self.cards, "avg_time_per_card":time,
            "retention_pct":retention, "total_reviews":self.reviews, "mined_lines":0}),
        )
    }
}

impl Report {
    pub(super) fn read(&self, conn: &Connection, grouping: Grouping) -> Result<Value> {
        for table in ["anki_notes", "anki_cards", "anki_reviews"] {
            if !table_exists(conn, table)? {
                return grouped_results(BTreeMap::new(), grouping);
            }
        }
        let prefix = format!("{}::", self.parent_tag);
        // Filter note creation and review time independently. Keep unreviewed
        // cards in card_count. Preserve the first reviewed card's order when
        // summing the per-note retention ratios, including floating point ties.
        let review_bound = match (self.start, self.end) {
            (Some(_), Some(_)) => "AND CAST(r.review_time AS INTEGER) BETWEEN ?1 AND ?2",
            (Some(_), None) => "AND CAST(r.review_time AS INTEGER)>=?1",
            (None, Some(_)) => "AND CAST(r.review_time AS INTEGER)<=?2",
            _ => "",
        };
        let mut stmt = conn.prepare(&format!(
            "SELECT n.tags, CAST(c.note_id AS INTEGER), COUNT(r.card_id),
                COUNT(*) FILTER (WHERE CAST(r.ease AS INTEGER)=1), SUM(CAST(r.time_taken AS INTEGER)), COUNT(r.time_taken)
             FROM anki_cards c JOIN anki_notes n ON n.note_id=c.note_id
             LEFT JOIN anki_reviews r ON r.card_id=c.card_id {review_bound}
             WHERE CAST(n.note_id AS INTEGER) BETWEEN ?1 AND ?2 GROUP BY c.rowid ORDER BY c.rowid"
        ))?;
        let bounds = params![self.start.unwrap_or(i64::MIN), self.end.unwrap_or(i64::MAX)];
        let mut rows = stmt.query(bounds)?;
        let mut games = BTreeMap::<String, Game>::new();
        while let Some(row) = rows.next()? {
            let Some(raw) = row.get_ref(0)?.as_str_or_null()? else {
                continue;
            };
            let tags = match serde_json::from_str::<Value>(raw) {
                Ok(Value::Array(tags)) => tags,
                Err(_) => continue,
                Ok(_) => return Ok(Value::Null),
            };
            let name = match grouping {
                Grouping::Game => {
                    let mut game = None;
                    for tag in &tags {
                        let Some(tag) = tag.as_str() else {
                            return Ok(Value::Null);
                        };
                        if tag.starts_with(&prefix) {
                            game = tag.split("::").nth(1).filter(|s| !s.is_empty());
                            break;
                        }
                    }
                    game
                }
                Grouping::Content => {
                    let mut matches_parent = false;
                    for tag in &tags {
                        let Some(tag) = tag.as_str() else {
                            return Ok(Value::Null);
                        };
                        if tag.starts_with(&self.parent_tag) {
                            matches_parent = true;
                            break;
                        }
                    }
                    matches_parent.then(|| {
                        if tags.iter().any(|t| t == "NSFW") {
                            "nsfw"
                        } else {
                            "sfw"
                        }
                    })
                }
            };
            let Some(name) = name else { continue };
            let game = games.entry(name.to_owned()).or_default();
            game.cards += 1;
            let reviews: i64 = row.get(2)?;
            if reviews > 0 {
                if reviews != row.get::<_, i64>(5)? {
                    return Ok(Value::Null);
                }
                let failed: i64 = row.get(3)?;
                let note = game.notes.entry(row.get(1)?).or_default();
                note.passed += reviews - failed;
                note.total += reviews;
                game.reviews += reviews;
                game.milliseconds += row.get::<_, i64>(4)?;
            }
        }
        grouped_results(games, grouping)
    }
}

#[derive(Clone, Copy)]
pub(super) enum Grouping {
    Game,
    Content,
}

fn grouped_results(mut groups: BTreeMap<String, Game>, grouping: Grouping) -> Result<Value> {
    match grouping {
        Grouping::Game => Ok(Value::Array(
            groups
                .into_iter()
                .map(|(name, g)| g.finish(name))
                .collect::<Result<_>>()?,
        )),
        Grouping::Content => {
            let mut report = json!({});
            for name in ["nsfw", "sfw"] {
                let stats = groups.remove(name).unwrap_or_default();
                let (time, retention) = stats.averages()?;
                report[format!("{name}_retention")] = retention;
                report[format!("{name}_reviews")] = json!(stats.reviews);
                report[format!("{name}_avg_time")] = time;
            }
            Ok(report)
        }
    }
}
