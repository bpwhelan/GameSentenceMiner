use serde_json::{json, Value};
use std::path::Path;

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
pub(crate) fn icon_from_bytes(bytes: &[u8]) -> Result<tauri::image::Image<'static>, String> {
    tauri::image::Image::from_bytes(bytes)
        .map(|image| image.to_owned())
        .map_err(err)
}
pub(crate) fn icon_from_path(path: &Path) -> Result<tauri::image::Image<'static>, String> {
    let bytes = std::fs::read(path).map_err(err)?;
    icon_from_bytes(&bytes)
}
pub(crate) fn tray_icon_from_bytes(bytes: &[u8]) -> Result<tauri::image::Image<'static>, String> {
    #[cfg(windows)]
    {
        crate::windows_tray::icon(bytes)
    }
    #[cfg(not(windows))]
    {
        icon_from_bytes(bytes)
    }
}
pub(crate) fn tray_icon_from_path(path: &Path) -> Result<tauri::image::Image<'static>, String> {
    let bytes = std::fs::read(path).map_err(err)?;
    tray_icon_from_bytes(&bytes)
}

pub(crate) fn shell_open_external(raw_url: &str) -> Result<(), String> {
    let url = url::Url::parse(raw_url).map_err(err)?;
    if !matches!(
        url.scheme(),
        "http" | "https" | "mailto" | "steam" | "obsidian"
    ) {
        return Err("Unsupported external URL scheme".into());
    }
    open::that(url.as_str()).map_err(err)
}

pub(crate) fn shell_open_path(path: &Path) -> Result<(), String> {
    open::that(path).map_err(err)
}

pub(crate) fn shell_reveal(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", path.display()))
            .creation_flags(0x08000000)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(target_os = "linux")]
    {
        open::that(path.parent().ok_or("Missing parent directory")?).map_err(err)?;
    }
    Ok(())
}

pub(crate) async fn dialog_message(params: &Value) -> Result<usize, String> {
    let buttons = params["buttons"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![json!("OK")]);
    let label = |index: usize| {
        buttons
            .get(index)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let kind = match buttons.len() {
        0 | 1 => rfd::MessageButtons::OkCustom(label(0)),
        2 => rfd::MessageButtons::OkCancelCustom(label(0), label(1)),
        _ => rfd::MessageButtons::YesNoCancelCustom(label(0), label(1), label(2)),
    };
    let message = format!(
        "{}{}{}",
        text(params, "message"),
        if params["detail"].is_string() {
            "\n\n"
        } else {
            ""
        },
        text(params, "detail")
    );
    let result = rfd::AsyncMessageDialog::new()
        .set_title(text(params, "title"))
        .set_description(message)
        .set_buttons(kind)
        .set_level(match text(params, "type") {
            "error" => rfd::MessageLevel::Error,
            "warning" => rfd::MessageLevel::Warning,
            _ => rfd::MessageLevel::Info,
        })
        .show()
        .await;
    let index = match result {
        rfd::MessageDialogResult::Custom(value) => buttons
            .iter()
            .position(|label| label.as_str() == Some(&value))
            .unwrap_or(0),
        rfd::MessageDialogResult::Cancel => params["cancelId"]
            .as_u64()
            .unwrap_or(buttons.len().saturating_sub(1) as u64)
            as usize,
        rfd::MessageDialogResult::No => 1,
        _ => 0,
    };
    Ok(index)
}

fn configure_file_dialog(mut dialog: rfd::AsyncFileDialog, params: &Value) -> rfd::AsyncFileDialog {
    if let Some(title) = params["title"].as_str() {
        dialog = dialog.set_title(title);
    }
    if let Some(default) = params["defaultPath"].as_str() {
        let path = Path::new(default);
        if path.is_dir() {
            dialog = dialog.set_directory(path);
        } else {
            if let Some(parent) = path.parent() {
                dialog = dialog.set_directory(parent);
            }
            if let Some(name) = path.file_name() {
                dialog = dialog.set_file_name(name.to_string_lossy());
            }
        }
    }
    for filter in params["filters"].as_array().into_iter().flatten() {
        let extensions: Vec<&str> = filter["extensions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|extension| *extension != "*")
            .collect();
        if !extensions.is_empty() {
            dialog = dialog.add_filter(text(filter, "name"), &extensions);
        }
    }
    dialog
}

pub(crate) async fn dialog_open(params: &Value) -> Result<Value, String> {
    let dialog = configure_file_dialog(rfd::AsyncFileDialog::new(), params);
    let props = params["properties"].as_array().cloned().unwrap_or_default();
    let files = if props.contains(&json!("openDirectory")) {
        dialog.pick_folder().await.map(|f| vec![f])
    } else if props.contains(&json!("multiSelections")) {
        dialog.pick_files().await
    } else {
        dialog.pick_file().await.map(|f| vec![f])
    };
    Ok(json!({
        "canceled": files.is_none(),
        "filePaths": files
            .unwrap_or_default()
            .iter()
            .map(|f| f.path().to_string_lossy().to_string())
            .collect::<Vec<_>>()
    }))
}

pub(crate) async fn dialog_save(params: &Value) -> Result<Value, String> {
    let dialog = configure_file_dialog(rfd::AsyncFileDialog::new(), params);
    let file = dialog.save_file().await;
    Ok(json!({
        "canceled": file.is_none(),
        "filePath": file.map(|f| f.path().to_string_lossy().to_string())
    }))
}
