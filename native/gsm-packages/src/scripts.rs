//! Preserve user edits separately from files still owned by upstream updates.
use gsm_settings::{read_object, with_lock, write_atomic, Result};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
type Hashes = BTreeMap<String, String>;
const REPOSITORY: &str = "0xDC00/scripts";
#[derive(Clone)]
pub struct Scripts {
    pub root: PathBuf,
    pub api: String,
}
fn file_key(path: &Path) -> String {
    let name = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        name.to_lowercase()
    } else {
        name
    }
}
pub fn hashes(root: &Path) -> Result<Hashes> {
    fn visit(root: &Path, dir: &Path, out: &mut Hashes) -> Result<()> {
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_dir() {
                visit(root, &entry.path(), out)?;
            } else if kind.is_file() {
                out.insert(
                    file_key(entry.path().strip_prefix(root).unwrap()),
                    crate::hash(&entry.path())?,
                );
            }
        }
        Ok(())
    }
    let mut result = Hashes::new();
    visit(root, root, &mut result)?;
    Ok(result)
}
fn remove_staged(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) => if m.is_dir() && !m.file_type().is_symlink() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        }
        .map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
pub fn preserve(local: &Path, incoming: &Path, previous: &Hashes, next: &mut Hashes) -> Result<()> {
    if !local.exists() {
        return Ok(());
    }
    if !fs::symlink_metadata(local)
        .map_err(|e| e.to_string())?
        .is_dir()
        || fs::symlink_metadata(local)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
    {
        return Err("Managed Agent scripts root must be a directory".into());
    }
    fn visit(
        local: &Path,
        incoming: &Path,
        relative: &Path,
        previous: &Hashes,
        next: &mut Hashes,
    ) -> Result<()> {
        for entry in fs::read_dir(local.join(relative)).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let relative = relative.join(entry.file_name());
            let source = local.join(&relative);
            let target = incoming.join(&relative);
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            let key = file_key(&relative);
            if kind.is_file()
                && previous
                    .get(&key)
                    .is_some_and(|h| crate::hash(&source).as_ref() == Ok(h))
            {
                continue;
            }
            if kind.is_dir() {
                if target.exists() && !target.is_dir() {
                    remove_staged(&target)?;
                    next.retain(|k, _| k != &key && !k.starts_with(&format!("{key}/")));
                }
                fs::create_dir_all(&target).map_err(|e| e.to_string())?;
                visit(local, incoming, &relative, previous, next)?;
            } else {
                remove_staged(&target)?;
                next.retain(|k, _| k != &key && !k.starts_with(&format!("{key}/")));
                if kind.is_symlink() {
                    let destination = fs::read_link(&source).map_err(|e| e.to_string())?;
                    #[cfg(unix)]
                    std::os::unix::fs::symlink(destination, &target).map_err(|e| e.to_string())?;
                    #[cfg(windows)]
                    {
                        if source.is_dir() {
                            std::os::windows::fs::symlink_dir(destination, &target)
                        } else {
                            std::os::windows::fs::symlink_file(destination, &target)
                        }
                        .map_err(|e| {
                            format!(
                                "Could not preserve local Agent link {}: {e}",
                                source.display()
                            )
                        })?;
                    }
                } else if kind.is_file() {
                    fs::copy(source, target).map_err(|e| e.to_string())?;
                } else {
                    return Err("Unsupported local Agent entry; keeping existing library".into());
                }
            }
        }
        Ok(())
    }
    visit(local, incoming, Path::new(""), previous, next)
}
pub fn count(root: &Path) -> usize {
    let Ok(entries) = fs::read_dir(root) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let Ok(kind) = entry.file_type() else {
                return 0;
            };
            if kind.is_dir() {
                count(&entry.path())
            } else {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                usize::from(
                    kind.is_file()
                        && !name.starts_with('_')
                        && !name.starts_with("lib")
                        && [".js", ".mjs", ".cjs"]
                            .iter()
                            .any(|ext| name.ends_with(ext)),
                )
            }
        })
        .sum()
}
fn repository_root(root: &Path) -> Result<PathBuf> {
    if root.join("libLoader.js").is_file() {
        return Ok(root.into());
    }
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.join("libLoader.js").is_file() {
            return Ok(path);
        }
    }
    Err("Agent archive did not contain libLoader.js".into())
}
impl Scripts {
    pub fn new(active: &Path) -> Self {
        Self {
            root: active.join("agent-scripts"),
            api: "https://api.github.com/repos/0xDC00/scripts".into(),
        }
    }
    pub fn directory(&self) -> PathBuf {
        self.root.join("scripts")
    }
    fn metadata_path(&self) -> PathBuf {
        self.root.join("metadata.json")
    }
    fn metadata(&self) -> Value {
        let mut value = read_object(&self.metadata_path()).unwrap_or(json!({}));
        if value["repository"] != REPOSITORY
            || !value["branch"].is_string()
            || !value["commit"].is_string()
            || !value["installedAt"].is_number()
            || !value["checkedAt"].is_number()
            || !value["scriptCount"].is_number()
        {
            return json!({});
        }
        if !value["fileHashes"].is_null() {
            let parsed = serde_json::from_value::<Hashes>(value["fileHashes"].clone())
                .ok()
                .filter(|v| {
                    v.values()
                        .all(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
                })
                .unwrap_or_default();
            value["fileHashes"] = json!(parsed
                .into_iter()
                .map(|(k, v)| (file_key(Path::new(&k)), v))
                .collect::<Hashes>());
        }
        value
    }
    fn status(&self, metadata: &Value, updated: bool) -> Value {
        let count = count(&self.directory());
        json!({"path":self.directory(),"repository":REPOSITORY,"branch":metadata["branch"],"commit":metadata["commit"],"installed":count>0,"updated":updated,"scriptCount":count,"checkedAt":metadata["checkedAt"]})
    }
    fn unpack(&self, commit: &str, temporary: &Path) -> Result<PathBuf> {
        fs::create_dir_all(temporary).map_err(|e| e.to_string())?;
        let zip = temporary.join("scripts.zip");
        let incoming = temporary.join("incoming");
        crate::download(
            &format!("{}/zipball/{commit}", self.api),
            &zip,
            None,
            &|_, _| {},
        )?;
        fs::create_dir(&incoming).map_err(|e| e.to_string())?;
        crate::extract(&zip, &incoming, None)?;
        repository_root(&incoming)
    }
    /// A journal makes the directory/metadata pair recoverable if the desktop
    /// exits between the two renames. All paths must stay inside this root.
    fn recover(&self) -> Result<()> {
        let journal = self.root.join("transaction.json");
        if !journal.exists() {
            return Ok(());
        }
        let transaction = read_object(&journal)?;
        let backup = transaction["backup"]
            .as_str()
            .ok_or("Invalid Agent recovery journal")?;
        if !backup.starts_with("scripts-old-") || backup.contains(['/', '\\']) {
            return Err("Invalid Agent backup path".into());
        }
        let backup = self.root.join(backup);
        // Restore the previous library and metadata instead of guessing which
        // portion of an interrupted update reached disk.
        if backup.exists() {
            if self.directory().exists() {
                let interrupted = self
                    .root
                    .join(format!("scripts-interrupted-{}", uuid::Uuid::new_v4()));
                fs::rename(self.directory(), interrupted).map_err(|e| e.to_string())?;
            }
            fs::rename(backup, self.directory()).map_err(|e| e.to_string())?;
            write_atomic(&self.metadata_path(), &transaction["previousMetadata"])?;
        }
        fs::remove_file(journal).map_err(|e| e.to_string())
    }
    pub fn ensure(&self, force: bool) -> Result<Value> {
        with_lock(&self.metadata_path(), || {
            self.recover()?;
            let metadata = self.metadata();
            let usable = count(&self.directory()) > 0;
            let now = gsm_settings::profiles::now();
            if !force
                && usable
                && now.saturating_sub(metadata["checkedAt"].as_u64().unwrap_or(0))
                    < 24 * 60 * 60 * 1000
            {
                return Ok(self.status(&metadata, false));
            }
            let snapshot = (|| -> Result<(String, String)> {
                let repo = crate::fetch_json(&self.api)?;
                let branch = repo["default_branch"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("main")
                    .to_owned();
                let mut url = reqwest::Url::parse(&format!("{}/commits/", self.api))
                    .map_err(|e| e.to_string())?;
                url.path_segments_mut()
                    .map_err(|_| "Invalid repository URL")?
                    .pop_if_empty()
                    .push(&branch);
                let commit = crate::fetch_json(url.as_str())?["sha"]
                    .as_str()
                    .ok_or("Missing Agent commit")?
                    .to_owned();
                if commit.len() != 40 || !commit.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err("Invalid Agent commit".into());
                }
                Ok((branch, commit))
            })();
            let (branch, commit) = match snapshot {
                Ok(v) => v,
                Err(e) if usable => {
                    let mut status = self.status(&metadata, false);
                    status["warning"] =
                        json!(format!("Could not check for Agent script updates: {e}"));
                    return Ok(status);
                }
                Err(e) => return Err(e),
            };
            if !force && usable && metadata["commit"] == commit {
                let mut next = metadata.clone();
                next["branch"] = json!(branch);
                next["checkedAt"] = json!(now);
                next["scriptCount"] = json!(count(&self.directory()));
                write_atomic(&self.metadata_path(), &next)?;
                return Ok(self.status(&next, false));
            }
            let temporary = self.root.join(format!("download-{}", uuid::Uuid::new_v4()));
            let result = (|| {
                let incoming = self.unpack(&commit, &temporary)?;
                if count(&incoming) == 0 {
                    return Err("Agent archive contains no scripts".into());
                }
                let mut next_hashes = hashes(&incoming)?;
                let previous: Hashes = if !metadata["fileHashes"].is_null() {
                    serde_json::from_value(metadata["fileHashes"].clone()).unwrap_or_default()
                } else if let Some(old) = metadata["commit"]
                    .as_str()
                    .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                {
                    if old == commit {
                        next_hashes.clone()
                    } else {
                        self.unpack(old, &temporary.join("previous"))
                            .and_then(|r| hashes(&r))
                            .unwrap_or_default()
                    }
                } else {
                    Hashes::new()
                };
                preserve(&self.directory(), &incoming, &previous, &mut next_hashes)?;
                let next = json!({"repository":REPOSITORY,"branch":branch,"commit":commit,"checkedAt":now,"installedAt":now,"scriptCount":count(&incoming),"fileHashes":next_hashes});
                let backup = format!("scripts-old-{}", uuid::Uuid::new_v4());
                let journal = self.root.join("transaction.json");
                write_atomic(
                    &journal,
                    &json!({"backup":backup,"previousMetadata":metadata}),
                )?;
                let install = (|| -> Result<()> {
                    if self.directory().exists() {
                        fs::rename(self.directory(), self.root.join(&backup))
                            .map_err(|e| e.to_string())?;
                    }
                    fs::rename(&incoming, self.directory()).map_err(|e| e.to_string())?;
                    write_atomic(&self.metadata_path(), &next)?;
                    fs::remove_file(&journal).map_err(|e| e.to_string())?;
                    Ok(())
                })();
                if let Err(error) = install {
                    self.recover()
                        .map_err(|recovery| format!("{error}; recovery: {recovery}"))?;
                    return Err(error);
                }
                // Keep the previous tree intact as recovery material. Never
                // delete user-owned scripts merely to reclaim installation space.
                Ok(self.status(&next, true))
            })();
            if !self.root.join("transaction.json").exists() {
                let _ = fs::remove_dir_all(temporary);
            }
            result
        })
    }
}
