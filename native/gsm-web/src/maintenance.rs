use crate::{Reply, Reports};
use gsm_history::{
    reports::{DeduplicateQuery, DuplicateQuery, LineRemoval, TextDeletionQuery},
    Request,
};
use serde_json::Value;

#[derive(Clone, Copy)]
pub enum Maintenance {
    PreviewText,
    PreviewDuplicates,
    SearchDuplicates,
    DeleteText,
    Deduplicate,
    DeduplicateEntireGame,
    DeleteSelected,
    PreviewArchive,
    StripRegex,
}

enum Operation {
    Read(Request),
    Remove(LineRemoval),
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(v) => !v.is_empty(),
        Value::Object(v) => !v.is_empty(),
    }
}

impl Maintenance {
    pub fn route(path: &str) -> Option<Self> {
        Some(match path {
            "/api/delete-regex-in-game-lines" => Self::StripRegex,
            "/api/preview-text-deletion" => Self::PreviewText,
            "/api/preview-deduplication" => Self::PreviewDuplicates,
            "/api/search-duplicates" => Self::SearchDuplicates,
            "/api/delete-text-lines" => Self::DeleteText,
            "/api/deduplicate" => Self::Deduplicate,
            "/api/deduplicate-entire-game" => Self::DeduplicateEntireGame,
            "/api/delete-sentence-lines" => Self::DeleteSelected,
            "/api/games/archive/preview" => Self::PreviewArchive,
            _ => return None,
        })
    }

    fn query(self, body: &Value) -> Result<Operation, &'static str> {
        if matches!(self, Self::DeleteSelected) {
            let ids = &body["line_ids"];
            if !truthy(ids) {
                return Err("No line IDs provided");
            }
            let ids = ids
                .as_array()
                .ok_or("line_ids must be a list")?
                .iter()
                .filter(|v| truthy(v))
                .map(|v| match v {
                    Value::String(s) => Ok(s.clone()),
                    Value::Number(n) => Ok(n.to_string()),
                    Value::Bool(true) => Ok("1".into()),
                    _ => Err("Invalid sentence ID"),
                })
                .collect::<Result<_, _>>()?;
            return Ok(Operation::Remove(LineRemoval::Ids(ids)));
        }
        if body.as_object().is_none_or(|map| map.is_empty()) {
            return Err("No data provided");
        }
        let case_sensitive = truthy(&body["case_sensitive"]);
        if matches!(self,Self::StripRegex) {
            let pattern = body["regex_pattern"].as_str().filter(|s| !s.is_empty()).ok_or("Regex pattern is required")?;
            return Ok(Operation::Remove(LineRemoval::StripRegex {pattern:pattern.to_owned(),case_sensitive}));
        }
        if matches!(self, Self::PreviewText | Self::DeleteText) {
            let pattern = &body["regex_pattern"];
            let exact = &body["exact_text"];
            let use_regex = truthy(&body["use_regex"]);
            if !truthy(pattern) && !truthy(exact) {
                return Err("Either regex_pattern or exact_text must be provided");
            }
            if use_regex && truthy(pattern) && !pattern.is_string() {
                return Err("Regex pattern must be a string");
            }
            let exact_text = match exact {
                Value::String(s) => vec![s.clone()],
                Value::Array(items) => items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect(),
                _ if !truthy(exact) || (use_regex && truthy(pattern)) => Vec::new(),
                _ => return Err("exact_text must be a string or list of strings"),
            };
            let query = TextDeletionQuery {
                regex_pattern: pattern.as_str().map(str::to_owned),
                exact_text,
                case_sensitive,
                use_regex,
            };
            return Ok(if matches!(self, Self::DeleteText) {
                Operation::Remove(LineRemoval::Text(query))
            } else {
                Operation::Read(Request::PreviewTextDeletion(query))
            });
        }
        let time_window_minutes = match body.get("time_window_minutes") {
            None => 5.0,
            Some(v) => v
                .as_f64()
                .or_else(|| v.as_str()?.trim().parse().ok())
                .filter(|n| n.is_finite())
                .ok_or("Invalid time window")?,
        };
        let ignore_time_window =
            matches!(self, Self::DeduplicateEntireGame) || truthy(&body["ignore_time_window"]);
        if matches!(self, Self::SearchDuplicates) {
            let game = body["game"]
                .as_str()
                .filter(|v| !v.is_empty())
                .map(str::to_owned);
            Ok(Operation::Read(Request::SearchDuplicates(DuplicateQuery {
                game,
                time_window_minutes,
                case_sensitive,
                ignore_time_window,
            })))
        } else {
            let games = body["games"]
                .as_array()
                .filter(|v| !v.is_empty())
                .ok_or("At least one game must be selected")?;
            let games = games
                .iter()
                .map(|g| {
                    g.as_str()
                        .map(str::to_owned)
                        .ok_or("Game names must be strings")
                })
                .collect::<Result<_, _>>()?;
            let query = DeduplicateQuery {
                games,
                time_window_minutes,
                case_sensitive,
                ignore_time_window,
                preserve_newest: truthy(&body["preserve_newest"]),
            };
            Ok(if matches!(self, Self::PreviewDuplicates) {
                Operation::Read(Request::PreviewDeduplication(query))
            } else {
                Operation::Remove(LineRemoval::Duplicates(query))
            })
        }
    }
}

impl Reports {
    pub fn save_maintenance_settings(&self, body: Value) -> Reply {
        if std::env::var("GSM_DB_READ_ONLY").as_deref() == Ok("1") {
            return Reply::error(403, "Database is read-only");
        }
        let Some(fields) = body.as_object().filter(|m| {
            m.keys()
                .all(|key| matches!(key.as_str(), "vacuum_interval_days" | "archive_after_days"))
        }) else {
            return Reply::error(400, "Expected vacuum_interval_days and archive_after_days");
        };
        for (key, value) in fields {
            if !value.as_i64().is_some_and(|v| (0..=3650).contains(&v)) {
                return Reply::error(
                    400,
                    &format!("{key} must be a whole number between 0 and 3650 (0 disables it)"),
                );
            }
        }
        match self.history.save_maintenance_settings(
            &self.database,
            body["vacuum_interval_days"].as_i64(),
            body["archive_after_days"].as_i64(),
        ) {
            Ok(settings) => Reply {
                status: 200,
                body: serde_json::json!({"settings":settings}),
            },
            Err(e) => Reply::error(500, &e.to_string()),
        }
    }

    fn preview_archive(&self, body: &Value) -> Reply {
        match self.selected_games(body) {
            Ok(games) => Reply {
                status: 200,
                body: serde_json::json!({"game_count":games.len(),"raw_lines":games.iter().map(|g|g.raw_lines).sum::<i64>()}),
            },
            Err(reply) => reply,
        }
    }

    pub(super) fn selected_games(
        &self,
        body: &Value,
    ) -> Result<Vec<gsm_history::reports::ArchiveCandidate>, Reply> {
        let error = "Select between 1 and 1000 games using their game IDs";
        let Some(items) = body["game_ids"]
            .as_array()
            .filter(|v| (1..=1000).contains(&v.len()))
        else {
            return Err(Reply::error(400, error));
        };
        let mut seen = std::collections::HashSet::new();
        let mut ids = Vec::with_capacity(items.len());
        for item in items {
            let Some(id) = item
                .as_str()
                .filter(|s| !s.trim().is_empty() && s.chars().count() <= 512)
            else {
                return Err(Reply::error(400, error));
            };
            if seen.insert(id) {
                ids.push(id);
            }
        }
        match self.history.selected_archive_games(&self.database, &ids) {
            Ok(Some(games)) => Ok(games),
            Ok(None) => Err(Reply::error(
                400,
                "Some selected games no longer exist. Refresh the games list and try again.",
            )),
            Err(e) => Err(Reply::error(500, &e.to_string())),
        }
    }
    /// None delegates an expression to the compatibility engine before any
    /// modification has committed.
    pub fn maintenance(&self, operation: Maintenance, body: Value) -> Option<Reply> {
        if matches!(operation, Maintenance::PreviewArchive) {
            return Some(self.preview_archive(&body));
        }
        let request = match operation.query(&body) {
            Ok(query) => query,
            Err(error) => return Some(Reply::error(400, error)),
        };
        let remove = match request {
            Operation::Remove(remove) => remove,
            Operation::Read(read) => {
                return match self.history.run(&self.database, read) {
                    Ok(body) if body["fallback"] == "invalidRegex" => Some(Reply::error(400, "Invalid regex pattern")),
                    Ok(body) => Some(Reply { status: 200, body }),
                    Err(e) => Some(Reply::error(500, &e.to_string())),
                }
            }
        };
        if std::env::var("GSM_DB_READ_ONLY").as_deref() == Ok("1") {
            return Some(Reply::error(500, "Database is read-only"));
        }
        let prefs = match self.preferences() {
            Ok(prefs) => prefs,
            Err(e) => return Some(Reply::error(500, &e.to_string())),
        };
        let cleaner = prefs.cleaner.as_ref()?;
        let result = self.history.remove_lines(&self.database, remove, cleaner, prefs.gap, prefs.tokenization);
        match result {
            Ok(Some(summary)) => {
                let n = summary.deleted_count;
                if matches!(operation,Maintenance::StripRegex) {return Some(Reply {status:200,body:serde_json::json!({"updated_count":n})});}
                let message = match operation {
                    Maintenance::DeleteText => format!("Successfully deleted {n} lines"),
                    Maintenance::DeleteSelected => format!(
                        "Successfully deleted {n} {}",
                        if n == 1 { "sentence" } else { "sentences" }
                    ),
                    _ => format!("Successfully removed {n} duplicate sentences"),
                };
                let mut body = serde_json::json!({"deleted_count":n,"message":message});
                if !summary.failed_ids.is_empty() {
                    body["warning"] =
                        format!("{} lines failed to delete", summary.failed_ids.len()).into();
                    body["failed_ids"] = summary.failed_ids.into();
                }
                Some(Reply { status: 200, body })
            }
            Ok(None) => Some(Reply::error(400, "Invalid regex pattern")),
            Err(e) => Some(Reply::error(500, &e.to_string())),
        }
    }
}
