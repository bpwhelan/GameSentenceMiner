//! Catalog portable archives without reading their sentence streams or retaining
//! embedded cover images. A file ID identifies one managed filename.
use crate::Reports;
use gsm_history::game_archive::catalog::{self, entries, valid_id, INVALID_FILE, MISSING};
use serde_json::{json, Value};
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

pub struct ArchiveDownload {
    pub path: PathBuf,
    pub filename: String,
}

impl ArchiveDownload {
    pub fn disposition(&self) -> String {
        let fallback: String = self
            .filename
            .chars()
            .map(|c| {
                if c.is_ascii_graphic() && !matches!(c, '"' | '\\') {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let encoded = percent_encoding::utf8_percent_encode(
            &self.filename,
            percent_encoding::NON_ALPHANUMERIC,
        );
        format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}")
    }
}

fn resolve(root: &Path, path: &Path) -> Option<ArchiveDownload> {
    let real = catalog::resolve(root,path)?;
    Some(ArchiveDownload {
        path: real,
        filename: path.file_name()?.to_str()?.into(),
    })
}

impl Reports {
    pub(super) fn archive_directory(&self) -> PathBuf {
        self.database.with_file_name("archives").join("games")
    }

    pub(super) fn archive_files(&self) -> io::Result<Value> {
        let directory = self.archive_directory();
        let entries = entries(&directory)?;
        let mut archives = Vec::new();
        if !entries.is_empty() {
            let root = directory.canonicalize()?;
            for (id, path) in entries {
                let Some(file) = path.and_then(|p| resolve(&root, &p)) else {
                    continue;
                };
                let Ok(stat) = fs::metadata(&file.path) else {
                    continue;
                };
                let updated = stat
                    .modified()?
                    .duration_since(UNIX_EPOCH)
                    .map_or_else(|e| -e.duration().as_secs_f64(), |t| t.as_secs_f64());
                let mut item = json!({"file_id":id,"filename":file.filename,"size_bytes":stat.len(),"updated_at":updated});
                match gsm_history::game_archive::summary(&file.path, &id) {
                    Ok(data) => {
                        item["game_id"] = data.game_id.into();
                        item["game_name"] = data.game_name.into();
                        item["line_count"] = data.line_count.into();
                        item["can_restore"] = true.into();
                    }
                    Err(error) => {
                        item["game_name"] = file.filename.into();
                        item["line_count"] = Value::Null;
                        item["can_restore"] = false.into();
                        item["error"] = error.into();
                    }
                }
                archives.push(item);
            }
            archives.sort_by(|a, b| {
                b["updated_at"]
                    .as_f64()
                    .unwrap_or_default()
                    .total_cmp(&a["updated_at"].as_f64().unwrap_or_default())
            });
        }
        Ok(json!({"directory":directory,"archives":archives}))
    }

    pub fn archive_download(&self, id: &str) -> Result<ArchiveDownload, (u16, &'static str)> {
        if !valid_id(id) {
            return Err((400, "Invalid archive file ID"));
        }
        let directory = self.archive_directory();
        let mut files =
            entries(&directory).map_err(|_| (500, "Unable to read archive directory"))?;
        let path = files
            .remove(id)
            .ok_or((404, MISSING))?
            .ok_or((400, INVALID_FILE))?;
        let root = directory.canonicalize().map_err(|_| (404, MISSING))?;
        resolve(&root, &path).ok_or((400, INVALID_FILE))
    }
}
