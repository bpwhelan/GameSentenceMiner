use super::{pipeline, MiningService};
use crate::text_intake::Intake;
use gsm_mining::{
    ai::{is_successful_translation, normalize_translation_source, study_task_body},
    clips::{get_clips_root, saved_selections},
    config::{profile_language_name, ProfileConfig, AI_DEEPL},
    gateway::{AiAction, StatusCode},
    text::GameLine,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

type Reply = (StatusCode, Value);
const DOCS: &str = "https://docs.gamesentenceminer.com/docs/features/ai-features";

fn bad(error: &str) -> Reply {
    (StatusCode::BAD_REQUEST, json!({"error":error}))
}

async fn settings(app: &AppHandle, service: &MiningService) -> bool {
    let mut opened = service.ai_settings_opened.lock().await;
    if opened.is_some_and(|t| t.elapsed() < Duration::from_secs(5)) {
        return true;
    }
    let shown = crate::gui_dialog::open_settings(app, "ai".into(), "general".into())
        .await
        .is_ok();
    if shown {
        *opened = Some(Instant::now());
    }
    shown
}

pub(super) async fn setup_required(
    app: &AppHandle,
    service: &MiningService,
    automatic: bool,
) -> Value {
    let opened = !automatic && settings(app, service).await;
    let instruction = if opened {
        "AI setup is open."
    } else {
        "Open Config → AI / Translation."
    };
    json!({"code":"ai_setup_required","settings_opened":opened,"href":DOCS,"error":format!("{instruction} Choose a provider, follow the account and API key steps, then test the connection and retry. You do not need to enable adding AI output to Anki to translate or explain sentences.")})
}

fn provider_error(reason: &str) -> Reply {
    (
        StatusCode::BAD_GATEWAY,
        json!({"code":"ai_request_failed","error":provider_error_message(reason)}),
    )
}

pub(super) fn provider_error_message(reason: &str) -> &'static str {
    let detail = reason.to_lowercase();
    let has = |tokens: &[&str]| tokens.iter().any(|s| detail.contains(s));
    if has(&[
        "401",
        "403",
        "api key",
        "api_key",
        "unauthorized",
        "permission_denied",
    ]) {
        "The provider rejected access. Create or check your API key and model access in AI / Translation settings."
    } else if has(&["429", "quota", "rate limit", "resource_exhausted"]) {
        "The provider's rate limit or quota was reached. Wait and retry, or check your account's usage and limits."
    } else if has(&["404", "not found", "not_found"]) {
        "The selected model is unavailable. Choose a supported model in AI / Translation settings."
    } else if detail.contains("deepl supports translation only") {
        "DeepL supports translation only. Choose Gemini, Groq, or another AI provider for explanations."
    } else if detail.contains("cut off") {
        "The answer was cut off. Increase Max Output Tokens in AI / Translation settings."
    } else {
        "The AI request failed. Check your connection, API key, model, and account limits in AI / Translation settings."
    }
}

struct Dialogue {
    target: GameLine,
    lines: Vec<GameLine>,
    scene: String,
    sentence: String,
}

fn resolve(
    app: &AppHandle,
    config: &ProfileConfig,
    action: AiAction,
    input: &Value,
) -> Result<Dialogue, Reply> {
    let ids: Vec<_> = if action == AiAction::Multiple {
        input["ids"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect()
    } else {
        input["id"].as_str().into_iter().collect()
    };
    let intake = app.state::<Intake>();
    let live = intake.reader_targets(app, &ids);
    let missing: HashSet<_> = ids
        .iter()
        .copied()
        .filter(|id| !live.contains_key(*id))
        .collect();
    let saved = if missing.is_empty() {
        Default::default()
    } else {
        get_clips_root(config)
            .map(|p| saved_selections(&p, missing))
            .unwrap_or_default()
    };
    let mut selected = ids.iter().filter_map(|id| {
        live.get(*id).map(|line| (line, None)).or_else(|| {
            let clip = saved.get(*id)?;
            let line = clip.selected.iter().find(|l| l.id == *id)?;
            Some((line, Some(clip)))
        })
    });
    let (target, clip) = selected.next().ok_or_else(|| {
        bad(if action == AiAction::Multiple {
            "No matching lines found"
        } else {
            "Invalid id"
        })
    })?;
    let mut sentence = target.text.clone();
    if action == AiAction::Multiple {
        for (line, _) in selected {
            sentence.push('\n');
            sentence.push_str(&line.text);
        }
    } else if let Some(text) = input["text"].as_str().filter(|s| !s.is_empty()) {
        if action == AiAction::Analyze {
            sentence = text.to_owned();
        } else if !text.trim().is_empty() {
            sentence = text.trim().to_owned();
        }
    }
    if action == AiAction::Analyze
        && (sentence.trim().is_empty()
            || input
                .get("text")
                .is_some_and(|v| !v.is_null() && !v.is_string()))
    {
        return Err(bad("No sentence available to explain."));
    }
    let (mut scene, mut lines) = intake.dialogue_context(
        &target.id,
        if clip.is_some() {
            0
        } else {
            config.ai.dialogue_context_length
        },
    );
    if let Some(clip) = clip {
        if !target.scene.is_empty() {
            scene.clone_from(&target.scene);
        }
        lines.clone_from(&clip.lines);
    }
    if action == AiAction::Multiple && config.ai.custom_full_prompt.trim().is_empty() {
        // Keep the first selected line as the window anchor. The prompt builder
        // omits it from context, while the target contains every selected line.
        lines.retain(|line| line.id == target.id || !ids.contains(&line.id.as_str()));
    }
    Ok(Dialogue {
        target: target.clone(),
        lines,
        scene,
        sentence,
    })
}

pub(crate) async fn request(app: &AppHandle, action: AiAction, input: Value) -> Reply {
    let service = app.state::<Arc<MiningService>>().inner().clone();
    if action == AiAction::Settings {
        return (
            StatusCode::OK,
            json!({"settings_opened":settings(app,&service).await,"href":DOCS}),
        );
    }
    if action == AiAction::CharacterSummary {
        return character_summary(app, &service, &input).await;
    }
    let mode = input.get("mode").map_or(Some("sentence"), Value::as_str);
    let question = input.get("question").map_or(Some(""), Value::as_str);
    match action {
        AiAction::Analyze => {
            if input["id"].is_null()
                || !mode.is_some_and(|m| m == "custom" || study_task_body(m).is_some())
            {
                return bad("Choose a sentence and a valid analysis mode.");
            }
            if !question.is_some_and(|q| {
                q.chars().take(4001).count() <= 4000
                    && (mode != Some("custom") || !q.trim().is_empty())
            }) {
                return bad("Enter a question of 1–4000 characters.");
            }
        }
        AiAction::Multiple if !input["ids"].as_array().is_some_and(|a| !a.is_empty()) => {
            return bad("Missing ids")
        }
        AiAction::Translate if input["id"].is_null() => return bad("Missing id"),
        _ => {}
    }
    let mode = mode.unwrap_or("sentence").to_owned();
    let question = question.unwrap_or("").to_owned();
    let automatic = input["automatic"] == true;
    let force = input["force_refresh"] == true;
    let desktop = app.clone();
    let source = service.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        let config = source.load_config().map_err(|_| provider_error(""))?;
        let dialogue = if config.ai.is_configured() {
            Some(resolve(&desktop, &config, action, &input)?)
        } else {
            None
        };
        Ok::<_, Reply>((config, dialogue))
    })
    .await;
    let (config, dialogue) = match prepared {
        Ok(Ok(value)) => value,
        Ok(Err(reply)) => return reply,
        Err(_) => return provider_error(""),
    };
    let Some(dialogue) = dialogue else {
        return (
            StatusCode::BAD_REQUEST,
            setup_required(app, &service, automatic).await,
        );
    };
    let Dialogue {
        target,
        lines,
        scene,
        sentence,
    } = dialogue;
    if action == AiAction::Analyze {
        return match service
            .ai
            .analyze(
                &config,
                &lines,
                &sentence,
                Some(&target),
                &scene,
                &mode,
                &question,
            )
            .await
        {
            Ok(text) if !text.trim().is_empty() => {
                (StatusCode::OK, json!({"analysis":text,"mode":mode}))
            }
            Ok(_) => provider_error(""),
            Err(error) => provider_error(&error),
        };
    }
    let template = if action == AiAction::Multiple {
        include_str!("prompts/reader_multiple.md")
    } else {
        include_str!("prompts/reader_single.md")
    };
    let prompt = if action == AiAction::Translate && !config.ai.custom_texthooker_prompt.is_empty()
    {
        config.ai.custom_texthooker_prompt.trim().to_owned()
    } else {
        let language = if action == AiAction::Multiple && config.general.native_language.is_empty()
        {
            "English"
        } else {
            profile_language_name(&config.general.native_language)
        };
        template.trim().replace("{language}", language)
    };
    let characters = pipeline::fetch_character_context(app, &service, &config, &scene).await;
    let text = service
        .ai
        .translate(
            &config,
            &lines,
            &sentence,
            Some(&target),
            &scene,
            &characters,
            Some(&prompt),
            force,
            true,
        )
        .await;
    if text.is_empty() || text.starts_with("Processing failed:") {
        return provider_error(&text);
    }
    if target.clip_folder.is_none()
        && is_successful_translation(&text)
        && (sentence == target.text
            || normalize_translation_source(&sentence)
                == normalize_translation_source(&target.text))
    {
        app.state::<Intake>().translated(&target, &text);
    }
    (
        StatusCode::OK,
        if action == AiAction::Multiple {
            Value::String(text)
        } else {
            json!({"TL":text})
        },
    )
}

async fn character_summary(app: &AppHandle, service: &Arc<MiningService>, input: &Value) -> Reply {
    let Some(id) = input["game_id"]
        .as_str()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    else {
        return bad("Choose a game to summarize.");
    };
    let history = app.state::<Arc<gsm_history::History>>().inner().clone();
    let database = app
        .state::<crate::settings::Settings>()
        .paths
        .active
        .join("gsm.db");
    let game_id = id.to_owned();
    let settings = Arc::clone(service);
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        let data = history.character_data_for_game(&database, &game_id)
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, json!({"error":"Could not read this game's character metadata."})))?
            .ok_or_else(|| (StatusCode::NOT_FOUND, json!({"error":"Game not found."})))?;
        let data: Value = serde_json::from_str(&data)
            .map_err(|_| bad("No character metadata is available. Link a game with character data and refresh its metadata."))?;
        let config = settings.load_config().map_err(|_| provider_error(""))?;
        Ok::<_, Reply>((data, config))
    }).await;
    let (data, config) = match prepared {
        Ok(Ok(value)) => value,
        Ok(Err(reply)) => return reply,
        Err(_) => return provider_error(""),
    };
    if !config.ai.is_configured() {
        return bad(
            "Configure an AI provider under Mining Settings → AI and Translation, then retry.",
        );
    }
    if config.ai.provider == AI_DEEPL {
        return bad(
            "DeepL only translates text. Choose a generative AI provider to create a summary.",
        );
    }
    match service.ai.generate_character_summary(&config.ai, &data).await {
        Ok(Some(summary)) => (StatusCode::OK, json!({"summary":summary})),
        Ok(None) => bad("No character metadata is available. Link a game with character data and refresh its metadata."),
        Err(error) => {
            crate::desktop_log::warn(app, "mining", format!("Character summary generation failed for game {id}: {error}"));
            provider_error(&error)
        }
    }
}
