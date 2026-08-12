use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, c_int, CStr, CString};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::ptr;
use std::slice;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex;
use tokio::task;
use tracing::{info, warn};

const MANIFEST_FILE_NAME: &str = "manifest.json";
const DEFAULT_LOOKUP_SCAN_LENGTH: usize = 16;
const MIN_LOOKUP_SCAN_LENGTH: usize = 1;
const MAX_LOOKUP_SCAN_LENGTH: usize = 64;
const DEFAULT_LOOKUP_MAX_RESULTS: c_int = 32;
const MIN_LOOKUP_MAX_RESULTS: c_int = 1;
const MAX_LOOKUP_MAX_RESULTS: c_int = 256;
const MAX_LOOKUP_TEXT_BYTES: usize = 4 * 1024;
const MAX_LOOKUP_PRIMARY_READING_BYTES: usize = 4 * 1024;
const MAX_LOOKUP_SORT_DICTIONARY_BYTES: usize = 4 * 1024;
const MAX_LOOKUP_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_MEDIA_DICTIONARY_BYTES: usize = 1024;
const MAX_MEDIA_PATH_BYTES: usize = 4 * 1024;
const MAX_MEDIA_BYTES: usize = 4 * 1024 * 1024;
const MAX_MEDIA_RESPONSE_BYTES: usize = 6 * 1024 * 1024;
const MAX_STYLES_RESPONSE_BYTES: usize = 3 * 1024 * 1024;

const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_DICTIONARIES: usize = 256;
const MAX_NATIVE_STRING_BYTES: usize = MAX_LOOKUP_RESPONSE_BYTES;
const MAX_GLOSSARY_BYTES: usize = 8 * 1024 * 1024;
const MAX_DICTIONARY_STYLE_BYTES: usize = 256 * 1024;
const MAX_STYLE_DICTIONARY_BYTES: usize = 1024;
const MAX_TRACE_STEPS: usize = 32;
const MAX_KANJI_ENTRIES: usize = 64;
const MAX_KANJI_DEFINITIONS_PER_ENTRY: usize = 64;
const MAX_KANJI_STATS_PER_ENTRY: usize = 128;
const MAX_ARCHIVE_INDEX_BYTES: u64 = 1024 * 1024;
const MAX_MEDIA_RECORDS: u64 = 1_000_000;
const REQUIRED_DICTIONARY_FILES: [&str; 3] = ["hash.table", "bloom.filter", "blobs.bin"];
const HOSHIDICTS_MARKERS: [&str; 4] = [
    ".hoshidicts_4",
    ".hoshidicts_3",
    ".hoshidicts_2",
    ".hoshidicts_1",
];

/// Opaque native handle: only ever held behind a pointer.
macro_rules! hd_opaque {
    ($($name:ident),+ $(,)?) => {
        $(
            #[repr(C)]
            struct $name {
                _private: [u8; 0],
            }
        )+
    };
}

hd_opaque!(
    HdImportResult,
    HdDeinflector,
    HdQuery,
    HdLookup,
    HdLookupResults,
    HdKanjiResults,
    HdStyles,
);

#[derive(Clone, Copy)]
#[repr(C)]
struct HdMediaFile {
    data: *const u8,
    size: usize,
}

#[derive(Clone, Copy)]
#[repr(C)]
struct HdStr {
    ptr: *const c_char,
    len: usize,
}

fn optional_hd_string(value: Option<&str>) -> HdStr {
    match value {
        Some(value) => HdStr {
            ptr: value.as_ptr().cast(),
            len: value.len(),
        },
        None => HdStr {
            ptr: ptr::null(),
            len: 0,
        },
    }
}

#[derive(Clone, Copy)]
#[repr(C)]
struct HdDictionaryStyle {
    dict_name: HdStr,
    styles: HdStr,
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

#[derive(Clone, Copy)]
#[repr(C)]
struct HdLookupOptions {
    primary_reading: HdStr,
    frequency_dictionary: HdStr,
    frequency_order: i32,
}

const HD_LOOKUP_FREQUENCY_ORDER_ASCENDING: i32 = 1;
const HD_LOOKUP_FREQUENCY_ORDER_DESCENDING: i32 = 2;
const HD_LOOKUP_FREQUENCY_ORDER_DISABLED: i32 = 3;

#[derive(Clone, Copy)]
#[repr(C)]
struct HdKanjiStat {
    key: HdStr,
    value: HdStr,
}

#[derive(Clone, Copy)]
#[repr(C)]
struct HdKanjiEntry {
    dict_name: HdStr,
    onyomi: HdStr,
    kunyomi: HdStr,
    tags: HdStr,
    definitions: *const HdStr,
    definitions_count: usize,
    stats: *const HdKanjiStat,
    stats_count: usize,
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
    fn hd_query_run_kanji(
        query: *const HdQuery,
        kanji: *const c_char,
        out_entries: *mut *const HdKanjiEntry,
        out_count: *mut usize,
    ) -> *mut HdKanjiResults;
    fn hd_kanji_results_free(results: *mut HdKanjiResults);
    fn hd_query_get_media_file(
        query: *const HdQuery,
        dict_name: *const c_char,
        media_path: *const c_char,
    ) -> HdMediaFile;
    fn hd_query_get_styles(
        query: *const HdQuery,
        out_styles: *mut *const HdDictionaryStyle,
        out_count: *mut usize,
    ) -> *mut HdStyles;
    fn hd_styles_free(styles: *mut HdStyles);

    fn hd_lookup_new(query: *mut HdQuery, deinflector: *mut HdDeinflector) -> *mut HdLookup;
    fn hd_lookup_free(lookup: *mut HdLookup);
    fn hd_lookup_run_with_options(
        lookup: *const HdLookup,
        lookup_string: *const c_char,
        max_results: c_int,
        scan_length: usize,
        options: *const HdLookupOptions,
        out_results: *mut *const HdLookupResult,
        out_count: *mut usize,
    ) -> *mut HdLookupResults;
    fn hd_lookup_results_free(results: *mut HdLookupResults);
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
enum RequestId {
    Number(u64),
    Text(String),
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum LookupFrequencySortOrder {
    Ascending,
    Descending,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LookupOptions {
    scan_length: usize,
    max_results: c_int,
    primary_reading: Option<String>,
    sort_frequency_dictionary: Option<String>,
    sort_frequency_order: LookupFrequencySortOrder,
}

impl Default for LookupOptions {
    fn default() -> Self {
        Self {
            scan_length: DEFAULT_LOOKUP_SCAN_LENGTH,
            max_results: DEFAULT_LOOKUP_MAX_RESULTS,
            primary_reading: None,
            sort_frequency_dictionary: None,
            sort_frequency_order: LookupFrequencySortOrder::Descending,
        }
    }
}

impl LookupOptions {
    /// Every field comes from the overlay, which already bounds scanLength and
    /// maxResults to exactly these ranges, so out-of-range values mean a bug on
    /// our own side rather than a request worth rejecting: clamp and serve.
    fn from_request(
        scan_length: Option<i64>,
        max_results: Option<i64>,
        primary_reading: Option<String>,
        sort_frequency_dictionary: Option<String>,
        sort_frequency_order: Option<LookupFrequencySortOrder>,
    ) -> Self {
        let clamp = |value: Option<i64>, default: i64, min: i64, max: i64| {
            value.unwrap_or(default).clamp(min, max)
        };
        // The byte bound stays: tungstenite admits messages up to 64 MiB.
        let bounded = |value: Option<String>, maximum_bytes: usize| {
            value.filter(|value| {
                !value.is_empty()
                    && value.len() <= maximum_bytes
                    && !value.chars().any(char::is_control)
            })
        };
        Self {
            scan_length: clamp(
                scan_length,
                DEFAULT_LOOKUP_SCAN_LENGTH as i64,
                MIN_LOOKUP_SCAN_LENGTH as i64,
                MAX_LOOKUP_SCAN_LENGTH as i64,
            ) as usize,
            max_results: clamp(
                max_results,
                DEFAULT_LOOKUP_MAX_RESULTS as i64,
                MIN_LOOKUP_MAX_RESULTS as i64,
                MAX_LOOKUP_MAX_RESULTS as i64,
            ) as c_int,
            primary_reading: bounded(primary_reading, MAX_LOOKUP_PRIMARY_READING_BYTES),
            sort_frequency_dictionary: bounded(
                sort_frequency_dictionary,
                MAX_LOOKUP_SORT_DICTIONARY_BYTES,
            ),
            sort_frequency_order: sort_frequency_order
                .unwrap_or(LookupFrequencySortOrder::Descending),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct LookupTrace {
    name: String,
    description: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct LookupGlossary {
    dictionary: String,
    glossary: String,
    definition_tags: String,
    term_tags: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LookupFrequency {
    value: i32,
    display_value: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LookupFrequencyEntry {
    dictionary: String,
    frequencies: Vec<LookupFrequency>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct LookupPitch {
    position: i32,
    pattern: String,
    nasal: Vec<i32>,
    devoice: Vec<i32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct LookupPitchEntry {
    dictionary: String,
    pitches: Vec<LookupPitch>,
    transcriptions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LookupTerm {
    expression: String,
    reading: String,
    rules: String,
    score: i32,
    glossaries: Vec<LookupGlossary>,
    frequencies: Vec<LookupFrequencyEntry>,
    pitches: Vec<LookupPitchEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct LookupResult {
    matched: String,
    deinflected: String,
    trace: Vec<LookupTrace>,
    term: LookupTerm,
    preprocessor_steps: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MediaFile {
    media_type: &'static str,
    data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DictionaryStyle {
    dictionary: String,
    styles: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum StylesError {
    StaleGeneration,
    Internal(String),
}

impl StylesError {
    const fn code(&self) -> &'static str {
        match self {
            Self::StaleGeneration => "stale_generation",
            Self::Internal(_) => "internal_error",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaError {
    InvalidDictionary,
    InvalidPath,
    NotFound,
    UnsupportedMediaType,
    MediaTooLarge,
    StaleGeneration,
    InternalError,
}

impl MediaError {
    const fn code(self) -> &'static str {
        match self {
            Self::InvalidDictionary => "invalid_dictionary",
            Self::InvalidPath => "invalid_path",
            Self::NotFound => "not_found",
            Self::UnsupportedMediaType => "unsupported_media_type",
            Self::MediaTooLarge => "media_too_large",
            Self::StaleGeneration => "stale_generation",
            Self::InternalError => "internal_error",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct LookupKanjiStat {
    name: String,
    value: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct LookupKanjiEntry {
    dictionary: String,
    onyomi: String,
    kunyomi: String,
    tags: String,
    definitions: Vec<String>,
    stats: Vec<LookupKanjiStat>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct LookupKanji {
    character: String,
    entries: Vec<LookupKanjiEntry>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
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
            error: error.into(),
            ..Default::default()
        }
    }

    pub fn to_json_line(&self) -> String {
        // Only bools, integers and Strings, so serialization cannot fail.
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// Owns one native result handle and releases it with its own free function.
macro_rules! hd_owned {
    ($($guard:ident($handle:ident) => $free:ident;)+) => {
        $(
            struct $guard(*mut $handle);

            impl Drop for $guard {
                fn drop(&mut self) {
                    if !self.0.is_null() {
                        unsafe { $free(self.0) };
                    }
                }
            }
        )+
    };
}

hd_owned! {
    ImportResultGuard(HdImportResult) => hd_import_result_free;
    LookupResultsGuard(HdLookupResults) => hd_lookup_results_free;
    KanjiResultsGuard(HdKanjiResults) => hd_kanji_results_free;
    StylesGuard(HdStyles) => hd_styles_free;
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
    media: ItemCount,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ItemCount {
    total: u64,
}

#[derive(Debug)]
struct DictionarySpec {
    path: PathBuf,
    has_terms: bool,
    has_frequency: bool,
    has_pitch: bool,
    has_kanji: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DictionaryKind {
    Term,
    Frequency,
    Pitch,
    Kanji,
}

impl DictionarySpec {
    fn query_kinds(&self) -> impl Iterator<Item = DictionaryKind> {
        [
            self.has_terms.then_some(DictionaryKind::Term),
            self.has_frequency.then_some(DictionaryKind::Frequency),
            self.has_pitch.then_some(DictionaryKind::Pitch),
            self.has_kanji.then_some(DictionaryKind::Kanji),
        ]
        .into_iter()
        .flatten()
    }
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

/// Read one small JSON file, refusing anything empty, oversized, or not a file
/// before it is allocated.
fn read_bounded_json<T: serde::de::DeserializeOwned>(
    path: &Path,
    maximum_bytes: u64,
    label: &str,
) -> Result<T, String> {
    let display = path.display();
    let metadata =
        fs::metadata(path).map_err(|error| format!("missing {label} at {display}: {error}"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > maximum_bytes {
        return Err(format!(
            "{label} is empty, oversized, or not a file: {display}"
        ));
    }
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("failed to read {label} at {display}: {error}"))?;
    serde_json::from_str(&contents)
        .map_err(|error| format!("failed to parse {label} at {display}: {error}"))
}

const MEDIA_FRAMING_ERROR: &str = "dictionary media.bin has a malformed record";

/// Bounds one record's framing and returns where it ends.
///
/// Mandatory rather than defensive: query.cpp indexes the mmap as
/// `media.data + offset` and reads the blob length with no bounds checking of
/// its own, and both the path length and the blob length come out of a
/// user-downloaded Yomitan ZIP.
fn media_record_end(
    media_file: &mut fs::File,
    media_size: u64,
    offset: u64,
) -> Result<u64, String> {
    let framing = || MEDIA_FRAMING_ERROR.to_string();
    let mut path_header = [0u8; 2];
    media_file
        .seek(SeekFrom::Start(offset))
        .and_then(|_| media_file.read_exact(&mut path_header))
        .map_err(|_| framing())?;
    let path_length = u64::from(u16::from_le_bytes(path_header));
    if path_length == 0 || path_length > MAX_MEDIA_PATH_BYTES as u64 {
        return Err(framing());
    }

    let blob_header_offset = offset
        .checked_add(2)
        .and_then(|value| value.checked_add(path_length))
        .ok_or_else(framing)?;
    let mut blob_header = [0u8; 4];
    media_file
        .seek(SeekFrom::Start(blob_header_offset))
        .and_then(|_| media_file.read_exact(&mut blob_header))
        .map_err(|_| framing())?;
    let blob_length = u64::from(u32::from_le_bytes(blob_header));
    if blob_length == 0 || blob_length > MAX_MEDIA_BYTES as u64 {
        return Err(framing());
    }

    let end = blob_header_offset
        .checked_add(4)
        .and_then(|value| value.checked_add(blob_length))
        .ok_or_else(framing)?;
    if end > media_size {
        return Err(framing());
    }
    Ok(end)
}

fn validate_native_media_files(dictionary_path: &Path, declared_count: u64) -> Result<(), String> {
    let index_path = dictionary_path.join("media.idx");
    let media_path = dictionary_path.join("media.bin");

    if declared_count == 0 {
        for file_path in [&index_path, &media_path] {
            match fs::metadata(file_path) {
                Ok(_) => {
                    return Err(format!(
                        "dictionary declares no media but contains {}",
                        file_path.display()
                    ));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "failed to inspect dictionary media file {}: {error}",
                        file_path.display()
                    ));
                }
            }
        }
        return Ok(());
    }

    if declared_count > MAX_MEDIA_RECORDS {
        return Err(format!(
            "dictionary media count exceeds the {MAX_MEDIA_RECORDS}-record limit"
        ));
    }
    let expected_count = u32::try_from(declared_count)
        .map_err(|_| "dictionary media count exceeds the native index format".to_string())?;
    let expected_index_size = declared_count
        .checked_mul(8)
        .and_then(|size| size.checked_add(4))
        .ok_or_else(|| "dictionary media index size overflowed".to_string())?;

    let index_metadata = fs::metadata(&index_path).map_err(|error| {
        format!(
            "dictionary with media is missing required file {}: {error}",
            index_path.display()
        )
    })?;
    if !index_metadata.is_file() || index_metadata.len() != expected_index_size {
        return Err(format!(
            "dictionary media.idx has size {}, expected exactly {expected_index_size} bytes for {declared_count} records: {}",
            index_metadata.len(),
            index_path.display()
        ));
    }

    let media_metadata = fs::metadata(&media_path).map_err(|error| {
        format!(
            "dictionary with media is missing required file {}: {error}",
            media_path.display()
        )
    })?;
    if !media_metadata.is_file() || media_metadata.len() == 0 {
        return Err(format!(
            "dictionary media.bin is empty or not a file: {}",
            media_path.display()
        ));
    }
    let media_size = media_metadata.len();

    let mut index_file = fs::File::open(&index_path).map_err(|error| {
        format!(
            "failed to open dictionary media index {}: {error}",
            index_path.display()
        )
    })?;
    let mut count_bytes = [0u8; 4];
    index_file.read_exact(&mut count_bytes).map_err(|error| {
        format!(
            "failed to read dictionary media index count {}: {error}",
            index_path.display()
        )
    })?;
    let indexed_count = u32::from_le_bytes(count_bytes);
    if indexed_count != expected_count {
        return Err(format!(
            "dictionary media.idx count {indexed_count} does not match declared media count {declared_count}"
        ));
    }

    let count = usize::try_from(declared_count)
        .map_err(|_| "dictionary media count cannot fit in memory".to_string())?;
    let mut media_file = fs::File::open(&media_path).map_err(|error| {
        format!(
            "failed to open dictionary media data {}: {error}",
            media_path.display()
        )
    })?;
    // The importer sorts these and writes them contiguously; re-deriving that
    // only re-checks our own writer. What matters is that every offset frames a
    // record inside media.bin, which is what query.cpp assumes.
    for index in 0..count {
        let mut offset_bytes = [0u8; 8];
        index_file.read_exact(&mut offset_bytes).map_err(|error| {
            format!(
                "failed to read dictionary media index offset {index} from {}: {error}",
                index_path.display()
            )
        })?;
        media_record_end(
            &mut media_file,
            media_size,
            u64::from_le_bytes(offset_bytes),
        )?;
    }

    Ok(())
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

    let index: DictionaryIndex = read_bounded_json(
        &dictionary_path.join("index.json"),
        MAX_MANIFEST_BYTES,
        "generated dictionary index.json",
    )?;
    if index.title.trim().is_empty() {
        return Err(format!(
            "dictionary generated index has no title: {}",
            dictionary_path.display()
        ));
    }
    let has_terms = index.counts.terms.total > 0;
    let has_frequency = index.counts.term_meta.get("freq").copied().unwrap_or(0) > 0;
    let has_pitch = index.counts.term_meta.get("pitch").copied().unwrap_or(0) > 0
        || index.counts.term_meta.get("ipa").copied().unwrap_or(0) > 0;
    let has_kanji = index.counts.kanji.total > 0;
    if !has_terms && !has_frequency && !has_pitch && !has_kanji {
        return Err(format!(
            "dictionary has no queryable entries: {}",
            dictionary_path.display()
        ));
    }
    validate_native_media_files(dictionary_path, index.counts.media.total)?;

    Ok(DictionarySpec {
        path: dictionary_path.to_path_buf(),
        has_terms,
        has_frequency,
        has_pitch,
        has_kanji,
    })
}

fn load_dictionary_specs(root: &Path) -> Result<Vec<DictionarySpec>, String> {
    let manifest_path = root.join(MANIFEST_FILE_NAME);
    if !manifest_path.exists() {
        return Ok(Vec::new());
    }
    let manifest: DictionaryManifest =
        read_bounded_json(&manifest_path, MAX_MANIFEST_BYTES, "Hoshidicts manifest")?;
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
        // Keep the canonical path for containment checks, but pass the regular
        // Windows path to Hoshidicts. Its native loader appends filenames with
        // `/`, which does not work after Rust adds the `\\?\` verbatim prefix.
        specs.push(validate_dictionary_directory(&dictionary_path)?);
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
            for kind in dictionary.query_kinds() {
                let result = match kind {
                    DictionaryKind::Term => add("term", hd_query_add_term_dict),
                    DictionaryKind::Frequency => add("frequency", hd_query_add_freq_dict),
                    DictionaryKind::Pitch => add("pitch", hd_query_add_pitch_dict),
                    DictionaryKind::Kanji => add("kanji", hd_query_add_kanji_dict),
                };
                if let Err(error) = result {
                    unsafe {
                        hd_deinflector_free(deinflector);
                        hd_query_free(query);
                    }
                    return Err(error);
                }
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

    fn lookup(&self, text: &str, options: &LookupOptions) -> Result<Vec<LookupResult>, String> {
        validate_lookup_text(text)?;
        let lookup_text =
            CString::new(text).map_err(|_| "lookup text contains an embedded NUL byte")?;
        let frequency_order = if options.sort_frequency_dictionary.is_none() {
            HD_LOOKUP_FREQUENCY_ORDER_DISABLED
        } else {
            match options.sort_frequency_order {
                LookupFrequencySortOrder::Ascending => HD_LOOKUP_FREQUENCY_ORDER_ASCENDING,
                LookupFrequencySortOrder::Descending => HD_LOOKUP_FREQUENCY_ORDER_DESCENDING,
            }
        };
        let native_options = HdLookupOptions {
            primary_reading: optional_hd_string(options.primary_reading.as_deref()),
            frequency_dictionary: optional_hd_string(options.sort_frequency_dictionary.as_deref()),
            frequency_order,
        };
        let mut result_pointer = ptr::null();
        let mut result_count = 0usize;
        let owned_results = unsafe {
            hd_lookup_run_with_options(
                self.lookup,
                lookup_text.as_ptr(),
                options.max_results,
                options.scan_length,
                &native_options,
                &mut result_pointer,
                &mut result_count,
            )
        };
        if owned_results.is_null() {
            return Err("native Hoshidicts lookup failed".into());
        }
        let _owned_results = LookupResultsGuard(owned_results);
        if result_count > options.max_results as usize {
            return Err("native Hoshidicts returned too many lookup results".into());
        }
        let native_results =
            unsafe { checked_slice(result_pointer, result_count, "lookup results")? };

        let mut copy_budget = 0usize;
        native_results
            .iter()
            .map(|result| unsafe {
                let trace_count = result.trace_count.min(MAX_TRACE_STEPS);
                let trace = checked_slice(result.trace, trace_count, "deinflection trace")?
                    .iter()
                    .map(|step| {
                        Ok(LookupTrace {
                            name: copy_hd_string_bounded(
                                step.name,
                                "trace name",
                                &mut copy_budget,
                            )?,
                            description: copy_hd_string_bounded(
                                step.description,
                                "trace description",
                                &mut copy_budget,
                            )?,
                        })
                    })
                    .collect::<Result<Vec<_>, String>>()?;

                let glossaries = checked_slice(
                    result.term.glossaries,
                    result.term.glossaries_count,
                    "glossaries",
                )?
                .iter()
                .map(|glossary| {
                    Ok(LookupGlossary {
                        dictionary: copy_hd_string_bounded(
                            glossary.dict_name,
                            "glossary dictionary",
                            &mut copy_budget,
                        )?,
                        glossary: copy_hd_string_bounded_with_limit(
                            glossary.glossary,
                            "glossary content",
                            &mut copy_budget,
                            MAX_GLOSSARY_BYTES,
                        )?,
                        definition_tags: copy_hd_string_bounded(
                            glossary.definition_tags,
                            "definition tags",
                            &mut copy_budget,
                        )?,
                        term_tags: copy_hd_string_bounded(
                            glossary.term_tags,
                            "term tags",
                            &mut copy_budget,
                        )?,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
                let frequencies = copy_frequency_entries(
                    result.term.frequencies,
                    result.term.frequencies_count,
                    &mut copy_budget,
                )?;
                let pitches = copy_pitch_entries(
                    result.term.pitches,
                    result.term.pitches_count,
                    &mut copy_budget,
                )?;

                Ok(LookupResult {
                    matched: copy_hd_string_bounded(
                        result.matched,
                        "matched text",
                        &mut copy_budget,
                    )?,
                    deinflected: copy_hd_string_bounded(
                        result.deinflected,
                        "deinflected text",
                        &mut copy_budget,
                    )?,
                    trace,
                    term: LookupTerm {
                        expression: copy_hd_string_bounded(
                            result.term.expression,
                            "term expression",
                            &mut copy_budget,
                        )?,
                        reading: copy_hd_string_bounded(
                            result.term.reading,
                            "term reading",
                            &mut copy_budget,
                        )?,
                        rules: copy_hd_string_bounded(
                            result.term.rules,
                            "term rules",
                            &mut copy_budget,
                        )?,
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

    fn lookup_kanji(&self, character: &str) -> Result<LookupKanji, String> {
        validate_lookup_text(character)?;
        let kanji = CString::new(character)
            .map_err(|_| "kanji lookup text contains an embedded NUL byte")?;
        let mut entry_pointer = ptr::null();
        let mut entry_count = 0usize;
        let owned_results = unsafe {
            hd_query_run_kanji(
                self.query,
                kanji.as_ptr(),
                &mut entry_pointer,
                &mut entry_count,
            )
        };
        if owned_results.is_null() {
            return Err("native Hoshidicts kanji lookup failed".into());
        }
        let _owned_results = KanjiResultsGuard(owned_results);
        if entry_count > MAX_KANJI_ENTRIES {
            return Err("native Hoshidicts returned too many kanji entries".into());
        }
        let mut copy_budget = 0usize;
        let entries = unsafe { checked_slice(entry_pointer, entry_count, "kanji entries")? }
            .iter()
            .map(|entry| unsafe {
                let definitions = checked_slice(
                    entry.definitions,
                    entry.definitions_count.min(MAX_KANJI_DEFINITIONS_PER_ENTRY),
                    "kanji definitions",
                )?
                .iter()
                .map(|definition| {
                    copy_hd_string_bounded(*definition, "kanji definition", &mut copy_budget)
                })
                .collect::<Result<Vec<_>, String>>()?;
                let mut stats = checked_slice(
                    entry.stats,
                    entry.stats_count.min(MAX_KANJI_STATS_PER_ENTRY),
                    "kanji stats",
                )?
                .iter()
                .map(|stat| {
                    Ok(LookupKanjiStat {
                        name: copy_hd_string_bounded(
                            stat.key,
                            "kanji stat name",
                            &mut copy_budget,
                        )?,
                        value: copy_hd_string_bounded(
                            stat.value,
                            "kanji stat value",
                            &mut copy_budget,
                        )?,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
                stats.sort_by(|left, right| {
                    left.name
                        .cmp(&right.name)
                        .then_with(|| left.value.cmp(&right.value))
                });
                Ok(LookupKanjiEntry {
                    dictionary: copy_hd_string_bounded(
                        entry.dict_name,
                        "kanji dictionary",
                        &mut copy_budget,
                    )?,
                    onyomi: copy_hd_string_bounded(entry.onyomi, "kanji onyomi", &mut copy_budget)?,
                    kunyomi: copy_hd_string_bounded(
                        entry.kunyomi,
                        "kanji kunyomi",
                        &mut copy_budget,
                    )?,
                    tags: copy_hd_string_bounded(entry.tags, "kanji tags", &mut copy_budget)?,
                    definitions,
                    stats,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(LookupKanji {
            character: character.to_owned(),
            entries,
        })
    }

    /// The caller (`HoshidictsService::media`) validates the dictionary and path
    /// before the generation check, so both arrive already bounded.
    fn media(&self, dictionary: &str, path: &str) -> Result<MediaFile, MediaError> {
        let dictionary = CString::new(dictionary).map_err(|_| MediaError::InvalidDictionary)?;
        let path = CString::new(path).map_err(|_| MediaError::InvalidPath)?;
        let native =
            unsafe { hd_query_get_media_file(self.query, dictionary.as_ptr(), path.as_ptr()) };
        if native.data.is_null() || native.size == 0 {
            return Err(MediaError::NotFound);
        }
        if native.size > MAX_MEDIA_BYTES {
            return Err(MediaError::MediaTooLarge);
        }

        // The C API returns a view into query-owned mmap data. Copy it before
        // returning so no borrowed native pointer escapes the serialized call.
        let data = unsafe { slice::from_raw_parts(native.data, native.size) }.to_vec();
        let media_type = media_type_for(&data)?;
        Ok(MediaFile { media_type, data })
    }

    fn styles(&self) -> Result<Vec<DictionaryStyle>, String> {
        let mut styles_pointer = ptr::null();
        let mut styles_count = 0usize;
        let owned_styles =
            unsafe { hd_query_get_styles(self.query, &mut styles_pointer, &mut styles_count) };
        if owned_styles.is_null() {
            return Err("native Hoshidicts dictionary styles lookup failed".into());
        }
        let _owned_styles = StylesGuard(owned_styles);
        unsafe { copy_dictionary_styles(styles_pointer, styles_count) }
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

unsafe fn copy_hd_string_with_limit(
    value: HdStr,
    label: &str,
    maximum_bytes: usize,
) -> Result<String, String> {
    if value.len == 0 {
        return Ok(String::new());
    }
    if value.ptr.is_null() {
        return Err(format!("native {label} pointer was null"));
    }
    if value.len > maximum_bytes {
        return Err(format!("native {label} exceeds the permitted size"));
    }
    let bytes = slice::from_raw_parts(value.ptr.cast::<u8>(), value.len);
    String::from_utf8(bytes.to_vec()).map_err(|_| format!("native {label} was not valid UTF-8"))
}

unsafe fn copy_dictionary_styles(
    pointer: *const HdDictionaryStyle,
    count: usize,
) -> Result<Vec<DictionaryStyle>, String> {
    if count > MAX_DICTIONARIES {
        return Err("native Hoshidicts returned too many dictionary styles".into());
    }
    let native_styles = checked_slice(pointer, count, "dictionary styles")?;
    // copy_hd_string_with_limit bounds each field, and reader.js applies the
    // same per-entry and aggregate caps again on the way in.
    native_styles
        .iter()
        .map(|style| {
            Ok(DictionaryStyle {
                dictionary: copy_hd_string_with_limit(
                    style.dict_name,
                    "style dictionary",
                    MAX_STYLE_DICTIONARY_BYTES,
                )?,
                styles: copy_hd_string_with_limit(
                    style.styles,
                    "dictionary stylesheet",
                    MAX_DICTIONARY_STYLE_BYTES,
                )?,
            })
        })
        .collect()
}

unsafe fn copy_hd_string_bounded(
    value: HdStr,
    label: &str,
    budget: &mut usize,
) -> Result<String, String> {
    copy_hd_string_bounded_with_limit(value, label, budget, MAX_NATIVE_STRING_BYTES)
}

/// Accumulates one copy against the aggregate byte cap.
///
/// The cap is not redundant with enforce_lookup_response_limit: that runs on
/// the serialized reply after every copy has already been made, so it bounds
/// the reply rather than the allocation, and these blobs come out of a
/// downloaded dictionary.
fn claim_native_bytes(budget: &mut usize, bytes: usize, label: &str) -> Result<(), String> {
    *budget = budget
        .checked_add(bytes)
        .filter(|total| *total <= MAX_LOOKUP_RESPONSE_BYTES)
        .ok_or_else(|| format!("native {label} exceeds the aggregate response limit"))?;
    Ok(())
}

unsafe fn copy_hd_string_bounded_with_limit(
    value: HdStr,
    label: &str,
    budget: &mut usize,
    maximum_bytes: usize,
) -> Result<String, String> {
    claim_native_bytes(budget, value.len, label)?;
    copy_hd_string_with_limit(value, label, maximum_bytes)
}

unsafe fn copy_frequency_entries(
    pointer: *const HdFrequencyEntry,
    count: usize,
    budget: &mut usize,
) -> Result<Vec<LookupFrequencyEntry>, String> {
    checked_slice(pointer, count, "frequency entries")?
        .iter()
        .map(|entry| {
            let frequencies = checked_slice(
                entry.frequencies,
                entry.frequencies_count,
                "frequency values",
            )?
            .iter()
            .map(|frequency| {
                Ok(LookupFrequency {
                    value: frequency.value,
                    display_value: copy_hd_string_bounded(
                        frequency.display_value,
                        "frequency display value",
                        budget,
                    )?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
            Ok(LookupFrequencyEntry {
                dictionary: copy_hd_string_bounded(
                    entry.dict_name,
                    "frequency dictionary",
                    budget,
                )?,
                frequencies,
            })
        })
        .collect()
}

unsafe fn copy_pitch_entries(
    pointer: *const HdPitchEntry,
    count: usize,
    budget: &mut usize,
) -> Result<Vec<LookupPitchEntry>, String> {
    checked_slice(pointer, count, "pitch entries")?
        .iter()
        .map(|entry| {
            let pitches = checked_slice(entry.pitches, entry.pitches_count, "pitch values")?
                .iter()
                .map(|pitch| {
                    Ok(LookupPitch {
                        position: pitch.position,
                        pattern: copy_hd_string_bounded(pitch.pattern, "pitch pattern", budget)?,
                        nasal: checked_slice(
                            pitch.nasal,
                            pitch.nasal_count,
                            "pitch nasal markers",
                        )?
                        .to_vec(),
                        devoice: checked_slice(
                            pitch.devoice,
                            pitch.devoice_count,
                            "pitch devoice markers",
                        )?
                        .to_vec(),
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            let transcriptions = checked_slice(
                entry.transcriptions,
                entry.transcriptions_count,
                "pitch transcriptions",
            )?
            .iter()
            .map(|transcription| {
                copy_hd_string_bounded(*transcription, "pitch transcription", budget)
            })
            .collect::<Result<Vec<_>, String>>()?;
            Ok(LookupPitchEntry {
                dictionary: copy_hd_string_bounded(entry.dict_name, "pitch dictionary", budget)?,
                pitches,
                transcriptions,
            })
        })
        .collect()
}

fn validate_lookup_text(text: &str) -> Result<(), String> {
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

fn validate_media_dictionary(dictionary: &str) -> Result<(), MediaError> {
    if dictionary.is_empty()
        || dictionary.len() > MAX_MEDIA_DICTIONARY_BYTES
        || dictionary.chars().any(char::is_control)
    {
        return Err(MediaError::InvalidDictionary);
    }
    Ok(())
}

fn validate_media_path(path: &str) -> Result<(), MediaError> {
    if path.is_empty()
        || path.len() > MAX_MEDIA_PATH_BYTES
        || path.starts_with('/')
        || path.contains('\\')
        || path.chars().any(char::is_control)
        || path
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
    {
        return Err(MediaError::InvalidPath);
    }
    Ok(())
}

/// Identifies the media type from its magic prefix. The overlay renders media
/// through `<img>`/CSS only, so the browser decodes it; nothing here needs the
/// pixel dimensions.
fn media_type_for(data: &[u8]) -> Result<&'static str, MediaError> {
    const PREFIXES: &[(&[u8], &str)] = &[
        (b"\x89PNG\r\n\x1a\n", "image/png"),
        (b"GIF87a", "image/gif"),
        (b"GIF89a", "image/gif"),
        (b"\xff\xd8", "image/jpeg"),
    ];
    for (prefix, media_type) in PREFIXES {
        if data.starts_with(prefix) {
            return Ok(media_type);
        }
    }
    if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        return Ok("image/webp");
    }
    if data.len() >= 12 && &data[4..8] == b"ftyp" {
        return Ok("image/avif");
    }
    // SVG: the first non-whitespace byte of an XML document, past any BOM.
    let xml = data.strip_prefix(b"\xef\xbb\xbf").unwrap_or(data);
    if xml.iter().copied().find(|b| !b.is_ascii_whitespace()) == Some(b'<') {
        return Ok("image/svg+xml");
    }
    Err(MediaError::UnsupportedMediaType)
}

struct HoshidictsService {
    root: PathBuf,
    engine: Option<NativeEngine>,
    generation: u64,
}

impl HoshidictsService {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            engine: None,
            generation: 0,
        }
    }

    fn activate(&mut self) -> Result<usize, String> {
        if self.engine.is_none() {
            self.engine = Some(NativeEngine::load(&self.root)?);
            self.advance_generation();
        }
        Ok(self.dictionary_count())
    }

    fn deactivate(&mut self) {
        self.engine = None;
        self.advance_generation();
    }

    fn reload(&mut self) -> Result<usize, String> {
        let replacement = NativeEngine::load(&self.root)?;
        let dictionary_count = replacement.dictionary_count;
        self.engine = Some(replacement);
        self.advance_generation();
        Ok(dictionary_count)
    }

    #[cfg(test)]
    fn lookup(&mut self, text: &str) -> Result<Vec<LookupResult>, String> {
        self.lookup_with_options(text, &LookupOptions::default())
    }

    fn lookup_with_options(
        &mut self,
        text: &str,
        options: &LookupOptions,
    ) -> Result<Vec<LookupResult>, String> {
        self.activate()?;
        self.engine
            .as_ref()
            .expect("engine was activated")
            .lookup(text, options)
    }

    fn lookup_kanji(&mut self, character: &str) -> Result<LookupKanji, String> {
        self.activate()?;
        self.engine
            .as_ref()
            .expect("engine was activated")
            .lookup_kanji(character)
    }

    fn media(
        &self,
        generation: u64,
        dictionary: &str,
        path: &str,
    ) -> Result<MediaFile, MediaError> {
        validate_media_dictionary(dictionary)?;
        validate_media_path(path)?;
        if generation != self.generation || self.engine.is_none() {
            return Err(MediaError::StaleGeneration);
        }
        self.engine
            .as_ref()
            .expect("loaded engine checked above")
            .media(dictionary, path)
    }

    fn styles(&self, generation: u64) -> Result<Vec<DictionaryStyle>, StylesError> {
        if generation != self.generation || self.engine.is_none() {
            return Err(StylesError::StaleGeneration);
        }
        self.engine
            .as_ref()
            .expect("loaded engine checked above")
            .styles()
            .map_err(StylesError::Internal)
    }

    fn generation(&self) -> u64 {
        self.generation
    }

    fn advance_generation(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        if self.generation == 0 {
            self.generation = 1;
        }
    }

    #[cfg(test)]
    fn is_loaded(&self) -> bool {
        self.engine.is_some()
    }

    fn dictionary_count(&self) -> usize {
        self.engine
            .as_ref()
            .map(|engine| engine.dictionary_count)
            .unwrap_or(0)
    }
}

// ============================== client bridge ===============================
// Everything below owns the `hoshidicts_*` websocket protocol. The overlay
// server reaches it through exactly two entry points: `handle_client_message`
// for requests and `SharedHoshidicts::apply_feature_state` for feature leases.

const LOOKUP_RESULT: &str = "hoshidicts_lookup_result";
const MEDIA_RESULT: &str = "hoshidicts_media_result";
const STYLES_RESULT: &str = "hoshidicts_styles_result";
const RELOAD_RESULT: &str = "hoshidicts_reload_result";
const FEATURE_DISABLED_MESSAGE: &str = "Hoshidicts is not enabled for this connection";
const FEATURE_DISABLED_CODE: &str = "feature_disabled";

/// The native service plus the gate that serializes native calls.
#[derive(Clone)]
pub struct SharedHoshidicts {
    service: Arc<StdMutex<HoshidictsService>>,
    operation_gate: Arc<Mutex<()>>,
}

impl SharedHoshidicts {
    pub fn new(root: PathBuf) -> Self {
        Self {
            service: Arc::new(StdMutex::new(HoshidictsService::new(root))),
            operation_gate: Arc::new(Mutex::new(())),
        }
    }

    async fn run_blocking<T, F>(&self, operation: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&mut HoshidictsService) -> T + Send + 'static,
    {
        // Wait for exclusive access without consuming a blocking-pool thread. Move
        // the permit into the blocking task so cancellation cannot admit another
        // native call before this one has actually finished.
        let operation_permit = self.operation_gate.clone().lock_owned().await;
        let service = self.service.clone();
        task::spawn_blocking(move || {
            let _operation_permit = operation_permit;
            let mut service = service
                .lock()
                .map_err(|_| "Hoshidicts service lock is poisoned".to_string())?;
            Ok(operation(&mut service))
        })
        .await
        .map_err(|error| format!("Hoshidicts blocking task failed: {error}"))?
    }

    /// Load or unload the native engine when the feature lease changes.
    pub async fn apply_feature_state(&self, enabled: bool, was_enabled: bool) {
        if enabled == was_enabled {
            return;
        }
        if enabled {
            match self.run_blocking(HoshidictsService::activate).await {
                Ok(Ok(dictionary_count)) => {
                    info!("Hoshidicts activated with {dictionary_count} dictionaries")
                }
                Ok(Err(error)) | Err(error) => warn!("failed to activate Hoshidicts: {error}"),
            }
        } else if let Err(error) = self.run_blocking(|service| service.deactivate()).await {
            warn!("failed to deactivate Hoshidicts: {error}");
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum LookupRequestMode {
    #[default]
    TermFirst,
    Kanji,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct LookupRequestOptions {
    #[serde(default)]
    scan_length: Option<i64>,
    #[serde(default)]
    max_results: Option<i64>,
    #[serde(default)]
    primary_reading: Option<String>,
    #[serde(default)]
    sort_frequency_dictionary: Option<String>,
    #[serde(default)]
    sort_frequency_dictionary_order: Option<LookupFrequencySortOrder>,
}

impl LookupRequestOptions {
    fn resolve(self) -> LookupOptions {
        LookupOptions::from_request(
            self.scan_length,
            self.max_results,
            self.primary_reading,
            self.sort_frequency_dictionary,
            self.sort_frequency_dictionary_order,
        )
    }
}

/// The `hoshidicts_*` client messages. Anything else deserializes to `None` and
/// is left to the caller.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type")]
enum Request {
    #[serde(rename = "hoshidicts_lookup", rename_all = "camelCase")]
    Lookup {
        request_id: RequestId,
        #[serde(default)]
        text: String,
        #[serde(default)]
        mode: LookupRequestMode,
        #[serde(flatten)]
        options: LookupRequestOptions,
    },

    #[serde(rename = "hoshidicts_media", rename_all = "camelCase")]
    Media {
        request_id: RequestId,
        generation: u64,
        dictionary: String,
        path: String,
    },

    #[serde(rename = "hoshidicts_styles", rename_all = "camelCase")]
    Styles {
        request_id: RequestId,
        generation: u64,
    },

    #[serde(rename = "hoshidicts_reload", rename_all = "camelCase")]
    Reload { request_id: RequestId },
}

/// Handle one Hoshidicts request and return the reply to send back. Returns
/// `None` for anything that is not a Hoshidicts message.
pub async fn handle_client_message(
    message: &str,
    enabled: bool,
    hoshidicts: &SharedHoshidicts,
) -> Option<String> {
    Some(match serde_json::from_str::<Request>(message).ok()? {
        Request::Lookup {
            request_id,
            text,
            mode,
            options,
        } => lookup_payload(request_id, text, mode, options, enabled, hoshidicts).await,
        Request::Media {
            request_id,
            generation,
            dictionary,
            path,
        } => {
            media_payload(
                request_id, generation, dictionary, path, enabled, hoshidicts,
            )
            .await
        }
        Request::Styles {
            request_id,
            generation,
        } => styles_payload(request_id, generation, enabled, hoshidicts).await,
        Request::Reload { request_id } => reload_payload(request_id, enabled, hoshidicts).await,
    })
}

/// Serialize one reply: the envelope every kind shares, plus that kind's own
/// fields. `error` of `None` means success.
fn reply(
    kind: &str,
    request_id: Value,
    generation: u64,
    feature_disabled: bool,
    error: Option<&str>,
    fields: Value,
) -> String {
    let mut payload = serde_json::json!({
        "type": kind,
        "requestId": request_id,
        "success": error.is_none(),
        "generation": generation,
        "featureDisabled": feature_disabled,
        "error": error,
    });
    if let (Some(envelope), Value::Object(fields)) = (payload.as_object_mut(), fields) {
        envelope.extend(fields);
    }
    payload.to_string()
}

/// `RequestId` is echoed back for correlation, or null when it was rejected.
fn request_id_value(request_id: RequestId) -> Value {
    serde_json::to_value(request_id).unwrap_or(Value::Null)
}

// --------------------------------- lookup -----------------------------------

fn lookup_reply(
    request_id: Value,
    dictionary_count: usize,
    generation: u64,
    outcome: Result<(Vec<LookupResult>, Option<LookupKanji>), String>,
    feature_disabled: bool,
) -> String {
    let (results, kanji, error) = match outcome {
        Ok((results, kanji)) => (results, kanji, None),
        Err(error) => (Vec::new(), None, Some(error)),
    };
    reply(
        LOOKUP_RESULT,
        request_id,
        generation,
        feature_disabled,
        error.as_deref(),
        serde_json::json!({
            "results": results,
            "kanji": kanji,
            "dictionaryCount": dictionary_count,
        }),
    )
}

/// A lookup must stay one complete JSON response, so an oversized one is
/// replaced rather than truncated.
fn enforce_lookup_response_limit(
    request_id: Value,
    dictionary_count: usize,
    generation: u64,
    serialized: String,
) -> String {
    if serialized.len() <= MAX_LOOKUP_RESPONSE_BYTES {
        return serialized;
    }
    lookup_reply(
        request_id,
        dictionary_count,
        generation,
        Err(format!(
            "lookup response exceeds the {MAX_LOOKUP_RESPONSE_BYTES}-byte limit"
        )),
        false,
    )
}

fn is_han_character(character: char) -> bool {
    matches!(
        character as u32,
        0x3400..=0x4dbf
            | 0x4e00..=0x9fff
            | 0xf900..=0xfaff
            | 0x20000..=0x2fa1f
    )
}

fn first_han_character(text: &str) -> Option<String> {
    text.chars()
        .next()
        .filter(|character| is_han_character(*character))
        .map(|character| character.to_string())
}

/// Kanji entries for the first Han character of the query, dropped when the
/// dictionaries hold none.
fn kanji_fallback(
    service: &mut HoshidictsService,
    text: &str,
) -> Result<Option<LookupKanji>, String> {
    let Some(character) = first_han_character(text) else {
        return Ok(None);
    };
    let result = service.lookup_kanji(&character)?;
    Ok((!result.entries.is_empty()).then_some(result))
}

async fn lookup_payload(
    request_id: RequestId,
    text: String,
    mode: LookupRequestMode,
    request_options: LookupRequestOptions,
    enabled: bool,
    hoshidicts: &SharedHoshidicts,
) -> String {
    let request_id = request_id_value(request_id);
    if !enabled {
        return lookup_reply(request_id, 0, 0, Err(FEATURE_DISABLED_MESSAGE.into()), true);
    }
    let lookup_options = if mode == LookupRequestMode::TermFirst {
        request_options.resolve()
    } else {
        LookupOptions::default()
    };

    let (outcome, dictionary_count, generation) = match hoshidicts
        .run_blocking(move |service| {
            let outcome = (|| -> Result<(Vec<LookupResult>, Option<LookupKanji>), String> {
                let terms = match mode {
                    LookupRequestMode::TermFirst => {
                        service.lookup_with_options(&text, &lookup_options)?
                    }
                    LookupRequestMode::Kanji => Vec::new(),
                };
                // Kanji entries are a fallback for a query no term matched, and
                // are the only result kanji mode asks for.
                let kanji = if terms.is_empty() {
                    kanji_fallback(service, &text)?
                } else {
                    None
                };
                Ok((terms, kanji))
            })();
            (outcome, service.dictionary_count(), service.generation())
        })
        .await
    {
        Ok(outcome) => outcome,
        Err(error) => (Err(error), 0, 0),
    };
    let payload = lookup_reply(
        request_id.clone(),
        dictionary_count,
        generation,
        outcome,
        false,
    );
    enforce_lookup_response_limit(request_id, dictionary_count, generation, payload)
}

// --------------------------------- styles -----------------------------------

fn styles_reply(
    request_id: Value,
    generation: u64,
    outcome: Result<Vec<DictionaryStyle>, &str>,
    feature_disabled: bool,
) -> String {
    let (styles, error) = match outcome {
        Ok(styles) => (styles, None),
        Err(code) => (Vec::new(), Some(code)),
    };
    reply(
        STYLES_RESULT,
        request_id,
        generation,
        feature_disabled,
        error,
        serde_json::json!({
            "styles": styles,
            "staleGeneration": error == Some(StylesError::StaleGeneration.code()),
        }),
    )
}

/// Stylesheets are dictionary-supplied text whose JSON escaping can multiply its
/// size, so an oversized styles response is replaced with an empty one.
fn styles_success_reply(
    request_id: Value,
    generation: u64,
    styles: Vec<DictionaryStyle>,
) -> String {
    let payload = styles_reply(request_id.clone(), generation, Ok(styles), false);
    if payload.len() <= MAX_STYLES_RESPONSE_BYTES {
        payload
    } else {
        styles_reply(request_id, generation, Err("response_too_large"), false)
    }
}

async fn styles_payload(
    request_id: RequestId,
    generation: u64,
    enabled: bool,
    hoshidicts: &SharedHoshidicts,
) -> String {
    let request_id = request_id_value(request_id);
    if !enabled {
        return styles_reply(request_id, generation, Err(FEATURE_DISABLED_CODE), true);
    }

    let code = match hoshidicts
        .run_blocking(move |service| service.styles(generation))
        .await
    {
        Ok(Ok(styles)) => return styles_success_reply(request_id, generation, styles),
        Ok(Err(error)) => {
            if let StylesError::Internal(message) = &error {
                warn!("failed to copy Hoshidicts dictionary styles: {message}");
            }
            error.code()
        }
        Err(error) => {
            warn!("failed to read Hoshidicts dictionary styles: {error}");
            "internal_error"
        }
    };
    styles_reply(request_id, generation, Err(code), false)
}

// ---------------------------------- media -----------------------------------

/// Never reflect an oversized untrusted field back into a response envelope.
/// The request fields every media reply echoes back for correlation.
#[derive(Clone)]
struct MediaEnvelope {
    request_id: Value,
    generation: u64,
    dictionary: String,
    path: String,
}

impl MediaEnvelope {
    fn reply(
        &self,
        media: Option<MediaFile>,
        error: Option<&str>,
        feature_disabled: bool,
    ) -> String {
        let (media_type, data_base64, byte_length) = match media {
            Some(media) => (
                Some(media.media_type),
                Some(BASE64_STANDARD.encode(&media.data)),
                media.data.len(),
            ),
            None => (None, None, 0),
        };
        reply(
            MEDIA_RESULT,
            self.request_id.clone(),
            self.generation,
            feature_disabled,
            error,
            serde_json::json!({
                "dictionary": self.dictionary,
                "path": self.path,
                "mediaType": media_type,
                "byteLength": byte_length,
                "dataBase64": data_base64,
                "staleGeneration": error == Some(MediaError::StaleGeneration.code()),
            }),
        )
    }

    fn failure(&self, error: &str, feature_disabled: bool) -> String {
        self.reply(None, Some(error), feature_disabled)
    }

    /// Base64 expands the payload, so a media response that grew past the limit
    /// is replaced with a `media_too_large` failure.
    fn success(&self, media: MediaFile) -> String {
        let payload = self.reply(Some(media), None, false);
        if payload.len() <= MAX_MEDIA_RESPONSE_BYTES {
            payload
        } else {
            self.failure(MediaError::MediaTooLarge.code(), false)
        }
    }
}

async fn media_payload(
    request_id: RequestId,
    generation: u64,
    dictionary: String,
    path: String,
    enabled: bool,
    hoshidicts: &SharedHoshidicts,
) -> String {
    let mut envelope = MediaEnvelope {
        request_id: Value::Null,
        generation,
        dictionary,
        path,
    };
    envelope.request_id = request_id_value(request_id);
    if !enabled {
        return envelope.failure(FEATURE_DISABLED_CODE, true);
    }

    let operation = envelope.clone();
    match hoshidicts
        .run_blocking(move |service| {
            match service.media(operation.generation, &operation.dictionary, &operation.path) {
                Ok(media) => operation.success(media),
                Err(error) => operation.failure(error.code(), false),
            }
        })
        .await
    {
        Ok(payload) => payload,
        Err(_) => envelope.failure(MediaError::InternalError.code(), false),
    }
}

// --------------------------------- reload -----------------------------------

fn reload_reply(
    request_id: Value,
    dictionary_count: usize,
    generation: u64,
    error: Option<&str>,
    feature_disabled: bool,
) -> String {
    reply(
        RELOAD_RESULT,
        request_id,
        generation,
        feature_disabled,
        error,
        serde_json::json!({ "dictionaryCount": dictionary_count }),
    )
}

async fn reload_payload(
    request_id: RequestId,
    enabled: bool,
    hoshidicts: &SharedHoshidicts,
) -> String {
    let request_id = request_id_value(request_id);
    if !enabled {
        return reload_reply(request_id, 0, 0, Some(FEATURE_DISABLED_MESSAGE), true);
    }

    let (result, active_dictionary_count, generation) = match hoshidicts
        .run_blocking(|service| {
            let result = service.reload();
            let active_dictionary_count = service.dictionary_count();
            (result, active_dictionary_count, service.generation())
        })
        .await
    {
        Ok(outcome) => outcome,
        Err(error) => (Err(error), 0, 0),
    };
    match result {
        Ok(dictionary_count) => reload_reply(request_id, dictionary_count, generation, None, false),
        Err(error) => reload_reply(
            request_id,
            active_dictionary_count,
            generation,
            Some(&error),
            false,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use zip::write::SimpleFileOptions;

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(1);
    const TEST_PNG: &[u8] =
        b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x02\0\0\0\x03\x08\x06\0\0\0\0\0\0\0";

    /// Borrow test bytes as the native string view the C API hands back.
    fn hd_str(bytes: &[u8]) -> HdStr {
        HdStr {
            ptr: bytes.as_ptr().cast::<c_char>(),
            len: bytes.len(),
        }
    }

    fn test_avif(width: u32, height: u32) -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&24u32.to_be_bytes());
        data.extend_from_slice(b"ftypavif\0\0\0\0mif1avif");
        data.extend_from_slice(&48u32.to_be_bytes());
        data.extend_from_slice(b"meta\0\0\0\0");
        data.extend_from_slice(&36u32.to_be_bytes());
        data.extend_from_slice(b"iprp");
        data.extend_from_slice(&28u32.to_be_bytes());
        data.extend_from_slice(b"ipco");
        data.extend_from_slice(&20u32.to_be_bytes());
        data.extend_from_slice(b"ispe\0\0\0\0");
        data.extend_from_slice(&width.to_be_bytes());
        data.extend_from_slice(&height.to_be_bytes());
        data
    }

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

    fn write_dictionary(root: &Path, relative: &str, terms: u64, kanji: u64) -> PathBuf {
        write_dictionary_with_counts(root, relative, terms, &[], kanji)
    }

    fn write_dictionary_with_counts(
        root: &Path,
        relative: &str,
        terms: u64,
        term_meta: &[(&str, u64)],
        kanji: u64,
    ) -> PathBuf {
        let dictionary = root.join(relative);
        fs::create_dir_all(&dictionary).expect("create dictionary");
        fs::write(dictionary.join(".hoshidicts_3"), []).expect("write marker");
        fs::write(dictionary.join("hash.table"), [1]).expect("write hash");
        fs::write(dictionary.join("bloom.filter"), [1]).expect("write bloom");
        fs::write(dictionary.join("blobs.bin"), [1]).expect("write blobs");
        let term_meta = term_meta
            .iter()
            .map(|(kind, count)| ((*kind).to_string(), serde_json::Value::from(*count)))
            .collect::<serde_json::Map<String, serde_json::Value>>();
        fs::write(
            dictionary.join("index.json"),
            serde_json::json!({
                "title": "Test",
                "counts": {
                    "terms": { "total": terms },
                    "termMeta": term_meta,
                    "kanji": { "total": kanji },
                },
            })
            .to_string(),
        )
        .expect("write index");
        dictionary
    }

    /// A manifest enabling `paths`, in order, with generated ids.
    fn write_manifest(root: &Path, paths: &[&str]) {
        let dictionaries = paths
            .iter()
            .enumerate()
            .map(|(index, path)| {
                serde_json::json!({ "id": format!("dictionary-{index}"), "path": path })
            })
            .collect::<Vec<_>>();
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            serde_json::json!({ "version": 1, "dictionaries": dictionaries }).to_string(),
        )
        .expect("write manifest");
    }

    fn set_dictionary_media_count(dictionary: &Path, count: u64) {
        let mut index: serde_json::Value = serde_json::from_slice(
            &fs::read(dictionary.join("index.json")).expect("read dictionary index"),
        )
        .expect("parse dictionary index");
        index["counts"]["media"]["total"] = count.into();
        fs::write(
            dictionary.join("index.json"),
            serde_json::to_vec(&index).expect("serialize dictionary index"),
        )
        .expect("write media count");
    }

    fn write_native_media_files(dictionary: &Path, entries: &[(&str, &[u8])]) {
        let mut media = Vec::new();
        let mut offsets = Vec::new();
        for (path, blob) in entries {
            let offset = u64::try_from(media.len()).expect("media offset");
            let path_length = u16::try_from(path.len()).expect("media path length");
            let blob_length = u32::try_from(blob.len()).expect("media blob length");
            media.extend_from_slice(&path_length.to_le_bytes());
            media.extend_from_slice(path.as_bytes());
            media.extend_from_slice(&blob_length.to_le_bytes());
            media.extend_from_slice(blob);
            offsets.push((path.to_string(), offset));
        }
        fs::write(dictionary.join("media.bin"), media).expect("write media data");

        offsets.sort_by(|left, right| left.0.cmp(&right.0));
        let mut index = Vec::new();
        index.extend_from_slice(
            &u32::try_from(offsets.len())
                .expect("media count")
                .to_le_bytes(),
        );
        for (_, offset) in offsets {
            index.extend_from_slice(&offset.to_le_bytes());
        }
        fs::write(dictionary.join("media.idx"), index).expect("write media index");
    }

    fn media_dictionary(root: &Path, entries: &[(&str, &[u8])]) -> PathBuf {
        let dictionary = write_dictionary(root, "Test", 1, 0);
        write_manifest(root, &["Test"]);
        set_dictionary_media_count(
            &dictionary,
            u64::try_from(entries.len()).expect("media count"),
        );
        write_native_media_files(&dictionary, entries);
        dictionary
    }

    /// Write one uncompressed Yomitan dictionary archive from literal members.
    fn write_zip_archive<C: AsRef<[u8]>>(path: &Path, entries: &[(&str, C)]) {
        let mut archive = zip::ZipWriter::new(fs::File::create(path).expect("create archive"));
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, contents) in entries {
            archive
                .start_file(*name, options)
                .expect("start archive file");
            archive
                .write_all(contents.as_ref())
                .expect("write archive file");
        }
        archive.finish().expect("finish archive");
    }

    fn archive_index(title: &str) -> Vec<u8> {
        serde_json::json!({
            "title": title,
            "revision": "1",
            "format": 3,
            "sequenced": false,
            "sourceLanguage": "ja",
        })
        .to_string()
        .into_bytes()
    }

    fn write_modern_media_archive(path: &Path, avif: &[u8], svg: &[u8]) {
        write_zip_archive(
            path,
            &[
                (
                    "index.json",
                    br#"{"title":"Modern Media","revision":"1","format":3,"sourceLanguage":"ja"}"#
                        .as_slice(),
                ),
                (
                    "term_bank_1.json",
                    r#"[["画像","がぞう","","",0,[{"type":"structured-content","content":[{"tag":"img","path":"graphics/test.avif"},{"tag":"img","path":"glyphs/test.svg"}]}],1,""]]"#
                        .as_bytes(),
                ),
                ("graphics/test.avif", avif),
                ("glyphs/test.svg", svg),
            ],
        );
    }

    fn write_test_archive(path: &Path, include_terms: bool) {
        write_test_archive_with_title(path, "Test Dictionary", include_terms);
    }

    fn write_test_archive_with_title(path: &Path, title: &str, include_terms: bool) {
        write_test_archive_with_kanji_entries(path, title, include_terms, 1);
    }

    fn write_test_archive_with_kanji_entries(
        path: &Path,
        title: &str,
        include_terms: bool,
        kanji_entry_count: usize,
    ) {
        let kanji_entry = serde_json::json!([
            "食",
            "ショク ジキ",
            "く.う た.べる",
            "jouyou",
            ["eat", "food"],
            { "strokes": "9", "grade": "2" }
        ]);
        let mut entries: Vec<(&str, Vec<u8>)> = vec![("index.json", archive_index(title))];
        if include_terms {
            entries.extend([
                (
                    "term_bank_1.json",
                    r#"[["食べる","たべる","","v1",0,[{"type":"structured-content","content":[{"tag":"span","content":"to eat"},{"tag":"img","path":"img/test.png","width":2,"height":3,"sizeUnits":"px"}]}],1,""]]"#
                        .into(),
                ),
                (
                    "term_meta_bank_1.json",
                    r#"[["食べる","freq",{"reading":"たべる","frequency":{"value":123,"displayValue":"123 ★"}}],["食べる","pitch",{"reading":"たべる","pitches":[{"position":2,"nasal":[1],"devoice":[2]}]}]]"#
                        .into(),
                ),
                ("img/test.png", TEST_PNG.to_vec()),
            ]);
        }
        entries.push((
            "kanji_bank_1.json",
            serde_json::to_vec(&vec![kanji_entry; kanji_entry_count]).expect("kanji bank"),
        ));
        write_zip_archive(path, &entries);
    }

    fn write_frequency_only_archive(path: &Path) {
        write_zip_archive(
            path,
            &[
                (
                    "index.json",
                    r#"{"title":"Standalone Frequency","revision":"1","format":3,"sourceLanguage":"ja","frequencyMode":"rank-based"}"#,
                ),
                (
                    "term_meta_bank_1.json",
                    r#"[["食べる","freq",{"reading":"たべる","frequency":{"value":22,"displayValue":"22 rank"}}]]"#,
                ),
            ],
        );
    }

    fn write_kana_lookup_archive(path: &Path) {
        write_zip_archive(
            path,
            &[
                (
                    "index.json",
                    r#"{"title":"Kana Lookup","revision":"1","format":3,"sourceLanguage":"ja"}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["我輩","わがはい","","",0,["I; me; myself"],1606640,""]]"#,
                ),
            ],
        );
    }

    fn write_redirect_lookup_archive(path: &Path) {
        write_zip_archive(
            path,
            &[
                (
                    "index.json",
                    r#"{"title":"Redirect Lookup","revision":"1","format":3,"sourceLanguage":"ja"}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["喰べる","","","",0,[{"type":"structured-content","content":{"tag":"a","href":"?query=%E9%A3%9F%E3%81%B9%E3%82%8B&primary_reading=%E3%81%9F%E3%81%B9%E3%82%8B","content":"食べる"}},["食べる",["redirected from 喰べる"]]],1,""],["食べる","たべる","","v1",10,["to eat"],2,""]]"#,
                ),
            ],
        );
    }

    fn write_lookup_ranking_archive(path: &Path) {
        let terms = (0..33)
            .map(|index| {
                serde_json::json!([
                    "語",
                    format!("よみ{index:02}"),
                    "",
                    "",
                    100 - index,
                    [format!("definition {index}")],
                    index + 1,
                    ""
                ])
            })
            .collect::<Vec<_>>();
        let term_bank = serde_json::to_string(&terms).expect("serialize ranking terms");
        write_zip_archive(
            path,
            &[
                (
                    "index.json",
                    r#"{"title":"Lookup Ranking","revision":"1","format":3,"sourceLanguage":"ja"}"#,
                ),
                ("term_bank_1.json", &term_bank),
            ],
        );
    }

    fn write_explicit_frequency_sort_archives(term_path: &Path, frequency_path: &Path) {
        write_zip_archive(
            term_path,
            &[
                (
                    "index.json",
                    r#"{"title":"Frequency Sort Terms","revision":"1","format":3,"sourceLanguage":"ja"}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["語","ご一","","",30,["one"],1,""],["語","ご二","","",20,["two"],2,""],["語","ご三","","",10,["three"],3,""]]"#,
                ),
            ],
        );
        write_zip_archive(
            frequency_path,
            &[
                (
                    "index.json",
                    r#"{"title":"Explicit Rank","revision":"1","format":3,"sourceLanguage":"ja","frequencyMode":"rank-based"}"#,
                ),
                (
                    "term_meta_bank_1.json",
                    r#"[["語","freq",{"reading":"ご一","frequency":300}],["語","freq",{"reading":"ご二","frequency":200}],["語","freq",{"reading":"ご三","frequency":100}]]"#,
                ),
            ],
        );
    }

    fn write_styled_archive(path: &Path) {
        write_zip_archive(
            path,
            &[
                (
                    "index.json",
                    r#"{"title":"Styled Dictionary","revision":"1","format":3,"sourceLanguage":"ja"}"#,
                ),
                (
                    "term_bank_1.json",
                    r#"[["綺麗","きれい","","",0,["pretty"],1,""]]"#,
                ),
                (
                    "styles.css",
                    ".glossary[data-dictionary=\"Styled Dictionary\"] { color: rebeccapurple; }",
                ),
            ],
        );
    }

    fn write_large_glossary_archive(path: &Path, title: &str, marker: &str) {
        let glossary = format!("{marker}:{}", "x".repeat(140 * 1024));
        let term_bank = serde_json::to_vec(&vec![serde_json::json!([
            "膨大",
            "ぼうだい",
            "",
            "",
            0,
            [glossary],
            1,
            ""
        ])])
        .expect("serialize large glossary term bank");
        write_zip_archive(
            path,
            &[
                ("index.json", archive_index(title)),
                ("term_bank_1.json", term_bank),
            ],
        );
    }

    /// Import one archive written by `write`, enable it under `title`, and return
    /// the import report next to a service that can query it.
    fn imported_service(
        root: &Path,
        title: &str,
        write: impl FnOnce(&Path),
    ) -> (HoshidictsService, ImportReport) {
        let archive_path = root.join(format!("{title}.zip"));
        write(&archive_path);
        let report = import_dictionary(&archive_path, root);
        assert!(report.success, "dictionary import failed: {}", report.error);
        write_manifest(root, &[title]);
        (HoshidictsService::new(root.to_path_buf()), report)
    }

    #[test]
    fn lookup_text_is_bounded() {
        assert!(validate_lookup_text("").is_err());
        assert!(validate_lookup_text(&"x".repeat(MAX_LOOKUP_TEXT_BYTES + 1)).is_err());
    }

    #[test]
    fn lookup_options_match_yomitan_defaults_and_clamp_out_of_range_fields() {
        assert_eq!(DEFAULT_LOOKUP_SCAN_LENGTH, 16);
        assert_eq!(DEFAULT_LOOKUP_MAX_RESULTS, 32);
        let defaults = LookupOptions::from_request(None, None, None, None, None);
        assert_eq!(defaults, LookupOptions::default());
        assert_eq!(defaults.sort_frequency_dictionary, None);

        let configured = LookupOptions::from_request(
            Some(64),
            Some(256),
            Some("よみ".into()),
            Some("BCCWJ".into()),
            Some(LookupFrequencySortOrder::Ascending),
        );
        assert_eq!(configured.scan_length, 64);
        assert_eq!(configured.max_results, 256);
        assert_eq!(configured.primary_reading.as_deref(), Some("よみ"));
        assert_eq!(
            configured.sort_frequency_dictionary.as_deref(),
            Some("BCCWJ")
        );
        assert_eq!(
            configured.sort_frequency_order,
            LookupFrequencySortOrder::Ascending
        );

        // The overlay bounds these to the same ranges, so anything outside
        // them is our own bug: clamp to the nearest legal value and serve.
        for (scan_length, max_results, expected_scan, expected_results) in [
            (Some(0), None, 1, DEFAULT_LOOKUP_MAX_RESULTS),
            (Some(65), None, 64, DEFAULT_LOOKUP_MAX_RESULTS),
            (None, Some(0), DEFAULT_LOOKUP_SCAN_LENGTH, 1),
            (None, Some(257), DEFAULT_LOOKUP_SCAN_LENGTH, 256),
        ] {
            let clamped = LookupOptions::from_request(scan_length, max_results, None, None, None);
            assert_eq!(clamped.scan_length, expected_scan);
            assert_eq!(clamped.max_results, expected_results);
        }
        // Oversized or control-bearing strings drop to None rather than failing
        // the whole lookup.
        for (primary_reading, sort_dictionary) in [
            (Some("x".repeat(MAX_LOOKUP_PRIMARY_READING_BYTES + 1)), None),
            (Some("bad\0reading".into()), None),
            (None, Some("bad\ndictionary".to_string())),
            (Some(String::new()), None),
        ] {
            let dropped =
                LookupOptions::from_request(None, None, primary_reading, sort_dictionary, None);
            assert_eq!(dropped.primary_reading, None);
            assert_eq!(dropped.sort_frequency_dictionary, None);
        }
    }

    #[test]
    fn native_copy_budget_rejects_oversized_aggregate_results() {
        assert_eq!(MAX_GLOSSARY_BYTES, 8 * 1024 * 1024);
        assert_eq!(MAX_LOOKUP_RESPONSE_BYTES, 32 * 1024 * 1024);

        let mut glossary_budget = 0usize;
        let oversized_glossary = HdStr {
            ptr: ptr::NonNull::<c_char>::dangling().as_ptr(),
            len: MAX_GLOSSARY_BYTES + 1,
        };
        assert!(unsafe {
            copy_hd_string_bounded_with_limit(
                oversized_glossary,
                "glossary content",
                &mut glossary_budget,
                MAX_GLOSSARY_BYTES,
            )
        }
        .expect_err("per-glossary byte limit must fail")
        .contains("permitted size"));

        // The aggregate cap accumulates across copies and rejects the one that
        // would cross it.
        let mut byte_budget = 0usize;
        claim_native_bytes(&mut byte_budget, MAX_LOOKUP_RESPONSE_BYTES, "test value")
            .expect("full aggregate byte budget");
        assert!(claim_native_bytes(&mut byte_budget, 1, "test value")
            .expect_err("aggregate byte limit must fail")
            .contains("aggregate response limit"));
    }

    #[test]
    fn dictionary_style_copy_enforces_count_and_per_style_limits() {
        unsafe {
            assert!(copy_dictionary_styles(ptr::null(), MAX_DICTIONARIES + 1)
                .expect_err("style count limit must fail")
                .contains("too many dictionary styles"));
        }

        let oversized_css = vec![b'x'; MAX_DICTIONARY_STYLE_BYTES + 1];
        let oversized = [HdDictionaryStyle {
            dict_name: hd_str(b"Test"),
            styles: hd_str(&oversized_css),
        }];
        unsafe {
            assert!(copy_dictionary_styles(oversized.as_ptr(), oversized.len())
                .expect_err("per-style limit must fail")
                .contains("stylesheet exceeds the permitted size"));
        }
    }

    #[test]
    fn frequencies_copy_values_and_display_values_verbatim() {
        // Native display values are always present; an archive that omits one
        // gets it synthesised from the numeric value during import.
        let values = [
            HdFrequency {
                value: 1,
                display_value: hd_str("1㋕".as_bytes()),
            },
            HdFrequency {
                value: 7,
                display_value: hd_str(b""),
            },
        ];
        let entries = [HdFrequencyEntry {
            dict_name: hd_str(b"Frequency Test"),
            frequencies: values.as_ptr(),
            frequencies_count: values.len(),
        }];

        let copied = unsafe {
            copy_frequency_entries(entries.as_ptr(), entries.len(), &mut 0usize)
                .expect("valid frequencies")
        };
        assert_eq!(
            copied,
            vec![LookupFrequencyEntry {
                dictionary: "Frequency Test".into(),
                frequencies: vec![
                    LookupFrequency {
                        value: 1,
                        display_value: "1㋕".into(),
                    },
                    LookupFrequency {
                        value: 7,
                        display_value: String::new(),
                    },
                ],
            }]
        );

        let json = serde_json::to_value(&copied).expect("serialize frequencies");
        assert_eq!(json[0]["frequencies"][0]["displayValue"], "1㋕");
        assert_eq!(json[0]["frequencies"][0]["value"], 1);
        assert_eq!(json[0]["frequencies"][1]["displayValue"], "");
    }

    #[test]
    fn manifest_ignores_profiles_and_uses_projected_enabled_flags() {
        let manifest: DictionaryManifest = serde_json::from_str(
            r#"{
                "version": 1,
                "activeProfileId": "persona",
                "profiles": [{"id": "persona", "name": "Persona"}],
                "dictionaries": [
                    {"id": "enabled", "path": "Enabled", "enabled": true},
                    {"id": "disabled", "path": "Disabled", "enabled": false}
                ]
            }"#,
        )
        .expect("profile-aware manifest must remain native-compatible");

        assert_eq!(manifest.version, 1);
        assert_eq!(manifest.dictionaries.len(), 2);
        assert!(manifest.dictionaries[0].enabled);
        assert!(!manifest.dictionaries[1].enabled);
    }

    #[test]
    fn media_paths_and_media_types_are_strictly_validated() {
        assert!(validate_media_dictionary("Japanese Character Names").is_ok());
        assert_eq!(
            validate_media_dictionary("bad\0dictionary"),
            Err(MediaError::InvalidDictionary)
        );
        assert!(validate_media_path("img/c123.jpg").is_ok());
        for path in [
            "",
            "/img/a.png",
            "img\\a.png",
            "img//a.png",
            "img/../a.png",
            "./a.png",
        ] {
            assert_eq!(validate_media_path(path), Err(MediaError::InvalidPath));
        }

        // Every supported format is identified from its magic prefix alone.
        for (media_type, data) in [
            ("image/png", TEST_PNG),
            ("image/gif", b"GIF89a\x02\0\x03\0".as_slice()),
            (
                "image/jpeg",
                &[
                    0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 3, 0, 2, 1, 1, 0x11, 0, 0xff, 0xd9,
                ],
            ),
            (
                "image/webp",
                b"RIFF\x16\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0\x01\0\0\x02\0\0",
            ),
            ("image/avif", &test_avif(580, 435)),
            (
                "image/svg+xml",
                br#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>"#,
            ),
            ("image/svg+xml", b"\xef\xbb\xbf  <svg/>"),
        ] {
            assert_eq!(media_type_for(data), Ok(media_type), "{media_type}");
        }
        for data in [b"not an image".as_slice(), b"", b"\x89PN"] {
            assert_eq!(
                media_type_for(data),
                Err(MediaError::UnsupportedMediaType),
                "{}",
                String::from_utf8_lossy(data)
            );
        }
    }

    #[test]
    fn ffi_imported_avif_and_svg_media_are_returned_with_safe_metadata() {
        let root = TestDir::new("modern-media");
        let archive_path = root.0.join("modern-media.zip");
        let avif = test_avif(580, 435);
        let svg = br#"<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg height="100" width="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <path d="M 10,10 90,90" />
</svg>"#;
        write_modern_media_archive(&archive_path, &avif, svg);

        let report = import_dictionary(&archive_path, &root.0);
        assert!(report.success, "dictionary import failed: {}", report.error);
        assert_eq!(report.media_count, 2);
        write_manifest(&root.0, &["Modern Media"]);

        let mut service = HoshidictsService::new(root.0.clone());
        assert_eq!(service.activate().expect("activate dictionary"), 1);
        let generation = service.generation();
        let returned_avif = service
            .media(generation, "Modern Media", "graphics/test.avif")
            .expect("return AVIF media");
        assert_eq!(returned_avif.media_type, "image/avif");
        assert_eq!(returned_avif.data, avif);
        let returned_svg = service
            .media(generation, "Modern Media", "glyphs/test.svg")
            .expect("return SVG media");
        assert_eq!(returned_svg.media_type, "image/svg+xml");
        assert_eq!(returned_svg.data, svg);
    }

    #[test]
    fn manifest_validation_requires_marker_index_content_and_native_files() {
        let root = TestDir::new("validation");
        let dictionary = write_dictionary(&root.0, "generations/test/1/Test", 1, 0);
        write_manifest(&root.0, &["generations/test/1/Test"]);
        assert_eq!(
            load_dictionary_specs(&root.0)
                .expect("valid manifest")
                .len(),
            1
        );

        fs::write(dictionary.join(".hoshidicts_4"), []).expect("write v4 marker");
        fs::remove_file(dictionary.join(".hoshidicts_3")).expect("remove v3 marker");
        assert_eq!(
            load_dictionary_specs(&root.0)
                .expect("valid v4 manifest")
                .len(),
            1
        );

        fs::remove_file(dictionary.join(".hoshidicts_4")).expect("remove v4 marker");
        assert!(load_dictionary_specs(&root.0)
            .expect_err("missing marker must fail")
            .contains("format marker"));
    }

    #[test]
    fn dictionary_index_classifies_content_by_declared_counts() {
        let root = TestDir::new("classification");
        // (label, terms, term metadata counts, kanji, queryable roles). The roles
        // are exactly the `has_*` flags that were set, in declaration order.
        for (label, terms, term_meta, kanji, roles) in [
            ("term", 1, &[][..], 0, &[DictionaryKind::Term][..]),
            (
                "frequency",
                0,
                &[("freq", 1)][..],
                0,
                &[DictionaryKind::Frequency][..],
            ),
            (
                "pitch",
                0,
                &[("pitch", 1)][..],
                0,
                &[DictionaryKind::Pitch][..],
            ),
            ("ipa", 0, &[("ipa", 1)][..], 0, &[DictionaryKind::Pitch][..]),
            ("kanji", 0, &[][..], 1, &[DictionaryKind::Kanji][..]),
            (
                "everything",
                1,
                &[("freq", 1), ("pitch", 1)][..],
                1,
                &[
                    DictionaryKind::Term,
                    DictionaryKind::Frequency,
                    DictionaryKind::Pitch,
                    DictionaryKind::Kanji,
                ][..],
            ),
        ] {
            let dictionary = write_dictionary_with_counts(&root.0, label, terms, term_meta, kanji);
            let spec = validate_dictionary_directory(&dictionary).expect(label);
            assert_eq!(spec.query_kinds().collect::<Vec<_>>(), roles, "{label}");
        }
    }

    #[test]
    fn dictionary_with_media_requires_a_valid_native_media_layout() {
        let root = TestDir::new("media-validation");
        let dictionary = write_dictionary(&root.0, "Test", 1, 0);
        write_manifest(&root.0, &["Test"]);
        set_dictionary_media_count(&dictionary, 2);
        let error = load_dictionary_specs(&root.0).expect_err("missing media files must fail");
        assert!(error.contains("media.idx"));

        write_native_media_files(&dictionary, &[("img/b.png", &[2, 3]), ("img/a.png", &[1])]);
        assert_eq!(
            load_dictionary_specs(&root.0)
                .expect("media layout is valid")
                .len(),
            1
        );
    }

    #[test]
    fn media_index_count_and_exact_size_are_validated() {
        let root = TestDir::new("media-index-size");
        let dictionary = media_dictionary(&root.0, &[("img/a.png", &[1]), ("img/b.png", &[2])]);
        let index_path = dictionary.join("media.idx");
        let valid_index = fs::read(&index_path).expect("read valid index");

        fs::write(&index_path, &valid_index[..valid_index.len() - 1])
            .expect("write truncated index");
        assert!(load_dictionary_specs(&root.0)
            .expect_err("truncated index must fail")
            .contains("expected exactly"));

        let mut wrong_count = valid_index;
        wrong_count[..4].copy_from_slice(&1u32.to_le_bytes());
        fs::write(&index_path, wrong_count).expect("write wrong count");
        assert!(load_dictionary_specs(&root.0)
            .expect_err("wrong index count must fail")
            .contains("does not match declared media count"));
    }

    #[test]
    fn media_index_offsets_must_frame_a_record_inside_media_bin() {
        let root = TestDir::new("media-index-offsets");
        let dictionary = media_dictionary(&root.0, &[("img/a.png", &[1]), ("img/b.png", &[2])]);
        let index_path = dictionary.join("media.idx");
        let media_path = dictionary.join("media.bin");
        let valid_index = fs::read(&index_path).expect("read valid index");
        let media_size = fs::metadata(&media_path).expect("media metadata").len();

        for offset in [media_size, media_size - 1, u64::MAX] {
            let mut corrupted = valid_index.clone();
            corrupted[4..12].copy_from_slice(&offset.to_le_bytes());
            fs::write(&index_path, corrupted).expect("write out-of-bounds offset");
            assert!(load_dictionary_specs(&root.0)
                .expect_err("an offset outside media.bin must fail")
                .contains(MEDIA_FRAMING_ERROR));
        }
    }

    #[test]
    fn media_records_reject_truncated_headers_invalid_paths_and_blob_sizes() {
        let root = TestDir::new("media-record-corruption");
        let dictionary = media_dictionary(&root.0, &[("a", &[1])]);
        let media_path = dictionary.join("media.bin");

        let mut oversized_blob = vec![1, 0, b'a'];
        oversized_blob.extend_from_slice(
            &u32::try_from(MAX_MEDIA_BYTES + 1)
                .expect("oversized blob length")
                .to_le_bytes(),
        );
        // A truncated blob-length header, a zero path length, and a blob length
        // past the end of the file all fail the framing bound. A non-UTF-8 path
        // no longer does: the path bytes are skipped rather than decoded.
        for record in [
            vec![1, 0, b'a', 1, 0],
            vec![0, 0, b'a', 1, 0, 0, 0],
            oversized_blob,
        ] {
            fs::write(&media_path, record).expect("write corrupted media record");
            assert!(load_dictionary_specs(&root.0)
                .expect_err("a malformed record must fail")
                .contains(MEDIA_FRAMING_ERROR));
        }
    }

    #[test]
    fn undeclared_native_media_files_are_rejected_before_loading() {
        let root = TestDir::new("undeclared-media");
        let dictionary = write_dictionary(&root.0, "Test", 1, 0);
        write_manifest(&root.0, &["Test"]);
        fs::write(dictionary.join("media.idx"), 0u32.to_le_bytes())
            .expect("write unexpected media index");
        fs::write(dictionary.join("media.bin"), []).expect("write unexpected media data");

        assert!(load_dictionary_specs(&root.0)
            .expect_err("undeclared media files must fail")
            .contains("declares no media"));
    }

    #[test]
    fn duplicate_adjacent_media_paths_remain_compatible() {
        let root = TestDir::new("duplicate-media-paths");
        media_dictionary(&root.0, &[("img/a.png", &[1]), ("img/a.png", &[2])]);

        assert_eq!(
            load_dictionary_specs(&root.0)
                .expect("duplicate sorted media paths are supported")
                .len(),
            1
        );
    }

    #[test]
    fn dictionary_index_rejects_empty_or_unsupported_content() {
        let root = TestDir::new("empty");
        let empty_dictionary = write_dictionary_with_counts(&root.0, "empty", 0, &[], 0);
        assert!(validate_dictionary_directory(&empty_dictionary)
            .expect_err("empty dictionary must fail")
            .contains("no queryable entries"));

        let unsupported_dictionary =
            write_dictionary_with_counts(&root.0, "unsupported", 0, &[("unknown", 1)], 0);
        assert!(validate_dictionary_directory(&unsupported_dictionary)
            .expect_err("unsupported dictionary must fail")
            .contains("no queryable entries"));
    }

    #[test]
    fn declared_media_count_is_bounded_before_file_allocation() {
        let root = TestDir::new("media-count-limit");
        let dictionary = write_dictionary(&root.0, "Test", 1, 0);
        write_manifest(&root.0, &["Test"]);
        set_dictionary_media_count(&dictionary, MAX_MEDIA_RECORDS + 1);

        assert!(load_dictionary_specs(&root.0)
            .expect_err("oversized declared media count must fail")
            .contains("record limit"));
    }

    #[test]
    fn manifest_rejects_paths_outside_the_fixed_root() {
        let root = TestDir::new("path-escape");
        write_manifest(&root.0, &["../outside"]);
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
        let active_generation = service.generation();
        assert_ne!(active_generation, 0);

        fs::write(root.0.join(MANIFEST_FILE_NAME), "{not-json").expect("write bad manifest");
        assert!(service.reload().is_err());
        assert!(service.is_loaded());
        assert_eq!(service.generation(), active_generation);
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
        let frequency_archive_path = root.0.join("frequency.zip");
        write_test_archive(&archive_path, true);
        write_frequency_only_archive(&frequency_archive_path);

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
                kanji_count: 1,
                media_count: 1,
                error: String::new(),
            }
        );
        assert_eq!(
            import_dictionary(&frequency_archive_path, &root.0),
            ImportReport {
                success: true,
                title: "Standalone Frequency".into(),
                term_count: 0,
                meta_count: 1,
                frequency_count: 1,
                pitch_count: 0,
                kanji_count: 0,
                media_count: 0,
                error: String::new(),
            }
        );
        write_manifest(&root.0, &["Test Dictionary", "Standalone Frequency"]);

        let mut service = HoshidictsService::new(root.0.clone());
        assert_eq!(service.activate().expect("activate dictionaries"), 2);
        let generation = service.generation();
        let results = service.lookup("食べた").expect("deinflected lookup");
        let result = results
            .iter()
            .find(|result| result.term.expression == "食べる")
            .expect("term result");
        assert_eq!(
            result.term.frequencies,
            vec![
                LookupFrequencyEntry {
                    dictionary: "Test Dictionary".into(),
                    frequencies: vec![LookupFrequency {
                        value: 123,
                        display_value: "123 ★".into(),
                    }],
                },
                LookupFrequencyEntry {
                    dictionary: "Standalone Frequency".into(),
                    frequencies: vec![LookupFrequency {
                        value: 22,
                        display_value: "22 rank".into(),
                    }],
                }
            ]
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
        assert_eq!(
            service.lookup_kanji("食").expect("kanji lookup"),
            LookupKanji {
                character: "食".into(),
                entries: vec![LookupKanjiEntry {
                    dictionary: "Test Dictionary".into(),
                    onyomi: "ショク ジキ".into(),
                    kunyomi: "く.う た.べる".into(),
                    tags: "jouyou".into(),
                    definitions: vec!["eat".into(), "food".into()],
                    stats: vec![
                        LookupKanjiStat {
                            name: "grade".into(),
                            value: "2".into(),
                        },
                        LookupKanjiStat {
                            name: "strokes".into(),
                            value: "9".into(),
                        },
                    ],
                }],
            }
        );
        assert!(result.term.glossaries[0]
            .glossary
            .contains("structured-content"));
        let media = service
            .media(generation, "Test Dictionary", "img/test.png")
            .expect("copied media");
        assert_eq!(media.media_type, "image/png");
        assert_eq!(media.data, TEST_PNG);
        assert_eq!(
            service.media(generation, "Test Dictionary", "../test.png"),
            Err(MediaError::InvalidPath)
        );
        assert_eq!(
            service.media(generation + 1, "Test Dictionary", "img/test.png"),
            Err(MediaError::StaleGeneration)
        );
        assert_eq!(service.reload().expect("reload dictionaries"), 2);
        assert_ne!(service.generation(), generation);
        assert_eq!(
            service.media(generation, "Test Dictionary", "img/test.png"),
            Err(MediaError::StaleGeneration)
        );
        drop(service);
    }

    #[test]
    fn native_lookup_preserves_large_glossaries_from_every_enabled_dictionary() {
        let root = TestDir::new("large-multi-dictionary-glossary");
        let titles = ["Large Alpha", "Large Beta", "Large Gamma"];
        for (index, title) in titles.iter().enumerate() {
            let archive_path = root.0.join(format!("dictionary-{index}.zip"));
            write_large_glossary_archive(&archive_path, title, &format!("definition-{index}"));
            let report = import_dictionary(&archive_path, &root.0);
            assert!(report.success, "dictionary import failed: {}", report.error);
        }
        write_manifest(&root.0, &titles);

        let mut service = HoshidictsService::new(root.0.clone());
        assert_eq!(
            service.activate().expect("activate dictionaries"),
            titles.len()
        );
        let results = service.lookup("膨大").expect("large native lookup");
        let result = results
            .iter()
            .find(|result| result.term.expression == "膨大")
            .expect("large lookup result");
        assert_eq!(result.term.glossaries.len(), titles.len());
        for (index, title) in titles.iter().enumerate() {
            let glossary = result
                .term
                .glossaries
                .iter()
                .find(|glossary| glossary.dictionary == *title)
                .expect("dictionary glossary");
            assert!(glossary.glossary.contains(&format!("definition-{index}")));
            assert!(glossary.glossary.len() > 128 * 1024);
        }
        assert!(
            serde_json::to_vec(&results)
                .expect("serialize large lookup")
                .len()
                > 256 * 1024
        );
    }

    #[test]
    fn imported_dictionary_redirects_are_followed_without_rendering_raw_tuples() {
        let root = TestDir::new("redirect-lookup");
        let (mut service, report) =
            imported_service(&root.0, "Redirect Lookup", write_redirect_lookup_archive);
        assert_eq!(report.term_count, 2);
        assert!(root
            .0
            .join("Redirect Lookup")
            .join(".hoshidicts_4")
            .is_file());
        let results = service.lookup("喰べる").expect("redirect lookup");
        let source = results
            .iter()
            .find(|result| result.term.expression == "喰べる")
            .expect("source redirect-link result");
        assert_eq!(source.matched, "喰べる");
        let source_glossary: serde_json::Value =
            serde_json::from_str(&source.term.glossaries[0].glossary)
                .expect("filtered source glossary JSON");
        assert_eq!(
            source_glossary
                .as_array()
                .expect("source definitions")
                .len(),
            1
        );

        let target = results
            .iter()
            .find(|result| result.term.expression == "食べる" && result.term.reading == "たべる")
            .expect("redirect target result");
        assert_eq!(target.matched, "喰べる");
        assert_eq!(target.deinflected, "食べる");
        assert_eq!(
            target.trace.last().map(|step| step.name.as_str()),
            Some("redirected from 喰べる")
        );
        assert!(target.term.glossaries[0].glossary.contains("to eat"));
        assert!(results.iter().all(|result| result
            .term
            .glossaries
            .iter()
            .all(|glossary| !glossary.glossary.contains("[\"食べる\",["))));
    }

    #[test]
    fn lookup_options_apply_primary_reading_before_the_configured_result_cap() {
        let root = TestDir::new("lookup-ranking");
        let (mut service, _) =
            imported_service(&root.0, "Lookup Ranking", write_lookup_ranking_archive);
        let ordinary = service.lookup("語").expect("ordinary lookup");
        assert_eq!(ordinary.len(), DEFAULT_LOOKUP_MAX_RESULTS as usize);
        assert!(ordinary
            .iter()
            .all(|result| result.term.reading != "よみ32"));

        let preferred_options = LookupOptions {
            primary_reading: Some("よみ32".into()),
            ..LookupOptions::default()
        };
        let preferred = service
            .lookup_with_options("語", &preferred_options)
            .expect("preferred-reading lookup");
        assert_eq!(preferred.len(), DEFAULT_LOOKUP_MAX_RESULTS as usize);
        assert_eq!(preferred[0].term.reading, "よみ32");

        let one_result = service
            .lookup_with_options(
                "語",
                &LookupOptions {
                    max_results: 1,
                    primary_reading: Some("よみ32".into()),
                    ..LookupOptions::default()
                },
            )
            .expect("one preferred result");
        assert_eq!(one_result.len(), 1);
        assert_eq!(one_result[0].term.reading, "よみ32");
    }

    #[test]
    fn lookup_options_sort_only_with_the_explicit_frequency_dictionary() {
        let root = TestDir::new("lookup-frequency-sort");
        let term_path = root.0.join("terms.zip");
        let frequency_path = root.0.join("frequency.zip");
        write_explicit_frequency_sort_archives(&term_path, &frequency_path);
        for archive in [&term_path, &frequency_path] {
            let report = import_dictionary(archive, &root.0);
            assert!(report.success, "dictionary import failed: {}", report.error);
        }
        write_manifest(&root.0, &["Frequency Sort Terms", "Explicit Rank"]);

        let readings = |results: Vec<LookupResult>| {
            results
                .into_iter()
                .map(|result| result.term.reading)
                .collect::<Vec<_>>()
        };
        let mut service = HoshidictsService::new(root.0.clone());
        assert_eq!(
            readings(service.lookup("語").expect("unsorted lookup")),
            ["ご一", "ご二", "ご三"]
        );
        assert_eq!(
            readings(
                service
                    .lookup_with_options(
                        "語",
                        &LookupOptions {
                            sort_frequency_dictionary: Some("Explicit Rank".into()),
                            sort_frequency_order: LookupFrequencySortOrder::Ascending,
                            ..LookupOptions::default()
                        },
                    )
                    .expect("ascending frequency lookup"),
            ),
            ["ご三", "ご二", "ご一"]
        );
        assert_eq!(
            readings(
                service
                    .lookup_with_options(
                        "語",
                        &LookupOptions {
                            sort_frequency_dictionary: Some("Missing Frequency".into()),
                            sort_frequency_order: LookupFrequencySortOrder::Ascending,
                            ..LookupOptions::default()
                        },
                    )
                    .expect("unknown frequency dictionary lookup"),
            ),
            ["ご一", "ご二", "ご三"]
        );
    }

    #[test]
    fn ffi_dictionary_styles_are_owned_and_generation_checked() {
        let root = TestDir::new("ffi-styles");
        let (mut service, _) = imported_service(&root.0, "Styled Dictionary", write_styled_archive);
        assert_eq!(service.activate().expect("activate dictionary"), 1);
        let generation = service.generation();
        assert_eq!(
            service.styles(generation),
            Ok(vec![DictionaryStyle {
                dictionary: "Styled Dictionary".into(),
                styles:
                    ".glossary[data-dictionary=\"Styled Dictionary\"] { color: rebeccapurple; }"
                        .into(),
            }])
        );
        assert_eq!(
            service.styles(generation.wrapping_add(1)),
            Err(StylesError::StaleGeneration)
        );

        assert_eq!(service.reload().expect("reload dictionary"), 1);
        assert_eq!(
            service.styles(generation),
            Err(StylesError::StaleGeneration)
        );
    }

    #[test]
    fn imported_hiragana_reading_matches_kana_and_kanji_variants() {
        let root = TestDir::new("kana-width");
        let (mut service, report) =
            imported_service(&root.0, "Kana Lookup", write_kana_lookup_archive);
        assert_eq!(report.term_count, 1);
        assert_eq!(service.activate().expect("activate dictionary"), 1);
        for source in ["ワガハイ", "ﾜｶﾞﾊｲ", "ワガハイ", "わがはい", "我輩"]
        {
            let result = service
                .lookup(source)
                .expect("katakana lookup")
                .into_iter()
                .find(|candidate| {
                    candidate.term.expression == "我輩" && candidate.term.reading == "わがはい"
                })
                .expect("katakana should match the hiragana reading");
            assert_eq!(result.matched, source);
        }
    }

    #[test]
    fn pure_kanji_dictionary_activates_without_a_term_role() {
        let root = TestDir::new("kanji-only");
        let (mut service, report) = imported_service(&root.0, "Test Dictionary", |path| {
            write_test_archive(path, false)
        });
        assert_eq!(report.term_count, 0);
        assert_eq!(report.kanji_count, 1);
        assert_eq!(service.activate().expect("activate kanji dictionary"), 1);
        assert!(service.lookup("食").expect("term lookup").is_empty());
        assert_eq!(
            service
                .lookup_kanji("食")
                .expect("kanji lookup")
                .entries
                .len(),
            1
        );
    }

    #[test]
    fn unicode_paths_and_titles_round_trip_through_native_import_and_lookup() {
        let root = TestDir::new("unicode-㋕");
        let (mut service, report) = imported_service(&root.0, "JPDBv2㋕", |path| {
            write_test_archive_with_title(path, "JPDBv2㋕", true)
        });
        assert_eq!(report.title, "JPDBv2㋕");
        assert_eq!(service.activate().expect("activate Unicode dictionary"), 1);
        assert!(service
            .lookup("食べた")
            .expect("lookup Unicode dictionary")
            .iter()
            .any(|result| result.term.expression == "食べる"));
    }

    #[test]
    fn native_kanji_query_rejects_oversized_materialization_before_ffi_copy() {
        let root = TestDir::new("bounded-native-kanji");
        let (mut service, _) = imported_service(&root.0, "Duplicate Kanji", |path| {
            write_test_archive_with_kanji_entries(
                path,
                "Duplicate Kanji",
                false,
                MAX_KANJI_ENTRIES + 1,
            )
        });
        assert_eq!(service.activate().expect("activate dictionary"), 1);
        assert!(service
            .lookup_kanji("食")
            .expect_err("native query must enforce its entry budget")
            .contains("native Hoshidicts kanji lookup failed"));
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

    // ---------------------------- client bridge -----------------------------

    fn unused_service() -> SharedHoshidicts {
        SharedHoshidicts::new(PathBuf::from("unused"))
    }

    fn parse_request(message: &str) -> Request {
        serde_json::from_str(message).expect("Hoshidicts request should deserialize")
    }

    /// Drive one request through the single bridge entry point and return the
    /// parsed reply.
    async fn reply_for(
        request: serde_json::Value,
        enabled: bool,
        service: &SharedHoshidicts,
    ) -> Value {
        let payload = handle_client_message(&request.to_string(), enabled, service)
            .await
            .expect("Hoshidicts request should be handled");
        serde_json::from_str(&payload).expect("reply should be one valid JSON value")
    }

    /// Failure replies must still carry the full media envelope, with no media.
    fn assert_media_failure(value: &Value, error: &str, stale_generation: bool) {
        assert_eq!(value["type"], MEDIA_RESULT);
        assert_eq!(value["success"], false);
        assert_eq!(value["mediaType"], Value::Null);
        assert_eq!(value["byteLength"], 0);
        assert_eq!(value["dataBase64"], Value::Null);
        assert_eq!(value["width"], Value::Null);
        assert_eq!(value["height"], Value::Null);
        assert_eq!(value["staleGeneration"], stale_generation);
        assert_eq!(value["error"], error);
    }

    #[test]
    fn requests_deserialize_with_correlated_request_ids() {
        assert_eq!(
            parse_request(
                r#"{"type":"hoshidicts_lookup","requestId":"lookup-1","text":"食べた","scanLength":21,"maxResults":48,"primaryReading":"たべた","sortFrequencyDictionary":"BCCWJ","sortFrequencyDictionaryOrder":"ascending"}"#
            ),
            Request::Lookup {
                request_id: RequestId::Text("lookup-1".into()),
                text: "食べた".into(),
                mode: LookupRequestMode::TermFirst,
                options: LookupRequestOptions {
                    scan_length: Some(21),
                    max_results: Some(48),
                    primary_reading: Some("たべた".into()),
                    sort_frequency_dictionary: Some("BCCWJ".into()),
                    sort_frequency_dictionary_order: Some(LookupFrequencySortOrder::Ascending),
                },
            }
        );
        assert_eq!(
            parse_request(
                r#"{"type":"hoshidicts_lookup","requestId":"lookup-kanji","text":"食","mode":"kanji"}"#
            ),
            Request::Lookup {
                request_id: RequestId::Text("lookup-kanji".into()),
                text: "食".into(),
                mode: LookupRequestMode::Kanji,
                options: LookupRequestOptions::default(),
            }
        );
        assert_eq!(
            parse_request(r#"{"type":"hoshidicts_reload","requestId":42}"#),
            Request::Reload {
                request_id: RequestId::Number(42),
            }
        );
        assert_eq!(
            parse_request(
                r#"{"type":"hoshidicts_media","requestId":"media-1","generation":7,"dictionary":"Japanese Character Names","path":"img/c123.jpg"}"#
            ),
            Request::Media {
                request_id: RequestId::Text("media-1".into()),
                generation: 7,
                dictionary: "Japanese Character Names".into(),
                path: "img/c123.jpg".into(),
            }
        );
        assert_eq!(
            parse_request(r#"{"type":"hoshidicts_styles","requestId":"styles-1","generation":7}"#),
            Request::Styles {
                request_id: RequestId::Text("styles-1".into()),
                generation: 7,
            }
        );
    }

    #[tokio::test]
    async fn non_hoshidicts_messages_are_left_to_the_caller() {
        let service = unused_service();
        for message in [
            r#"{"type":"tokenize","text":"食べた"}"#,
            r#"{"type":"hoshidicts_unknown","requestId":1}"#,
            // A Hoshidicts message without a request id cannot be correlated, so
            // it is ignored exactly like any other unroutable message.
            r#"{"type":"hoshidicts_lookup","text":"食べた"}"#,
            "not json",
        ] {
            assert!(
                handle_client_message(message, true, &service)
                    .await
                    .is_none(),
                "{message}"
            );
        }
    }

    #[tokio::test]
    async fn lookup_runs_through_the_blocking_boundary_and_preserves_correlation() {
        let value = reply_for(
            serde_json::json!({"type":"hoshidicts_lookup","requestId":42,"text":"食べる"}),
            true,
            &unused_service(),
        )
        .await;
        assert_eq!(value["type"], LOOKUP_RESULT);
        assert_eq!(value["requestId"], 42);
        assert_eq!(value["success"], true);
        assert_eq!(value["dictionaryCount"], 0);
        assert_ne!(value["generation"], 0);
        assert_eq!(value["featureDisabled"], false);
        assert_eq!(value["results"], serde_json::json!([]));
        assert_eq!(value["kanji"], Value::Null);
        assert_eq!(value["error"], Value::Null);
    }

    #[tokio::test]
    async fn lookup_failures_stay_correlated_and_keep_an_empty_result_shape() {
        let service = unused_service();
        let value = reply_for(
            serde_json::json!({"type":"hoshidicts_lookup","requestId":"lookup-2","text":"食べる"}),
            false,
            &service,
        )
        .await;
        assert_eq!(value["type"], LOOKUP_RESULT);
        assert_eq!(value["requestId"], "lookup-2");
        assert_eq!(value["success"], false);
        assert_eq!(value["results"], serde_json::json!([]));
        assert_eq!(value["kanji"], Value::Null);
        assert_eq!(value["dictionaryCount"], 0);
        assert_eq!(value["featureDisabled"], true);
        assert!(value["error"]
            .as_str()
            .expect("lookup error message")
            .contains(FEATURE_DISABLED_MESSAGE));
    }

    #[test]
    fn large_lookup_payload_stays_one_complete_json_response() {
        let request_id = serde_json::json!("lookup-large");
        let dictionaries = ["Large Alpha", "Large Beta", "Large Gamma"];
        let serialized = lookup_reply(
            request_id.clone(),
            dictionaries.len(),
            7,
            Ok((
                vec![LookupResult {
                    matched: "膨大".into(),
                    deinflected: "膨大".into(),
                    trace: Vec::new(),
                    term: LookupTerm {
                        expression: "膨大".into(),
                        reading: "ぼうだい".into(),
                        rules: String::new(),
                        score: 0,
                        glossaries: dictionaries
                            .iter()
                            .enumerate()
                            .map(|(index, dictionary)| LookupGlossary {
                                dictionary: (*dictionary).into(),
                                glossary: format!("definition-{index}:{}", "x".repeat(140 * 1024)),
                                definition_tags: String::new(),
                                term_tags: String::new(),
                            })
                            .collect(),
                        frequencies: Vec::new(),
                        pitches: Vec::new(),
                    },
                    preprocessor_steps: 0,
                }],
                None,
            )),
            false,
        );
        assert!(serialized.len() > 256 * 1024);
        assert!(serialized.len() < MAX_LOOKUP_RESPONSE_BYTES);

        let response =
            enforce_lookup_response_limit(request_id, dictionaries.len(), 7, serialized.clone());
        assert_eq!(response, serialized);
        let value: Value = serde_json::from_str(&response).expect("lookup payload");
        let preserved = value["results"][0]["term"]["glossaries"]
            .as_array()
            .expect("glossaries");
        assert_eq!(preserved.len(), dictionaries.len());
        for dictionary in dictionaries {
            assert!(preserved
                .iter()
                .any(|glossary| glossary["dictionary"] == dictionary));
        }
    }

    #[test]
    fn kanji_fallback_uses_only_the_first_han_character() {
        assert_eq!(first_han_character("食べる").as_deref(), Some("食"));
        assert_eq!(first_han_character("𠮟る").as_deref(), Some("𠮟"));
        assert_eq!(first_han_character("べる"), None);
        assert_eq!(first_han_character("。食"), None);
    }

    #[tokio::test]
    async fn styles_replies_keep_a_stable_shape_for_every_outcome() {
        let service = unused_service();
        let generation = service
            .run_blocking(|service| {
                service.activate().expect("activate empty service");
                service.generation()
            })
            .await
            .expect("blocking styles setup");

        let loaded = reply_for(
            serde_json::json!({"type":"hoshidicts_styles","requestId":"styles-2","generation":generation}),
            true,
            &service,
        )
        .await;
        assert_eq!(loaded["type"], STYLES_RESULT);
        assert_eq!(loaded["requestId"], "styles-2");
        assert_eq!(loaded["success"], true);
        assert_eq!(loaded["generation"], generation);
        assert_eq!(loaded["styles"], serde_json::json!([]));
        assert_eq!(loaded["featureDisabled"], false);
        assert_eq!(loaded["staleGeneration"], false);
        assert_eq!(loaded["error"], Value::Null);

        // (enabled, generation, expected featureDisabled, expected staleGeneration, expected error)
        for (enabled, requested_generation, feature_disabled, stale, error) in [
            (false, 3, true, false, FEATURE_DISABLED_CODE),
            (true, 99, false, true, "stale_generation"),
        ] {
            let value = reply_for(
                serde_json::json!({"type":"hoshidicts_styles","requestId":9,"generation":requested_generation}),
                enabled,
                &service,
            )
            .await;
            assert_eq!(value["requestId"], 9);
            assert_eq!(value["success"], false);
            assert_eq!(value["generation"], requested_generation);
            assert_eq!(value["styles"], serde_json::json!([]));
            assert_eq!(value["featureDisabled"], feature_disabled);
            assert_eq!(value["staleGeneration"], stale);
            assert_eq!(value["error"], error);
        }
    }

    #[test]
    fn styles_response_rejects_json_escape_expansion() {
        let styles = (0..7)
            .map(|index| DictionaryStyle {
                dictionary: format!("Dictionary {index}"),
                styles: "\0".repeat(256 * 1024),
            })
            .collect();
        let payload = styles_success_reply(serde_json::json!("styles-large"), 12, styles);
        assert!(payload.len() <= MAX_STYLES_RESPONSE_BYTES);
        let value: Value = serde_json::from_str(&payload).expect("valid styles response");
        assert_eq!(value["requestId"], "styles-large");
        assert_eq!(value["success"], false);
        assert_eq!(value["generation"], 12);
        assert_eq!(value["styles"], serde_json::json!([]));
        assert_eq!(value["featureDisabled"], false);
        assert_eq!(value["staleGeneration"], false);
        assert_eq!(value["error"], "response_too_large");
    }

    #[tokio::test]
    async fn media_failures_use_a_stable_correlated_envelope() {
        let service = unused_service();
        // (enabled, path, expected error, expected featureDisabled, expected staleGeneration)
        for (enabled, path, error, feature_disabled, stale) in [
            (
                true,
                "../escape.png",
                MediaError::InvalidPath.code(),
                false,
                false,
            ),
            (
                true,
                "img/test.png",
                MediaError::StaleGeneration.code(),
                false,
                true,
            ),
            (false, "img/test.png", FEATURE_DISABLED_CODE, true, false),
        ] {
            let value = reply_for(
                serde_json::json!({
                    "type": "hoshidicts_media",
                    "requestId": "media-2",
                    "generation": 99,
                    "dictionary": "Test",
                    "path": path,
                }),
                enabled,
                &service,
            )
            .await;
            assert_media_failure(&value, error, stale);
            assert_eq!(value["requestId"], "media-2");
            assert_eq!(value["generation"], 99);
            assert_eq!(value["dictionary"], "Test");
            assert_eq!(value["path"], path);
            assert_eq!(value["featureDisabled"], feature_disabled);
        }
    }

    #[test]
    fn media_success_envelope_includes_base64_and_dimensions() {
        let payload = MediaEnvelope {
            request_id: serde_json::json!("media-success"),
            generation: 11,
            dictionary: "Test".into(),
            path: "img/test.png".into(),
        }
        .success(MediaFile {
            media_type: "image/png",
            data: vec![0, 1, 2, 253],
        });
        let value: Value = serde_json::from_str(&payload).expect("valid media response");
        assert_eq!(value["type"], MEDIA_RESULT);
        assert_eq!(value["requestId"], "media-success");
        assert_eq!(value["success"], true);
        assert_eq!(value["generation"], 11);
        assert_eq!(value["dictionary"], "Test");
        assert_eq!(value["path"], "img/test.png");
        assert_eq!(value["mediaType"], "image/png");
        assert_eq!(value["byteLength"], 4);
        assert_eq!(value["dataBase64"], "AAEC/Q==");
        assert_eq!(value["featureDisabled"], false);
        assert_eq!(value["staleGeneration"], false);
        assert_eq!(value["error"], Value::Null);
    }

    #[tokio::test]
    async fn reload_reports_feature_state_and_preserves_correlation() {
        let service = unused_service();
        let disabled = reply_for(
            serde_json::json!({"type":"hoshidicts_reload","requestId":7}),
            false,
            &service,
        )
        .await;
        assert_eq!(disabled["type"], RELOAD_RESULT);
        assert_eq!(disabled["requestId"], 7);
        assert_eq!(disabled["success"], false);
        assert_eq!(disabled["dictionaryCount"], 0);
        assert_eq!(disabled["featureDisabled"], true);
        assert_eq!(disabled["error"], FEATURE_DISABLED_MESSAGE);

        let reloaded = reply_for(
            serde_json::json!({"type":"hoshidicts_reload","requestId":8}),
            true,
            &service,
        )
        .await;
        assert_eq!(reloaded["requestId"], 8);
        assert_eq!(reloaded["success"], true);
        assert_eq!(reloaded["dictionaryCount"], 0);
        assert_ne!(reloaded["generation"], 0);
        assert_eq!(reloaded["featureDisabled"], false);
        assert_eq!(reloaded["error"], Value::Null);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn blocking_work_does_not_stall_the_async_runtime() {
        let service = unused_service();
        let slow_operation = service.run_blocking(|_| {
            std::thread::sleep(Duration::from_millis(100));
        });
        tokio::pin!(slow_operation);

        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(10)) => {}
            result = &mut slow_operation => {
                panic!("blocking work completed before the async heartbeat: {result:?}");
            }
        }

        slow_operation
            .await
            .expect("blocking Hoshidicts work should complete");
    }

    #[tokio::test]
    async fn feature_lease_transitions_load_and_unload_the_engine() {
        let root = TestDir::new("feature-lease");
        let service = SharedHoshidicts::new(root.0.clone());
        async fn is_loaded(service: &SharedHoshidicts) -> bool {
            service
                .run_blocking(|service| service.is_loaded())
                .await
                .expect("engine state")
        }

        // No transition, no native work.
        service.apply_feature_state(false, false).await;
        assert!(!is_loaded(&service).await);
        service.apply_feature_state(true, false).await;
        assert!(is_loaded(&service).await);
        service.apply_feature_state(false, true).await;
        assert!(!is_loaded(&service).await);
    }
}
