//! Commit a prepared mining note in AnkiConnect order. Only a rejected
//! collection-busy action is resumable. A network failure can be ambiguous.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

#[derive(Copy, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Step {
    UpdateNoteFields,
    AddTags,
    RemoveTags,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edit {
    url: reqwest::Url,
    note: Value,
    tags: Vec<String>,
    remove_overlay: bool,
    step: Step,
    #[serde(default)]
    timed: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    #[serde(rename = "result")]
    _result: Value,
    error: Value,
}

#[derive(Serialize)]
struct Progress {
    busy: Option<Step>,
    error: Option<String>,
    attempts: Vec<Value>,
}

pub async fn commit(client: &reqwest::Client, edit: Edit) -> Result<Value, String> {
    Ok(json!(advance(client, &edit, edit.step).await?))
}

pub async fn commit_group(
    client: &reqwest::Client,
    url: reqwest::Url,
    note: Value,
    tags: Vec<String>,
    remove_overlay: bool,
) -> Result<(), String> {
    let edit = Edit {
        url,
        note,
        tags,
        remove_overlay,
        step: Step::UpdateNoteFields,
        timed: false,
    };
    let mut step = edit.step;
    let mut delay = 1;
    loop {
        let progress = advance(client, &edit, step).await?;
        if let Some(error) = progress.error {
            return Err(error);
        }
        let Some(busy) = progress.busy else {
            return Ok(());
        };
        if step != busy {
            delay = 1;
        }
        step = busy;
        tokio::time::sleep(Duration::from_secs(delay)).await;
        delay = (delay * 2).min(5);
    }
}

async fn advance(
    client: &reqwest::Client,
    edit: &Edit,
    mut step: Step,
) -> Result<Progress, String> {
    if !matches!(edit.url.scheme(), "http" | "https") {
        return Err("Invalid AnkiConnect URL".into());
    }
    let target = edit.note["id"].as_u64().ok_or("Invalid target note ID")?;
    let mut attempts = Vec::new();
    loop {
        let params = match step {
            Step::UpdateNoteFields => json!({"note": edit.note}),
            Step::AddTags => json!({"notes":[target], "tags": edit.tags.join(" ")}),
            Step::RemoveTags => json!({"notes":[target], "tags":"overlay"}),
        };
        let started = Instant::now();
        let result = async {
            let reply: Reply = client
                .post(edit.url.clone())
                .json(&json!({"action":step,"params":params,"version":6}))
                .timeout(Duration::from_secs(10))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            Ok::<_, reqwest::Error>(reply)
        }
        .await;
        let (busy, error) = match result {
            Ok(Reply { error, .. }) if error == "A collection operation is active." => (true, None),
            Ok(Reply { error, .. }) if error.is_null() => (false, None),
            Ok(Reply { error, .. }) => (
                false,
                Some(
                    error
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| error.to_string()),
                ),
            ),
            Err(e) => (false, Some(e.without_url().to_string())),
        };
        if edit.timed {
            attempts
                .push(json!({"action":step,"elapsed_ms":started.elapsed().as_secs_f64()*1000.0}));
        }
        if busy || error.is_some() {
            return Ok(Progress {
                busy: busy.then_some(step),
                error,
                attempts,
            });
        }
        step = match step {
            Step::UpdateNoteFields if !edit.tags.is_empty() => Step::AddTags,
            Step::UpdateNoteFields | Step::AddTags if edit.remove_overlay => Step::RemoveTags,
            _ => {
                return Ok(Progress {
                    busy: None,
                    error: None,
                    attempts,
                })
            }
        };
    }
}
