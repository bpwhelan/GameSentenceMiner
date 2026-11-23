use super::*;
use crate::mining_workspace::{invoke, MiningWorkspace};

pub(super) async fn run(app: &AppHandle) -> Result<Value, String> {
    let obs = app.state::<crate::obs::Obs>();
    let workspace = app.state::<MiningWorkspace>();
    let start = |name: &str| {
        invoke(
            app,
            "speech-recognition.start",
            json!({
                "scene": {"id": "smoke", "name": name},
                "settings": {"backend": "sapi", "language": "ja"}
            }),
        )
    };
    let scene = "Speech fixture";
    obs.set_smoke_target(scene, 1);
    if start("Other scene").await?["success"] != false {
        return Err("Speech accepted a mismatched scene".into());
    }
    let reply = start(scene).await?;
    if reply["success"] != true {
        return Err(reply.to_string());
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let latest = invoke(app, "textprocess.latestText", Value::Null).await?;
            if latest["source"] == "speech_recognition" && latest["text"] == "結果63" {
                return Ok::<_, String>(());
            }
            let status = workspace.speech.status();
            if status["state"] == "error" {
                return Err(status.to_string());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .map_err(|_| "Final recognition did not reach the reader")??;
    obs.set_smoke_target("Other scene", 2);
    tokio::time::timeout(Duration::from_secs(2), async {
        while workspace.speech.status()["reason"] != "scene changed" {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .map_err(|_| "Speech stayed attached after switching scenes")?;
    let reply = start("Other scene").await?;
    if reply["success"] != true {
        return Err(reply.to_string());
    }
    invoke(app, "speech-recognition.stop", Value::Null).await?;
    if workspace.speech.status()["state"] != "idle" {
        return Err("Speech did not stop".into());
    }
    Ok(json!({"latest":"結果63","stopped":true}))
}
