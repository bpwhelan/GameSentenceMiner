//! Manual library edits share the capture writer, including the link from a
//! newly created game to earlier sentences recorded under its original title.
use crate::{game_stats::GAME_STATUS_VALUES, History, Result};
use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension,
    TransactionBehavior,
};
use serde_json::{json, Value};
use std::path::Path;
mod scenes;
mod metadata;
pub use metadata::{igdb_slug, CharacterSource, MetadataLink, MetadataProvider, RefreshGame, RefreshPlan, RepullSources, RepullTarget};
pub use scenes::SceneEdit;

pub enum Edit {
    Create,
    Update(String),
    Complete(String),
}

#[derive(Clone, Copy)]
pub enum Removal {
    Unlink,
    DeleteLines,
}

pub enum Outcome {
    Saved(Value),
    Invalid(String),
    Missing,
}

pub(super) fn orphaned(conn: &mut Connection) -> Result<Value> {
    let tx = conn.transaction()?;
    let managed: i64 = tx.query_row(
        "SELECT COUNT(*) FROM (SELECT DISTINCT title_original FROM games)",
        [],
        |r| r.get(0),
    )?;
    let mut query = tx.prepare(
        "SELECT json_object('game_name',game_name,'line_count',count(*),'character_count',
             coalesce(sum(length(line_text)),0),'first_seen',min(timestamp),'last_seen',max(timestamp))
         FROM game_lines WHERE game_name!='' AND game_name NOT IN
             (SELECT title_original FROM games WHERE title_original IS NOT NULL)
         GROUP BY game_name ORDER BY coalesce(sum(length(line_text)),0) DESC,game_name"
    )?;
    let mut rows = query.query([])?;
    let mut games = Vec::new();
    while let Some(row) = rows.next()? {
        games.push(serde_json::from_str::<Value>(row.get_ref(0)?.as_str()?)?);
    }
    Ok(json!({"total_orphaned":games.len(),"total_managed":managed,"orphaned_games":games}))
}

fn valid_status(v: &Value) -> bool {
    v.as_str().is_some_and(|s| GAME_STATUS_VALUES.contains(&s))
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Bool(v) => *v,
        Value::Null => false,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn stored(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => i64::from(*b).into(),
        Value::String(s) => s.clone().into(),
        _ => v.to_string().into(),
    }
}

fn create(tx: &Connection, input: &Value) -> Result<Outcome> {
    let title = input["title_original"].as_str().unwrap_or("").trim();
    if title.is_empty() {
        return Ok(Outcome::Invalid("title_original is required".into()));
    }
    let status = &input["status"];
    if !status.is_null() && !valid_status(status) {
        return Ok(Outcome::Invalid("Unknown game status".into()));
    }
    if tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM games WHERE title_original=?)",
        [title],
        |r| r.get::<_, bool>(0),
    )? {
        return Ok(Outcome::Invalid(format!(
            "Game with title \"{title}\" already exists"
        )));
    }
    let text = |key: &str| input[key].as_str().unwrap_or("");
    let completed = if status.is_null() {
        truthy(&input["completed"])
    } else {
        status == "completed"
    };
    let id = uuid::Uuid::new_v4().to_string();
    let links = if truthy(&input["links"]) {
        stored(&input["links"])
    } else {
        SqlValue::Text("[]".into())
    };
    tx.execute("INSERT INTO games(id,title_original,title_romaji,title_english,type,description,image,difficulty,links,completed,status,
          character_count,release_date,manual_overrides,obs_scene_name,genres,tags,vndb_id,anilist_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,0,'','[]','','[]','[]','','')", params![id,title,text("title_romaji"),text("title_english"),
          text("type"),text("description"),text("image"),stored(&input["difficulty"]),links,completed,text("status")])?;
    let linked = tx.execute(
        "UPDATE game_lines SET game_id=? WHERE game_name=? AND (game_id IS NULL OR game_id='')",
        params![id, title],
    )?;
    let effective = status.as_str().unwrap_or(if completed {
        "completed"
    } else {
        "in_progress"
    });
    Ok(Outcome::Saved(
        json!({"success":true,"message":format!("Game \"{title}\" created successfully"),"game":{
            "id":id,"title_original":title,"title_romaji":text("title_romaji"),"title_english":text("title_english"),
            "type":text("type"),"status":effective,"jiten_character_count":0,"lines_linked":linked
        }}),
    ))
}

// Response order follows the form. Override ordering follows the stored game
// model, including its historical distinction between "type" and "game_type".
const FORM_FIELDS: &[&str] = &[
    "title_original",
    "title_romaji",
    "title_english",
    "type",
    "description",
    "difficulty",
    "completed",
    "status",
    "deck_id",
    "vndb_id",
    "anilist_id",
    "character_count",
    "image",
    "links",
    "release_date",
    "genres",
    "tags",
    "character_summary",
];
const MODEL_FIELDS: &[&str] = &[
    "deck_id",
    "title_original",
    "title_romaji",
    "title_english",
    "type",
    "description",
    "image",
    "character_count",
    "difficulty",
    "links",
    "completed",
    "release_date",
    "genres",
    "tags",
    "character_summary",
    "vndb_id",
    "anilist_id",
    "status",
];

fn field_value(key: &str, input: &Value) -> Option<Value> {
    let value = input.get(key)?;
    Some(match key {
        "links" if value == "" => json!([]),
        "links" if !value.is_array() => return None,
        "completed" => json!(truthy(value)),
        "deck_id" | "difficulty" | "character_count" if value == "" => Value::Null,
        "vndb_id" if truthy(value) => {
            let raw = value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string());
            let id = raw.trim();
            json!(if id.is_empty() || id.starts_with('v') {
                id.to_owned()
            } else {
                format!("v{id}")
            })
        }
        _ => value.clone(),
    })
}

fn update(tx: &Connection, id: &str, input: &Value) -> Result<Outcome> {
    let existing=tx.query_row("SELECT coalesce(status,''),coalesce(completed=1,0),coalesce(manual_overrides,'[]') FROM games WHERE id=?",
        [id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,bool>(1)?,r.get::<_,String>(2)?))).optional()?;
    let Some((status, completed, raw_overrides)) = existing else {
        return Ok(Outcome::Missing);
    };
    if input.get("status").is_some_and(|v| !valid_status(v)) {
        return Ok(Outcome::Invalid("Unknown game status".into()));
    }
    let mut fields = serde_json::Map::new();
    let mut reported = Vec::new();
    for &key in FORM_FIELDS {
        if let Some(value) = field_value(key, input) {
            reported.push(if key == "type" { "game_type" } else { key });
            fields.insert(key.into(), value);
        }
    }
    if reported.is_empty() {
        return Ok(Outcome::Invalid("No valid fields to update".into()));
    }
    let mut overrides: Vec<Value> = serde_json::from_str(&raw_overrides).unwrap_or_default();
    let mut modified = Vec::<(&'static str, SqlValue)>::new();
    let mut set = |key: &'static str, value: SqlValue| {
        if let Some((_, old)) = modified.iter_mut().find(|(k, _)| *k == key) {
            *old = value;
        } else {
            modified.push((key, value));
        }
        if !overrides.iter().any(|v| v == key) {
            overrides.push(json!(key));
        }
    };
    for &key in MODEL_FIELDS {
        let Some(value) = fields.get(key).filter(|v| !v.is_null()) else {
            continue;
        };
        set(key, stored(value));
        if key == "completed" && !fields.contains_key("status") {
            let was_complete = if GAME_STATUS_VALUES.contains(&status.as_str()) {
                status == "completed"
            } else {
                completed
            };
            let now = value == true;
            if now != was_complete || !GAME_STATUS_VALUES.contains(&status.as_str()) {
                set(
                    "status",
                    SqlValue::Text(if now { "completed" } else { "in_progress" }.into()),
                );
            }
        }
        if key == "status" {
            set("completed", i64::from(value == "completed").into());
        }
    }
    if !modified.is_empty() {
        modified.push((
            "manual_overrides",
            serde_json::to_string(&overrides)?.into(),
        ));
        let assignments = modified
            .iter()
            .map(|(key, _)| format!("{key}=?"))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("UPDATE games SET {assignments} WHERE id=?");
        tx.execute(
            &sql,
            params_from_iter(
                modified
                    .into_iter()
                    .map(|(_, v)| v)
                    .chain(std::iter::once(SqlValue::Text(id.into()))),
            ),
        )?;
    }
    Ok(Outcome::Saved(
        json!({"success":true,"message":"Game updated successfully","updated_fields":reported,"manual_overrides":overrides}),
    ))
}

fn complete(tx: &Connection, id: &str) -> Result<Outcome> {
    let title = tx.query_row(
        "UPDATE games SET completed=1,status='completed' WHERE id=? RETURNING coalesce(title_original,'')",
        [id], |r| r.get::<_, String>(0),
    ).optional()?;
    Ok(match title {
        None => Outcome::Missing,
        Some(title) => Outcome::Saved(json!({
            "success":true, "message":format!("Game \"{title}\" marked as completed"),
            "game_id":id, "completed":true, "status":"completed"
        })),
    })
}

fn affected_dates(tx: &Connection, id: &str) -> Result<Vec<chrono::NaiveDate>> {
    // Older profiles may have only the embedded daily summaries. Include
    // those dates even when both source lines and normalized slices are gone.
    let mut query = tx.prepare(
        "SELECT date(timestamp,'unixepoch','localtime') FROM game_lines WHERE game_id=?1 AND timestamp IS NOT NULL
         UNION SELECT date FROM game_daily_rollup WHERE game_id=?1
         UNION SELECT date FROM archived_game_days WHERE game_id=?1
         UNION SELECT date FROM daily_stats_rollup WHERE
           EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(game_activity_data) THEN game_activity_data END) WHERE key=?1)
           OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(games_played_ids) THEN games_played_ids END) WHERE value=?1)"
    )?;
    let rows = query.query_map([id], |r| r.get::<_, Option<String>>(0))?;
    let mut dates = Vec::new();
    for row in rows {
        if let Some(date) = row?.and_then(|s| s.parse().ok()) {
            dates.push(date);
        }
    }
    Ok(dates)
}

impl History {
    pub fn game_cover(&self, path: &Path, id: &str) -> Result<Option<String>> {
        self.with_reader(path, |conn| {
            let mut query = conn.prepare_cached(
                "SELECT image FROM games WHERE id=? AND image IS NOT NULL AND image!=''",
            )?;
            Ok(query.query_row([id], |row| row.get(0)).optional()?)
        })
    }

    pub fn edit_game(&self, path: &Path, edit: Edit, body: &Value) -> Result<Outcome> {
        self.with_writer(path, |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let result = match edit {
                Edit::Complete(id) => complete(&tx, &id)?,
                _ if body.as_object().is_none_or(|m| m.is_empty()) => {
                    Outcome::Invalid("No data provided".into())
                }
                Edit::Create => create(&tx, body)?,
                Edit::Update(id) => update(&tx, &id, body)?,
            };
            tx.commit()?;
            Ok(result)
        })
    }

    pub fn remove_game(
        &self,
        path: &Path,
        id: &str,
        removal: Removal,
        cleaner: Option<&crate::ReportCleaner>,
        gap: f64,
        tokenized: bool,
    ) -> Result<Option<Outcome>> {
        self.with_writer(path, |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let title = tx.query_row("SELECT coalesce(title_original,'') FROM games WHERE id=?", [id], |r| r.get::<_,String>(0)).optional()?;
            let Some(title) = title else { return Ok(Some(Outcome::Missing)) };
            if matches!(removal, Removal::Unlink) && tx.query_row("SELECT EXISTS(SELECT 1 FROM archived_game_days WHERE game_id=? AND line_count>0)",[id],|r|r.get::<_,bool>(0))? {
                tx.execute("UPDATE games SET deck_id=NULL,vndb_id=NULL,anilist_id=NULL,links='[]' WHERE id=?", [id])?;
                tx.commit()?;
                return Ok(Some(Outcome::Saved(json!({"success":true,"game_name":title,"unlinked_lines":0}))));
            }
            let Some(cleaner) = cleaner else {return Ok(None)};
            let dates = affected_dates(&tx, id)?;
            let response = match removal {
                Removal::Unlink => {
                    let count = tx.execute("UPDATE game_lines SET game_id=NULL WHERE game_id=?", [id])?;
                    json!({"success":true,"game_name":title,"unlinked_lines":count,"message":format!("Game \"{title}\" has been unlinked successfully")})
                }
                Removal::DeleteLines => {
                    let count = tx.execute("DELETE FROM game_lines WHERE game_id=?", [id])?;
                    json!({"success":true,"game_name":title,"deleted_lines":count,"message":format!("Game lines for \"{title}\" have been PERMANENTLY DELETED")})
                }
            };
            tx.execute("DELETE FROM games WHERE id=?", [id])?;
            crate::rollup::replace_dates(&tx, dates, cleaner, gap, tokenized)?;
            tx.commit()?;
            Ok(Some(Outcome::Saved(response)))
        })
    }
}
