use super::{manifest, records, Manifest, Record};
use crate::{
    maintenance::MaintenancePermit, rollup, stats, word_index, History, ReportCleaner, Result,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use flate2::read::ZlibDecoder;
use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension,
    TransactionBehavior,
};
use serde::de::IgnoredAny;
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs::File,
    io::BufReader,
    path::Path,
    sync::Arc,
};
use zip::ZipArchive;

fn bind(value: &Value) -> Result<SqlValue> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(v) => SqlValue::Integer(i64::from(*v)),
        Value::Number(n) => match n.as_i64() {
            Some(i) => SqlValue::Integer(i),
            None if n.is_f64() => SqlValue::Real(n.as_f64().ok_or("Invalid archive number")?),
            None => return Err("Archive integer is outside SQLite's supported range".into()),
        },
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Object(o) if o.len() == 1 && o.contains_key("$binary") => SqlValue::Blob(
            STANDARD.decode(
                o["$binary"]
                    .as_str()
                    .ok_or("Invalid binary archive value")?,
            )?,
        ),
        _ => return Err("Unsupported archive value".into()),
    })
}

struct InsertTable {
    name: &'static str,
    columns: HashSet<String>,
    fields: Vec<String>,
    sql: String,
}

impl InsertTable {
    fn new(conn: &Connection, name: &'static str) -> Result<Self> {
        let mut stmt = conn.prepare("SELECT name FROM pragma_table_info(?)")?;
        let columns = stmt
            .query_map([name], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(Self {
            name,
            columns,
            fields: Vec::new(),
            sql: String::new(),
        })
    }

    fn insert(&mut self, conn: &Connection, row: &Map<String, Value>) -> Result<()> {
        if self.sql.is_empty()
            || !self.fields.iter().eq(row
                .keys()
                .filter(|k| k.as_str() != "tokenized" || self.columns.contains(*k)))
        {
            self.fields.clear();
            for name in row.keys() {
                if self.columns.contains(name) {
                    self.fields.push(name.clone());
                } else if name != "tokenized" {
                    return Err(
                        "Archive file contains unsupported columns; update GSM before restoring it"
                            .into(),
                    );
                }
            }
            let quoted = self
                .fields
                .iter()
                .map(|s| format!("\"{}\"", s.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(",");
            let params = vec!["?"; self.fields.len()].join(",");
            self.sql = format!("INSERT INTO {} ({quoted}) VALUES ({params})", self.name);
        }
        let values = self
            .fields
            .iter()
            .map(|k| bind(&row[k]))
            .collect::<Result<Vec<_>>>()?;
        conn.prepare_cached(&self.sql)?
            .execute(params_from_iter(values))?;
        Ok(())
    }
}

#[derive(Default)]
struct Ownership {
    days: Vec<(String, chrono::NaiveDate)>,
    owners: HashMap<String, Arc<str>>,
}

impl Ownership {
    fn find(conn: &Connection, ids: &HashSet<String>) -> Result<Self> {
        type EventId = (
            IgnoredAny,
            IgnoredAny,
            IgnoredAny,
            IgnoredAny,
            IgnoredAny,
            IgnoredAny,
            String,
        );
        let mut ownership = Self::default();
        let mut query = conn.prepare("SELECT game_id,date,events FROM archived_game_days")?;
        let mut rows = query.query([])?;
        while let Some(row) = rows.next()? {
            let events: Vec<EventId> = serde_json::from_reader(BufReader::new(ZlibDecoder::new(
                row.get_ref(2)?.as_blob()?,
            )))?;
            let matched = events.iter().filter(|e| ids.contains(&e.6)).count();
            if matched == 0 {
                continue;
            }
            if matched != events.len() {
                return Err("This file contains only part of an archived day, possibly because an earlier file was deleted or games were merged. Download the ZIP to recover its text; automatic restore would double-count statistics.".into());
            }
            let owner: Arc<str> = Arc::from(row.get_ref(0)?.as_str()?);
            ownership
                .days
                .push((owner.to_string(), row.get_ref(1)?.as_str()?.parse()?));
            for event in events {
                if ownership.owners.insert(event.6, owner.clone()).is_some() {
                    return Err("A sentence belongs to multiple archived days".into());
                }
            }
        }
        Ok(ownership)
    }
}

fn restore_tokens(
    conn: &Connection,
    record: &Record,
    time: f64,
    touched: &mut HashSet<i64>,
) -> Result<()> {
    let id = record.id()?;
    for (word, reading, pos, in_anki) in &record.words {
        conn.prepare_cached(
            "INSERT OR IGNORE INTO words(word,reading,pos,in_anki) VALUES(?,?,?,?)",
        )?
        .execute(params![word, reading, pos, bind(in_anki)?])?;
        let wid: i64 = conn
            .prepare_cached("SELECT id FROM words WHERE word=?")?
            .query_row([word], |r| r.get(0))?;
        conn.prepare_cached(
            "INSERT OR IGNORE INTO word_occurrences(word_id,line_id) VALUES (?,?)",
        )?
        .execute(params![wid, id])?;
        conn.prepare_cached(
            "UPDATE words SET last_seen=max(coalesce(CAST(last_seen AS REAL),0),?) WHERE id=?",
        )?
        .execute(params![time, wid])?;
        touched.insert(wid);
    }
    for ch in &record.kanji {
        conn.prepare_cached("INSERT OR IGNORE INTO kanji(character) VALUES(?)")?
            .execute([ch])?;
        conn.prepare_cached("INSERT OR IGNORE INTO kanji_occurrences(kanji_id,line_id) SELECT id,? FROM kanji WHERE character=?")?
            .execute(params![id,ch])?;
    }
    Ok(())
}

impl History {
    pub fn restore_archive(
        &self,
        permit: &MaintenancePermit,
        path: &Path,
        file_id: &str,
        cleaner: &ReportCleaner,
        gap: f64,
        tokenized: bool,
    ) -> Result<Value> {
        let mut zip = ZipArchive::new(File::open(path)?).map_err(|_| super::DAMAGED)?;
        let metadata: Manifest<Map<String, Value>> = manifest(&mut zip, file_id)?;
        let mut ids = HashSet::new();
        let mut has_tokens = false;
        records(&mut zip, |record| {
            if !ids.insert(record.id()?.to_owned()) {
                return Err("Duplicate sentence IDs in archive file".into());
            }
            has_tokens |=
                record.tokens_available || !record.words.is_empty() || !record.kanji.is_empty();
            Ok(())
        })?;
        if ids.len() as u64 != metadata.line_count {
            return Err("Archive file sentence count does not match its metadata".into());
        }
        if has_tokens && !tokenized {
            return Err("Enable tokenization before restoring this archive to preserve its saved vocabulary".into());
        }
        self.with_writer_generation(&permit.database,Some(permit.generation),|conn|{
            let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let owned=Ownership::find(&tx,&ids)?;
            drop(ids);
            let mut dates:BTreeSet<_>=owned.days.iter().map(|(_,date)|*date).collect();
            let mut games=InsertTable::new(&tx,"games")?;
            let mut lines=InsertTable::new(&tx,"game_lines")?;
            let mut touched=HashSet::new();
            let (mut restored,mut skipped)=(0u64,0u64);
            let mut scenes=HashMap::<String,Value>::new();
            records(&mut zip,|mut record|{
                let id=record.id()?;
                let archived_owner=owned.owners.get(id);
                let exists=tx.prepare_cached("SELECT EXISTS(SELECT 1 FROM game_lines WHERE id=?)")?.query_row([id],|r|r.get::<_,bool>(0))?;
                if exists {
                    if archived_owner.is_some() {return Err("A sentence exists in both live and archived history; restore was cancelled".into());}
                    skipped+=1;
                    return Ok(());
                }
                let gid=archived_owner.map_or(metadata.game_id.as_str(),Arc::as_ref);
                let scene=match scenes.get(gid) {
                    Some(scene)=>scene,
                    None=>{
                        let lookup=|| -> rusqlite::Result<Option<Option<String>>> {
                            tx.prepare_cached("SELECT coalesce(nullif(obs_scene_name,''),title_original) FROM games WHERE id=?")?
                                .query_row([gid],|r|r.get(0)).optional()
                        };
                        let scene=match lookup()? {
                            Some(scene)=>scene,
                            None if gid==metadata.game_id=>{
                                games.insert(&tx,&metadata.game)?;
                                lookup()?.ok_or("Unable to restore the game's metadata")?
                            }
                            None=>return Err("The game owning these archived sentences no longer exists".into()),
                        };
                        scenes.entry(gid.to_owned()).or_insert_with(||json!(scene))
                    }
                };
                if record.line.get("game_id").and_then(Value::as_str) != Some(gid) {
                    if record.line.get("original_game_name").and_then(Value::as_str).is_none_or(str::is_empty) {
                        let original=record.line.get("game_name").cloned().unwrap_or(Value::Null);
                        record.line.insert("original_game_name".into(),original);
                    }
                    record.line.insert("game_name".into(),scene.clone());
                }
                record.line.insert("game_id".into(),json!(gid));
                if let Some(flag)=record.line.get_mut("tokenized") {*flag=json!(i64::from(record.tokens_available));}
                let time=record.timestamp()?;
                lines.insert(&tx,&record.line)?;
                if has_tokens {restore_tokens(&tx,&record,time,&mut touched)?;}
                dates.insert(stats::local_date(time)?);
                restored+=1;
                Ok(())
            })?;
            for (gid,date) in owned.days {
                let date=date.to_string();
                tx.prepare_cached("DELETE FROM archived_game_days WHERE game_id=? AND date=?")?.execute(params![gid,date])?;
                tx.prepare_cached("DELETE FROM archived_word_stats WHERE game_id=? AND date=?")?.execute(params![gid,date])?;
            }
            if !touched.is_empty(){
                word_index::repair_first_seen(&tx,true,"id IN (SELECT value FROM json_each(?))",[serde_json::to_string(&touched)?])?;
            }
            rollup::replace_dates(&tx,dates,cleaner,gap,tokenized)?;
            tx.commit()?;
            Ok(json!({"restored_lines":restored,"skipped_lines":skipped}))
        })
    }
}
