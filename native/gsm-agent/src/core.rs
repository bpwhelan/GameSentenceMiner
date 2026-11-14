use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
pub type Event = (String, Value);
fn plain_path(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn truncate(text: &str, limit: usize) -> String {
    let mut n = 0;
    text.chars()
        .take_while(|c| {
            n += c.len_utf16();
            n <= limit
        })
        .collect()
}
fn sanitize(text: &str, limit: usize) -> Option<String> {
    if text.encode_utf16().count() > 10_000
        || (text.matches('「').count() > 10 && text.matches('」').count() > 10)
    {
        None
    } else {
        Some(truncate(text, limit))
    }
}
pub fn string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        _ => v.to_string(),
    }
}
fn safe_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._-".contains(c) {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}
fn read(path: &Path) -> Result<Vec<u8>, String> {
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > 32 * 1024 * 1024 {
        return Err("Agent file exceeds 32 MiB".into());
    }
    fs::read(path).map_err(|e| e.to_string())
}
fn encode(text: &str, encoding: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    match encoding.to_ascii_lowercase().as_str() {
        "utf8" | "utf-8" => Ok(text.as_bytes().to_vec()),
        "utf16le" | "utf-16le" | "ucs2" | "ucs-2" => {
            Ok(text.encode_utf16().flat_map(u16::to_le_bytes).collect())
        }
        "latin1" | "binary" | "ascii" => Ok(text.encode_utf16().map(|v| v as u8).collect()),
        "base64" => base64::engine::general_purpose::STANDARD
            .decode(text)
            .map_err(|e| e.to_string()),
        "hex" => text
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                std::str::from_utf8(pair)
                    .map_err(|e| e.to_string())
                    .and_then(|s| u8::from_str_radix(s, 16).map_err(|e| e.to_string()))
            })
            .collect(),
        _ => Err(format!("Unsupported file encoding: {encoding}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        dir: PathBuf,
        core: Core,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("gsm-agent-unit-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("game.js"), "// game").unwrap();
            fs::write(dir.join("libLoader.js"), "// loader").unwrap();
            let mut core=Core::new(json!({"scriptPath":dir.join("game.js"),"baseDir":dir,"pid":123,"flushDelayMs":100})).unwrap();
            core.begin_attempt();
            Self { dir, core }
        }
        fn send(&mut self, payload: Value) -> Option<Value> {
            self.core.message(
                self.core.attempt,
                json!({"type":"send","payload":payload}),
                None,
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
    #[test]
    fn cumulative_text_preserves_capture_time_and_unicode() {
        let mut f = Fixture::new();
        f.core.copy("日本", 100);
        f.core.copy("日本語🦀", 200);
        f.core.copy("日本", 300);
        f.core.flush();
        let outputs: Vec<_> = f
            .core
            .drain()
            .into_iter()
            .filter(|(c, _)| c == "agent.text")
            .collect();
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].1["text"], "日本語🦀");
        assert_eq!(outputs[0].1["capturedAt"], 100);
        assert_eq!(outputs[0].1["sessionId"], f.core.id);
    }
    #[test]
    fn independent_lines_and_stop_flush() {
        let mut f = Fixture::new();
        f.core.copy("first", 100);
        f.core.copy("second", 200);
        f.core.stop();
        let outputs: Vec<_> = f
            .core
            .drain()
            .into_iter()
            .filter(|(c, _)| c == "agent.text")
            .collect();
        assert_eq!(outputs[0].1["text"], "first\nsecond");
        assert_eq!(outputs[0].1["capturedAt"], 100);
        assert!(f.core.state()["status"].is_null());
    }
    #[test]
    fn rejection_and_surrogate_safe_limit() {
        assert_eq!(truncate("日🦀語", 2), "日");
        assert!(sanitize(&"a".repeat(10001), 3000).is_none());
        let mut f = Fixture::new();
        f.core.configure("flushDelayMs", json!(0));
        f.core.configure("maxBufferSize", json!(4));
        f.core.copy("日本語🦀", 100);
        assert!(f
            .core
            .drain()
            .iter()
            .any(|(c, v)| c == "agent.text" && v["text"] == "日本語"));
    }
    #[test]
    fn initialization_failure_retry_and_optional_hooks() {
        let mut f = Fixture::new();
        f.core.message(
            f.core.attempt,
            json!({"type":"log","payload":"Mono not found!"}),
            None,
        );
        f.core.message(
            f.core.attempt,
            json!({"type":"error","description":"setHook undefined"}),
            None,
        );
        assert!(f.core.retryable(&f.core.init_error().unwrap()));
        f.core.begin_attempt();
        f.core.message(
            f.core.attempt,
            json!({"type":"log","payload":"Hook not found! optional"}),
            None,
        );
        assert!(f.core.init_error().is_some());
        f.core.message(
            f.core.attempt,
            json!({"type":"log","payload":"Attach: present hook"}),
            None,
        );
        assert!(f.core.init_error().is_none());
        f.send(json!({"cmd":"__gsm_agent_initialized"}));
        f.core.ready();
        assert_eq!(f.core.status()["agentPhase"], "waiting");
    }
    #[test]
    fn stale_attempt_and_stopped_messages_are_ignored() {
        let mut f = Fixture::new();
        let old = f.core.attempt;
        f.core.begin_attempt();
        f.core.message(
            old,
            json!({"type":"send","payload":{"cmd":"copy","text":"stale"}}),
            None,
        );
        assert!(f.core.drain().is_empty());
        f.core.stop();
        f.core.drain();
        f.send(json!({"cmd":"copy","text":"late"}));
        assert!(f.core.drain().is_empty());
    }
    #[test]
    fn storage_persists_but_session_storage_does_not() {
        let mut f = Fixture::new();
        assert_eq!(
            f.send(json!({"cmd":"localStorage_setItem","args":["key","日本語🦀"],"key":1}))
                .unwrap()["result"],
            true
        );
        f.send(json!({"cmd":"sessionStorage_setItem","args":["temp","value"]}));
        let mut restored = Core::new(f.core.options.clone()).unwrap();
        assert_eq!(
            restored
                .storage("localStorage_getItem", &[json!("key")])
                .unwrap(),
            "日本語🦀"
        );
        assert_eq!(
            restored
                .storage("sessionStorage_getItem", &[json!("temp")])
                .unwrap(),
            Value::Null
        );
        f.send(json!({"cmd":"localStorage_setItem","args":["key","updated"]}));
        assert_eq!(
            Core::new(f.core.options.clone())
                .unwrap()
                .storage("localStorage_getItem", &[json!("key")])
                .unwrap(),
            "updated"
        );
    }
    #[test]
    fn filesystem_module_resolution_binary_and_encodings() {
        let mut f = Fixture::new();
        fs::write(f.dir.join("module.js"), "日本語").unwrap();
        let stat = f.core.remote("_statPath", &[json!("module")]).unwrap();
        assert_eq!(stat["isFile"], true);
        assert_eq!(
            f.core
                .remote("fs_readFileSync", &[json!("module"), json!("utf8")])
                .unwrap(),
            "日本語"
        );
        assert_eq!(
            f.core
                .remote(
                    "fs_writeFileSync",
                    &[json!("output.txt"), json!("日本語🦀"), json!("utf16le")]
                )
                .unwrap(),
            true
        );
        assert_eq!(
            f.core
                .remote("fs_readFileSync", &[json!("output.txt"), json!("utf16le")])
                .unwrap(),
            "日本語🦀"
        );
        assert_eq!(
            f.core
                .remote("fs_readFileSync", &[json!("module"), Value::Null])
                .unwrap()["type"],
            "Buffer"
        );
        assert!(encode("語", "hex").is_err());
    }
    #[test]
    fn script_ui_messages_are_session_scoped() {
        let mut f = Fixture::new();
        f.send(json!({"cmd":"loadHtml","text":"<html>controls</html>","fileName":"controls.html"}));
        f.send(json!({"cmd":"rpc_send","func":"update","args":["日本語"]}));
        assert_eq!(f.core.status()["agentHasUi"], true);
        assert!(f.core.drain().iter().any(|(c, p)| c == "agent-ui.rpc-event"
            && p["sessionId"] == f.core.id
            && p["args"][0] == "日本語"));
    }
}
fn decode(bytes: &[u8], encoding: &str) -> Result<String, String> {
    use base64::Engine;
    match encoding.to_ascii_lowercase().as_str() {
        "utf8" | "utf-8" => Ok(String::from_utf8_lossy(bytes).into_owned()),
        "utf16le" | "utf-16le" | "ucs2" | "ucs-2" => Ok(String::from_utf16_lossy(
            &bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect::<Vec<_>>(),
        )),
        "latin1" | "binary" => Ok(bytes.iter().map(|b| *b as char).collect()),
        "ascii" => Ok(bytes.iter().map(|b| (b & 127) as char).collect()),
        "base64" => Ok(base64::engine::general_purpose::STANDARD.encode(bytes)),
        "hex" => Ok(bytes.iter().map(|b| format!("{b:02x}")).collect()),
        _ => Err(format!("Unsupported file encoding: {encoding}")),
    }
}
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("File has no parent directory")?)
        .map_err(|e| e.to_string())?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, bytes)
        .and_then(|_| fs::rename(&temp, path))
        .map_err(|e| {
            let _ = fs::remove_file(&temp);
            e.to_string()
        })
}
#[derive(Default)]
pub struct Initialization {
    pub completed: bool,
    pub error: Option<String>,
    pub mono_missing: bool,
    pub hook_missing: bool,
    pub has_hook: bool,
}
pub struct Core {
    pub options: Value,
    pub id: String,
    pub script: PathBuf,
    pub loader: PathBuf,
    pub phase: String,
    pub attempt: u64,
    pub initialization: Option<Initialization>,
    pub start_result: Option<Value>,
    pub running: bool,
    pub stop_requested: bool,
    pub ui: Option<String>,
    pub ui_filename: Option<String>,
    local: Vec<(String, String)>,
    session: Vec<(String, String)>,
    preview: String,
    samples: Vec<String>,
    pending: Vec<Value>,
    due: Option<Instant>,
    events: Vec<Event>,
}
impl Core {
    pub fn new(mut options: Value) -> Result<Self, String> {
        let script = PathBuf::from(options["scriptPath"].as_str().unwrap_or(""))
            .canonicalize()
            .map_err(|_| "Select a valid Agent script before starting.")?;
        let script = plain_path(script);
        if !script.is_file() {
            return Err("Select a valid Agent script before starting.".into());
        }
        let root = PathBuf::from(options["root"].as_str().unwrap_or("."));
        let loader = [
            script.parent().unwrap().join("libLoader.js"),
            root.join(".agent_scripts/libLoader.js"),
        ]
        .into_iter()
        .find(|p| p.is_file())
        .ok_or("Agent loader missing. Expected libLoader.js next to the script.")?;
        options["scriptPath"] = json!(script);
        let storage = PathBuf::from(
            options["baseDir"]
                .as_str()
                .ok_or("Missing Agent data directory")?,
        )
        .join("texthook/agent-storage")
        .join(format!("{}.json", safe_name(&script)));
        let local = fs::read(storage)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| {
                v.as_object()
                    .map(|o| o.iter().map(|(k, v)| (k.clone(), string(v))).collect())
            })
            .unwrap_or_default();
        Ok(Self {
            options,
            id: uuid::Uuid::new_v4().to_string(),
            script,
            loader,
            phase: "starting".into(),
            attempt: 0,
            initialization: None,
            start_result: None,
            running: true,
            stop_requested: false,
            ui: None,
            ui_filename: None,
            local,
            session: vec![],
            preview: String::new(),
            samples: vec![],
            pending: vec![],
            due: None,
            events: vec![],
        })
    }
    fn delay(&self) -> u64 {
        self.options["flushDelayMs"]
            .as_u64()
            .unwrap_or(100)
            .min(5000)
    }
    fn limit(&self) -> usize {
        self.options["maxBufferSize"]
            .as_u64()
            .unwrap_or(3000)
            .clamp(1, 100000) as usize
    }
    pub fn status(&self) -> Value {
        if !self.running {
            return json!({"running":false});
        }
        json!({"running":true,"sessionId":self.id,"agentPhase":self.phase,"engine":"agent","arch":self.options["arch"],"pid":self.options["pid"],"exeName":self.options["exeName"],"source":self.options["source"],"selectedHookId":if self.phase=="starting"{Value::Null}else{json!("agent")},"hookCount":if self.phase=="starting"{0}else{1},"flushDelayMs":self.delay(),"copyToClipboard":self.options["copyToClipboard"]==true,"agentScriptPath":self.script,"agentHasUi":self.ui.is_some(),"agentDetached":self.options["detached"]==true})
    }
    pub fn hooks(&self) -> Value {
        if !self.running || self.phase == "starting" {
            return json!({"hooks":[],"selectedHookId":null});
        }
        json!({"hooks":[{"id":"agent","function":self.script.file_name().unwrap_or_default().to_string_lossy(),"preview":self.preview,"samples":self.samples}],"selectedHookId":"agent"})
    }
    pub fn state(&self) -> Value {
        json!({"status":if self.running{self.status()}else{Value::Null},"hooks":self.hooks(),"startResult":self.start_result})
    }
    pub fn emit(&mut self, channel: &str, data: Value) {
        self.events.push((channel.into(), data));
    }
    pub fn status_event(&mut self) {
        self.emit("texthook.status", self.status());
        self.emit("texthook.hooks", self.hooks());
    }
    pub fn log(&mut self, message: &str, level: &str) {
        self.emit(
            "texthook.log",
            json!({"message":message,"level":level,"ts":now()}),
        );
    }
    pub fn drain(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.events)
    }
    pub fn begin_attempt(&mut self) -> u64 {
        self.attempt += 1;
        self.initialization = Some(Initialization::default());
        self.attempt
    }
    pub fn init_error(&self) -> Option<String> {
        self.initialization.as_ref().and_then(|i| {
            i.error.clone().or_else(|| {
                (i.hook_missing && !i.has_hook)
                    .then(|| "Unity game hooks are not ready yet.".into())
            })
        })
    }
    pub fn retryable(&self, error: &str) -> bool {
        self.phase != "receiving"
            && self.initialization.as_ref().is_some_and(|i| {
                i.mono_missing
                    || (i.hook_missing && !i.has_hook)
                    || error.to_ascii_lowercase().contains("libmono.js:")
                    || (error.contains("setHook") && error.contains("undefined"))
            })
    }
    pub fn ready(&mut self) {
        self.initialization = None;
        if self.phase == "starting" {
            self.phase = "waiting".into()
        }
        self.start_result = Some(
            json!({"success":true,"pid":self.options["pid"],"exeName":self.options["exeName"],"arch":self.options["arch"]}),
        );
        self.status_event();
    }
    pub fn fail(&mut self, error: &str, cancelled: bool) {
        if !cancelled {
            self.log(error, "error");
            self.emit(
                "texthook.agentError",
                json!({"error":error,"sessionId":self.id}),
            );
        }
        self.start_result = Some(json!({"success":false,"error":error}));
        self.stop();
    }
    pub fn stop(&mut self) {
        self.flush();
        self.running = false;
        self.attempt += 1;
        self.initialization = None;
        self.status_event();
    }
    fn preview(&mut self, text: &str) {
        self.preview = truncate(text, 80);
        if text.encode_utf16().count() > 80 {
            self.preview.push_str("...")
        };
        if self.samples.len() < 3 {
            self.samples.push(text.into())
        }
        self.emit("texthook.hooks", self.hooks());
    }
    fn output(&mut self, payload: Value) {
        self.emit("agent.text", payload.clone());
        self.emit(
            "texthook.text",
            json!({"hookId":"agent","text":payload["text"],"ts":now(),"sessionId":self.id}),
        );
    }
    fn copy(&mut self, text: &str, at: u64) {
        if text.trim().is_empty() {
            return;
        }
        let Some(text) = sanitize(text, self.limit()) else {
            return;
        };
        if self.phase != "receiving" {
            self.phase = "receiving".into();
            self.status_event();
        }
        let mut payload = json!({"text":text,"sessionId":self.id,"hookId":"agent","hookFunction":self.script.file_name().unwrap_or_default().to_string_lossy(),"engine":"agent","exeName":self.options["exeName"],"copyToClipboard":self.options["copyToClipboard"]==true,"capturedAt":at,"revisionWindowMs":0,"mergeFragments":false});
        self.preview(&text);
        if self.delay() == 0 {
            self.output(payload);
            return;
        }
        if let Some(last) = self.pending.last_mut() {
            let old = last["text"].as_str().unwrap();
            if text.starts_with(old) {
                payload["capturedAt"] = last["capturedAt"].clone();
                *last = payload;
            } else if !old.starts_with(&text) {
                self.pending.push(payload);
            }
        } else {
            self.pending.push(payload);
        }
        self.due = Some(Instant::now() + Duration::from_millis(self.delay()));
        if self
            .pending
            .iter()
            .map(|v| v["text"].as_str().unwrap().encode_utf16().count() + 1)
            .sum::<usize>()
            >= 10_000
        {
            self.flush()
        }
    }
    pub fn flush(&mut self) {
        self.due = None;
        if self.pending.is_empty() {
            return;
        }
        let all = self
            .pending
            .iter()
            .map(|v| v["text"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        let mut last = self.pending.last().unwrap().clone();
        last["capturedAt"] = self.pending[0]["capturedAt"].clone();
        self.pending.clear();
        if let Some(text) = sanitize(&all, self.limit()) {
            self.preview(&text);
            last["text"] = json!(text);
            self.output(last)
        }
    }
    pub fn tick(&mut self) {
        if self.due.is_some_and(|t| t <= Instant::now()) {
            self.flush()
        }
    }
    pub fn configure(&mut self, key: &str, value: Value) -> Value {
        self.options[key] = value;
        if key == "flushDelayMs" {
            if self.delay() == 0 {
                self.flush()
            } else if !self.pending.is_empty() {
                self.due = Some(Instant::now() + Duration::from_millis(self.delay()));
            }
        }
        self.status_event();
        json!({"success":true,key:self.options[key]})
    }
    fn path(&self, requested: &str, base: Option<&str>) -> PathBuf {
        let p = PathBuf::from(requested);
        if p.is_absolute() {
            p
        } else {
            base.map(PathBuf::from)
                .unwrap_or_else(|| self.script.parent().unwrap().to_path_buf())
                .join(p)
        }
    }
    fn candidates(&self, requested: &str, base: Option<&str>) -> Vec<PathBuf> {
        let p = self.path(requested, base);
        let mut paths = vec![p.clone()];
        if p.extension().is_none() {
            paths.push(p.with_extension("js"));
            paths.push(p.with_extension("json"))
        }
        paths
    }
    fn remote(&mut self, func: &str, args: &[Value]) -> Result<Value, String> {
        let arg = |i: usize| args.get(i).and_then(Value::as_str).unwrap_or("");
        match func {
            "__mission" => Ok(json!(self.script)),
            "__dirname" => Ok(json!(self.script.parent())),
            "path_dirname" => Ok(json!(Path::new(arg(0)).parent().unwrap_or(Path::new(".")))),
            "_statPath" => {
                let paths = self.candidates(arg(0), args.get(1).and_then(Value::as_str));
                for p in &paths {
                    if let Ok(m) = fs::metadata(p) {
                        return Ok(json!({"path":p,"isFile":m.is_file(),"isDir":m.is_dir()}));
                    }
                }
                Ok(json!({"path":paths[0],"isFile":false,"isDir":false,"errno":-4058}))
            }
            "fs_realpathSync" => Ok(self
                .candidates(arg(0), None)
                .into_iter()
                .find_map(|p| p.canonicalize().ok())
                .map(|p| json!(plain_path(p)))
                .unwrap_or(Value::Null)),
            "fs_readFileSync" => {
                let Some(p) = self
                    .candidates(arg(0), None)
                    .into_iter()
                    .find(|p| p.is_file())
                else {
                    return Ok(Value::Null);
                };
                let data = read(&p)?;
                if args.get(1).is_some_and(Value::is_string) {
                    Ok(json!(decode(&data, arg(1))?))
                } else {
                    Ok(json!({"type":"Buffer","data":data}))
                }
            }
            "fs_writeFileSync" => {
                let p = self.path(arg(0), None);
                let text = string(args.get(1).unwrap_or(&Value::Null));
                let encoding = args.get(2).and_then(Value::as_str).unwrap_or("utf8");
                write_atomic(&p, &encode(&text, encoding)?)?;
                Ok(json!(true))
            }
            _ => {
                self.log(&format!("Unhandled Agent host call: {func}"), "warn");
                Ok(Value::Null)
            }
        }
    }
    fn storage(&mut self, cmd: &str, args: &[Value]) -> Result<Value, String> {
        let is_local = cmd.starts_with("localStorage_");
        let store = if is_local {
            &mut self.local
        } else {
            &mut self.session
        };
        let key = string(args.first().unwrap_or(&Value::Null));
        let action = cmd.split_once('_').map(|v| v.1).unwrap_or("");
        let result = match action {
            "getItem" => store
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| json!(v))
                .unwrap_or_else(|| args.get(1).cloned().unwrap_or(Value::Null)),
            "setItem" => {
                let v = string(args.get(1).unwrap_or(&Value::Null));
                if let Some((_, old)) = store.iter_mut().find(|(k, _)| *k == key) {
                    *old = v
                } else {
                    store.push((key, v))
                }
                json!(true)
            }
            "removeItem" => {
                store.retain(|(k, _)| *k != key);
                json!(true)
            }
            "clear" => {
                store.clear();
                json!(true)
            }
            "key" => args
                .first()
                .and_then(Value::as_u64)
                .and_then(|i| store.get(i as usize))
                .map(|(k, _)| json!(k))
                .unwrap_or(Value::Null),
            "keys" => json!(store.iter().map(|(k, _)| k).collect::<Vec<_>>()),
            "length" => json!(store.len()),
            _ => Value::Null,
        };
        if is_local && matches!(action, "setItem" | "removeItem" | "clear") {
            let path = PathBuf::from(self.options["baseDir"].as_str().unwrap())
                .join("texthook/agent-storage")
                .join(format!("{}.json", safe_name(&self.script)));
            let map = self
                .local
                .iter()
                .map(|(k, v)| (k.clone(), json!(v)))
                .collect::<serde_json::Map<_, _>>();
            write_atomic(
                &path,
                &serde_json::to_vec_pretty(&map).map_err(|e| e.to_string())?,
            )?;
        }
        Ok(result)
    }
    /// Process a Frida message and return its synchronous loader reply, if any.
    pub fn message(&mut self, attempt: u64, message: Value, data: Option<&[u8]>) -> Option<Value> {
        if attempt != self.attempt || !self.running {
            return None;
        }
        match message["type"].as_str().unwrap_or("") {
            "log" => {
                let text = message["payload"].as_str().unwrap_or("");
                if let Some(init) = self.initialization.as_mut() {
                    if text.to_lowercase().contains("mono not found!") {
                        init.mono_missing = true
                    }
                    if text.trim().starts_with("Hook not found!")
                        || text.trim().starts_with("setHook.SkipNullAddress:")
                    {
                        init.hook_missing = true
                    }
                    if text.trim().starts_with("Attach: ") {
                        init.has_hook = true
                    }
                }
                self.log(
                    &format!("[Agent] {text}"),
                    match message["level"].as_str() {
                        Some("error") => "error",
                        Some("warning") => "warn",
                        _ => "info",
                    },
                );
                return None;
            }
            "error" => {
                let detail = message["stack"]
                    .as_str()
                    .or(message["description"].as_str())
                    .unwrap_or("Agent script error");
                self.log(detail, "error");
                if let Some(init) = self.initialization.as_mut() {
                    init.error.get_or_insert_with(|| detail.into());
                    init.completed = true
                } else {
                    self.emit(
                        "texthook.agentError",
                        json!({"error":detail,"sessionId":self.id}),
                    );
                }
                return None;
            }
            "send" => {}
            _ => return None,
        }
        let p = &message["payload"];
        let cmd = p["cmd"].as_str().unwrap_or("");
        let args = p["args"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        let result: Result<Value, String> = (|| match cmd {
            "__gsm_agent_initialized" => {
                if let Some(init) = self.initialization.as_mut() {
                    init.completed = true
                }
                Ok(Value::Null)
            }
            "copy" => {
                self.copy(p["text"].as_str().unwrap_or(""), now());
                Ok(Value::Null)
            }
            "detach" => {
                self.stop_requested = true;
                Ok(Value::Null)
            }
            "eval" => self.remote(p["func"].as_str().unwrap_or(""), args),
            "writeBytes" => {
                if let (Some(path), Some(bytes)) = (p["path"].as_str(), data) {
                    write_atomic(&self.path(path, None), bytes)?;
                    Ok(json!(true))
                } else {
                    Ok(json!(false))
                }
            }
            "prompt" => Ok(p.get("default").cloned().unwrap_or(json!(""))),
            "getScripts" => Ok(json!(fs::read_dir(self.script.parent().unwrap())
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .filter(|e| e
                    .file_name()
                    .to_string_lossy()
                    .to_lowercase()
                    .ends_with(".js"))
                .map(|e| e.path())
                .collect::<Vec<_>>())),
            _ if cmd.starts_with("localStorage_") || cmd.starts_with("sessionStorage_") => {
                self.storage(cmd, args)
            }
            "loadHtml" => {
                self.ui = Some(p["text"].as_str().unwrap_or("").into());
                self.ui_filename = p["fileName"].as_str().map(str::to_owned);
                self.status_event();
                self.emit("agent-ui.changed", json!({"sessionId":self.id}));
                Ok(Value::Null)
            }
            "rpc_send" => {
                self.emit(
                    "agent-ui.rpc-event",
                    json!({"func":p["func"],"args":args,"sessionId":self.id}),
                );
                Ok(Value::Null)
            }
            "rpc_invoke" | "re_attach" | "setTargetID" => Ok(Value::Null),
            _ => {
                self.log(&format!("Unhandled Agent message: {cmd}"), "warn");
                Ok(Value::Null)
            }
        })();
        let value = match result {
            Ok(v) => v,
            Err(error) => {
                self.log(&format!("Agent host message failed: {error}"), "error");
                Value::Null
            }
        };
        p.get("key")
            .filter(|k| !k.is_null())
            .map(|key| json!({"type":key,"result":value}))
    }
}
