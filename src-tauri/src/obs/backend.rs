//! Compatibility requests from the authenticated mining backend share the primary socket.
use super::*;
use std::collections::HashMap;

#[derive(Default)]
pub(super) struct Images(Mutex<HashMap<uuid::Uuid, String>>);

impl Obs {
    pub async fn backend_request(&self, topic: &str, request: &Value) -> Result<Value, String> {
        if topic == "obs.imageChunk" {
            let id = text(request, "id").parse().map_err(err)?;
            let mut images = self.0.images.0.lock().unwrap();
            let data = images.get(&id).ok_or("OBS image transfer expired")?;
            let start = request["offset"]
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .filter(|n| *n < data.len())
                .ok_or("Invalid OBS image offset")?;
            let end = start.saturating_add(2 << 20).min(data.len());
            let chunk = data
                .get(start..end)
                .ok_or("Invalid OBS image data")?
                .to_owned();
            if end == data.len() {
                images.remove(&id);
            }
            return Ok(Value::String(chunk));
        }
        let method = text(request, "method");
        if !matches!(
            method,
            "GetVersion"
                | "GetSceneList"
                | "GetCurrentProgramScene"
                | "GetInputAudioTracks"
                | "GetInputList"
                | "GetInputSettings"
                | "GetOutputList"
                | "GetOutputSettings"
                | "GetProfileParameter"
                | "GetRecordDirectory"
                | "GetRecordStatus"
                | "GetReplayBufferStatus"
                | "GetSceneItemList"
                | "GetSourceActive"
                | "GetSourceScreenshot"
                | "GetStreamStatus"
                | "GetVideoSettings"
                | "SaveSourceScreenshot"
                | "SetInputAudioTracks"
                | "SetOutputSettings"
                | "SetProfileParameter"
                | "SetRecordDirectory"
                | "SetSceneItemEnabled"
                | "SetSceneItemTransform"
                | "SetVideoSettings"
                | "StartStream"
                | "StopStream"
                | "StartRecord"
                | "StopRecord"
                | "StartReplayBuffer"
                | "StopReplayBuffer"
                | "ToggleReplayBuffer"
        ) {
            return Err("Unsupported backend OBS request".into());
        }
        let _lifecycle = self
            .0
            .lifecycle
            .try_read()
            .map_err(|_| "OBS runtime is changing")?;
        if self.0.suspended.load(Ordering::Acquire) {
            return Err("OBS runtime is suspended".into());
        }
        let output = !method.starts_with("Get") && !method.starts_with("SaveSource");
        let _recording = if output {
            Some(self.0.recording.lock().await)
        } else {
            None
        };
        if output {
            self.0.policy.lock().unwrap().expect_method(method);
        }
        let response = match self
            .0
            .client
            .primary_call(method, request["data"].clone())
            .await
        {
            Ok(data) => data,
            Err(error) => return Ok(json!({"error":error})),
        };
        // The desktop bus has an 8 MiB frame limit. Do not recapture a frame
        // between chunks. A disconnected reader can retain at most four images.
        if method == "GetSourceScreenshot"
            && response["imageData"]
                .as_str()
                .is_some_and(|s| s.len() > 6 << 20)
        {
            let mut response = response;
            let Value::String(data) = response["imageData"].take() else {
                unreachable!()
            };
            let id = uuid::Uuid::new_v4();
            let size = data.len();
            let mut images = self.0.images.0.lock().unwrap();
            if images.len() >= 4 {
                return Err("Too many large OBS image transfers".into());
            }
            images.insert(id, data);
            let obs = self.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(60)).await;
                obs.0.images.0.lock().unwrap().remove(&id);
            });
            return Ok(json!({"transfer":id,"size":size}));
        }
        Ok(Value::Object(serde_json::Map::from_iter([(
            "response".into(),
            response,
        )])))
    }
}
