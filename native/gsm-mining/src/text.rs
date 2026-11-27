//! Text normalization, HTML/cloze preservation, dialogue combining, and fuzzy card-to-line matching.
use crate::config::{AnkiCard, AnkiConfig};
use chrono::{DateTime, Duration, Local, NaiveDateTime, TimeZone};
use rapidfuzz::{distance::indel::BatchComparator, fuzz::ratio};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Reverse;
use std::collections::HashMap;
use std::hash::Hash;
use std::path::Path;
use std::sync::OnceLock;

pub const SOURCE_OCR: &str = "ocr";
pub const SOURCE_OCR_MANUAL: &str = "ocr_manual";
pub const SOURCE_HOOKER: &str = "hooker";
pub const SOURCE_MANUAL: &str = "manual";
pub const SOURCE_SECONDARY: &str = "secondary";
pub const SOURCE_SCREEN_CROPPER: &str = "screen_cropper";
pub const SOURCE_HOTKEY: &str = "hotkey";
pub const SOURCE_OVERLAY: &str = "overlay";
pub const SOURCE_SKIP_RECOVERY: &str = "skip_recovery";

pub fn source_padding_seconds(source: Option<&str>) -> f64 {
    match source.unwrap_or("") {
        SOURCE_OCR | SOURCE_HOOKER => 0.0,
        SOURCE_OCR_MANUAL => 2.0,
        SOURCE_MANUAL | SOURCE_SECONDARY | SOURCE_HOTKEY | SOURCE_OVERLAY => 3.0,
        SOURCE_SCREEN_CROPPER => 5.0,
        _ => 0.0,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameLine {
    pub id: String,
    pub text: String,
    /// Wall-clock local timestamp as epoch seconds (f64) for exact parity with Python's naive local datetime.
    pub time_epoch: f64,
    #[serde(default)]
    pub index: i64,
    #[serde(default)]
    pub scene: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub source_padding: Option<f64>,
    #[serde(default)]
    pub mined_time_epoch: Option<f64>,
    #[serde(default)]
    pub excluded_from_stats: bool,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub first_seen_time_epoch: Option<f64>,
    #[serde(default)]
    pub translation: String,
    #[serde(default)]
    pub prev_id: Option<String>,
    #[serde(default)]
    pub next_id: Option<String>,
    /// Populated when this line comes from a saved clip rather than the live log.
    #[serde(default)]
    pub clip_folder: Option<String>,
    #[serde(default)]
    pub clip_path: Option<String>,
    #[serde(default)]
    pub clip_end_time_epoch: Option<f64>,
}

impl GameLine {
    pub fn effective_padding(&self) -> f64 {
        self.source_padding.unwrap_or_else(|| source_padding_seconds(self.source.as_deref()))
    }

    pub fn is_overlay(&self) -> bool {
        self.source.as_deref() == Some(SOURCE_OVERLAY)
    }

    pub fn is_from_clip(&self) -> bool {
        self.clip_folder.is_some()
    }

    pub fn iso_time(&self) -> String {
        epoch_to_local_iso(self.time_epoch)
    }
}

pub fn now_epoch() -> f64 {
    let dt = Local::now();
    dt.timestamp() as f64 + (dt.timestamp_subsec_nanos() as f64) * 1e-9
}

pub fn epoch_to_local_iso(epoch: f64) -> String {
    let secs = epoch.floor() as i64;
    let nanos = ((epoch - secs as f64).clamp(0.0, 0.999_999_999) * 1e9) as u32;
    let dt = Local
        .timestamp_opt(secs, nanos)
        .single()
        .unwrap_or_else(Local::now);
    dt.naive_local().format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
}

pub fn parse_iso_to_epoch(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(dt.timestamp() as f64 + (dt.timestamp_subsec_nanos() as f64) * 1e-9);
    }
    for fmt in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
    ] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, fmt) {
            if let Some(dt) = Local.from_local_datetime(&naive).earliest() {
                return Some(
                    dt.timestamp() as f64 + (dt.timestamp_subsec_nanos() as f64) * 1e-9,
                );
            }
        }
    }
    None
}

pub fn remove_html_and_cloze_tags(text: &str) -> String {
    if !text.contains(['[', '{', '<']) {
        return text.to_string();
    }
    static RE_BRACKET: OnceLock<Regex> = OnceLock::new();
    static RE_CLOZE: OnceLock<Regex> = OnceLock::new();
    static RE_HTML: OnceLock<Regex> = OnceLock::new();

    let mut current: std::borrow::Cow<'_, str> = std::borrow::Cow::Borrowed(text);
    if current.contains('[') {
        let re_bracket = RE_BRACKET.get_or_init(|| Regex::new(r"\[[^\]]*\]").unwrap());
        if let std::borrow::Cow::Owned(s) = re_bracket.replace_all(&current, "") {
            current = std::borrow::Cow::Owned(s);
        }
    }
    if current.contains("{{") {
        let re_cloze =
            RE_CLOZE.get_or_init(|| Regex::new(r"(?s)\{\{c\d+::(.*?)(?:::[^\{\}]*)?\}\}").unwrap());
        if let std::borrow::Cow::Owned(s) = re_cloze.replace_all(&current, "$1") {
            current = std::borrow::Cow::Owned(s);
        }
    }
    if current.contains('<') {
        let re_html = RE_HTML.get_or_init(|| Regex::new(r"(?s)<[^>]*>").unwrap());
        if let std::borrow::Cow::Owned(s) = re_html.replace_all(&current, "") {
            current = std::borrow::Cow::Owned(s);
        }
    }
    current.into_owned()
}

pub fn html_unescape_basic(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'&' {
            if let Some(semi) = text[i..].find(';') {
                let entity = &text[i + 1..i + semi];
                if let Some(ch) = decode_entity(entity) {
                    out.push_str(&ch);
                    i += semi + 1;
                    continue;
                }
            }
        }
        let ch = text[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn decode_entity(entity: &str) -> Option<String> {
    match entity {
        "amp" => Some("&".into()),
        "lt" => Some("<".into()),
        "gt" => Some(">".into()),
        "quot" => Some("\"".into()),
        "apos" | "#39" | "#x27" => Some("'".into()),
        "nbsp" => Some("\u{00A0}".into()),
        _ if entity.starts_with("#x") || entity.starts_with("#X") => {
            u32::from_str_radix(&entity[2..], 16)
                .ok()
                .and_then(char::from_u32)
                .map(|c| c.to_string())
        }
        _ if entity.starts_with('#') => entity[1..]
            .parse::<u32>()
            .ok()
            .and_then(char::from_u32)
            .map(|c| c.to_string()),
        _ => None,
    }
}

pub fn html_escape_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            _ => out.push(c),
        }
    }
    out
}

pub fn strip_sentence_formatting_for_reuse(sentence: &str) -> String {
    static RE_BR: OnceLock<Regex> = OnceLock::new();
    if sentence.is_empty() {
        return String::new();
    }
    let placeholder = "\u{0000}GSM_BR\u{0000}";
    let re_br = RE_BR.get_or_init(|| Regex::new(r"(?i)<\s*br\s*/?\s*>").unwrap());
    let protected = re_br.replace_all(sentence, placeholder);
    let stripped = remove_html_and_cloze_tags(&protected);
    stripped.replace(placeholder, "<br>").trim().to_string()
}

pub fn normalize_line_breaks_to_br(text: &str) -> String {
    text.replace("\r\n", "<br>")
        .replace('\r', "<br>")
        .replace('\n', "<br>")
}

pub fn sanitize_filename(filename: &str) -> String {
    filename
        .chars()
        .filter(|&c| {
            !matches!(c, ' ' | '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
                && (c as u32) >= 0x20
        })
        .collect()
}

pub fn media_filename_for_game(path: &str, game_name: &str) -> String {
    static RE_TS: OnceLock<Regex> = OnceLock::new();
    let p = Path::new(path);
    let file_name = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("media")
        .to_string();
    if game_name.is_empty() {
        return file_name;
    }
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("media");
    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let re_ts = RE_TS
        .get_or_init(|| Regex::new(r"_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}").unwrap());
    let ts_suffix = re_ts.find(stem).map(|m| m.as_str()).unwrap_or("");
    let abs = std::fs::canonicalize(p)
        .unwrap_or_else(|_| p.to_path_buf())
        .to_string_lossy()
        .into_owned();
    let norm = if cfg!(windows) {
        abs.to_lowercase()
    } else {
        abs
    };
    let digest = Sha256::digest(norm.as_bytes());
    let mut hex = String::with_capacity(16);
    for b in &digest[..8] {
        hex.push_str(&format!("{b:02x}"));
    }
    let mut prefix = sanitize_filename(game_name);
    if prefix.is_empty() {
        prefix = "game".into();
    }
    format!("{prefix}{ts_suffix}_{hex}{ext}")
}

pub fn make_unique_file_name(path: &Path) -> std::path::PathBuf {
    let now = Local::now();
    let ts = format!(
        "{}-{:03}",
        now.format("%Y-%m-%d-%H-%M-%S"),
        now.timestamp_subsec_millis()
    );
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!("{stem}_{ts}{ext}"))
}

pub fn make_unique_temp_file(temp_dir: &Path, source_path: &Path) -> std::path::PathBuf {
    let now = Local::now();
    let ts = format!(
        "{}-{:03}",
        now.format("%Y-%m-%d-%H-%M-%S"),
        now.timestamp_subsec_millis()
    );
    let stem = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let ext = source_path
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    temp_dir.join(format!("{stem}_{ts}{ext}"))
}

pub fn normalize_text_for_comparison(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_whitespace() && !is_punctuation_or_symbol(*c))
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_punctuation_or_symbol(c: char) -> bool {
    if c.is_ascii_punctuation() {
        return true;
    }
    // Common CJK/Japanese punctuation & symbols stripped by GSM's punctuation remover
    matches!(
        c as u32,
        0x2000..=0x206F
            | 0x2E00..=0x2E7F
            | 0x3000..=0x303F
            | 0xFE10..=0xFE1F
            | 0xFE30..=0xFE6F
            | 0xFF01..=0xFF0F
            | 0xFF1A..=0xFF20
            | 0xFF3B..=0xFF40
            | 0xFF5B..=0xFF65
    ) || matches!(c, '・' | '…' | '―' | '─' | '〜' | '～' | '♪' | '♥' | '★' | '☆')
}

pub fn lines_match(a: &str, b: &str) -> bool {
    let na = normalize_text_for_comparison(a);
    let nb = normalize_text_for_comparison(b);
    if na.is_empty() || nb.is_empty() {
        let ca: String = a.split_whitespace().collect();
        let cb: String = b.split_whitespace().collect();
        return !ca.is_empty() && ca == cb;
    }
    if na == nb {
        return true;
    }
    let la = na.chars().count();
    let lb = nb.chars().count();
    let short = la.min(lb);
    let long = la.max(lb);
    let contained =
        (short >= 5 || short as f64 >= 0.3 * long as f64) && (na.contains(&nb) || nb.contains(&na));
    if contained {
        return true;
    }
    let score = ratio(na.chars(), nb.chars()) * 100.0;
    score >= 80.0
}

pub fn combine_dialogue(dialogue_lines: &[String], line_break: &str) -> Vec<String> {
    let mut new_lines = Vec::new();
    let mut i = 0;
    while i < dialogue_lines.len() {
        let line = &dialogue_lines[i];
        if !line.contains('「') {
            let suffix = if i + 1 < dialogue_lines.len() {
                line_break
            } else {
                ""
            };
            new_lines.push(format!("{line}{suffix}"));
            i += 1;
            continue;
        }
        let (character_name, dialogue_text) = line.split_once('「').unwrap();
        let mut parts = vec![dialogue_text.trim_end_matches('」').to_string()];
        i += 1;
        let prefix = format!("{character_name}「");
        while i < dialogue_lines.len() && dialogue_lines[i].starts_with(&prefix) {
            if let Some((_, rest)) = dialogue_lines[i].split_once('「') {
                parts.push(rest.trim_end_matches('」').to_string());
            }
            i += 1;
        }
        let mut combined = format!("{character_name}「{}」", parts.join(line_break));
        if i < dialogue_lines.len() {
            combined.push_str(line_break);
        }
        new_lines.push(combined);
    }
    new_lines
}

pub fn fix_overlay_whitespace(card: &mut AnkiCard, note_fields: &mut HashMap<String, String>) {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        vec![
            Regex::new(r"(\r?\n){3,}").unwrap(),
            Regex::new(r"(\r){3,}").unwrap(),
            Regex::new(r"(\n\r\n){2,}").unwrap(),
            Regex::new(r"(\r\n\r){2,}").unwrap(),
            Regex::new(r"(<br>\s*){3,}").unwrap(),
        ]
    });
    for (field_name, field_val) in &mut card.fields {
        for pat in patterns {
            if pat.is_match(&field_val.value) {
                let fixed = pat.replace_all(&field_val.value, "").into_owned();
                field_val.value = fixed.clone();
                note_fields.insert(field_name.clone(), fixed);
                break;
            }
        }
    }
}

/// Re-apply inline HTML tags (such as `<b>...</b>` or `<span ...>...</span>`) and Anki clozes
/// from `original_text` onto `new_text` while keeping `new_text`'s characters and spacing.
pub fn preserve_html_tags(original_text: &str, new_text: &str) -> String {
    let trimmed_new = new_text.trim();
    if (!original_text.contains('<') || !original_text.contains('>')) && !original_text.contains('{')
    {
        return trimmed_new.to_string();
    }
    // Extract plain text and tagged spans from original_text.
    static RE_TAG_OR_CLOZE: OnceLock<Regex> = OnceLock::new();
    let re = RE_TAG_OR_CLOZE.get_or_init(|| {
        Regex::new(r"(?s)(<[^>]+>|\{\{c\d+::(.*?)(?:::[^\{\}]*)?\}\})").unwrap()
    });

    // Find paired inline tags (`<b>...</b>`, `<span ...>...</span>`, etc.) without regex backreferences.
    let mut result = trimmed_new.to_string();
    let mut matched_any = false;
    let inline_tags = ["b", "strong", "i", "em", "u", "span", "mark"];
    for tag in inline_tags {
        let open_pat = Regex::new(&format!(r"(?i)<{tag}(?:\s[^>]*)?>")).unwrap();
        let close_pat = format!("</{tag}>");
        let lower_orig = original_text.to_ascii_lowercase();
        for m in open_pat.find_iter(original_text) {
            if let Some(rel_end) = lower_orig[m.end()..].find(&close_pat) {
                let close_start = m.end() + rel_end;
                let close_end = close_start + close_pat.len();
                let open = m.as_str();
                let close = &original_text[close_start..close_end];
                let inner_plain = remove_html_and_cloze_tags(&original_text[m.end()..close_start]);
                if !inner_plain.is_empty() && result.contains(&inner_plain) {
                    let wrapped = format!("{open}{inner_plain}{close}");
                    if !result.contains(&wrapped) {
                        result = result.replacen(&inner_plain, &wrapped, 1);
                        matched_any = true;
                    }
                }
            }
        }
    }
    if matched_any {
        return result;
    }

    // Fallback: if plain text matches verbatim, return original_text as-is.
    let orig_plain = re.replace_all(original_text, |caps: &regex::Captures| {
        caps.get(2).map(|m| m.as_str()).unwrap_or("").to_string()
    });
    if normalize_text_for_comparison(&orig_plain) == normalize_text_for_comparison(trimmed_new) {
        return original_text.trim().to_string();
    }
    trimmed_new.to_string()
}

/// Preserve HTML tags from `source_sentence` around the furigana-annotated `furigana_text`.
pub fn preserve_html_tags_for_furigana(source_sentence: &str, furigana_text: &str) -> String {
    if !source_sentence.contains('<') || !source_sentence.contains('>') {
        return furigana_text.to_string();
    }
    // Walk `source_sentence` and `furigana_text` in lockstep, re-inserting HTML tags at matching
    // visible character positions while skipping `[reading]` brackets in `furigana_text`.
    let src_chars: Vec<char> = source_sentence.chars().collect();
    let furi_chars: Vec<char> = furigana_text.chars().collect();
    let mut out = String::with_capacity(furigana_text.len() + source_sentence.len() / 2);
    let mut si = 0usize;
    let mut fi = 0usize;

    while si < src_chars.len() {
        if src_chars[si] == '<' {
            let start = si;
            while si < src_chars.len() && src_chars[si] != '>' {
                si += 1;
            }
            if si < src_chars.len() {
                si += 1;
            }
            let tag: String = src_chars[start..si].iter().collect();
            let is_closing = tag.starts_with("</");
            // If closing tag, flush any immediately following `[reading]` from furigana_text first!
            if is_closing && fi < furi_chars.len() && furi_chars[fi] == '[' {
                while fi < furi_chars.len() {
                    let ch = furi_chars[fi];
                    out.push(ch);
                    fi += 1;
                    if ch == ']' {
                        break;
                    }
                }
            }
            out.push_str(&tag);
            continue;
        }
        let sc = src_chars[si];
        si += 1;
        if sc.is_whitespace() {
            if fi < furi_chars.len() && furi_chars[fi].is_whitespace() {
                out.push(furi_chars[fi]);
                fi += 1;
            } else {
                out.push(sc);
            }
            continue;
        }
        // Flush any `[reading]` or leading space in furigana_text before matching visible char.
        while fi < furi_chars.len() {
            let fc = furi_chars[fi];
            if fc == '[' {
                while fi < furi_chars.len() {
                    let b = furi_chars[fi];
                    out.push(b);
                    fi += 1;
                    if b == ']' {
                        break;
                    }
                }
                continue;
            }
            if fc == ' ' && !sc.is_whitespace() {
                out.push(fc);
                fi += 1;
                continue;
            }
            out.push(fc);
            fi += 1;
            break;
        }
    }
    while fi < furi_chars.len() {
        out.push(furi_chars[fi]);
        fi += 1;
    }
    out
}

/// Extract normalized context sentence and highlighted (bold/cloze) character spans for card matching.
pub fn get_mined_expression_spans(sentence: &str, expression: &str) -> (String, Vec<(usize, usize)>, bool) {
    static RE_BOLD: OnceLock<Regex> = OnceLock::new();
    let re_bold = RE_BOLD
        .get_or_init(|| Regex::new(r"(?is)<(?:b|strong)(?:\s[^>]*)?>(.*?)</(?:b|strong)>").unwrap());

    let mut context = String::new();
    let mut spans = Vec::new();
    let mut last_end = 0usize;
    let mut has_bold = false;

    for cap in re_bold.captures_iter(sentence) {
        let m = cap.get(0).unwrap();
        let before = remove_html_and_cloze_tags(&sentence[last_end..m.start()]);
        context.push_str(&normalize_text_for_comparison(&before));
        let start_chars = context.chars().count();
        let inner = remove_html_and_cloze_tags(&cap[1]);
        let norm_inner = normalize_text_for_comparison(&inner);
        if !norm_inner.is_empty() {
            context.push_str(&norm_inner);
            let end_chars = context.chars().count();
            spans.push((start_chars, end_chars));
            has_bold = true;
        }
        last_end = m.end();
    }
    let tail = remove_html_and_cloze_tags(&sentence[last_end..]);
    context.push_str(&normalize_text_for_comparison(&tail));

    if !has_bold && !expression.is_empty() {
        let norm_expr = normalize_text_for_comparison(expression);
        if !norm_expr.is_empty() {
            let expr_len = norm_expr.chars().count();
            let mut prev_byte = 0usize;
            let mut char_pos = 0usize;
            for (byte_idx, _) in context.match_indices(&norm_expr) {
                char_pos += context[prev_byte..byte_idx].chars().count();
                prev_byte = byte_idx;
                spans.push((char_pos, char_pos + expr_len));
            }
        }
    }

    (context, spans, has_bold)
}

// --- Fuzzy card-to-line matcher ---

pub struct MatchQuery {
    pub sentence: String,
    pub punctuation: String,
    pub expression: String,
    pub context: String,
    pub spans: Vec<(usize, usize)>,
    pub bold: bool,
    pub recent: bool,
    pub minimum: f64,
}

struct Anchor {
    start: usize,
    length: usize,
    text: String,
}

struct Pick<T> {
    line: T,
    order: usize,
    expression: bool,
    similarity: f64,
}

struct SourceLine<T> {
    context_score: Option<f64>,
    newest: Option<Pick<T>>,
    most_similar: Option<Pick<T>>,
}

impl<T> SourceLine<T> {
    fn new() -> Self {
        Self {
            context_score: None,
            newest: None,
            most_similar: None,
        }
    }

    fn record(&mut self, pick: Pick<T>) {
        let Some(newest) = &self.newest else {
            self.newest = Some(pick);
            return;
        };
        if pick.expression && !newest.expression {
            self.newest = Some(pick);
            self.most_similar = None;
        } else if pick.expression == newest.expression
            && self.context_score.is_none()
            && pick.similarity > self.most_similar.as_ref().unwrap_or(newest).similarity
        {
            self.most_similar = Some(pick);
        }
    }

    fn winner(self) -> Option<Pick<T>> {
        let mut pick = self.most_similar.or(self.newest)?;
        if let Some(score) = self.context_score {
            pick.similarity = score;
        }
        Some(pick)
    }
}

pub struct CardMatcher<T, Id> {
    query: MatchQuery,
    sentence_length: usize,
    scorer: BatchComparator<char>,
    context: Vec<char>,
    anchors: Vec<Anchor>,
    matches: HashMap<Id, SourceLine<T>>,
    order: usize,
    best_sentence: Option<((bool, f64), T)>,
    recent_fallback: Option<T>,
}

impl<T, Id: Eq + Hash> CardMatcher<T, Id> {
    pub fn new(query: MatchQuery) -> Self {
        let context: Vec<_> = query.context.chars().collect();
        let anchors = query
            .spans
            .iter()
            .filter_map(|&(start, end)| {
                let text = context.get(start..end)?;
                (!text.is_empty()).then(|| Anchor {
                    start,
                    length: text.len(),
                    text: text.iter().collect(),
                })
            })
            .collect();
        Self {
            sentence_length: query.sentence.chars().count(),
            scorer: BatchComparator::new(query.sentence.chars()),
            context,
            anchors,
            query,
            matches: HashMap::new(),
            order: 0,
            best_sentence: None,
            recent_fallback: None,
        }
    }

    fn context_score(&self, line: &str) -> f64 {
        let mut chars = None;
        let mut best: f64 = 0.0;
        for anchor in &self.anchors {
            let mut previous_byte = 0;
            let mut position = 0;
            for (byte, _) in line.match_indices(&anchor.text) {
                position += line[previous_byte..byte].chars().count();
                previous_byte = byte;
                let chars = chars.get_or_insert_with(|| line.chars().collect::<Vec<_>>());
                let left = &chars[position.saturating_sub(anchor.start)..];
                let right = &self.context[anchor.start.saturating_sub(position)..];
                let overlap = left.len().min(right.len());
                if overlap >= 5.max(anchor.length) {
                    let score =
                        ratio(left.iter().copied(), right[..overlap].iter().copied()) * 100.0;
                    best = best.max(score);
                    if best == 100.0 {
                        return best;
                    }
                }
            }
        }
        best
    }

    pub fn observe(&mut self, original: T, id: Id, line: &str, punctuation: &str) -> Option<T> {
        let q = &self.query;
        let (matches, similarity) = if line.is_empty() || q.sentence.is_empty() {
            (!punctuation.is_empty() && punctuation == q.punctuation, 0.0)
        } else if line == q.sentence {
            (true, 100.0)
        } else {
            let length = line.chars().count();
            let short = length.min(self.sentence_length);
            let long = length.max(self.sentence_length);
            let contained = (short >= 5 || short as f64 >= 0.3 * long as f64)
                && (line.contains(&q.sentence) || q.sentence.contains(line));
            let score = self.scorer.normalized_similarity(line.chars()) * 100.0;
            (contained || score >= 80.0, score)
        };
        let ordinary = matches && (q.minimum <= 0.0 || similarity >= q.minimum);
        let context_score = self.context_score(line);
        let anchored = context_score >= q.minimum.max(80.0);
        if !ordinary && !anchored {
            return None;
        }
        if q.recent {
            if (q.bold && anchored) || (!q.bold && ordinary) {
                return Some(original);
            }
            self.recent_fallback.get_or_insert(original);
            return None;
        }
        let expression = !q.expression.is_empty()
            && q.sentence.contains(&q.expression)
            && line.contains(&q.expression);
        if self.anchors.is_empty() || (q.bold && !anchored) {
            let priority = (expression, similarity);
            if self
                .best_sentence
                .as_ref()
                .is_none_or(|(old, _)| priority > *old)
            {
                self.best_sentence = Some((priority, original));
            }
            return None;
        }
        let source = self.matches.entry(id).or_insert_with(SourceLine::new);
        if anchored {
            source.context_score = Some(context_score);
            source.most_similar = None;
        }
        if ordinary || q.bold {
            source.record(Pick {
                line: original,
                order: self.order,
                expression,
                similarity,
            });
            self.order += 1;
        }
        None
    }

    pub fn finish(self) -> Option<T> {
        if self.query.recent {
            return self.recent_fallback;
        }
        if self.matches.is_empty() {
            return self.best_sentence.map(|(_, line)| line);
        }
        self.matches
            .into_values()
            .filter_map(SourceLine::winner)
            .max_by(|a, b| {
                a.expression
                    .cmp(&b.expression)
                    .then(a.similarity.total_cmp(&b.similarity))
                    .then(Reverse(a.order).cmp(&Reverse(b.order)))
            })
            .map(|pick| pick.line)
    }
}

pub fn find_matching_line<'a>(
    card: &AnkiCard,
    anki_cfg: &AnkiConfig,
    lines: &'a [GameLine],
    prefer_recent: bool,
    respect_replay_window: bool,
    replay_buffer_length: f64,
    minimum_score: f64,
) -> Option<&'a GameLine> {
    if lines.is_empty() {
        return None;
    }
    let sentence = card.get_field(&anki_cfg.sentence.name)?;
    if sentence.is_empty() {
        return None;
    }
    let anki_sentence = remove_html_and_cloze_tags(sentence);
    let normalized_sentence = normalize_text_for_comparison(&anki_sentence);
    let expression = card
        .get_field(&anki_cfg.word.name)
        .map(remove_html_and_cloze_tags)
        .unwrap_or_default();
    let normalized_expression = normalize_text_for_comparison(&expression);
    let (context, spans, bold) = get_mined_expression_spans(sentence, &expression);
    let punctuation = if normalized_sentence.is_empty() {
        anki_sentence.split_whitespace().collect()
    } else {
        String::new()
    };
    let cutoff = respect_replay_window.then(|| {
        let now = Local::now() - Duration::milliseconds(((replay_buffer_length + 5.0) * 1000.0) as i64);
        now.timestamp() as f64 + (now.timestamp_subsec_nanos() as f64) * 1e-9
    });

    let mut matcher = CardMatcher::new(MatchQuery {
        sentence: normalized_sentence,
        punctuation: punctuation.clone(),
        expression: normalized_expression,
        context,
        spans,
        bold,
        recent: prefer_recent,
        minimum: minimum_score,
    });
    for line in lines.iter().rev() {
        if let Some(min_t) = cutoff {
            if line.time_epoch < min_t {
                continue;
            }
        }
        let norm = normalize_text_for_comparison(&line.text);
        let compact = if !punctuation.is_empty() && norm.is_empty() {
            line.text.split_whitespace().collect::<String>()
        } else {
            String::new()
        };
        if let Some(winner) = matcher.observe(line, line.id.as_str(), &norm, &compact) {
            return Some(winner);
        }
    }
    matcher.finish()
}

pub fn get_previous_context_line<'a>(
    game_line: &GameLine,
    selected_lines: &[GameLine],
    all_lines: &'a [GameLine],
) -> Option<&'a GameLine> {
    let first_id = selected_lines
        .first()
        .map(|l| l.id.as_str())
        .unwrap_or(game_line.id.as_str());
    let mut prev_id = all_lines
        .iter()
        .find(|l| l.id == first_id)
        .and_then(|l| l.prev_id.as_deref())
        .or(game_line.prev_id.as_deref());
    let mut guard = 0usize;
    while let Some(id) = prev_id {
        guard += 1;
        if guard > 512 {
            break;
        }
        let Some(candidate) = all_lines.iter().find(|l| l.id == id) else {
            break;
        };
        let dialogue_text = candidate
            .text
            .split_once(['「', '『', '｢'])
            .map(|(_, rest)| rest)
            .unwrap_or(&candidate.text);
        if dialogue_text.chars().any(char::is_alphanumeric) {
            return Some(candidate);
        }
        prev_id = candidate.prev_id.as_deref();
    }
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn explicit_zero_padding_overrides_the_source_default() {
        let mut input = serde_json::json!({"id":"line","text":"test","time_epoch":2.0,"source":"manual"});
        let parse = |value| serde_json::from_value::<super::GameLine>(value).unwrap().effective_padding();
        assert_eq!(parse(input.clone()), 3.0);
        input["source_padding"] = serde_json::json!(0.0);
        assert_eq!(parse(input), 0.0);
    }
    use super::*;
    use crate::config::AnkiCardField;

    #[test]
    fn html_cloze_and_dialogue_combining() {
        assert_eq!(
            remove_html_and_cloze_tags("<b>{{c1::猫::cat}}</b>が[ねこ]いる"),
            "猫がいる"
        );
        assert_eq!(
            strip_sentence_formatting_for_reuse("<b>猫</b><br>犬"),
            "猫<br>犬"
        );
        assert_eq!(
            combine_dialogue(
                &[
                    "太郎「おはよう」".into(),
                    "太郎「元気？」".into(),
                    "花子「うん」".into(),
                ],
                "<br>"
            ),
            vec!["太郎「おはよう<br>元気？」<br>", "花子「うん」"]
        );
    }

    #[test]
    fn preserve_tags_and_furigana() {
        assert_eq!(
            preserve_html_tags("昨日の<b>図書館</b>で待っていた", "昨日の図書館で待っていた"),
            "昨日の<b>図書館</b>で待っていた"
        );
        assert_eq!(
            preserve_html_tags_for_furigana(
                "<b>猫</b>がいる",
                "猫[ねこ]がいる"
            ),
            "<b>猫[ねこ]</b>がいる"
        );
    }

    #[test]
    fn card_matcher_finds_best_line() {
        let cfg = AnkiConfig::default();
        let card = AnkiCard {
            note_id: 1,
            tags: vec![],
            fields: vec![
                (
                    "Expression".into(),
                    AnkiCardField {
                        value: "図書館".into(),
                        order: 0,
                    },
                ),
                (
                    "Sentence".into(),
                    AnkiCardField {
                        value: "昨日の<b>図書館</b>で待っていた".into(),
                        order: 1,
                    },
                ),
            ],
            cards: vec![2],
            model_name: "Lapis".into(),
        };
        let now = now_epoch();
        let lines = vec![
            GameLine {
                id: "1".into(),
                text: "全然違う文".into(),
                time_epoch: now - 10.0,
                index: 0,
                scene: "VN".into(),
                source: Some(SOURCE_HOOKER.into()),
                source_padding: Some(0.0),
                mined_time_epoch: None,
                excluded_from_stats: false,
                session_id: String::new(),
                first_seen_time_epoch: None,
                translation: String::new(),
                prev_id: None,
                next_id: Some("2".into()),
                clip_folder: None,
                clip_path: None,
                clip_end_time_epoch: None,
            },
            GameLine {
                id: "2".into(),
                text: "昨日の図書館で待っていた".into(),
                time_epoch: now - 5.0,
                index: 1,
                scene: "VN".into(),
                source: Some(SOURCE_HOOKER.into()),
                source_padding: Some(0.0),
                mined_time_epoch: None,
                excluded_from_stats: false,
                session_id: String::new(),
                first_seen_time_epoch: None,
                translation: String::new(),
                prev_id: Some("1".into()),
                next_id: None,
                clip_folder: None,
                clip_path: None,
                clip_end_time_epoch: None,
            },
        ];
        let found = find_matching_line(&card, &cfg, &lines, false, true, 300.0, 0.0).unwrap();
        assert_eq!(found.id, "2");
    }

    #[test]
    fn card_matcher_matches_overlay_card_with_speaker_tag_and_bold_word() {
        let cfg = AnkiConfig::default();
        let card = AnkiCard {
            note_id: 99,
            tags: vec!["overlay".into()],
            fields: vec![
                (
                    "Expression".into(),
                    AnkiCardField {
                        value: "今し方".into(),
                        order: 0,
                    },
                ),
                (
                    "Sentence".into(),
                    AnkiCardField {
                        value: "【冥夜】「<b>今し方</b>教室を出ていったが?」".into(),
                        order: 1,
                    },
                ),
            ],
            cards: vec![100],
            model_name: "Lapis".into(),
        };
        let now = now_epoch();
        let lines = vec![GameLine {
            id: "line-meiya".into(),
            text: "【冥夜】「今し方教室を出ていったが?」".into(),
            time_epoch: now - 3.0,
            index: 10,
            scene: "Muv-Luv EXTRA".into(),
            source: Some(SOURCE_HOOKER.into()),
            source_padding: Some(0.0),
            mined_time_epoch: None,
            excluded_from_stats: false,
            session_id: String::new(),
            first_seen_time_epoch: None,
            translation: String::new(),
            prev_id: None,
            next_id: None,
            clip_folder: None,
            clip_path: None,
            clip_end_time_epoch: None,
        }];
        let found = find_matching_line(&card, &cfg, &lines, true, true, 300.0, 0.0).unwrap();
        assert_eq!(found.id, "line-meiya");
    }
}
