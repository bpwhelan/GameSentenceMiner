//! Read-only Chromium store input. SQLite holds the latest version of each key
//! on disk, including tombstones until every table and journal has been read.
use anyhow::{bail, ensure, Context, Result};
use rusqlite::{params, Connection};
use std::{fs, io::Read, path::Path};

pub(crate) fn take<'a>(input: &mut &'a [u8], n: usize) -> Result<&'a [u8]> {
    let (head, tail) = input
        .split_at_checked(n)
        .context("Truncated saved dictionary")?;
    *input = tail;
    Ok(head)
}

pub(crate) fn byte(input: &mut &[u8]) -> Result<u8> {
    Ok(take(input, 1)?[0])
}

pub(crate) fn integer(input: &mut &[u8]) -> Result<u64> {
    let mut n = 0;
    for shift in (0..64).step_by(7) {
        let b = byte(input)?;
        ensure!(shift != 63 || b <= 1, "Invalid dictionary integer");
        n |= u64::from(b & 127) << shift;
        if b < 128 {
            return Ok(n);
        }
    }
    bail!("Invalid dictionary integer")
}

pub(crate) fn sized<'a>(input: &mut &'a [u8]) -> Result<&'a [u8]> {
    let n = usize::try_from(integer(input)?)?;
    take(input, n)
}

pub(crate) fn little(bytes: &[u8]) -> Result<u64> {
    ensure!(bytes.len() <= 8, "Invalid dictionary ID");
    let mut raw = [0; 8];
    raw[..bytes.len()].copy_from_slice(bytes);
    Ok(u64::from_le_bytes(raw))
}

pub(crate) fn utf16(input: &[u8], big: bool) -> Result<String> {
    ensure!(input.len().is_multiple_of(2), "Invalid dictionary string");
    let units = input.chunks_exact(2).map(|p| {
        if big {
            u16::from_be_bytes([p[0], p[1]])
        } else {
            u16::from_le_bytes([p[0], p[1]])
        }
    });
    Ok(char::decode_utf16(units).collect::<Result<String, _>>()?)
}

pub(crate) fn string(input: &mut &[u8]) -> Result<String> {
    let n = usize::try_from(integer(input)?)?
        .checked_mul(2)
        .context("Invalid string length")?;
    utf16(take(input, n)?, true)
}

pub(crate) fn prefix(input: &mut &[u8]) -> Result<(u64, u64, u64)> {
    let h = byte(input)?;
    let db = little(take(input, usize::from(h >> 5) + 1)?)?;
    let store = little(take(input, usize::from((h >> 2) & 7) + 1)?)?;
    let kind = little(take(input, usize::from(h & 3) + 1)?)?;
    Ok((db, store, kind))
}

type Visitor<'a> = dyn FnMut(&[u8], &[u8], u64, bool) -> Result<()> + 'a;

fn batch(mut data: &[u8], visit: &mut Visitor<'_>) -> Result<()> {
    let first = little(take(&mut data, 8)?)?;
    let count = little(take(&mut data, 4)?)?;
    for offset in 0..count {
        let kind = byte(&mut data)?;
        ensure!(kind <= 1, "Invalid dictionary journal entry");
        let key = sized(&mut data)?;
        let value = if kind == 1 { sized(&mut data)? } else { &[] };
        visit(
            key,
            value,
            first
                .checked_add(offset)
                .context("Invalid journal sequence")?,
            kind == 0,
        )?;
    }
    ensure!(data.is_empty(), "Trailing dictionary journal bytes");
    Ok(())
}

fn journal(file: &Path, visit: &mut Visitor<'_>) -> Result<()> {
    let mut file = fs::File::open(file)?;
    let mut block = [0; 32768];
    let mut parts: Option<Vec<u8>> = None;
    loop {
        let mut read = 0;
        while read < block.len() {
            let n = file.read(&mut block[read..])?;
            if n == 0 {
                break;
            }
            read += n;
        }
        if read == 0 {
            break;
        }
        let mut rest = &block[..read];
        while rest.len() >= 7 {
            let checksum = little(take(&mut rest, 4)?)? as u32;
            let size = little(take(&mut rest, 2)?)? as usize;
            let kind = byte(&mut rest)?;
            if kind == 0 && size == 0 && checksum == 0 {
                ensure!(
                    parts.is_none() && rest.iter().all(|v| *v == 0),
                    "Damaged journal padding"
                );
                break;
            }
            let data = take(&mut rest, size)?;
            let crc = crc32c::crc32c_append(crc32c::crc32c(&[kind]), data);
            ensure!(
                crc.rotate_right(15).wrapping_add(0xa282ead8) == checksum,
                "Saved dictionary journal checksum failed"
            );
            match kind {
                1 if parts.is_none() => batch(data, visit)?,
                2 if parts.is_none() => parts = Some(data.to_vec()),
                3 | 4 if parts.is_some() => {
                    parts.as_mut().unwrap().extend_from_slice(data);
                    if kind == 4 {
                        batch(&parts.take().unwrap(), visit)?
                    }
                }
                _ => bail!("Invalid dictionary journal fragment"),
            }
        }
        ensure!(
            rest.iter().all(|b| *b == 0),
            "Incomplete dictionary journal header"
        );
    }
    ensure!(parts.is_none(), "Incomplete dictionary journal");
    Ok(())
}

pub(crate) fn load(dir: &Path, indexed: bool, progress: &dyn Fn(u64)) -> Result<Connection> {
    let mut db = Connection::open("")?; // SQLite owns and unlinks its private temporary file.
    db.execute_batch("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-262144;
        CREATE TABLE records(key BLOB PRIMARY KEY,value BLOB,seq INTEGER,deleted INTEGER,db INTEGER,store INTEGER,kind INTEGER) WITHOUT ROWID;")?;
    let tx = db.transaction()?;
    {
        let mut put = tx.prepare("INSERT INTO records VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,seq=excluded.seq,deleted=excluded.deleted WHERE excluded.seq>records.seq")?;
        let mut count = 0u64;
        let mut visit = |key: &[u8], value: &[u8], seq: u64, deleted: bool| -> Result<()> {
            let (db, store, kind) = if indexed {
                prefix(&mut &*key)?
            } else {
                (0, 0, 0)
            };
            if matches!(kind, 0 | 1 | 3) {
                put.execute(params![key, value, seq, deleted, db, store, kind])?;
                count += 1;
                if count % 100000 == 0 {
                    progress(count)
                }
            }
            Ok(())
        };
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            match path.extension().and_then(|v| v.to_str()) {
                Some("ldb" | "sst") => {
                    ensure!(
                        entry.file_type()?.is_file(),
                        "Unexpected dictionary table link"
                    );
                    for r in leveldb_core::parse_table_bytes(&fs::read(&path)?, &path)? {
                        visit(&r.key, &r.value, r.seq, r.deleted)?;
                    }
                }
                Some("log") => {
                    ensure!(
                        entry.file_type()?.is_file(),
                        "Unexpected dictionary journal link"
                    );
                    journal(&path, &mut visit)?;
                }
                _ => {}
            }
        }
        progress(count);
    }
    tx.execute_batch(
        "DELETE FROM records WHERE deleted; CREATE INDEX stores ON records(db,store,kind)",
    )?;
    tx.commit()?;
    Ok(db)
}
