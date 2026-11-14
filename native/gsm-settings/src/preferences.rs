//! Desktop preferences retain electron/config.json. Defaults are a read view;
//! opening an old installation never rewrites or prunes its saved document.
use crate::{read_object, with_lock, write_atomic, Result};
use serde_json::{json, Value};
use std::path::PathBuf;
#[derive(Clone)]
pub struct Preferences {
    pub file: PathBuf,
}
impl Preferences {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            file: root.into().join("electron/config.json"),
        }
    }
    pub fn snapshot(&self) -> Result<Value> {
        read_object(&self.file)
    }
    pub fn get(&self, key: &str) -> Result<Option<Value>> {
        let document = self.snapshot()?;
        let mut current = &document;
        for part in components(key)? {
            let Some(next) = current.get(&part) else {
                return Ok(None);
            };
            current = next;
        }
        Ok(Some(current.clone()))
    }
    pub fn patch(&self, values: &Value) -> Result<Value> {
        let entries = values.as_object().ok_or("Expected a preference patch")?;
        let parsed: Vec<_> = entries
            .iter()
            .map(|(key, value)| Ok((components(key)?, value)))
            .collect::<Result<_>>()?;
        with_lock(&self.file, || {
            let mut document = self.snapshot()?;
            for (parts, value) in parsed {
                insert(&mut document, &parts, value.clone())?;
            }
            write_atomic(&self.file, &document)?;
            Ok(document)
        })
    }
    pub fn delete(&self, key: &str) -> Result<()> {
        let parts = components(key)?;
        with_lock(&self.file, || {
            let mut document = self.snapshot()?;
            let mut current = &mut document;
            for part in &parts[..parts.len() - 1] {
                let Some(next) = current.get_mut(part) else {
                    return Ok(());
                };
                current = next;
            }
            if let Some(map) = current.as_object_mut() {
                map.remove(parts.last().unwrap());
            }
            write_atomic(&self.file, &document)
        })
    }
}
fn components(key: &str) -> Result<Vec<String>> {
    let mut parts = Vec::new();
    let mut segment = String::new();
    let mut escaped = false;
    for ch in key.chars() {
        if escaped {
            segment.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '.' {
            parts.push(std::mem::take(&mut segment));
        } else {
            segment.push(ch);
        }
    }
    if escaped {
        segment.push('\\');
    }
    parts.push(segment);
    if parts
        .iter()
        .any(|s| s.is_empty() || matches!(s.as_str(), "__proto__" | "prototype" | "constructor"))
    {
        return Err("Invalid preference key".into());
    }
    Ok(parts)
}
fn insert(document: &mut Value, parts: &[String], value: Value) -> Result<()> {
    let Some(map) = document.as_object_mut() else {
        return Err("Preference parent is not an object".into());
    };
    if parts.len() == 1 {
        map.insert(parts[0].clone(), value);
    } else {
        let entry = map.entry(parts[0].clone()).or_insert_with(|| json!({}));
        // Match existing dot-path setters when replacing a scalar parent.
        if !entry.is_object() {
            *entry = json!({});
        }
        insert(entry, &parts[1..], value)?;
    }
    Ok(())
}
