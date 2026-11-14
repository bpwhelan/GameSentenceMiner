//! Native Agent script discovery, Switch TitleID detection, and fast fuzzy ranking.
//!
//! Replaces `electron-src/main/agent_script_resolver.ts` and the backend usage of
//! `electron-src/shared/agent_scripts.ts` in pure Rust without regex backtracking
//! or Node process overhead.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

const ALLOWED_EXTENSIONS: [&str; 3] = ["js", "mjs", "cjs"];
const SWITCH_EMULATORS: [&str; 8] = [
    "yuzu", "eden", "suyu", "citron", "torzu", "sudachi", "ryujinx", "lichii",
];
const GENERIC_EXES: [&str; 12] = [
    "game",
    "main",
    "start",
    "launcher",
    "client",
    "app",
    "unityplayer",
    "nw",
    "electron",
    "unreal",
    "retroarch",
    "bootstrap",
];
const STOP_WORDS: [&str; 16] = [
    "exe",
    "win64",
    "win32",
    "x64",
    "x86",
    "shipping",
    "release",
    "retail",
    "dx11",
    "dx12",
    "directx",
    "vulkan",
    "opengl",
    "bit",
    "64",
    "32",
];
const SCRIPT_METADATA_PREFIX_TOKENS: [&str; 16] = [
    "pc",
    "ns",
    "3ds",
    "ps2",
    "ps1",
    "psp",
    "ps3",
    "vita",
    "pc98",
    "dos",
    "hcode",
    "steam",
    "gog",
    "unity",
    "unreal",
    "dlsite",
];
const SCRIPT_REGION_OR_LANG_TOKENS: [&str; 6] = ["en", "jp", "ja", "cn", "zh", "japan"];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentScriptCandidate {
    pub path: String,
    pub reason: String,
    pub score: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveAgentScriptInput {
    pub scripts_path: String,
    #[serde(default)]
    pub scene_name: Option<String>,
    #[serde(default)]
    pub window_title: Option<String>,
    #[serde(default)]
    pub process_name: Option<String>,
    #[serde(default)]
    pub explicit_game_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveAgentScriptOutput {
    pub status: String,
    pub path: Option<String>,
    pub reason: String,
    pub is_exact_yuzu_id_match: bool,
    pub is_switch_target: bool,
    pub title_id: Option<String>,
    pub candidates: Vec<AgentScriptCandidate>,
    pub process_name: Option<String>,
    pub window_title: Option<String>,
}

/// Convert fullwidth ASCII / compatibility characters to lowercase ASCII + clean Unicode.
fn fold_nfkc_lower(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        let mapped = match ch {
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(ch as u32 - 0xFEE0).unwrap_or(ch),
            '\u{3000}' | '\u{00A0}' => ' ',
            '™' | '®' | '©' => ' ',
            other => other,
        };
        if mapped.is_ascii() {
            out.push(mapped.to_ascii_lowercase());
        } else {
            for lc in mapped.to_lowercase() {
                out.push(lc);
            }
        }
    }
    out
}

fn tokenize_alnum(input: &str) -> Vec<String> {
    let folded = fold_nfkc_lower(input);
    let mut tokens = Vec::new();
    let mut cur = String::new();
    for ch in folded.chars() {
        if ch.is_alphanumeric() {
            cur.push(ch);
        } else if !cur.is_empty() {
            tokens.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    tokens
}

pub fn is_listable_agent_script_path(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|s| s.to_str()) else {
        return false;
    };
    if !ALLOWED_EXTENSIONS
        .iter()
        .any(|allowed| ext.eq_ignore_ascii_case(allowed))
    {
        return false;
    }
    let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    if name.starts_with('_') {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    !lower.starts_with("lib")
}

/// Walk `dir` iteratively and return sorted listable `.js`/`.mjs`/`.cjs` script paths.
pub fn list_agent_script_files(dir: &Path) -> Vec<String> {
    if !dir.is_dir() {
        return Vec::new();
    }
    let mut files = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ft.is_symlink() {
                continue;
            }
            let path = entry.path();
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() && is_listable_agent_script_path(&path) {
                files.push(path.to_string_lossy().into_owned());
            }
        }
    }
    files.sort();
    files
}

fn exe_stem_lower(process_name: &str) -> String {
    let base = process_name
        .trim()
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .trim();
    let lower = fold_nfkc_lower(base);
    lower.strip_suffix(".exe").unwrap_or(&lower).to_owned()
}

pub fn is_switch_emulator_target(
    process_name: Option<&str>,
    window_title: Option<&str>,
) -> bool {
    if let Some(proc) = process_name.map(str::trim).filter(|s| !s.is_empty()) {
        let stem = exe_stem_lower(proc);
        if SWITCH_EMULATORS
            .iter()
            .any(|emu| stem == *emu || stem.starts_with(&format!("{emu}-")) || stem.starts_with(&format!("{emu}_")))
        {
            return true;
        }
    }
    if let Some(title) = window_title.map(str::trim).filter(|s| !s.is_empty()) {
        let folded = fold_nfkc_lower(title);
        if let Some(first_word) = tokenize_alnum(&folded).first() {
            if SWITCH_EMULATORS.contains(&first_word.as_str()) {
                return true;
            }
        }
    }
    false
}

fn find_16_hex_token(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut i = 0usize;
    while i + 16 <= bytes.len() {
        let before_ok = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
        if before_ok && bytes[i..i + 16].iter().all(|b| b.is_ascii_hexdigit()) {
            let after_ok = i + 16 == bytes.len() || !bytes[i + 16].is_ascii_alphanumeric();
            if after_ok {
                return std::str::from_utf8(&bytes[i..i + 16])
                    .ok()
                    .map(|s| s.to_ascii_uppercase());
            }
        }
        i += 1;
    }
    None
}

pub fn extract_title_id(
    explicit_game_id: Option<&str>,
    window_title: Option<&str>,
    process_name: Option<&str>,
) -> (Option<String>, bool) {
    if let Some(explicit) = explicit_game_id.and_then(find_16_hex_token) {
        return (Some(explicit), true);
    }
    if let Some(title) = window_title.and_then(find_16_hex_token) {
        return (Some(title), false);
    }
    if let Some(proc) = process_name.and_then(find_16_hex_token) {
        return (Some(proc), false);
    }
    (None, false)
}

pub fn is_switch_script_path(path: &str) -> bool {
    let name = Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    name.len() >= 3 && name[..3].eq_ignore_ascii_case("ns_")
}

pub fn find_agent_script_by_id(files: &[String], title_id: &str) -> Option<String> {
    let needle = title_id.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return None;
    }
    files
        .iter()
        .find(|p| {
            Path::new(p)
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|n| n.to_ascii_lowercase().contains(&needle))
        })
        .cloned()
}

fn is_ps_serial_token(token: &str) -> bool {
    if token.len() < 8 || token.len() > 12 {
        return false;
    }
    let prefixes = ["slpm", "slps", "slus", "sles", "scps", "scus", "npjh", "uljm", "bljm"];
    prefixes.iter().any(|p| token.starts_with(p)) && token[4..].bytes().all(|b| b.is_ascii_digit())
}

fn extract_script_title_tokens(path: &str) -> Vec<String> {
    let p = Path::new(path);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let mut parts: Vec<String> = tokenize_alnum(stem);

    // Strip known leading platform / publisher / engine / titleId / serial prefixes.
    let mut start = 0usize;
    while start < parts.len() {
        let tok = &parts[start];
        let is_hex16 = tok.len() == 16 && tok.bytes().all(|b| b.is_ascii_hexdigit());
        let is_ver = tok.starts_with('v') && tok.len() > 1 && tok[1..].bytes().all(|b| b.is_ascii_digit());
        if SCRIPT_METADATA_PREFIX_TOKENS.contains(&tok.as_str())
            || SCRIPT_REGION_OR_LANG_TOKENS.contains(&tok.as_str())
            || is_hex16
            || is_ps_serial_token(tok)
            || (is_ver && start == 0)
        {
            start += 1;
        } else if start <= 2 && matches!(tok.as_str(), "leaf" | "capcom" | "key" | "atlus" | "nintendo")
        {
            start += 1;
        } else {
            break;
        }
    }
    if start < parts.len() {
        parts = parts.split_off(start);
    }
    while parts.len() > 1
        && SCRIPT_REGION_OR_LANG_TOKENS.contains(&parts.last().unwrap().as_str())
    {
        parts.pop();
    }
    parts
}

#[derive(Clone, Debug)]
struct ScriptIndexEntry {
    path: String,
    tokens: Vec<String>,
    token_set: HashSet<String>,
    numbers: Vec<String>,
    compact: String,
}

impl ScriptIndexEntry {
    fn from_path(path: String) -> Self {
        let tokens = extract_script_title_tokens(&path);
        let token_set: HashSet<String> = tokens.iter().cloned().collect();
        let numbers: Vec<String> = tokens
            .iter()
            .filter(|t| t.bytes().all(|b| b.is_ascii_digit()))
            .cloned()
            .collect();
        let compact = tokens.concat();
        Self {
            path,
            tokens,
            token_set,
            numbers,
            compact,
        }
    }
}

fn clean_hint_tokens(raw: &str) -> Vec<String> {
    tokenize_alnum(raw)
        .into_iter()
        .filter(|tok| {
            !GENERIC_EXES.contains(&tok.as_str())
                && !SWITCH_EMULATORS.contains(&tok.as_str())
                && !STOP_WORDS.contains(&tok.as_str())
        })
        .collect()
}

/// Extract normalized title queries from capture context while ignoring generic emulator/engine names.
pub fn get_agent_script_search_queries(
    scene_name: Option<&str>,
    window_title: Option<&str>,
    process_name: Option<&str>,
) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut queries = Vec::new();
    let mut push_query = |raw: &str| {
        let cleaned = strip_emulator_title(raw);
        let tokens = clean_hint_tokens(&cleaned);
        if tokens.is_empty() {
            return;
        }
        let joined = tokens.join(" ");
        if seen.insert(joined.clone()) {
            queries.push(joined);
        }
    };

    if let Some(scene) = scene_name.map(str::trim).filter(|s| !s.is_empty()) {
        push_query(scene);
    }
    if let Some(title) = window_title.map(str::trim).filter(|s| !s.is_empty()) {
        // Split pipe-delimited engine/publisher titles (`CAPCOM | Game | DirectX 11`).
        let mut any_pipe_segment = false;
        if title.contains('|') {
            for seg in title.split('|') {
                let s = seg.trim();
                let seg_tokens = clean_hint_tokens(s);
                if seg_tokens.is_empty() {
                    continue;
                }
                let raw_toks = tokenize_alnum(s);
                let is_pure_meta = raw_toks.len() <= 2
                    && raw_toks.iter().all(|t| {
                        STOP_WORDS.contains(&t.as_str())
                            || SWITCH_EMULATORS.contains(&t.as_str())
                            || t.starts_with("fps")
                            || (t.starts_with('v') && t[1..].bytes().all(|b| b.is_ascii_digit()))
                            || matches!(t.as_str(), "nvidia" | "amd" | "msvc" | "capcom")
                    });
                if !is_pure_meta {
                    any_pipe_segment = true;
                    push_query(s);
                }
            }
        }
        if !any_pipe_segment {
            push_query(title);
        }
    }
    if let Some(proc) = process_name.map(str::trim).filter(|s| !s.is_empty()) {
        let stem = exe_stem_lower(proc);
        let meaningful = clean_hint_tokens(&stem);
        if !meaningful.is_empty() {
            let joined = meaningful.join(" ");
            if seen.insert(joined.clone()) {
                queries.push(joined);
            }
        }
    }
    queries
}

fn strip_emulator_title(raw: &str) -> String {
    let mut trimmed = raw.trim().to_owned();
    if trimmed.contains('|') {
        let parts: Vec<&str> = trimmed.split('|').map(str::trim).collect();
        if let Some(first) = parts.first() {
            let first_words = tokenize_alnum(first);
            let is_emu_header = first_words.iter().any(|w| {
                SWITCH_EMULATORS.contains(&w.as_str())
                    || matches!(w.as_str(), "vita3k" | "cemu" | "dolphin" | "citra" | "azahar" | "fps")
            });
            if is_emu_header {
                let candidates: Vec<&str> = parts
                    .iter()
                    .skip(1)
                    .copied()
                    .filter(|seg| {
                        let toks = tokenize_alnum(seg);
                        !toks.is_empty()
                            && !toks.iter().all(|t| {
                                STOP_WORDS.contains(&t.as_str())
                                    || t == "msvc"
                                    || t == "nvidia"
                                    || t == "amd"
                                    || (t.starts_with('v') && t[1..].bytes().all(|b| b.is_ascii_digit()))
                                    || t.bytes().all(|b| b.is_ascii_digit())
                            })
                    })
                    .collect();
                if let Some(best) = candidates.into_iter().max_by_key(|s| s.len()) {
                    trimmed = best.to_owned();
                }
            }
        }
    }
    // Trim trailing `(64-bit)` / `(32-bit)` / `[TitleID]` decorations.
    if let Some(idx) = trimmed.find("(64-bit)") {
        trimmed = trimmed[..idx].trim().to_owned();
    }
    if let Some(idx) = trimmed.find("(32-bit)") {
        trimmed = trimmed[..idx].trim().to_owned();
    }
    trimmed
}

fn bigrams(text: &str) -> HashMap<(char, char), usize> {
    let chars: Vec<char> = text.chars().collect();
    let mut map = HashMap::new();
    for pair in chars.windows(2) {
        *map.entry((pair[0], pair[1])).or_insert(0) += 1;
    }
    map
}

fn dice_similarity(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    if a.chars().count() < 2 || b.chars().count() < 2 {
        return if !a.is_empty() && a == b { 1.0 } else { 0.0 };
    }
    let map_a = bigrams(a);
    let map_b = bigrams(b);
    let len_a: usize = map_a.values().sum();
    let len_b: usize = map_b.values().sum();
    if len_a == 0 || len_b == 0 {
        return 0.0;
    }
    let mut overlap = 0usize;
    for (k, count_a) in &map_a {
        if let Some(count_b) = map_b.get(k) {
            overlap += (*count_a).min(*count_b);
        }
    }
    (2.0 * overlap as f64) / (len_a + len_b) as f64
}

fn numbers_conflict(a: &[String], b: &[String]) -> bool {
    !a.is_empty() && !b.is_empty() && a != b
}

fn score_single_hint(hint: &str, entry: &ScriptIndexEntry, query_mode: bool) -> (f64, &'static str) {
    if entry.tokens.is_empty() || entry.compact.is_empty() {
        return (1.0, "unmatched");
    }
    let hint_tokens: Vec<String> = tokenize_alnum(hint);
    if hint_tokens.is_empty() {
        return (1.0, "unmatched");
    }
    let hint_numbers: Vec<String> = hint_tokens
        .iter()
        .filter(|t| t.bytes().all(|b| b.is_ascii_digit()))
        .cloned()
        .collect();
    let hint_compact = hint_tokens.concat();

    // Numeric conflict (e.g. `Octopath Traveler 0` vs `Octopath Traveler 2`): never high confidence.
    if numbers_conflict(&hint_numbers, &entry.numbers) {
        return (0.48, "matched_fuzzy_name");
    }

    // Exact match.
    if hint_compact == entry.compact {
        return (0.04, "matched_name");
    }

    // Substring containment on compacted strings.
    let hint_in_script = hint_compact.len() >= 4 && entry.compact.contains(&hint_compact);
    let script_in_hint = entry.compact.len() >= 4 && hint_compact.contains(&entry.compact);

    if query_mode && (hint_in_script || script_in_hint) {
        return (0.06, "matched_name");
    }

    let hint_set: HashSet<&String> = hint_tokens.iter().collect();
    let shared_tokens = entry
        .token_set
        .iter()
        .filter(|t| hint_set.contains(t))
        .count();

    if hint_in_script || script_in_hint {
        // Numbers differ (`Persona` vs `Persona 4`) or extra meaningful tokens (`Persona 4 - Golden` vs `Persona 4`).
        if hint_numbers != entry.numbers || hint_tokens.len() != entry.tokens.len() {
            return (0.26, "matched_name");
        }
        return (0.08, "matched_name");
    }

    if shared_tokens == 0 {
        let dice = dice_similarity(&hint_compact, &entry.compact);
        if dice >= 0.45 {
            return ((1.0 - dice).max(0.22), "matched_fuzzy_name");
        }
        return (1.0, "unmatched");
    }

    let recall = shared_tokens as f64 / entry.tokens.len().max(1) as f64;
    let precision = shared_tokens as f64 / hint_tokens.len().max(1) as f64;
    let dice = dice_similarity(&hint_compact, &entry.compact);
    let similarity = 0.55 * (2.0 * recall * precision / (recall + precision).max(0.001)) + 0.45 * dice;

    if recall >= 0.99 && hint_tokens.len() <= entry.tokens.len() + 1 && hint_numbers == entry.numbers {
        (0.12 + (1.0 - similarity) * 0.2, "matched_name")
    } else if similarity >= 0.35 {
        let mut score = (1.0 - similarity).clamp(0.20, 0.89);
        if hint_numbers != entry.numbers {
            score = score.max(0.28);
        }
        (score, "matched_fuzzy_name")
    } else {
        (1.0, "unmatched")
    }
}

pub fn score_script_for_query(query: &str, script_path: &str) -> f64 {
    let entry = ScriptIndexEntry::from_path(script_path.to_owned());
    let mut best = 1.0f64;
    for seg in query.split('|') {
        let trimmed = seg.trim();
        if !trimmed.is_empty() {
            let (s, _) = score_single_hint(trimmed, &entry, true);
            best = best.min(s);
        }
    }
    let tokens = clean_hint_tokens(query);
    if !tokens.is_empty() {
        let (s, _) = score_single_hint(&tokens.join(" "), &entry, true);
        best = best.min(s);
    }
    best
}

fn score_entry_against_queries(
    entry: &ScriptIndexEntry,
    queries: &[String],
) -> (f64, &'static str) {
    let mut best_score = 1.0f64;
    let mut best_reason = "unmatched";
    let mut matching_hints = 0usize;
    for q in queries {
        let (s, reason) = score_single_hint(q, entry, false);
        if s < 0.50 {
            matching_hints += 1;
        }
        if s < best_score {
            best_score = s;
            best_reason = reason;
        }
    }
    if best_score <= 0.15 && matching_hints > 1 {
        let bonus = 0.01 * (matching_hints - 1).min(2) as f64;
        best_score = (best_score - bonus).max(0.02);
    }
    (best_score, best_reason)
}

#[cfg(test)]
pub fn score_script_for_context(
    scene_name: Option<&str>,
    window_title: Option<&str>,
    process_name: Option<&str>,
    script_path: &str,
) -> f64 {
    let queries = get_agent_script_search_queries(scene_name, window_title, process_name);
    if queries.is_empty() {
        return 1.0;
    }
    let entry = ScriptIndexEntry::from_path(script_path.to_owned());
    score_entry_against_queries(&entry, &queries).0
}

pub fn resolve_agent_script_from_files(
    files: &[String],
    scene_name: Option<&str>,
    window_title: Option<&str>,
    process_name: Option<&str>,
    explicit_game_id: Option<&str>,
) -> ResolveAgentScriptOutput {
    let is_switch_target = is_switch_emulator_target(process_name, window_title);
    let (title_id, is_explicit_id) =
        extract_title_id(explicit_game_id, window_title, process_name);

    let scoped_files: Vec<String> = files
        .iter()
        .filter(|path| !is_switch_target || is_switch_script_path(path))
        .cloned()
        .collect();

    if let Some(ref tid) = title_id {
        if let Some(matched) = find_agent_script_by_id(&scoped_files, tid) {
            let reason = if is_explicit_id {
                "matched_explicit_id"
            } else {
                "matched_title_id"
            };
            let score = if is_explicit_id { 0.0 } else { 0.01 };
            let candidate = AgentScriptCandidate {
                path: matched.clone(),
                reason: reason.into(),
                score,
            };
            return ResolveAgentScriptOutput {
                status: "success".into(),
                path: Some(matched),
                reason: reason.into(),
                is_exact_yuzu_id_match: is_explicit_id,
                is_switch_target,
                title_id,
                candidates: vec![candidate],
                process_name: process_name.map(str::to_owned),
                window_title: window_title.map(str::to_owned),
            };
        }
    }

    let queries = get_agent_script_search_queries(scene_name, window_title, process_name);
    if queries.is_empty() {
        return ResolveAgentScriptOutput {
            status: "not_found".into(),
            path: None,
            reason: "no_context".into(),
            is_exact_yuzu_id_match: false,
            is_switch_target,
            title_id,
            candidates: Vec::new(),
            process_name: process_name.map(str::to_owned),
            window_title: window_title.map(str::to_owned),
        };
    }

    let entries: Vec<ScriptIndexEntry> = scoped_files
        .into_iter()
        .map(ScriptIndexEntry::from_path)
        .collect();

    let mut candidates = Vec::new();
    for entry in entries {
        let (best_score, best_reason) = score_entry_against_queries(&entry, &queries);
        if best_score < 0.85 {
            candidates.push(AgentScriptCandidate {
                path: entry.path,
                reason: best_reason.into(),
                score: (best_score * 1000.0).round() / 1000.0,
            });
        }
    }

    candidates.sort_by(|a, b| {
        a.score
            .partial_cmp(&b.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.path.cmp(&b.path))
    });

    if let Some(top) = candidates.first().cloned() {
        let status = if top.score <= 0.15 { "success" } else { "not_found" };
        ResolveAgentScriptOutput {
            status: status.into(),
            path: if top.score <= 0.65 {
                Some(top.path.clone())
            } else {
                None
            },
            reason: top.reason,
            is_exact_yuzu_id_match: false,
            is_switch_target,
            title_id,
            candidates: candidates.into_iter().take(25).collect(),
            process_name: process_name.map(str::to_owned),
            window_title: window_title.map(str::to_owned),
        }
    } else {
        ResolveAgentScriptOutput {
            status: "not_found".into(),
            path: None,
            reason: "no_match".into(),
            is_exact_yuzu_id_match: false,
            is_switch_target,
            title_id,
            candidates: Vec::new(),
            process_name: process_name.map(str::to_owned),
            window_title: window_title.map(str::to_owned),
        }
    }
}

pub fn resolve_agent_script(input: &ResolveAgentScriptInput) -> ResolveAgentScriptOutput {
    let dir = Path::new(input.scripts_path.trim());
    let files = list_agent_script_files(dir);
    resolve_agent_script_from_files(
        &files,
        input.scene_name.as_deref(),
        input.window_title.as_deref(),
        input.process_name.as_deref(),
        input.explicit_game_id.as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use tempfile::tempdir;

    #[test]
    fn scans_tree_ignoring_private_and_library_scripts() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let visible = dir
            .path()
            .join("NS_01000AE01954A000_Unicorn_Overlord.js");
        let nested_visible = nested.join("PC_Example_Game.js");
        std::fs::write(&visible, "").unwrap();
        std::fs::write(&nested_visible, "").unwrap();
        std::fs::write(dir.path().join("_ExecutionWatch.js"), "").unwrap();
        std::fs::write(dir.path().join("libCitra.js"), "").unwrap();

        let listed = list_agent_script_files(dir.path());
        assert_eq!(listed.len(), 2);
        assert_eq!(
            find_agent_script_by_id(&listed, "01000AE01954A000").as_deref(),
            Some(visible.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn enforces_switch_isolation_explicit_ids_and_exe_hints() {
        let switch_script = "NS_0100A3501946E000_Octopath_Traveler_2.js".to_owned();
        let pc_script = "PC_Steam_Unreal_OCTOPATH_TRAVELER_0.js".to_owned();
        let files = vec![switch_script.clone(), pc_script.clone()];

        for emu in ["yuzu", "eden", "lichii"] {
            let res = resolve_agent_script_from_files(
                &files,
                Some("Octopath Traveler 0"),
                Some(&format!("{emu} | Octopath Traveler 0 (64-bit)")),
                Some(&format!("{emu}.exe")),
                None,
            );
            assert!(res.is_switch_target);
            assert_ne!(res.path.as_deref(), Some(pc_script.as_str()));
            assert!(res.candidates.iter().all(|c| c.path.starts_with("NS_")));
        }

        // Generic exes never fabricate script candidates.
        let generic_files = vec!["PC_Game_UnityPlayer_NW.js".to_owned()];
        for proc in ["game.exe", "UnityPlayer.exe", "main.exe", "yuzu.exe", "nw.exe"] {
            let res = resolve_agent_script_from_files(
                &generic_files,
                None,
                None,
                Some(proc),
                None,
            );
            assert!(res.candidates.is_empty(), "expected no candidates for {proc}");
        }

        // Corroborating context wins, and explicit ID beats conflicting title ID.
        let multi = vec![
            "PC_Tsukihime.js".to_owned(),
            "PC_Resident_Evil_HD_REMASTER.js".to_owned(),
            "PC_Unicorn_Overlord.js".to_owned(),
        ];
        let ranked = resolve_agent_script_from_files(
            &multi,
            Some("Tsukihime"),
            Some("Resident Evil HD REMASTER"),
            Some("ResidentEvil.exe"),
            None,
        );
        assert_eq!(
            ranked.candidates[0].path,
            "PC_Resident_Evil_HD_REMASTER.js"
        );
        assert!(ranked.candidates[0].score < ranked.candidates[1].score);

        // Executable match works even with generic scene/window title.
        let unicorn = resolve_agent_script_from_files(
            &multi,
            Some("My capture"),
            Some("Loading…"),
            Some("C:\\Games\\UnicornOverlord-Win64-Shipping.exe"),
            None,
        );
        assert_eq!(unicorn.path.as_deref(), Some("PC_Unicorn_Overlord.js"));
        assert!(unicorn.candidates[0].score <= 0.15);

        // Explicit Title ID vs window Title ID precedence.
        let switch_pair = vec![
            "NS_01000AE01954A000_Unicorn_Overlord.js".to_owned(),
            "NS_01001DC01486A000_Tsukihime.js".to_owned(),
        ];
        let detected = resolve_agent_script_from_files(
            &switch_pair,
            Some("Tsukihime"),
            Some("lichii | Tsukihime [01000AE01954A000]"),
            Some("lichii.exe"),
            None,
        );
        assert_eq!(detected.reason, "matched_title_id");
        assert_eq!(detected.path.as_deref(), Some("NS_01000AE01954A000_Unicorn_Overlord.js"));

        let explicit = resolve_agent_script_from_files(
            &switch_pair,
            Some("Tsukihime"),
            Some("lichii | Tsukihime [01000AE01954A000]"),
            Some("lichii.exe"),
            Some("01001DC01486A000"),
        );
        assert_eq!(explicit.reason, "matched_explicit_id");
        assert_eq!(explicit.path.as_deref(), Some("NS_01001DC01486A000_Tsukihime.js"));
    }

    #[test]
    fn scoring_guards_partial_and_separator_queries() {
        let re = "C:\\Agent\\data\\scripts\\PC_Steam_Resident_Evil_HD_REMASTER.js";
        assert!(score_script_for_query("ResidentEvil", re) < 0.1);
        assert!(
            score_script_for_query("CAPCOM | Resident Evil HD REMASTER™ | DirectX 11", re) < 0.1
        );
        assert_eq!(
            get_agent_script_search_queries(None, Some("Lichii"), Some("LICHII.EXE")),
            Vec::<String>::new()
        );
        assert_eq!(
            get_agent_script_search_queries(None, Some("Lichii | ANONYMOUS;CODE"), Some("lichii.exe")),
            vec!["anonymous code".to_owned()]
        );
        assert!(
            score_script_for_context(
                Some("Persona"),
                Some("Persona"),
                Some("Persona.exe"),
                "PC_Persona_4.js"
            ) > 0.15
        );
        assert!(
            score_script_for_context(Some("Octopath Traveler 0"), None, None, "PC_Octopath_Traveler_2.js")
                > 0.15
        );
        assert!(
            score_script_for_context(None, Some("Persona 4 - Golden"), None, "PC_Persona_4.js")
                > 0.15
        );
    }

    #[test]
    fn bench_resolve_against_500_scripts() {
        let dir = tempdir().unwrap();
        for i in 0..499 {
            let name = if i % 4 == 0 {
                format!("NS_01000AE0{:08X}_Sample_Switch_Game_{}.js", i, i)
            } else {
                format!("PC_Steam_Sample_Game_Title_{}.js", i)
            };
            std::fs::write(dir.path().join(name), "").unwrap();
        }
        let target = dir.path().join("PC_Steam_Unity_Target_Chronicle_Zero.js");
        std::fs::write(&target, "").unwrap();

        let input = ResolveAgentScriptInput {
            scripts_path: dir.path().to_string_lossy().into_owned(),
            scene_name: Some("Target Chronicle Zero".into()),
            window_title: Some("Target Chronicle Zero (64-bit)".into()),
            process_name: Some("TargetChronicleZero-Win64-Shipping.exe".into()),
            explicit_game_id: None,
        };

        let start = Instant::now();
        let output = resolve_agent_script(&input);
        let first_ms = start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(
            output.path.as_deref(),
            Some(target.to_string_lossy().as_ref())
        );

        let files = list_agent_script_files(dir.path());
        let iters = 20u64;
        let match_start = Instant::now();
        for _ in 0..iters {
            let r = resolve_agent_script_from_files(
                &files,
                input.scene_name.as_deref(),
                input.window_title.as_deref(),
                input.process_name.as_deref(),
                None,
            );
            std::hint::black_box(&r);
        }
        let match_ms = match_start.elapsed().as_secs_f64() * 1000.0 / iters as f64;
        println!(
            "[bench] agent_scripts 500_scripts full_walk_and_resolve_ms={:.3} in_memory_rank_ms={:.3}",
            first_ms, match_ms
        );
    }
}
