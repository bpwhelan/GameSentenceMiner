use super::*;
use crate::obs_service::ObsError;
use serde::Deserialize;
use tokio::time::{timeout_at, Instant};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Action {
    SaveReplay,
    LongplayStart,
    LongplayStop,
    RecordStart,
    RecordStop,
}

impl Action {
    fn method(self) -> &'static str {
        match self {
            Self::SaveReplay => "SaveReplayBuffer",
            Self::LongplayStart => "StartReplayBuffer",
            Self::LongplayStop => "StopReplayBuffer",
            Self::RecordStart => "StartRecord",
            Self::RecordStop => "StopRecord",
        }
    }

    fn result(self, response: Result<Value, ObsError>) -> Result<Value, String> {
        // OBS checks the current output state inside Start/Stop. Its v5
        // OutputRunning/OutputNotRunning replies replace a separate status RPC.
        let data = match response {
            Err(error) => {
                return match (self, error.code) {
                    (Self::LongplayStart | Self::RecordStart, 500)
                    | (Self::LongplayStop | Self::RecordStop, 501) => Ok(json!({"changed":false})),
                    _ => Err(format!(
                        "{} ({}): {}",
                        self.method(),
                        error.code,
                        error.message
                    )),
                };
            }
            Ok(data) => data,
        };
        match self {
            Self::SaveReplay => Ok(data),
            Self::RecordStop => Ok(json!({"changed":true,"outputPath":data["outputPath"]})),
            _ => Ok(json!({"changed":true})),
        }
    }
}

#[derive(Deserialize)]
struct Request {
    action: Action,
    deadline: u64,
}

impl Obs {
    pub async fn mining_output(
        &self,
        app: &tauri::AppHandle,
        payload: &Value,
        now_ms: u64,
    ) -> Result<Value, String> {
        let request: Request = serde_json::from_value(payload.clone()).map_err(err)?;
        let budget_ms = request.deadline.saturating_sub(now_ms).min(
            if matches!(
                request.action,
                Action::RecordStop | Action::LongplayStop | Action::SaveReplay
            ) {
                35_000
            } else {
                10_000
            },
        );
        if budget_ms == 0 {
            return Err("OBS output request expired".into());
        }
        self.output(app, request.action, Duration::from_millis(budget_ms))
            .await
    }

    pub(super) async fn save_replay(&self, app: &tauri::AppHandle) -> Result<Value, String> {
        self.output(app, Action::SaveReplay, Duration::from_secs(35))
            .await
    }

    async fn output(
        &self,
        app: &tauri::AppHandle,
        action: Action,
        budget: Duration,
    ) -> Result<Value, String> {
        let deadline = Instant::now() + budget;
        // An update can be waiting for the backend to quit while it owns the
        // write lock. Fail immediately instead of queuing a command after it.
        let _lifecycle = self
            .0
            .lifecycle
            .try_read()
            .map_err(|_| "OBS is changing its runtime")?;
        if self.0.suspended.load(Ordering::SeqCst) {
            return Err("OBS is being updated or closed".into());
        }
        let _recording = timeout_at(deadline, self.0.recording.lock())
            .await
            .map_err(|_| "OBS output request expired")?;
        timeout_at(deadline, self.ensure_connection(app))
            .await
            .map_err(|_| "OBS connection timed out")??;
        let id = self.0.client.primary_id().ok_or("OBS disconnected")?;
        let mut result = self.send_output(&id, action, deadline).await?;
        if result["changed"] == true {
            let recording = match action {
                Action::LongplayStart => Action::RecordStart,
                Action::LongplayStop => Action::RecordStop,
                _ => return Ok(result),
            };
            // Replay has already changed. Report a recording failure separately
            // so the backend still accounts for that transition exactly once.
            match self.send_output(&id, recording, deadline).await {
                Ok(data) => result["recording"] = data,
                Err(error) => result["recordingError"] = json!(error),
            }
        }
        Ok(result)
    }

    async fn send_output(
        &self,
        id: &str,
        action: Action,
        deadline: Instant,
    ) -> Result<Value, String> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("OBS output request expired")?;
        action.result(
            self.0
                .client
                .call(id, action.method().into(), Value::Null, remaining)
                .await,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failure(code: i64) -> Result<Value, ObsError> {
        Err(ObsError {
            code,
            message: "output state".into(),
        })
    }

    #[test]
    fn only_an_already_satisfied_transition_is_a_noop() {
        for action in [Action::LongplayStart, Action::RecordStart] {
            assert_eq!(action.result(failure(500)).unwrap()["changed"], false);
            assert!(action.result(failure(501)).is_err());
        }
        for action in [Action::LongplayStop, Action::RecordStop] {
            assert_eq!(action.result(failure(501)).unwrap()["changed"], false);
            assert!(action.result(failure(500)).is_err());
        }
        assert!(Action::RecordStop.result(failure(-1)).is_err());
    }

    #[test]
    fn preserves_recording_path_and_rejects_unknown_actions() {
        assert_eq!(
            Action::RecordStop
                .result(Ok(json!({"outputPath":"録画.mkv"})))
                .unwrap()["outputPath"],
            "録画.mkv"
        );
        assert!(serde_json::from_value::<Request>(
            json!({"action":"SetProfileParameter","deadline":1})
        )
        .is_err());
    }
}
