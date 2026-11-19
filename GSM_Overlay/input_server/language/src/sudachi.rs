use crate::{vocabulary, Request, VocabularyRequest};
use reqwest::Client as HttpClient;
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{BufWriter, Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::{Duration, Instant, UNIX_EPOCH};
use sudachi::analysis::stateless_tokenizer::StatelessTokenizer;
use sudachi::analysis::{Mode as SudachiMode, Tokenize as SudachiTokenize};
use sudachi::config::Config as SudachiConfig;
use sudachi::dic::build::DictBuilder;
use sudachi::dic::dictionary::JapaneseDictionary;
use sudachi::dic::storage::{Storage as SudachiStorage, SudachiDicData};
use tokio::{sync::Mutex, time};
use tracing::{info, warn};
use zip::ZipArchive;

// sudachi.rs 0.6.10 reads V0 only. Releases >= 202610 are incompatible V1.
// Keep release, engine and checksums together; never resolve "latest" at runtime.
const SUDACHI_DICT_RELEASE: &str = "20260116";
const SUDACHI_IDLE_UNLOAD_AFTER: Duration = Duration::from_secs(5 * 60);
const SUDACHI_IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(30);
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SudachiDictionaryKind {
    Small,
    Core,
    Full,
}

impl SudachiDictionaryKind {
    fn from_value(value: Option<&str>) -> Self {
        match value.map(|v| v.trim().to_ascii_lowercase()) {
            Some(v) if v == "small" => Self::Small,
            Some(v) if v == "core" => Self::Core,
            Some(v) if v == "full" => Self::Full,
            _ => Self::Small,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Core => "core",
            Self::Full => "full",
        }
    }

    fn zip_sha256(self) -> &'static str {
        match self {
            Self::Small => "0ac281c48fd9273e5cdfbb7d49d1457579998b5540da711767c6f733c95a6aa9",
            Self::Core => "e80e68c8e7b17e2082341284cffefbc11fb7838b2c318ae280c1690fc1ee1e2f",
            Self::Full => "2a1eda5a0240a42f45daf8003d97df5565c5d252bb2d58e71807bbbd082f7eea",
        }
    }

    fn download_url(self) -> String {
        format!(
            "https://github.com/WorksApplications/SudachiDict/releases/download/v{}/sudachi-dictionary-{}-{}.zip",
            SUDACHI_DICT_RELEASE,
            SUDACHI_DICT_RELEASE,
            self.as_str()
        )
    }
}

pub struct LanguageService {
    sudachi: Mutex<SudachiService>,
    vocabulary: Arc<StdMutex<Option<vocabulary::Store>>>,
    vocabulary_path: PathBuf,
}

impl LanguageService {
    pub fn new(data_dir: PathBuf, user_dict_dir: PathBuf) -> Self {
        Self {
            sudachi: Mutex::new(SudachiService::new(
                data_dir,
                user_dict_dir,
                sudachi_dictionary_kind_from_env(),
            )),
            vocabulary: Default::default(),
            vocabulary_path: std::env::var_os("GSM_VOCABULARY_DB_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| default_gsm_app_data_dir().join("local-vocabulary.sqlite3")),
        }
    }

    pub fn from_env() -> Self {
        Self::new(resolve_sudachi_data_dir(), resolve_sudachi_user_dicts_dir())
    }

    pub async fn unload_when_idle(service: Weak<Self>) {
        loop {
            time::sleep(SUDACHI_IDLE_CHECK_INTERVAL).await;
            let Some(service) = service.upgrade() else {
                return;
            };
            service
                .sudachi
                .lock()
                .await
                .unload_if_idle(Instant::now(), SUDACHI_IDLE_UNLOAD_AFTER);
        }
    }

    pub async fn release(&self) {
        self.sudachi.lock().await.disable();
    }

    /// Snapshot the selected dictionary for a batch. Analysis can run without
    /// holding the service lock, including while the overlay requests readings.
    pub async fn mining_dictionary(
        &self,
        dictionary: &str,
    ) -> Result<crate::mining::MiningDictionary, String> {
        let mut service = self.sudachi.lock().await;
        service.configure_if_unselected(dictionary)?;
        service.last_request_at = Some(Instant::now());
        service.ensure_tokenizer().await?;
        service
            .dictionary
            .clone()
            .map(crate::mining::MiningDictionary)
            .ok_or_else(|| "Sudachi dictionary unavailable".to_string())
    }

    pub async fn execute(&self, request: Request) -> Result<Value, String> {
        match request {
            Request::Status => {
                let Ok(mut service) = self.sudachi.try_lock() else {
                    return Ok(json!({"type": "sudachi_status", "state": "installing"}));
                };
                // Verify an existing install without downloading or replacing it.
                if service.last_error.is_none() && service.dictionary_path().is_file() {
                    if let Err(error) = service.ensure_tokenizer().await {
                        service.last_error = Some(error);
                    }
                    service.last_request_at = Some(Instant::now());
                }
                Ok(service.status())
            }
            Request::Prepare { dictionary } => {
                let mut service = self.sudachi.lock().await;
                if let Err(error) = service.prepare(dictionary.as_deref()).await {
                    service.last_error = Some(error);
                }
                Ok(service.status())
            }
            Request::Configure { dictionary } => {
                let mut service = self.sudachi.lock().await;
                if let Err(error) = service.configure_if_unselected(&dictionary) {
                    service.last_error = Some(error);
                }
                let mut payload = service.status();
                payload["type"] = json!("sudachi_configuration");
                Ok(payload)
            }
            Request::Analyze { text, furigana } => {
                let mut service = self.sudachi.lock().await;
                let result = if furigana {
                    service.furigana(&text).await
                } else {
                    service.tokenize(&text).await
                };
                service.last_error = result.as_ref().err().cloned();
                result
                    .map(|values| Value::Array(values))
                    .map_err(|error| format!("{error}. Open Japanese dictionary setup and retry."))
            }
            Request::Vocabulary { request } => self.vocabulary(request).await,
        }
    }

    async fn vocabulary(&self, request: VocabularyRequest) -> Result<Value, String> {
        request.validate()?;
        let dictionary = if request.requires_dictionary() {
            let mut service = self.sudachi.lock().await;
            service.last_request_at = Some(Instant::now());
            service.ensure_tokenizer().await?;
            service.last_request_at = Some(Instant::now());
            service.dictionary.clone()
        } else {
            None
        };
        let store = self.vocabulary.clone();
        let path = self.vocabulary_path.clone();
        tokio::task::spawn_blocking(move || {
            let mut store = store
                .lock()
                .map_err(|_| "Vocabulary database lock failed")?;
            if store.is_none() {
                if let Some(directory) = path.parent() {
                    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
                }
                *store = Some(vocabulary::Store::open(path)?);
            }
            store.as_mut().unwrap().execute(request, dictionary)
        })
        .await
        .map_err(|error| format!("Local vocabulary task failed: {error}"))?
    }
}

struct SudachiService {
    data_dir: PathBuf,
    user_dict_dir: PathBuf,
    dictionary_kind: SudachiDictionaryKind,
    dictionary: Option<Arc<JapaneseDictionary>>,
    loaded_signature: Option<String>,
    last_request_at: Option<Instant>,
    last_error: Option<String>,
}

/// Emit a structured JSON progress message to stdout for Electron to parse.
/// Format: GSMPROGRESS:{"stage":"...","percent":N,"totalBytes":N,"error":"..."}
fn emit_sudachi_progress(stage: &str, percent: u64, total_bytes: Option<u64>, error: Option<&str>) {
    let mut msg = json!({
        "stage": stage,
        "percent": percent,
    });
    if let Some(total) = total_bytes {
        msg["totalBytes"] = json!(total);
    }
    if let Some(err) = error {
        msg["error"] = json!(err);
    }
    // Print to stdout with a recognizable prefix for Electron to parse
    println!("GSMPROGRESS:{}", msg);
}

impl SudachiService {
    fn new(
        data_dir: PathBuf,
        user_dict_dir: PathBuf,
        dictionary_kind: SudachiDictionaryKind,
    ) -> Self {
        let dictionary_kind = fs::read_to_string(data_dir.join("sudachi/selection.txt"))
            .ok()
            .map(|value| SudachiDictionaryKind::from_value(Some(&value)))
            .unwrap_or(dictionary_kind);
        Self {
            data_dir,
            user_dict_dir,
            dictionary_kind,
            dictionary: None,
            loaded_signature: None,
            last_request_at: None,
            last_error: None,
        }
    }

    fn disable(&mut self) {
        self.dictionary = None;
        self.loaded_signature = None;
        self.last_request_at = None;
        info!("sudachi capability released");
    }

    fn inactivity_expired(
        last_request_at: Option<Instant>,
        now: Instant,
        idle_timeout: Duration,
    ) -> bool {
        last_request_at
            .is_some_and(|last_request| now.saturating_duration_since(last_request) >= idle_timeout)
    }

    fn should_unload_for_inactivity(&self, now: Instant, idle_timeout: Duration) -> bool {
        self.dictionary.is_some()
            && Self::inactivity_expired(self.last_request_at, now, idle_timeout)
    }

    fn unload_if_idle(&mut self, now: Instant, idle_timeout: Duration) -> bool {
        if !self.should_unload_for_inactivity(now, idle_timeout) {
            return false;
        }
        self.dictionary = None;
        self.loaded_signature = None;
        self.last_request_at = None;
        info!(
            "sudachi dictionary unloaded after {} seconds without requests",
            idle_timeout.as_secs()
        );
        true
    }

    fn set_dictionary_kind(&mut self, dictionary_kind: SudachiDictionaryKind) {
        if self.dictionary_kind == dictionary_kind {
            return;
        }
        self.disable();
        self.dictionary_kind = dictionary_kind;
        self.last_error = None;
        info!(
            "sudachi dictionary selection changed to {}",
            self.dictionary_kind.as_str()
        );
    }

    async fn ensure_tokenizer(&mut self) -> Result<(), String> {
        let dict_path = self.dictionary_path();
        if !dict_path.is_file() {
            return Err("Sudachi dictionary setup is required".to_string());
        }
        let user_dict_dir = self.user_dict_dir.clone();
        let dict_path_for_user_dicts = dict_path.clone();
        let (user_dict_paths, signature) = tokio::task::spawn_blocking(move || {
            prepare_sudachi_user_dictionaries(&dict_path_for_user_dicts, &user_dict_dir)
        })
        .await
        .map_err(|e| format!("sudachi dictionary task failed: {e}"))??;
        if self.dictionary.is_some() && self.loaded_signature.as_deref() == Some(signature.as_str())
        {
            return Ok(());
        }
        let dict_path_for_load = dict_path.clone();
        let dictionary = tokio::task::spawn_blocking(move || {
            load_sudachi_dictionary(&dict_path_for_load, &user_dict_paths)
        })
        .await
        .map_err(|e| format!("sudachi dictionary task failed: {e}"))??;
        self.dictionary = Some(dictionary);
        self.loaded_signature = Some(signature);
        self.last_error = None;
        Ok(())
    }

    fn dictionary_path(&self) -> PathBuf {
        self.data_dir
            .join("sudachi")
            .join(format!(
                "v{}-{}",
                SUDACHI_DICT_RELEASE,
                self.dictionary_kind.as_str()
            ))
            .join(format!("system_{}.dic", self.dictionary_kind.as_str()))
    }

    fn persist_selection(&self) -> Result<(), String> {
        let root = self.data_dir.join("sudachi");
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let temporary = root.join("selection.tmp");
        fs::write(&temporary, self.dictionary_kind.as_str()).map_err(|e| e.to_string())?;
        fs::rename(temporary, root.join("selection.txt")).map_err(|e| e.to_string())
    }

    fn configure_if_unselected(&mut self, dictionary: &str) -> Result<(), String> {
        if !self.data_dir.join("sudachi/selection.txt").is_file() {
            self.set_dictionary_kind(SudachiDictionaryKind::from_value(Some(dictionary)));
            self.persist_selection()?;
        }
        Ok(())
    }

    fn status(&self) -> Value {
        json!({
            "type": "sudachi_status",
            "dictionary": self.dictionary_kind.as_str(),
            "release": SUDACHI_DICT_RELEASE,
            "state": if self.last_error.is_some() { "error" } else if self.dictionary.is_some() { "ready" }
                else if self.dictionary_path().is_file() { "installed" } else { "setup_required" },
            "error": self.last_error,
        })
    }

    async fn prepare(&mut self, dictionary: Option<&str>) -> Result<(), String> {
        if let Some(kind) = dictionary {
            if !matches!(kind, "small" | "core" | "full") {
                return Err("Choose a valid Sudachi dictionary: small, core, or full".to_string());
            }
            self.set_dictionary_kind(SudachiDictionaryKind::from_value(Some(kind)));
        }
        self.persist_selection()?;
        self.last_error = None;
        // Only explicit setup can replace an unreadable system dictionary.
        let path = self.dictionary_path();
        if path.is_file() {
            let check_path = path.clone();
            let valid = tokio::task::spawn_blocking(move || {
                load_sudachi_dictionary(&check_path, &[]).is_ok()
            })
            .await
            .map_err(|e| e.to_string())?;
            if !valid {
                self.disable();
                fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
        }
        self.ensure_dictionary().await?;
        self.ensure_tokenizer().await?;
        self.last_request_at = Some(Instant::now());
        Ok(())
    }

    async fn ensure_dictionary(&self) -> Result<PathBuf, String> {
        let dict_path = self.dictionary_path();
        let version_dir = dict_path.parent().expect("dictionary parent");
        if dict_path.is_file() {
            emit_sudachi_progress("ready", 100, None, None);
            return Ok(dict_path);
        }

        fs::create_dir_all(&version_dir)
            .map_err(|e| format!("failed to create Sudachi data directory: {e}"))?;

        info!(
            "downloading Sudachi dictionary {} ({})",
            SUDACHI_DICT_RELEASE,
            self.dictionary_kind.as_str()
        );
        emit_sudachi_progress("downloading", 0, None, None);

        let client = HttpClient::builder()
            .user_agent("gsm-overlay-server/0.1.0")
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(15 * 60))
            .build()
            .map_err(|e| {
                let msg = format!("failed to build Sudachi HTTP client: {e}");
                emit_sudachi_progress("error", 0, None, Some(&msg));
                msg
            })?;
        let mut response = client
            .get(self.dictionary_kind.download_url())
            .send()
            .await
            .map_err(|e| {
                let msg = format!("failed to download Sudachi dictionary: {e}");
                emit_sudachi_progress("error", 0, None, Some(&msg));
                msg
            })?;
        let status = response.status();
        if !status.is_success() {
            let msg = format!("failed to download Sudachi dictionary: HTTP {}", status);
            emit_sudachi_progress("error", 0, None, Some(&msg));
            return Err(msg);
        }

        let total_size = response.content_length();
        let mut downloaded: u64 = 0;
        let mut zip_bytes = Vec::with_capacity(total_size.unwrap_or(0) as usize);
        let mut last_progress_pct: u64 = 0;

        // Stream download with progress
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    downloaded += chunk.len() as u64;
                    zip_bytes.extend_from_slice(&chunk);
                    if let Some(total) = total_size {
                        if total > 0 {
                            let pct = (downloaded * 100) / total;
                            // Emit at most every 2% to avoid flooding
                            if pct >= last_progress_pct + 2 || pct == 100 {
                                emit_sudachi_progress("downloading", pct, total_size, None);
                                last_progress_pct = pct;
                            }
                        }
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let msg = format!("failed to read Sudachi dictionary archive: {e}");
                    emit_sudachi_progress("error", 0, total_size, Some(&msg));
                    return Err(msg);
                }
            }
        }

        emit_sudachi_progress("verifying", 100, total_size, None);
        let digest = sha256_hex(&zip_bytes);
        if digest != self.dictionary_kind.zip_sha256() {
            let msg = format!(
                "Sudachi dictionary checksum mismatch: expected {}, got {digest}",
                self.dictionary_kind.zip_sha256()
            );
            emit_sudachi_progress("error", 0, total_size, Some(&msg));
            return Err(msg);
        }

        emit_sudachi_progress("extracting", 100, total_size, None);
        let dict_path_for_extract = dict_path.clone();
        tokio::task::spawn_blocking(move || {
            extract_sudachi_dictionary(&zip_bytes, &dict_path_for_extract)
        })
        .await
        .map_err(|e| {
            let msg = format!("Sudachi extraction task failed: {e}");
            emit_sudachi_progress("error", 0, None, Some(&msg));
            msg
        })??;

        emit_sudachi_progress("done", 100, total_size, None);
        info!("Sudachi dictionary ready at {}", dict_path.display());
        Ok(dict_path)
    }

    async fn tokenize(&mut self, text: &str) -> Result<Vec<Value>, String> {
        self.last_request_at = Some(Instant::now());
        self.ensure_tokenizer().await?;
        let dictionary = self
            .dictionary
            .as_ref()
            .ok_or_else(|| "Sudachi dictionary unavailable".to_string())?;
        let text = text.to_string();
        let result = tokio::task::spawn_blocking({
            let dictionary = dictionary.clone();
            move || tokenize_with_sudachi(&dictionary, &text)
        })
        .await
        .map_err(|e| format!("Sudachi tokenization task failed: {e}"))?;
        self.last_request_at = Some(Instant::now());
        result
    }

    async fn furigana(&mut self, text: &str) -> Result<Vec<Value>, String> {
        self.last_request_at = Some(Instant::now());
        self.ensure_tokenizer().await?;
        let dictionary = self
            .dictionary
            .as_ref()
            .ok_or_else(|| "Sudachi dictionary unavailable".to_string())?;
        let text = text.to_string();
        let result = tokio::task::spawn_blocking({
            let dictionary = dictionary.clone();
            move || furigana_with_sudachi(&dictionary, &text)
        })
        .await
        .map_err(|e| format!("Sudachi furigana task failed: {e}"))?;
        self.last_request_at = Some(Instant::now());
        result
    }
}

fn sudachi_dictionary_kind_from_env() -> SudachiDictionaryKind {
    SudachiDictionaryKind::from_value(std::env::var("GSM_SUDACHI_DICT_KIND").ok().as_deref())
}

fn resolve_sudachi_data_dir() -> PathBuf {
    std::env::var("GSM_SUDACHI_DATA_PATH")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_gsm_app_data_dir)
}

fn default_gsm_app_data_dir() -> PathBuf {
    if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let trimmed = appdata.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed).join("GameSentenceMiner");
            }
        }
    } else {
        if let Ok(config_home) = std::env::var("XDG_CONFIG_HOME") {
            let trimmed = config_home.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed).join("GameSentenceMiner");
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            let trimmed = home.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed)
                    .join(".config")
                    .join("GameSentenceMiner");
            }
        }
    }

    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("GameSentenceMiner")
}

fn resolve_sudachi_user_dicts_dir() -> PathBuf {
    if let Ok(path) = std::env::var("GSM_SUDACHI_USER_DICTS_PATH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    default_gsm_app_data_dir()
        .join("dictionaries")
        .join("sudachi")
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn extract_sudachi_dictionary(zip_bytes: &[u8], dict_path: &Path) -> Result<(), String> {
    let parent = dict_path
        .parent()
        .ok_or_else(|| format!("invalid Sudachi dictionary path: {}", dict_path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("failed to create Sudachi parent directory: {e}"))?;

    let file_name = dict_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            format!(
                "invalid Sudachi dictionary filename: {}",
                dict_path.display()
            )
        })?;
    let partial_path = dict_path.with_file_name(format!("{file_name}.part"));
    if partial_path.exists() {
        let _ = fs::remove_file(&partial_path);
    }

    let reader = Cursor::new(zip_bytes);
    let mut archive =
        ZipArchive::new(reader).map_err(|e| format!("failed to open Sudachi zip archive: {e}"))?;

    for idx in 0..archive.len() {
        let mut entry = archive
            .by_index(idx)
            .map_err(|e| format!("failed to read Sudachi zip entry {idx}: {e}"))?;
        if entry.is_dir() {
            continue;
        }

        let entry_name = entry.name().replace('\\', "/");
        if !entry_name.ends_with(".dic") || !entry_name.contains("system_") {
            continue;
        }

        let mut out = fs::File::create(&partial_path)
            .map_err(|e| format!("failed to create Sudachi dictionary file: {e}"))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("failed to extract Sudachi dictionary: {e}"))?;
        out.flush()
            .map_err(|e| format!("failed to flush Sudachi dictionary: {e}"))?;
        fs::rename(&partial_path, dict_path)
            .map_err(|e| format!("failed to finalize Sudachi dictionary file: {e}"))?;
        return Ok(());
    }

    Err("Sudachi archive did not contain a system_*.dic entry".to_string())
}

fn file_timestamp_secs(path: &Path) -> Result<u64, String> {
    let modified = fs::metadata(path)
        .map_err(|e| format!("failed to read metadata for {}: {e}", path.display()))?
        .modified()
        .map_err(|e| format!("failed to read modified time for {}: {e}", path.display()))?;
    let duration = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("invalid modified time for {}: {e}", path.display()))?;
    Ok(duration.as_secs())
}

fn should_rebuild_user_dictionary(csv_path: &Path, dic_path: &Path) -> Result<bool, String> {
    if !dic_path.is_file() {
        return Ok(true);
    }

    Ok(file_timestamp_secs(csv_path)? > file_timestamp_secs(dic_path)?)
}

fn collect_sorted_paths(dir: &Path, extension: &str) -> Result<Vec<PathBuf>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }

    let mut paths = Vec::new();
    for entry in
        fs::read_dir(dir).map_err(|e| format!("failed to read directory {}: {e}", dir.display()))?
    {
        let entry = entry.map_err(|e| format!("failed to read directory entry: {e}"))?;
        let path = entry.path();
        if path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case(extension))
            .unwrap_or(false)
        {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}

fn compile_user_dictionary(
    csv_path: &Path,
    dic_path: &Path,
    system_dictionary: &Arc<JapaneseDictionary>,
) -> Result<(), String> {
    if let Some(parent) = dic_path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "failed to create Sudachi user dictionary directory {}: {e}",
                parent.display()
            )
        })?;
    }

    let partial_path = dic_path.with_extension("dic.part");
    if partial_path.exists() {
        let _ = fs::remove_file(&partial_path);
    }

    let file = File::create(&partial_path).map_err(|e| {
        format!(
            "failed to create temporary Sudachi user dictionary {}: {e}",
            partial_path.display()
        )
    })?;
    let mut writer = BufWriter::with_capacity(16 * 1024, file);
    let mut builder = DictBuilder::new_user(system_dictionary.as_ref());
    let description = csv_path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| format!("GSM user dictionary ({value})"))
        .unwrap_or_else(|| "GSM user dictionary".to_string());
    builder.set_description(description);
    builder.read_lexicon(csv_path).map_err(|e| {
        format!(
            "failed to read Sudachi user dictionary CSV {}: {e}",
            csv_path.display()
        )
    })?;
    builder.resolve().map_err(|e| {
        format!(
            "failed to resolve Sudachi user dictionary CSV {}: {e}",
            csv_path.display()
        )
    })?;
    builder.compile(&mut writer).map_err(|e| {
        format!(
            "failed to compile Sudachi user dictionary CSV {}: {e}",
            csv_path.display()
        )
    })?;
    writer.flush().map_err(|e| {
        format!(
            "failed to flush Sudachi user dictionary {}: {e}",
            dic_path.display()
        )
    })?;
    fs::rename(&partial_path, dic_path).map_err(|e| {
        format!(
            "failed to finalize Sudachi user dictionary {}: {e}",
            dic_path.display()
        )
    })?;
    Ok(())
}

fn build_dictionary_signature(
    dict_path: &Path,
    user_dict_paths: &[PathBuf],
) -> Result<String, String> {
    let system_meta = fs::metadata(dict_path)
        .map_err(|e| format!("failed to read metadata for {}: {e}", dict_path.display()))?;
    let system_stamp = file_timestamp_secs(dict_path)?;
    let mut parts = vec![format!(
        "{}:{}:{}",
        dict_path.display(),
        system_meta.len(),
        system_stamp
    )];

    for path in user_dict_paths {
        let meta = fs::metadata(path)
            .map_err(|e| format!("failed to read metadata for {}: {e}", path.display()))?;
        let stamp = file_timestamp_secs(path)?;
        parts.push(format!("{}:{}:{}", path.display(), meta.len(), stamp));
    }

    Ok(parts.join("|"))
}

fn prepare_sudachi_user_dictionaries(
    dict_path: &Path,
    user_dict_dir: &Path,
) -> Result<(Vec<PathBuf>, String), String> {
    let csv_dir = user_dict_dir.join("csv");
    let system_signature = build_dictionary_signature(dict_path, &[])?;
    let dic_dir = user_dict_dir
        .join("dic")
        .join(sha256_hex(system_signature.as_bytes()));
    let csv_paths = collect_sorted_paths(&csv_dir, "csv")?;

    if csv_paths.is_empty() {
        return Ok((Vec::new(), build_dictionary_signature(dict_path, &[])?));
    }

    fs::create_dir_all(&dic_dir)
        .map_err(|e| format!("failed to create Sudachi user dictionary directory: {e}"))?;
    let mut system_dictionary = None;
    let mut compiled_paths = Vec::new();

    for csv_path in csv_paths {
        let Some(stem) = csv_path.file_stem().and_then(|value| value.to_str()) else {
            warn!(
                "skipping Sudachi user dictionary CSV with invalid filename: {}",
                csv_path.display()
            );
            continue;
        };
        let dic_path = dic_dir.join(format!("{stem}.dic"));
        let rebuild = should_rebuild_user_dictionary(&csv_path, &dic_path)?;
        if rebuild {
            if system_dictionary.is_none() {
                system_dictionary = Some(load_sudachi_dictionary(dict_path, &[])?);
            }
            if dic_path.exists() {
                let _ = fs::remove_file(&dic_path);
            }
            match compile_user_dictionary(&csv_path, &dic_path, system_dictionary.as_ref().unwrap())
            {
                Ok(()) => info!(
                    "compiled Sudachi user dictionary {} -> {}",
                    csv_path.display(),
                    dic_path.display()
                ),
                Err(error) => {
                    return Err(error);
                }
            }
        }

        if dic_path.is_file() {
            compiled_paths.push(dic_path);
        }
    }

    compiled_paths.sort();
    let signature = build_dictionary_signature(dict_path, &compiled_paths)?;
    Ok((compiled_paths, signature))
}

pub(crate) fn load_sudachi_dictionary(
    dict_path: &Path,
    user_dict_paths: &[PathBuf],
) -> Result<Arc<JapaneseDictionary>, String> {
    let dictionary_bytes =
        fs::read(dict_path).map_err(|e| format!("failed to read Sudachi dictionary: {e}"))?;
    let config = SudachiConfig::new_embedded()
        .map_err(|e| format!("failed to build Sudachi embedded config: {e}"))?
        .with_system_dic(dict_path.to_path_buf());
    let mut storage = SudachiDicData::new(SudachiStorage::Owned(dictionary_bytes));
    for user_dict_path in user_dict_paths {
        let user_dict_bytes = fs::read(user_dict_path).map_err(|e| {
            format!(
                "failed to read Sudachi user dictionary {}: {e}",
                user_dict_path.display()
            )
        })?;
        storage.add_user(SudachiStorage::Owned(user_dict_bytes));
    }
    let dictionary = JapaneseDictionary::from_cfg_storage_with_embedded_chardef(&config, storage)
        .map_err(|e| format!("failed to load Sudachi dictionary: {e}"))?;
    Ok(Arc::new(dictionary))
}

fn has_kanji(text: &str) -> bool {
    text.chars().any(|ch| {
        matches!(
            ch as u32,
            0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x2A6DF
        )
    })
}

fn katakana_to_hiragana(text: &str) -> String {
    text.chars()
        .map(|ch| match ch as u32 {
            0x30A1..=0x30F6 => char::from_u32((ch as u32) - 0x60).unwrap_or(ch),
            _ => ch,
        })
        .collect()
}

fn tokenize_with_sudachi(
    dictionary: &Arc<JapaneseDictionary>,
    text: &str,
) -> Result<Vec<Value>, String> {
    let tokenizer = StatelessTokenizer::new(dictionary.clone());
    let morphemes = tokenizer
        .tokenize(text, SudachiMode::B, false)
        .map_err(|e| format!("Sudachi tokenize failed: {e}"))?;

    let mut tokens = Vec::with_capacity(morphemes.len());
    for morpheme in morphemes.iter() {
        let word = morpheme.surface().to_string();
        if word.trim().is_empty() {
            continue;
        }

        let reading = morpheme.reading_form();
        let headword = morpheme.dictionary_form();
        let pos = morpheme.part_of_speech().join(",");
        let mut token = json!({
            "word": word,
            "start": morpheme.begin_c(),
            "end": morpheme.end_c(),
            "headword": headword,
            "pos": pos,
        });
        if !reading.is_empty() {
            token["reading"] = json!(reading);
        }
        tokens.push(token);
    }

    Ok(tokens)
}

fn furigana_with_sudachi(
    dictionary: &Arc<JapaneseDictionary>,
    text: &str,
) -> Result<Vec<Value>, String> {
    let tokenizer = StatelessTokenizer::new(dictionary.clone());
    let morphemes = tokenizer
        .tokenize(text, SudachiMode::B, false)
        .map_err(|e| format!("Sudachi furigana tokenize failed: {e}"))?;

    let mut segments = Vec::with_capacity(morphemes.len());
    for morpheme in morphemes.iter() {
        let segment_text = morpheme.surface().to_string();
        let mut reading = None;
        if has_kanji(&segment_text) {
            let converted = katakana_to_hiragana(morpheme.reading_form());
            if !converted.is_empty() && converted != segment_text {
                reading = Some(converted);
            }
        }

        segments.push(json!({
            "text": segment_text,
            "start": morpheme.begin_c(),
            "end": morpheme.end_c(),
            "hasReading": reading.is_some(),
            "reading": reading,
        }));
    }

    Ok(segments)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn katakana_readings_convert_to_hiragana() {
        assert_eq!(katakana_to_hiragana("キンチョウ"), "きんちょう");
        assert_eq!(katakana_to_hiragana("ゲーム"), "げーむ");
    }

    #[test]
    fn kanji_detection_matches_japanese_text() {
        assert!(has_kanji("緊張気味"));
        assert!(!has_kanji("きんちょう"));
    }

    #[tokio::test]
    async fn missing_dictionary_is_setup_required_without_network_or_fallback() {
        let root = std::env::temp_dir().join(format!("gsm-sudachi-missing-{}", std::process::id()));
        let mut service = SudachiService::new(
            root.clone(),
            root.join("user"),
            SudachiDictionaryKind::Small,
        );
        assert_eq!(service.status()["state"], "setup_required");
        assert!(service
            .tokenize("test")
            .await
            .unwrap_err()
            .contains("setup"));
        assert!(service
            .furigana("test")
            .await
            .unwrap_err()
            .contains("setup"));
        assert!(
            !root.exists(),
            "ordinary analysis must not create download files"
        );
    }

    #[tokio::test]
    async fn invalid_dictionary_is_not_replaced_by_ordinary_analysis() {
        let root = std::env::temp_dir().join(format!("gsm-sudachi-invalid-{}", std::process::id()));
        let mut service = SudachiService::new(
            root.clone(),
            root.join("user"),
            SudachiDictionaryKind::Small,
        );
        let dictionary = service.dictionary_path();
        fs::create_dir_all(dictionary.parent().unwrap()).unwrap();
        fs::write(&dictionary, vec![0u8; 512]).unwrap();
        assert!(service.ensure_tokenizer().await.is_err());
        assert_eq!(fs::read(&dictionary).unwrap(), vec![0u8; 512]);
        assert!(service.prepare(Some("unknown")).await.is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "requires GSM_TEST_SUDACHI_DICTIONARY pointing to an installed system dictionary"]
    fn real_sudachi_user_dictionary_compiles_and_reuses_selected_system() {
        let system = PathBuf::from(std::env::var("GSM_TEST_SUDACHI_DICTIONARY").unwrap());
        let root = std::env::temp_dir().join(format!("gsm-sudachi-user-{}", std::process::id()));
        fs::create_dir_all(root.join("csv")).unwrap();
        let source = "試験辞書語,4787,4787,-10000,試験辞書語,名詞,固有名詞,人名,一般,*,*,シケンジショゴ,試験辞書語,*,A,*,*,*,*\n";
        fs::write(root.join("csv/test.csv"), source).unwrap();
        let (paths, signature) = prepare_sudachi_user_dictionaries(&system, &root).unwrap();
        assert_eq!(paths.len(), 1);
        let dictionary = load_sudachi_dictionary(&system, &paths).unwrap();
        let tokens = tokenize_with_sudachi(&dictionary, "試験辞書語").unwrap();
        assert_eq!(tokens[0]["reading"], "シケンジショゴ");
        let (cached_paths, cached_signature) =
            prepare_sudachi_user_dictionaries(&system, &root).unwrap();
        assert_eq!(paths, cached_paths);
        assert_eq!(signature, cached_signature);
        assert_eq!(
            fs::read_to_string(root.join("csv/test.csv")).unwrap(),
            source
        );
        drop(dictionary);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn user_dictionary_cache_identity_changes_with_system_edition() {
        let root = std::env::temp_dir().join(format!("gsm-sudachi-cache-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let small = root.join("system_small.dic");
        let full = root.join("system_full.dic");
        fs::write(&small, b"system").unwrap();
        fs::write(&full, b"system").unwrap();
        assert_ne!(
            build_dictionary_signature(&small, &[]).unwrap(),
            build_dictionary_signature(&full, &[]).unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selected_dictionary_survives_service_restart() {
        let root =
            std::env::temp_dir().join(format!("gsm-sudachi-selection-{}", std::process::id()));
        let mut service = SudachiService::new(
            root.clone(),
            root.join("user"),
            SudachiDictionaryKind::Small,
        );
        service.set_dictionary_kind(SudachiDictionaryKind::Full);
        service.persist_selection().unwrap();
        let restarted =
            SudachiService::new(root.clone(), root.join("user"), SudachiDictionaryKind::Core);
        assert_eq!(restarted.dictionary_kind, SudachiDictionaryKind::Full);
        assert_eq!(restarted.status()["state"], "setup_required");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pinned_dictionary_is_v0_and_downloads_are_checksummed_for_every_edition() {
        assert!(SUDACHI_DICT_RELEASE < "202610");
        for edition in [
            SudachiDictionaryKind::Small,
            SudachiDictionaryKind::Core,
            SudachiDictionaryKind::Full,
        ] {
            assert_eq!(edition.zip_sha256().len(), 64);
            assert!(edition.download_url().contains(SUDACHI_DICT_RELEASE));
            assert!(edition
                .download_url()
                .ends_with(&format!("-{}.zip", edition.as_str())));
        }
    }

    #[test]
    fn sudachi_dictionary_selection_normalizes_protocol_values() {
        assert_eq!(
            SudachiDictionaryKind::from_value(Some("small")),
            SudachiDictionaryKind::Small
        );
        assert_eq!(
            SudachiDictionaryKind::from_value(Some("core")),
            SudachiDictionaryKind::Core
        );
        assert_eq!(
            SudachiDictionaryKind::from_value(Some("FULL")),
            SudachiDictionaryKind::Full
        );
        assert_eq!(
            SudachiDictionaryKind::from_value(Some("unknown")),
            SudachiDictionaryKind::Small
        );
        assert_eq!(
            SudachiDictionaryKind::from_value(None),
            SudachiDictionaryKind::Small
        );
    }

    #[test]
    fn sudachi_idle_unload_requires_a_loaded_dictionary_and_expired_activity() {
        let mut service = SudachiService::new(
            PathBuf::from("unused"),
            PathBuf::from("unused"),
            SudachiDictionaryKind::Small,
        );
        let now = Instant::now();
        let timeout = Duration::from_secs(300);

        service.last_request_at = Some(now);
        assert!(!service.should_unload_for_inactivity(now, timeout));

        service.last_request_at = now.checked_sub(timeout + Duration::from_secs(1));
        assert!(!service.should_unload_for_inactivity(now, timeout));
        assert!(SudachiService::inactivity_expired(
            service.last_request_at,
            now,
            timeout
        ));
    }

    #[test]
    #[ignore = "requires GSM_TEST_SUDACHI_DICTIONARY pointing to an installed system dictionary"]
    fn loaded_dictionary_stays_resident_for_five_idle_minutes() {
        let path = PathBuf::from(std::env::var_os("GSM_TEST_SUDACHI_DICTIONARY").unwrap());
        let mut service = SudachiService::new(
            PathBuf::from("unused"),
            PathBuf::from("unused"),
            SudachiDictionaryKind::Small,
        );
        let dictionary = load_sudachi_dictionary(&path, &[]).unwrap();
        let resident = Arc::downgrade(&dictionary);
        service.dictionary = Some(dictionary);
        let used = Instant::now();
        service.last_request_at = Some(used);
        assert!(!service.unload_if_idle(used + Duration::from_secs(299), SUDACHI_IDLE_UNLOAD_AFTER));
        assert!(resident.upgrade().is_some());
        assert!(service.unload_if_idle(used + Duration::from_secs(300), SUDACHI_IDLE_UNLOAD_AFTER));
        assert!(resident.upgrade().is_none());
    }
}
