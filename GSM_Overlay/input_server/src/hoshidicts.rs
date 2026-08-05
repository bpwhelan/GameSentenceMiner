use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, c_int, CStr, CString};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::ptr;
use std::slice;

pub const MANIFEST_FILE_NAME: &str = "manifest.json";
pub const LOOKUP_SCAN_LENGTH: usize = 10;
pub const LOOKUP_MAX_RESULTS: c_int = 16;
pub const MAX_LOOKUP_TEXT_BYTES: usize = 4 * 1024;
pub const MAX_LOOKUP_RESPONSE_BYTES: usize = 256 * 1024;
pub const MAX_REQUEST_ID_BYTES: usize = 128;

const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_DICTIONARIES: usize = 256;
const MAX_NATIVE_STRING_BYTES: usize = 128 * 1024;
const MAX_GLOSSARIES: usize = 64;
const MAX_TRACE_STEPS: usize = 32;
const MAX_FREQUENCY_ENTRIES: usize = 64;
const MAX_FREQUENCIES_PER_ENTRY: usize = 64;
const MAX_PITCH_ENTRIES: usize = 64;
const MAX_PITCHES_PER_ENTRY: usize = 64;
const MAX_PITCH_MARKERS: usize = 128;
const MAX_TRANSCRIPTIONS_PER_ENTRY: usize = 64;
const MAX_ARCHIVE_INDEX_BYTES: u64 = 1024 * 1024;
const REQUIRED_DICTIONARY_FILES: [&str; 3] = ["hash.table", "bloom.filter", "blobs.bin"];
const HOSHIDICTS_MARKERS: [&str; 3] = [".hoshidicts_3", ".hoshidicts_2", ".hoshidicts_1"];

#[repr(C)]
struct HdImportResult {
    _private: [u8; 0],
}

#[repr(C)]
struct HdDeinflector {
    _private: [u8; 0],
}

#[repr(C)]
struct HdQuery {
    _private: [u8; 0],
}

#[repr(C)]
struct HdLookup {
    _private: [u8; 0],
}

#[repr(C)]
struct HdLookupResults {
    _private: [u8; 0],
}

#[derive(Clone, Copy)]
#[repr(C)]
struct HdStr {
    ptr: *const c_char,
    len: usize,
}

#[derive(Clone, Copy)]
#[repr(C)]
struct HdGlossaryEntry {
    dict_name: HdStr,
    glossary: HdStr,
    definition_tags: HdStr,
    term_tags: HdStr,
}

#[derive(Clone, Copy)]
#[repr(C)]
struct HdFrequency {
    value: i32,
    display_value: HdStr,
}

#[derive(Clone, Copy)]
#[repr(C)]
struct HdFrequencyEntry {
    dict_name: HdStr,
    frequencies: *const HdFrequency,
    frequencies_count: usize,
}

#[derive(Clone, Copy)]
#[repr(C)]
struct HdPitch {
    position: i32,
    pattern: HdStr,
    nasal: *const i32,
    nasal_count: usize,
    devoice: *const i32,
    devoice_count: usize,
}

#[derive(Clone, Copy)]
#[repr(C)]
struct HdPitchEntry {
    dict_name: HdStr,
    pitches: *const HdPitch,
    pitches_count: usize,
    transcriptions: *const HdStr,
    transcriptions_count: usize,
}

#[derive(Clone, Copy)]
#[repr(C)]
struct HdTermResult {
    expression: HdStr,
    reading: HdStr,
    rules: HdStr,
    score: i32,
    glossaries: *const HdGlossaryEntry,
    glossaries_count: usize,
    frequencies: *const HdFrequencyEntry,
    frequencies_count: usize,
    pitches: *const HdPitchEntry,
    pitches_count: usize,
}

#[derive(Clone, Copy)]
#[repr(C)]
struct HdTransformGroup {
    name: HdStr,
    description: HdStr,
}

#[derive(Clone, Copy)]
#[repr(C)]
struct HdLookupResult {
    matched: HdStr,
    deinflected: HdStr,
    trace: *const HdTransformGroup,
    trace_count: usize,
    term: HdTermResult,
    preprocessor_steps: i32,
}

extern "C" {
    fn hd_import(
        zip_path: *const c_char,
        output_dir: *const c_char,
        low_ram: c_int,
    ) -> *mut HdImportResult;
    fn hd_import_result_free(result: *mut HdImportResult);
    fn hd_import_result_success(result: *const HdImportResult) -> c_int;
    fn hd_import_result_title(result: *const HdImportResult) -> *const c_char;
    fn hd_import_result_term_count(result: *const HdImportResult) -> u64;
    fn hd_import_result_meta_count(result: *const HdImportResult) -> u64;
    fn hd_import_result_freq_count(result: *const HdImportResult) -> u64;
    fn hd_import_result_pitch_count(result: *const HdImportResult) -> u64;
    fn hd_import_result_kanji_count(result: *const HdImportResult) -> u64;
    fn hd_import_result_media_count(result: *const HdImportResult) -> u64;
    fn hd_import_result_error(result: *const HdImportResult) -> *const c_char;

    fn hd_deinflector_new() -> *mut HdDeinflector;
    fn hd_deinflector_free(deinflector: *mut HdDeinflector);

    fn hd_query_new() -> *mut HdQuery;
    fn hd_query_free(query: *mut HdQuery);
    fn hd_query_add_term_dict(query: *mut HdQuery, path: *const c_char) -> c_int;
    fn hd_query_add_freq_dict(query: *mut HdQuery, path: *const c_char) -> c_int;
    fn hd_query_add_pitch_dict(query: *mut HdQuery, path: *const c_char) -> c_int;
    fn hd_query_add_kanji_dict(query: *mut HdQuery, path: *const c_char) -> c_int;

    fn hd_lookup_new(query: *mut HdQuery, deinflector: *mut HdDeinflector) -> *mut HdLookup;
    fn hd_lookup_free(lookup: *mut HdLookup);
    fn hd_lookup_run(
        lookup: *const HdLookup,
        lookup_string: *const c_char,
        max_results: c_int,
        scan_length: usize,
        out_results: *mut *const HdLookupResult,
        out_count: *mut usize,
    ) -> *mut HdLookupResults;
    fn hd_lookup_results_free(results: *mut HdLookupResults);
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum RequestId {
    Number(u64),
    Text(String),
}

impl RequestId {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Number(_) => Ok(()),
            Self::Text(value) if value.len() <= MAX_REQUEST_ID_BYTES => Ok(()),
            Self::Text(_) => Err(format!(
                "requestId exceeds the {MAX_REQUEST_ID_BYTES}-byte limit"
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LookupTrace {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LookupGlossary {
    pub dictionary: String,
    pub glossary: String,
    pub definition_tags: String,
    pub term_tags: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LookupFrequency {
    pub value: i32,
    pub display_value: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LookupFrequencyEntry {
    pub dictionary: String,
    pub frequencies: Vec<LookupFrequency>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LookupPitch {
    pub position: i32,
    pub pattern: String,
    pub nasal: Vec<i32>,
    pub devoice: Vec<i32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LookupPitchEntry {
    pub dictionary: String,
    pub pitches: Vec<LookupPitch>,
    pub transcriptions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LookupTerm {
    pub expression: String,
    pub reading: String,
    pub rules: String,
    pub score: i32,
    pub glossaries: Vec<LookupGlossary>,
    pub frequencies: Vec<LookupFrequencyEntry>,
    pub pitches: Vec<LookupPitchEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LookupResult {
    pub matched: String,
    pub deinflected: String,
    pub trace: Vec<LookupTrace>,
    pub term: LookupTerm,
    pub preprocessor_steps: i32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub success: bool,
    pub title: String,
    pub term_count: u64,
    pub meta_count: u64,
    pub frequency_count: u64,
    pub pitch_count: u64,
    pub kanji_count: u64,
    pub media_count: u64,
    pub error: String,
}

impl ImportReport {
    fn failure(error: impl Into<String>) -> Self {
        Self {
            success: false,
            title: String::new(),
            term_count: 0,
            meta_count: 0,
            frequency_count: 0,
            pitch_count: 0,
            kanji_count: 0,
            media_count: 0,
            error: error.into(),
        }
    }

    pub fn to_json_line(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|error| {
            serde_json::json!({
                "success": false,
                "title": "",
                "termCount": 0,
                "metaCount": 0,
                "frequencyCount": 0,
                "pitchCount": 0,
                "kanjiCount": 0,
                "mediaCount": 0,
                "error": format!("failed to serialize import result: {error}"),
            })
            .to_string()
        })
    }
}

struct ImportResultGuard(*mut HdImportResult);

impl Drop for ImportResultGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { hd_import_result_free(self.0) };
        }
    }
}

struct LookupResultsGuard(*mut HdLookupResults);

impl Drop for LookupResultsGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { hd_lookup_results_free(self.0) };
        }
    }
}

#[derive(Debug, Deserialize)]
struct ArchiveIndex {
    title: String,
}

fn archive_dictionary_title(archive_path: &Path) -> Result<String, String> {
    let archive_file = fs::File::open(archive_path)
        .map_err(|error| format!("failed to open dictionary archive: {error}"))?;
    let mut archive = zip::ZipArchive::new(archive_file)
        .map_err(|error| format!("failed to read dictionary archive: {error}"))?;
    let mut index = archive
        .by_name("index.json")
        .map_err(|_| "dictionary archive does not contain index.json".to_string())?;
    if index.size() > MAX_ARCHIVE_INDEX_BYTES {
        return Err("dictionary index.json is too large".to_string());
    }

    let mut contents = String::new();
    index
        .read_to_string(&mut contents)
        .map_err(|error| format!("failed to read dictionary index.json: {error}"))?;
    let parsed: ArchiveIndex = serde_json::from_str(&contents)
        .map_err(|error| format!("failed to parse dictionary index.json: {error}"))?;
    validate_dictionary_title(&parsed.title)?;
    Ok(parsed.title)
}

fn validate_dictionary_title(title: &str) -> Result<(), String> {
    let trimmed = title.trim();
    if trimmed.is_empty() || trimmed != title {
        return Err("dictionary title must be non-empty and have no surrounding whitespace".into());
    }
    if title.chars().count() > 240 {
        return Err("dictionary title is too long".into());
    }
    if title == "." || title == ".." || title.ends_with('.') || title.ends_with(' ') {
        return Err("dictionary title is not a safe directory name".into());
    }
    if title
        .chars()
        .any(|character| character.is_control() || r#"<>:"/\|?*"#.contains(character))
    {
        return Err("dictionary title contains a path separator or reserved character".into());
    }

    let stem = title
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0');
    if reserved {
        return Err("dictionary title is a reserved Windows filename".into());
    }
    Ok(())
}

fn path_to_c_string(path: &Path, label: &str) -> Result<CString, String> {
    let utf8 = path
        .to_str()
        .ok_or_else(|| format!("{label} must be representable as UTF-8"))?;
    CString::new(utf8).map_err(|_| format!("{label} contains an embedded NUL byte"))
}

unsafe fn copy_c_string(pointer: *const c_char, label: &str) -> Result<String, String> {
    if pointer.is_null() {
        return Err(format!("native {label} pointer was null"));
    }
    Ok(CStr::from_ptr(pointer).to_string_lossy().into_owned())
}

pub fn import_dictionary(archive_path: &Path, output_dir: &Path) -> ImportReport {
    let expected_title = match archive_dictionary_title(archive_path) {
        Ok(title) => title,
        Err(error) => return ImportReport::failure(error),
    };
    if let Err(error) = fs::create_dir_all(output_dir) {
        return ImportReport::failure(format!("failed to create import output directory: {error}"));
    }

    let archive = match path_to_c_string(archive_path, "archive path") {
        Ok(path) => path,
        Err(error) => return ImportReport::failure(error),
    };
    let output = match path_to_c_string(output_dir, "output directory") {
        Ok(path) => path,
        Err(error) => return ImportReport::failure(error),
    };

    let pointer = unsafe { hd_import(archive.as_ptr(), output.as_ptr(), 1) };
    if pointer.is_null() {
        return ImportReport::failure("native dictionary import failed without a result");
    }
    let result = ImportResultGuard(pointer);

    let title = unsafe { copy_c_string(hd_import_result_title(result.0), "import title") }
        .unwrap_or_default();
    let native_error = unsafe { copy_c_string(hd_import_result_error(result.0), "import error") }
        .unwrap_or_else(|error| error);
    let native_success = unsafe { hd_import_result_success(result.0) != 0 };
    let mut report = ImportReport {
        success: native_success,
        title,
        term_count: unsafe { hd_import_result_term_count(result.0) },
        meta_count: unsafe { hd_import_result_meta_count(result.0) },
        frequency_count: unsafe { hd_import_result_freq_count(result.0) },
        pitch_count: unsafe { hd_import_result_pitch_count(result.0) },
        kanji_count: unsafe { hd_import_result_kanji_count(result.0) },
        media_count: unsafe { hd_import_result_media_count(result.0) },
        error: native_error,
    };

    if report.success && report.title != expected_title {
        report.success = false;
        report.error = "imported dictionary title did not match archive index.json".into();
    }
    if report.success && !output_dir.join(&report.title).is_dir() {
        report.success = false;
        report.error = "native import did not create the expected dictionary directory".into();
    }
    report
}

#[derive(Debug, Deserialize)]
struct DictionaryManifest {
    version: u32,
    #[serde(default)]
    dictionaries: Vec<ManifestDictionary>,
}

#[derive(Debug, Deserialize)]
struct ManifestDictionary {
    id: String,
    path: String,
    #[serde(default = "enabled_by_default")]
    enabled: bool,
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct DictionaryIndex {
    title: String,
    counts: DictionaryCounts,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct DictionaryCounts {
    terms: ItemCount,
    term_meta: HashMap<String, u64>,
    kanji: ItemCount,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ItemCount {
    total: u64,
}

#[derive(Debug)]
struct DictionarySpec {
    path: PathBuf,
    has_frequency: bool,
    has_pitch: bool,
    has_kanji: bool,
}

fn validate_relative_dictionary_path(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() || path.len() > 4096 {
        return Err("dictionary manifest path is empty or too long".into());
    }
    let candidate = PathBuf::from(path);
    if candidate.is_absolute()
        || !candidate
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(format!(
            "dictionary manifest path must be a normalized relative path: {path}"
        ));
    }
    Ok(candidate)
}

fn read_dictionary_index(dictionary_path: &Path) -> Result<DictionaryIndex, String> {
    let index_path = dictionary_path.join("index.json");
    let metadata = fs::metadata(&index_path).map_err(|error| {
        format!(
            "dictionary is missing generated index.json at {}: {error}",
            index_path.display()
        )
    })?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_MANIFEST_BYTES {
        return Err(format!(
            "dictionary generated index.json has an invalid size at {}",
            index_path.display()
        ));
    }
    let contents = fs::read_to_string(&index_path).map_err(|error| {
        format!(
            "failed to read generated dictionary index {}: {error}",
            index_path.display()
        )
    })?;
    serde_json::from_str(&contents).map_err(|error| {
        format!(
            "failed to parse generated dictionary index {}: {error}",
            index_path.display()
        )
    })
}

fn validate_dictionary_directory(dictionary_path: &Path) -> Result<DictionarySpec, String> {
    let marker_exists = HOSHIDICTS_MARKERS
        .iter()
        .any(|marker| dictionary_path.join(marker).is_file());
    if !marker_exists {
        return Err(format!(
            "dictionary is missing a Hoshidicts format marker: {}",
            dictionary_path.display()
        ));
    }

    for file_name in REQUIRED_DICTIONARY_FILES {
        let file_path = dictionary_path.join(file_name);
        let metadata = fs::metadata(&file_path).map_err(|error| {
            format!(
                "dictionary is missing required file {}: {error}",
                file_path.display()
            )
        })?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(format!(
                "dictionary required file is empty or not a file: {}",
                file_path.display()
            ));
        }
    }

    let index = read_dictionary_index(dictionary_path)?;
    if index.title.trim().is_empty() {
        return Err(format!(
            "dictionary generated index has no title: {}",
            dictionary_path.display()
        ));
    }
    if index.counts.terms.total == 0 {
        return Err(format!(
            "dictionary has no term entries: {}",
            dictionary_path.display()
        ));
    }

    Ok(DictionarySpec {
        path: dictionary_path.to_path_buf(),
        has_frequency: index.counts.term_meta.get("freq").copied().unwrap_or(0) > 0,
        has_pitch: index.counts.term_meta.get("pitch").copied().unwrap_or(0) > 0
            || index.counts.term_meta.get("ipa").copied().unwrap_or(0) > 0,
        has_kanji: index.counts.kanji.total > 0,
    })
}

fn load_dictionary_specs(root: &Path) -> Result<Vec<DictionarySpec>, String> {
    let manifest_path = root.join(MANIFEST_FILE_NAME);
    if !manifest_path.exists() {
        return Ok(Vec::new());
    }
    let manifest_metadata = fs::metadata(&manifest_path)
        .map_err(|error| format!("failed to inspect Hoshidicts manifest: {error}"))?;
    if !manifest_metadata.is_file()
        || manifest_metadata.len() == 0
        || manifest_metadata.len() > MAX_MANIFEST_BYTES
    {
        return Err("Hoshidicts manifest is empty, oversized, or not a file".into());
    }
    let contents = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("failed to read Hoshidicts manifest: {error}"))?;
    let manifest: DictionaryManifest = serde_json::from_str(&contents)
        .map_err(|error| format!("failed to parse Hoshidicts manifest: {error}"))?;
    if manifest.version != 1 {
        return Err(format!(
            "unsupported Hoshidicts manifest version: {}",
            manifest.version
        ));
    }
    if manifest.dictionaries.len() > MAX_DICTIONARIES {
        return Err(format!(
            "Hoshidicts manifest exceeds the {MAX_DICTIONARIES}-dictionary limit"
        ));
    }

    let canonical_root = fs::canonicalize(root)
        .map_err(|error| format!("failed to resolve Hoshidicts data root: {error}"))?;
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    let mut specs = Vec::new();
    for dictionary in manifest
        .dictionaries
        .into_iter()
        .filter(|dictionary| dictionary.enabled)
    {
        if dictionary.id.trim().is_empty() || !ids.insert(dictionary.id.clone()) {
            return Err("Hoshidicts manifest contains an empty or duplicate dictionary id".into());
        }
        let relative_path = validate_relative_dictionary_path(&dictionary.path)?;
        if !paths.insert(relative_path.clone()) {
            return Err("Hoshidicts manifest contains a duplicate dictionary path".into());
        }
        let dictionary_path = root.join(relative_path);
        let canonical_dictionary = fs::canonicalize(&dictionary_path).map_err(|error| {
            format!(
                "failed to resolve dictionary directory {}: {error}",
                dictionary_path.display()
            )
        })?;
        if !canonical_dictionary.starts_with(&canonical_root) {
            return Err(format!(
                "dictionary path escapes the fixed Hoshidicts data root: {}",
                dictionary_path.display()
            ));
        }
        specs.push(validate_dictionary_directory(&canonical_dictionary)?);
    }
    Ok(specs)
}

struct NativeEngine {
    lookup: *mut HdLookup,
    query: *mut HdQuery,
    deinflector: *mut HdDeinflector,
    dictionary_count: usize,
}

// Hoshidicts has no thread affinity. Access to an engine is serialized by the
// service mutex, and native result data is copied before that lock is released.
unsafe impl Send for NativeEngine {}

impl NativeEngine {
    fn load(root: &Path) -> Result<Self, String> {
        let dictionaries = load_dictionary_specs(root)?;
        let query = unsafe { hd_query_new() };
        if query.is_null() {
            return Err("failed to create native Hoshidicts query".into());
        }
        let deinflector = unsafe { hd_deinflector_new() };
        if deinflector.is_null() {
            unsafe { hd_query_free(query) };
            return Err("failed to create native Hoshidicts deinflector".into());
        }

        for dictionary in &dictionaries {
            let path = match path_to_c_string(&dictionary.path, "dictionary path") {
                Ok(path) => path,
                Err(error) => {
                    unsafe {
                        hd_deinflector_free(deinflector);
                        hd_query_free(query);
                    }
                    return Err(error);
                }
            };
            let add = |name: &str,
                       callback: unsafe extern "C" fn(*mut HdQuery, *const c_char) -> c_int|
             -> Result<(), String> {
                if unsafe { callback(query, path.as_ptr()) } == 0 {
                    Ok(())
                } else {
                    Err(format!(
                        "native Hoshidicts rejected {name} dictionary {}",
                        dictionary.path.display()
                    ))
                }
            };
            if let Err(error) = add("term", hd_query_add_term_dict)
                .and_then(|_| {
                    if dictionary.has_frequency {
                        add("frequency", hd_query_add_freq_dict)
                    } else {
                        Ok(())
                    }
                })
                .and_then(|_| {
                    if dictionary.has_pitch {
                        add("pitch", hd_query_add_pitch_dict)
                    } else {
                        Ok(())
                    }
                })
                .and_then(|_| {
                    if dictionary.has_kanji {
                        add("kanji", hd_query_add_kanji_dict)
                    } else {
                        Ok(())
                    }
                })
            {
                unsafe {
                    hd_deinflector_free(deinflector);
                    hd_query_free(query);
                }
                return Err(error);
            }
        }

        let lookup = unsafe { hd_lookup_new(query, deinflector) };
        if lookup.is_null() {
            unsafe {
                hd_deinflector_free(deinflector);
                hd_query_free(query);
            }
            return Err("failed to create native Hoshidicts lookup".into());
        }

        Ok(Self {
            lookup,
            query,
            deinflector,
            dictionary_count: dictionaries.len(),
        })
    }

    fn lookup(&self, text: &str) -> Result<Vec<LookupResult>, String> {
        validate_lookup_text(text)?;
        let lookup_text =
            CString::new(text).map_err(|_| "lookup text contains an embedded NUL byte")?;
        let mut result_pointer = ptr::null();
        let mut result_count = 0usize;
        let owned_results = unsafe {
            hd_lookup_run(
                self.lookup,
                lookup_text.as_ptr(),
                LOOKUP_MAX_RESULTS,
                LOOKUP_SCAN_LENGTH,
                &mut result_pointer,
                &mut result_count,
            )
        };
        if owned_results.is_null() {
            return Err("native Hoshidicts lookup failed".into());
        }
        let _owned_results = LookupResultsGuard(owned_results);
        if result_count > LOOKUP_MAX_RESULTS as usize {
            return Err("native Hoshidicts returned too many lookup results".into());
        }
        let native_results =
            unsafe { checked_slice(result_pointer, result_count, "lookup results")? };

        let mut glossary_count = 0usize;
        native_results
            .iter()
            .map(|result| unsafe {
                let trace_count = result.trace_count.min(MAX_TRACE_STEPS);
                let trace = checked_slice(result.trace, trace_count, "deinflection trace")?
                    .iter()
                    .map(|step| {
                        Ok(LookupTrace {
                            name: copy_hd_string(step.name, "trace name")?,
                            description: copy_hd_string(step.description, "trace description")?,
                        })
                    })
                    .collect::<Result<Vec<_>, String>>()?;

                let remaining_glossaries = MAX_GLOSSARIES.saturating_sub(glossary_count);
                let current_glossary_count = result.term.glossaries_count.min(remaining_glossaries);
                let glossaries =
                    checked_slice(result.term.glossaries, current_glossary_count, "glossaries")?
                        .iter()
                        .map(|glossary| {
                            Ok(LookupGlossary {
                                dictionary: copy_hd_string(
                                    glossary.dict_name,
                                    "glossary dictionary",
                                )?,
                                glossary: copy_hd_string(glossary.glossary, "glossary content")?,
                                definition_tags: copy_hd_string(
                                    glossary.definition_tags,
                                    "definition tags",
                                )?,
                                term_tags: copy_hd_string(glossary.term_tags, "term tags")?,
                            })
                        })
                        .collect::<Result<Vec<_>, String>>()?;
                glossary_count += glossaries.len();
                let frequencies =
                    copy_frequency_entries(result.term.frequencies, result.term.frequencies_count)?;
                let pitches = copy_pitch_entries(result.term.pitches, result.term.pitches_count)?;

                Ok(LookupResult {
                    matched: copy_hd_string(result.matched, "matched text")?,
                    deinflected: copy_hd_string(result.deinflected, "deinflected text")?,
                    trace,
                    term: LookupTerm {
                        expression: copy_hd_string(result.term.expression, "term expression")?,
                        reading: copy_hd_string(result.term.reading, "term reading")?,
                        rules: copy_hd_string(result.term.rules, "term rules")?,
                        score: result.term.score,
                        glossaries,
                        frequencies,
                        pitches,
                    },
                    preprocessor_steps: result.preprocessor_steps,
                })
            })
            .collect()
    }
}

impl Drop for NativeEngine {
    fn drop(&mut self) {
        unsafe {
            // Lookup borrows both dependencies, so it must be destroyed first.
            if !self.lookup.is_null() {
                hd_lookup_free(self.lookup);
                self.lookup = ptr::null_mut();
            }
            if !self.query.is_null() {
                hd_query_free(self.query);
                self.query = ptr::null_mut();
            }
            if !self.deinflector.is_null() {
                hd_deinflector_free(self.deinflector);
                self.deinflector = ptr::null_mut();
            }
        }
    }
}

unsafe fn checked_slice<'a, T>(
    pointer: *const T,
    count: usize,
    label: &str,
) -> Result<&'a [T], String> {
    if count == 0 {
        return Ok(&[]);
    }
    if pointer.is_null() {
        return Err(format!("native {label} pointer was null"));
    }
    Ok(slice::from_raw_parts(pointer, count))
}

unsafe fn copy_hd_string(value: HdStr, label: &str) -> Result<String, String> {
    if value.len == 0 {
        return Ok(String::new());
    }
    if value.ptr.is_null() {
        return Err(format!("native {label} pointer was null"));
    }
    if value.len > MAX_NATIVE_STRING_BYTES {
        return Err(format!("native {label} exceeds the permitted size"));
    }
    let bytes = slice::from_raw_parts(value.ptr.cast::<u8>(), value.len);
    String::from_utf8(bytes.to_vec()).map_err(|_| format!("native {label} was not valid UTF-8"))
}

unsafe fn copy_frequency_entries(
    pointer: *const HdFrequencyEntry,
    count: usize,
) -> Result<Vec<LookupFrequencyEntry>, String> {
    checked_slice(
        pointer,
        count.min(MAX_FREQUENCY_ENTRIES),
        "frequency entries",
    )?
    .iter()
    .map(|entry| {
        let frequencies = checked_slice(
            entry.frequencies,
            entry.frequencies_count.min(MAX_FREQUENCIES_PER_ENTRY),
            "frequency values",
        )?
        .iter()
        .map(|frequency| {
            Ok(LookupFrequency {
                value: frequency.value,
                display_value: copy_hd_string(frequency.display_value, "frequency display value")?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
        Ok(LookupFrequencyEntry {
            dictionary: copy_hd_string(entry.dict_name, "frequency dictionary")?,
            frequencies,
        })
    })
    .collect()
}

unsafe fn copy_pitch_entries(
    pointer: *const HdPitchEntry,
    count: usize,
) -> Result<Vec<LookupPitchEntry>, String> {
    checked_slice(pointer, count.min(MAX_PITCH_ENTRIES), "pitch entries")?
        .iter()
        .map(|entry| {
            let pitches = checked_slice(
                entry.pitches,
                entry.pitches_count.min(MAX_PITCHES_PER_ENTRY),
                "pitch values",
            )?
            .iter()
            .map(|pitch| {
                Ok(LookupPitch {
                    position: pitch.position,
                    pattern: copy_hd_string(pitch.pattern, "pitch pattern")?,
                    nasal: checked_slice(
                        pitch.nasal,
                        pitch.nasal_count.min(MAX_PITCH_MARKERS),
                        "pitch nasal markers",
                    )?
                    .to_vec(),
                    devoice: checked_slice(
                        pitch.devoice,
                        pitch.devoice_count.min(MAX_PITCH_MARKERS),
                        "pitch devoice markers",
                    )?
                    .to_vec(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
            let transcriptions = checked_slice(
                entry.transcriptions,
                entry.transcriptions_count.min(MAX_TRANSCRIPTIONS_PER_ENTRY),
                "pitch transcriptions",
            )?
            .iter()
            .map(|transcription| copy_hd_string(*transcription, "pitch transcription"))
            .collect::<Result<Vec<_>, String>>()?;
            Ok(LookupPitchEntry {
                dictionary: copy_hd_string(entry.dict_name, "pitch dictionary")?,
                pitches,
                transcriptions,
            })
        })
        .collect()
}

pub fn validate_lookup_text(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Err("lookup text must not be empty".into());
    }
    if text.len() > MAX_LOOKUP_TEXT_BYTES {
        return Err(format!(
            "lookup text exceeds the {MAX_LOOKUP_TEXT_BYTES}-byte limit"
        ));
    }
    if text.contains('\0') {
        return Err("lookup text contains an embedded NUL byte".into());
    }
    Ok(())
}

pub struct HoshidictsService {
    root: PathBuf,
    engine: Option<NativeEngine>,
}

impl HoshidictsService {
    pub fn new(root: PathBuf) -> Self {
        Self { root, engine: None }
    }

    pub fn activate(&mut self) -> Result<usize, String> {
        if self.engine.is_none() {
            self.engine = Some(NativeEngine::load(&self.root)?);
        }
        Ok(self.dictionary_count())
    }

    pub fn deactivate(&mut self) {
        self.engine = None;
    }

    pub fn reload(&mut self) -> Result<usize, String> {
        let replacement = NativeEngine::load(&self.root)?;
        let dictionary_count = replacement.dictionary_count;
        self.engine = Some(replacement);
        Ok(dictionary_count)
    }

    pub fn lookup(&mut self, text: &str) -> Result<Vec<LookupResult>, String> {
        self.activate()?;
        self.engine
            .as_ref()
            .expect("engine was activated")
            .lookup(text)
    }

    #[cfg(test)]
    pub fn is_loaded(&self) -> bool {
        self.engine.is_some()
    }

    pub fn dictionary_count(&self) -> usize {
        self.engine
            .as_ref()
            .map(|engine| engine.dictionary_count)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    use zip::write::SimpleFileOptions;

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(1);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let nonce = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
            let time = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock before Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "gsm-hoshidicts-{label}-{}-{time}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_dictionary(root: &Path, relative: &str, terms: u64) -> PathBuf {
        let dictionary = root.join(relative);
        fs::create_dir_all(&dictionary).expect("create dictionary");
        fs::write(dictionary.join(".hoshidicts_3"), []).expect("write marker");
        fs::write(dictionary.join("hash.table"), [1]).expect("write hash");
        fs::write(dictionary.join("bloom.filter"), [1]).expect("write bloom");
        fs::write(dictionary.join("blobs.bin"), [1]).expect("write blobs");
        fs::write(
            dictionary.join("index.json"),
            format!(
                r#"{{"title":"Test","counts":{{"terms":{{"total":{terms}}},"termMeta":{{"total":0}},"kanji":{{"total":0}}}}}}"#
            ),
        )
        .expect("write index");
        dictionary
    }

    fn write_manifest(root: &Path, path: &str) {
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            format!(r#"{{"version":1,"dictionaries":[{{"id":"test","path":"{path}"}}]}}"#),
        )
        .expect("write manifest");
    }

    fn write_test_archive(path: &Path) {
        let file = fs::File::create(path).expect("create archive");
        let mut archive = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        archive
            .start_file("index.json", options)
            .expect("start index");
        archive
            .write_all(
                br#"{"title":"Test Dictionary","revision":"1","format":3,"sequenced":false,"sourceLanguage":"ja"}"#,
            )
            .expect("write index");
        archive
            .start_file("term_bank_1.json", options)
            .expect("start term bank");
        archive
            .write_all(r#"[["食べる","たべる","","v1",0,["to eat"],1,""]]"#.as_bytes())
            .expect("write term bank");
        archive
            .start_file("term_meta_bank_1.json", options)
            .expect("start term metadata bank");
        archive
            .write_all(
                r#"[["食べる","freq",{"reading":"たべる","frequency":{"value":123,"displayValue":"123 ★"}}],["食べる","pitch",{"reading":"たべる","pitches":[{"position":2,"nasal":[1],"devoice":[2]}]}]]"#
                    .as_bytes(),
            )
            .expect("write term metadata bank");
        archive.finish().expect("finish archive");
    }

    #[test]
    fn request_ids_and_lookup_text_are_bounded() {
        assert!(RequestId::Number(42).validate().is_ok());
        assert!(RequestId::Text("request-42".into()).validate().is_ok());
        assert!(RequestId::Text("x".repeat(MAX_REQUEST_ID_BYTES + 1))
            .validate()
            .is_err());
        assert!(validate_lookup_text("").is_err());
        assert!(validate_lookup_text(&"x".repeat(MAX_LOOKUP_TEXT_BYTES + 1)).is_err());
    }

    #[test]
    fn manifest_validation_requires_marker_index_terms_and_native_files() {
        let root = TestDir::new("validation");
        let dictionary = write_dictionary(&root.0, "generations/test/1/Test", 1);
        write_manifest(&root.0, "generations/test/1/Test");
        assert_eq!(
            load_dictionary_specs(&root.0)
                .expect("valid manifest")
                .len(),
            1
        );

        fs::remove_file(dictionary.join(".hoshidicts_3")).expect("remove marker");
        assert!(load_dictionary_specs(&root.0)
            .expect_err("missing marker must fail")
            .contains("format marker"));
    }

    #[test]
    fn manifest_rejects_paths_outside_the_fixed_root() {
        let root = TestDir::new("path-escape");
        write_manifest(&root.0, "../outside");
        assert!(load_dictionary_specs(&root.0)
            .expect_err("path escape must fail")
            .contains("normalized relative path"));
    }

    #[test]
    fn failed_reload_preserves_the_active_engine() {
        let root = TestDir::new("rollback");
        let mut service = HoshidictsService::new(root.0.clone());
        assert_eq!(service.activate().expect("activate empty engine"), 0);
        assert!(service.is_loaded());

        fs::write(root.0.join(MANIFEST_FILE_NAME), "{not-json").expect("write bad manifest");
        assert!(service.reload().is_err());
        assert!(service.is_loaded());
        assert_eq!(service.dictionary_count(), 0);
        assert!(service
            .lookup("食べる")
            .expect("old engine remains")
            .is_empty());
    }

    #[test]
    fn ffi_import_lookup_and_owned_drop_order_work_end_to_end() {
        let root = TestDir::new("ffi");
        let archive_path = root.0.join("dictionary.zip");
        write_test_archive(&archive_path);

        let report = import_dictionary(&archive_path, &root.0);
        assert_eq!(
            report,
            ImportReport {
                success: true,
                title: "Test Dictionary".into(),
                term_count: 1,
                meta_count: 2,
                frequency_count: 1,
                pitch_count: 1,
                kanji_count: 0,
                media_count: 0,
                error: String::new(),
            }
        );
        fs::write(
            root.0.join(MANIFEST_FILE_NAME),
            r#"{"version":1,"dictionaries":[{"id":"test","path":"Test Dictionary"}]}"#,
        )
        .expect("write manifest");

        let mut service = HoshidictsService::new(root.0.clone());
        assert_eq!(service.activate().expect("activate dictionary"), 1);
        let results = service.lookup("食べた").expect("deinflected lookup");
        let result = results
            .iter()
            .find(|result| result.term.expression == "食べる")
            .expect("term result");
        assert_eq!(
            result.term.frequencies,
            vec![LookupFrequencyEntry {
                dictionary: "Test Dictionary".into(),
                frequencies: vec![LookupFrequency {
                    value: 123,
                    display_value: "123 ★".into(),
                }],
            }]
        );
        assert_eq!(
            result.term.pitches,
            vec![LookupPitchEntry {
                dictionary: "Test Dictionary".into(),
                pitches: vec![LookupPitch {
                    position: 2,
                    pattern: String::new(),
                    nasal: vec![1],
                    devoice: vec![2],
                }],
                transcriptions: Vec::new(),
            }]
        );
        drop(service);
    }

    #[test]
    fn import_output_is_one_json_value_with_stable_field_names() {
        let report = ImportReport::failure("bad archive");
        let line = report.to_json_line();
        assert!(!line.contains('\n'));
        let value: serde_json::Value = serde_json::from_str(&line).expect("valid JSON");
        assert_eq!(value["success"], false);
        assert_eq!(value["termCount"], 0);
        assert_eq!(value["error"], "bad archive");
    }

    #[test]
    fn unsafe_dictionary_titles_are_rejected_before_native_import() {
        for title in ["../escape", r"..\escape", "CON", "name.", "bad:name"] {
            assert!(validate_dictionary_title(title).is_err(), "{title}");
        }
        assert!(validate_dictionary_title("日本語辞書").is_ok());
    }
}
