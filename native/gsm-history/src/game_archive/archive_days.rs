use crate::{kanji::is_kanji, rollup, stats, ReportCleaner, Result};
use chrono::{NaiveDate, NaiveTime};
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    io::BufReader,
};

#[derive(Serialize, Deserialize)]
struct Event(f64, usize, usize, u8, usize, u8, String);
type Counts = HashMap<char, u64>;

#[derive(Default)]
struct Day {
    name: String,
    events: Vec<Event>,
    kanji: Counts,
    raw: Counts,
    token_kanji: Counts,
}

impl Day {
    fn load(tx: &Transaction, game: &str, date: NaiveDate, name: &str) -> Result<Self> {
        let mut day = Self {
            name: name.into(),
            ..Self::default()
        };
        let mut stmt=tx.prepare_cached("SELECT events,kanji,raw_kanji,token_kanji FROM archived_game_days WHERE game_id=? AND date=?")?;
        let mut rows = stmt.query(params![game, date.to_string()])?;
        if let Some(row) = rows.next()? {
            day.events = serde_json::from_reader(BufReader::new(ZlibDecoder::new(
                row.get_ref(0)?.as_blob()?,
            )))?;
            day.kanji = serde_json::from_str(row.get_ref(1)?.as_str()?)?;
            day.raw = serde_json::from_str(row.get_ref(2)?.as_str()?)?;
            day.token_kanji = serde_json::from_str(row.get_ref(3)?.as_str()?)?;
        }
        Ok(day)
    }

    fn add(&mut self, row: &rusqlite::Row, cleaner: &ReportCleaner) -> Result<()> {
        let text = |i| -> rusqlite::Result<Option<&str>> { Ok(row.get_ref(i)?.as_str_or_null()?) };
        let line = text(2)?.unwrap_or("");
        let chars = cleaner.visit(line, |s| {
            for ch in s.chars().filter(is_kanji) {
                *self.kanji.entry(ch).or_default() += 1;
            }
            s.chars().count()
        })?;
        let indexed = row.get::<_, bool>(8)?;
        let mut seen = HashSet::new();
        for ch in line.chars().filter(is_kanji) {
            *self.raw.entry(ch).or_default() += 1;
            if indexed && seen.insert(ch) {
                *self.token_kanji.entry(ch).or_default() += 1;
            }
        }
        let mut flags = 0;
        for col in 5..=7 {
            if !text(col)?
                .unwrap_or("")
                .trim_matches(rollup::python_space)
                .is_empty()
            {
                flags |= 1 << (col - 5);
            }
        }
        self.events.push(Event(
            row.get(0)?,
            chars,
            rollup::count_cards(text(4)?.unwrap_or(""), flags)?,
            flags,
            line.chars().count(),
            u8::from(indexed),
            row.get(1)?,
        ));
        Ok(())
    }

    fn store(
        mut self,
        tx: &Transaction,
        game: &str,
        date: NaiveDate,
        have_tokens: bool,
    ) -> Result<()> {
        self.events.sort_by(|a, b| a.0.total_cmp(&b.0));
        self.save_events(tx, game, date, None)?;
        if have_tokens {
            store_words(tx, game, date)?;
        }
        Ok(())
    }

    fn save_events(
        &self,
        tx: &Transaction,
        game: &str,
        date: NaiveDate,
        archived_at: Option<f64>,
    ) -> Result<()> {
        let mut ids = HashSet::with_capacity(self.events.len());
        let mut characters = 0u64;
        let mut indexed = 0u64;
        for event in &self.events {
            if !ids.insert(&event.6) {
                return Err(
                    "A sentence exists in both live and archived history; archiving was cancelled"
                        .into(),
                );
            }
            characters += event.1 as u64;
            indexed += u64::from(event.5);
        }
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        serde_json::to_writer(&mut encoder, &self.events)?;
        let day = date.to_string();
        tx.prepare_cached("INSERT OR REPLACE INTO archived_game_days(game_id,date,game_name,events,kanji,raw_kanji,
            archived_at,line_count,character_count,first_timestamp,last_timestamp,tokenized_lines,token_kanji)
            VALUES(?1,?2,?3,?4,?5,?6,coalesce(?13,unixepoch('subsec')),?7,?8,?9,?10,?11,?12)")?
            .execute(params![game,day,self.name,encoder.finish()?,serde_json::to_string(&self.kanji)?,serde_json::to_string(&self.raw)?,
                self.events.len(),characters,self.events.first().ok_or("Empty archive day")?.0,self.events.last().unwrap().0,indexed,serde_json::to_string(&self.token_kanji)?,archived_at])?;
        Ok(())
    }
}

fn store_words(tx: &Transaction, game: &str, date: NaiveDate) -> Result<()> {
    let day = date.to_string();
    let start = gsm_db::local_timestamp(date.and_time(NaiveTime::MIN))?;
    let end = gsm_db::local_timestamp(
        date.succ_opt()
            .ok_or("Invalid archive date")?
            .and_time(NaiveTime::MIN),
    )?;
    tx.prepare_cached("WITH occurrences AS (
                SELECT o.word_id,gl.id AS line,CAST(gl.timestamp AS REAL) AS stamp,
                    row_number() OVER(PARTITION BY o.word_id ORDER BY CAST(gl.timestamp AS REAL),gl.id) AS ordinal
                FROM game_lines gl JOIN word_occurrences o ON o.line_id=gl.id
                WHERE gl.game_id=?1 AND gl.timestamp>=?3 AND gl.timestamp<?4)
                INSERT INTO archived_word_stats(game_id,date,word_id,word,reading,pos,frequency,first_seen,last_seen,first_line_id)
                SELECT ?1,?2,w.id,w.word,coalesce(w.reading,''),coalesce(w.pos,''),count(*),min(o.stamp),max(o.stamp),
                    max(CASE WHEN ordinal=1 THEN line END) FROM occurrences o JOIN words w ON w.id=o.word_id GROUP BY w.id
                ON CONFLICT(game_id,date,word_id) DO UPDATE SET frequency=frequency+excluded.frequency,
                    first_line_id=CASE WHEN excluded.first_seen<first_seen THEN excluded.first_line_id ELSE first_line_id END,
                    first_seen=min(first_seen,excluded.first_seen),last_seen=max(last_seen,excluded.last_seen)")?
                .execute(params![game,day,start,end])?;
    Ok(())
}

pub(crate) fn merge_into(
    tx: &Transaction,
    source: &str,
    target: &str,
    name: &str,
    dates: &mut BTreeSet<NaiveDate>,
) -> Result<u64> {
    // Collect compact headers before modifying the indexed rows of this scan.
    let mut q=tx.prepare_cached("SELECT s.date,s.line_count,max(s.archived_at,coalesce(t.archived_at,s.archived_at)),t.game_id IS NOT NULL
        FROM archived_game_days s LEFT JOIN archived_game_days t ON t.date=s.date AND t.game_id=?2 WHERE s.game_id=?1")?;
    let days = q
        .query_map([source, target], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u64>(1)?,
                r.get::<_, f64>(2)?,
                r.get::<_, bool>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut moved = 0;
    for (date, count, at, overlap) in days {
        let day = date.parse()?;
        dates.insert(day);
        moved += count;
        if !overlap {
            tx.prepare_cached("UPDATE archived_game_days SET game_id=?1,game_name=?2 WHERE game_id=?3 AND date=?4")?
                .execute(params![target,name,source,date])?;
            continue;
        }
        let old = Day::load(tx, source, day, name)?;
        let mut combined = Day::load(tx, target, day, name)?;
        combined.events.extend(old.events);
        combined
            .events
            .sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.6.cmp(&b.6)));
        for (dest, fields) in [
            (&mut combined.kanji, old.kanji),
            (&mut combined.raw, old.raw),
            (&mut combined.token_kanji, old.token_kanji),
        ] {
            for (ch, count) in fields {
                *dest.entry(ch).or_default() += count;
            }
        }
        combined.save_events(tx, target, day, Some(at))?;
    }
    tx.prepare_cached("INSERT INTO archived_word_stats SELECT ?1,date,word_id,word,reading,pos,frequency,first_seen,last_seen,first_line_id
        FROM archived_word_stats WHERE game_id=?2 ON CONFLICT(game_id,date,word_id) DO UPDATE SET
        frequency=frequency+excluded.frequency,first_line_id=CASE WHEN excluded.first_seen<first_seen THEN excluded.first_line_id ELSE first_line_id END,
        first_seen=min(first_seen,excluded.first_seen),last_seen=max(last_seen,excluded.last_seen)")?.execute([target,source])?;
    tx.prepare_cached("DELETE FROM archived_word_stats WHERE game_id=?")?
        .execute([source])?;
    tx.prepare_cached("DELETE FROM archived_game_days WHERE game_id=?")?
        .execute([source])?;
    Ok(moved)
}

pub(super) fn store(
    tx: &Transaction,
    game: &str,
    scene: &str,
    title: &str,
    cleaner: &ReportCleaner,
    have_tokens: bool,
) -> Result<BTreeSet<NaiveDate>> {
    let indexed = tx
        .query_row(
            "SELECT 1 FROM pragma_table_info('game_lines') WHERE name='tokenized'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    let flag = if indexed {
        "coalesce(tokenized,0)=1"
    } else {
        "0"
    };
    let mut query=tx.prepare(&format!("SELECT CAST(timestamp AS REAL),id,line_text,game_name,note_ids,screenshot_in_anki,audio_in_anki,translation,{flag}
        FROM game_lines WHERE game_id=? ORDER BY CAST(timestamp AS REAL),id"))?;
    let mut rows = query.query([game])?;
    let mut dates = BTreeSet::new();
    let mut current: Option<(NaiveDate, Day)> = None;
    while let Some(row) = rows.next()? {
        let date = stats::local_date(row.get(0)?)?;
        if current.as_ref().is_none_or(|(old, _)| *old != date) {
            if let Some((old, day)) = current.take() {
                day.store(tx, game, old, have_tokens)?;
            }
            let source = row.get_ref(3)?.as_str_or_null()?.unwrap_or("");
            let name = if !scene.is_empty() {
                scene
            } else if !source.is_empty() {
                source
            } else {
                title
            };
            current = Some((date, Day::load(tx, game, date, name)?));
            dates.insert(date);
        }
        current.as_mut().unwrap().1.add(row, cleaner)?;
    }
    if let Some((date, day)) = current {
        day.store(tx, game, date, have_tokens)?;
    }
    Ok(dates)
}
