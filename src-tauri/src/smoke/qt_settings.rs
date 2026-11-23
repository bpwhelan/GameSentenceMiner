use super::*;
use crate::gui_dialog::{self, Dialog};

pub(super) async fn run(app: &AppHandle, python: String, root: PathBuf) -> Result<Value, String> {
    let runtime = crate::runtime::get(app)?;
    let paths = &app.state::<crate::settings::Settings>().paths;
    let profile = &paths.active;
    let path = profile.join("config.json");
    let mut config = gsm_settings::read_object(&path)?;
    let selected = config["current_profile"]
        .as_str()
        .ok_or("No test profile")?
        .to_owned();
    config["smoke_marker"] = json!(42);
    config["configs"][&selected]["general"]["open_config_on_startup"] = json!(false);
    config["configs"][&selected]["anki"]["enabled"] = json!(false);
    config["configs"][&selected]["obs"] =
        json!({"disable_recording":true,"open_obs":false,"close_obs":false,"port":1});
    gsm_settings::write_atomic(&path, &config)?;
    gsm_settings::profile_config::prepare(
        paths,
        &app.state::<DesktopState>().app_root,
        &app.package_info().version.to_string(),
    )?;
    let started = Instant::now();
    gui_dialog::open_settings_with(
        app,
        "general".into(),
        String::new(),
        std::future::ready(Ok((python.clone(), root.clone()))),
    )
    .await?;
    let open_ms = started.elapsed().as_secs_f64() * 1000.0;
    let state = || runtime.call("process.state", json!({"id":"qt-settings"}));
    let pid = state().await?["pid"]
        .as_u64()
        .ok_or("Settings window closed during launch")?;
    let started = Instant::now();
    gui_dialog::open_settings_with(app, "audio".into(), String::new(), std::future::ready(Ok((python.clone(),root.clone())))).await?;
    let focus_ms = started.elapsed().as_secs_f64() * 1000.0;
    if state().await?["pid"] != pid {
        return Err("Focusing settings launched another worker".into());
    }
    let result = gui_dialog::run_worker(
        app,
        Dialog::TextInput {
            title: "Fixture".into(),
            label: "Fixture".into(),
        },
        &python,
        &root,
    )
    .await?;
    if result != "日本語" || state().await?["pid"] != pid {
        return Err("Opening a modal dialog interrupted settings".into());
    }
    let close = || async {
        tokio::fs::write(profile.join("close-settings"), [])
            .await
            .map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let process = state().await?;
                if !process["pid"].is_u64() {
                    return Ok::<_, String>(());
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .map_err(|_| "Settings worker did not exit")??;
        tokio::fs::remove_file(profile.join("close-settings"))
            .await
            .map_err(|e| e.to_string())
    };
    close().await?;
    let config = gsm_settings::read_object(&profile.join("config.json"))?;
    if config["configs"][&selected]["general"]["open_config_on_startup"] != true
        || config["smoke_marker"] != 42
    {
        return Err("Qt settings edit or unknown field missing from saved profile".into());
    }
    let started = Instant::now();
    gui_dialog::open_settings_with(
        app,
        "hotkeys".into(),
        String::new(),
        std::future::ready(Ok((python, root))),
    )
    .await?;
    let reopen_ms = started.elapsed().as_secs_f64() * 1000.0;
    if !state().await?["pid"].is_u64() {
        return Err("Settings did not reopen".into());
    }
    close().await?;
    Ok(json!({"open_ms":open_ms,"focus_ms":focus_ms,"reopen_ms":reopen_ms}))
}
