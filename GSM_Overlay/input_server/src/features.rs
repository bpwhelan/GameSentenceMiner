use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

pub const PROTOCOL_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceFeature {
    Gamepad,
    Keyboard,
    Mecab,
    Sudachi,
    Hoshidicts,
}

impl ServiceFeature {
    pub const ALL: [Self; 5] = [
        Self::Gamepad,
        Self::Keyboard,
        Self::Mecab,
        Self::Sudachi,
        Self::Hoshidicts,
    ];

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "gamepad" => Some(Self::Gamepad),
            "keyboard" => Some(Self::Keyboard),
            "mecab" => Some(Self::Mecab),
            "sudachi" => Some(Self::Sudachi),
            "hoshidicts" => Some(Self::Hoshidicts),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gamepad => "gamepad",
            Self::Keyboard => "keyboard",
            Self::Mecab => "mecab",
            Self::Sudachi => "sudachi",
            Self::Hoshidicts => "hoshidicts",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FeatureSnapshot {
    pub enabled: Vec<&'static str>,
    pub capabilities: Vec<&'static str>,
    pub revision: u64,
}

#[derive(Debug, Default)]
struct RegistryState {
    baseline: HashSet<ServiceFeature>,
    clients: HashMap<u64, HashSet<ServiceFeature>>,
    revision: u64,
}

#[derive(Debug, Clone)]
pub struct FeatureRegistry {
    state: Arc<Mutex<RegistryState>>,
    next_client_id: Arc<AtomicU64>,
    changed: watch::Sender<u64>,
}

impl FeatureRegistry {
    pub fn new(baseline: impl IntoIterator<Item = ServiceFeature>) -> Self {
        let mut baseline = baseline.into_iter().collect::<HashSet<_>>();
        // Gamepad input is the service's inexpensive baseline and cannot be
        // disabled by an optional-feature client.
        baseline.insert(ServiceFeature::Gamepad);
        let (changed, _) = watch::channel(0);
        Self {
            state: Arc::new(Mutex::new(RegistryState {
                baseline,
                ..RegistryState::default()
            })),
            next_client_id: Arc::new(AtomicU64::new(1)),
            changed,
        }
    }

    pub fn register_client(&self) -> u64 {
        let client_id = self.next_client_id.fetch_add(1, Ordering::Relaxed);
        self.state
            .lock()
            .expect("feature registry mutex poisoned")
            .clients
            .insert(client_id, HashSet::new());
        client_id
    }

    pub fn set_client_features(
        &self,
        client_id: u64,
        features: impl IntoIterator<Item = ServiceFeature>,
    ) -> FeatureSnapshot {
        let requested = features
            .into_iter()
            .filter(|feature| *feature != ServiceFeature::Gamepad)
            .collect::<HashSet<_>>();
        let revision = {
            let mut state = self.state.lock().expect("feature registry mutex poisoned");
            let previous = state.clients.insert(client_id, requested.clone());
            if previous.as_ref() != Some(&requested) {
                state.revision += 1;
            }
            state.revision
        };
        self.changed.send_replace(revision);
        self.snapshot()
    }

    pub fn release_client(&self, client_id: u64) -> FeatureSnapshot {
        let revision = {
            let mut state = self.state.lock().expect("feature registry mutex poisoned");
            let changed = state
                .clients
                .remove(&client_id)
                .is_some_and(|features| !features.is_empty());
            if changed {
                state.revision += 1;
            }
            state.revision
        };
        self.changed.send_replace(revision);
        self.snapshot()
    }

    pub fn is_enabled(&self, feature: ServiceFeature) -> bool {
        let state = self.state.lock().expect("feature registry mutex poisoned");
        state.baseline.contains(&feature)
            || state
                .clients
                .values()
                .any(|features| features.contains(&feature))
    }

    pub fn snapshot(&self) -> FeatureSnapshot {
        let state = self.state.lock().expect("feature registry mutex poisoned");
        let enabled = ServiceFeature::ALL
            .into_iter()
            .filter(|feature| {
                state.baseline.contains(feature)
                    || state
                        .clients
                        .values()
                        .any(|features| features.contains(feature))
            })
            .map(ServiceFeature::as_str)
            .collect();
        FeatureSnapshot {
            enabled,
            capabilities: ServiceFeature::ALL
                .into_iter()
                .map(ServiceFeature::as_str)
                .collect(),
            revision: state.revision,
        }
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gamepad_is_always_enabled_and_optional_features_are_leased() {
        let registry = FeatureRegistry::new([]);
        let first = registry.register_client();
        let second = registry.register_client();

        assert!(registry.is_enabled(ServiceFeature::Gamepad));
        assert!(!registry.is_enabled(ServiceFeature::Keyboard));

        registry.set_client_features(
            first,
            [
                ServiceFeature::Keyboard,
                ServiceFeature::Sudachi,
                ServiceFeature::Hoshidicts,
            ],
        );
        registry.set_client_features(second, [ServiceFeature::Keyboard]);
        assert!(registry.is_enabled(ServiceFeature::Keyboard));
        assert!(registry.is_enabled(ServiceFeature::Sudachi));
        assert!(registry.is_enabled(ServiceFeature::Hoshidicts));

        registry.release_client(first);
        assert!(registry.is_enabled(ServiceFeature::Keyboard));
        assert!(!registry.is_enabled(ServiceFeature::Sudachi));
        assert!(!registry.is_enabled(ServiceFeature::Hoshidicts));

        registry.release_client(second);
        assert!(!registry.is_enabled(ServiceFeature::Keyboard));
        assert!(registry.is_enabled(ServiceFeature::Gamepad));
    }

    #[test]
    fn unknown_features_are_rejected_by_parser() {
        assert_eq!(
            ServiceFeature::parse("sudachi"),
            Some(ServiceFeature::Sudachi)
        );
        assert_eq!(
            ServiceFeature::parse("hoshidicts"),
            Some(ServiceFeature::Hoshidicts)
        );
        assert_eq!(ServiceFeature::parse("unknown"), None);
    }
}
