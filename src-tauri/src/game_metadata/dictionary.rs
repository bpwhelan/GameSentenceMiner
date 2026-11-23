use gsm_history::History;
use std::sync::{Arc, LazyLock};
use tauri::{AppHandle, Manager};
use tokio::sync::Semaphore;

static ENABLED: LazyLock<bool> = LazyLock::new(|| {
    std::env::var("GSM_ENABLE_SUDACHI_USER_DICT").is_ok_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
});
static WRITER: Semaphore = Semaphore::const_new(1);

pub(crate) enum Selection<'a> {
    Game(&'a str, u64),
    Scene(&'a str),
}

pub(crate) fn queue(app: &AppHandle, selection: Selection<'_>) {
    if !*ENABLED {
        return;
    }
    let history = app.state::<Arc<History>>().inner().clone();
    let (name, scene, generation) = match selection {
        Selection::Game(id, generation) => (id, false, generation),
        Selection::Scene(scene) => {
            let Ok(generation) = history.generation() else {
                return;
            };
            (scene, true, generation)
        }
    };
    if name.is_empty() {
        return;
    }
    let name = name.to_owned();
    let path = app
        .state::<crate::settings::Settings>()
        .paths
        .active
        .join("gsm.db");
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(_permit) = WRITER.acquire().await else {
            return;
        };
        let result = tokio::task::spawn_blocking(move || -> gsm_history::Result<()> {
            if history.generation()? != generation {
                return Ok(());
            }
            let id = if scene {
                let Some(id) = history.dictionary_game_for_scene(&path, &name)? else {
                    return Ok(());
                };
                id
            } else {
                name
            };
            history.export_sudachi_names(&path, &id, generation)?;
            Ok(())
        })
        .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => crate::desktop_log::warn(&app, "sudachi", e.to_string()),
            Err(e) => crate::desktop_log::warn(&app, "sudachi", e.to_string()),
        }
    });
}
