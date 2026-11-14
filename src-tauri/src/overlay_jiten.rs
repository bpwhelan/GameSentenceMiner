//! High-performance Jiten Reader API cache, rate limiter, character-budget enforcer,
//! batching coalescer, overlap token remapper, write-receipt deduplicator, and
//! local vocabulary WebSocket client.
//!
//! Replaces `GSM_Overlay/jiten_cache.js`, `GSM_Overlay/jiten_session.js`, and
//! `GSM_Overlay/local_vocabulary.js` with shared keep-alive TLS connections and bounded memory.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio_tungstenite::{connect_async, tungstenite::Message};

pub const DEFAULT_JITEN_PARSE_URL: &str = "https://api.jiten.moe/api/reader/parse";
pub const DEFAULT_JITEN_API_BASE: &str = "https://api.jiten.moe/api";
#[allow(dead_code)]
pub const DEFAULT_ANKI_CONNECT_URL: &str = "http://127.0.0.1:8765";

const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_CACHE_ENTRIES: usize = 2000;
const MAX_CACHE_BYTES: usize = 16 * 1024 * 1024;
const CHAR_BUDGET_LIMIT: usize = 60_000;
const CHAR_BUDGET_WINDOW: Duration = Duration::from_secs(60);
const MIN_REQUEST_INTERVAL: Duration = Duration::from_millis(1000);

const MAX_BATCH_TEXTS: usize = 24;
const MAX_BATCH_CHARS: usize = 3000;
const WRITE_RECEIPT_TTL: Duration = Duration::from_secs(300);
const STATE_TTL: Duration = Duration::from_secs(300);

pub(crate) fn browser_error_status(error: &str) -> u16 {
    if let Some((_, tail)) = error.split_once("HTTP ") {
        if let Some(status) = tail
            .split(|c: char| !c.is_ascii_digit())
            .next()
            .and_then(|s| s.parse::<u16>().ok())
            .filter(|code| (400..600).contains(code))
        {
            return status;
        }
    }
    if error.contains("unconfirmed") || error.contains("reused") {
        409
    } else if error.contains("rate") || error.contains("budget") || error.contains("Too many") {
        429
    } else if error.contains("too large") {
        413
    } else if error.contains("not configured") {
        401
    } else if error.starts_with("Invalid")
        || error.starts_with("Missing")
        || error.starts_with("Unsupported")
    {
        400
    } else {
        503
    }
}

/// Recognize only the bundled Reader's JSON API, preserving custom API bases.
pub(crate) fn broker_route(raw: &str) -> Option<(String, String)> {
    let mut url = url::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.query().is_some() {
        return None;
    }
    let path = url.path().trim_end_matches('/');
    let actions = [
        "reader/parse",
        "reader/lookup-vocabulary",
        "reader/ping",
        "srs/reader-study-decks",
        "srs/review",
        "srs/set-vocabulary-state",
        "srs/add-vocabulary",
        "srs/remove-vocabulary",
        "srs/batch-review",
        "set-card-sentence",
    ];
    let action = actions
        .iter()
        .find(|action| path.ends_with(&format!("/{action}")))
        .map(|v| v.to_string())
        .or_else(|| {
            let (_, tail) = path.rsplit_once("/srs/study-decks/")?;
            let id = tail.strip_suffix("/words")?;
            (!id.is_empty() && id.bytes().all(|c| c.is_ascii_digit()))
                .then(|| format!("srs/study-decks/{id}/words"))
        })?;
    let base = &path[..path.len() - action.len()];
    url.set_path(&format!("{base}reader/parse"));
    url.set_fragment(None);
    Some((url.to_string(), action))
}

fn state_key(scope: &str, word: &Value) -> String {
    format!(
        "{scope}|{}|{}",
        word["wordId"],
        word["readingIndex"].as_u64().unwrap_or(0)
    )
}

pub fn derive_jiten_api_base(endpoint_or_url: &str) -> String {
    let trimmed = endpoint_or_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return DEFAULT_JITEN_API_BASE.to_string();
    }
    if let Ok(mut parsed) = url::Url::parse(trimmed) {
        let path = parsed.path().trim_end_matches('/').to_string();
        if let Some(base) = path.strip_suffix("/reader/parse") {
            parsed.set_path(base);
        } else if let Some(pos) = path.find("/api/") {
            parsed.set_path(&path[..pos + 4]);
        } else if path.ends_with("/api") {
            parsed.set_path(&path);
        } else {
            parsed.set_path("/api");
        }
        parsed.set_query(None);
        parsed.set_fragment(None);
        return parsed.to_string().trim_end_matches('/').to_string();
    }
    DEFAULT_JITEN_API_BASE.to_string()
}

pub fn derive_parse_url(endpoint_or_url: &str) -> String {
    let trimmed = endpoint_or_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return DEFAULT_JITEN_PARSE_URL.to_string();
    }
    if trimmed.ends_with("/reader/parse") {
        return trimmed.to_string();
    }
    format!("{}/reader/parse", derive_jiten_api_base(trimmed))
}

pub fn api_key_fingerprint(api_key: &str) -> String {
    let digest = Sha256::digest(api_key.trim().as_bytes());
    let mut out = String::with_capacity(12);
    for byte in &digest[..6] {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[derive(Clone, Debug)]
struct CachedParseEntry {
    key: String,
    scope: String,
    text: String,
    normalized_text: String,
    payload: Value,
    approx_bytes: usize,
    inserted_at: Instant,
    seq: u64,
}

#[derive(Default)]
struct CacheInner {
    entries: HashMap<String, CachedParseEntry>,
    total_bytes: usize,
    seq_counter: u64,
    // Ordered timestamps + character counts within CHAR_BUDGET_WINDOW.
    char_window: VecDeque<(Instant, usize)>,
    last_upstream_at: Option<Instant>,
    // Pending write receipts keyed by (scope, op, request_id) -> (inserted_at, result)
    write_receipts: HashMap<String, (Instant, Value)>,
    vocabulary_states: HashMap<String, (Instant, Value, Value)>,
    cooldowns: HashMap<String, Instant>,
    stats: JitenStats,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JitenStats {
    pub cache_hits: u64,
    pub overlap_hits: u64,
    pub coalesce_hits: u64,
    pub upstream_requests: u64,
    pub cache_entries: usize,
    pub cache_bytes: usize,
    pub budget_used_chars: usize,
}

/// Normalize whitespace & noisy Japanese punctuation for fuzzy substring overlap reuse.
pub fn normalize_for_overlap(text: &str) -> (String, Vec<usize>) {
    let mut norm = String::with_capacity(text.len());
    let mut byte_map = Vec::with_capacity(text.len());
    for (byte_idx, ch) in text.char_indices() {
        if ch.is_whitespace()
            || matches!(
                ch,
                '「' | '」' | '『' | '』' | '（' | '）' | '…' | '・' | '　'
            )
        {
            continue;
        }
        norm.push(ch);
        byte_map.push(byte_idx);
    }
    (norm, byte_map)
}

/// Attempt to reuse cached tokens when `new_text` shares >= 80% contiguous prefix/suffix/substring
/// with an existing cached line for the same API key & endpoint. Returns a cloned & shifted JSON
/// payload only if every token cleanly maps inside `new_text` without crossing boundaries.
pub fn try_remap_overlap(new_text: &str, cached_text: &str, payload: &Value) -> Option<Value> {
    if new_text == cached_text {
        return Some(payload.clone());
    }
    let new_chars: usize = new_text.encode_utf16().count();
    let old_chars: usize = cached_text.encode_utf16().count();
    if new_chars == 0 || old_chars == 0 {
        return None;
    }
    // Strict fast path: `new_text` contains the entirety of `cached_text` OR `cached_text`
    // contains the entirety of `new_text` when lengths differ by <= 4 trailing chars (punctuation/cursor).
    if let Some(byte_offset) = cached_text.find(new_text) {
        let char_offset = cached_text[..byte_offset].encode_utf16().count();
        let end_char = char_offset + new_chars;
        if new_chars * 10 >= old_chars * 8 {
            return shift_payload_window(payload, char_offset, end_char, -(char_offset as isize));
        }
    }
    if new_text.contains(cached_text) && old_chars * 10 >= new_chars * 8 {
        // Only when suffix/prefix difference has no alphanumeric/kanji characters.
        let byte_offset = new_text.find(cached_text)?;
        let prefix = &new_text[..byte_offset];
        let suffix = &new_text[byte_offset + cached_text.len()..];
        let benign = |s: &str| {
            s.chars().all(|c| {
                c.is_whitespace()
                    || c.is_ascii_punctuation()
                    || matches!(c, '。' | '、' | '！' | '？' | '…' | '」' | '』')
            })
        };
        if benign(prefix) && benign(suffix) {
            let char_offset = prefix.encode_utf16().count() as isize;
            return shift_payload_window(payload, 0, old_chars, char_offset);
        }
    }
    None
}

fn shift_payload_window(
    payload: &Value,
    min_start: usize,
    max_end: usize,
    delta: isize,
) -> Option<Value> {
    let rows = payload["tokens"].as_array()?;
    let nested = rows.first().is_some_and(Value::is_array);
    let tokens = if nested {
        rows.first()?.as_array()?
    } else {
        rows
    };
    let mut kept = Vec::new();
    for token in tokens {
        let start = token["start"].as_u64()? as usize;
        let end = token["length"]
            .as_u64()
            .map(|n| start + n as usize)
            .or_else(|| token["end"].as_u64().map(|n| n as usize))?;
        // Never clip a word into a different word at a crop boundary.
        if (start < min_start && end > min_start) || (start < max_end && end > max_end) {
            return None;
        }
        if start >= min_start && end <= max_end {
            let mut token = token.clone();
            token["start"] = json!((start as isize + delta).max(0));
            if token.get("end").is_some() {
                token["end"] = json!((end as isize + delta).max(0));
            }
            kept.push(token);
        }
    }
    let mut result = payload.clone();
    result["tokens"] = if nested { json!([kept]) } else { json!(kept) };
    Some(result)
}

#[derive(Clone)]
pub struct JitenParseCache {
    http: reqwest::Client,
    inner: Arc<Mutex<CacheInner>>,
    frames: Arc<Mutex<HashMap<String, u64>>>,
    requests: Arc<tokio::sync::Mutex<()>>,
}

impl JitenParseCache {
    /// Both browser-extension and overlay callers use the same queue and cache.
    pub async fn browser_request(
        &self,
        url: &str,
        method: &str,
        key: &str,
        request_id: Option<&str>,
        body: &[u8],
    ) -> Result<Value, String> {
        let (endpoint, action) = broker_route(url).ok_or("Unsupported Jiten request")?;
        if body.len() > 1024 * 1024 {
            return Err("Jiten request body too large".into());
        }
        let payload: Value = if body.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(body).map_err(|_| "Invalid Jiten request JSON")?
        };
        if action == "reader/parse" {
            let texts: Vec<String> = payload["text"]
                .as_array()
                .ok_or("Missing Jiten text")?
                .iter()
                .map(|v| v.as_str().map(str::to_owned).ok_or("Invalid Jiten text"))
                .collect::<Result<_, _>>()?;
            return self.parse_texts(&texts, key, &endpoint, None).await;
        }
        if action == "reader/lookup-vocabulary" {
            let _queue = self.requests.lock().await;
            return self
                .lookup_vocabulary(
                    payload["words"].as_array().ok_or("Missing Jiten words")?,
                    key,
                    &endpoint,
                )
                .await;
        }
        let read =
            method == "GET" || matches!(action.as_str(), "reader/ping" | "srs/reader-study-decks");
        if !read {
            if method != "POST" {
                return Err("Unsupported Jiten request method".into());
            }
            let operation = match action.as_str() {
                "srs/review" => "review",
                "srs/set-vocabulary-state" => "set-state",
                other => other,
            };
            return self
                .idempotent_write(operation, key, url, request_id, payload)
                .await;
        }
        let _queue = self.requests.lock().await;
        let mut request = self
            .http
            .request(
                reqwest::Method::from_bytes(method.as_bytes())
                    .map_err(|_| "Invalid Jiten method")?,
                url,
            )
            .header("Authorization", format!("ApiKey {}", key.trim()))
            .timeout(Duration::from_secs(15));
        if !payload.is_null() {
            request = request.json(&payload);
        }
        let response = request.send().await.map_err(|_| "Jiten request failed")?;
        if !response.status().is_success() {
            return Err(format!("Jiten API HTTP {}", response.status().as_u16()));
        }
        response
            .json()
            .await
            .map_err(|_| "Invalid Jiten response".into())
    }

    pub fn new(http: reqwest::Client) -> Self {
        Self {
            http,
            inner: Arc::new(Mutex::new(CacheInner::default())),
            frames: Arc::new(Mutex::new(HashMap::new())),
            requests: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    #[allow(dead_code)]
    pub fn stats(&self) -> JitenStats {
        let mut guard = self.inner.lock().unwrap();
        let now = Instant::now();
        prune_char_window(&mut guard.char_window, now);
        guard.stats.cache_entries = guard.entries.len();
        guard.stats.cache_bytes = guard.total_bytes;
        guard.stats.budget_used_chars = guard.char_window.iter().map(|(_, n)| *n).sum();
        guard.stats.clone()
    }

    pub fn next_frame_generation(&self, sender: &str) -> u64 {
        let mut frames = self.frames.lock().unwrap();
        let next = frames.get(sender).copied().unwrap_or(0).saturating_add(1);
        frames.insert(sender.to_string(), next);
        next
    }

    pub fn cancel_frame(&self, sender: &str) {
        self.next_frame_generation(sender);
    }

    pub fn is_frame_current(&self, sender: &str, generation: u64) -> bool {
        self.frames.lock().unwrap().get(sender).copied() == Some(generation)
    }

    fn cache_key(scope: &str, text: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(scope.as_bytes());
        hasher.update(b"\x00");
        hasher.update(text.as_bytes());
        let digest = hasher.finalize();
        let mut hex = String::with_capacity(32);
        for b in &digest[..16] {
            hex.push_str(&format!("{b:02x}"));
        }
        hex
    }

    fn lookup_cached_locked(
        inner: &mut CacheInner,
        scope: &str,
        text: &str,
        now: Instant,
    ) -> Option<Value> {
        let key = Self::cache_key(scope, text);
        if let Some(entry) = inner.entries.get_mut(&key) {
            if now.duration_since(entry.inserted_at) <= CACHE_TTL {
                inner.seq_counter += 1;
                entry.seq = inner.seq_counter;
                inner.stats.cache_hits += 1;
                return Some(entry.payload.clone());
            }
            let bytes = entry.approx_bytes;
            inner.entries.remove(&key);
            inner.total_bytes = inner.total_bytes.saturating_sub(bytes);
        }

        // Fast bounded overlap scan on most recent cached entries sharing the same scope
        let (norm_q, _) = normalize_for_overlap(text);
        if norm_q.len() >= 6 {
            let candidate = inner
                .entries
                .values()
                .filter(|e| e.scope == scope && now.duration_since(e.inserted_at) <= CACHE_TTL)
                .max_by_key(|e| e.seq)
                .and_then(|e| {
                    if !e.normalized_text.is_empty()
                        && (e.text.contains(text) || text.contains(&e.text))
                    {
                        try_remap_overlap(text, &e.text, &e.payload)
                    } else {
                        None
                    }
                });
            if let Some(remapped) = candidate {
                inner.stats.overlap_hits += 1;
                return Some(remapped);
            }
        }
        None
    }

    fn insert_cached_locked(
        inner: &mut CacheInner,
        scope: &str,
        text: &str,
        payload: Value,
        now: Instant,
    ) {
        for word in payload["vocabulary"].as_array().into_iter().flatten() {
            inner.vocabulary_states.insert(
                state_key(scope, word),
                (
                    now,
                    word["knownState"].clone(),
                    word.get("studyDeckIds").cloned().unwrap_or(json!([])),
                ),
            );
        }
        if inner.vocabulary_states.len() > MAX_CACHE_ENTRIES * 32 {
            inner
                .vocabulary_states
                .retain(|_, (at, _, _)| now.saturating_duration_since(*at) < STATE_TTL);
            let excess = inner
                .vocabulary_states
                .len()
                .saturating_sub(MAX_CACHE_ENTRIES * 32);
            if excess > 0 {
                let mut oldest: Vec<_> = inner
                    .vocabulary_states
                    .iter()
                    .map(|(key, (at, _, _))| (key.clone(), *at))
                    .collect();
                oldest.sort_unstable_by_key(|(_, at)| *at);
                for (key, _) in oldest.into_iter().take(excess) {
                    inner.vocabulary_states.remove(&key);
                }
            }
        }
        let key = Self::cache_key(scope, text);
        let approx_bytes = payload.to_string().len() + text.len() + 128;
        let (normalized_text, _) = normalize_for_overlap(text);
        if let Some(old) = inner.entries.remove(&key) {
            inner.total_bytes = inner.total_bytes.saturating_sub(old.approx_bytes);
        }
        inner.seq_counter += 1;
        let seq = inner.seq_counter;
        inner.total_bytes += approx_bytes;
        inner.entries.insert(
            key.clone(),
            CachedParseEntry {
                key,
                scope: scope.to_string(),
                text: text.to_string(),
                normalized_text,
                payload,
                approx_bytes,
                inserted_at: now,
                seq,
            },
        );

        while inner.entries.len() > MAX_CACHE_ENTRIES || inner.total_bytes > MAX_CACHE_BYTES {
            let Some(oldest_key) = inner
                .entries
                .values()
                .min_by_key(|e| e.seq)
                .map(|e| e.key.clone())
            else {
                break;
            };
            if let Some(removed) = inner.entries.remove(&oldest_key) {
                inner.total_bytes = inner.total_bytes.saturating_sub(removed.approx_bytes);
            }
        }
    }

    pub async fn parse(&self, text: &str, api_key: &str, endpoint: &str) -> Result<Value, String> {
        self.parse_texts(&[text.to_owned()], api_key, endpoint, None)
            .await
    }

    pub async fn parse_frame(
        &self,
        sender: &str,
        texts: &[String],
        api_key: &str,
        endpoint: &str,
    ) -> Result<Value, String> {
        let generation = self.next_frame_generation(sender);
        self.parse_texts(texts, api_key, endpoint, Some((sender, generation)))
            .await
    }

    async fn parse_texts(
        &self,
        texts: &[String],
        api_key: &str,
        endpoint: &str,
        frame: Option<(&str, u64)>,
    ) -> Result<Value, String> {
        if texts.len() > 2048 {
            return Err("Too many Jiten paragraphs".into());
        }
        let clean_key = api_key.trim();
        if clean_key.is_empty() {
            return Err("Jiten API key is not configured".into());
        }
        let current =
            || frame.is_none_or(|(sender, generation)| self.is_frame_current(sender, generation));
        // The queue also serializes writes. A waiter rechecks cache after acquiring
        // it, so identical in-flight reads share the result without lost wakeups.
        let _queue = self.requests.lock().await;
        if !current() {
            return Err("Jiten request superseded".into());
        }
        let parse_url = derive_parse_url(endpoint);
        let scope = format!("{}|{}", api_key_fingerprint(clean_key), parse_url);
        let mut results = vec![None; texts.len()];
        let mut missing = Vec::new();
        {
            let mut cache = self.inner.lock().unwrap();
            for (i, text) in texts.iter().enumerate() {
                if text.trim().is_empty() {
                    results[i] = Some(json!({"tokens":[[]],"vocabulary":[]}));
                } else if let Some(hit) =
                    Self::lookup_cached_locked(&mut cache, &scope, text, Instant::now())
                {
                    results[i] = Some(hit);
                } else {
                    missing.push(i);
                }
            }
        }
        let mut offset = 0;
        while offset < missing.len() {
            if !current() {
                return Err("Jiten request superseded".into());
            }
            if self
                .inner
                .lock()
                .unwrap()
                .cooldowns
                .get(&scope)
                .is_some_and(|at| *at > Instant::now())
            {
                return Err("Jiten is temporarily rate limited; wait before trying again".into());
            }
            let mut end = offset;
            let mut chars = 0;
            while end < missing.len() && end - offset < MAX_BATCH_TEXTS {
                let count = texts[missing[end]].encode_utf16().count();
                if count > CHAR_BUDGET_LIMIT {
                    return Err("Jiten paragraph exceeds the character budget".into());
                }
                if end > offset && chars + count > MAX_BATCH_CHARS {
                    break;
                }
                chars += count;
                end += 1;
            }
            let delay = {
                let mut cache = self.inner.lock().unwrap();
                let now = Instant::now();
                prune_char_window(&mut cache.char_window, now);
                if cache.char_window.iter().map(|(_, n)| *n).sum::<usize>() + chars
                    > CHAR_BUDGET_LIMIT
                {
                    return Err("Jiten Reader character rate budget temporarily exceeded".into());
                }
                cache.char_window.push_back((now, chars));
                cache.last_upstream_at.and_then(|at| {
                    MIN_REQUEST_INTERVAL.checked_sub(now.saturating_duration_since(at))
                })
            };
            if let Some(delay) = delay {
                tokio::time::sleep(delay).await;
            }
            if !current() {
                return Err("Jiten request superseded".into());
            }
            {
                let mut cache = self.inner.lock().unwrap();
                cache.last_upstream_at = Some(Instant::now());
                cache.stats.upstream_requests += 1;
            }
            let batch: Vec<&str> = missing[offset..end]
                .iter()
                .map(|&i| texts[i].as_str())
                .collect();
            let response = self
                .http
                .post(&parse_url)
                .header("Authorization", format!("ApiKey {clean_key}"))
                .json(&json!({"text":batch}))
                .timeout(Duration::from_secs(15))
                .send()
                .await
                .map_err(|e| format!("Jiten request failed: {e}"))?;
            let status = response.status();
            if status.as_u16() == 429 || status.as_u16() == 503 {
                let seconds = response
                    .headers()
                    .get("retry-after")
                    .and_then(|s| s.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(60)
                    .clamp(1, 3600);
                self.inner
                    .lock()
                    .unwrap()
                    .cooldowns
                    .insert(scope.clone(), Instant::now() + Duration::from_secs(seconds));
            }
            let body: Value = response
                .json()
                .await
                .map_err(|e| format!("Invalid Jiten response: {e}"))?;
            if !status.is_success() || body.get("error_message").is_some() {
                return Err(format!(
                    "Jiten API HTTP {}: {}",
                    status.as_u16(),
                    body["error_message"]
                        .as_str()
                        .or_else(|| body["message"].as_str())
                        .unwrap_or("Request failed")
                ));
            }
            let rows = body["tokens"]
                .as_array()
                .filter(|rows| rows.len() == batch.len())
                .ok_or("Invalid Jiten token rows")?;
            let vocabulary = body["vocabulary"]
                .as_array()
                .ok_or("Invalid Jiten vocabulary")?;
            let mut split = Vec::new();
            for (text, row) in batch.iter().zip(rows) {
                let tokens = row.as_array().ok_or("Invalid Jiten tokens")?;
                let limit = text.encode_utf16().count() as u64;
                for token in tokens {
                    let start = token["start"].as_u64().ok_or("Invalid Jiten offset")?;
                    let length = token["length"]
                        .as_u64()
                        .or_else(|| token["end"].as_u64().and_then(|end| end.checked_sub(start)))
                        .ok_or("Invalid Jiten length")?;
                    if start.checked_add(length).is_none_or(|end| end > limit)
                        || !vocabulary.iter().any(|word| {
                            word["wordId"] == token["wordId"]
                                && word["readingIndex"].as_u64().unwrap_or(0)
                                    == token["readingIndex"].as_u64().unwrap_or(0)
                        })
                    {
                        return Err("Invalid Jiten token offsets or vocabulary reference".into());
                    }
                }
                split.push(json!({"tokens":[row],"vocabulary":vocabulary}));
            }
            let mut cache = self.inner.lock().unwrap();
            for (&i, payload) in missing[offset..end].iter().zip(split) {
                Self::insert_cached_locked(
                    &mut cache,
                    &scope,
                    &texts[i],
                    payload.clone(),
                    Instant::now(),
                );
                results[i] = Some(payload);
            }
            offset = end;
        }
        if !current() {
            return Err("Jiten request superseded".into());
        }
        let mut tokens = Vec::new();
        let mut vocabulary = std::collections::BTreeMap::new();
        for payload in results.into_iter().flatten() {
            tokens.push(payload["tokens"][0].clone());
            for word in payload["vocabulary"].as_array().into_iter().flatten() {
                vocabulary.insert(
                    (
                        word["wordId"].as_i64().unwrap_or(0),
                        word["readingIndex"].as_i64().unwrap_or(0),
                    ),
                    word.clone(),
                );
            }
        }
        let mut words: Vec<Value> = vocabulary.into_values().collect();
        let stale: Vec<usize> = {
            let cache = self.inner.lock().unwrap();
            words
                .iter_mut()
                .enumerate()
                .filter_map(|(i, word)| {
                    if let Some((at, state, decks)) =
                        cache.vocabulary_states.get(&state_key(&scope, word))
                    {
                        word["knownState"] = state.clone();
                        word["studyDeckIds"] = decks.clone();
                        if at.elapsed() < STATE_TTL {
                            return None;
                        }
                    }
                    Some(i)
                })
                .collect()
        };
        if !stale.is_empty() {
            let refs: Vec<Value> = stale
                .iter()
                .map(|&i| {
                    json!([
                        words[i]["wordId"],
                        words[i]["readingIndex"].as_u64().unwrap_or(0)
                    ])
                })
                .collect();
            // Preserve cached readings and the last known state while offline.
            if let Ok(states) = self.lookup_vocabulary(&refs, clean_key, endpoint).await {
                if states["result"]
                    .as_array()
                    .is_some_and(|rows| rows.len() == refs.len())
                {
                    let mut cache = self.inner.lock().unwrap();
                    for (j, &i) in stale.iter().enumerate() {
                        words[i]["knownState"] = states["result"][j].clone();
                        words[i]["studyDeckIds"] =
                            states["decks"].get(j).cloned().unwrap_or(json!([]));
                        cache.vocabulary_states.insert(
                            state_key(&scope, &words[i]),
                            (
                                Instant::now(),
                                words[i]["knownState"].clone(),
                                words[i]["studyDeckIds"].clone(),
                            ),
                        );
                    }
                }
            }
        }
        if !current() {
            return Err("Jiten request superseded".into());
        }
        Ok(json!({"tokens":tokens,"vocabulary":words}))
    }

    pub async fn review_card(
        &self,
        word_id: i64,
        reading_index: i64,
        rating: Value,
        api_key: &str,
        endpoint: &str,
        request_id: Option<&str>,
    ) -> Result<Value, String> {
        let base = derive_jiten_api_base(endpoint);
        self.idempotent_write(
            "review",
            api_key,
            &format!("{base}/srs/review"),
            request_id,
            json!({
                "wordId": word_id,
                "readingIndex": reading_index,
                "rating": rating,
            }),
        )
        .await
    }

    pub async fn set_vocabulary_state(
        &self,
        word_id: i64,
        reading_index: i64,
        state: &str,
        api_key: &str,
        endpoint: &str,
        request_id: Option<&str>,
    ) -> Result<Value, String> {
        let base = derive_jiten_api_base(endpoint);
        self.idempotent_write(
            "set-state",
            api_key,
            &format!("{base}/srs/set-vocabulary-state"),
            request_id,
            json!({
                "wordId": word_id,
                "readingIndex": reading_index,
                "state": state,
            }),
        )
        .await
    }

    async fn idempotent_write(
        &self,
        op: &str,
        api_key: &str,
        url: &str,
        request_id: Option<&str>,
        payload: Value,
    ) -> Result<Value, String> {
        let _queue = self.requests.lock().await;
        let clean_key = api_key.trim();
        if clean_key.is_empty() {
            return Err("Jiten API key is not configured".into());
        }
        let receipt_key = request_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|id| format!("{}|{url}|{op}|{id}", api_key_fingerprint(clean_key)));
        let explicit_receipt = receipt_key.is_some();
        // Reader retries do not always carry an ID. Keep an uncertainty receipt
        // for an identical write until its outcome is known, without suppressing
        // legitimate repeated actions after a confirmed success.
        let receipt_key = receipt_key.or_else(|| {
            Some(format!(
                "{}|{url}|{op}|anonymous:{:x}",
                api_key_fingerprint(clean_key),
                Sha256::digest(payload.to_string().as_bytes())
            ))
        });

        if let Some(ref rk) = receipt_key {
            let mut guard = self.inner.lock().unwrap();
            let now = Instant::now();
            guard
                .write_receipts
                .retain(|_, (ts, _)| now.duration_since(*ts) <= WRITE_RECEIPT_TTL);
            if let Some((_, cached)) = guard.write_receipts.get(rk) {
                if cached["request"] != payload {
                    return Err("Jiten request ID was reused with different data".into());
                }
                if let Some(error) = cached["error"].as_str() {
                    return Err(error.into());
                }
                return Ok(cached["result"].clone());
            }
            if guard.write_receipts.len() >= MAX_CACHE_ENTRIES {
                return Err("Too many pending Jiten writes".into());
            }
            // Record uncertainty before sending: a timeout may follow a successful
            // remote grade, so retrying the same operation must not grade twice.
            guard.write_receipts.insert(rk.clone(),(now,json!({"request":payload,"error":"The previous Jiten write has an unconfirmed outcome. Refresh the word before issuing another grade."})));
        }

        let response = self
            .http
            .post(url)
            .header("Authorization", format!("ApiKey {clean_key}"))
            .header("Accept", "application/json")
            .json(&payload)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("Jiten write request failed: {e}"))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .unwrap_or(json!({ "ok": status.is_success() }));
        if !status.is_success() {
            let msg = body
                .get("error_message")
                .or_else(|| body.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Jiten write error");
            return Err(format!("Jiten API HTTP {}: {msg}", status.as_u16()));
        }

        {
            let prefix = format!("{}|", api_key_fingerprint(clean_key));
            let mut cache = self.inner.lock().unwrap();
            cache
                .entries
                .retain(|_, entry| !entry.scope.starts_with(&prefix));
            cache
                .vocabulary_states
                .retain(|key, _| !key.starts_with(&prefix));
            cache.total_bytes = cache.entries.values().map(|entry| entry.approx_bytes).sum();
        }
        if let Some(rk) = receipt_key {
            let mut cache = self.inner.lock().unwrap();
            if explicit_receipt {
                cache.write_receipts.insert(
                    rk,
                    (Instant::now(), json!({"request":payload,"result":body})),
                );
            } else {
                cache.write_receipts.remove(&rk);
            }
        }
        Ok(body)
    }

    #[allow(dead_code)]
    pub async fn lookup_vocabulary(
        &self,
        words: &[Value],
        api_key: &str,
        endpoint: &str,
    ) -> Result<Value, String> {
        let clean_key = api_key.trim();
        if clean_key.is_empty() {
            return Err("Jiten API key is not configured".into());
        }
        let base = derive_jiten_api_base(endpoint);
        let url = format!("{base}/reader/lookup-vocabulary");
        let response = self
            .http
            .post(&url)
            .header("Authorization", format!("ApiKey {clean_key}"))
            .header("Accept", "application/json")
            .json(&json!({ "words": words }))
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("Jiten lookup request failed: {e}"))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|e| format!("Invalid lookup JSON: {e}"))?;
        if !status.is_success() {
            return Err(format!("Jiten lookup HTTP {}", status.as_u16()));
        }
        Ok(body)
    }
}

fn prune_char_window(window: &mut VecDeque<(Instant, usize)>, now: Instant) {
    while let Some((ts, _)) = window.front() {
        if now.duration_since(*ts) > CHAR_BUDGET_WINDOW {
            window.pop_front();
        } else {
            break;
        }
    }
}

/// Send a local vocabulary RPC over WebSocket to `gsm_overlay_server`.
pub async fn local_vocabulary_ws_request(ws_url: &str, request: Value) -> Result<Value, String> {
    let (mut socket, _) = connect_async(ws_url)
        .await
        .map_err(|e| format!("Input server unavailable ({ws_url}): {e}"))?;
    socket
        .send(Message::Text(
            json!({ "type": "configure_features", "features": ["sudachi"] })
                .to_string()
                .into(),
        ))
        .await
        .map_err(|e| e.to_string())?;

    let req_id = format!(
        "vocabulary-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let mut ready = false;
    while let Some(frame) = socket.next().await {
        let msg = frame.map_err(|e| e.to_string())?;
        if let Message::Text(text) = msg {
            let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            match parsed.get("type").and_then(Value::as_str) {
                Some("service_info") => {
                    if parsed.get("vocabularyProtocol").and_then(Value::as_i64) != Some(1) {
                        return Err(
                            "The Rust input server needs to be rebuilt for local vocabulary".into(),
                        );
                    }
                    ready = true;
                    socket
                        .send(Message::Text(
                            json!({
                                "type": "local_vocabulary",
                                "requestId": req_id,
                                "request": request,
                            })
                            .to_string()
                            .into(),
                        ))
                        .await
                        .map_err(|e| e.to_string())?;
                }
                Some("local_vocabulary")
                    if parsed.get("requestId").and_then(Value::as_str) == Some(req_id.as_str()) =>
                {
                    if let Some(err) = parsed.get("error").and_then(Value::as_str) {
                        return Err(err.to_string());
                    }
                    return Ok(parsed.get("result").cloned().unwrap_or(Value::Null));
                }
                _ => {
                    let _ = ready;
                }
            }
        }
    }
    Err("Input server closed before local vocabulary reply".into())
}

/// Normalize a reading/word for Anki word export matching (`GSM_Overlay/local_vocabulary.js`).
#[allow(dead_code)]
pub fn extract_jiten_words_from_export(data: &Value) -> Vec<(String, Vec<String>)> {
    let mut words = Vec::new();
    let Some(cards) = data.get("cards").and_then(Value::as_array) else {
        return words;
    };
    for card in cards {
        let Some(states_arr) = card.get("states").and_then(Value::as_array) else {
            continue;
        };
        let states: Vec<String> = states_arr
            .iter()
            .filter_map(|v| v.as_str().map(str::trim).filter(|s| !s.is_empty()))
            .map(str::to_string)
            .collect();
        if states.is_empty() {
            continue;
        }
        let spelling = card
            .get("wordText")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if !spelling.is_empty() {
            words.push((spelling.to_string(), states));
        }
    }
    words
}

/// Filter unique strings preserving order.
#[allow(dead_code)]
pub fn unique_nonempty_texts<'a>(texts: &'a [String]) -> Vec<&'a str> {
    let mut seen = HashSet::with_capacity(texts.len());
    let mut out = Vec::with_capacity(texts.len());
    for t in texts {
        let trimmed = t.trim();
        if !trimmed.is_empty() && seen.insert(trimmed) {
            out.push(trimmed);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_batch_cache_and_preserve_renderer_contract() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/api/reader/parse", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicUsize::new(0));
        let seen = requests.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let (start, length) = loop {
                    let mut buffer = [0u8; 4096];
                    let n = socket.read(&mut buffer).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buffer[..n]);
                    if let Some(index) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..index]).to_ascii_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap();
                        if bytes.len() >= index + 4 + length {
                            break (index + 4, length);
                        }
                    }
                };
                let body: Value = serde_json::from_slice(&bytes[start..start + length]).unwrap();
                seen.fetch_add(1, Ordering::SeqCst);
                // The upstream may accept a grade and lose the response.
                if body["wordId"] == 9 {
                    continue;
                }
                let tokens: Vec<Value> = body["text"].as_array().into_iter().flatten().map(|text| json!([{
                    "wordId":1,"readingIndex":0,"start":0,"length":text.as_str().unwrap().encode_utf16().count()
                }])).collect();
                let reply = if body.get("words").is_some() { json!({"result":[[2]],"decks":[[42]]}) }
                    else if body.get("rating").is_some() { json!({"ok":true}) }
                    else { json!({"tokens":tokens,"vocabulary":[{"wordId":1,"readingIndex":0,"knownState":[0]}]}) }.to_string();
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",reply.len()).as_bytes()).await.unwrap();
            }
        });
        let cache = JitenParseCache::new(reqwest::Client::new());
        let texts = vec![" 猫".into(), "犬𠮷".into()];
        let result = cache
            .parse_frame("overlay", &texts, "test-key", &endpoint)
            .await
            .unwrap();
        assert_eq!(result["tokens"].as_array().map(Vec::len), Some(2));
        assert_eq!(result["tokens"][1][0]["length"], 3);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        let again = cache
            .parse_frame("overlay", &texts, "test-key", &endpoint)
            .await
            .unwrap();
        assert_eq!(again, result);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        let browser = cache
            .browser_request(
                &endpoint,
                "POST",
                "test-key",
                None,
                &serde_json::to_vec(&json!({"text":texts})).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(browser, result);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        for (at, _, _) in cache.inner.lock().unwrap().vocabulary_states.values_mut() {
            *at = Instant::now() - STATE_TTL - Duration::from_secs(1);
        }
        let fresh = cache
            .parse_frame("overlay", &texts, "test-key", &endpoint)
            .await
            .unwrap();
        assert_eq!(fresh["tokens"], result["tokens"]);
        assert_eq!(fresh["vocabulary"][0]["knownState"], json!([2]));
        assert_eq!(fresh["vocabulary"][0]["studyDeckIds"], json!([42]));
        assert_eq!(requests.load(Ordering::SeqCst), 2);
        cache
            .review_card(1, 0, json!(3), "test-key", &endpoint, Some("grade-1"))
            .await
            .unwrap();
        cache
            .review_card(1, 0, json!(3), "test-key", &endpoint, Some("grade-1"))
            .await
            .unwrap();
        assert!(cache
            .review_card(2, 0, json!(3), "test-key", &endpoint, Some("grade-1"))
            .await
            .is_err());
        assert_eq!(requests.load(Ordering::SeqCst), 3);
        cache
            .browser_request(
                &format!("{}/srs/review", derive_jiten_api_base(&endpoint)),
                "POST",
                "test-key",
                Some("grade-1"),
                &serde_json::to_vec(&json!({"wordId":1,"readingIndex":0,"rating":3})).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            requests.load(Ordering::SeqCst),
            3,
            "Browser and overlay must share write receipts"
        );
        assert!(cache
            .review_card(9, 0, json!(3), "test-key", &endpoint, None)
            .await
            .is_err());
        assert_eq!(requests.load(Ordering::SeqCst), 4);
        assert!(cache
            .review_card(9, 0, json!(3), "test-key", &endpoint, None)
            .await
            .is_err());
        assert_eq!(
            requests.load(Ordering::SeqCst),
            4,
            "An uncertain anonymous grade was sent twice"
        );
        server.abort();
    }

    #[test]
    fn api_base_derivation_and_fingerprint_stay_private() {
        assert_eq!(
            broker_route("https://example.test/private/v2/reader/parse"),
            Some((
                "https://example.test/private/v2/reader/parse".into(),
                "reader/parse".into()
            ))
        );
        assert!(broker_route("https://example.test/reader/parse?token=x").is_none());
        assert!(broker_route("file:///api/reader/parse").is_none());
        assert_eq!(
            derive_jiten_api_base("https://example.test/private/v2/reader/parse"),
            "https://example.test/private/v2"
        );
        assert_eq!(
            derive_jiten_api_base("https://api.jiten.moe/api/reader/parse"),
            "https://api.jiten.moe/api"
        );
        assert_eq!(
            derive_parse_url("http://127.0.0.1:8080/api"),
            "http://127.0.0.1:8080/api/reader/parse"
        );
        let fp = api_key_fingerprint("secret-key-123");
        assert_eq!(fp.len(), 12);
        assert!(!fp.contains("secret"));
    }

    #[test]
    fn cache_evicts_and_remaps_overlap() {
        let mut inner = CacheInner::default();
        let now = Instant::now();
        let payload = json!({
            "tokens": [
                { "wordId": 1, "start": 0, "end": 2 },
                { "wordId": 2, "start": 2, "end": 5 }
            ]
        });
        JitenParseCache::insert_cached_locked(&mut inner, "scope", "今日は晴れ。", payload, now);
        let hit = JitenParseCache::lookup_cached_locked(&mut inner, "scope", "今日は晴れ", now)
            .expect("prefix overlap should hit");
        assert_eq!(hit["tokens"].as_array().unwrap().len(), 2);
        assert_eq!(inner.stats.overlap_hits, 1);
    }

    #[test]
    fn benchmark_jiten_cache_and_overlap_1k_calls() {
        let mut inner = CacheInner::default();
        let now = Instant::now();
        let sample = json!({
            "tokens": [
                { "wordId": 10, "start": 0, "end": 3 },
                { "wordId": 20, "start": 3, "end": 7 },
                { "wordId": 30, "start": 7, "end": 12 }
            ]
        });
        for i in 0..100 {
            JitenParseCache::insert_cached_locked(
                &mut inner,
                "k|u",
                &format!("サンプル文章{i}ですよ。"),
                sample.clone(),
                now,
            );
        }
        let started = Instant::now();
        let mut hits = 0u64;
        for i in 0..1000 {
            let key = format!("サンプル文章{}ですよ。", i % 100);
            if JitenParseCache::lookup_cached_locked(&mut inner, "k|u", &key, now).is_some() {
                hits += 1;
            }
        }
        let elapsed = started.elapsed();
        assert_eq!(hits, 1000);
        println!(
            "[bench] jiten_cache_lookup_1k total_ms={:.3} us_per_lookup={:.2}",
            elapsed.as_secs_f64() * 1000.0,
            elapsed.as_secs_f64() * 1_000_000.0 / 1000.0
        );
    }
}
