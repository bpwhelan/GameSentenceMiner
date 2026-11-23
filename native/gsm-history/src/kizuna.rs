//! Kizuna exports use a session fingerprint shared with earlier desktop releases.
mod csv_input;
use crate::{History, Result};
use csv_input::{Session, Sessions};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap},
    fmt,
    io::BufRead,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug)]
pub struct InvalidFile(String);
impl fmt::Display for InvalidFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for InvalidFile {}

struct Game {
    id: String,
    title: String,
    linked: bool,
}
fn game(conn: &Connection, session: &Session) -> Result<Game> {
    let read = |r: &rusqlite::Row<'_>| {
        Ok(Game {
            id: r.get(0)?,
            title: r.get(1)?,
            linked: r.get(2)?,
        })
    };
    if !session.vndb.is_empty() {
        let mut select = conn.prepare_cached(
            "SELECT id,coalesce(title_original,''),1 FROM games WHERE lower(vndb_id)=? LIMIT 1",
        )?;
        if let Some(game) = select.query_row([&session.vndb], read).optional()? {
            return Ok(game);
        }
    }
    let mut select = conn.prepare_cached(
        "SELECT id,coalesce(title_original,''),coalesce(vndb_id,'')!='' FROM games
        WHERE (title_original=?1 OR title_romaji=?1 OR title_english=?1 OR obs_scene_name=?1)
        AND (?2='' OR coalesce(vndb_id,'')='' OR lower(vndb_id)=?2) LIMIT 1",
    )?;
    if let Some(mut game) = select
        .query_row(params![session.name, session.vndb], read)
        .optional()?
    {
        if !game.linked && !session.vndb.is_empty() {
            conn.execute(
                "UPDATE games SET vndb_id=? WHERE id=?",
                params![session.vndb, game.id],
            )?;
            game.linked = true;
        }
        return Ok(game);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let linked = !session.vndb.is_empty();
    conn.execute("INSERT INTO games(id,title_original,title_romaji,title_english,type,description,image,character_count,links,completed,
        release_date,manual_overrides,obs_scene_name,genres,tags,vndb_id,anilist_id,status)
        VALUES(?1,?2,'','',?3,'','',0,'[]',0,'','[]',?2,'[]','[]',?4,'','')",
        params![id,session.name,if linked {"Visual Novel"} else {""},session.vndb])?;
    Ok(Game {
        id,
        title: session.name.clone(),
        linked,
    })
}

impl History {
    pub fn import_kizuna(
        &self,
        path: &Path,
        generation: u64,
        file: impl BufRead,
        clear: bool,
    ) -> Result<Value> {
        let mut sessions = Sessions::new(file)?;
        self.with_writer_generation(path, Some(generation), |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let cleared = if clear {
                tx.execute("DELETE FROM third_party_stats WHERE source='kizuna'", [])?
            } else {
                0
            };
            let result = store(&tx, &mut sessions, cleared)?;
            tx.commit()?;
            Ok(result)
        })
    }
}

fn store(
    conn: &Connection,
    sessions: &mut Sessions<impl BufRead>,
    cleared: usize,
) -> Result<Value> {
    let mut existing = conn.prepare_cached(
        "SELECT 1 FROM third_party_stats WHERE source='kizuna' AND source_id=? AND source_id!=''",
    )?;
    let mut insert=conn.prepare_cached("INSERT INTO third_party_stats(date,characters_read,time_read_seconds,source,label,created_at,
        game_id,lines_read,source_id,timestamp) VALUES(?,?,?,'kizuna',?,?,?,?,?,?)")?;
    let created = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64();
    let mut games = HashMap::new();
    let mut earliest = None::<String>;
    let mut latest = None::<String>;
    let (mut count, mut skipped) = (0usize, 0usize);
    let (mut characters, mut lines) = (0i128, 0i128);
    let mut seconds = crate::sessions::DurationSum::default();
    while let Some(session) = sessions.next()? {
        if existing.exists([&session.id])? {
            skipped += 1;
            continue;
        }
        let key = session.key();
        if !games.contains_key(key) {
            games.insert(key.to_owned(), game(conn, &session)?);
        }
        insert.execute(params![
            session.date,
            session.chars,
            session.seconds,
            session.name,
            created,
            games[key].id,
            session.lines,
            session.id,
            session.timestamp
        ])?;
        if earliest.as_ref().is_none_or(|day| session.date < *day) {
            earliest = Some(session.date.clone());
        }
        if latest.as_ref().is_none_or(|day| session.date > *day) {
            latest = Some(session.date);
        }
        count += 1;
        characters += i128::from(session.chars);
        lines += i128::from(session.lines);
        seconds.add(session.seconds);
    }
    if count + skipped == 0 {
        return Err(InvalidFile("No reading sessions found in the Kizuna CSV".into()).into());
    }
    let titles = games.values().map(|g| &g.title).collect::<BTreeSet<_>>();
    let ids = games.values().map(|g| &g.id).collect::<BTreeSet<_>>();
    let linked = games
        .values()
        .filter(|g| g.linked)
        .map(|g| &g.id)
        .collect::<BTreeSet<_>>();
    let number = |sum: i128| {
        serde_json::Number::from_i128(sum)
            .map(Value::Number)
            .unwrap_or_else(|| json!(sum as f64))
    };
    Ok(
        json!({"imported_count":count,"skipped_count":skipped,"cleared_count":cleared,"games_count":ids.len(),"games":titles,
        "total_characters":number(characters),"total_lines":number(lines),"total_time_seconds":seconds.seconds(),
        "date_range":{"min":earliest,"max":latest},"vndb_games_count":linked.len()}),
    )
}
