//! The Python library resolves an OBS scene by exact scene, exact game title,
//! then the first normalized title/scene with a SequenceMatcher ratio of 0.85.
use crate::{History, Result};
use regex::Regex;
use rusqlite::OptionalExtension;
use std::{collections::HashMap, path::Path, sync::LazyLock};

fn normalize(text: &str) -> Vec<char> {
    static VERSION: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)\s*v(?:er)?\.?\s*\d+(?:\.\d+)*").unwrap());
    VERSION
        .replace_all(text, "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
        .chars()
        .collect()
}

fn similar(a: &[char], b: &[char]) -> bool {
    if a == b {
        return true;
    }
    let length = a.len() + b.len();
    if 200 * a.len().min(b.len()) < 85 * length {
        return false;
    }
    let mut positions: HashMap<char, Vec<usize>> = HashMap::new();
    for (j, &c) in b.iter().enumerate() {
        positions.entry(c).or_default().push(j)
    }
    if b.len() >= 200 {
        positions.retain(|_, indexes| indexes.len() <= b.len() / 100 + 1)
    }
    let mut blocks = vec![(0, a.len(), 0, b.len())];
    let mut matched = 0;
    while let Some((alo, ahi, blo, bhi)) = blocks.pop() {
        let (mut i0, mut j0, mut size) = (alo, blo, 0);
        let mut previous = HashMap::new();
        let mut next = HashMap::new();
        for (i, &c) in a.iter().enumerate().take(ahi).skip(alo) {
            next.clear();
            if let Some(indices) = positions.get(&c) {
                let start = indices.partition_point(|&j| j < blo);
                for &j in indices[start..].iter().take_while(|&&j| j < bhi) {
                    let k = 1 + previous.get(&j).copied().unwrap_or(0usize);
                    next.insert(j + 1, k);
                    if k > size {
                        (i0, j0, size) = (i + 1 - k, j + 1 - k, k)
                    }
                }
            }
            std::mem::swap(&mut previous, &mut next);
        }
        while i0 > alo && j0 > blo && a[i0 - 1] == b[j0 - 1] {
            i0 -= 1;
            j0 -= 1;
            size += 1
        }
        while i0 + size < ahi && j0 + size < bhi && a[i0 + size] == b[j0 + size] {
            size += 1
        }
        if size == 0 {
            continue;
        }
        matched += size;
        if 200 * matched >= 85 * length {
            return true;
        }
        if alo < i0 && blo < j0 {
            blocks.push((alo, i0, blo, j0))
        }
        if i0 + size < ahi && j0 + size < bhi {
            blocks.push((i0 + size, ahi, j0 + size, bhi))
        }
    }
    false
}

impl History {
    pub fn dictionary_game_for_scene(&self, path: &Path, scene: &str) -> Result<Option<String>> {
        let scene = scene.trim();
        if scene.is_empty() {
            return Ok(None);
        }
        self.with_reader(path,|db|{
            let exact=db.prepare_cached("SELECT id FROM games WHERE obs_scene_name=?1 OR title_original=?1
                ORDER BY CASE WHEN obs_scene_name=?1 THEN 0 ELSE 1 END,rowid LIMIT 1")?
                .query_row([scene],|r|r.get(0)).optional()?;
            if exact.is_some(){return Ok(exact)}
            let needle=normalize(scene);
            let mut stmt=db.prepare_cached("SELECT id,coalesce(title_original,''),coalesce(obs_scene_name,'') FROM games ORDER BY rowid")?;
            let mut rows=stmt.query([])?;
            while let Some(row)=rows.next()?{
                for column in [1,2] {
                    let name=row.get_ref(column)?.as_str()?;
                    if !name.is_empty() && similar(&needle,&normalize(name)){return Ok(Some(row.get(0)?))}
                }
            }
            Ok(None)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_version_and_typo_variants_at_the_library_threshold() {
        assert!(similar(
            &normalize("　作品名  Ver.1.01"),
            &normalize("作品名")
        ));
        assert!(similar(
            &normalize("a distant galaxy"),
            &normalize("a distant galaxyy")
        ));
        assert!(!similar(
            &normalize("A distant galaxy"),
            &normalize("A different galaxy")
        ));
        assert!(similar(
            &normalize(&format!("p{}z", "a".repeat(202))),
            &normalize(&format!("p{}y", "a".repeat(202)))
        ));
    }
}
