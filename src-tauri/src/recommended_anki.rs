use crate::{anki_connect, desktop_state::DesktopState, native_dialog, settings::Settings};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::LazyLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

pub(crate) type Windows = native_dialog::Sessions<SetupWindow>;
type Fields = Vec<(String, String)>;
const MAX_PACKAGE_BYTES: u64 = 64 * 1024 * 1024;
const CONTEXT_CHANGED: &str =
    "The GSM profile or AnkiConnect URL changed. Run setup again for the current profile.";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Preset {
    id: String,
    name: String,
    #[serde(skip_serializing)]
    repository: String,
    documentation: String,
    gsm_fields: Fields,
    yomitan_fields: Fields,
}

static PRESETS: LazyLock<Vec<Preset>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("recommended_anki_presets.json"))
        .expect("Valid built-in Anki presets")
});
static OPEN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(crate) struct SetupWindow {
    active: tokio::sync::Mutex<Option<String>>,
    path: PathBuf,
}

#[derive(PartialEq, Eq)]
struct Context {
    profile: String,
    server: String,
}

impl Context {
    fn read(doc: &Value) -> Result<Self, String> {
        let profile = doc["current_profile"]
            .as_str()
            .ok_or("Missing active profile")?;
        let server = doc["configs"][profile]["anki"]["url"]
            .as_str()
            .unwrap_or("")
            .trim();
        Ok(Self {
            profile: profile.into(),
            server: server.into(),
        })
    }
}

pub(crate) async fn open(app: &AppHandle) -> Result<Value, String> {
    let Ok(_open) = OPEN.try_lock() else {
        if let Some(window) = app
            .webview_windows()
            .into_iter()
            .find_map(|(label, window)| label.starts_with("recommended-anki-").then_some(window))
        {
            let _ = window.set_focus();
        }
        return Ok(Value::Null);
    };
    let path = app.state::<Settings>().paths.active.join("config.json");
    let session = SetupWindow {
        active: Default::default(),
        path,
    };
    Windows::open(
        app,
        "recommended-anki",
        "Set up recommended Anki cards",
        (740., 700.),
        session,
        None,
        |builder| {
            let builder = builder.min_inner_size(480., 450.);
            match app.get_webview_window(crate::app_lifecycle::HUB_WINDOW_LABEL) {
                Some(parent) => builder.parent(&parent).map_err(|e| e.to_string()),
                None => Ok(builder),
            }
        },
        |_, _, data| data.active.try_lock().is_ok(),
    )
    .await
}

#[derive(Deserialize)]
struct Choice {
    preset: String,
    deck: String,
    yomitan: bool,
}

pub(crate) async fn invoke(
    app: &AppHandle,
    label: &str,
    command: &str,
    value: &Value,
) -> Result<Value, String> {
    let session = Windows::get(app, label)?;
    let data = &session.data;
    match command {
        "recommendedAnki.read" => return Ok(json!(*PRESETS)),
        "recommendedAnki.title" => return native_dialog::title(app, label, value),
        "recommendedAnki.copy" => {
            let text = value.as_str().ok_or("Missing Yomitan field table")?;
            app.clipboard()
                .write_text(text)
                .map_err(|e| e.to_string())?;
            return Ok(Value::Null);
        }
        "recommendedAnki.close" => {
            let _idle = data
                .active
                .try_lock()
                .map_err(|_| "Anki setup is still running")?;
            session.resolve(Value::Null);
            return Ok(Value::Null);
        }
        _ => {}
    }
    let mut pending = data
        .active
        .try_lock()
        .map_err(|_| "Anki setup is still running")?;
    if command == "recommendedAnki.reset" {
        *pending = None;
        return Ok(Value::Null);
    }
    if command == "recommendedAnki.guide" {
        let preset = preset(value.as_str().unwrap_or(""))?;
        open::that_detached(&preset.documentation).map_err(|e| e.to_string())?;
        return Ok(Value::Null);
    }
    let context = Context::read(&gsm_settings::read_object(&data.path)?)?;
    let url = Url::parse(&context.server)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https") && url.has_host())
        .ok_or("Enter an HTTP or HTTPS AnkiConnect URL.")?;
    let desktop = app.state::<DesktopState>();
    let anki = anki_connect::Collection {
        client: &desktop.http,
        url: &url,
    };
    if command == "recommendedAnki.check" {
        let decks = check(&anki).await?;
        if context != Context::read(&gsm_settings::read_object(&data.path)?)? {
            return Err(CONTEXT_CHANGED.into());
        }
        return Ok(json!(decks));
    }
    if command != "recommendedAnki.install" {
        return Err("Unknown Anki setup command".into());
    }
    let choice: Choice = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
    let preset = preset(&choice.preset)?;
    let deck = choice.deck.trim();
    if deck.is_empty() {
        return Err("Choose or enter a deck for new cards.".into());
    }
    check(&anki).await?;
    let models: Vec<String> = call(&anki, "modelNames", json!({})).await?;
    let Some(model) = models
        .iter()
        .find(|name| name.eq_ignore_ascii_case(&preset.name))
    else {
        if pending.as_deref() == Some(&preset.id) {
            return Err(format!(
                "Finish importing {} in Anki, then click Finish setup again.",
                preset.name
            ));
        }
        if !matches!(
            url.host(),
            Some(url::Host::Domain("localhost"))
                | Some(url::Host::Ipv4(std::net::Ipv4Addr::LOCALHOST))
                | Some(url::Host::Ipv6(std::net::Ipv6Addr::LOCALHOST))
        ) {
            return Err("Automatic import requires Anki on the same computer as GSM. Import the official package on your Anki computer, then retry.".into());
        }
        let dir = data
            .path
            .with_file_name("downloads")
            .join("anki-note-types");
        let path = download(preset, &dir).await?;
        if context != Context::read(&gsm_settings::read_object(&data.path)?)? {
            return Err(CONTEXT_CHANGED.into());
        }
        let _: Value = call(
            &anki,
            "guiImportFile",
            json!({"path":path.to_string_lossy().replace('\\', "/")}),
        )
        .await?;
        *pending = Some(preset.id.clone());
        return Ok(json!({"importPending":true}));
    };
    let fields: Vec<String> = call(&anki, "modelFieldNames", json!({"modelName":model})).await?;
    let glossary = if preset.id == "senren" {
        "glossary"
    } else {
        "Glossary"
    };
    let mut missing: Vec<&str> = preset
        .gsm_fields
        .iter()
        .map(|(_, field)| field.as_str())
        .chain([glossary])
        .filter(|field| !fields.iter().any(|name| name == field))
        .collect();
    missing.sort_unstable();
    if !missing.is_empty() {
        return Err(format!("{model} is missing required fields: {}. Check its official setup guide before retrying; GSM has left its templates unchanged.", missing.join(", ")));
    }
    if context != Context::read(&gsm_settings::read_object(&data.path)?)? {
        return Err(CONTEXT_CHANGED.into());
    }
    let decks: Vec<String> = call(&anki, "deckNames", json!({})).await?;
    if !decks.iter().any(|name| name == deck) {
        let _: Value = call(&anki, "createDeck", json!({"deck":deck})).await?;
        let decks: Vec<String> = call(&anki, "deckNames", json!({})).await?;
        if !decks.iter().any(|name| name == deck) {
            return Err(
                "Anki did not create the selected deck. Please create it in Anki and retry.".into(),
            );
        }
    }
    let tags = save_settings(&data.path, &context, preset, model, &fields)?;
    *pending = None;
    crate::mining_settings::changed(app).await;
    crate::desktop_state::emit_to_desktop_windows(app, "settings.mining.changed", &[]);
    let mappings = yomitan_fields(preset, &fields);
    let mut result = json!({"model":model,"yomitanFields":mappings});
    if choice.yomitan {
        crate::desktop_state::emit_to_window(app, label, "recommendedAnki.configuringYomitan", &[]);
        let deadline = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            + 24_000;
        let response = crate::reader_service::handle_ws2_anki_setup(app, &json!({
            "request_id":uuid::Uuid::new_v4().to_string(),"deadline":deadline,"data":{
                "preset":preset.id,"model":model,"deck":deck,"server":context.server,"tags":tags,
                "fields":mappings.into_iter().collect::<std::collections::BTreeMap<_, _>>()
            }
        })).await;
        if response["success"] == true && response["profileName"].is_string() {
            result["profile"] = response["profileName"].clone();
        } else {
            result["yomitanError"] = response["error"]
                .as_str()
                .unwrap_or("Yomitan did not confirm the configured profile.")
                .into();
        }
    }
    Ok(result)
}

fn preset(id: &str) -> Result<&'static Preset, String> {
    PRESETS
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "Choose Lapis, Kiku or Senren.".into())
}

async fn call<T: serde::de::DeserializeOwned + Send + 'static>(
    anki: &anki_connect::Collection<'_>,
    action: &str,
    params: Value,
) -> Result<T, String> {
    let body = json!({"action":action,"version":6,"params":params});
    anki_connect::attempt(anki.client, anki.url, &body, |raw| {
        serde_json::from_str(raw.get()).map_err(|e| e.to_string())
    })
    .await?
    .ok_or_else(|| anki_connect::BUSY.into())
}

async fn check(anki: &anki_connect::Collection<'_>) -> Result<Vec<String>, String> {
    let version: u32 = call(anki, "version", json!({})).await?;
    if version < 6 {
        return Err("Update AnkiConnect to a version supporting API 6.".into());
    }
    call(anki, "deckNames", json!({})).await
}

fn yomitan_fields(preset: &Preset, fields: &[String]) -> Fields {
    let has = |field: &str| fields.iter().any(|name| name == field);
    fields
        .iter()
        .map(|name| {
            let key = if preset.id == "senren" {
                match name.as_str() {
                    "sentenceEng" => "sentenceTranslation",
                    "pitchPosition" => "pitchPositions",
                    "pitch" => "pitchCategories",
                    "frequency" => "frequencies",
                    "reading" if has("pitch") && !has("pitchAccents") => "pitchAccents",
                    _ => name,
                }
            } else {
                name
            };
            let value = preset
                .yomitan_fields
                .iter()
                .find(|(field, _)| field == key)
                .map(|(_, value)| value.clone())
                .unwrap_or_default();
            (name.clone(), value)
        })
        .collect()
}

fn apply_fields(profile: &mut Value, preset: &Preset, model: &str, fields: &[String]) {
    let has = |field: &str| fields.iter().any(|name| name == field);
    let anki = &mut profile["anki"];
    anki["note_type"] = model.into();
    anki["enabled"] = true.into();
    anki["available_fields"] = json!(fields);
    for (key, field) in &preset.gsm_fields {
        let mapping = &mut anki[key];
        mapping["name"] = field.as_str().into();
        if key != "word" {
            if !matches!(key.as_str(), "sentence_audio" | "picture") {
                mapping["enabled"] = true.into();
            }
            mapping["append"] = false.into();
            mapping["overwrite"] = true.into();
        }
    }
    for key in ["previous_sentence", "previous_image", "video"] {
        if !anki[key]["name"].as_str().is_some_and(has) {
            anki[key]["name"] = "".into();
            anki[key]["enabled"] = false.into();
        }
    }
    let translation = match preset.id.as_str() {
        "senren" if !has("sentenceTranslation") => "sentenceEng",
        "senren" => "sentenceTranslation",
        _ => "SentenceTranslation",
    };
    if preset.id != "kiku" {
        anki["field_grouping_enabled"] = false.into();
    }
    let game_field = if preset.id == "senren" {
        "miscInfo"
    } else {
        "MiscInfo"
    };
    anki["field_grouping_additional_fields"] = json!([translation, game_field]
        .into_iter()
        .filter(|field| has(field))
        .collect::<Vec<_>>());
    let ai = &mut profile["ai"];
    if has(translation) {
        ai["anki_field"] = translation.into();
    } else if !ai["anki_field"].as_str().is_some_and(has) {
        ai["anki_field"] = "".into();
        ai["add_to_anki"] = false.into();
    }
}

fn save_settings(
    path: &Path,
    context: &Context,
    preset: &Preset,
    model: &str,
    fields: &[String],
) -> Result<Value, String> {
    gsm_settings::mining_scopes::update(path, |doc| {
        if Context::read(doc)? != *context {
            return Err(CONTEXT_CHANGED.into());
        }
        let backup = path.with_file_name("backup").join("config").join(format!(
            "config_backup_{}.json",
            chrono::Local::now().format("%Y-%m-%d_%H-%M-%S-%3f")
        ));
        gsm_settings::write_atomic(&backup, doc)?;
        let profile = &mut doc["configs"][&context.profile];
        apply_fields(profile, preset, model, fields);
        Ok(profile["anki"]["tags_to_check"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into())
    })
}

async fn download(preset: &Preset, directory: &Path) -> Result<PathBuf, String> {
    let client = Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(20))
        .user_agent("GameSentenceMiner-AnkiSetup")
        .build()
        .map_err(|e| e.to_string())?;
    let network_error = |e: reqwest::Error| {
        format!(
            "Could not download the official Anki package. {}",
            e.without_url()
        )
    };
    let release: Value = client
        .get(format!(
            "https://api.github.com/repos/{}/releases/latest",
            preset.repository
        ))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(network_error)?
        .json()
        .await
        .map_err(network_error)?;
    let mut assets = release["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|asset| {
            asset["name"].as_str().is_some_and(|name| {
                let name = name.to_ascii_lowercase();
                name.starts_with(&preset.id) && name.ends_with(".apkg")
            })
        });
    let asset_error = "The official release has no unambiguous Anki package. Open its setup guide.";
    let asset = assets.next().ok_or(asset_error)?;
    if assets.next().is_some() {
        return Err(asset_error.into());
    }
    let url = asset["browser_download_url"]
        .as_str()
        .and_then(|s| Url::parse(s).ok())
        .filter(|url| {
            url.scheme() == "https"
                && url.host_str() == Some("github.com")
                && url.port().is_none()
                && url.username().is_empty()
                && url.password().is_none()
                && url
                    .path()
                    .starts_with(&format!("/{}/releases/download/", preset.repository))
        })
        .ok_or("The release package URL is not from the official repository.")?;
    let size = asset["size"]
        .as_u64()
        .filter(|n| (1..=MAX_PACKAGE_BYTES).contains(n))
        .ok_or("The release package is empty or exceeds the 64 MB download limit.")?;
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(network_error)?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut received = 0;
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        received += chunk.len() as u64;
        if received > size {
            return Err("The downloaded package exceeds its expected size.".into());
        }
        digest.update(&chunk);
        temporary.write_all(&chunk).map_err(|e| e.to_string())?;
    }
    if received != size {
        return Err("The download was incomplete. Retry the installation.".into());
    }
    let digest = format!("{:x}", digest.finalize());
    if asset["digest"]
        .as_str()
        .is_some_and(|value| !value.is_empty() && value != format!("sha256:{digest}"))
    {
        return Err("The download checksum does not match the official release.".into());
    }
    let destination = directory.join(format!("{}-{}.apkg", preset.name, &digest[..16]));
    tokio::task::spawn_blocking(move || {
        let file = temporary.reopen().map_err(|e| e.to_string())?;
        let archive =
            zip::ZipArchive::new(file).map_err(|_| "The download is not an Anki package.")?;
        if archive.index_for_name("media").is_none()
            || ![
                "collection.anki2",
                "collection.anki21",
                "collection.anki21b",
            ]
            .into_iter()
            .any(|name| archive.index_for_name(name).is_some())
        {
            return Err("The download does not contain an Anki collection.".into());
        }
        drop(archive);
        temporary.persist(&destination).map_err(|e| e.to_string())?;
        Ok(destination)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn senren_v4_reuses_legacy_fields_and_preserves_capture_preferences() {
        let preset = preset("senren").unwrap();
        let mut fields = preset
            .gsm_fields
            .iter()
            .map(|(_, name)| name.clone())
            .collect::<Vec<_>>();
        fields.extend(["sentenceEng", "pitch", "reading"].map(str::to_owned));
        let mut profile = json!({"anki":{"picture":{"enabled":false},"sentence_audio":{"enabled":true},
            "video":{"name":"Video","enabled":true},"field_grouping_enabled":true},"ai":{"add_to_anki":true}});
        apply_fields(&mut profile, preset, "Senren", &fields);
        assert_eq!(
            profile["anki"]["picture"],
            json!({"name":"picture","enabled":false,"append":false,"overwrite":true})
        );
        assert_eq!(profile["anki"]["sentence_audio"]["enabled"], true);
        assert_eq!(profile["anki"]["field_grouping_enabled"], false);
        assert_eq!(profile["anki"]["video"]["enabled"], false);
        assert_eq!(
            profile["ai"],
            json!({"anki_field":"sentenceEng","add_to_anki":true})
        );
        assert!(
            yomitan_fields(preset, &fields).contains(&("reading".into(), "{pitch-accents}".into()))
        );
    }
}
