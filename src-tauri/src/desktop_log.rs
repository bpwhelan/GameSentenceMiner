//! Centralized origin-tagged desktop logging for Rust components, renderer diagnostics,
//! and Python backend terminal forwarding.
use chrono::Local;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::{IsTerminal, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const LOG_BACKUPS: usize = 5;
const RECENT_TERMINAL_LIMIT: usize = 300;
const MAX_LINE_CHARS: usize = 16_000;

struct DesktopLogState {
    log_file: Option<PathBuf>,
    recent: VecDeque<Value>,
    next_seq: u64,
}

impl Default for DesktopLogState {
    fn default() -> Self {
        Self {
            log_file: None,
            recent: VecDeque::with_capacity(RECENT_TERMINAL_LIMIT),
            next_seq: 1,
        }
    }
}

static STATE: OnceLock<Mutex<DesktopLogState>> = OnceLock::new();

fn state() -> &'static Mutex<DesktopLogState> {
    STATE.get_or_init(|| Mutex::new(DesktopLogState::default()))
}

/// Initialize persistent desktop logging under `<data_dir>/logs/desktop.log`.
pub fn init(logs_dir: PathBuf) {
    let _ = fs::create_dir_all(&logs_dir);
    let mut guard = state().lock().unwrap();
    guard.log_file = Some(logs_dir.join("desktop.log"));
}

/// Strip ANSI SGR escape sequences (e.g. `\x1b[32m`, `\x1b[38;5;208m`).
pub fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            while let Some(c) = chars.next() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn is_origin_namespace(ns: &str) -> bool {
    matches!(
        ns.to_ascii_lowercase().as_str(),
        "py" | "python" | "rust" | "electron" | "renderer" | "frida" | "system"
    )
}

fn split_origin_prefix(clean: &str) -> Option<(&str, &str)> {
    let trimmed = clean.trim_start();
    let rest = trimmed.strip_prefix('[')?;
    let end = rest.find(']')?;
    let tag = &rest[..end];
    if tag.is_empty() || tag.len() > 48 {
        return None;
    }
    let after = &rest[end + 1..];
    if !after.is_empty() && !after.starts_with(char::is_whitespace) {
        return None;
    }
    let (ns, sub) = match tag.split_once(':') {
        Some((ns, sub)) => (ns, Some(sub)),
        None => (tag, None),
    };
    if !is_origin_namespace(ns) {
        return None;
    }
    if let Some(sub) = sub {
        if sub.is_empty()
            || !sub
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-' | b':'))
        {
            return None;
        }
    }
    Some((tag, after.trim_start()))
}

/// Returns true when `line` (ignoring leading ANSI codes) already starts with a canonical
/// `[<runtime>:<component>]` origin tag.
pub fn has_origin_prefix(line: &str) -> bool {
    let clean = strip_ansi(line);
    split_origin_prefix(&clean).is_some()
}

/// Ensure `message` begins with `[<origin>] `, without double-prefixing if it already carries
/// a canonical origin tag.
pub fn ensure_origin(origin: &str, message: &str) -> String {
    if message.trim().is_empty() || has_origin_prefix(message) {
        return message.to_owned();
    }
    format!("[{origin}] {message}")
}

fn normalize_level(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_uppercase().as_str() {
        "CRITICAL" => Some("CRITICAL"),
        "ERROR" => Some("ERROR"),
        "WARNING" | "WARN" => Some("WARNING"),
        "SUCCESS" => Some("SUCCESS"),
        "TEXT_RECEIVED" => Some("TEXT_RECEIVED"),
        "DISPLAY" => Some("DISPLAY"),
        "INFO" => Some("INFO"),
        "BACKGROUND" => Some("BACKGROUND"),
        "DEBUG" => Some("DEBUG"),
        "TRACE" => Some("TRACE"),
        _ => None,
    }
}

fn rotate_log_file(file_path: &Path, backup_count: usize) {
    let Some(parent) = file_path.parent() else {
        return;
    };
    let Some(file_name) = file_path.file_name().and_then(|n| n.to_str()) else {
        return;
    };
    let history = parent.join("history");
    if fs::create_dir_all(&history).is_err() {
        return;
    }
    for index in (1..=backup_count).rev() {
        let source = if index == 1 {
            file_path.to_path_buf()
        } else {
            history.join(format!("{file_name}.{}", index - 1))
        };
        let dest = history.join(format!("{file_name}.{index}"));
        if source.exists() {
            let _ = fs::rename(&source, &dest);
        }
    }
}

fn append_file_line(log_file: &Path, line: &str) {
    if let Ok(meta) = fs::metadata(log_file) {
        if meta.len() >= MAX_LOG_BYTES {
            rotate_log_file(log_file, LOG_BACKUPS);
        }
    }
    if let Some(parent) = log_file.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_file) {
        let clean = strip_ansi(line);
        let _ = writeln!(file, "{clean}");
    }
}

fn truncate_message(message: &str) -> String {
    let trimmed = message.trim_end_matches(['\r', '\n']);
    if trimmed.chars().count() <= MAX_LINE_CHARS {
        trimmed.to_owned()
    } else {
        let mut out: String = trimmed.chars().take(MAX_LINE_CHARS).collect();
        out.push_str("...[truncated]");
        out
    }
}

/// Emit a structured Rust component log to stderr, `desktop.log`, the recent buffer,
/// and (when `app` is provided) desktop windows' Logs tab.
pub fn emit_rust(app: Option<&tauri::AppHandle>, component: &str, level: &str, message: &str) {
    let body = truncate_message(message);
    if body.trim().is_empty() {
        return;
    }
    let normalized = normalize_level(level).unwrap_or("INFO");
    let now = Local::now();
    let console_line = format!(
        "[rust:{component}] {} | {:<10} | {body}",
        now.format("%Y-%m-%d %H:%M:%S"),
        normalized
    );
    let file_line = format!(
        "[rust:{component}] {} | {:<8} | PID {} | {body}",
        now.format("%Y-%m-%d %H:%M:%S%.3f"),
        normalized,
        std::process::id()
    );

    if normalized == "TEXT_RECEIVED" && std::io::stderr().is_terminal() {
        eprintln!("\x1b[36m{console_line}\x1b[0m");
    } else {
        eprintln!("{console_line}");
    }

    let stream = if matches!(normalized, "ERROR" | "CRITICAL") {
        "stderr"
    } else {
        "stdout"
    };
    let channel = if matches!(normalized, "BACKGROUND" | "DEBUG" | "TRACE") {
        "background"
    } else {
        "basic"
    };
    let mut payload = json!({
        "message": console_line,
        "stream": stream,
        "level": normalized,
        "channel": channel,
        "source": format!("rust:{component}"),
    });

    {
        let mut guard = state().lock().unwrap();
        if let Some(log_file) = guard.log_file.clone() {
            append_file_line(&log_file, &file_line);
        }
        let seq = guard.next_seq;
        guard.next_seq = guard.next_seq.wrapping_add(1);
        payload["seq"] = json!(seq);
        if guard.recent.len() >= RECENT_TERMINAL_LIMIT {
            guard.recent.pop_front();
        }
        guard.recent.push_back(payload.clone());
    }

    if let Some(app) = app {
        let ipc_channel = if stream == "stderr" {
            "terminal-error"
        } else {
            "terminal-output"
        };
        crate::desktop_state::emit_to_desktop_windows(app, ipc_channel, &[payload]);
    }
}

pub fn info(app: &tauri::AppHandle, component: &str, message: impl AsRef<str>) {
    emit_rust(Some(app), component, "INFO", message.as_ref());
}

pub fn warn(app: &tauri::AppHandle, component: &str, message: impl AsRef<str>) {
    emit_rust(Some(app), component, "WARNING", message.as_ref());
}

pub fn error(app: &tauri::AppHandle, component: &str, message: impl AsRef<str>) {
    emit_rust(Some(app), component, "ERROR", message.as_ref());
}

pub fn background(app: &tauri::AppHandle, component: &str, message: impl AsRef<str>) {
    emit_rust(Some(app), component, "BACKGROUND", message.as_ref());
}

/// Log a Rust component diagnostic before an `AppHandle` is available (stderr + `desktop.log`).
pub fn stderr_only(component: &str, level: &str, message: impl AsRef<str>) {
    emit_rust(None, component, level, message.as_ref());
}

/// Record a renderer console/error message without echoing it back to the renderer.
pub fn renderer(window_label: &str, level: &str, message: impl AsRef<str>) {
    let body = truncate_message(message.as_ref());
    if body.trim().is_empty() {
        return;
    }
    let normalized = normalize_level(level).unwrap_or("INFO");
    let now = Local::now();
    let console_line = format!(
        "[renderer:{window_label}] {} | {:<10} | {body}",
        now.format("%Y-%m-%d %H:%M:%S"),
        normalized
    );
    let file_line = format!(
        "[renderer:{window_label}] {} | {:<8} | PID {} | {body}",
        now.format("%Y-%m-%d %H:%M:%S%.3f"),
        normalized,
        std::process::id()
    );
    eprintln!("{console_line}");
    let log_file = state().lock().unwrap().log_file.clone();
    if let Some(log_file) = log_file {
        append_file_line(&log_file, &file_line);
    }
}

/// Return buffered recent terminal log entries for newly mounted desktop windows.
pub fn recent_terminal_logs() -> Vec<Value> {
    state().lock().unwrap().recent.iter().cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_origin_prefixes_plain_lines_without_double_tagging() {
        assert_eq!(
            ensure_origin("py:backend", "2026-11-19 12:30:01 | MAIN | INFO | Ready"),
            "[py:backend] 2026-11-19 12:30:01 | MAIN | INFO | Ready"
        );
        assert_eq!(
            ensure_origin(
                "py:backend",
                "[py:backend] 2026-11-19 12:30:01 | MAIN | INFO | Ready"
            ),
            "[py:backend] 2026-11-19 12:30:01 | MAIN | INFO | Ready"
        );
        assert_eq!(
            ensure_origin("py:ocr", "\x1b[93m[py:ocr]\x1b[0m Recognized"),
            "\x1b[93m[py:ocr]\x1b[0m Recognized"
        );
        assert_eq!(
            ensure_origin("py:speech", "[final] こんにちは"),
            "[py:speech] [final] こんにちは"
        );
        assert_eq!(
            ensure_origin("rust:agent", "[Agent] Attach: hook"),
            "[rust:agent] [Agent] Attach: hook"
        );
    }

    #[test]
    fn writes_and_rotates_desktop_log_file_without_ansi() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("desktop.log");
        append_file_line(&file, "\x1b[38;5;208m[rust:startup]\x1b[0m Started");
        let contents = fs::read_to_string(&file).unwrap();
        assert!(contents.contains("[rust:startup] Started"));
        assert!(!contents.contains('\x1b'));
        rotate_log_file(&file, 2);
        assert!(dir.path().join("history/desktop.log.1").exists());
    }
}
