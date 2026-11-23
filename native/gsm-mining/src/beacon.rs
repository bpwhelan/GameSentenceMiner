//! AnkiBeacon push event receiver state, deduplication, and heartbeat tracking.
use serde_json::Value;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Notify};

#[derive(Debug, Clone)]
pub struct BeaconNoteEvent {
    pub session_id: String,
    pub note_id: u64,
    pub payload: Value,
    pub received_at: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeaconEventOutcome {
    Heartbeat,
    DuplicateNoteAdded,
    NoteAdded,
}

#[derive(Debug, Default)]
struct BeaconInner {
    last_heartbeat_at: Option<Instant>,
    session_id: String,
    heartbeat_interval_seconds: f64,
    payload_mode: String,
    processed_keys: HashSet<(String, u64)>,
}

#[derive(Clone)]
pub struct BeaconReceiver {
    inner: Arc<Mutex<BeaconInner>>,
    tx: mpsc::Sender<BeaconNoteEvent>,
    wake: Arc<Notify>,
}

impl BeaconReceiver {
    pub fn new(capacity: usize) -> (Self, mpsc::Receiver<BeaconNoteEvent>) {
        let (tx, rx) = mpsc::channel(capacity.max(16));
        (
            Self {
                inner: Arc::new(Mutex::new(BeaconInner::default())),
                tx,
                wake: Arc::new(Notify::new()),
            },
            rx,
        )
    }

    pub fn wake_notifier(&self) -> Arc<Notify> {
        Arc::clone(&self.wake)
    }

    pub fn handle_event(&self, payload: Value) -> Result<BeaconEventOutcome, (u16, String)> {
        let Some(obj) = payload.as_object() else {
            return Err((400, "Expected a JSON object payload.".into()));
        };
        let event = obj
            .get("event")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();

        if event == "heartbeat" {
            let session_id = obj
                .get("session_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let payload_mode = obj
                .get("payload_mode")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let interval = obj
                .get("heartbeat_interval_seconds")
                .and_then(|v| {
                    v.as_f64()
                        .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
                })
                .filter(|s| Duration::try_from_secs_f64(3.0 * s).is_ok())
                .unwrap_or(0.0)
                .max(0.0);

            if let Ok(mut guard) = self.inner.lock() {
                if !session_id.is_empty() && session_id != guard.session_id {
                    guard.processed_keys.clear();
                }
                guard.last_heartbeat_at = Some(Instant::now());
                guard.session_id = session_id;
                guard.heartbeat_interval_seconds = interval;
                guard.payload_mode = payload_mode;
            }
            self.wake.notify_waiters();
            return Ok(BeaconEventOutcome::Heartbeat);
        }

        if event != "note_added" {
            let label = if event.is_empty() {
                "missing event"
            } else {
                event.as_str()
            };
            return Err((400, format!("Unsupported Anki event: {label}")));
        }

        let note_id = obj
            .get("note_id")
            .and_then(|v| {
                v.as_u64()
                    .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
            })
            .filter(|&id| id > 0)
            .ok_or_else(|| {
                (
                    400,
                    "note_added payload must include a valid note_id.".into(),
                )
            })?;
        let session_id = obj
            .get("session_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let key = (session_id.clone(), note_id);

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| (500, "Beacon lock poisoned".into()))?;
        if guard.processed_keys.contains(&key) {
            return Ok(BeaconEventOutcome::DuplicateNoteAdded);
        }
        // A concurrent duplicate may only receive success once delivery is guaranteed.
        let slot = self
            .tx
            .try_reserve()
            .map_err(|_| (503, "Anki event mailbox is backpressured".to_owned()))?;
        guard.processed_keys.insert(key);
        slot.send(BeaconNoteEvent {
            session_id,
            note_id,
            payload,
            received_at: Instant::now(),
        });
        drop(guard);
        self.wake.notify_waiters();
        Ok(BeaconEventOutcome::NoteAdded)
    }

    pub fn forget_note(&self, note_id: u64) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.processed_keys.retain(|(_, id)| *id != note_id);
        }
    }

    pub fn remaining_freshness(&self) -> Duration {
        let Ok(guard) = self.inner.lock() else {
            return Duration::ZERO;
        };
        let Some(last) = guard.last_heartbeat_at else {
            return Duration::ZERO;
        };
        let expiry_secs = (3.0 * guard.heartbeat_interval_seconds.max(0.0)).max(30.0);
        let expiry = Duration::from_secs_f64(expiry_secs);
        expiry.saturating_sub(last.elapsed())
    }

    pub fn is_heartbeat_fresh(&self) -> bool {
        !self.remaining_freshness().is_zero()
    }

    pub fn reset(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = BeaconInner::default();
        }
        self.wake.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn full_mailbox_allows_redelivery_and_preserves_accepted_duplicates() {
        let (beacon, mut rx) = BeaconReceiver::new(16);
        let payload = |note_id| json!({"event":"note_added","session_id":"s","note_id":note_id});
        for id in 1..=16 {
            assert_eq!(
                beacon.handle_event(payload(id)).unwrap(),
                BeaconEventOutcome::NoteAdded
            );
        }
        assert_eq!(beacon.handle_event(payload(17)).unwrap_err().0, 503);
        assert_eq!(
            beacon.handle_event(payload(1)).unwrap(),
            BeaconEventOutcome::DuplicateNoteAdded
        );
        let first = rx.try_recv().unwrap();
        assert_eq!(first.note_id, 1);
        assert_eq!(
            beacon.handle_event(payload(17)).unwrap(),
            BeaconEventOutcome::NoteAdded
        );
        beacon.forget_note(first.note_id);
        rx.try_recv().unwrap();
        assert_eq!(
            beacon.handle_event(payload(1)).unwrap(),
            BeaconEventOutcome::NoteAdded
        );
    }

    #[test]
    fn excessive_heartbeat_intervals_use_the_minimum_freshness() {
        let (beacon, _rx) = BeaconReceiver::new(16);
        for value in ["1e307", "NaN", "infinity", "-300"] {
            beacon
                .handle_event(json!({"event":"heartbeat","heartbeat_interval_seconds":value}))
                .unwrap();
            let remaining = beacon.remaining_freshness();
            assert!(remaining <= Duration::from_secs(30) && remaining > Duration::from_secs(29));
        }
    }

    #[test]
    fn handles_heartbeat_deduplication_and_session_reset() {
        let (beacon, mut rx) = BeaconReceiver::new(16);
        assert!(!beacon.is_heartbeat_fresh());
        assert_eq!(
            beacon
                .handle_event(json!({"event": "heartbeat", "session_id": "s1", "heartbeat_interval_seconds": 15}))
                .unwrap(),
            BeaconEventOutcome::Heartbeat
        );
        assert!(beacon.is_heartbeat_fresh());
        assert_eq!(
            beacon
                .handle_event(json!({"event": "note_added", "session_id": "s1", "note_id": 42}))
                .unwrap(),
            BeaconEventOutcome::NoteAdded
        );
        assert_eq!(
            beacon
                .handle_event(json!({"event": "note_added", "session_id": "s1", "note_id": 42}))
                .unwrap(),
            BeaconEventOutcome::DuplicateNoteAdded
        );
        let ev = rx.try_recv().unwrap();
        assert_eq!(ev.note_id, 42);
        // New session clears dedup set
        assert_eq!(
            beacon
                .handle_event(json!({"event": "heartbeat", "session_id": "s2", "heartbeat_interval_seconds": 15}))
                .unwrap(),
            BeaconEventOutcome::Heartbeat
        );
        assert_eq!(
            beacon
                .handle_event(json!({"event": "note_added", "session_id": "s2", "note_id": 42}))
                .unwrap(),
            BeaconEventOutcome::NoteAdded
        );
    }
}
