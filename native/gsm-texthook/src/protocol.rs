use regex::Regex;
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::LazyLock};

const RAW_LIMIT: usize = 14_096;
const HOOK_LIMIT: usize = 1024;
static LUNA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[#([0-9a-fA-F]+)\|([^\]]+)\] (.*)$").unwrap());
static CREATED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\[Hook #([0-9a-fA-F]+) created\] Handle: [0-9a-fA-F]+$").unwrap()
});
static TEXTRACTOR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\[([0-9a-fA-F]+):[^:]+:[^:]+:[^:]+:[^:]+:([^:]+):([^\]]+)\] (.*)$").unwrap()
});
static NOISE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"%D\$vl\d+;").unwrap());
static ARCH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\barchitecture mismatch:\s*only\s+(?:[A-Za-z0-9_.-]+\s+)*(x86|x64)\s+can inject\b",
    )
    .unwrap()
});
static SELECTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Selected hook(?: #[0-9a-fA-F]+(?: \(Handle: [0-9a-fA-F]+\))?|: [0-9a-fA-F]+)(?:\s*Now showing text only from (?:selected hook|\d+ selected hook\(s\))\.)?$").unwrap()
});
static SHOWING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Now showing text (?:from all hooks|only from (?:selected hook|\d+ selected hook\(s\)))\.$").unwrap()
});

pub enum Event {
    Text(Value),
    Hooks(Value),
    Log(String),
    Command(String),
    Architecture(String),
}
#[derive(Default)]
struct Hook {
    name: String,
    preview: String,
    samples: Vec<String>,
    pending: String,
    due: Option<u64>,
}
/// All time values are supplied by the actor; tests never need timers or a game.
pub struct Session {
    pub options: Value,
    byte: Option<u8>,
    line: Vec<u16>,
    dropping: bool,
    continuation: Option<(String, String, bool)>,
    hooks: BTreeMap<String, Hook>,
    selected: Option<String>,
    last_text: Option<String>,
    pending: Vec<Value>,
    due: Option<u64>,
    events: Vec<Event>,
    dirty: bool,
}
pub fn truncate(text: &str, units: usize) -> String {
    let mut count = 0;
    text.chars()
        .take_while(|c| {
            count += c.len_utf16();
            count <= units
        })
        .collect()
}
fn length(text: &str) -> usize {
    text.encode_utf16().count()
}
fn sanitize(text: &str, limit: usize) -> Option<String> {
    if length(text) > 10_000 || (text.matches('「').count() > 10 && text.matches('」').count() > 10)
    {
        None
    } else {
        Some(truncate(text, limit))
    }
}
fn ignorable(line: &str) -> bool {
    [
        "Usage:",
        "After attaching,",
        "After 10 texts,",
        "Commands:",
        "attach -P",
        "detach -P",
        "select <handle>",
        "showall",
        "=== HOOK SELECTION ===",
        "You've seen text from multiple hooks above.",
        "To select specific hooks",
        "Example: select",
        "To see all hooks",
        "To continue with current selection",
        "======================",
    ]
    .iter()
    .any(|p| line.starts_with(p))
        || SELECTED.is_match(line)
        || SHOWING.is_match(line)
}
fn matches(saved: &str, name: &str) -> bool {
    saved == name
        || name
            .rsplit_once(" (")
            .is_some_and(|(base, suffix)| suffix.ends_with(')') && saved == base)
}
impl Session {
    pub fn new(options: Value) -> Self {
        Self {
            options,
            byte: None,
            line: Vec::new(),
            dropping: false,
            continuation: None,
            hooks: BTreeMap::new(),
            selected: None,
            last_text: None,
            pending: vec![],
            due: None,
            events: vec![],
            dirty: false,
        }
    }
    fn limit(&self) -> usize {
        self.options["maxBufferSize"]
            .as_u64()
            .unwrap_or(3000)
            .clamp(1, 100_000) as usize
    }
    fn delay(&self) -> u64 {
        self.options["flushDelayMs"]
            .as_u64()
            .unwrap_or(100)
            .min(5000)
    }
    pub fn status(&self) -> Value {
        json!({"running":true,"engine":self.options["engine"],"pid":self.options["pid"],"arch":self.options["arch"],
            "exeName":self.options["exeName"],"source":self.options["source"],"selectedHookId":self.selected,
            "hookCount":self.hooks.len(),"flushDelayMs":self.delay(),"copyToClipboard":self.options["copyToClipboard"]==true})
    }
    pub fn hooks(&self) -> Value {
        json!({"selectedHookId":self.selected,"hooks":self.hooks.iter().map(|(id,h)|json!({"id":id,"function":h.name,"preview":h.preview,"samples":h.samples})).collect::<Vec<_>>()})
    }
    pub fn drain(&mut self) -> Vec<Event> {
        if self.dirty {
            self.events.push(Event::Hooks(self.hooks()));
            self.dirty = false;
        }
        std::mem::take(&mut self.events)
    }
    // Frame UTF-16 code units before decoding: odd bytes AND split surrogate pairs
    // survive pipe reads. Oversized frames are discarded through the next newline.
    pub fn feed(&mut self, bytes: &[u8], now: u64) {
        for &b in bytes {
            let Some(first) = self.byte.take() else {
                self.byte = Some(b);
                continue;
            };
            let unit = u16::from_le_bytes([first, b]);
            if unit == 10 {
                if !self.dropping {
                    let line = String::from_utf16_lossy(&self.line);
                    self.parse(line.trim_end_matches(['\0', '\r']).trim(), now);
                }
                self.line.clear();
                self.dropping = false;
            } else if !self.dropping {
                if self.line.len() == RAW_LIMIT {
                    self.dropping = true;
                    self.line.clear();
                    self.continuation = None;
                    self.events
                        .push(Event::Log("Discarded oversized hook output line.".into()));
                } else {
                    self.line.push(unit);
                }
            }
        }
    }
    pub fn diagnostic(&mut self, text: &str) {
        self.events.push(Event::Log(format!("[Engine] {text}")));
        if let Some(c) = ARCH.captures(text) {
            self.continuation = None;
            self.events
                .push(Event::Architecture(c[1].to_ascii_lowercase()));
        }
    }
    fn parse(&mut self, line: &str, now: u64) {
        if line.is_empty() {
            return;
        }
        if ignorable(line) {
            self.continuation = None;
            return;
        }
        if ARCH.is_match(line) || line.starts_with("[Console]") {
            self.diagnostic(line);
            self.continuation = None;
            return;
        }
        let parsed = if self.options["engine"] == "textractor" {
            TEXTRACTOR.captures(line).map(|c| {
                (
                    c[1].to_owned(),
                    c[2].to_owned(),
                    c[4].to_owned(),
                    c[2] == *"Console" || c[2] == *"Clipboard" || c[3] == *"HB0@0",
                )
            })
        } else {
            if let Some(c) = CREATED.captures(line) {
                self.record(&c[1], &format!("Hook #{}", &c[1]), "", now);
                self.continuation = None;
                return;
            }
            LUNA.captures(line).map(|c| {
                let parts: Vec<_> = c[2].split(':').collect();
                let name = if parts.len() >= 6 {
                    let ctx = if parts[4].is_empty() {
                        parts[3].to_owned()
                    } else {
                        format!("{}:{}", parts[3], parts[4])
                    };
                    if ctx.is_empty() {
                        parts[5].to_owned()
                    } else {
                        format!("{} ({ctx})", parts[5])
                    }
                } else {
                    parts[parts.len().saturating_sub(2)].to_owned()
                };
                (c[1].to_owned(), name, c[3].to_owned(), false)
            })
        };
        if let Some((id, name, text, ignored)) = parsed {
            if name == "Console" {
                self.diagnostic(&text);
                self.continuation = None;
                return;
            }
            self.continuation = Some((id.clone(), name.clone(), ignored));
            if !ignored {
                self.record(&id, &name, &text, now);
            }
        } else if !line.starts_with('[') && self.continuation.is_some() {
            let (id, name, ignored) = self.continuation.clone().unwrap();
            if !ignored {
                self.record(&id, &name, line, now);
            }
        } else {
            self.events.push(Event::Log(format!("[raw] {line}")));
            self.continuation = None;
        }
    }
    fn record(&mut self, id: &str, name: &str, text: &str, now: u64) {
        let input = NOISE.replace_all(text, "");
        let Some(text) = sanitize(&input, self.limit()) else {
            return;
        };
        if !self.hooks.contains_key(id) && self.hooks.len() >= HOOK_LIMIT {
            return;
        }
        if self.selected.as_deref() == Some(id)
            && !text.is_empty()
            && self.last_text.as_deref() == Some(&input)
        {
            return;
        }
        let limit = self.limit();
        let delay = self.delay();
        let h = self.hooks.entry(id.into()).or_insert_with(|| Hook {
            name: name.into(),
            ..Default::default()
        });
        if h.name.starts_with("Hook #") {
            h.name = name.into();
        }
        if !text.is_empty() {
            let remaining = limit.saturating_sub(length(&h.pending));
            if remaining > 0 {
                if !h.pending.is_empty() {
                    h.pending.push('\n');
                }
                h.pending.push_str(&truncate(&text, remaining));
                h.due = Some(now + delay);
            }
        } else {
            self.dirty = true;
        }
        if self.selected.is_none() {
            let saved = self.options["autoSelectHookFunction"]
                .as_str()
                .unwrap_or("");
            let id_match = self.options["autoSelectHookId"] == id;
            if (id_match && (saved.is_empty() || matches(saved, &h.name)))
                || (!saved.is_empty() && matches(saved, &h.name))
            {
                self.select(id, now);
            }
        }
        if self.selected.as_deref() == Some(id) {
            if text.is_empty() {
                self.last_text = None;
            } else {
                self.last_text = Some(input.into_owned());
                let mut payload = json!({"text":text,"hookId":id,"hookFunction":name,"engine":self.options["engine"],"exeName":self.options["exeName"],
                    "copyToClipboard":self.options["copyToClipboard"]==true,"capturedAt":now,"revisionWindowMs":0,"mergeFragments":false});
                if let Some(previous) = self.pending.last_mut() {
                    let old = previous["text"].as_str().unwrap();
                    if text.starts_with(old) {
                        payload["capturedAt"] = previous["capturedAt"].clone();
                        *previous = payload;
                    } else if !old.starts_with(&text) {
                        self.pending.push(payload);
                    }
                } else {
                    self.pending.push(payload);
                }
                self.due = Some(now + delay);
                if self
                    .pending
                    .iter()
                    .map(|v| length(v["text"].as_str().unwrap()) + 1)
                    .sum::<usize>()
                    >= limit
                {
                    self.flush_text();
                }
            }
        }
        self.tick(now);
    }
    pub fn select(&mut self, id: &str, _now: u64) -> bool {
        if !self.hooks.contains_key(id) {
            return false;
        }
        self.flush_text();
        self.selected = Some(id.into());
        self.last_text = None;
        self.dirty = true;
        self.events.push(Event::Command(format!("select {id}\n")));
        true
    }
    pub fn manual(&self, code: &str) -> Result<String, String> {
        let code = code.trim();
        if !code.starts_with(['H', 'h', 'R', 'r'])
            || !code.contains('@')
            || code.contains(['\r', '\n', '\0'])
            || code.len() > 4096
        {
            return Err("Invalid hook code. Expected a single H- or R-code.".into());
        }
        Ok(format!(
            "{code} -P{}\n",
            self.options["attachPid"]
                .as_u64()
                .or(self.options["pid"].as_u64())
                .unwrap_or_default()
        ))
    }
    fn flush_text(&mut self) {
        self.due = None;
        if self.pending.is_empty() {
            return;
        }
        let text = self
            .pending
            .iter()
            .map(|v| v["text"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        let captured = self.pending[0]["capturedAt"].clone();
        let mut payload = self.pending.last().unwrap().clone();
        self.pending.clear();
        if let Some(text) = sanitize(&text, self.limit()) {
            payload["text"] = json!(text);
            payload["capturedAt"] = captured;
            self.events.push(Event::Text(payload));
        }
    }
    pub fn tick(&mut self, now: u64) {
        if self.due.is_some_and(|due| due <= now) {
            self.flush_text();
        }
        for h in self.hooks.values_mut() {
            if h.due.is_some_and(|due| due <= now) {
                let text = std::mem::take(&mut h.pending);
                h.due = None;
                h.preview = truncate(&text, 80);
                if length(&text) > 80 {
                    h.preview.push('…');
                }
                let sample = truncate(&text, 2000);
                if !sample.trim().is_empty() {
                    h.samples.retain(|s| *s != sample);
                    h.samples.push(sample);
                    if h.samples.len() > 5 {
                        h.samples.remove(0);
                    }
                }
                self.dirty = true;
            }
        }
    }
    pub fn flush(&mut self) {
        self.tick(u64::MAX);
    }
    pub fn configure(&mut self, key: &str, value: Value, now: u64) {
        self.options[key] = value;
        if key == "maxBufferSize" {
            self.flush();
        }
        if key == "flushDelayMs" {
            let delay = self.delay();
            if self.due.is_some() {
                self.due = Some(now + delay);
            }
            for h in self.hooks.values_mut() {
                if h.due.is_some() {
                    h.due = Some(now + delay);
                }
            }
        }
        self.tick(now);
    }
}
