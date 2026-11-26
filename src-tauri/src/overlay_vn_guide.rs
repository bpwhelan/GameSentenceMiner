//! Native VN-Guide library, GitHub/local catalogue loader, progress store,
//! OCR menu/choice tracker, HUD controller, and isolated custom-page helpers.
//!
//! Replaces `GSM_Overlay/vn_guide.js`, `vn_guide_library.js`,
//! `vn_guide_catalogue.js`, `vn_guide_controller.js`, `vn_guide_hud.js`, and
//! `custom_page_window.js` with allocation-light native Rust.

use gsm_settings::write_atomic;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;

#[allow(dead_code)]
pub const VN_GUIDE_SITE: &str = "https://kanjieater.github.io/VN-Guide/";
pub const VN_GUIDE_RAW: &str = "https://raw.githubusercontent.com/kanjieater/VN-Guide/main/";
pub const DEFAULT_CATALOGUE_SOURCE: &str = "https://github.com/kanjieater/VN-Guide";
pub const UPDATE_INTERVAL_MS: u64 = 15 * 60 * 1000;
const HOOK_MENU_MAX_AGE_MS: u64 = 10_000;
const LOOK_AHEAD_CHOICES: usize = 3;
const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn percent_encode_segment(raw: &str) -> String {
    url::form_urlencoded::byte_serialize(raw.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

fn strip_punct_space_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[\p{P}\p{S}\s]").expect("valid unicode regex"))
}

fn choice_prefix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(?:[▶▷►●○・]\s*)*(?:\d{1,2}[.)、]\s*)?").expect("valid choice prefix regex")
    })
}

fn number_prefix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(\d{1,2})[.)、]\s*([^\d\s])").expect("valid num prefix regex"))
}

fn has_number_prefix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\d{1,2}[.)、]").expect("valid has_num prefix regex"))
}

fn choice_number_token(text: &str) -> Option<i32> {
    let digits = text.trim();
    if !(1..=2).contains(&digits.chars().take(3).count())
        || !digits
            .chars()
            .all(|c| c.is_ascii_digit() || ('０'..='９').contains(&c))
    {
        return None;
    }
    nfkc_compat(digits)
        .parse()
        .ok()
        .filter(|number| *number > 0)
}

fn save_control_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)セーブ|ロード|上書き|保存先|^(?:(?:quick|auto)?(?:save|load)(?:game|data|slot)?|overwrite)$")
            .expect("valid save control regex")
    })
}

fn cjk_script_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]")
            .expect("valid cjk regex")
    })
}

fn word_letter_or_digit_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[\p{L}\p{N}]").expect("valid alnum regex"))
}

fn safe_slug_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[\p{L}\p{N}_-]{1,160}$").expect("valid slug regex"))
}

fn safe_vndb_id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(?:v[0-9]+|game:[a-z0-9]+(?:-[a-z0-9]+)*)$").expect("valid vndb regex")
    })
}

fn trailing_sentence_punct(ch: char) -> bool {
    matches!(
        ch,
        '。' | '！'
            | '？'
            | '!'
            | '?'
            | '…'
            | '‥'
            | '.'
            | ','
            | '，'
            | '、'
            | '：'
            | ':'
            | '；'
            | ';'
    )
}

/// Fast pure-Rust NFKC normalization covering ASCII fast-path, fullwidth ASCII,
/// ideographic space, fullwidth punctuation (`．`, `、`), and halfwidth katakana + dakuten/handakuten.
pub fn nfkc_compat(input: &str) -> String {
    if input.is_ascii() {
        return input.to_string();
    }
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        match ch {
            '\u{3000}' => out.push(' '),
            '\u{FF01}'..='\u{FF5E}' => {
                if let Some(ascii) = char::from_u32((ch as u32) - 0xFEE0) {
                    out.push(ascii);
                } else {
                    out.push(ch);
                }
            }
            '\u{FF61}' => out.push('。'),
            '\u{FF62}' => out.push('「'),
            '\u{FF63}' => out.push('」'),
            '\u{FF64}' => out.push('、'),
            '\u{FF65}' => out.push('・'),
            '\u{FF70}' => out.push('ー'),
            '\u{FF66}'..='\u{FF9D}' => {
                let base = match ch {
                    'ｦ' => 'ヲ',
                    'ｧ' => 'ァ',
                    'ｨ' => 'ィ',
                    'ｩ' => 'ゥ',
                    'ｪ' => 'ェ',
                    'ｫ' => 'ォ',
                    'ｬ' => 'ャ',
                    'ｭ' => 'ュ',
                    'ｮ' => 'ョ',
                    'ｯ' => 'ッ',
                    'ｱ' => 'ア',
                    'ｲ' => 'イ',
                    'ｳ' => 'ウ',
                    'ｴ' => 'エ',
                    'ｵ' => 'オ',
                    'ｶ' => 'カ',
                    'ｷ' => 'キ',
                    'ｸ' => 'ク',
                    'ｹ' => 'ケ',
                    'ｺ' => 'コ',
                    'ｻ' => 'サ',
                    'ｼ' => 'シ',
                    'ｽ' => 'ス',
                    'ｾ' => 'セ',
                    'ｿ' => 'ソ',
                    'ﾀ' => 'タ',
                    'ﾁ' => 'チ',
                    'ﾂ' => 'ツ',
                    'ﾃ' => 'テ',
                    'ﾄ' => 'ト',
                    'ﾅ' => 'ナ',
                    'ﾆ' => 'ニ',
                    'ﾇ' => 'ヌ',
                    'ﾈ' => 'ネ',
                    'ﾉ' => 'ノ',
                    'ﾊ' => 'ハ',
                    'ﾋ' => 'ヒ',
                    'ﾌ' => 'フ',
                    'ﾍ' => 'ヘ',
                    'ﾎ' => 'ホ',
                    'ﾏ' => 'マ',
                    'ﾐ' => 'ミ',
                    'ﾑ' => 'ム',
                    'ﾒ' => 'メ',
                    'ﾓ' => 'モ',
                    'ﾔ' => 'ヤ',
                    'ﾕ' => 'ユ',
                    'ﾖ' => 'ヨ',
                    'ﾗ' => 'ラ',
                    'ﾘ' => 'リ',
                    'ﾙ' => 'ル',
                    'ﾚ' => 'レ',
                    'ﾛ' => 'ロ',
                    'ﾜ' => 'ワ',
                    'ﾝ' => 'ン',
                    _ => ch,
                };
                let next = chars.get(i + 1).copied();
                let combined = match next {
                    Some('\u{FF9E}') => match base {
                        'ウ' => Some('ヴ'),
                        'カ' | 'キ' | 'ク' | 'ケ' | 'コ' | 'サ' | 'シ' | 'ス' | 'セ' | 'ソ'
                        | 'タ' | 'チ' | 'ツ' | 'テ' | 'ト' | 'ハ' | 'ヒ' | 'フ' | 'ヘ' | 'ホ' => {
                            char::from_u32((base as u32) + 1)
                        }
                        _ => None,
                    },
                    Some('\u{FF9F}') => match base {
                        'ハ' | 'ヒ' | 'フ' | 'ヘ' | 'ホ' => char::from_u32((base as u32) + 2),
                        _ => None,
                    },
                    _ => None,
                };
                if let Some(c) = combined {
                    out.push(c);
                    i += 1;
                } else {
                    out.push(base);
                }
            }
            '\u{FF9E}' => out.push('゛'),
            '\u{FF9F}' => out.push('゜'),
            _ => out.push(ch),
        }
        i += 1;
    }
    out
}

/// Normalize choice text for comparisons, stripping decorative bullets/numbers and
/// punctuation/symbols/whitespace while keeping letters such as the Japanese vowel mark `ー`.
pub fn normalize_choice(value: &str) -> String {
    let compat = nfkc_compat(value);
    let trimmed = compat.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let without_prefix = choice_prefix_re().replace(trimmed, "");
    strip_punct_space_re()
        .replace_all(&without_prefix, "")
        .into_owned()
}

// OCR sometimes attaches a bare list number to an otherwise complete answer.
// Only ignore it when the entire remaining row equals the current instruction.
fn exact_current_row(text: &str, target: &str) -> bool {
    text == target
        || text.strip_suffix(target).is_some_and(|prefix| {
            (1..=2).contains(&prefix.len())
                && prefix.bytes().all(|b| b.is_ascii_digit())
                && !target.starts_with(|c: char| c.is_ascii_digit())
        })
}

fn is_save_control_text(normalized_text: &str) -> bool {
    !normalized_text.is_empty() && save_control_re().is_match(normalized_text)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedGuideSource {
    pub base_url: String,
    pub progress_id: String,
    pub local_dir: Option<PathBuf>,
    pub route_id: String,
    pub step: Option<usize>,
}

fn has_traversal_or_empty_path(path: &str) -> bool {
    path.split('/').any(|seg| seg == ".." || seg == ".")
}

/// Parse and canonicalize a VN-Guide URL or local folder path (`vn_guide.js::parseGuideUrl`).
pub fn parse_guide_url(value: &str) -> Result<ParsedGuideSource, String> {
    let input = value
        .trim()
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(value.trim())
        .trim();
    if input.is_empty() {
        return Err("Enter a VN-Guide URL or local guide folder.".into());
    }

    let as_path = Path::new(input);
    let url = if as_path.is_absolute() {
        url::Url::from_directory_path(as_path)
            .or_else(|_| url::Url::from_file_path(as_path))
            .map_err(|_| "Enter a valid VN-Guide URL or local guide folder.".to_string())?
    } else {
        url::Url::parse(input)
            .map_err(|_| "Enter a valid VN-Guide URL or local guide folder.".to_string())?
    };

    let nav: HashMap<_, _> = url::form_urlencoded::parse(url.fragment().unwrap_or("").as_bytes())
        .into_owned()
        .collect();
    let file_route = url
        .path()
        .rsplit('/')
        .next()
        .unwrap_or("")
        .strip_prefix("route_")
        .and_then(|s| s.strip_suffix(".json"))
        .map(urlencoding_decode_lossy);
    let route_id = nav
        .get("route")
        .filter(|s| !s.is_empty())
        .cloned()
        .or(file_route)
        .unwrap_or_default();
    if !route_id.is_empty() && !safe_slug_re().is_match(&route_id) {
        return Err("Invalid route in the guide URL.".into());
    }
    let step = nav
        .get("step")
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|s| s.parse::<usize>().ok());

    if url.scheme() == "file" {
        let mut path = url
            .to_file_path()
            .map_err(|_| "Local guide path must be an absolute path.".to_string())?;
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name == "index.html"
                || name == "guide.json"
                || (name.starts_with("route_") && name.ends_with(".json"))
            {
                if let Some(parent) = path.parent() {
                    path = parent.to_path_buf();
                }
            }
        }
        let dir_url = url::Url::from_directory_path(&path)
            .map_err(|_| "Local guide folder path is invalid.".to_string())?;
        let base_url = dir_url.to_string();
        return Ok(ParsedGuideSource {
            progress_id: base_url.clone(),
            base_url,
            local_dir: Some(path),
            route_id,
            step,
        });
    }

    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(
            "Use a GitHub, raw GitHub, or GitHub Pages VN-Guide URL, or a local game guide folder."
                .into(),
        );
    }

    let host = url.host_str().unwrap_or("");
    let raw_path = url.path();
    if has_traversal_or_empty_path(raw_path) {
        return Err("Invalid VN-Guide URL path.".into());
    }

    let segments: Vec<String> = raw_path
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| urlencoding_decode_lossy(s))
        .collect();

    let mut clean = segments;
    if let Some(last) = clean.last() {
        if last == "index.html"
            || last == "guide.json"
            || (last.starts_with("route_") && last.ends_with(".json"))
        {
            clean.pop();
        }
    }

    let canonical_base = if let Some(owner) = host.strip_suffix(".github.io") {
        if owner.is_empty() || clean.len() != 2 {
            return Err("Include a game slug in the VN-Guide URL.".into());
        }
        format!(
            "https://raw.githubusercontent.com/{}/{}/main/{}/",
            percent_encode_segment(owner),
            percent_encode_segment(&clean[0]),
            percent_encode_segment(&clean[1])
        )
    } else if host.eq_ignore_ascii_case("github.com") {
        if clean.len() < 3 {
            return Err(
                "Use a GitHub URL pointing to a guide folder (github.com/owner/repo/tree/branch/game)."
                    .into(),
            );
        }
        let owner = &clean[0];
        let repo = &clean[1];
        let tail = &clean[2..];
        let mut parts: Vec<String> = vec![owner.clone(), repo.clone()];
        if tail.len() >= 3 && (tail[0] == "tree" || tail[0] == "blob") {
            parts.extend(tail[1..].iter().cloned());
        } else {
            parts.push("main".into());
            parts.extend(tail.iter().cloned());
        }
        if parts.len() < 4 {
            return Err("Include a game slug in the GitHub VN-Guide URL.".into());
        }
        let encoded: Vec<String> = parts.iter().map(|p| percent_encode_segment(p)).collect();
        format!("https://raw.githubusercontent.com/{}/", encoded.join("/"))
    } else if host.eq_ignore_ascii_case("raw.githubusercontent.com") {
        if clean.len() < 4 {
            return Err("Include owner/repo/branch/slug in the raw GitHub URL.".into());
        }
        let encoded: Vec<String> = clean.iter().map(|p| percent_encode_segment(p)).collect();
        format!("https://raw.githubusercontent.com/{}/", encoded.join("/"))
    } else {
        return Err(
            "Use a GitHub, raw GitHub, or GitHub Pages VN-Guide URL, or a local game guide folder."
                .into(),
        );
    };

    let slug = clean.last().map(String::as_str).unwrap_or("");
    let progress_id =
        if canonical_base == format!("{VN_GUIDE_RAW}{}/", percent_encode_segment(slug)) {
            slug.to_string()
        } else {
            canonical_base.clone()
        };

    Ok(ParsedGuideSource {
        base_url: canonical_base,
        progress_id,
        local_dir: None,
        route_id,
        step,
    })
}

fn urlencoding_decode_lossy(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let raw = input.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() {
            if let Ok(hex) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                bytes.push(hex);
                i += 3;
                continue;
            }
        }
        bytes.push(raw[i]);
        i += 1;
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideRouteMeta {
    pub id: String,
    pub title: String,
    pub reviewed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideManifest {
    pub title: String,
    pub target: String,
    pub routes: Vec<GuideRouteMeta>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideStep {
    pub text: String,
    pub kind: String,
}

pub fn step_kind(text: &str) -> &'static str {
    let compat = nfkc_compat(text);
    let lower = compat.trim().to_ascii_lowercase();
    if lower.contains("ロード")
        || lower
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .any(|word| word == "load")
    {
        "load"
    } else if lower.contains("セーブ")
        || lower.starts_with("save ")
        || lower == "save"
        || lower.contains("save here")
        || lower.contains("create save")
    {
        "save"
    } else if lower.starts_with("load ")
        || lower == "load"
        || lower.contains("load save")
        || lower.contains("load file")
    {
        "load"
    } else {
        "choice"
    }
}

pub fn validate_guide(data: &Value) -> Result<GuideManifest, String> {
    let obj = data
        .as_object()
        .ok_or_else(|| "This file is not a valid VN-Guide manifest (guide.json).".to_string())?;
    let title = obj
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Guide manifest is missing a title.".to_string())?
        .chars()
        .take(300)
        .collect::<String>();

    let target = obj
        .get("guide_target")
        .and_then(|v| v.get("label"))
        .and_then(Value::as_str)
        .map(|s| s.trim().chars().take(300).collect::<String>())
        .unwrap_or_default();

    let routes_val = obj
        .get("routes")
        .and_then(Value::as_array)
        .ok_or_else(|| "Guide manifest has no routes array.".to_string())?;
    if routes_val.is_empty() || routes_val.len() > 200 {
        return Err("Guide manifest routes list is empty or too large.".into());
    }

    let mut routes = Vec::with_capacity(routes_val.len());
    let mut seen_ids = HashSet::new();
    for item in routes_val {
        let Some(r) = item.as_object() else {
            return Err("Invalid route entry in guide.json.".into());
        };
        let Some(id) = r.get("id").and_then(Value::as_str).map(str::trim) else {
            return Err("Route entry is missing an id.".into());
        };
        if id.is_empty()
            || id.contains('/')
            || id.contains("..")
            || !seen_ids.insert(id.to_string())
        {
            return Err(format!("Invalid or duplicate route id: {id}"));
        }
        let route_title = r
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(id)
            .chars()
            .take(300)
            .collect();
        let reviewed = r.get("reviewed").and_then(Value::as_bool).unwrap_or(false);
        routes.push(GuideRouteMeta {
            id: id.to_string(),
            title: route_title,
            reviewed,
        });
    }

    Ok(GuideManifest {
        title,
        target,
        routes,
    })
}

pub fn validate_route(data: &Value) -> Result<Vec<GuideStep>, String> {
    let raw_steps = if let Some(arr) = data.as_array() {
        arr
    } else if let Some(arr) = data.get("steps").and_then(Value::as_array) {
        arr
    } else if let Some(arr) = data.get("choices").and_then(Value::as_array) {
        arr
    } else {
        return Err("Invalid VN-Guide route file.".into());
    };
    if raw_steps.is_empty() || raw_steps.len() > 5000 {
        return Err("This route does not contain a supported step list.".into());
    }
    let mut steps = Vec::with_capacity(raw_steps.len());
    for entry in raw_steps {
        let (text_raw, kind_override) = if let Some(s) = entry.as_str() {
            (s.trim(), None)
        } else if let Some(obj) = entry.as_object() {
            let txt = obj
                .get("simpleJp")
                .or_else(|| obj.get("text"))
                .or_else(|| obj.get("choice"))
                .or_else(|| obj.get("label"))
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            let kind = if obj.get("isLoad") == Some(&json!(true)) {
                Some("load")
            } else {
                obj.get("kind")
                    .or_else(|| obj.get("type"))
                    .and_then(Value::as_str)
                    .and_then(|k| match k {
                        "choice" | "save" | "load" => Some(k),
                        _ => None,
                    })
            };
            (txt, kind)
        } else {
            return Err("Invalid step in VN-Guide route.".into());
        };
        if text_raw.is_empty() || text_raw.chars().count() > 2000 {
            return Err("A route step is missing its Japanese instruction or is too long.".into());
        }
        let kind = kind_override
            .unwrap_or_else(|| step_kind(text_raw))
            .to_string();
        steps.push(GuideStep {
            text: text_raw.to_owned(),
            kind,
        });
    }
    Ok(steps)
}

pub fn fingerprint_steps(steps: &[GuideStep]) -> String {
    // Match the existing JS library so upgrades preserve the user's position.
    let digest = Sha256::digest(serde_json::to_vec(steps).expect("guide steps serialize"));
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn old_native_fingerprint_steps(steps: &[GuideStep]) -> String {
    let mut hasher = Sha256::new();
    for step in steps {
        hasher.update(step.kind.as_bytes());
        hasher.update(b":");
        hasher.update(step.text.as_bytes());
        hasher.update(b"\n");
    }
    let digest = hasher.finalize();
    let mut out = String::with_capacity(32);
    for byte in &digest[..16] {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueEntry {
    pub slug: String,
    pub title: String,
    pub alttitle: String,
    pub target: String,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueListResult {
    pub guides: Vec<CatalogueEntry>,
    pub warning: String,
}

#[derive(Clone, Debug)]
pub struct LoadedGuide {
    pub key: String,
    pub source: ParsedGuideSource,
    pub guide: GuideManifest,
    pub route: GuideRouteMeta,
    pub steps: Vec<GuideStep>,
    pub fingerprint: String,
    pub index: usize,
    pub changed: bool,
}

fn read_json_object_file(path: &Path) -> Map<String, Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

pub async fn fetch_guide_json(http: &reqwest::Client, url_or_path: &str) -> Result<Value, String> {
    if let Ok(parsed) = url::Url::parse(url_or_path) {
        if parsed.scheme() == "file" {
            let file_path = parsed
                .to_file_path()
                .map_err(|_| "Invalid local file URL".to_string())?;
            return read_local_json_safe(&file_path);
        }
    } else if Path::new(url_or_path).is_absolute() {
        return read_local_json_safe(Path::new(url_or_path));
    }

    let response = http
        .get(url_or_path)
        .header("Accept", "application/json")
        .header("User-Agent", "GameSentenceMiner-Overlay")
        .timeout(HTTP_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch VN-Guide data: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "HTTP {} while fetching {url_or_path}",
            status.as_u16()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed reading VN-Guide response: {e}"))?;
    if bytes.len() > MAX_JSON_BYTES {
        return Err("VN-Guide file exceeds maximum allowed size (8 MB).".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("Invalid VN-Guide JSON: {e}"))
}

fn read_local_json_safe(path: &Path) -> Result<Value, String> {
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Invalid relative path in VN-Guide source.".into());
    }
    let meta =
        fs::symlink_metadata(path).map_err(|e| format!("Not found ({}): {e}", path.display()))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(format!(
            "Unsafe or non-file guide entry: {}",
            path.display()
        ));
    }
    if meta.len() as usize > MAX_JSON_BYTES {
        return Err("Local VN-Guide file exceeds 8 MB limit.".into());
    }
    let text =
        fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("Invalid JSON in {}: {e}", path.display()))
}

#[derive(Clone, Debug)]
struct ParsedCatalogueSource {
    base_url: String,
    index_url: String,
    local_dir: Option<PathBuf>,
    tree_url: Option<String>,
}

fn parse_catalogue_source(value: Option<&str>) -> Result<ParsedCatalogueSource, String> {
    let raw = value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_CATALOGUE_SOURCE)
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or_else(|| {
            value
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_CATALOGUE_SOURCE)
        });
    let with_slug = if raw.ends_with("/games.json") {
        raw.trim_end_matches("/games.json").to_string()
    } else if raw.ends_with("\\games.json") {
        Path::new(raw)
            .parent()
            .unwrap_or_else(|| Path::new(raw))
            .to_string_lossy()
            .into_owned()
    } else {
        raw.to_string()
    };

    let sentinel = if Path::new(&with_slug).is_absolute() {
        Path::new(&with_slug)
            .join("__catalogue__")
            .to_string_lossy()
            .into_owned()
    } else {
        format!("{}/__catalogue__/", with_slug.trim_end_matches('/'))
    };
    let parsed = parse_guide_url(&sentinel).map_err(|_| {
        "Use a GitHub repository URL or an absolute path to a guide catalogue folder.".to_string()
    })?;
    let base_url = if let Some(dir) = parsed.local_dir.as_ref().and_then(|d| d.parent()) {
        url::Url::from_directory_path(dir)
            .map_err(|_| "Invalid local catalogue directory.".to_string())?
            .to_string()
    } else {
        parsed
            .base_url
            .trim_end_matches("__catalogue__/")
            .to_string()
    };
    let local_dir = parsed
        .local_dir
        .and_then(|d| d.parent().map(Path::to_path_buf));
    let index_url = format!("{base_url}games.json");
    let tree_url = if local_dir.is_none() {
        let u = url::Url::parse(&base_url).ok();
        u.and_then(|parsed_u| {
            let parts: Vec<String> = parsed_u
                .path()
                .split('/')
                .filter(|s| !s.is_empty())
                .map(urlencoding_decode_lossy)
                .collect();
            if parts.len() >= 3 {
                let owner = percent_encode_segment(&parts[0]);
                let repo = percent_encode_segment(&parts[1]);
                let branch = percent_encode_segment(&parts[2..].join("/"));
                Some(format!(
                    "https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1"
                ))
            } else {
                None
            }
        })
    } else {
        None
    };

    Ok(ParsedCatalogueSource {
        base_url,
        index_url,
        local_dir,
        tree_url,
    })
}

pub fn validated_catalogue_source(value: Option<&str>) -> Result<String, String> {
    let source = value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_CATALOGUE_SOURCE);
    parse_catalogue_source(Some(source))?;
    Ok(source.to_owned())
}

fn validate_catalogue_map(data: &Value) -> Result<Vec<CatalogueEntry>, String> {
    let obj = data
        .as_object()
        .ok_or_else(|| "This file is not a VN-Guide games.json catalogue.".to_string())?;
    if obj.len() > 2000 {
        return Err("The guide catalogue contains too many games.".into());
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for game in obj.values() {
        let Some(g) = game.as_object() else {
            return Err("The catalogue contains an invalid or duplicate game.".into());
        };
        let slug = g.get("slug").and_then(Value::as_str).unwrap_or("");
        let title = g
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let has_guide = g.get("has_guide").and_then(Value::as_bool);
        if !safe_slug_re().is_match(slug)
            || !seen.insert(slug.to_string())
            || title.is_empty()
            || has_guide.is_none()
        {
            return Err("The catalogue contains an invalid or duplicate game.".into());
        }
        if has_guide != Some(true) {
            continue;
        }
        let alttitle = g
            .get("alttitle")
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .take(300)
            .collect();
        let target = g
            .get("guide_target")
            .and_then(|v| v.get("label"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .take(300)
            .collect();
        out.push(CatalogueEntry {
            slug: slug.to_string(),
            title: title.chars().take(300).collect(),
            alttitle,
            target,
            url: String::new(),
        });
    }
    Ok(out)
}

fn catalogues_in_tree(data: &Value) -> Result<Vec<String>, String> {
    let truncated = data
        .get("truncated")
        .and_then(Value::as_bool)
        .ok_or_else(|| "GitHub returned an invalid guide directory listing.".to_string())?;
    if truncated {
        return Err("GitHub returned an incomplete guide directory listing.".into());
    }
    let tree = data
        .get("tree")
        .and_then(Value::as_array)
        .ok_or_else(|| "GitHub returned an invalid guide directory listing.".to_string())?;

    let mut files: HashMap<&str, &Map<String, Value>> = HashMap::with_capacity(tree.len());
    for entry in tree {
        if let Some(obj) = entry.as_object() {
            if let Some(p) = obj.get("path").and_then(Value::as_str) {
                files.insert(p, obj);
            }
        }
    }

    let mut slugs = Vec::new();
    for (filename, entry) in &files {
        let mut split = filename.split('/');
        let (Some(slug), Some(file), None) = (split.next(), split.next(), split.next()) else {
            continue;
        };
        if file != "catalog.json" || slug.starts_with('.') {
            continue;
        }
        let Some(manifest) = files.get(format!("{slug}/guide.json").as_str()) else {
            return Err(
                "The catalogue contains an unsafe folder or a missing guide manifest.".into(),
            );
        };
        let valid_blob = |e: &Map<String, Value>| {
            e.get("type").and_then(Value::as_str) == Some("blob")
                && matches!(
                    e.get("mode").and_then(Value::as_str),
                    Some("100644") | Some("100755")
                )
        };
        if !safe_slug_re().is_match(slug) || !valid_blob(entry) || !valid_blob(manifest) {
            return Err(
                "The catalogue contains an unsafe folder or a missing guide manifest.".into(),
            );
        }
        slugs.push(slug.to_string());
    }
    slugs.sort();
    Ok(slugs)
}

fn local_catalogues(dir: &Path) -> Result<Vec<String>, String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("Cannot read catalogue dir: {e}"))?;
    let mut slugs = Vec::new();
    for item in entries.flatten() {
        let path = item.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let catalog_path = path.join("catalog.json");
        if !catalog_path.exists() {
            continue;
        }
        let guide_path = path.join("guide.json");
        let cat_ok = fs::symlink_metadata(&catalog_path)
            .map(|m| m.is_file())
            .unwrap_or(false);
        let guide_ok = fs::symlink_metadata(&guide_path)
            .map(|m| m.is_file())
            .unwrap_or(false);
        if !safe_slug_re().is_match(name) || !cat_ok || !guide_ok {
            return Err(
                "The catalogue contains an unsafe folder or a missing guide manifest.".into(),
            );
        }
        slugs.push(name.to_string());
    }
    slugs.sort();
    Ok(slugs)
}

fn validate_game_catalogue_entry(
    metadata: &Value,
    guide_data: &Value,
    slug: &str,
) -> Result<(String, Value), String> {
    let meta_obj = metadata
        .as_object()
        .ok_or_else(|| format!("Invalid catalogue or mismatched guide in {slug}."))?;
    let id = meta_obj
        .get("vndb_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let meta_slug = meta_obj.get("slug").and_then(Value::as_str);
    let data_vndb = guide_data
        .get("vndb_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !safe_vndb_id_re().is_match(id)
        || (meta_slug.is_some() && meta_slug != Some(slug))
        || data_vndb != id
    {
        return Err(format!("Invalid catalogue or mismatched guide in {slug}."));
    }
    let guide = validate_guide(guide_data)?;
    let title = meta_obj
        .get("title")
        .and_then(Value::as_str)
        .map(|s| s.chars().take(300).collect::<String>())
        .unwrap_or_else(|| guide.title.clone());
    let alttitle = meta_obj
        .get("alttitle")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(300)
        .collect::<String>();
    let label = meta_obj
        .get("guide_target")
        .or_else(|| guide_data.get("guide_target"))
        .and_then(|v| v.get("label"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(300)
        .collect::<String>();
    let has_guide = guide.routes.iter().all(|r| r.reviewed);
    Ok((
        id.to_string(),
        json!({
            "slug": slug,
            "title": title,
            "alttitle": alttitle,
            "guide_target": { "label": label },
            "has_guide": has_guide,
        }),
    ))
}

pub struct GuideStore {
    http: reqwest::Client,
    cache_file: PathBuf,
    progress_file: PathBuf,
    catalogue_cache_file: PathBuf,
    cache: Map<String, Value>,
    progress: Map<String, Value>,
    catalogue_cache: Map<String, Value>,
    fetched_at_ms: HashMap<String, u64>,
}

impl GuideStore {
    pub fn new(http: reqwest::Client, data_dir: &Path) -> Self {
        let cache_file = data_dir.join("vn-guide-cache.json");
        let progress_file = data_dir.join("vn-guide-progress.json");
        let catalogue_cache_file = data_dir.join("vn-guide-catalogue-cache.json");
        Self {
            http,
            cache: read_json_object_file(&cache_file),
            progress: read_json_object_file(&progress_file),
            catalogue_cache: read_json_object_file(&catalogue_cache_file),
            cache_file,
            progress_file,
            catalogue_cache_file,
            fetched_at_ms: HashMap::new(),
        }
    }

    async fn fetch_cached_json<F>(
        &mut self,
        key: &str,
        validator: F,
        refresh: bool,
    ) -> Result<Value, String>
    where
        F: Fn(&Value) -> Result<(), String>,
    {
        if !refresh {
            if let Some(cached) = self.cache.get(key) {
                if validator(cached).is_ok() {
                    return Ok(cached.clone());
                }
            }
        }
        let fetched = fetch_guide_json(&self.http, key).await?;
        validator(&fetched)?;
        self.cache.insert(key.to_string(), fetched.clone());
        self.fetched_at_ms.insert(key.to_string(), now_ms());
        let _ = write_atomic(&self.cache_file, &Value::Object(self.cache.clone()));
        Ok(fetched)
    }

    pub async fn load(
        &mut self,
        url_input: &str,
        requested_route_id: Option<&str>,
        refresh: bool,
    ) -> Result<LoadedGuide, String> {
        let source = parse_guide_url(url_input)?;
        let guide_url = format!("{}guide.json", source.base_url);
        let guide_json = self
            .fetch_cached_json(&guide_url, |v| validate_guide(v).map(|_| ()), refresh)
            .await?;
        let guide = validate_guide(&guide_json)?;

        let chosen_route_id = requested_route_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .or_else(|| (!source.route_id.is_empty()).then_some(source.route_id.as_str()))
            .unwrap_or(guide.routes[0].id.as_str())
            .to_string();
        let route = guide
            .routes
            .iter()
            .find(|r| r.id == chosen_route_id)
            .cloned()
            .ok_or_else(|| "Selected route does not exist in guide.".to_string())?;

        let route_url = format!(
            "{}route_{}.json",
            source.base_url,
            percent_encode_segment(&route.id)
        );
        let route_json = self
            .fetch_cached_json(&route_url, |v| validate_route(v).map(|_| ()), refresh)
            .await?;
        let steps = validate_route(&route_json)?;
        let fingerprint = fingerprint_steps(&steps);
        let key = format!("{}/{}", source.progress_id, route.id);
        let old_native_key = format!("{}#{}", source.progress_id, route.id);

        let saved = self
            .progress
            .get(&key)
            .or_else(|| self.progress.get(&old_native_key))
            .and_then(Value::as_object);
        let (index, changed) = if let Some(entry) = saved {
            let saved_fp = entry.get("fingerprint").and_then(Value::as_str);
            let saved_idx = entry.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            if saved_fp == Some(fingerprint.as_str())
                || saved_fp == Some(old_native_fingerprint_steps(&steps).as_str())
            {
                (saved_idx.min(steps.len()), false)
            } else {
                (0, true)
            }
        } else {
            let initial_index =
                if requested_route_id.is_none_or(|id| id.is_empty() || id == source.route_id) {
                    source.step.unwrap_or(0)
                } else {
                    0
                };
            (
                if initial_index <= steps.len() {
                    initial_index
                } else {
                    0
                },
                false,
            )
        };

        Ok(LoadedGuide {
            key,
            source,
            guide,
            route,
            steps,
            fingerprint,
            index,
            changed,
        })
    }

    fn prepare_update_check(
        &mut self,
        loaded: &LoadedGuide,
        force: bool,
        generation: u64,
    ) -> GuideUpdateCheck {
        let guide_url = format!("{}guide.json", loaded.source.base_url);
        let route_url = format!(
            "{}route_{}.json",
            loaded.source.base_url,
            percent_encode_segment(&loaded.route.id)
        );
        let now = now_ms();
        let recent_g = self
            .fetched_at_ms
            .get(&guide_url)
            .is_some_and(|t| now.saturating_sub(*t) < UPDATE_INTERVAL_MS);
        let recent_r = self
            .fetched_at_ms
            .get(&route_url)
            .is_some_and(|t| now.saturating_sub(*t) < UPDATE_INTERVAL_MS);
        let cached = !force && recent_g && recent_r;
        if !cached {
            // A check does not replace the playable cache. Reopening that cache
            // must still check the source, even shortly after its first download.
            self.fetched_at_ms.remove(&guide_url);
            self.fetched_at_ms.remove(&route_url);
        }
        GuideUpdateCheck {
            generation,
            http: self.http.clone(),
            guide_url,
            route_url,
            cached: cached.then(|| (loaded.guide.clone(), loaded.fingerprint.clone())),
        }
    }

    pub fn save_progress(
        &mut self,
        key: &str,
        index: usize,
        fingerprint: &str,
    ) -> Result<(), String> {
        self.progress.insert(
            key.to_string(),
            json!({ "index": index, "fingerprint": fingerprint }),
        );
        write_atomic(&self.progress_file, &Value::Object(self.progress.clone())).map_err(|_| {
            "Could not save guide progress. Check that the GSM data folder is writable.".to_string()
        })
    }

    pub async fn list_catalogue(
        &mut self,
        source_url: Option<&str>,
        refresh: bool,
    ) -> Result<CatalogueListResult, String> {
        let source = parse_catalogue_source(source_url)?;
        let snap_key = format!("{}#catalogue-v2", source.base_url);

        if !refresh {
            if let Some(cached) = self.catalogue_cache.get(&snap_key) {
                if let Ok(res) = validate_catalogue_snapshot(cached, &source.base_url) {
                    return Ok(res);
                }
            }
        }

        match self.fetch_catalogue_snapshot(&source).await {
            Ok(snapshot) => {
                let res = validate_catalogue_snapshot(&snapshot, &source.base_url)?;
                self.catalogue_cache.insert(snap_key, snapshot);
                let _ = write_atomic(
                    &self.catalogue_cache_file,
                    &Value::Object(self.catalogue_cache.clone()),
                );
                Ok(res)
            }
            Err(err) => {
                if let Some(cached) = self.catalogue_cache.get(&snap_key) {
                    if let Ok(mut res) = validate_catalogue_snapshot(cached, &source.base_url) {
                        res.warning = format!(
                            "Could not refresh the catalogue: {err} Using the cached list."
                        );
                        return Ok(res);
                    }
                }
                Err(err)
            }
        }
    }

    async fn fetch_catalogue_snapshot(
        &self,
        source: &ParsedCatalogueSource,
    ) -> Result<Value, String> {
        let legacy: Option<Map<String, Value>> =
            match fetch_guide_json(&self.http, &source.index_url).await {
                Ok(val) => {
                    validate_catalogue_map(&val)?;
                    val.as_object().cloned()
                }
                Err(e) if e.contains("HTTP 404") || e.contains("Not found") => None,
                Err(e) => return Err(e),
            };

        let slugs_res = if let Some(dir) = source.local_dir.as_deref() {
            local_catalogues(dir)
        } else if let Some(tree_url) = source.tree_url.as_deref() {
            let tree_json = fetch_guide_json(&self.http, tree_url).await?;
            catalogues_in_tree(&tree_json)
        } else {
            Err("Invalid catalogue source.".into())
        };

        let slugs = match slugs_res {
            Ok(s) => s,
            Err(err) => {
                if let Some(leg) = legacy {
                    return Ok(json!({
                        "version": 2,
                        "games": Value::Object(leg),
                        "warning": format!("Could not load all guide folders: {err} Showing only the older catalogue entries.")
                    }));
                }
                return Err(err);
            }
        };

        if legacy.is_none() && slugs.is_empty() {
            return Err("No guide catalogues were found in this source.".into());
        }
        if slugs.len() > 2000 {
            return Err("The guide catalogue contains too many games.".into());
        }

        let sem = Arc::new(Semaphore::new(6));
        let mut tasks = Vec::with_capacity(slugs.len());
        for slug in slugs {
            let permit = sem.clone();
            let http = self.http.clone();
            let base = source.base_url.clone();
            tasks.push(tokio::spawn(async move {
                let _guard = permit.acquire_owned().await.map_err(|e| e.to_string())?;
                let folder = format!("{base}{}/", percent_encode_segment(&slug));
                let catalog_url = format!("{folder}catalog.json");
                let guide_url = format!("{folder}guide.json");
                let (meta_res, guide_res) = tokio::join!(
                    fetch_guide_json(&http, &catalog_url),
                    fetch_guide_json(&http, &guide_url)
                );
                let metadata = meta_res?;
                let guide_data = guide_res?;
                validate_game_catalogue_entry(&metadata, &guide_data, &slug)
            }));
        }

        let mut games = legacy.clone().unwrap_or_default();
        let mut ids = HashSet::new();
        for task in tasks {
            let pair = match task.await {
                Ok(Ok(p)) => p,
                Ok(Err(e)) => {
                    if let Some(leg) = legacy {
                        return Ok(json!({
                            "version": 2,
                            "games": Value::Object(leg),
                            "warning": format!("Could not load all guide folders: {e} Showing only the older catalogue entries.")
                        }));
                    }
                    return Err(e);
                }
                Err(e) => return Err(e.to_string()),
            };
            let (id, game_val) = pair;
            let new_slug = game_val.get("slug").and_then(Value::as_str).unwrap_or("");
            if !ids.insert(id.clone()) {
                return Err("The catalogue contains a duplicate game identifier.".into());
            }
            if let Some(existing_slug) = games
                .get(&id)
                .and_then(|v| v.get("slug"))
                .and_then(Value::as_str)
            {
                if existing_slug != new_slug {
                    return Err("The catalogue contains a duplicate game identifier.".into());
                }
            }
            games.insert(id, game_val);
        }
        let games_val = Value::Object(games);
        validate_catalogue_map(&games_val)?;
        Ok(json!({
            "version": 2,
            "games": games_val,
            "warning": ""
        }))
    }
}

fn validate_catalogue_snapshot(
    data: &Value,
    base_url: &str,
) -> Result<CatalogueListResult, String> {
    let version = data.get("version").and_then(Value::as_i64);
    let warning = data
        .get("warning")
        .and_then(Value::as_str)
        .ok_or_else(|| "Invalid cached guide catalogue.".to_string())?;
    if version != Some(2) {
        return Err("Invalid cached guide catalogue.".into());
    }
    let games = data
        .get("games")
        .ok_or_else(|| "Invalid cached guide catalogue.".to_string())?;
    let mut guides = validate_catalogue_map(games)?;
    for entry in &mut guides {
        entry.url = format!("{base_url}{}/", percent_encode_segment(&entry.slug));
    }
    Ok(CatalogueListResult {
        guides,
        warning: warning.to_string(),
    })
}

// ---------- Geometric OCR Block / Choice Detector ----------

#[derive(Clone, Copy, Debug)]
struct RectBox {
    x1: f64,
    y1: f64,
    x3: f64,
    y3: f64,
    width: f64,
    height: f64,
}

fn read_rect_scaled(rect: &Value, scale: f64) -> Option<RectBox> {
    let obj = rect.as_object()?;
    let mut xs = [0.0f64; 4];
    let mut ys = [0.0f64; 4];
    let mut xn = 0;
    let mut yn = 0;
    for (idx, k) in ["x1", "x2", "x3", "x4"].iter().enumerate() {
        if let Some(v) = obj
            .get(*k)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
        {
            xs[xn] = v * scale;
            xn += 1;
        } else if idx == 0 || idx == 2 {
            return None;
        }
    }
    for (idx, k) in ["y1", "y2", "y3", "y4"].iter().enumerate() {
        if let Some(v) = obj
            .get(*k)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
        {
            ys[yn] = v * scale;
            yn += 1;
        } else if idx == 0 || idx == 2 {
            return None;
        }
    }
    let x1 = xs[..xn].iter().copied().fold(f64::INFINITY, f64::min);
    let x3 = xs[..xn].iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let y1 = ys[..yn].iter().copied().fold(f64::INFINITY, f64::min);
    let y3 = ys[..yn].iter().copied().fold(f64::NEG_INFINITY, f64::max);
    if x3 <= x1 || y3 <= y1 {
        return None;
    }
    Some(RectBox {
        x1,
        y1,
        x3,
        y3,
        width: x3 - x1,
        height: y3 - y1,
    })
}

fn union_rect_boxes<'a>(boxes: impl Iterator<Item = &'a RectBox>) -> Option<RectBox> {
    let mut x1 = f64::INFINITY;
    let mut y1 = f64::INFINITY;
    let mut x3 = f64::NEG_INFINITY;
    let mut y3 = f64::NEG_INFINITY;
    let mut any = false;
    for b in boxes {
        any = true;
        x1 = x1.min(b.x1);
        y1 = y1.min(b.y1);
        x3 = x3.max(b.x3);
        y3 = y3.max(b.y3);
    }
    any.then_some(RectBox {
        x1,
        y1,
        x3,
        y3,
        width: (x3 - x1).max(0.0),
        height: (y3 - y1).max(0.0),
    })
}

#[inline]
fn axis_overlap(a1: f64, a2: f64, b1: f64, b2: f64) -> f64 {
    (a2.min(b2) - a1.max(b1)).max(0.0)
}

#[inline]
fn axis_gap(a1: f64, a2: f64, b1: f64, b2: f64) -> f64 {
    if a2 < b1 {
        b1 - a2
    } else if b2 < a1 {
        a1 - b2
    } else {
        0.0
    }
}

fn median_f64(values: &[f64]) -> f64 {
    let mut finite: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    if finite.is_empty() {
        return 0.0;
    }
    finite.sort_by(|a, b| a.total_cmp(b));
    let mid = finite.len() / 2;
    if finite.len() % 2 == 0 {
        (finite[mid - 1] + finite[mid]) * 0.5
    } else {
        finite[mid]
    }
}

#[derive(Clone, Debug)]
struct PreparedLine {
    normalized: String,
    x1: f64,
    y1: f64,
    y3: f64,
    height: f64,
    center: f64,
    #[allow(dead_code)]
    is_vertical: bool,
    choice_number: Option<i32>,
    has_number_prefix: bool,
    unpunctuated_choice: Option<(i32, String)>,
    isolated: bool,
}

impl PreparedLine {
    fn numbered_choice(&self) -> Option<(i32, &str)> {
        self.choice_number
            .map(|number| (number, self.normalized.as_str()))
            .or_else(|| {
                self.unpunctuated_choice
                    .as_ref()
                    .map(|(number, body)| (*number, body.as_str()))
            })
    }

    fn matches_option(&self, options: &[String]) -> bool {
        contains_option(options, &self.normalized)
            || self
                .unpunctuated_choice
                .as_ref()
                .is_some_and(|(_, body)| options.contains(body))
    }
}

#[derive(Clone, Copy, Debug)]
struct AxisMetric {
    rect: RectBox,
    vertical: bool,
    inline_start: f64,
    inline_end: f64,
    cross_start: f64,
    cross_end: f64,
    font_size: f64,
    advance: f64,
    spacing: f64,
    punctuation_only: bool,
    glyph_count: usize,
    valid: bool,
}

fn with_axes(
    rect: RectBox,
    vertical: bool,
    font_size: f64,
    advance: f64,
    spacing: f64,
    punctuation_only: bool,
    glyph_count: usize,
    valid: bool,
) -> AxisMetric {
    AxisMetric {
        rect,
        vertical,
        inline_start: if vertical { rect.y1 } else { rect.x1 },
        inline_end: if vertical { rect.y3 } else { rect.x3 },
        cross_start: if vertical { rect.x1 } else { rect.y1 },
        cross_end: if vertical { rect.x3 } else { rect.y3 },
        font_size,
        advance,
        spacing,
        punctuation_only,
        glyph_count,
        valid,
    }
}

fn shares_row(a: &AxisMetric, b: &AxisMetric) -> bool {
    let overlap = axis_overlap(a.cross_start, a.cross_end, b.cross_start, b.cross_end);
    a.vertical == b.vertical
        && overlap > 0.0
        && overlap >= (a.cross_end - a.cross_start).min(b.cross_end - b.cross_start) * 0.5
}

fn compatible_font(a: &AxisMetric, b: &AxisMetric) -> bool {
    a.font_size > 0.0
        && b.font_size > 0.0
        && a.font_size.max(b.font_size) <= a.font_size.min(b.font_size) * 1.5
}

fn compatible_inline_font(a: &AxisMetric, b: &AxisMetric) -> bool {
    if compatible_font(a, b) || a.punctuation_only || b.punctuation_only {
        return true;
    }
    (a.glyph_count == 1 || b.glyph_count == 1)
        && a.advance.min(b.advance) > 0.0
        && a.advance.max(b.advance) <= a.advance.min(b.advance) * 1.3
}

fn inline_gap_limit(a: &AxisMetric, b: &AxisMetric) -> f64 {
    let adv = a.advance.min(b.advance) + a.spacing.min(b.spacing);
    (adv * 2.2).min(adv * 1.6 + a.spacing.min(b.spacing) * 2.5)
}

fn aligned_rows(a: &AxisMetric, b: &AxisMetric) -> bool {
    let overlap = axis_overlap(a.inline_start, a.inline_end, b.inline_start, b.inline_end);
    (overlap > 0.0
        && overlap >= (a.inline_end - a.inline_start).min(b.inline_end - b.inline_start) * 0.25)
        || (overlap == 0.0
            && axis_gap(a.inline_start, a.inline_end, b.inline_start, b.inline_end)
                <= a.advance.min(b.advance) * 0.75)
}

fn are_boxes_close(a: &AxisMetric, b: &AxisMetric) -> bool {
    if !a.valid || !b.valid || a.vertical != b.vertical {
        return false;
    }
    if shares_row(a, b) {
        if !compatible_inline_font(a, b) {
            return false;
        }
        return axis_gap(a.inline_start, a.inline_end, b.inline_start, b.inline_end)
            <= inline_gap_limit(a, b);
    }
    compatible_font(a, b)
        && aligned_rows(a, b)
        && axis_gap(a.cross_start, a.cross_end, b.cross_start, b.cross_end)
            <= a.font_size.min(b.font_size) * 1.6
}

fn visible_symbol_count(s: &str) -> usize {
    s.chars().filter(|c| !c.is_whitespace()).count()
}

fn union_find(n: usize, edges: &[(usize, usize)]) -> Vec<Vec<usize>> {
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut [usize], mut x: usize) -> usize {
        while p[x] != x {
            p[x] = p[p[x]];
            x = p[x];
        }
        x
    }
    for &(a, b) in edges {
        let ra = find(&mut parent, a);
        let rb = find(&mut parent, b);
        parent[rb] = ra;
    }
    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        let r = find(&mut parent, i);
        groups.entry(r).or_default().push(i);
    }
    let mut vals: Vec<Vec<usize>> = groups.into_values().collect();
    vals.sort_by_key(|g| g[0]);
    vals
}

fn prepare_choice_lines(data: &[Value]) -> Vec<PreparedLine> {
    if data.len() > 500 {
        return Vec::new();
    }
    struct RawRun {
        text: String,
        rect_norm: RectBox,
        vertical: bool,
        metric: AxisMetric,
        unpunctuated_label: Option<(i32, usize)>,
    }
    let mut runs: Vec<RawRun> = Vec::with_capacity(data.len());

    for line_val in data {
        let Some(text) = line_val.get("text").and_then(Value::as_str) else {
            continue;
        };
        let Some(line_box_norm) = line_val
            .get("bounding_rect")
            .and_then(|r| read_rect_scaled(r, 1.0))
        else {
            continue;
        };
        let words_arr = line_val.get("words").and_then(Value::as_array);
        let mut word_boxes: Vec<(RectBox, &str)> = Vec::new();
        let mut word_offsets: Vec<usize> = Vec::new();
        let mut offsets_valid = false;
        if let Some(words) = words_arr {
            let mut cursor = 0usize;
            offsets_valid = true;
            for w in words {
                let wtxt = w.get("text").and_then(Value::as_str).unwrap_or("");
                if !wtxt.chars().any(|c| !c.is_whitespace()) {
                    continue;
                }
                let Some(wb) = w
                    .get("bounding_rect")
                    .and_then(|r| read_rect_scaled(r, 100.0))
                else {
                    continue;
                };
                if let Some(rel) = text[cursor..].find(wtxt) {
                    let start = cursor + rel;
                    if text[cursor..start].chars().any(|c| !c.is_whitespace()) {
                        offsets_valid = false;
                        break;
                    }
                    word_offsets.push(start);
                    word_boxes.push((wb, wtxt));
                    cursor = start + wtxt.len();
                } else {
                    offsets_valid = false;
                    break;
                }
            }
            if offsets_valid && text[cursor..].chars().any(|c| !c.is_whitespace()) {
                offsets_valid = false;
            }
        }

        let explicit_vert = line_val
            .get("isVertical")
            .and_then(Value::as_bool)
            .or_else(|| line_val.get("is_vertical").and_then(Value::as_bool));
        let infer_vert = |wbs: &[(RectBox, &str)]| -> bool {
            if let Some(v) = explicit_vert {
                return v;
            }
            if wbs.is_empty() || !cjk_script_re().is_match(text) {
                return false;
            }
            let mut horiz = 0;
            let mut vert = 0;
            for (idx, (wb, wt)) in wbs.iter().enumerate() {
                if visible_symbol_count(wt) > 1 {
                    if wb.width > wb.height * 1.2 {
                        horiz += 2;
                    }
                    if wb.height > wb.width * 1.2 {
                        vert += 2;
                    }
                }
                if idx > 0 {
                    let (prev, _) = wbs[idx - 1];
                    if axis_overlap(wb.y1, wb.y3, prev.y1, prev.y3)
                        >= wb.height.min(prev.height) * 0.5
                    {
                        horiz += 1;
                    }
                    if axis_overlap(wb.x1, wb.x3, prev.x1, prev.x3)
                        >= wb.width.min(prev.width) * 0.5
                    {
                        vert += 1;
                    }
                }
            }
            vert > horiz
        };

        if !offsets_valid || word_boxes.is_empty() {
            let scaled = RectBox {
                x1: line_box_norm.x1 * 100.0,
                y1: line_box_norm.y1 * 100.0,
                x3: line_box_norm.x3 * 100.0,
                y3: line_box_norm.y3 * 100.0,
                width: line_box_norm.width * 100.0,
                height: line_box_norm.height * 100.0,
            };
            let vertical = explicit_vert.unwrap_or(false);
            let glyphs = visible_symbol_count(text).max(1);
            let inline_len = if vertical {
                scaled.height
            } else {
                scaled.width
            };
            let cross_len = if vertical {
                scaled.width
            } else {
                scaled.height
            };
            let punct_only = text.chars().any(|c| !c.is_whitespace())
                && !word_letter_or_digit_re().is_match(text);
            let metric = with_axes(
                scaled,
                vertical,
                cross_len,
                inline_len / glyphs as f64,
                0.0,
                punct_only,
                glyphs,
                true,
            );
            runs.push(RawRun {
                text: text.to_string(),
                rect_norm: line_box_norm,
                vertical,
                metric,
                unpunctuated_label: None,
            });
            continue;
        }

        let vertical = infer_vert(&word_boxes);
        let word_metrics: Vec<AxisMetric> = word_boxes
            .iter()
            .map(|(wb, wt)| {
                let glyphs = visible_symbol_count(wt).max(1);
                let inline_len = if vertical { wb.height } else { wb.width };
                let cross_len = if vertical { wb.width } else { wb.height };
                let punct_only = !word_letter_or_digit_re().is_match(wt);
                with_axes(
                    *wb,
                    vertical,
                    cross_len,
                    inline_len / glyphs as f64,
                    0.0,
                    punct_only,
                    glyphs,
                    true,
                )
            })
            .collect();
        let ref_font = {
            let fs: Vec<f64> = word_metrics
                .iter()
                .filter(|m| !m.punctuation_only)
                .map(|m| m.font_size)
                .collect();
            if fs.is_empty() {
                median_f64(&word_metrics.iter().map(|m| m.font_size).collect::<Vec<_>>())
            } else {
                median_f64(&fs)
            }
        };
        let ref_adv = {
            let advs: Vec<f64> = word_metrics
                .iter()
                .filter(|m| !m.punctuation_only)
                .map(|m| m.advance)
                .collect();
            if advs.is_empty() {
                median_f64(&word_metrics.iter().map(|m| m.advance).collect::<Vec<_>>())
            } else {
                median_f64(&advs)
            }
        };
        let mut gaps = Vec::new();
        for w_i in 1..word_metrics.len() {
            let prev = &word_metrics[w_i - 1];
            let cur = &word_metrics[w_i];
            let gap = cur.inline_start - prev.inline_end;
            if shares_row(prev, cur) && gap >= 0.0 && gap <= ref_adv * 2.2 {
                gaps.push(gap);
            }
        }
        let spacing = median_f64(&gaps);

        let mut split_runs: Vec<Vec<usize>> = Vec::new();
        for w_i in 0..word_metrics.len() {
            let mut cur = word_metrics[w_i];
            cur.spacing = spacing;
            if let Some(last_run) = split_runs.last_mut() {
                let prev = word_metrics[*last_run.last().unwrap()];
                let gap = cur.inline_start - prev.inline_end;
                // A narrow number or period may have a larger gap before the
                // choice than its own glyph width can account for.
                let follows_label = || {
                    let prefix = text[word_offsets[last_run[0]]..word_offsets[w_i]].trim();
                    let digits = prefix
                        .strip_suffix(['.', ')', '．', '）', '、'])
                        .unwrap_or(prefix);
                    choice_number_token(digits).is_some()
                };
                if shares_row(&prev, &cur)
                    && compatible_inline_font(&prev, &cur)
                    && cur.inline_start >= prev.inline_start - cur.advance * 0.5
                    && (gap <= inline_gap_limit(&prev, &cur)
                        || (gap <= cur.advance * 1.5 && follows_label()))
                {
                    last_run.push(w_i);
                    continue;
                }
            }
            split_runs.push(vec![w_i]);
        }

        for (r_idx, run_indices) in split_runs.iter().enumerate() {
            let start = if r_idx == 0 {
                0
            } else {
                word_offsets[run_indices[0]]
            };
            let end = if r_idx + 1 == split_runs.len() {
                text.len()
            } else {
                word_offsets[split_runs[r_idx + 1][0]]
            };
            let sub_text = &text[start..end];
            let Some(ub) = union_rect_boxes(run_indices.iter().map(|idx| &word_boxes[*idx].0))
            else {
                continue;
            };
            let rect_norm = RectBox {
                x1: ub.x1 / 100.0,
                y1: ub.y1 / 100.0,
                x3: ub.x3 / 100.0,
                y3: ub.y3 / 100.0,
                width: ub.width / 100.0,
                height: ub.height / 100.0,
            };
            let glyphs = visible_symbol_count(sub_text).max(1);
            let punct_only = sub_text.chars().any(|c| !c.is_whitespace())
                && !word_letter_or_digit_re().is_match(sub_text);
            let metric = with_axes(
                ub, vertical, ref_font, ref_adv, spacing, punct_only, glyphs, true,
            );
            // OCR can drop the period after a menu number (and absorb part of
            // its width into the digit box). Look for a separate digit token
            // with a visible gap before the option text.
            let unpunctuated_label = run_indices.get(1).and_then(|&second| {
                let first = run_indices[0];
                let gap = word_metrics[second].inline_start - word_metrics[first].inline_end;
                if gap < word_metrics[second].advance * 0.25 {
                    return None;
                }
                Some((
                    choice_number_token(word_boxes[first].1)?,
                    word_offsets[second] - start,
                ))
            });
            runs.push(RawRun {
                text: sub_text.to_string(),
                rect_norm,
                vertical,
                metric,
                unpunctuated_label,
            });
        }
    }

    // Filter out invalid / overly large / vertical / multiline candidates matching `choiceLines`
    let kept: Vec<RawRun> = runs
        .into_iter()
        .filter(|r| {
            r.rect_norm.x1 >= 0.0
                && r.rect_norm.x3 <= 1.0
                && r.rect_norm.y1 >= 0.0
                && r.rect_norm.y3 <= 1.0
                && r.rect_norm.x3 > r.rect_norm.x1
                && r.rect_norm.y3 > r.rect_norm.y1
                && r.rect_norm.height <= 0.09
                && !r.vertical
                && r.text.chars().count() <= 100
                && !r.text.contains('\n')
                && !r.text.contains('\r')
        })
        .collect();

    if kept.is_empty() {
        return Vec::new();
    }

    // Group rows & paragraphs using block_detection geometry to compute `isolated`
    let metrics: Vec<AxisMetric> = kept.iter().map(|r| r.metric).collect();
    let mut row_edges = Vec::new();
    for i in 0..metrics.len() {
        for j in (i + 1)..metrics.len() {
            if shares_row(&metrics[i], &metrics[j]) && are_boxes_close(&metrics[i], &metrics[j]) {
                row_edges.push((i, j));
            }
        }
    }
    let rows_members = union_find(metrics.len(), &row_edges);
    let rows_metrics: Vec<AxisMetric> = rows_members
        .iter()
        .map(|members| {
            let rects = union_rect_boxes(members.iter().map(|i| &metrics[*i].rect)).unwrap();
            let fs = median_f64(
                &members
                    .iter()
                    .map(|i| metrics[*i].font_size)
                    .collect::<Vec<_>>(),
            );
            let adv = median_f64(
                &members
                    .iter()
                    .map(|i| metrics[*i].advance)
                    .collect::<Vec<_>>(),
            );
            let sp = median_f64(
                &members
                    .iter()
                    .map(|i| metrics[*i].spacing)
                    .collect::<Vec<_>>(),
            );
            with_axes(
                rects,
                metrics[members[0]].vertical,
                fs,
                adv,
                sp,
                members.iter().all(|i| metrics[*i].punctuation_only),
                1,
                true,
            )
        })
        .collect();

    let mut col_edges = Vec::new();
    for i in 0..rows_metrics.len() {
        for j in (i + 1)..rows_metrics.len() {
            if !shares_row(&rows_metrics[i], &rows_metrics[j])
                && are_boxes_close(&rows_metrics[i], &rows_metrics[j])
            {
                col_edges.push((i, j));
            }
        }
    }
    let neighborhoods = union_find(rows_metrics.len(), &col_edges);

    let floor_unit = median_f64(
        &metrics
            .iter()
            .filter(|m| m.rect.height > 0.0)
            .map(|m| m.rect.height)
            .collect::<Vec<_>>(),
    )
    .max(0.8);

    let mut isolated_flags = vec![false; kept.len()];
    for neigh in neighborhoods {
        // Group paragraphs inside neighborhood cleanly
        let is_name_split =
            if neigh.len() >= 2 && neigh.iter().all(|ri| rows_members[*ri].len() == 1) {
                let mut sorted = neigh.clone();
                sorted.sort_by(|&a, &b| {
                    rows_metrics[a]
                        .rect
                        .y1
                        .total_cmp(&rows_metrics[b].rect.y1)
                        .then(rows_metrics[a].rect.x1.total_cmp(&rows_metrics[b].rect.x1))
                });
                let cand_idx = rows_members[sorted[0]][0];
                let cand_symbols = visible_symbol_count(&kept[cand_idx].text);
                let cand_last_punct = kept[cand_idx]
                    .text
                    .trim()
                    .chars()
                    .last()
                    .is_some_and(trailing_sentence_punct);
                let body_rows = &sorted[1..];
                let widest_body = body_rows
                    .iter()
                    .map(|r| rows_metrics[*r].rect.width)
                    .fold(0.0f64, f64::max);
                let body_h = median_f64(
                    &body_rows
                        .iter()
                        .map(|r| rows_metrics[*r].rect.height)
                        .collect::<Vec<_>>(),
                );
                (2..=16).contains(&cand_symbols)
                    && !cand_last_punct
                    && rows_metrics[sorted[0]].rect.y3 <= rows_metrics[sorted[1]].rect.y1
                    && widest_body > 0.0
                    && rows_metrics[sorted[0]].rect.width <= widest_body * 0.65
                    && rows_metrics[sorted[0]].rect.height <= body_h * 1.15
                    && (rows_metrics[sorted[0]].rect.height <= body_h * 0.9
                        || (body_rows.len() == 1
                            && rows_metrics[sorted[0]].rect.width <= widest_body * 0.35
                            && (rows_metrics[sorted[1]].rect.y1 - rows_metrics[sorted[0]].rect.y3)
                                >= rows_metrics[sorted[0]].rect.height.max(body_h) * 0.6)
                        || body_rows.len() > 1
                            && (rows_metrics[sorted[1]].rect.y1 - rows_metrics[sorted[0]].rect.y3)
                                >= body_h * 0.35
                            && floor_unit > 0.0)
            } else {
                false
            };

        if is_name_split {
            // Nameplate is a semantic character-name block, NOT role == 'text'
            continue;
        }

        if neigh.len() == 1 && rows_members[neigh[0]].len() == 1 {
            isolated_flags[rows_members[neigh[0]][0]] = true;
        }
    }

    let mut lines: Vec<_> = kept
        .into_iter()
        .enumerate()
        .map(|(idx, r)| {
            let source = nfkc_compat(&r.text);
            let trimmed = source.trim();
            let choice_number = number_prefix_re()
                .captures(trimmed)
                .and_then(|c| c.get(1))
                .and_then(|m| m.as_str().parse::<i32>().ok());
            let has_number_prefix = has_number_prefix_re().is_match(trimmed);
            let unpunctuated_choice = r
                .unpunctuated_label
                .filter(|_| !has_number_prefix)
                .map(|(number, body_start)| (number, normalize_choice(&r.text[body_start..])))
                .filter(|(_, body)| !body.is_empty() && !is_save_control_text(body));
            PreparedLine {
                normalized: normalize_choice(&r.text),
                x1: r.rect_norm.x1,
                y1: r.rect_norm.y1,
                y3: r.rect_norm.y3,
                height: r.rect_norm.height,
                center: (r.rect_norm.x1 + r.rect_norm.x3) * 0.5,
                is_vertical: r.vertical,
                choice_number,
                has_number_prefix,
                unpunctuated_choice,
                isolated: isolated_flags[idx],
            }
        })
        .collect();

    // Confirm the detached digits against consecutive numbers on nearby menu rows.
    let confirmed: Vec<_> = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            let (number, body) = line.unpunctuated_choice.as_ref()?;
            lines
                .iter()
                .any(|peer| {
                    peer.numbered_choice()
                        .is_some_and(|(peer_number, peer_body)| {
                            body != peer_body
                                && !peer_body.is_empty()
                                && !is_save_control_text(peer_body)
                                && consecutive_choices(line, *number, peer, peer_number)
                                && compact_choice_geometry(line, peer)
                        })
                })
                .then_some(index)
        })
        .collect();
    for index in confirmed {
        let line = &mut lines[index];
        let (number, body) = line.unpunctuated_choice.take().unwrap();
        line.choice_number = Some(number);
        line.has_number_prefix = true;
        line.normalized = body;
    }
    lines
}

fn choice_similarity(observed: &str, target: &str) -> f64 {
    if observed.is_empty() || target.is_empty() {
        return 0.0;
    }
    if observed == target {
        return 1.0;
    }
    let a: Vec<char> = observed.chars().collect();
    let b: Vec<char> = target.chars().collect();
    let length = a.len().max(b.len());
    let budget = ((length as f64 * 0.12).floor() as usize).clamp(1, 2);
    if a.len().min(b.len()) < 8 || length > 100 || a.len().abs_diff(b.len()) > budget {
        return 0.0;
    }
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for i in 0..a.len() {
        let mut next = Vec::with_capacity(b.len() + 1);
        next.push(i + 1);
        let mut min_val = i + 1;
        for j in 0..b.len() {
            let cost = (next[j] + 1)
                .min(row[j + 1] + 1)
                .min(row[j] + usize::from(a[i] != b[j]));
            min_val = min_val.min(cost);
            next.push(cost);
        }
        if min_val > budget {
            return 0.0;
        }
        row = next;
    }
    if row[b.len()] <= budget {
        1.0 - (row[b.len()] as f64 / length as f64)
    } else {
        0.0
    }
}

fn contains_option(options: &[String], text: &str) -> bool {
    options.iter().any(|opt| choice_similarity(text, opt) > 0.0)
}

fn consecutive_choices(
    first: &PreparedLine,
    first_number: i32,
    second: &PreparedLine,
    second_number: i32,
) -> bool {
    let delta = second_number - first_number;
    delta.abs() == 1 && (second.y1 - first.y1) * f64::from(delta) > 0.0
}

fn compact_choice_geometry(m: &PreparedLine, l: &PreparedLine) -> bool {
    let height = l.height.max(m.height);
    let gap = (l.y1 - m.y3).max(m.y1 - l.y3);
    (l.center - m.center).abs().min((l.x1 - m.x1).abs()) < 0.035
        && (l.height.min(m.height) / height) > 0.65
        && gap >= -height * 0.2
        && gap <= height * 7.0
}

fn is_compact_choice_peer(m: &PreparedLine, l: &PreparedLine) -> bool {
    if l.normalized.is_empty()
        || l.normalized == m.normalized
        || is_save_control_text(&l.normalized)
    {
        return false;
    }
    if (m.has_number_prefix && m.choice_number.is_none())
        || (l.has_number_prefix && l.choice_number.is_none())
    {
        return false;
    }
    if let (Some(first), Some(second)) = (m.choice_number, l.choice_number) {
        return consecutive_choices(m, first, l, second) && compact_choice_geometry(m, l);
    }
    compact_choice_geometry(m, l)
}

#[derive(Clone, Debug)]
struct ChoiceMatch {
    text: String,
    observed: String,
    exact: bool,
    menu: bool,
    options: Vec<String>,
    hook_text: Option<String>,
}

impl ChoiceMatch {
    fn hint(target: String) -> Self {
        Self {
            observed: target.clone(),
            options: vec![target.clone()],
            text: target,
            exact: true,
            menu: false,
            hook_text: None,
        }
    }
}

enum ChoiceSearch<'a> {
    Current(&'a [Value]),
    Ahead,
}

fn find_choice(
    lines: &[PreparedLine],
    expected: &str,
    search: ChoiceSearch<'_>,
) -> Option<ChoiceMatch> {
    let target = normalize_choice(expected);
    if target.is_empty() {
        return None;
    }
    let require_menu = matches!(search, ChoiceSearch::Ahead);
    let mut exact_rows = lines.iter().filter(|line| match search {
        ChoiceSearch::Ahead => line.normalized == target,
        ChoiceSearch::Current(_) => exact_current_row(&line.normalized, &target),
    });
    let (matched, exact) = if let Some(row) = exact_rows.next() {
        if exact_rows.next().is_some() {
            // Repeated text can reveal the current hint but cannot identify a menu.
            return (!require_menu).then(|| ChoiceMatch::hint(target));
        }
        (row, true)
    } else {
        let ChoiceSearch::Current(data) = search else {
            return None;
        };
        // Layout processing can split or discard a complete OCR row.
        if data.len() <= 500
            && data.iter().any(|row| {
                row["text"].as_str().is_some_and(|text| {
                    !text.contains(['\r', '\n'])
                        && exact_current_row(&normalize_choice(text), &target)
                }) && read_rect_scaled(&row["bounding_rect"], 1.0)
                    .is_some_and(|b| b.x1 >= 0.0 && b.y1 >= 0.0 && b.x3 <= 1.0 && b.y3 <= 1.0)
            })
        {
            return Some(ChoiceMatch::hint(target));
        }
        let mut fuzzy = lines.iter().filter(|line| {
            choice_similarity(&line.normalized, &target) > 0.0
                && (line.isolated || lines.iter().any(|peer| is_compact_choice_peer(line, peer)))
        });
        let row = fuzzy.next()?;
        if fuzzy.next().is_some() {
            return None;
        }
        (row, false)
    };
    let peers: Vec<_> = lines
        .iter()
        .filter(|line| {
            is_compact_choice_peer(matched, line)
                && (!require_menu || matched.has_number_prefix == line.has_number_prefix)
        })
        .collect();
    let menu = !peers.is_empty();
    if require_menu && !menu {
        return None;
    }
    if !exact && !menu && choice_similarity(&matched.normalized, &target) < 0.88 {
        return None;
    }
    let mut opts = Vec::new();
    let mut push_uniq = |s: String| {
        if !opts.contains(&s) {
            opts.push(s);
        }
    };
    push_uniq(target.clone());
    push_uniq(matched.normalized.clone());
    for p in peers {
        push_uniq(p.normalized.clone());
    }
    Some(ChoiceMatch {
        text: target,
        observed: matched.normalized.clone(),
        exact,
        menu,
        options: opts,
        hook_text: None,
    })
}

#[derive(Clone, Debug)]
struct RecentTextBatch {
    text: String,
    options: Vec<String>,
    at_ms: u64,
}

fn find_hooked_choice(
    lines: &[PreparedLine],
    expected: &str,
    recent_text: Option<&RecentTextBatch>,
    now: u64,
) -> Option<ChoiceMatch> {
    let rt = recent_text?;
    if now < rt.at_ms || now - rt.at_ms > HOOK_MENU_MAX_AGE_MS {
        return None;
    }
    let target = normalize_choice(expected);
    if target.chars().count() < 6
        || rt.options.iter().any(|o| is_save_control_text(o))
        || lines
            .iter()
            .any(|l| is_save_control_text(&l.normalized) && l.y3 <= 0.74)
    {
        return None;
    }
    let anchors: Vec<&PreparedLine> = lines
        .iter()
        .filter(|l| {
            let len = l.normalized.chars().count();
            l.isolated
                && (6..=100).contains(&len)
                && l.y3 <= 0.72
                && (l.center - 0.5).abs() <= 0.3
                && if rt.options.len() > 1 {
                    rt.options.contains(&l.normalized)
                } else {
                    rt.text.starts_with(&l.normalized)
                }
        })
        .collect();

    for anchor in anchors {
        let menu_opts = if rt.options.len() > 1 {
            if !(2..=6).contains(&rt.options.len())
                || rt
                    .options
                    .iter()
                    .any(|o| !(2..=100).contains(&o.chars().count()))
                || rt.options.iter().filter(|o| **o == target).count() != 1
            {
                continue;
            }
            rt.options.clone()
        } else {
            let Some(tail) = rt.text.strip_prefix(&anchor.normalized) else {
                continue;
            };
            let tail_len = tail.chars().count();
            if !(6..=100).contains(&tail_len)
                || (target != anchor.normalized
                    && (!tail.ends_with(&target) || tail.find(&target) != tail.rfind(&target)))
            {
                continue;
            }
            vec![anchor.normalized.clone(), target.clone()]
        };
        let mut uniq = Vec::new();
        for o in menu_opts {
            if !uniq.contains(&o) {
                uniq.push(o);
            }
        }
        return Some(ChoiceMatch {
            text: target,
            observed: rt.text.clone(),
            exact: true,
            menu: true,
            options: uniq,
            hook_text: Some(rt.text.clone()),
        });
    }
    None
}

#[derive(Clone, Debug)]
struct ArmedChoice {
    options: Vec<String>,
    menu: bool,
    source_is_ocr: bool,
    since_ms: u64,
    presence_id: Option<String>,
    line_id: Option<String>,
    stable: bool,
    save_controls: Vec<(String, f64, f64)>,
    invalidated_at_ms: Option<u64>,
}

pub struct GuideTracker {
    pub steps: Vec<GuideStep>,
    pub index: usize,
    pub tentative: bool,
    pub recovered_from: Option<usize>,
    pub detected: bool,
    armed: Option<ArmedChoice>,
    recent_text: Option<RecentTextBatch>,
    blocked_options: Option<Vec<String>>,
    pending_line_id: Option<String>,
    pending_ahead: Option<(String, u64)>,
    suspended_presence_id: Option<String>,
    suspended_line_id: Option<String>,
    suspended_options: Option<Vec<String>>,
}

impl GuideTracker {
    pub fn new(steps: Vec<GuideStep>, index: usize) -> Self {
        let mut tracker = Self {
            steps,
            index: 0,
            tentative: false,
            recovered_from: None,
            detected: false,
            armed: None,
            recent_text: None,
            blocked_options: None,
            pending_line_id: None,
            pending_ahead: None,
            suspended_presence_id: None,
            suspended_line_id: None,
            suspended_options: None,
        };
        let clamped = if index <= tracker.steps.len() {
            index
        } else {
            0
        };
        tracker.index = tracker.choice_after_save(clamped);
        tracker
    }

    pub fn current(&self) -> Option<&GuideStep> {
        self.steps.get(self.index)
    }

    pub fn complete(&self) -> bool {
        self.index == self.steps.len()
    }

    pub fn start_index(&self) -> usize {
        let mut start = self.index;
        if self.current().is_some_and(|s| s.kind == "choice") {
            while start > 0 && self.steps.get(start - 1).is_some_and(|s| s.kind == "save") {
                start -= 1;
            }
        }
        start
    }

    pub fn save_instructions(&self) -> Vec<String> {
        let start = self.start_index();
        self.steps[start..self.index]
            .iter()
            .map(|s| s.text.clone())
            .collect()
    }

    pub fn choice_after_save(&self, index: usize) -> usize {
        let mut next = index;
        while self.steps.get(next).is_some_and(|s| s.kind == "save") {
            next += 1;
        }
        if self.steps.get(next).is_some_and(|s| s.kind == "choice") {
            next
        } else {
            index
        }
    }

    pub fn remembered_choice(&self) -> bool {
        self.detected && self.armed.is_none()
    }

    pub fn reset_detection(&mut self, preserve_text: bool) {
        if !preserve_text {
            self.recent_text = None;
        }
        self.detected = false;
        self.armed = None;
        self.blocked_options = None;
        self.pending_line_id = None;
        self.pending_ahead = None;
        self.suspended_presence_id = None;
        self.suspended_line_id = None;
        self.suspended_options = None;
    }

    pub fn suspend_detection(&mut self) {
        if let Some(armed) = &self.armed {
            self.suspended_presence_id = armed.presence_id.clone();
            self.suspended_line_id = armed.line_id.clone();
            self.suspended_options = Some(armed.options.clone());
        }
        self.armed = None;
        self.recent_text = None;
        self.pending_line_id = None;
        self.pending_ahead = None;
    }

    pub fn jump(&mut self, raw_index: usize) -> Result<(), String> {
        if raw_index > self.steps.len() {
            return Err("Choose a step within this route.".into());
        }
        let target_index = self.choice_after_save(raw_index);
        let blocked = if target_index > self.index {
            self.armed.as_ref().map(|a| a.options.clone())
        } else {
            None
        };
        self.index = target_index;
        self.tentative = false;
        self.recovered_from = None;
        self.reset_detection(false);
        self.blocked_options = blocked;
        Ok(())
    }

    pub fn next(&mut self) {
        let _ = self.jump((self.index + 1).min(self.steps.len()));
    }

    pub fn back(&mut self) {
        let target = self
            .recovered_from
            .unwrap_or_else(|| self.start_index().saturating_sub(1));
        let _ = self.jump(target);
    }

    fn find_ahead_choice(
        &self,
        lines: &[PreparedLine],
        recent_text: Option<&RecentTextBatch>,
        now: u64,
    ) -> Option<(usize, ChoiceMatch)> {
        let cur_norm = normalize_choice(&self.current()?.text);
        if lines.iter().any(|l| {
            l.normalized == cur_norm || (is_save_control_text(&l.normalized) && l.y3 <= 0.74)
        }) {
            return None;
        }
        let has_saves = !self.save_instructions().is_empty();
        let limit = if has_saves { 1 } else { LOOK_AHEAD_CHOICES };
        let mut idx = self.index + 1;
        let mut candidates = vec![self.current()?.text.as_str()];
        let mut matches = Vec::new();
        for _ in 0..limit {
            if idx >= self.steps.len() {
                break;
            }
            let carries_save = self.steps[idx].kind == "save";
            if carries_save {
                idx = self.choice_after_save(idx);
            }
            if self.steps.get(idx).is_none_or(|s| s.kind != "choice") {
                break;
            }
            candidates.push(self.steps[idx].text.as_str());
            let found = find_choice(lines, &self.steps[idx].text, ChoiceSearch::Ahead)
                .or_else(|| find_hooked_choice(lines, &self.steps[idx].text, recent_text, now));
            if let Some(m) = found {
                matches.push((idx, m));
            }
            if carries_save {
                break;
            }
            idx += 1;
        }
        if matches.len() != 1 {
            return None;
        }
        let (matched_idx, matched) = matches.into_iter().next().unwrap();
        if let Some(hook_txt) = matched.hook_text.as_deref() {
            if candidates.iter().any(|c| {
                *c != self.steps[matched_idx].text && hook_txt.contains(&normalize_choice(c))
            }) {
                return None;
            }
        }
        Some((matched_idx, matched))
    }

    pub fn observe(&mut self, message: &Value, now: u64, auto_advance: bool) {
        let Some(cur) = self.current().cloned() else {
            return;
        };
        if cur.kind != "choice" {
            return;
        }
        let msg_type = message.get("type").and_then(Value::as_str).unwrap_or("");
        if msg_type == "game_text" {
            let Some(text) = message.get("text").and_then(Value::as_str) else {
                self.recent_text = None;
                return;
            };
            if text.len() > 20_000 {
                self.recent_text = None;
                return;
            }
            let options: Vec<String> = text
                .lines()
                .map(normalize_choice)
                .filter(|s| !s.is_empty())
                .collect();
            let joined = options.join("");
            if joined.is_empty() || joined.chars().count() > 300 || options.len() > 6 {
                self.recent_text = None;
            } else {
                let at_ms = match &self.recent_text {
                    Some(prev) if prev.text == joined => prev.at_ms,
                    _ => now,
                };
                self.recent_text = Some(RecentTextBatch {
                    text: joined,
                    options: options.clone(),
                    at_ms,
                });
            }
            if options.is_empty() {
                return;
            }
            if let Some(blocked) = self.blocked_options.as_ref() {
                if options.iter().any(|o| contains_option(blocked, o)) {
                    return;
                }
                self.blocked_options = None;
            }
            let target = normalize_choice(&cur.text);
            let match_count = options.iter().filter(|o| **o == target).count();
            if match_count == 1 && !options.iter().any(|o| is_save_control_text(o)) {
                if !self.armed.as_ref().is_some_and(|a| a.source_is_ocr) {
                    self.armed = Some(ArmedChoice {
                        options,
                        menu: false,
                        source_is_ocr: false,
                        since_ms: now,
                        presence_id: None,
                        line_id: None,
                        stable: false,
                        save_controls: Vec::new(),
                        invalidated_at_ms: None,
                    });
                    self.detected = true;
                }
            } else if self.armed.as_ref().is_some_and(|a| !a.source_is_ocr) {
                self.armed = None;
                self.detected = false;
            }
            return;
        }

        if msg_type == "overlay_clear" {
            self.pending_ahead = None;
            let lid = message.get("line_id").and_then(Value::as_str);
            if lid.is_none_or(str::is_empty) {
                self.reset_detection(true);
            } else {
                self.pending_line_id = lid.map(str::to_string);
                if self.armed.as_ref().is_some_and(|a| a.source_is_ocr) {
                    self.detected = false;
                }
                if let Some(a) = self.armed.as_mut() {
                    if a.invalidated_at_ms.is_none() {
                        a.invalidated_at_ms = Some(now);
                    }
                }
            }
            return;
        }

        if msg_type == "ocr_text_invalidated" {
            let pid = message.get("presence_id").and_then(Value::as_str);
            if let Some(a) = self.armed.as_mut() {
                if a.source_is_ocr && (pid.is_none() || pid == a.presence_id.as_deref()) {
                    self.pending_ahead = None;
                    a.invalidated_at_ms = Some(now);
                    self.detected = false;
                }
            }
            if pid.is_some() && pid == self.suspended_presence_id.as_deref() {
                self.detected = false;
            }
            return;
        }

        let mut revalidated = false;
        let payload_msg = if msg_type == "ocr_text_revalidated" {
            let pid = message.get("presence_id").and_then(Value::as_str);
            let armed_or_susp_pid = self
                .armed
                .as_ref()
                .and_then(|a| a.presence_id.as_deref())
                .or(self.suspended_presence_id.as_deref());
            if let Some(payload) = message.get("payload") {
                if pid.is_some()
                    && pid == armed_or_susp_pid
                    && payload.get("presence_id").and_then(Value::as_str) == pid
                    && payload.get("type").and_then(Value::as_str) == Some("word_coordinates")
                {
                    revalidated = true;
                    payload
                } else {
                    return;
                }
            } else {
                return;
            }
        } else {
            message
        };

        if payload_msg.get("type").and_then(Value::as_str) != Some("word_coordinates")
            || payload_msg.get("supplemental").and_then(Value::as_bool) == Some(true)
        {
            return;
        }
        let Some(data) = payload_msg.get("data").and_then(Value::as_array) else {
            return;
        };
        if data.is_empty() {
            self.pending_ahead = None;
            return;
        }

        let msg_line_id = payload_msg.get("line_id").and_then(Value::as_str);
        let msg_presence_id = payload_msg.get("presence_id").and_then(Value::as_str);
        let is_final = payload_msg.get("is_final").and_then(Value::as_bool) == Some(true);

        if let Some(pending) = self.pending_line_id.as_deref() {
            let stale_line = msg_line_id.is_some_and(|l| l != pending);
            let stale_presence = self.armed.as_ref().and_then(|a| a.line_id.as_deref())
                != Some(pending)
                && msg_presence_id.is_some()
                && msg_presence_id == self.armed.as_ref().and_then(|a| a.presence_id.as_deref());
            if revalidated || stale_line || stale_presence {
                return;
            }
        }

        let lines = prepare_choice_lines(data);
        if let Some(blocked) = self.blocked_options.as_ref() {
            if is_final
                && !lines.is_empty()
                && !lines.iter().any(|line| line.matches_option(blocked))
            {
                self.blocked_options = None;
            } else {
                return;
            }
        }

        let recent_for_final = if is_final && !revalidated {
            self.recent_text.clone()
        } else {
            None
        };

        let mut matched = find_choice(&lines, &cur.text, ChoiceSearch::Current(data));
        if !matched.as_ref().is_some_and(|m| m.menu) {
            if let Some(hooked) =
                find_hooked_choice(&lines, &cur.text, recent_for_final.as_ref(), now)
            {
                matched = Some(hooked);
            }
        }
        if let Some(ref m) = matched {
            if !m.exact
                && self
                    .steps
                    .iter()
                    .any(|s| s.kind == "choice" && normalize_choice(&s.text) == m.observed)
            {
                matched = None;
            }
        }

        let prev_presence = self
            .armed
            .as_ref()
            .and_then(|a| a.presence_id.as_deref())
            .or(self.suspended_presence_id.as_deref())
            .map(str::to_string);
        let prev_line = self
            .armed
            .as_ref()
            .and_then(|a| a.line_id.as_deref())
            .or(self.suspended_line_id.as_deref())
            .map(str::to_string);

        let mut stable_ahead = false;
        if matched.is_none()
            && auto_advance
            && !revalidated
            && prev_presence
                .as_deref()
                .is_none_or(|p| Some(p) != msg_presence_id)
        {
            if let Some((ahead_idx, ahead_match)) =
                self.find_ahead_choice(&lines, recent_for_final.as_ref(), now)
            {
                let cur_or_susp_opts = self
                    .armed
                    .as_ref()
                    .map(|a| &a.options)
                    .or(self.suspended_options.as_ref());
                if cur_or_susp_opts.is_none_or(|opts| !contains_option(opts, &ahead_match.text)) {
                    let adjacent = self.armed.as_ref().is_some_and(|a| {
                        a.source_is_ocr
                            && a.stable
                            && ahead_idx == self.choice_after_save(self.index + 1)
                            && a.invalidated_at_ms
                                .is_none_or(|inv| now.saturating_sub(inv) <= 15_000)
                    });
                    let mut sorted_opts = ahead_match.options.clone();
                    sorted_opts.sort();
                    let sig = format!("{ahead_idx}|{}", sorted_opts.join("\x1f"));
                    if adjacent {
                        match &self.pending_ahead {
                            Some((prev_sig, since)) if *prev_sig == sig => {
                                stable_ahead = now.saturating_sub(*since) >= 200;
                            }
                            _ => {
                                self.pending_ahead = Some((sig, now));
                            }
                        }
                    } else {
                        self.pending_ahead = None;
                    }
                    if stable_ahead
                        || (is_final && prev_line.as_deref().is_none_or(|l| Some(l) != msg_line_id))
                    {
                        let from = self.index;
                        let _ = self.jump(ahead_idx);
                        self.blocked_options = None;
                        self.tentative = true;
                        self.recovered_from = Some(from);
                        matched = Some(ahead_match);
                    }
                }
            } else {
                self.pending_ahead = None;
            }
        } else {
            self.pending_ahead = None;
        }

        if let Some(mut m) = matched {
            self.pending_ahead = None;
            let save_controls: Vec<(String, f64, f64)> = lines
                .iter()
                .filter(|l| is_save_control_text(&l.normalized))
                .map(|l| (l.normalized.clone(), l.center, l.y1))
                .collect();
            let prev = self.armed.as_ref();
            // A partial rescan of a confirmed menu still belongs to that menu.
            if let Some(confirmed) = prev.filter(|p| p.stable && !m.menu) {
                m.menu = true;
                m.options.clone_from(&confirmed.options);
            }
            let since_ms = match prev {
                Some(p) if p.source_is_ocr && p.menu == m.menu => p.since_ms,
                _ => now,
            };
            let stable = stable_ahead
                || prev.is_some_and(|p| p.stable)
                || (m.menu
                    && (is_final
                        || prev.is_some_and(|p| p.menu && now.saturating_sub(p.since_ms) >= 200)));
            self.armed = Some(ArmedChoice {
                options: m.options,
                menu: m.menu,
                source_is_ocr: true,
                since_ms,
                presence_id: msg_presence_id.map(str::to_string),
                line_id: msg_line_id.map(str::to_string),
                stable,
                save_controls,
                invalidated_at_ms: None,
            });
            self.detected = true;
            if is_final {
                self.pending_line_id = None;
            }
            self.suspended_presence_id = None;
            self.suspended_line_id = None;
            self.suspended_options = None;
            return;
        }

        let Some(armed) = self.armed.clone() else {
            if is_final && !lines.is_empty() {
                let susp = self.suspended_options.clone();
                self.reset_detection(false);
                if let Some(opts) = susp {
                    if lines.iter().any(|line| line.matches_option(&opts)) {
                        self.suspended_options = Some(opts);
                    }
                }
            }
            return;
        };

        if !armed.source_is_ocr {
            return;
        }
        if armed
            .invalidated_at_ms
            .is_some_and(|inv| now.saturating_sub(inv) > 15_000)
        {
            self.reset_detection(false);
            return;
        }
        if lines.is_empty() || lines.iter().any(|line| line.matches_option(&armed.options)) {
            return;
        }
        if armed.presence_id.is_some() && armed.presence_id.as_deref() == msg_presence_id {
            return;
        }
        if armed.line_id.is_some() && armed.line_id.as_deref() == msg_line_id {
            return;
        }

        if is_final
            && lines.iter().any(|l| {
                is_save_control_text(&l.normalized)
                    && !armed.save_controls.iter().any(|(t, c, y)| {
                        *t == l.normalized && (c - l.center).abs() < 0.03 && (y - l.y1).abs() < 0.03
                    })
            })
        {
            self.reset_detection(false);
            return;
        }

        if is_final && !armed.stable {
            self.reset_detection(false);
            return;
        }
        let fresh_line = armed.line_id.is_some()
            && msg_line_id.is_some()
            && armed.line_id.as_deref() != msg_line_id;
        if !is_final || !armed.stable || (!fresh_line && now.saturating_sub(armed.since_ms) < 900) {
            return;
        }

        self.reset_detection(false);
        if auto_advance {
            self.next();
            self.tentative = true;
            self.observe(message, now, false);
        }
    }
}

// ---------- VN-Guide Controller & HUD Geometry ----------

// Network checks run outside the controller lock so text observation, hotkeys,
// source changes and timed notices remain responsive while a source is offline.
pub struct GuideUpdateCheck {
    generation: u64,
    http: reqwest::Client,
    guide_url: String,
    route_url: String,
    cached: Option<(GuideManifest, String)>,
}

pub struct GuideUpdateResult {
    generation: u64,
    result: Result<(GuideManifest, String), String>,
}

impl GuideUpdateCheck {
    pub async fn run(self) -> GuideUpdateResult {
        let result = if let Some(cached) = self.cached {
            Ok(cached)
        } else {
            async {
                let (guide_json, route_json) = tokio::try_join!(
                    fetch_guide_json(&self.http, &self.guide_url),
                    fetch_guide_json(&self.http, &self.route_url)
                )?;
                Ok((
                    validate_guide(&guide_json)?,
                    fingerprint_steps(&validate_route(&route_json)?),
                ))
            }
            .await
        };
        GuideUpdateResult {
            generation: self.generation,
            result,
        }
    }
}

#[derive(Clone, Debug, Default)]
struct LastActivity {
    text: String,
    line_id: Option<String>,
    presence_id: Option<String>,
}

pub struct VnGuideController {
    store: GuideStore,
    enabled: bool,
    url: String,
    route_pref: String,
    mode: String,
    display_style: String,
    auto_advance: bool,
    click_through_on_choice: bool,
    next_hotkey: String,
    source_url: String,
    source_key: String,
    loaded: Option<LoadedGuide>,
    tracker: Option<GuideTracker>,
    loading: bool,
    error: String,
    available: bool,
    scene: Option<String>,
    dismissed: bool,
    dismissed_at_choice: bool,
    peek: bool,
    peek_lines: u32,
    save_notice_until: Option<u64>,
    logged_choice: Option<String>,
    logged_until: u64,
    suspended_at: Option<u64>,
    last_activity: Option<LastActivity>,
    checking_updates: bool,
    update_available: bool,
    update_error: String,
    last_checked_at: Option<u64>,
    next_update_check_at: u64,
    epoch: u64,
    pub last_visible: bool,
}

impl VnGuideController {
    pub fn new(http: reqwest::Client, data_dir: &Path) -> Self {
        Self {
            store: GuideStore::new(http, data_dir),
            enabled: false,
            url: String::new(),
            route_pref: String::new(),
            mode: "auto".into(),
            display_style: "card".into(),
            auto_advance: true,
            click_through_on_choice: true,
            next_hotkey: String::new(),
            source_url: String::new(),
            source_key: String::new(),
            loaded: None,
            tracker: None,
            loading: false,
            error: String::new(),
            available: false,
            scene: None,
            dismissed: false,
            dismissed_at_choice: false,
            peek: false,
            peek_lines: 0,
            save_notice_until: None,
            logged_choice: None,
            logged_until: 0,
            suspended_at: None,
            last_activity: None,
            checking_updates: false,
            update_available: false,
            update_error: String::new(),
            last_checked_at: None,
            next_update_check_at: 0,
            epoch: 0,
            last_visible: false,
        }
    }

    fn reset_visibility(&mut self) {
        self.dismissed = false;
        self.dismissed_at_choice = false;
        self.peek = false;
        self.peek_lines = 0;
    }

    fn clear_logged_choice(&mut self) {
        self.logged_choice = None;
        self.logged_until = 0;
    }

    fn enter_step(&mut self) {
        self.clear_logged_choice();
        self.dismissed = false;
        self.dismissed_at_choice = false;
        let has_saves = self
            .tracker
            .as_ref()
            .is_some_and(|t| !t.save_instructions().is_empty());
        self.save_notice_until = if has_saves && !self.available {
            // Start the brief notice only when there is a capture to show it on.
            None
        } else {
            Some(if has_saves { now_ms() + 8000 } else { 0 })
        };
    }

    fn log_choice(&mut self, previous_step: Option<&GuideStep>) {
        if let Some(step) = previous_step {
            if step.kind == "choice" {
                self.logged_choice = Some(step.text.clone());
                self.logged_until = now_ms() + 4000;
                self.save_notice_until = Some(0);
                self.peek_lines = 0;
            }
        }
    }

    pub fn persist_progress(&mut self) {
        if let (Some(loaded), Some(tracker)) = (&self.loaded, &self.tracker) {
            if let Err(error) =
                self.store
                    .save_progress(&loaded.key, tracker.index, &loaded.fingerprint)
            {
                self.error = error;
            }
        }
    }

    fn next_route(&self) -> Option<GuideRouteMeta> {
        if !self.tracker.as_ref().is_some_and(GuideTracker::complete) {
            return None;
        }
        let loaded = self.loaded.as_ref()?;
        let pos = loaded
            .guide
            .routes
            .iter()
            .position(|r| r.id == loaded.route.id)?;
        loaded.guide.routes.get(pos + 1).cloned()
    }

    pub fn snapshot(&self) -> Value {
        let now = now_ms();
        // Keep expired confirmations in auto/hotkey mode: Next must reveal the
        // pending instruction, and a lingering preview must not expose it early.
        let choice_logged = self.logged_choice.as_ref();
        let save_instructions = self
            .tracker
            .as_ref()
            .map(GuideTracker::save_instructions)
            .unwrap_or_default();
        let detected = self.tracker.as_ref().is_some_and(|t| t.detected);
        let remembered = self
            .tracker
            .as_ref()
            .is_some_and(GuideTracker::remembered_choice);
        let save_notice = choice_logged.is_none()
            && self.mode == "auto"
            && !save_instructions.is_empty()
            && !detected
            && !remembered
            && !self.peek
            && self.save_notice_until.is_some_and(|u| now < u);
        let automatic = self.mode == "always"
            || self.mode == "auto"
                && self.tracker.as_ref().is_some_and(|t| {
                    t.detected || t.current().is_none_or(|s| s.kind != "choice") || save_notice
                });
        let showing = if choice_logged.is_some() {
            self.mode == "always" || (self.mode == "auto" || self.peek) && now < self.logged_until
        } else {
            self.peek || automatic
        };
        let visible =
            self.available && self.enabled && self.tracker.is_some() && !self.dismissed && showing;

        let routes: Vec<Value> = self
            .loaded
            .as_ref()
            .map(|l| {
                l.guide
                    .routes
                    .iter()
                    .map(|r| json!({ "id": r.id, "title": r.title, "reviewed": r.reviewed }))
                    .collect()
            })
            .unwrap_or_default();

        let next_route = self
            .next_route()
            .map(|r| json!({ "id": r.id, "title": r.title }));

        let cur = self.tracker.as_ref().and_then(|t| t.current());

        json!({
            "enabled": self.enabled,
            "loading": self.loading,
            "error": self.error,
            "mode": self.mode,
            "displayStyle": self.display_style,
            "sourceUrl": self.source_url,
            "checkingUpdates": self.checking_updates,
            "updateAvailable": self.update_available,
            "updateError": self.update_error,
            "lastCheckedAt": self.last_checked_at,
            "visible": visible,
            "loggedChoice": choice_logged,
            "saveNotice": save_notice,
            "saveInstructions": save_instructions,
            "title": self.loaded.as_ref().map(|l| l.guide.title.as_str()).unwrap_or(""),
            "target": self.loaded.as_ref().map(|l| l.guide.target.as_str()).unwrap_or(""),
            "routes": routes,
            "routeId": self.loaded.as_ref().map(|l| l.route.id.as_str()).unwrap_or(""),
            "routeTitle": self.loaded.as_ref().map(|l| l.route.title.as_str()).unwrap_or(""),
            "reviewed": self.loaded.as_ref().is_some_and(|l| l.route.reviewed),
            "changed": self.loaded.as_ref().is_some_and(|l| l.changed),
            "index": self.tracker.as_ref().map(|t| t.index).unwrap_or(0),
            "startIndex": self.tracker.as_ref().map(GuideTracker::start_index).unwrap_or(0),
            "total": self.tracker.as_ref().map(|t| t.steps.len()).unwrap_or(0),
            "kind": cur.map(|c| c.kind.as_str()).unwrap_or(""),
            "text": cur.map(|c| c.text.as_str()).unwrap_or(""),
            "complete": self.tracker.as_ref().is_some_and(GuideTracker::complete),
            "detected": detected && !remembered,
            "choiceClickThrough": detected && !remembered && self.available && !self.loading && self.click_through_on_choice,
            "rememberedChoice": remembered,
            "tentative": self.tracker.as_ref().is_some_and(|t| t.tentative),
            "recoveredFrom": self.tracker.as_ref().and_then(|t| t.recovered_from),
            "nextRoute": next_route,
            "nextHotkey": self.next_hotkey,
        })
    }

    pub async fn configure(&mut self, settings: &Map<String, Value>, refresh: bool) -> Value {
        let next_mode = settings
            .get("vnGuideMode")
            .and_then(Value::as_str)
            .filter(|mode| matches!(*mode, "auto" | "always" | "hotkey"))
            .unwrap_or("auto")
            .to_string();
        if next_mode != self.mode {
            self.reset_visibility();
        }
        self.enabled = settings.get("vnGuideEnabled").and_then(Value::as_bool) == Some(true);
        self.url = settings
            .get("vnGuideUrl")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        self.route_pref = settings
            .get("vnGuideRoute")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        self.mode = next_mode;
        self.display_style = settings
            .get("vnGuideDisplayStyle")
            .and_then(Value::as_str)
            .filter(|style| matches!(*style, "card" | "text"))
            .unwrap_or("card")
            .to_string();
        self.auto_advance =
            settings.get("vnGuideAutoAdvance").and_then(Value::as_bool) != Some(false);
        self.click_through_on_choice =
            settings.get("vnGuideClickThroughOnChoice").and_then(Value::as_bool) != Some(false);
        self.next_hotkey = settings
            .get("vnGuideNextHotkey")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        self.source_url = parse_guide_url(&self.url)
            .map(|p| p.base_url)
            .unwrap_or_default();

        let key = format!("{}|{}|{}", self.enabled, self.url, self.route_pref);
        if !refresh && key == self.source_key {
            return self.snapshot();
        }

        self.source_key = key;
        self.epoch += 1;
        self.next_update_check_at = 0;
        let gen = self.epoch;
        self.checking_updates = false;
        if !refresh {
            self.update_available = false;
            self.last_checked_at = None;
            self.loaded = None;
            self.tracker = None;
        }
        self.update_error.clear();
        self.error.clear();
        self.reset_visibility();
        self.clear_logged_choice();
        self.last_activity = None;
        self.loading = self.enabled && !self.url.trim().is_empty();

        if !self.loading {
            return self.snapshot();
        }

        let url = self.url.clone();
        let route_opt = (!self.route_pref.is_empty()).then(|| self.route_pref.clone());
        match self.store.load(&url, route_opt.as_deref(), refresh).await {
            Ok(loaded) => {
                if self.epoch == gen {
                    let tracker = GuideTracker::new(loaded.steps.clone(), loaded.index);
                    self.loaded = Some(loaded);
                    self.tracker = Some(tracker);
                    self.update_available = false;
                    self.enter_step();
                    self.persist_progress();
                }
            }
            Err(e) => {
                if self.epoch == gen {
                    self.error = if e.is_empty() {
                        "Could not load VN-Guide.".into()
                    } else {
                        e
                    };
                }
            }
        }
        self.loading = false;
        self.snapshot()
    }

    pub async fn check_for_updates(&mut self, force: bool) -> Value {
        if let Some(check) = self.begin_update_check(force) {
            self.finish_update_check(check.run().await);
        }
        self.snapshot()
    }

    pub fn begin_update_check(&mut self, force: bool) -> Option<GuideUpdateCheck> {
        if self.loading || !self.enabled || self.checking_updates {
            return None;
        }
        let loaded = self.loaded.as_ref()?;
        self.checking_updates = true;
        self.update_error.clear();
        self.next_update_check_at = now_ms() + UPDATE_INTERVAL_MS;
        Some(self.store.prepare_update_check(loaded, force, self.epoch))
    }

    pub fn finish_update_check(&mut self, update: GuideUpdateResult) -> bool {
        if self.epoch != update.generation {
            return false;
        }
        let Some(loaded) = self.loaded.as_ref() else {
            return false;
        };
        match update.result {
            Ok((latest_guide, latest_fp)) => {
                self.update_available =
                    latest_fp != loaded.fingerprint || latest_guide != loaded.guide;
                self.last_checked_at = Some(now_ms());
            }
            Err(e) => {
                self.update_error = if e.is_empty() {
                    "Could not check VN-Guide for updates.".into()
                } else {
                    e
                };
            }
        }
        self.checking_updates = false;
        self.next_update_check_at = now_ms() + UPDATE_INTERVAL_MS;
        true
    }

    pub async fn continue_route(&mut self) -> (Value, Option<String>) {
        let Some(next_r) = self.next_route() else {
            return (self.snapshot(), None);
        };
        if !self.enabled {
            return (self.snapshot(), None);
        }
        self.epoch += 1;
        self.next_update_check_at = 0;
        let gen = self.epoch;
        self.loading = true;
        self.checking_updates = false;
        self.error.clear();
        let mut switched_route = None;
        match self
            .store
            .load(&self.url.clone(), Some(&next_r.id), false)
            .await
        {
            Ok(loaded) => {
                if self.epoch == gen {
                    let route_id = loaded.route.id.clone();
                    switched_route = Some(route_id.clone());
                    self.route_pref = route_id.clone();
                    self.source_key = format!("{}|{}|{}", self.enabled, self.url, route_id);
                    let tracker = GuideTracker::new(loaded.steps.clone(), loaded.index);
                    self.loaded = Some(loaded);
                    self.tracker = Some(tracker);
                    self.update_available = false;
                    self.update_error.clear();
                    self.last_checked_at = None;
                    self.reset_visibility();
                    self.last_activity = None;
                    self.enter_step();
                    self.persist_progress();
                }
            }
            Err(e) => {
                if self.epoch == gen {
                    self.error = if e.is_empty() {
                        "Could not load the next route. Try again.".into()
                    } else {
                        e
                    };
                }
            }
        }
        self.loading = false;
        (self.snapshot(), switched_route)
    }

    /// Only capture-status scene names identify a guide session. Window titles
    /// can differ from the scene or change while the same game is still running.
    pub fn set_available(&mut self, value: bool, current_scene: Option<&str>) -> bool {
        let next = value;
        let changed_scene = current_scene
            .zip(self.scene.as_deref())
            .is_some_and(|(cur, prev)| cur != prev);
        if let Some(scene) = current_scene {
            self.scene = Some(scene.to_string());
        }
        let now = now_ms();
        if !next && self.available {
            self.suspended_at = Some(now);
            if let Some(t) = self.tracker.as_mut() {
                t.suspend_detection();
            }
        }
        if next && !self.available {
            if let Some(susp) = self.suspended_at.take() {
                let hidden_for = now.saturating_sub(susp);
                if let Some(snu) = self.save_notice_until.as_mut() {
                    if *snu > susp {
                        *snu += hidden_for;
                    }
                }
                if self.logged_until > susp {
                    self.logged_until += hidden_for;
                }
            }
        }
        if changed_scene {
            if let Some(t) = self.tracker.as_mut() {
                t.reset_detection(false);
            }
            self.reset_visibility();
            self.clear_logged_choice();
            self.last_activity = None;
        }
        if next && self.save_notice_until.is_none() {
            self.save_notice_until = Some(now + 8000);
        }
        let show_next_step = next
            && self.mode == "always"
            && self.logged_choice.is_some()
            && now >= self.logged_until;
        if show_next_step {
            self.clear_logged_choice();
        }
        let prev_avail = self.available;
        self.available = next;
        let vis = self
            .snapshot()
            .get("visible")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let dirty =
            next != prev_avail || changed_scene || show_next_step || vis != self.last_visible;
        self.last_visible = vis;
        dirty
    }

    pub fn is_available(&self) -> bool {
        self.available
    }

    pub fn needs_periodic_update_check(&self) -> bool {
        self.enabled
            && !self.loading
            && self.loaded.is_some()
            && !self.checking_updates
            && now_ms() >= self.next_update_check_at
    }

    pub fn observe(&mut self, message: &Value) -> bool {
        if !self.enabled || self.tracker.is_none() {
            return false;
        }
        if message.get("type").and_then(Value::as_str) == Some("window_state") {
            // The host handles availability; `game` here is a window title,
            // not the OBS scene used to select and reset the guide.
            return false;
        }
        if !self.available {
            return false;
        }
        let now = now_ms();
        let auto_adv = self.auto_advance;
        let (prev_state, next_state, step_changed, prev_step, detected_now, choice_observed) = {
            let t = self.tracker.as_mut().unwrap();
            let before = (t.index, t.detected, t.remembered_choice(), t.tentative);
            let prev_idx = t.index;
            let prev_step = t.current().cloned();
            let prev_armed_ptr = t.armed.as_ref().map(|a| (a.since_ms, a.options.clone()));
            t.observe(message, now, auto_adv);
            let after = (t.index, t.detected, t.remembered_choice(), t.tentative);
            let cur_armed_ptr = t.armed.as_ref().map(|a| (a.since_ms, a.options.clone()));
            let choice_observed = t.detected && prev_armed_ptr != cur_armed_ptr;
            (
                before,
                after,
                t.index != prev_idx,
                prev_step,
                t.detected,
                choice_observed,
            )
        };

        if step_changed {
            self.enter_step();
            if !detected_now {
                self.log_choice(prev_step.as_ref());
            }
            self.persist_progress();
        }
        if detected_now {
            self.save_notice_until = Some(0);
            self.clear_logged_choice();
        }
        let msg_type = message.get("type").and_then(Value::as_str).unwrap_or("");
        if choice_observed
            && (msg_type == "word_coordinates" || msg_type == "game_text")
            && !self.dismissed_at_choice
        {
            self.dismissed = false;
        }

        self.observe_activity(message, choice_observed);
        let vis = self
            .snapshot()
            .get("visible")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let changed = prev_state != next_state || vis != self.last_visible;
        self.last_visible = vis;
        changed
    }

    fn observe_activity(&mut self, message: &Value, choice_observed: bool) {
        let msg_type = message.get("type").and_then(Value::as_str).unwrap_or("");
        let (text, line_id, presence_id) = if msg_type == "game_text" {
            let t = normalize_choice(message.get("text").and_then(Value::as_str).unwrap_or(""));
            (t, None, None)
        } else if msg_type == "word_coordinates"
            && message.get("is_final").and_then(Value::as_bool) == Some(true)
            && message.get("supplemental").and_then(Value::as_bool) != Some(true)
        {
            let latest = message
                .get("latest_text")
                .and_then(Value::as_str)
                .map(normalize_choice)
                .unwrap_or_else(|| {
                    let joined = message
                        .get("data")
                        .and_then(Value::as_array)
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.get("text").and_then(Value::as_str))
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .unwrap_or_default();
                    normalize_choice(&joined)
                });
            (
                latest,
                message
                    .get("line_id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                message
                    .get("presence_id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            )
        } else {
            return;
        };
        if text.is_empty() {
            return;
        }
        let repeated = self.last_activity.as_ref().is_some_and(|prev| {
            prev.text == text
                || line_id.is_some() && line_id == prev.line_id
                || presence_id.is_some() && presence_id == prev.presence_id
                || ((line_id.is_none() || prev.line_id.is_none())
                    && (text.starts_with(&prev.text) || prev.text.starts_with(&text)))
        });
        let next_lid = line_id.or_else(|| {
            repeated
                .then(|| self.last_activity.as_ref()?.line_id.clone())
                .flatten()
        });
        let next_pid = presence_id.or_else(|| {
            repeated
                .then(|| self.last_activity.as_ref()?.presence_id.clone())
                .flatten()
        });
        self.last_activity = Some(LastActivity {
            text: text.clone(),
            line_id: next_lid,
            presence_id: next_pid,
        });
        if repeated
            || self.logged_choice.is_some()
            || !self.peek
            || self.mode == "always"
            || choice_observed
        {
            return;
        }
        if msg_type == "game_text" {
            if let Some(t) = self.tracker.as_ref() {
                if let Some(a) = &t.armed {
                    if a.options.contains(&text) {
                        return;
                    }
                } else if t
                    .current()
                    .is_some_and(|c| normalize_choice(&c.text) == text)
                {
                    return;
                }
            }
        }
        self.peek_lines += 1;
        if self.peek_lines >= 2 {
            self.peek = false;
            self.peek_lines = 0;
            self.dismissed = true;
            self.dismissed_at_choice = false;
        }
    }

    fn reveal_step(&mut self) {
        self.reset_visibility();
        self.clear_logged_choice();
        self.peek = true;
    }

    fn dismiss(&mut self, hold_choice: bool) {
        self.peek = false;
        self.peek_lines = 0;
        self.dismissed = true;
        self.dismissed_at_choice = hold_choice
            && self
                .tracker
                .as_ref()
                .is_some_and(|t| t.detected || t.armed.is_some());
    }

    pub async fn command(
        &mut self,
        action: &str,
        value: Option<&Value>,
        current_settings: &Map<String, Value>,
    ) -> (Value, Option<String>) {
        if action == "check-updates" {
            return (self.check_for_updates(true).await, None);
        }
        if action == "refresh" {
            return (self.configure(current_settings, true).await, None);
        }
        if self.loading || self.tracker.is_none() {
            return (self.snapshot(), None);
        }
        if action == "next" && self.logged_choice.is_some() {
            self.reveal_step();
            return (self.snapshot(), None);
        }
        if action == "next" && self.tracker.as_ref().is_some_and(GuideTracker::complete) {
            return self.continue_route().await;
        }
        match action {
            "toggle" => {
                let vis = self
                    .snapshot()
                    .get("visible")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if vis {
                    self.dismiss(true);
                } else {
                    self.reveal_step();
                }
            }
            "hide" => {
                let sn = self
                    .snapshot()
                    .get("saveNotice")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if sn {
                    self.save_notice_until = Some(0);
                } else {
                    self.dismiss(true);
                }
            }
            "next" | "back" | "jump" => {
                if let Some(t) = self.tracker.as_mut() {
                    if action == "jump" {
                        let Some(idx) = value
                            .and_then(Value::as_u64)
                            .and_then(|i| usize::try_from(i).ok())
                        else {
                            self.error = "Choose a step within this route.".into();
                            return (self.snapshot(), None);
                        };
                        if let Err(e) = t.jump(idx) {
                            self.error = e;
                            return (self.snapshot(), None);
                        }
                    } else if action == "next" {
                        t.next();
                    } else {
                        t.back();
                    }
                }
                self.error.clear();
                self.enter_step();
                if action != "jump" {
                    self.reveal_step();
                }
                if let Some(l) = self.loaded.as_mut() {
                    l.changed = false;
                }
                self.persist_progress();
            }
            _ => {}
        }
        let snap = self.snapshot();
        self.last_visible = snap
            .get("visible")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        (snap, None)
    }
}

/// Compute exact HUD bounds from a target display work area (physical px or logical px matching display coords).
pub fn compute_vn_guide_hud_bounds(
    area_x: i32,
    area_y: i32,
    area_w: i32,
    area_h: i32,
    state: &Value,
) -> (i32, i32, i32, i32) {
    let logged = state.get("loggedChoice").is_some_and(Value::is_string);
    let plain = state.get("displayStyle").and_then(Value::as_str) == Some("text") && !logged;
    let save_notice = state.get("saveNotice").and_then(Value::as_bool) == Some(true);
    let has_saves = state
        .get("saveInstructions")
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty());

    let height = if logged {
        96
    } else if plain {
        300.min((area_h - 36).max(96))
    } else if save_notice {
        176
    } else if has_saves {
        278
    } else {
        246
    };
    let width = (if plain { 600 } else { 400 }).min((area_w - 36).max(200));
    (area_x + 18, area_y + 18, width, height)
}

/// Validate a URL for the isolated `gsm-custom-page` overlay window.
pub fn normalize_custom_page_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = url::Url::parse(trimmed).ok()?;
    if matches!(parsed.scheme(), "http" | "https") {
        Some(parsed.to_string())
    } else {
        None
    }
}

#[cfg(test)]
#[path = "overlay_vn_guide_tests.rs"]
mod controller_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn regression_vn_guide_custom_page_and_fork_catalogue() {
        let source = parse_guide_url("https://raw.githubusercontent.com/bpwhelan/VN-Guide/codex/muv-luv-extra/muv-luv-extra/index.html#route=sumika&step=2").unwrap();
        assert_eq!(source.base_url, "https://raw.githubusercontent.com/bpwhelan/VN-Guide/codex/muv-luv-extra/muv-luv-extra/");
        assert_eq!(source.route_id, "sumika");
        assert_eq!(source.step, Some(2));
        let catalogue = parse_catalogue_source(Some(
            "https://github.com/bpwhelan/VN-Guide/tree/codex/muv-luv-extra",
        ))
        .unwrap();
        assert_eq!(
            catalogue.base_url,
            "https://raw.githubusercontent.com/bpwhelan/VN-Guide/codex/muv-luv-extra/"
        );
        assert_eq!(catalogue.tree_url.as_deref(), Some("https://api.github.com/repos/bpwhelan/VN-Guide/git/trees/codex%2Fmuv-luv-extra?recursive=1"));
    }

    #[test]
    fn accepts_upstream_japanese_route_format_and_save_load_instructions() {
        let steps = validate_route(&json!([
            {"simpleJp":"セーブ１"},
            {"simpleJp":"公園に行く"},
            {"simpleJp":"セーブ１をロード"},
            {"simpleJp":"続きから", "isLoad":true}
        ]))
        .unwrap();
        assert_eq!(
            steps.iter().map(|s| s.kind.as_str()).collect::<Vec<_>>(),
            ["save", "choice", "load", "load"]
        );
        assert!(validate_route(&json!([])).is_err());
    }

    #[tokio::test]
    async fn local_guide_import_restores_legacy_progress_and_url_route() {
        let dir = tempfile::tempdir().unwrap();
        let game = dir.path().join("game");
        fs::create_dir(&game).unwrap();
        fs::write(game.join("guide.json"), json!({"title":"Test","routes":[
            {"id":"first","title":"First","reviewed":true},{"id":"second","title":"Second","reviewed":true}
        ]}).to_string()).unwrap();
        let route = json!([{"simpleJp":"公園に行く"},{"simpleJp":"図書館に行く"}]);
        fs::write(game.join("route_second.json"), route.to_string()).unwrap();
        let source = url::Url::from_directory_path(&game).unwrap().to_string();
        let steps = validate_route(&route).unwrap();
        assert_eq!(
            fingerprint_steps(&steps),
            "be93e7f082aa31e585d6190bf08cf287ff308d4fe08ec3d8c56169a5bf1df565"
        );
        fs::write(
            dir.path().join("vn-guide-progress.json"),
            json!({format!("{source}/second"):{"index":1,"fingerprint":fingerprint_steps(&steps)}})
                .to_string(),
        )
        .unwrap();
        let mut store = GuideStore::new(reqwest::Client::new(), dir.path());
        let loaded = store
            .load(
                &format!("{source}index.html#route=second&step=0"),
                None,
                false,
            )
            .await
            .unwrap();
        assert_eq!(loaded.route.id, "second");
        assert_eq!(
            loaded.index, 1,
            "saved progress takes priority over the imported link"
        );
        assert!(!loaded.changed);
        assert!(store.load(&source, Some("missing"), false).await.is_err());
    }

    #[tokio::test]
    #[ignore = "requires the live GitHub guide catalogue"]
    async fn live_fork_catalogue_and_muv_luv_routes() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = GuideStore::new(reqwest::Client::new(), dir.path());
        let catalogue = store
            .list_catalogue(
                Some("https://github.com/bpwhelan/VN-Guide/tree/codex/muv-luv-extra"),
                true,
            )
            .await
            .unwrap();
        let entry = catalogue
            .guides
            .iter()
            .find(|g| g.slug == "muv-luv-extra")
            .expect("Muv-Luv is listed in the selected fork");
        assert!(entry.url.contains("bpwhelan/VN-Guide/codex/muv-luv-extra/"));
        let loaded = store.load(&entry.url, None, true).await.unwrap();
        assert_eq!(loaded.guide.title, "Muv-Luv EXTRA");
        assert!(!loaded.steps.is_empty());
        for route in &loaded.guide.routes {
            let loaded = store
                .load(&entry.url, Some(&route.id), false)
                .await
                .unwrap();
            assert!(!loaded.steps.is_empty());
        }
    }

    #[test]
    fn normalizes_choices_keeping_long_vowel_mark() {
        assert_eq!(normalize_choice("1. あー、それね！"), "あーそれね");
        assert_eq!(normalize_choice("▶ ２．テスト（ABC）"), "テストABC");
        assert_eq!(normalize_choice("ﾃｽﾄﾄﾞﾗｲﾌﾞ"), "テストドライブ");
        assert_eq!(normalize_choice("ﾊﾟﾋﾟﾌﾟﾍﾟﾎﾟ"), "パピプペポ");
    }

    #[test]
    fn parses_github_pages_tree_and_raw_urls() {
        let p = parse_guide_url("https://kanjieater.github.io/VN-Guide/clannad/").unwrap();
        assert_eq!(
            p.base_url,
            "https://raw.githubusercontent.com/kanjieater/VN-Guide/main/clannad/"
        );
        assert_eq!(p.progress_id, "clannad");

        let g = parse_guide_url("https://github.com/user/repo/tree/dev/my_vn").unwrap();
        assert_eq!(
            g.base_url,
            "https://raw.githubusercontent.com/user/repo/dev/my_vn/"
        );
        assert_eq!(g.progress_id, g.base_url);

        assert!(parse_guide_url("https://evil.example.com/guide").is_err());
    }

    #[test]
    fn custom_page_allows_only_http_https() {
        assert_eq!(
            normalize_custom_page_url("https://vndb.org/v11").as_deref(),
            Some("https://vndb.org/v11")
        );
        assert_eq!(normalize_custom_page_url("javascript:alert(1)"), None);
        assert_eq!(
            normalize_custom_page_url("file:///c:/windows/win.ini"),
            None
        );
    }

    #[test]
    fn tracker_detects_choice_menu_and_auto_advances() {
        let steps = vec![
            GuideStep {
                text: "公園に行く".into(),
                kind: "choice".into(),
            },
            GuideStep {
                text: "図書館に行く".into(),
                kind: "choice".into(),
            },
        ];
        let mut tracker = GuideTracker::new(steps, 0);

        let choice_frame = json!({
            "type": "word_coordinates",
            "is_final": true,
            "line_id": "L1",
            "presence_id": "P1",
            "data": [
                {
                    "text": "公園に行く",
                    "bounding_rect": { "x1": 0.4, "y1": 0.40, "x3": 0.6, "y3": 0.44 }
                },
                {
                    "text": "家に帰る",
                    "bounding_rect": { "x1": 0.4, "y1": 0.48, "x3": 0.6, "y3": 0.52 }
                }
            ]
        });
        tracker.observe(&choice_frame, 1000, true);
        assert!(tracker.detected);
        assert_eq!(tracker.index, 0);

        let dialogue_frame = json!({
            "type": "word_coordinates",
            "is_final": true,
            "line_id": "L2",
            "presence_id": "P2",
            "data": [
                {
                    "text": "公園に着いた。",
                    "bounding_rect": { "x1": 0.2, "y1": 0.80, "x3": 0.5, "y3": 0.84 }
                }
            ]
        });
        tracker.observe(&dialogue_frame, 1500, true);
        assert_eq!(tracker.index, 1);
        assert!(tracker.tentative);
    }

    #[test]
    fn detects_numbered_muv_luv_menu_when_ocr_drops_the_periods() {
        // MeikiOCR sees separated digits at the start of all three rows.
        let row = |text, y1, y3, words: &[(&str, f64, f64)]| {
            json!({
                "text": text,
                "is_vertical": false,
                "bounding_rect": {"x1": words[0].1, "y1": y1, "x3": words.last().unwrap().2, "y3": y3},
                "words": words.iter().map(|(text, x1, x3)| json!({
                    "text": text, "bounding_rect": {"x1": x1, "y1": y1, "x3": x3, "y3": y3}
                })).collect::<Vec<_>>()
            })
        };
        let rows = [
            row(
                "1ぬいぐるみ",
                0.608,
                0.626,
                &[
                    ("1", 0.489, 0.495),
                    ("ぬ", 0.502, 0.512),
                    ("い", 0.512, 0.522),
                    ("ぐ", 0.522, 0.530),
                    ("る", 0.530, 0.539),
                    ("み", 0.540, 0.549),
                ],
            ),
            row(
                "2本",
                0.630,
                0.647,
                &[("2", 0.506, 0.514), ("本", 0.521, 0.531)],
            ),
            row(
                "3ゲーム",
                0.651,
                0.668,
                &[
                    ("3", 0.497, 0.503),
                    ("ゲ", 0.511, 0.520),
                    ("ー", 0.521, 0.530),
                    ("ム", 0.530, 0.540),
                ],
            ),
        ];
        let frame = |data: &[Value], presence| {
            json!({"type":"word_coordinates", "native_layout":true, "is_final":true,
                "presence_id":presence, "data":data})
        };
        let steps = validate_route(&json!([{"simpleJp":"ゲーム"}, {"simpleJp":"続ける"}])).unwrap();
        let mut tracker = GuideTracker::new(steps, 0);
        tracker.observe(&frame(&rows[2..], "single"), 500, true);
        assert!(tracker.detected);
        assert!(!tracker.armed.as_ref().unwrap().stable);
        tracker.observe(&frame(&rows, "menu"), 1000, true);
        assert!(tracker.detected);
        assert!(tracker.armed.as_ref().unwrap().stable);
        assert_eq!(tracker.index, 0);

        // A later scan can miss the other options while the menu is still on screen.
        tracker.observe(&frame(&rows[2..], "partial"), 2500, true);
        assert_eq!(tracker.index, 0);
        tracker.observe(
            &frame(
                &[row("次の会話", 0.8, 0.83, &[("次の会話", 0.2, 0.4)])],
                "dialogue",
            ),
            3000,
            true,
        );
        assert_eq!(tracker.index, 1);

        let mixed = [
            row(
                "2. 本",
                0.630,
                0.647,
                &[("2.", 0.506, 0.514), ("本", 0.521, 0.531)],
            ),
            rows[2].clone(),
        ];
        let mixed = prepare_choice_lines(&mixed);
        assert!(
            find_choice(&mixed, "ゲーム", ChoiceSearch::Ahead).is_some_and(|matched| matched.exact),
            "{mixed:?}"
        );

        let counts = [
            row(
                "2冊を買う",
                0.630,
                0.647,
                &[("2", 0.506, 0.514), ("冊を買う", 0.515, 0.552)],
            ),
            row(
                "3ゲーム",
                0.651,
                0.668,
                &[("3", 0.506, 0.514), ("ゲーム", 0.515, 0.546)],
            ),
        ];
        let counts = prepare_choice_lines(&counts);
        assert!(find_choice(&counts, "ゲーム", ChoiceSearch::Ahead).is_none());
        assert!(
            find_choice(&counts, "3ゲーム", ChoiceSearch::Ahead)
                .unwrap()
                .exact
        );
    }

    #[test]
    fn detects_mida_vocr_muv_luv_numbered_choice_menu() {
        // Exact mida_vocr output from Muv-Luv EXTRA (1024x576) choice screen.
        let norm_box = |x1: f64, y1: f64, x3: f64, y3: f64| json!({"x1": x1 / 1024.0, "y1": y1 / 576.0, "x3": x3 / 1024.0, "y3": y3 / 576.0});
        let words = |items: &[(&str, f64, f64)], y1: f64, y3: f64| -> Vec<Value> {
            items
                .iter()
                .map(|(t, x1, x3)| json!({"text": t, "bounding_rect": norm_box(*x1, y1, *x3, y3)}))
                .collect()
        };
        let data = vec![
            json!({
                "text": "1.屋上に行く",
                "is_vertical": false,
                "bounding_rect": norm_box(413.0, 493.0, 603.0, 517.0),
                "words": words(&[
                    ("1", 434.0625, 457.5), (".", 457.5, 460.5), ("屋", 460.5, 494.5),
                    ("上", 494.5, 520.5), ("に", 520.5, 545.5), ("行", 545.5, 570.5),
                    ("く", 570.5, 590.1875),
                ], 493.0, 517.0),
            }),
            json!({
                "text": "2.物理準備室に行く",
                "is_vertical": false,
                "bounding_rect": norm_box(379.0, 522.0, 645.0, 546.0),
                "words": words(&[
                    ("2", 400.0, 416.5), (".", 416.5, 422.5), ("物", 422.5, 455.5),
                    ("理", 455.5, 481.5), ("準", 481.5, 513.5), ("備", 513.5, 532.5),
                    ("室", 532.5, 560.5), ("に", 560.5, 583.5), ("行", 583.5, 609.5),
                    ("く", 609.5, 633.75),
                ], 522.0, 546.0),
            }),
        ];
        let prepared = prepare_choice_lines(&data);
        let matched = find_choice(&prepared, "物理準備室に行く", ChoiceSearch::Current(&data))
            .expect("mida_vocr Muv-Luv choice menu should match");
        assert!(matched.exact);
        assert!(matched.menu);
        assert!(matched.options.contains(&"屋上に行く".to_string()));
        assert!(matched.options.contains(&"物理準備室に行く".to_string()));
    }

    #[test]
    fn detects_meikiocr_and_mida_vocr_muv_luv_menu_with_dropped_period_or_digit() {
        // Exact meikiocr output on Muv-Luv EXTRA (crop mapped to 1024x576):
        // "1" absorbed part of the period so the gap before "委" is ~0.29 * advance.
        let norm_box = |x1: f64, y1: f64, x3: f64, y3: f64| {
            json!({
                "x1": (249.0 + x1) / 1024.0,
                "y1": (446.0 + y1) / 576.0,
                "x3": (249.0 + x3) / 1024.0,
                "y3": (446.0 + y3) / 576.0,
            })
        };
        let words = |items: &[(&str, f64, f64)], y1: f64, y3: f64| -> Vec<Value> {
            items
                .iter()
                .map(|(t, x1, x3)| json!({"text": t, "bounding_rect": norm_box(*x1, y1, *x3, y3)}))
                .collect()
        };
        let meiki_data = vec![
            json!({
                "text": "1委員長を呼ぶ",
                "is_vertical": false,
                "bounding_rect": norm_box(170.0, 18.0, 352.0, 41.0),
                "words": words(&[
                    ("1", 171.25, 194.13), ("委", 201.33, 225.80), ("員", 226.06, 250.90),
                    ("長", 253.63, 277.57), ("を", 279.33, 301.05), ("呼", 303.02, 327.73),
                    ("ぶ", 326.24, 352.0),
                ], 18.0, 41.0),
            }),
            json!({
                "text": "2.彩峰を探しに行く",
                "is_vertical": false,
                "bounding_rect": norm_box(151.0, 46.0, 371.0, 71.0),
                "words": words(&[
                    ("2", 151.0, 166.12), (".", 165.08, 173.11), ("彩", 187.04, 210.97),
                    ("峰", 210.65, 234.71), ("を", 237.90, 258.29), ("探", 261.19, 284.01),
                    ("し", 282.65, 304.29), ("に", 308.49, 328.25), ("行", 331.21, 351.65),
                    ("く", 350.12, 369.27),
                ], 46.0, 71.0),
            }),
            json!({
                "text": "3.放課後まで待つ",
                "is_vertical": false,
                "bounding_rect": norm_box(157.0, 75.0, 365.0, 99.0),
                "words": words(&[
                    ("3", 158.55, 171.26), (".", 169.99, 177.88), ("放", 190.51, 215.53),
                    ("課", 215.73, 241.16), ("後", 243.50, 266.90), ("ま", 271.06, 292.27),
                    ("で", 293.11, 314.68), ("待", 315.91, 338.87), ("つ", 339.76, 362.79),
                ], 75.0, 99.0),
            }),
        ];
        let meiki_lines = prepare_choice_lines(&meiki_data);
        let meiki_match = find_choice(
            &meiki_lines,
            "委員長を呼ぶ",
            ChoiceSearch::Current(&meiki_data),
        )
        .expect("meikiocr choice menu with narrow unpunctuated digit gap should match");
        assert!(meiki_match.exact);
        assert!(meiki_match.menu);
        assert!(meiki_match
            .options
            .contains(&"彩峰を探しに行く".to_string()));

        // Exact mida_vocr output on the same frame: leading "1" dropped, leaving ".委員長を呼ぶ".
        let mida_data = vec![
            json!({
                "text": ".委員長を呼ぶ",
                "is_vertical": false,
                "bounding_rect": norm_box(153.0, 18.0, 369.0, 43.0),
                "words": words(&[
                    (".", 178.875, 198.5), ("委", 198.5, 228.5), ("員", 228.5, 254.5),
                    ("長", 254.5, 280.5), ("を", 280.5, 303.5), ("呼", 303.5, 329.5),
                    ("ぶ", 329.5, 358.75),
                ], 18.0, 43.0),
            }),
            meiki_data[1].clone(),
            meiki_data[2].clone(),
        ];
        let mida_lines = prepare_choice_lines(&mida_data);
        let mida_match = find_choice(
            &mida_lines,
            "委員長を呼ぶ",
            ChoiceSearch::Current(&mida_data),
        )
        .expect("mida_vocr choice menu with dropped leading digit should match");
        assert!(mida_match.exact);
        assert!(mida_match.menu);
        assert!(mida_match.options.contains(&"彩峰を探しに行く".to_string()));
    }

    #[test]
    fn benchmark_vn_guide_choice_observation_500_frames() {
        let steps = vec![GuideStep {
            text: "図書館へ行く".into(),
            kind: "choice".into(),
        }];
        let mut tracker = GuideTracker::new(steps, 0);
        let frame = json!({
            "type": "word_coordinates",
            "is_final": false,
            "line_id": "L1",
            "presence_id": "P1",
            "data": [
                { "text": "食堂へ行く", "bounding_rect": { "x1": 0.35, "y1": 0.35, "x3": 0.65, "y3": 0.39 } },
                { "text": "図書館へ行く", "bounding_rect": { "x1": 0.35, "y1": 0.43, "x3": 0.65, "y3": 0.47 } },
                { "text": "屋上へ行く", "bounding_rect": { "x1": 0.35, "y1": 0.51, "x3": 0.65, "y3": 0.55 } }
            ]
        });
        let started = Instant::now();
        for i in 0..500u64 {
            tracker.observe(&frame, 1000 + i * 16, true);
        }
        let elapsed = started.elapsed();
        println!(
            "[bench] vn_guide_observe_500_frames total_ms={:.3} us_per_frame={:.2}",
            elapsed.as_secs_f64() * 1000.0,
            elapsed.as_secs_f64() * 1_000_000.0 / 500.0
        );
    }
}
