use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
};

pub const INVALID_FILE: &str = "Archive file must be a single file inside the archive folder";
pub const MISSING: &str = "No saved archive file was found";
pub const SUFFIX: &str = ".gsm-archive.zip";

pub fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A duplicate identity is ambiguous even if only one of the two files opens.
pub fn entries(dir: &Path) -> io::Result<HashMap<String, Option<PathBuf>>> {
    let mut files = HashMap::new();
    let reader = match fs::read_dir(dir) {
        Ok(reader) => reader,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(files),
        Err(e) => return Err(e),
    };
    for item in reader {
        let item = item?;
        let name = item.file_name();
        let Some((_, id)) = name
            .to_str()
            .and_then(|s| s.strip_suffix(SUFFIX))
            .and_then(|s| s.rsplit_once("--"))
        else {
            continue;
        };
        if valid_id(id) {
            files
                .entry(id.to_owned())
                .and_modify(|p| *p = None)
                .or_insert_with(|| Some(item.path()));
        }
    }
    Ok(files)
}

pub fn resolve(root: &Path, path: &Path) -> Option<PathBuf> {
    let target = path.canonicalize().ok()?;
    (target.parent() == Some(root) && target.is_file()).then_some(target)
}

pub fn existing(dir: &Path, id: &str) -> io::Result<Option<PathBuf>> {
    let Some(entry) = entries(dir)?.remove(id) else {
        return Ok(None);
    };
    let root = dir.canonicalize()?;
    entry
        .filter(|p| resolve(&root, p).is_some())
        .map(Some)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, INVALID_FILE))
}
