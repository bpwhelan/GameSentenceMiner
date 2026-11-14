//! Typed public Tauri commands. Generic persistence/package RPC remains private
//! to the native desktop host and is not exposed to web content.
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::Manager;
fn authorize(window: &tauri::WebviewWindow, token: &str) -> Result<(), String> {
    crate::authorize(window, token)?;
    if window
        .app_handle()
        .state::<crate::desktop_state::DesktopState>()
        .window_scope(window.label())
        .as_deref()
        != Some("desktop")
    {
        return Err("This window cannot control desktop settings".into());
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(tag="action",rename_all="camelCase")]
pub enum BackendRequest { State, Start, Stop, Restart }
#[tauri::command]
pub async fn backend_lifecycle(request:BackendRequest,token:String,window:tauri::WebviewWindow)->Result<String,String> {
    authorize(&window,&token)?;
    let action=match request {BackendRequest::State=>"state",BackendRequest::Start=>"start",BackendRequest::Stop=>"stop",BackendRequest::Restart=>"restart"};
    crate::backend::dispatch(window.app_handle(),json!({"action":action,"params":{}})).await.map(|v|v.to_string())
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum InstallationRequest {
    Snapshot,
    Retry { #[serde(rename = "sessionId")] session_id: String, attempt: u64 },
}
#[derive(Deserialize)]
#[serde(tag="action", rename_all="camelCase")]
pub enum PythonEnvironmentRequest { Info, Packages, CleanCache }
#[tauri::command]
pub async fn python_environment(request: PythonEnvironmentRequest, token: String, window: tauri::WebviewWindow) -> Result<String,String> {
    authorize(&window,&token)?;
    let action=match request {PythonEnvironmentRequest::Info=>"info",PythonEnvironmentRequest::Packages=>"packages",PythonEnvironmentRequest::CleanCache=>"cleanCacheStrict"};
    crate::python_install::environment(window.app_handle(),action).await.map(|v|v.to_string())
}
#[tauri::command]
pub async fn installation_session(request: InstallationRequest, token: String, window: tauri::WebviewWindow) -> Result<String, String> {
    authorize(&window, &token)?;
    let app = window.app_handle();
    let value = match request {
        InstallationRequest::Snapshot => app.state::<crate::install_session::InstallSessions>().model.snapshot("renderer"),
        InstallationRequest::Retry { session_id, attempt } => crate::install_session::retry(app, window.label(), gsm_packages::install_session::Lease { session_id, attempt }).await,
    };
    Ok(value.to_string())
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum ProfilesRequest {
    List,
    Get {
        #[serde(rename = "exeName")]
        exe_name: String,
        #[serde(rename = "sceneId")]
        scene_id: Option<String>,
    },
    Save {
        profile: Value,
    },
    Delete {
        #[serde(rename = "exeName")]
        exe_name: String,
        #[serde(rename = "sceneId")]
        scene_id: Option<String>,
    },
}
#[tauri::command]
pub async fn hook_profiles(
    request: ProfilesRequest,
    token: String,
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    authorize(&window, &token)?;
    let (action, args) = match request {
        ProfilesRequest::List => ("profiles.list", json!({})),
        ProfilesRequest::Get { exe_name, scene_id } => (
            "profiles.get",
            json!({"exeName":exe_name,"sceneId":scene_id}),
        ),
        ProfilesRequest::Save { profile } => ("profiles.upsert", profile),
        ProfilesRequest::Delete { exe_name, scene_id } => (
            "profiles.delete",
            json!({"exeName":exe_name,"sceneId":scene_id}),
        ),
    };
    let result =
        crate::settings::dispatch(window.app_handle(), json!({"action":action,"params":args}))
            .await;
    match action {
        "profiles.upsert" => Ok(match result {
            Ok(profile) => json!({"success":true,"profile":profile}),
            Err(error) => json!({"success":false,"error":error}),
        }),
        "profiles.delete" => result.map(|_| json!({"success":true})),
        _ => result,
    }
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum UpdatesRequest {
    Status,
    Check,
    Download,
    Version { version: String },
    Automatic { enabled: bool },
}
#[tauri::command]
pub async fn hook_updates(
    request: UpdatesRequest,
    token: String,
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    authorize(&window, &token)?;
    let (action, args) = match request {
        UpdatesRequest::Status => ("state", Value::Null),
        UpdatesRequest::Check => ("check", Value::Null),
        UpdatesRequest::Download => ("download", Value::Null),
        UpdatesRequest::Version { version } => ("version", json!(version)),
        UpdatesRequest::Automatic { enabled } => ("automatic", json!(enabled)),
    };
    crate::hook_updates::dispatch(window.app_handle(), action, args).await
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum MiningRequest {
    LoadText, SaveText { config: Value }, Preview { payload: Value }, LatestText,
    Exclusions, AddExclusion { game: String, text: String }, RemoveExclusion { game: String, text: String },
    LoadSpeech { scene: Value }, SaveSpeech { scene: Value, settings: Value },
    StartSpeech { scene: Value, settings: Value }, StopSpeech, SpeechStatus,
}
#[tauri::command]
pub async fn mining_workspace(request: MiningRequest, token: String, window: tauri::WebviewWindow) -> Result<String, String> {
    authorize(&window, &token)?;
    let (channel, payload) = match request {
        MiningRequest::LoadText => ("textprocess.load", Value::Null),
        MiningRequest::SaveText { config } => ("textprocess.save", config),
        MiningRequest::Preview { payload } => ("textprocess.preview", payload),
        MiningRequest::LatestText => ("textprocess.latestText", Value::Null),
        MiningRequest::Exclusions => ("textprocess.exclusions.list", Value::Null),
        MiningRequest::AddExclusion { game, text } => ("textprocess.exclusions.add", json!({"game":game,"text":text})),
        MiningRequest::RemoveExclusion { game, text } => ("textprocess.exclusions.remove", json!({"game":game,"text":text})),
        MiningRequest::LoadSpeech { scene } => ("speech-recognition.loadScene", json!({"scene":scene})),
        MiningRequest::SaveSpeech { scene, settings } => ("speech-recognition.saveScene", json!({"scene":scene,"settings":settings})),
        MiningRequest::StartSpeech { scene, settings } => ("speech-recognition.start", json!({"scene":scene,"settings":settings})),
        MiningRequest::StopSpeech => ("speech-recognition.stop", Value::Null),
        MiningRequest::SpeechStatus => ("speech-recognition.getStatus", Value::Null),
    };
    // Tauri's postMessage fallback evaluates small JSON objects as JS literals.
    // A JSON string preserves arbitrary game keys (including __proto__) as data.
    crate::mining_workspace::invoke(window.app_handle(), channel, payload).await
        .map(|value| value.to_string())
}
