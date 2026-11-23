//! Saved clips loader, card matcher, and temporary replay copy helper (`util/clips.py` + `clip_cards.py`).
mod capture;
use crate::config::{AnkiCard, ProfileConfig};
use crate::pause_gaps::PauseHistory;
use crate::text::{find_matching_line, make_unique_temp_file, parse_iso_to_epoch, GameLine};
pub use capture::{find_saved_folder, ClipWindow};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

pub const CLIPS_FOLDER_NAME: &str = "Clips";
pub const MANIFEST_NAME: &str = "manifest.json";
pub const MIN_SAVED_CLIP_MATCH_SCORE: f64 = 90.0;

#[derive(Debug, Clone)]
pub struct SavedClip {
    pub folder: PathBuf,
    pub clip_path: PathBuf,
    pub clip_end_epoch: f64,
    pub lines: Vec<GameLine>,
    pub selected: Vec<GameLine>,
    pub pauses: Vec<(f64, f64)>,
}

pub fn get_clips_root(config: &ProfileConfig) -> Option<PathBuf> {
    if config.paths.output_folder.trim().is_empty() {
        return None;
    }
    Some(Path::new(&config.paths.output_folder).join(CLIPS_FOLDER_NAME))
}

pub fn load_clip(folder: &Path) -> Result<SavedClip, String> {
    let manifest_path = folder.join(MANIFEST_NAME);
    let bytes = std::fs::read(&manifest_path).map_err(|e| e.to_string())?;
    let manifest: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let clip_obj = manifest
        .get("clip")
        .and_then(Value::as_object)
        .ok_or("Missing clip metadata in manifest")?;
    let clip_file = clip_obj
        .get("file")
        .and_then(Value::as_str)
        .ok_or("Missing clip file")?;
    let end_str = clip_obj
        .get("end_time")
        .and_then(Value::as_str)
        .ok_or("Missing clip end_time")?;
    let clip_end_epoch = parse_iso_to_epoch(end_str).ok_or("Invalid clip end_time")?;
    let clip_path = folder.join(clip_file);
    let clip_folder_str = folder.to_string_lossy().into_owned();
    let clip_path_str = clip_path.to_string_lossy().into_owned();

    let raw_lines = manifest
        .get("lines")
        .and_then(Value::as_array)
        .ok_or("Missing lines in manifest")?;
    let mut lines: Vec<GameLine> = Vec::with_capacity(raw_lines.len());
    let mut selected_indices = Vec::new();

    for (idx, entry) in raw_lines.iter().enumerate() {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Missing line id")?
            .to_string();
        let text = entry
            .get("text")
            .and_then(Value::as_str)
            .ok_or("Missing line text")?
            .to_string();
        let time_str = entry
            .get("time")
            .and_then(Value::as_str)
            .ok_or("Missing line time")?;
        let time_epoch = parse_iso_to_epoch(time_str).ok_or("Invalid line time")?;
        let scene = entry
            .get("scene")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let source = entry
            .get("source")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let source_padding = entry
            .get("source_padding")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let prev_id = lines.last().map(|l| l.id.clone());
        if let Some(prev) = lines.last_mut() {
            prev.next_id = Some(id.clone());
        }
        if entry.get("role").and_then(Value::as_str) == Some("selected") {
            selected_indices.push(idx);
        }
        lines.push(GameLine {
            id,
            text,
            time_epoch,
            index: idx as i64,
            scene,
            source,
            // Old saved manifests loaded into GameLine with zero explicit padding.
            source_padding: Some(source_padding),
            mined_time_epoch: Some(clip_end_epoch),
            excluded_from_stats: false,
            session_id: String::new(),
            first_seen_time_epoch: Some(time_epoch),
            translation: String::new(),
            prev_id,
            next_id: None,
            clip_folder: Some(clip_folder_str.clone()),
            clip_path: Some(clip_path_str.clone()),
            clip_end_time_epoch: Some(clip_end_epoch),
        });
    }

    let selected = selected_indices
        .into_iter()
        .filter_map(|i| lines.get(i).cloned())
        .collect();
    let pauses = manifest
        .get("pauses")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let pair = p.as_array()?;
                    Some((pair.first()?.as_f64()?, pair.get(1)?.as_f64()?))
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(SavedClip {
        folder: folder.to_path_buf(),
        clip_path,
        clip_end_epoch,
        lines,
        selected,
        pauses,
    })
}

fn directories(root: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<_> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect();
    entries.sort();
    entries
}

fn folders(root: &Path) -> impl DoubleEndedIterator<Item = PathBuf> {
    directories(root)
        .into_iter()
        .flat_map(|day| directories(&day))
}

pub fn iter_clips(clips_root: &Path) -> Vec<SavedClip> {
    folders(clips_root)
        .filter_map(|folder| load_clip(&folder).ok())
        .collect()
}

/// Read the library once for missing reader IDs. Older manifests win in the same
/// order as the legacy reader. Context-only lines are never selected as targets.
pub fn saved_selections(
    root: &Path,
    mut missing: std::collections::HashSet<&str>,
) -> std::collections::HashMap<String, std::sync::Arc<SavedClip>> {
    use std::sync::Arc;
    let mut result = std::collections::HashMap::new();
    for clip in folders(root).filter_map(|p| load_clip(&p).ok()) {
        let matched: Vec<_> = clip
            .selected
            .iter()
            .filter(|l| missing.remove(l.id.as_str()))
            .map(|l| l.id.clone())
            .collect();
        if !matched.is_empty() {
            let clip = Arc::new(clip);
            result.extend(matched.into_iter().map(|id| (id, clip.clone())));
            if missing.is_empty() {
                break;
            }
        }
    }
    result
}

/// Load one manifest at a time so listing a library does not retain all its context lines.
pub fn catalog(root: Option<&Path>) -> Value {
    let Some(root) = root else {
        return json!({"clips":[],"error":"No output folder is set in the Paths settings."});
    };
    let clips = folders(root)
        .rev()
        .filter_map(|folder| {
            let clip = load_clip(&folder).ok()?;
            let id = folder
                .strip_prefix(root)
                .ok()?
                .to_str()?
                .replace(std::path::MAIN_SEPARATOR, "/");
            let size = std::fs::metadata(&clip.clip_path)
                .ok()
                .filter(|m| m.is_file())
                .map_or(0, |m| m.len());
            let lines = clip
                .selected
                .into_iter()
                .map(|line| json!({"id":line.id,"text":line.text}))
                .collect::<Vec<_>>();
            Some(json!({"id":id,"size_bytes":size,"lines":lines}))
        })
        .collect::<Vec<_>>();
    json!({"clips":clips})
}

/// Resolve a batch against one canonical library root. Existing settings may
/// legitimately use a link or junction as the library location.
pub struct ClipFolders(PathBuf);

impl ClipFolders {
    pub fn open(root: &Path) -> Option<Self> {
        Some(Self(root.canonicalize().ok()?))
    }
    pub fn resolve(&self, id: &str) -> Option<PathBuf> {
        let (day, name) = id.split_once('/')?;
        let normal = |part: &str| {
            !part.contains(['/', '\\', ':'])
                && matches!(
                    Path::new(part).components().next(),
                    Some(Component::Normal(_))
                )
        };
        if !normal(day) || !normal(name) {
            return None;
        }
        let expected = self.0.join(day).join(name);
        let folder = expected.canonicalize().ok()?;
        if folder != expected || !folder.join(MANIFEST_NAME).is_file() {
            return None;
        }
        Some(folder)
    }
}

pub fn match_card_to_clip(
    card: &AnkiCard,
    config: &ProfileConfig,
    clips_root: &Path,
) -> Option<(GameLine, SavedClip)> {
    let clips = iter_clips(clips_root);
    let mut candidates: Vec<(GameLine, usize)> = Vec::new();
    for (clip_idx, clip) in clips.iter().enumerate() {
        if !clip.clip_path.is_file() {
            continue;
        }
        for line in &clip.selected {
            candidates.push((line.clone(), clip_idx));
        }
    }
    candidates.sort_by(|a, b| a.0.time_epoch.total_cmp(&b.0.time_epoch));
    let lines_only: Vec<GameLine> = candidates.iter().map(|(l, _)| l.clone()).collect();
    let matched = find_matching_line(
        card,
        &config.anki,
        &lines_only,
        false,
        false,
        0.0,
        MIN_SAVED_CLIP_MATCH_SCORE,
    )?;
    let (_, clip_idx) = candidates
        .iter()
        .find(|(l, _)| l.id == matched.id && l.clip_folder == matched.clip_folder)?;
    Some((matched.clone(), clips[*clip_idx].clone()))
}

/// Hard-link (or copy) a clip's video into `temp_dir`, set mtime to `clip.clip_end_epoch`,
/// and register the clip's recorded pauses in `pause_history`.
pub fn replay_copy(
    clip: &SavedClip,
    temp_dir: &Path,
    pause_history: &PauseHistory,
) -> Result<PathBuf, String> {
    pause_history.remember_pauses(&clip.pauses);
    let dest = make_unique_temp_file(temp_dir, &clip.clip_path);
    if std::fs::hard_link(&clip.clip_path, &dest).is_err() {
        std::fs::copy(&clip.clip_path, &dest).map_err(|e| e.to_string())?;
    }
    if clip.clip_end_epoch > 0.0 {
        let secs = clip.clip_end_epoch.floor() as u64;
        let nanos = ((clip.clip_end_epoch - secs as f64).clamp(0.0, 0.999_999_999) * 1e9) as u32;
        let target_time = UNIX_EPOCH + Duration::new(secs, nanos);
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&dest) {
            let _ = f.set_modified(target_time);
        }
    }
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AnkiCardField;
    use serde_json::json;

    #[test]
    fn loads_saved_clip_and_matches_card() {
        let dir = tempfile::tempdir().unwrap();
        let clip_dir = dir
            .path()
            .join("Clips")
            .join("2026-11-19")
            .join("12-00-00-000_test");
        std::fs::create_dir_all(&clip_dir).unwrap();
        std::fs::write(clip_dir.join("clip.mkv"), b"fakevideo").unwrap();
        let manifest = json!({
            "clip": {"file": "clip.mkv", "end_time": "2026-11-19T12:00:05.000000"},
            "lines": [
                {"id": "l1", "text": "前の台詞", "time": "2026-11-19T12:00:00.000000", "role": "previous", "scene": "VN"},
                {"id": "l2", "text": "昨日の図書館で待っていた", "time": "2026-11-19T12:00:02.000000", "role": "selected", "scene": "VN"}
            ],
            "pauses": [[100.0, 102.0]]
        });
        std::fs::write(clip_dir.join("manifest.json"), manifest.to_string()).unwrap();

        let cfg = ProfileConfig::default();
        let card = AnkiCard {
            note_id: 99,
            tags: vec![],
            fields: vec![
                (
                    "Expression".into(),
                    AnkiCardField {
                        value: "図書館".into(),
                        order: 0,
                    },
                ),
                (
                    "Sentence".into(),
                    AnkiCardField {
                        value: "昨日の<b>図書館</b>で待っていた".into(),
                        order: 1,
                    },
                ),
            ],
            cards: vec![100],
            model_name: "Lapis".into(),
        };
        let (line, clip) = match_card_to_clip(&card, &cfg, &dir.path().join("Clips")).unwrap();
        assert_eq!(line.id, "l2");
        assert_eq!(clip.pauses, vec![(100.0, 102.0)]);
    }
}
