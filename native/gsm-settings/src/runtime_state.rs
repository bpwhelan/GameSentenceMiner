//! Ephemeral runtime state shared across desktop windows in memory.
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::sync::RwLock;

#[derive(Default)]
pub struct RuntimeState {
    entries: RwLock<BTreeMap<String, Value>>,
}

impl RuntimeState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        self.entries
            .read()
            .expect("runtime state lock poisoned")
            .get(key)
            .cloned()
    }

    /// Inserts or replaces a key, returning `(new_value, previous_value)`.
    pub fn set(&self, key: impl Into<String>, value: Value) -> (Value, Option<Value>) {
        let mut guard = self.entries.write().expect("runtime state lock poisoned");
        let previous = guard.insert(key.into(), value.clone());
        (value, previous)
    }

    /// Removes a key, returning its previous value if one existed.
    pub fn remove(&self, key: &str) -> Option<Value> {
        self.entries
            .write()
            .expect("runtime state lock poisoned")
            .remove(key)
    }

    pub fn get_all(&self) -> Map<String, Value> {
        self.entries
            .read()
            .expect("runtime state lock poisoned")
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    pub fn clear(&self) {
        self.entries
            .write()
            .expect("runtime state lock poisoned")
            .clear();
    }
}

#[cfg(test)]
mod tests {
    use super::RuntimeState;
    use serde_json::json;

    #[test]
    fn crud_operations_track_previous_values_and_clear_cleanly() {
        let state = RuntimeState::new();
        assert_eq!(state.get("obs.activeScene"), None);

        let (next, prev) = state.set("obs.activeScene", json!("Clannad"));
        assert_eq!(next, json!("Clannad"));
        assert_eq!(prev, None);
        assert_eq!(state.get("obs.activeScene"), Some(json!("Clannad")));

        let (next, prev) = state.set("obs.activeScene", json!("Steins;Gate"));
        assert_eq!(next, json!("Steins;Gate"));
        assert_eq!(prev, Some(json!("Clannad")));

        let _ = state.set("count", json!(42));
        let all = state.get_all();
        assert_eq!(all.len(), 2);
        assert_eq!(all["obs.activeScene"], json!("Steins;Gate"));
        assert_eq!(all["count"], json!(42));

        assert_eq!(state.remove("obs.activeScene"), Some(json!("Steins;Gate")));
        assert_eq!(state.remove("obs.activeScene"), None);
        assert_eq!(state.get("obs.activeScene"), None);

        state.clear();
        assert!(state.get_all().is_empty());
    }
}
