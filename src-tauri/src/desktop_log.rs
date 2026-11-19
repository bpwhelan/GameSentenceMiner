//! Centralized origin-tagged desktop logging for Rust components, renderer diagnostics,
//! and Python backend terminal forwarding.
use chrono::Local;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::Write,
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

fn starts_with_timestamp(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() >= 19
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(u8::is_ascii_digit)
        && bytes[10] == b' '
        && bytes[11..13].iter().all(u8::is_ascii_digit)
        && bytes[13] == b':'
        && bytes[14..16].iter().all(u8::is_ascii_digit)
        && bytes[16] == b':'
        && bytes[17..19].iter().all(u8::is_ascii_digit)
}

fn contains_word(haystack_upper: &str, needle: &str) -> bool {
    let mut start = 0;
    while let Some(pos) = haystack_upper[start..].find(needle) {
        let abs = start + pos;
        let before_ok = abs == 0
            || !haystack_upper.as_bytes()[abs - 1].is_ascii_alphanumeric()
                && haystack_upper.as_bytes()[abs - 1] != b'_';
        let after = abs + needle.len();
        let after_ok = after == haystack_upper.len()
            || !haystack_upper.as_bytes()[after].is_ascii_alphanumeric()
                && haystack_upper.as_bytes()[after] != b'_';
        if before_ok && after_ok {
            return true;
        }
        start = abs + 1;
    }
    false
}

/// Parse log level from structured Python/Rust log lines (with or without leading `[origin]` tag)
/// or unstructured fallback lines.
pub fn parse_log_level(line: &str) -> Option<&'static str> {
    let clean = strip_ansi(line);
    let body = match split_origin_prefix(&clean) {
        Some((_, rest)) => rest,
        None => clean.trim_start(),
    };

    if starts_with_timestamp(body) {
        let mut parts = body.split('|');
        let _ts = parts.next();
        if let Some(second) = parts.next() {
            if let Some(level) = normalize_level(second) {
                return Some(level);
            }
            if let Some(third) = parts.next() {
                if let Some(level) = normalize_level(third) {
                    return Some(level);
                }
            }
        }
    }

    let upper = body.to_ascii_uppercase();
    for lvl in ["CRITICAL", "ERROR", "WARNING", "WARN", "INFO", "DEBUG"] {
        if contains_word(&upper, lvl) {
            return normalize_level(lvl);
        }
    }
    None
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

fn record_terminal_payload(payload: &mut Value) -> u64 {
    let mut guard = state().lock().unwrap();
    let seq = guard.next_seq;
    guard.next_seq = guard.next_seq.wrapping_add(1);
    payload["seq"] = json!(seq);
    if guard.recent.len() >= RECENT_TERMINAL_LIMIT {
        guard.recent.pop_front();
    }
    guard.recent.push_back(payload.clone());
    seq
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

    eprintln!("{console_line}");

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

/// Forward a Python backend stdout/stderr line to desktop windows with `[py:backend]` origin tagging.
pub fn emit_python_backend_line(app: &tauri::AppHandle, stream: &str, raw_msg: &str) {
    let tagged = ensure_origin("py:backend", raw_msg);
    let channel_name = if stream == "stderr" {
        "terminal-error"
    } else {
        "terminal-output"
    };
    let level = parse_log_level(&tagged).or_else(|| (stream == "stderr").then_some("ERROR"));
    let channel = if matches!(level, Some("BACKGROUND" | "DEBUG" | "TRACE")) {
        "background"
    } else {
        "basic"
    };
    let mut payload = json!({
        "message": tagged,
        "stream": stream,
        "channel": channel,
        "source": "py:backend",
    });
    if let Some(lvl) = level {
        payload["level"] = json!(lvl);
    }
    record_terminal_payload(&mut payload);
    crate::desktop_state::emit_to_desktop_windows(app, channel_name, &[payload]);
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
    fn parse_log_level_handles_origin_prefixed_python_and_rust_lines() {
        assert_eq!(
            parse_log_level("[py:backend] 2026-11-19 12:30:01 | MAIN       | BACKGROUND | Boot"),
            Some("BACKGROUND")
        );
        assert_eq!(
            parse_log_level("[py:backend] 2026-11-19 12:30:01 | GAMETEXT   | TEXT_RECEIVED | Hi"),
            Some("TEXT_RECEIVED")
        );
        assert_eq!(
            parse_log_level("[rust:obs] 2026-11-19 12:30:01 | WARNING    | Scene missing"),
            Some("WARNING")
        );
        assert_eq!(
            parse_log_level("[rust:startup] 2026-11-19 12:30:01 | BACKGROUND | Update info"),
            Some("BACKGROUND")
        );
        assert_eq!(
            parse_log_level("2026-11-13 WARNING: retry"),
            Some("WARNING")
        );
        assert_eq!(parse_log_level("[error] failed"), Some("ERROR"));
        assert_eq!(parse_log_level("plain stdout line"), None);
        assert_eq!(parse_log_level("Updating information now"), None);
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
