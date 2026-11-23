//! Direct Chromium IndexedDB + Local Extension Settings cloning.
//! Copies LevelDB/blob storage with shared reads and appends a LevelDB WriteBatch
//! to rewrite origin metadata from `source_id` to `dest_id`.

use crate::storage::{byte, integer, little, prefix, sized};
use anyhow::{bail, ensure, Context, Result};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{self, BufWriter, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const LOG_BLOCK_SIZE: usize = 32 * 1024;
const CRC_MASK_DELTA: u32 = 0xa282_ead8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CloneSummary {
    pub databases: usize,
    pub records: u64,
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

fn copy_file_shared(src: &Path, dst: &Path) -> Result<()> {
    if fs::copy(src, dst).is_ok() {
        return Ok(());
    }
    let mut reader = fs::File::open(src)?;
    let mut writer = BufWriter::new(fs::File::create(dst)?);
    io::copy(&mut reader, &mut writer)?;
    writer.flush()?;
    Ok(())
}

fn copy_tree(
    src: &Path,
    dst: &Path,
    is_leveldb: bool,
    copied_files: &mut u64,
    last_progress: &mut Instant,
    progress: &dyn Fn(&str, u64),
) -> Result<()> {
    fs::create_dir_all(dst)?;
    let mut stack = vec![(src.to_path_buf(), dst.to_path_buf())];
    while let Some((from_dir, to_dir)) = stack.pop() {
        for entry in fs::read_dir(&from_dir)? {
            let entry = entry?;
            let ty = entry.file_type()?;
            ensure!(!ty.is_symlink(), "Saved dictionary contains a symbolic link");
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str == "LOCK" || (is_leveldb && matches!(name_str.as_ref(), "LOG" | "LOG.old")) {
                continue;
            }
            let from_path = entry.path();
            let to_path = to_dir.join(&name);
            if ty.is_dir() {
                fs::create_dir_all(&to_path)?;
                stack.push((from_path, to_path));
            } else if ty.is_file() {
                copy_file_shared(&from_path, &to_path)?;
                *copied_files += 1;
                if last_progress.elapsed() >= Duration::from_millis(250) {
                    progress("importing", *copied_files);
                    *last_progress = Instant::now();
                }
            }
        }
    }
    Ok(())
}

fn read_log_records(buf: &[u8]) -> Result<Vec<Vec<u8>>> {
    let mut records = Vec::new();
    let mut parts: Option<Vec<u8>> = None;
    for block in buf.chunks(LOG_BLOCK_SIZE) {
        let mut rest = block;
        while rest.len() >= 7 {
            let checksum = little(crate::storage::take(&mut rest, 4)?)? as u32;
            let size = little(crate::storage::take(&mut rest, 2)?)? as usize;
            let kind = byte(&mut rest)?;
            if kind == 0 && size == 0 && checksum == 0 {
                ensure!(
                    parts.is_none() && rest.iter().all(|v| *v == 0),
                    "Damaged journal padding"
                );
                rest = &[];
                break;
            }
            let data = crate::storage::take(&mut rest, size)?;
            let crc = crc32c::crc32c_append(crc32c::crc32c(&[kind]), data)
                .rotate_left(17)
                .wrapping_add(CRC_MASK_DELTA);
            ensure!(crc == checksum, "Saved dictionary journal checksum failed");
            match kind {
                1 if parts.is_none() => records.push(data.to_vec()),
                2 if parts.is_none() => parts = Some(data.to_vec()),
                3 | 4 if parts.is_some() => {
                    parts.as_mut().unwrap().extend_from_slice(data);
                    if kind == 4 {
                        records.push(parts.take().unwrap());
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
    Ok(records)
}

fn write_log_batches(path: &Path, batches: &[Vec<u8>]) -> Result<()> {
    let mut out = BufWriter::new(fs::File::create(path)?);
    let mut block_offset = 0usize;
    for batch in batches {
        let mut offset = 0usize;
        loop {
            let leftover = LOG_BLOCK_SIZE - block_offset;
            if leftover < 7 {
                if leftover > 0 {
                    out.write_all(&[0u8; 6][..leftover])?;
                }
                block_offset = 0;
            }
            let avail = LOG_BLOCK_SIZE - block_offset - 7;
            let frag_len = (batch.len() - offset).min(avail);
            let is_first = offset == 0;
            let is_last = offset + frag_len == batch.len();
            let rtype = match (is_first, is_last) {
                (true, true) => 1u8,
                (true, false) => 2u8,
                (false, false) => 3u8,
                (false, true) => 4u8,
            };
            let frag = &batch[offset..offset + frag_len];
            let crc = crc32c::crc32c_append(crc32c::crc32c(&[rtype]), frag)
                .rotate_left(17)
                .wrapping_add(CRC_MASK_DELTA);
            out.write_all(&crc.to_le_bytes())?;
            out.write_all(&(frag_len as u16).to_le_bytes())?;
            out.write_all(&[rtype])?;
            out.write_all(frag)?;
            block_offset += 7 + frag_len;
            offset += frag_len;
            if is_last {
                break;
            }
        }
    }
    out.flush()?;
    Ok(())
}

struct ManifestInfo {
    log_num: u64,
    last_seq: u64,
    active_tables: BTreeMap<u64, (Vec<u8>, Vec<u8>)>,
}

fn parse_manifest(dir: &Path) -> Result<Option<ManifestInfo>> {
    let current_path = dir.join("CURRENT");
    if !current_path.is_file() {
        return Ok(None);
    }
    let manifest_name = fs::read_to_string(&current_path)?.trim().to_string();
    if !manifest_name.starts_with("MANIFEST-")
        || manifest_name.contains(['/', '\\', '\0'])
        || manifest_name == ".."
    {
        return Ok(None);
    }
    let manifest_path = dir.join(&manifest_name);
    if !manifest_path.is_file() {
        return Ok(None);
    }
    let records = read_log_records(&fs::read(&manifest_path)?)?;
    let mut info = ManifestInfo {
        log_num: 0,
        last_seq: 0,
        active_tables: BTreeMap::new(),
    };
    for record in records {
        let mut input = record.as_slice();
        while !input.is_empty() {
            let tag = integer(&mut input)?;
            match tag {
                1 => {
                    sized(&mut input)?;
                }
                2 => info.log_num = integer(&mut input)?,
                3 | 9 => {
                    integer(&mut input)?;
                }
                4 => info.last_seq = integer(&mut input)?,
                5 => {
                    integer(&mut input)?;
                    sized(&mut input)?;
                }
                6 => {
                    integer(&mut input)?;
                    let file_num = integer(&mut input)?;
                    info.active_tables.remove(&file_num);
                }
                7 => {
                    integer(&mut input)?;
                    let file_num = integer(&mut input)?;
                    integer(&mut input)?;
                    let smallest = sized(&mut input)?;
                    let largest = sized(&mut input)?;
                    info.active_tables
                        .insert(file_num, (smallest.to_vec(), largest.to_vec()));
                }
                _ => return Ok(None),
            }
        }
    }
    Ok(Some(info))
}

fn range_may_contain_metadata(smallest_internal: &[u8], largest_internal: &[u8]) -> bool {
    let Some(sm_user) = smallest_internal
        .len()
        .checked_sub(8)
        .map(|n| &smallest_internal[..n])
    else {
        return true;
    };
    let Some(lg_user) = largest_internal
        .len()
        .checked_sub(8)
        .map(|n| &largest_internal[..n])
    else {
        return true;
    };
    let Ok((sm_db, sm_store, sm_kind)) = prefix(&mut &*sm_user) else {
        return true;
    };
    let Ok((lg_db, _, _)) = prefix(&mut &*lg_user) else {
        return true;
    };
    sm_db != lg_db || (sm_store == 0 && sm_kind == 0)
}

fn collect_table_candidates(dir: &Path, manifest: Option<&ManifestInfo>) -> Result<Vec<PathBuf>> {
    if let Some(info) = manifest {
        let mut paths = Vec::new();
        for (&file_num, (smallest, largest)) in &info.active_tables {
            if !range_may_contain_metadata(smallest, largest) {
                continue;
            }
            let ldb = dir.join(format!("{file_num:06}.ldb"));
            if ldb.is_file() {
                paths.push(ldb);
                continue;
            }
            let sst = dir.join(format!("{file_num:06}.sst"));
            if sst.is_file() {
                paths.push(sst);
                continue;
            }
            bail!("Missing dictionary table {file_num:06}.ldb referenced by MANIFEST");
        }
        return Ok(paths);
    }

    let mut paths = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if matches!(
            path.extension().and_then(|v| v.to_str()),
            Some("ldb" | "sst")
        ) && entry.file_type()?.is_file()
        {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}

type MetadataMap = BTreeMap<Vec<u8>, (u64, bool, Vec<u8>)>;

fn record_metadata(metadata: &mut MetadataMap, key: &[u8], seq: u64, deleted: bool, value: &[u8]) {
    if let Ok((_, 0, 0)) = prefix(&mut &*key) {
        let replace = metadata
            .get(key)
            .is_none_or(|(existing_seq, _, _)| seq >= *existing_seq);
        if replace {
            metadata.insert(key.to_vec(), (seq, deleted, value.to_vec()));
        }
    }
}

fn decode_write_batch(
    batch: &[u8],
    max_seq: &mut u64,
    metadata: &mut MetadataMap,
) -> Result<()> {
    let mut input = batch;
    let base_seq = little(crate::storage::take(&mut input, 8)?)?;
    let count = little(crate::storage::take(&mut input, 4)?)?;
    let batch_max = if count == 0 {
        base_seq
    } else {
        base_seq.saturating_add(count - 1)
    };
    *max_seq = (*max_seq).max(batch_max);
    for offset in 0..count {
        let kind = byte(&mut input)?;
        ensure!(kind <= 1, "Invalid dictionary journal entry");
        let key = sized(&mut input)?;
        let value = if kind == 1 { sized(&mut input)? } else { &[] };
        let seq = base_seq
            .checked_add(offset)
            .context("Invalid journal sequence")?;
        record_metadata(metadata, key, seq, kind == 0, value);
    }
    ensure!(input.is_empty(), "Trailing dictionary journal bytes");
    Ok(())
}

enum BatchOp {
    Delete(Vec<u8>),
    Put(Vec<u8>, Vec<u8>),
}

fn push_varint(out: &mut Vec<u8>, mut value: usize) {
    while value >= 0x80 {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn encode_write_batch(base_seq: u64, ops: &[BatchOp]) -> Result<Vec<u8>> {
    let count = u32::try_from(ops.len()).context("Too many metadata rewrite operations")?;
    let mut batch = Vec::with_capacity(12 + ops.len() * 64);
    batch.extend_from_slice(&base_seq.to_le_bytes());
    batch.extend_from_slice(&count.to_le_bytes());
    for op in ops {
        match op {
            BatchOp::Delete(key) => {
                batch.push(0);
                push_varint(&mut batch, key.len());
                batch.extend_from_slice(key);
            }
            BatchOp::Put(key, value) => {
                batch.push(1);
                push_varint(&mut batch, key.len());
                batch.extend_from_slice(key);
                push_varint(&mut batch, value.len());
                batch.extend_from_slice(value);
            }
        }
    }
    Ok(batch)
}

fn to_utf16_be(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 2);
    for unit in s.encode_utf16() {
        out.extend_from_slice(&unit.to_be_bytes());
    }
    out
}

fn replace_bytes(data: &[u8], needle: &[u8], replacement: &[u8]) -> Vec<u8> {
    if needle.is_empty() || data.len() < needle.len() {
        return data.to_vec();
    }
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        if data[i..].starts_with(needle) {
            out.extend_from_slice(replacement);
            i += needle.len();
        } else {
            out.push(data[i]);
            i += 1;
        }
    }
    out
}

fn rewrite_origin_bytes(data: &[u8], patterns: &[(Vec<u8>, Vec<u8>)]) -> Vec<u8> {
    let mut current = data.to_vec();
    for (needle, replacement) in patterns {
        if current.windows(needle.len()).any(|w| w == needle.as_slice()) {
            current = replace_bytes(&current, needle, replacement);
        }
    }
    current
}

fn is_database_name_key(key: &[u8]) -> bool {
    let mut tail = key;
    matches!(prefix(&mut tail), Ok((0, 0, 0))) && tail.first() == Some(&201)
}

fn rewrite_indexeddb_origin(dir: &Path, source_id: &str, dest_id: &str) -> Result<usize> {
    let manifest = parse_manifest(dir)?;
    let mut max_seq = manifest.as_ref().map_or(0, |m| m.last_seq);
    let manifest_log_num = manifest.as_ref().map_or(0, |m| m.log_num);
    let mut metadata = MetadataMap::new();

    for table_path in collect_table_candidates(dir, manifest.as_ref())? {
        for r in leveldb_core::parse_table_bytes(&fs::read(&table_path)?, &table_path)? {
            max_seq = max_seq.max(r.seq);
            record_metadata(&mut metadata, &r.key, r.seq, r.deleted, &r.value);
        }
    }

    let mut log_files: Vec<(u64, PathBuf)> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|v| v.to_str()) == Some("log") && entry.file_type()?.is_file() {
            if let Ok(num) = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .parse::<u64>()
            {
                log_files.push((num, path));
            }
        }
    }
    log_files.sort_by_key(|(num, _)| *num);

    let mut parsed_logs: HashMap<u64, Vec<Vec<u8>>> = HashMap::new();
    for &(num, ref path) in &log_files {
        let batches = read_log_records(&fs::read(path)?)?;
        for batch in &batches {
            decode_write_batch(batch, &mut max_seq, &mut metadata)?;
        }
        parsed_logs.insert(num, batches);
    }

    let databases = metadata
        .iter()
        .filter(|(key, (_, deleted, _))| !*deleted && is_database_name_key(key))
        .count();

    if source_id != dest_id {
        let under_src = format!("chrome-extension_{source_id}");
        let under_dst = format!("chrome-extension_{dest_id}");
        let url_src = format!("chrome-extension://{source_id}");
        let url_dst = format!("chrome-extension://{dest_id}");
        let patterns = vec![
            (to_utf16_be(&under_src), to_utf16_be(&under_dst)),
            (to_utf16_be(&url_src), to_utf16_be(&url_dst)),
            (under_src.into_bytes(), under_dst.into_bytes()),
            (url_src.into_bytes(), url_dst.into_bytes()),
        ];

        let mut ops = Vec::new();
        for (key, (_, deleted, value)) in &metadata {
            if *deleted {
                continue;
            }
            let new_key = rewrite_origin_bytes(key, &patterns);
            let new_value = rewrite_origin_bytes(value, &patterns);
            if new_key != *key {
                ops.push(BatchOp::Delete(key.clone()));
                ops.push(BatchOp::Put(new_key, new_value));
            } else if new_value != *value {
                ops.push(BatchOp::Put(key.clone(), new_value));
            }
        }

        if !ops.is_empty() {
            let next_seq = max_seq.checked_add(1).context("LevelDB sequence overflow")?;
            let new_batch = encode_write_batch(next_seq, &ops)?;
            let highest_log_num = log_files.last().map(|(n, _)| *n).unwrap_or(0);
            let target_num = highest_log_num.max(manifest_log_num).max(1);
            let target_path = log_files
                .iter()
                .find(|(n, _)| *n == target_num)
                .map(|(_, p)| p.clone())
                .unwrap_or_else(|| dir.join(format!("{target_num:06}.log")));
            let mut batches = parsed_logs.remove(&target_num).unwrap_or_default();
            batches.push(new_batch);
            write_log_batches(&target_path, &batches)?;
        }
    }

    Ok(databases)
}

struct StagedDir {
    _temp: tempfile::TempDir,
    data: PathBuf,
    dest: PathBuf,
}

fn stage_copy(
    src: &Path,
    dest: &Path,
    is_leveldb: bool,
    copied_files: &mut u64,
    last_progress: &mut Instant,
    progress: &dyn Fn(&str, u64),
) -> Result<StagedDir> {
    let parent = dest
        .parent()
        .context("Missing destination dictionary directory parent")?;
    fs::create_dir_all(parent)?;
    let temp = tempfile::tempdir_in(parent)?;
    let data = temp.path().join("staged");
    copy_tree(src, &data, is_leveldb, copied_files, last_progress, progress)?;
    Ok(StagedDir {
        _temp: temp,
        data,
        dest: dest.to_path_buf(),
    })
}

fn commit_staged(staged: StagedDir) -> Result<()> {
    if staged.dest.exists() {
        fs::remove_dir_all(&staged.dest)?;
    }
    fs::rename(&staged.data, &staged.dest)?;
    Ok(())
}

pub fn clone_chromium(
    source_database: &Path,
    source_settings: &Path,
    source_id: &str,
    dest_database: &Path,
    dest_settings: &Path,
    dest_id: &str,
    progress: &dyn Fn(&str, u64),
) -> Result<CloneSummary> {
    ensure!(
        source_database.is_dir() || source_settings.is_dir(),
        "No saved dictionary was found"
    );
    ensure!(
        valid_id(source_id) && valid_id(dest_id),
        "Invalid extension ID for Chromium storage clone"
    );

    let source_blobs = source_database.with_extension("blob");
    let dest_blobs = dest_database.with_extension("blob");
    let roots = [source_database, source_settings, source_blobs.as_path()];
    let before = crate::snapshot(&roots)?;

    let mut copied_files = 0u64;
    let mut last_progress = Instant::now();
    let mut staged = Vec::new();
    let mut databases = 0usize;

    if source_database.is_dir() {
        let db_stage = stage_copy(
            source_database,
            dest_database,
            true,
            &mut copied_files,
            &mut last_progress,
            progress,
        )?;
        databases = rewrite_indexeddb_origin(&db_stage.data, source_id, dest_id)?;
        staged.push(db_stage);

        if source_blobs.is_dir() {
            staged.push(stage_copy(
                &source_blobs,
                &dest_blobs,
                false,
                &mut copied_files,
                &mut last_progress,
                progress,
            )?);
        }
    }

    if source_settings.is_dir() {
        staged.push(stage_copy(
            source_settings,
            dest_settings,
            true,
            &mut copied_files,
            &mut last_progress,
            progress,
        )?);
    }

    ensure!(
        before == crate::snapshot(&roots)?,
        "Saved dictionaries changed during transfer. Close the older app and retry."
    );

    for item in staged {
        commit_staged(item)?;
    }
    if source_database.is_dir() && !source_blobs.is_dir() && dest_blobs.exists() {
        let _ = fs::remove_dir_all(&dest_blobs);
    }

    progress("importing", copied_files);
    Ok(CloneSummary {
        databases,
        records: copied_files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export;

    fn utf16be_with_len(s: &str) -> Vec<u8> {
        let mut out = Vec::new();
        push_varint(&mut out, s.encode_utf16().count());
        out.extend_from_slice(&to_utf16_be(s));
        out
    }

    fn key_prefix(db: u64, store: u64, kind: u64) -> Vec<u8> {
        let db_len = ((64 - db.max(1).leading_zeros()).div_ceil(8)).max(1) as usize;
        let st_len = ((64 - store.max(1).leading_zeros()).div_ceil(8)).max(1) as usize;
        let kd_len = ((64 - kind.max(1).leading_zeros()).div_ceil(8)).max(1) as usize;
        let header = (((db_len - 1) as u8) << 5) | (((st_len - 1) as u8) << 2) | ((kd_len - 1) as u8);
        let mut out = vec![header];
        out.extend_from_slice(&db.to_le_bytes()[..db_len]);
        out.extend_from_slice(&store.to_le_bytes()[..st_len]);
        out.extend_from_slice(&kind.to_le_bytes()[..kd_len]);
        out
    }

    fn v8_utf8_string(s: &str) -> Vec<u8> {
        // Blink header v20 + V8 header v15 + one-byte string '"'
        let mut out = vec![255, 20, 255, 15, b'"'];
        push_varint(&mut out, s.len());
        out.extend_from_slice(s.as_bytes());
        out
    }

    fn v8_blob_entry(index: u64) -> Vec<u8> {
        let mut out = vec![255, 20, 255, 15, b'\\', b'i'];
        push_varint(&mut out, index as usize);
        out
    }

    fn idb_string_key(s: &str) -> Vec<u8> {
        let mut out = vec![1];
        out.extend_from_slice(&utf16be_with_len(s));
        out
    }

    #[test]
    fn clone_chromium_rewrites_origin_and_preserves_data_blobs_and_settings() {
        let temp = tempfile::tempdir().unwrap();
        let src_profile = temp.path().join("src");
        let dst_profile = temp.path().join("dst");
        let src_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let dst_id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

        let src_db = src_profile
            .join("IndexedDB")
            .join(format!("chrome-extension_{src_id}_0.indexeddb.leveldb"));
        let src_blobs = src_db.with_extension("blob");
        let src_settings = src_profile.join("Local Extension Settings").join(src_id);
        fs::create_dir_all(&src_db).unwrap();
        fs::create_dir_all(src_blobs.join("1/00")).unwrap();
        fs::create_dir_all(&src_settings).unwrap();

        // Write a blob file referenced by db=1, blob index=1.
        let blob_bytes = b"yomitan-media-payload";
        fs::write(src_blobs.join("1/00/1"), blob_bytes).unwrap();

        // Build DatabaseNameKey, schema, store metadata, record, and blob journal in 000003.log.
        let mut db_name_key = key_prefix(0, 0, 0);
        db_name_key.push(201);
        db_name_key.extend_from_slice(&utf16be_with_len(&format!("chrome-extension_{src_id}_0@1")));
        db_name_key.extend_from_slice(&utf16be_with_len("dict"));

        let mut db_ver_key = key_prefix(1, 0, 0);
        db_ver_key.push(4);

        let mut store_name_key = key_prefix(1, 0, 0);
        store_name_key.push(50);
        push_varint(&mut store_name_key, 1);
        store_name_key.push(0);

        let mut store_kp_key = key_prefix(1, 0, 0);
        store_kp_key.push(50);
        push_varint(&mut store_kp_key, 1);
        store_kp_key.push(1);

        let mut data_key = key_prefix(1, 1, 1);
        data_key.extend_from_slice(&idb_string_key("term1"));
        let mut data_val = Vec::new();
        push_varint(&mut data_val, 1);
        data_val.extend_from_slice(&v8_utf8_string("definition"));

        let mut blob_rec_key = key_prefix(1, 1, 1);
        blob_rec_key.extend_from_slice(&idb_string_key("media1"));
        let mut blob_rec_val = Vec::new();
        push_varint(&mut blob_rec_val, 1);
        blob_rec_val.extend_from_slice(&v8_blob_entry(0));

        let mut blob_meta_key = key_prefix(1, 1, 3);
        blob_meta_key.extend_from_slice(&idb_string_key("media1"));
        let mut blob_meta_val = vec![0u8]; // kind = 0 (blob)
        push_varint(&mut blob_meta_val, 1); // blob number = 1
        blob_meta_val.extend_from_slice(&utf16be_with_len("image/png"));
        push_varint(&mut blob_meta_val, blob_bytes.len());

        let mut store_name_val = Vec::new();
        for unit in "terms".encode_utf16() {
            store_name_val.extend_from_slice(&unit.to_be_bytes());
        }

        let ops = vec![
            BatchOp::Put(db_name_key.clone(), 1u64.to_le_bytes()[..1].to_vec()),
            BatchOp::Put(db_ver_key, vec![1]),
            BatchOp::Put(store_name_key, store_name_val),
            BatchOp::Put(store_kp_key, vec![0, 0, 0]),
            BatchOp::Put(data_key, data_val),
            BatchOp::Put(blob_rec_key, blob_rec_val),
            BatchOp::Put(blob_meta_key, blob_meta_val),
        ];
        let batch = encode_write_batch(1, &ops).unwrap();
        write_log_batches(&src_db.join("000003.log"), &[batch]).unwrap();

        // Build a MANIFEST-000001 with comparator, log_num=3, next_file=4, last_seq=7.
        let mut edit = Vec::new();
        edit.push(1);
        let cmp = b"idb_cmp1";
        push_varint(&mut edit, cmp.len());
        edit.extend_from_slice(cmp);
        edit.push(2);
        push_varint(&mut edit, 3);
        edit.push(3);
        push_varint(&mut edit, 4);
        edit.push(4);
        push_varint(&mut edit, 7);
        write_log_batches(&src_db.join("MANIFEST-000001"), &[edit]).unwrap();
        fs::write(src_db.join("CURRENT"), "MANIFEST-000001\n").unwrap();
        fs::write(src_db.join("LOCK"), b"").unwrap();
        fs::write(src_db.join("LOG"), b"old log").unwrap();

        // Write Local Extension Settings log.
        let settings_ops = vec![BatchOp::Put(
            b"options".to_vec(),
            br#"{"profiles":[],"profileCurrent":0}"#.to_vec(),
        )];
        write_log_batches(
            &src_settings.join("000003.log"),
            &[encode_write_batch(1, &settings_ops).unwrap()],
        )
        .unwrap();
        fs::write(src_settings.join("CURRENT"), "MANIFEST-000001\n").unwrap();

        let dst_db = dst_profile
            .join("IndexedDB")
            .join(format!("chrome-extension_{dst_id}_0.indexeddb.leveldb"));
        let dst_settings = dst_profile.join("Local Extension Settings").join(dst_id);

        let summary = clone_chromium(
            &src_db,
            &src_settings,
            src_id,
            &dst_db,
            &dst_settings,
            dst_id,
            &|_, _| {},
        )
        .unwrap();
        assert_eq!(summary.databases, 1);
        assert!(summary.records >= 4);
        assert!(!dst_db.join("LOCK").exists());
        assert!(!dst_db.join("LOG").exists());
        assert!(dst_db.with_extension("blob").join("1/00/1").is_file());

        // Verify via storage::load & export that old origin key is deleted, new origin key exists,
        // and all records/blobs/settings export cleanly.
        let loaded = crate::storage::load(&dst_db, true, &|_| {}).unwrap();
        let old_key_exists: bool = loaded
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM records WHERE key=?)",
                [&db_name_key],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!old_key_exists, "old origin DatabaseNameKey should be deleted");

        let mut new_db_name_key = key_prefix(0, 0, 0);
        new_db_name_key.push(201);
        new_db_name_key.extend_from_slice(&utf16be_with_len(&format!("chrome-extension_{dst_id}_0@1")));
        new_db_name_key.extend_from_slice(&utf16be_with_len("dict"));
        let new_key_exists: bool = loaded
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM records WHERE key=?)",
                [&new_db_name_key],
                |r| r.get(0),
            )
            .unwrap();
        assert!(new_key_exists, "new origin DatabaseNameKey should exist");

        let export_dir = temp.path().join("exported");
        export(&dst_db, &dst_settings, None, &export_dir, &|_, _| {}).unwrap();
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(export_dir.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["databases"].as_array().unwrap().len(), 1);
        assert_eq!(manifest["databases"][0]["name"], "dict");
        assert_eq!(manifest["databases"][0]["stores"][0]["count"], 2);
        assert_eq!(
            manifest["storage"]["options"],
            serde_json::json!({"profiles": [], "profileCurrent": 0})
        );
    }
}
