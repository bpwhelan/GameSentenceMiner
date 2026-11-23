use super::{affected_dates, Outcome};
use crate::{rollup, History, ReportCleaner, Result};
use chrono::NaiveDate;
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::Path,
};

pub enum SceneEdit {
    Migrate { ids: Vec<Value>, target: String },
    Delete(Vec<String>),
    Merge { names: Vec<String>, target: String },
}

fn target_owner(tx: &Transaction, target: &str) -> Result<Option<String>> {
    Ok(tx
        .query_row(
            "SELECT game_id FROM game_lines WHERE game_name=? AND game_id!='' LIMIT 1",
            [target],
            |row| row.get(0),
        )
        .optional()?)
}

fn migrate_rows(
    tx: &mut Transaction,
    ids: &[String],
    target: &str,
    owner: &Option<String>,
) -> Result<(HashSet<String>, BTreeSet<NaiveDate>)> {
    let batch = tx.savepoint()?;
    let mut moved = HashSet::new();
    let mut dates = BTreeSet::new();
    {
        let mut q=batch.prepare_cached("UPDATE game_lines SET original_game_name=coalesce(original_game_name,game_name),game_name=?1,game_id=?2
            WHERE id IN (SELECT value FROM json_each(?3)) RETURNING id,date(timestamp,'unixepoch','localtime')")?;
        let mut rows = q.query(params![target, owner, serde_json::to_string(ids)?])?;
        while let Some(row) = rows.next()? {
            moved.insert(row.get(0)?);
            if let Some(day) = row.get::<_, Option<String>>(1)? {
                dates.insert(day.parse()?);
            }
        }
    }
    batch.commit()?;
    Ok((moved, dates))
}

fn migrate(
    tx: &mut Transaction,
    ids: Vec<Value>,
    target: String,
    dates: &mut BTreeSet<NaiveDate>,
) -> Result<Outcome> {
    let owner = target_owner(tx, &target)?;
    let mut failed = Vec::new();
    let mut count = 0;
    for chunk in ids.chunks(500) {
        let keys = chunk
            .iter()
            .map(|v| match v {
                Value::String(s) => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                Value::Bool(b) => Some(i32::from(*b).to_string()),
                _ => None,
            })
            .collect::<Vec<_>>();
        let valid = keys.iter().flatten().cloned().collect::<Vec<_>>();
        let (moved, changed) = match migrate_rows(tx, &valid, &target, &owner) {
            Ok(summary) => summary,
            Err(_) if !tx.is_autocommit() => {
                let mut moved = HashSet::new();
                let mut dates = BTreeSet::new();
                for key in &valid {
                    match migrate_rows(tx, std::slice::from_ref(key), &target, &owner) {
                        Ok((ids, days)) => {
                            moved.extend(ids);
                            dates.extend(days);
                        }
                        Err(_) if !tx.is_autocommit() => {}
                        Err(e) => return Err(e),
                    }
                }
                (moved, dates)
            }
            Err(e) => return Err(e),
        };
        dates.extend(changed);
        for (value, key) in chunk.iter().zip(keys) {
            if key.is_some_and(|key| moved.contains(&key)) {
                count += 1;
            } else {
                failed.push(value.clone());
            }
        }
    }
    let plural = if count == 1 { "" } else { "s" };
    let mut body = json!({"migrated_count":count,"message":format!("Successfully migrated {count} line{plural} to '{target}'"),"target_game":target});
    if !failed.is_empty() {
        body["warning"] = format!("{} lines failed to migrate", failed.len()).into();
        body["failed_ids"] = failed.into();
    }
    Ok(Outcome::Saved(body))
}

fn record_ids(tx: &Transaction, name: &str) -> Result<HashSet<String>> {
    let mut q=tx.prepare_cached("SELECT game_id FROM game_lines WHERE game_name=?1 AND game_id!=''
        UNION SELECT id FROM games WHERE title_original=?1 OR obs_scene_name=?1 OR title_romaji=?1 OR title_english=?1")?;
    let rows = q.query_map([name], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn delete_rows(tx: &mut Transaction, name: &str) -> Result<(u64, BTreeSet<NaiveDate>)> {
    let point = tx.savepoint()?;
    let mut count = 0;
    let mut dates = BTreeSet::new();
    {
        let mut q=point.prepare_cached("DELETE FROM game_lines WHERE game_name=? RETURNING date(timestamp,'unixepoch','localtime')")?;
        let mut rows = q.query([name])?;
        while let Some(row) = rows.next()? {
            count += 1;
            if let Some(day) = row.get::<_, Option<String>>(0)? {
                dates.insert(day.parse()?);
            }
        }
    }
    point.commit()?;
    Ok((count, dates))
}

fn delete(
    tx: &mut Transaction,
    names: Vec<String>,
    dates: &mut BTreeSet<NaiveDate>,
) -> Result<Outcome> {
    let mut ids = HashMap::new();
    let mut missing = Vec::new();
    for name in &names {
        let owners = record_ids(tx, name)?;
        if owners.is_empty()
            && !tx
                .prepare_cached("SELECT 1 FROM game_lines WHERE game_name=? LIMIT 1")?
                .exists([name])?
        {
            missing.push(name.as_str());
        }
        ids.insert(name.clone(), owners);
    }
    if !missing.is_empty() {
        return Ok(Outcome::Invalid(format!(
            "Games not found: {}",
            missing.join(", ")
        )));
    }
    let mut details = Map::new();
    let mut success = Vec::new();
    let mut failed = Vec::new();
    let mut remove = HashSet::new();
    let mut keep = HashSet::new();
    let mut total = 0;
    for name in names {
        let Some(owners) = ids.remove(&name) else {
            continue;
        };
        match delete_rows(tx, &name) {
            Ok((count, changed)) => {
                total += count;
                dates.extend(changed);
                remove.extend(owners);
                details.insert(
                    name.clone(),
                    json!({"deleted_sentences":count,"status":"success"}),
                );
                success.push(name);
            }
            Err(e) if !tx.is_autocommit() => {
                keep.extend(owners);
                details.insert(
                    name.clone(),
                    json!({"deleted_sentences":0,"status":"error","error":e.to_string()}),
                );
                failed.push(name);
            }
            Err(e) => return Err(e),
        }
    }
    let mut removed = 0;
    for id in remove.difference(&keep) {
        dates.extend(affected_dates(tx, id)?);
        removed += tx
            .prepare_cached("DELETE FROM games WHERE id=?")?
            .execute([id])?;
    }
    let mut body = json!({"message":format!("Deletion completed. {} games successfully deleted.",success.len()),
        "total_sentences_deleted":total,"deleted_game_records":removed,"successful_games":success,"failed_games":failed,"detailed_results":details});
    if !failed.is_empty() {
        body["warning"] = format!("Some games failed to delete: {}", failed.join(", ")).into();
    }
    Ok(Outcome::Saved(body))
}

impl History {
    pub fn edit_scenes(
        &self,
        path: &Path,
        edit: SceneEdit,
        cleaner: &ReportCleaner,
        gap: f64,
        tokenized: bool,
    ) -> Result<Outcome> {
        self.with_writer(path, |conn| {
            let mut tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut dates = BTreeSet::new();
            let out = match edit {
                SceneEdit::Migrate { ids, target } => migrate(&mut tx, ids, target, &mut dates)?,
                SceneEdit::Delete(names) => delete(&mut tx, names, &mut dates)?,
                SceneEdit::Merge { names, target } => merge(&tx, names, target, &mut dates)?,
            };
            rollup::replace_dates(&tx, dates, cleaner, gap, tokenized)?;
            tx.commit()?;
            Ok(out)
        })
    }
}

fn merge(
    tx: &Transaction,
    names: Vec<String>,
    target: String,
    dates: &mut BTreeSet<NaiveDate>,
) -> Result<Outcome> {
    let unique = names.iter().collect::<HashSet<_>>().len() == names.len();
    let mut owners = Vec::new();
    let mut target_ids = HashSet::new();
    let mut with_archives = false;
    if tx
        .prepare_cached("SELECT 1 FROM archived_game_days LIMIT 1")?
        .exists([])?
    {
        target_ids = record_ids(tx, &target)?;
        owners = names
            .iter()
            .map(|name| record_ids(tx, name))
            .collect::<Result<_>>()?;
        let mut query = tx.prepare_cached(
            "SELECT 1 FROM archived_game_days WHERE game_id=? AND line_count>0 LIMIT 1",
        )?;
        for id in owners.iter().flatten().chain(&target_ids) {
            if query.exists([id])? {
                with_archives = true;
                break;
            }
        }
    }
    let mut moved = 0;
    let total;
    let message;
    if with_archives {
        if !unique || names.contains(&target) {
            return Ok(Outcome::Invalid(
                "Choose distinct source games and a separate target game".into(),
            ));
        }
        let all = owners.iter().flatten().collect::<HashSet<_>>();
        if target_ids.len() != 1 || owners.iter().any(|s| s.len() != 1) || all.len() != names.len()
        {
            return Ok(Outcome::Invalid(
                "Choose existing games with distinct names to merge archived statistics".into(),
            ));
        }
        let id = target_ids.iter().next().unwrap();
        if all.contains(id) {
            return Ok(Outcome::Invalid(
                "A game cannot be merged into itself".into(),
            ));
        }
        for source in owners.iter().flatten() {
            moved += crate::game_archive::merge_into(tx, source, id, &target, dates)?;
            let mut q=tx.prepare_cached("UPDATE game_lines SET original_game_name=coalesce(original_game_name,game_name),
                game_id=?1,game_name=?2 WHERE game_id=?3 RETURNING date(timestamp,'unixepoch','localtime')")?;
            let mut rows = q.query(params![id, target, source])?;
            while let Some(row) = rows.next()? {
                moved += 1;
                if let Some(day) = row.get::<_, Option<String>>(0)? {
                    dates.insert(day.parse()?);
                }
            }
        }
        total = tx.query_row(
            "SELECT (SELECT count(*) FROM game_lines WHERE game_id=?1)
            +(SELECT coalesce(sum(line_count),0) FROM archived_game_days WHERE game_id=?1)",
            [id],
            |r| r.get::<_, u64>(0),
        )?;
        message = "Game history merged".to_owned();
    } else {
        let mut check = tx.prepare_cached("SELECT 1 FROM game_lines WHERE game_name=? LIMIT 1")?;
        let mut missing = Vec::new();
        for name in &names {
            if !check.exists([name])? {
                missing.push(name.as_str());
            }
        }
        if !missing.is_empty() {
            return Ok(Outcome::Invalid(format!(
                "Games not found: {}",
                missing.join(", ")
            )));
        }
        if !unique {
            return Ok(Outcome::Invalid(
                "Duplicate game names found in selection".into(),
            ));
        }
        let owner = target_owner(tx, &target)?;
        let before = tx.query_row(
            "SELECT count(*) FROM game_lines WHERE game_name=?",
            [&target],
            |r| r.get::<_, u64>(0),
        )?;
        let mut update=tx.prepare_cached("UPDATE game_lines SET original_game_name=coalesce(original_game_name,game_name),
            game_name=?1,game_id=?2 WHERE game_name IN(SELECT value FROM json_each(?3)) RETURNING date(timestamp,'unixepoch','localtime')")?;
        let mut rows = update.query(params![target, owner, serde_json::to_string(&names)?])?;
        while let Some(row) = rows.next()? {
            moved += 1;
            if let Some(day) = row.get::<_, Option<String>>(0)? {
                dates.insert(day.parse()?);
            }
        }
        total = before + moved;
        message = format!(
            "Successfully merged {} games into \"{target}\"",
            names.len()
        );
    }
    Ok(Outcome::Saved(
        json!({"message":message,"primary_game":target,"merged_games":names,
        "lines_moved":moved,"total_lines_in_primary":total,"merge_summary":{"primary_game":target,
            "secondary_games":names,"lines_moved":moved,"total_lines_after_merge":total}}),
    ))
}
