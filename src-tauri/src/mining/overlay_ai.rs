use super::{pipeline, reader_ai, MiningService};
use crate::text_intake::Intake;
use gsm_mining::{
    ai::{build_translation_prompt, study_task_body, OverlayBlocks},
    config::{profile_language_name, AI_DEEPL},
    text::remove_html_and_cloze_tags,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub(super) struct Queue {
    active: Option<Kind>,
    waiting: Option<Value>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Blocks,
    Flat,
}

enum Admission {
    Start(Value),
    Queued,
    Busy(Value),
}

impl Queue {
    fn submit(&mut self, request: Value) -> Admission {
        let kind = if request.get("blocks").is_some() {
            Kind::Blocks
        } else {
            Kind::Flat
        };
        match self.active {
            None => {
                self.active = Some(kind);
                Admission::Start(request)
            }
            Some(Kind::Blocks) if kind == Kind::Blocks => {
                self.waiting = Some(request);
                Admission::Queued
            }
            Some(_) => Admission::Busy(error(&request, "Translation already in progress")),
        }
    }

    fn finish(&mut self) -> Option<Value> {
        let next = self.waiting.take();
        self.active = next.as_ref().map(|_| Kind::Blocks);
        next
    }
}

fn error(request: &Value, message: &str) -> Value {
    let mut payload = json!({"type":"translation-error","error":message});
    if !request["request_id"].is_null() {
        payload["request_id"] = request["request_id"].clone();
    }
    payload
}

pub(crate) fn submit(app: &AppHandle, request: Value) {
    let service = app.state::<Arc<MiningService>>().inner().clone();
    let admitted = service.overlay_translations.lock().unwrap().submit(request);
    match admitted {
        Admission::Queued => {}
        Admission::Busy(msg) => app.state::<Intake>().overlay_event(msg),
        Admission::Start(mut current) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let reply = perform(&app, &service, &current)
                        .await
                        .unwrap_or_else(|e| error(&current, &e));
                    app.state::<Intake>().overlay_event(reply);
                    let Some(next) = service.overlay_translations.lock().unwrap().finish() else {
                        break;
                    };
                    current = next;
                }
            });
        }
    }
}

async fn perform(
    app: &AppHandle,
    service: &Arc<MiningService>,
    request: &Value,
) -> Result<Value, String> {
    let source = service.clone();
    let config = tauri::async_runtime::spawn_blocking(move || source.load_config())
        .await
        .map_err(|_| reader_ai::provider_error_message(""))?
        .map_err(|_| reader_ai::provider_error_message(""))?;
    let id = &request["request_id"];
    if !config.ai.is_configured() {
        let mut payload =
            reader_ai::setup_required(app, service, request["automatic"] == true).await;
        payload["type"] = "translation-error".into();
        payload["request_id"] = id.clone();
        return Ok(payload);
    }
    let mode = request
        .get("mode")
        .map_or(Some("translation"), Value::as_str);
    let Some(mode) =
        mode.filter(|m| *m == "translation" || *m == "custom" || study_task_body(m).is_some())
    else {
        return Err("Choose a valid sentence analysis mode.".into());
    };
    let study = mode != "translation";
    let question = request.get("question").map_or(Some(""), Value::as_str);
    if study
        && !question.is_some_and(|q| {
            q.chars().take(4001).count() <= 4000 && (mode != "custom" || !q.trim().is_empty())
        })
    {
        return Err("Enter a question of 1–4000 characters.".into());
    }
    let blocks = if study || request.get("blocks").is_some() {
        Some(
            OverlayBlocks::parse(&request["blocks"])
                .map_err(|e| format!("Translation failed: {e}"))?,
        )
    } else {
        None
    };
    let flat = !study && (blocks.is_none() || config.ai.provider == AI_DEEPL);
    let intake = app.state::<Intake>();
    let (scene, lines, last) = intake.overlay_dialogue(config.ai.dialogue_context_length, flat);
    let scene = if scene.is_empty() {
        "Unknown Game"
    } else {
        &scene
    };
    let data = if let Some(blocks) = blocks.as_ref().filter(|_| !flat) {
        if study {
            let text = service
                .ai
                .analyze(
                    &config,
                    &lines,
                    &blocks.text(),
                    None,
                    scene,
                    mode,
                    question.unwrap_or(""),
                )
                .await
                .map_err(|e| reader_ai::provider_error_message(&e))?;
            if text.trim().is_empty() {
                return Err(reader_ai::provider_error_message("").into());
            }
            json!({"request_id":id,"text":text,"mode":mode})
        } else {
            let translated = service
                .ai
                .translate_overlay_blocks(&config, &lines, blocks, scene)
                .await
                .map_err(|e| {
                    format!(
                        "Translation failed: {}",
                        reader_ai::provider_error_message(&e)
                    )
                })?;
            json!({"request_id":id,"blocks":translated})
        }
    } else {
        let sentence = blocks
            .map(|b| b.text())
            .or_else(|| {
                request["text"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_owned)
            })
            .or_else(|| intake.last_overlay_text())
            .filter(|s| !s.trim().is_empty())
            .ok_or("No OCR text available to translate")?;
        let characters = pipeline::fetch_character_context(app, service, &config, scene).await;
        let prompt =
            build_translation_prompt(profile_language_name(&config.general.native_language));
        let translated = service
            .ai
            .translate(
                &config,
                &lines,
                &sentence,
                last.as_ref(),
                scene,
                &characters,
                Some(&prompt),
                false,
                true,
            )
            .await;
        if translated.is_empty() || translated.starts_with("Processing failed:") {
            return Err(reader_ai::provider_error_message(&translated).into());
        }
        let text = remove_html_and_cloze_tags(&translated);
        if text.trim().is_empty() {
            return Err("Translation returned empty result".into());
        }
        if id.is_null() || id.as_str() == Some("") || id == false || id.as_i64() == Some(0) {
            json!(text)
        } else {
            json!({"request_id":id,"text":text})
        }
    };
    Ok(json!({"type":"translation-result","data":data}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overload_keeps_one_waiting_frame_and_returns_flat_requests_immediately() {
        let mut queue = Queue::default();
        let blocks = |id| json!({"request_id":id,"blocks":[]});
        assert!(matches!(queue.submit(blocks(1)), Admission::Start(_)));
        assert!(matches!(queue.submit(blocks(2)), Admission::Queued));
        assert!(matches!(queue.submit(blocks(3)), Admission::Queued));
        let Admission::Busy(reply) = queue.submit(json!({"request_id":"flat"})) else {
            panic!("expected busy");
        };
        assert_eq!(reply["request_id"], "flat");
        assert_eq!(queue.finish(), Some(blocks(3)));
        assert!(queue.finish().is_none());
        assert!(matches!(
            queue.submit(json!({"text":"line"})),
            Admission::Start(_)
        ));
        assert!(matches!(queue.submit(blocks(4)), Admission::Busy(_)));
        assert!(queue.finish().is_none());
        assert!(matches!(queue.submit(blocks(5)), Admission::Start(_)));
    }
}
