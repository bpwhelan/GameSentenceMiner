use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, c_int, CStr, CString};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::ptr;
use std::slice;

pub const MANIFEST_FILE_NAME: &str = "manifest.json";
pub const LOOKUP_SCAN_LENGTH: usize = 10;
pub const LOOKUP_MAX_RESULTS: c_int = 16;
pub const MAX_LOOKUP_TEXT_BYTES: usize = 4 * 1024;
pub const MAX_LOOKUP_RESPONSE_BYTES: usize = 256 * 1024;
pub const MAX_REQUEST_ID_BYTES: usize = 128;
pub const MAX_MEDIA_DICTIONARY_BYTES: usize = 1024;
pub const MAX_MEDIA_PATH_BYTES: usize = 4 * 1024;
pub const MAX_MEDIA_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_MEDIA_RESPONSE_BYTES: usize = 6 * 1024 * 1024;
pub const MAX_MEDIA_DIMENSION: u32 = 4096;
pub const MAX_MEDIA_PIXELS: u64 = 16 * 1024 * 1024;

const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_DICTIONARIES: usize = 256;
const MAX_NATIVE_STRING_BYTES: usize = 128 * 1024;
const MAX_NATIVE_AGGREGATE_STRINGS: usize = 4096;
const MAX_GLOSSARIES: usize = 64;
const MAX_TRACE_STEPS: usize = 32;
const MAX_FREQUENCY_ENTRIES: usize = 64;
const MAX_FREQUENCIES_PER_ENTRY: usize = 64;
const MAX_PITCH_ENTRIES: usize = 64;
const MAX_PITCHES_PER_ENTRY: usize = 64;
const MAX_PITCH_MARKERS: usize = 128;
const MAX_TRANSCRIPTIONS_PER_ENTRY: usize = 64;
const MAX_KANJI_ENTRIES: usize = 64;
const MAX_KANJI_DEFINITIONS_PER_ENTRY: usize = 64;
const MAX_KANJI_STATS_PER_ENTRY: usize = 128;
const MAX_ARCHIVE_INDEX_BYTES: u64 = 1024 * 1024;
const MAX_MEDIA_RECORDS: u64 = 1_000_000;
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

#[repr(C)]
struct HdKanjiResults {
    _private: [u8; 0],
}

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
struct HdFrequencyV2 {
    value: f64,
    display_value: HdStr,
    display_value_is_null: c_int,
}

#[derive(Clone, Copy)]
#[repr(C)]
struct HdFrequencyEntryV2 {
    dict_name: HdStr,
    frequencies: *const HdFrequencyV2,
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
struct HdTermResultV2 {
    expression: HdStr,
    reading: HdStr,
    rules: HdStr,
    score: i32,
    glossaries: *const HdGlossaryEntry,
    glossaries_count: usize,
    frequencies: *const HdFrequencyEntryV2,
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
struct HdLookupResultV2 {
    matched: HdStr,
    deinflected: HdStr,
    trace: *const HdTransformGroup,
    trace_count: usize,
    term: HdTermResultV2,
    preprocessor_steps: i32,
}

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

    fn hd_lookup_new(query: *mut HdQuery, deinflector: *mut HdDeinflector) -> *mut HdLookup;
    fn hd_lookup_free(lookup: *mut HdLookup);
    fn hd_lookup_run_v2(
        lookup: *const HdLookup,
        lookup_string: *const c_char,
        max_results: c_int,
        scan_length: usize,
        out_results: *mut *const HdLookupResultV2,
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

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LookupFrequency {
    pub value: f64,
    pub display_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
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

#[derive(Debug, Clone, Serialize, PartialEq)]
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

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LookupResult {
    pub matched: String,
    pub deinflected: String,
    pub trace: Vec<LookupTrace>,
    pub term: LookupTerm,
    pub preprocessor_steps: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaFile {
    pub media_type: &'static str,
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaError {
    InvalidRequestId,
    InvalidDictionary,
    InvalidPath,
    NotFound,
    UnsupportedMediaType,
    MediaTooLarge,
    InvalidDimensions,
    StaleGeneration,
    InternalError,
}

impl MediaError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidRequestId => "invalid_request_id",
            Self::InvalidDictionary => "invalid_dictionary",
            Self::InvalidPath => "invalid_path",
            Self::NotFound => "not_found",
            Self::UnsupportedMediaType => "unsupported_media_type",
            Self::MediaTooLarge => "media_too_large",
            Self::InvalidDimensions => "invalid_dimensions",
            Self::StaleGeneration => "stale_generation",
            Self::InternalError => "internal_error",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LookupKanjiStat {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LookupKanjiEntry {
    pub dictionary: String,
    pub onyomi: String,
    pub kunyomi: String,
    pub tags: String,
    pub definitions: Vec<String>,
    pub stats: Vec<LookupKanjiStat>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LookupKanji {
    pub character: String,
    pub entries: Vec<LookupKanjiEntry>,
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

struct KanjiResultsGuard(*mut HdKanjiResults);

impl Drop for KanjiResultsGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { hd_kanji_results_free(self.0) };
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

#[derive(Debug)]
struct MediaRecordMetadata {
    path: String,
    end: u64,
}

fn read_exact_at(
    file: &mut fs::File,
    offset: u64,
    buffer: &mut [u8],
    file_path: &Path,
    label: &str,
) -> Result<(), String> {
    file.seek(SeekFrom::Start(offset)).map_err(|error| {
        format!(
            "failed to seek to {label} in {}: {error}",
            file_path.display()
        )
    })?;
    file.read_exact(buffer).map_err(|error| {
        format!(
            "failed to read {label} from {}: {error}",
            file_path.display()
        )
    })
}

fn read_media_record_metadata(
    media_file: &mut fs::File,
    media_path: &Path,
    media_size: u64,
    record_offset: u64,
) -> Result<MediaRecordMetadata, String> {
    let path_length_end = record_offset
        .checked_add(2)
        .ok_or_else(|| "dictionary media record offset overflowed".to_string())?;
    if path_length_end > media_size {
        return Err(format!(
            "dictionary media record at offset {record_offset} has a truncated path length header"
        ));
    }

    let mut path_length_bytes = [0u8; 2];
    read_exact_at(
        media_file,
        record_offset,
        &mut path_length_bytes,
        media_path,
        "media path length",
    )?;
    let path_length = usize::from(u16::from_le_bytes(path_length_bytes));
    if path_length == 0 || path_length > MAX_MEDIA_PATH_BYTES {
        return Err(format!(
            "dictionary media record at offset {record_offset} has an invalid path length"
        ));
    }

    let path_end = path_length_end
        .checked_add(path_length as u64)
        .ok_or_else(|| "dictionary media path length overflowed".to_string())?;
    let blob_length_end = path_end
        .checked_add(4)
        .ok_or_else(|| "dictionary media blob header offset overflowed".to_string())?;
    if blob_length_end > media_size {
        return Err(format!(
            "dictionary media record at offset {record_offset} has a truncated path or blob length header"
        ));
    }

    let mut path_bytes = vec![0u8; path_length];
    read_exact_at(
        media_file,
        path_length_end,
        &mut path_bytes,
        media_path,
        "media path",
    )?;
    let path = String::from_utf8(path_bytes).map_err(|_| {
        format!("dictionary media record at offset {record_offset} has a non-UTF-8 path")
    })?;
    validate_media_path(&path).map_err(|_| {
        format!("dictionary media record at offset {record_offset} has a non-normalized path")
    })?;

    let mut blob_length_bytes = [0u8; 4];
    read_exact_at(
        media_file,
        path_end,
        &mut blob_length_bytes,
        media_path,
        "media blob length",
    )?;
    let blob_length = u64::from(u32::from_le_bytes(blob_length_bytes));
    if blob_length == 0 || blob_length > MAX_MEDIA_BYTES as u64 {
        return Err(format!(
            "dictionary media record at offset {record_offset} has an invalid blob length"
        ));
    }
    let end = blob_length_end
        .checked_add(blob_length)
        .ok_or_else(|| "dictionary media blob length overflowed".to_string())?;
    if end > media_size {
        return Err(format!(
            "dictionary media record at offset {record_offset} extends past the end of media.bin"
        ));
    }

    Ok(MediaRecordMetadata { path, end })
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
    let mut records = Vec::new();
    records
        .try_reserve_exact(count)
        .map_err(|_| "dictionary media index is too large to validate".to_string())?;
    for index in 0..count {
        let mut offset_bytes = [0u8; 8];
        index_file.read_exact(&mut offset_bytes).map_err(|error| {
            format!(
                "failed to read dictionary media index offset {index} from {}: {error}",
                index_path.display()
            )
        })?;
        records.push((u64::from_le_bytes(offset_bytes), 0u64));
    }

    let mut media_file = fs::File::open(&media_path).map_err(|error| {
        format!(
            "failed to open dictionary media data {}: {error}",
            media_path.display()
        )
    })?;
    let mut previous_path: Option<String> = None;
    for (offset, end) in &mut records {
        let record = read_media_record_metadata(&mut media_file, &media_path, media_size, *offset)?;
        if previous_path
            .as_ref()
            .is_some_and(|previous| previous > &record.path)
        {
            return Err("dictionary media.idx paths are not sorted".into());
        }
        previous_path = Some(record.path);
        *end = record.end;
    }

    records.sort_unstable_by_key(|(offset, _)| *offset);
    let mut expected_offset = 0u64;
    for (offset, end) in records {
        if offset != expected_offset {
            let problem = if offset < expected_offset {
                "overlapping or duplicate"
            } else {
                "non-contiguous"
            };
            return Err(format!(
                "dictionary media.idx contains {problem} record offsets: expected {expected_offset}, found {offset}"
            ));
        }
        expected_offset = end;
    }
    if expected_offset != media_size {
        return Err(format!(
            "dictionary media records do not cover media.bin: covered {expected_offset} of {media_size} bytes"
        ));
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

    let index = read_dictionary_index(dictionary_path)?;
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

    fn lookup(&self, text: &str) -> Result<Vec<LookupResult>, String> {
        validate_lookup_text(text)?;
        let lookup_text =
            CString::new(text).map_err(|_| "lookup text contains an embedded NUL byte")?;
        let mut result_pointer = ptr::null();
        let mut result_count = 0usize;
        let owned_results = unsafe {
            hd_lookup_run_v2(
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
        let mut copy_budget = NativeCopyBudget::new();
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

    fn media(&self, dictionary: &str, path: &str) -> Result<MediaFile, MediaError> {
        validate_media_dictionary(dictionary)?;
        validate_media_path(path)?;
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
        let (media_type, width, height) = raster_metadata(&data)?;
        validate_media_dimensions(width, height)?;
        Ok(MediaFile {
            media_type,
            data,
            width,
            height,
        })
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

struct NativeCopyBudget {
    bytes: usize,
    strings: usize,
}

impl NativeCopyBudget {
    fn new() -> Self {
        Self {
            bytes: 0,
            strings: 0,
        }
    }

    fn claim(&mut self, bytes: usize, label: &str) -> Result<(), String> {
        let next_bytes = self
            .bytes
            .checked_add(bytes)
            .ok_or_else(|| format!("native {label} exceeds the aggregate response limit"))?;
        let next_strings = self
            .strings
            .checked_add(1)
            .ok_or_else(|| format!("native {label} exceeds the aggregate response limit"))?;
        if next_bytes > MAX_LOOKUP_RESPONSE_BYTES || next_strings > MAX_NATIVE_AGGREGATE_STRINGS {
            return Err(format!(
                "native {label} exceeds the aggregate response limit"
            ));
        }
        self.bytes = next_bytes;
        self.strings = next_strings;
        Ok(())
    }
}

unsafe fn copy_hd_string_bounded(
    value: HdStr,
    label: &str,
    budget: &mut NativeCopyBudget,
) -> Result<String, String> {
    budget.claim(value.len, label)?;
    copy_hd_string(value, label)
}

unsafe fn copy_frequency_entries(
    pointer: *const HdFrequencyEntryV2,
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
            if !frequency.value.is_finite() {
                return Err("native frequency value was not finite".into());
            }
            Ok(LookupFrequency {
                value: frequency.value,
                display_value: if frequency.display_value_is_null != 0 {
                    None
                } else {
                    Some(copy_hd_string(
                        frequency.display_value,
                        "frequency display value",
                    )?)
                },
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

pub fn validate_media_dictionary(dictionary: &str) -> Result<(), MediaError> {
    if dictionary.is_empty()
        || dictionary.len() > MAX_MEDIA_DICTIONARY_BYTES
        || dictionary.chars().any(char::is_control)
    {
        return Err(MediaError::InvalidDictionary);
    }
    Ok(())
}

pub fn validate_media_path(path: &str) -> Result<(), MediaError> {
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

fn validate_media_dimensions(width: u32, height: u32) -> Result<(), MediaError> {
    if width == 0
        || height == 0
        || width > MAX_MEDIA_DIMENSION
        || height > MAX_MEDIA_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_MEDIA_PIXELS
    {
        return Err(MediaError::InvalidDimensions);
    }
    Ok(())
}

fn raster_metadata(data: &[u8]) -> Result<(&'static str, u32, u32), MediaError> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        if data.len() < 33 || &data[8..12] != b"\0\0\0\r" || &data[12..16] != b"IHDR" {
            return Err(MediaError::UnsupportedMediaType);
        }
        return Ok((
            "image/png",
            u32::from_be_bytes(data[16..20].try_into().unwrap()),
            u32::from_be_bytes(data[20..24].try_into().unwrap()),
        ));
    }
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        if data.len() < 10 {
            return Err(MediaError::UnsupportedMediaType);
        }
        return Ok((
            "image/gif",
            u16::from_le_bytes(data[6..8].try_into().unwrap()).into(),
            u16::from_le_bytes(data[8..10].try_into().unwrap()).into(),
        ));
    }
    if data.starts_with(&[0xff, 0xd8]) {
        let (width, height) = jpeg_dimensions(data)?;
        return Ok(("image/jpeg", width, height));
    }
    if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        let riff_size = u32::from_le_bytes(data[4..8].try_into().unwrap()) as usize;
        if riff_size.checked_add(8) != Some(data.len()) {
            return Err(MediaError::UnsupportedMediaType);
        }
        let (width, height) = webp_dimensions(data)?;
        return Ok(("image/webp", width, height));
    }
    Err(MediaError::UnsupportedMediaType)
}

fn jpeg_dimensions(data: &[u8]) -> Result<(u32, u32), MediaError> {
    let mut offset = 2usize;
    while offset < data.len() {
        while offset < data.len() && data[offset] != 0xff {
            offset += 1;
        }
        while offset < data.len() && data[offset] == 0xff {
            offset += 1;
        }
        let marker = *data.get(offset).ok_or(MediaError::UnsupportedMediaType)?;
        offset += 1;
        if marker == 0xd9 || marker == 0xda {
            break;
        }
        if marker == 0x01 || (0xd0..=0xd8).contains(&marker) {
            continue;
        }
        let length_bytes = data
            .get(offset..offset + 2)
            .ok_or(MediaError::UnsupportedMediaType)?;
        let length = usize::from(u16::from_be_bytes(length_bytes.try_into().unwrap()));
        if length < 2 || offset + length > data.len() {
            return Err(MediaError::UnsupportedMediaType);
        }
        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) {
            if length < 8 {
                return Err(MediaError::UnsupportedMediaType);
            }
            let height = u16::from_be_bytes(data[offset + 3..offset + 5].try_into().unwrap());
            let width = u16::from_be_bytes(data[offset + 5..offset + 7].try_into().unwrap());
            return Ok((width.into(), height.into()));
        }
        offset += length;
    }
    Err(MediaError::UnsupportedMediaType)
}

fn webp_dimensions(data: &[u8]) -> Result<(u32, u32), MediaError> {
    let mut offset = 12usize;
    while offset + 8 <= data.len() {
        let chunk = &data[offset..offset + 4];
        let length = u32::from_le_bytes(data[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let payload_start = offset + 8;
        let payload_end = payload_start
            .checked_add(length)
            .ok_or(MediaError::UnsupportedMediaType)?;
        let payload = data
            .get(payload_start..payload_end)
            .ok_or(MediaError::UnsupportedMediaType)?;
        match chunk {
            b"VP8 " if payload.len() >= 10 && payload[3..6] == [0x9d, 0x01, 0x2a] => {
                let width = u16::from_le_bytes(payload[6..8].try_into().unwrap()) & 0x3fff;
                let height = u16::from_le_bytes(payload[8..10].try_into().unwrap()) & 0x3fff;
                return Ok((width.into(), height.into()));
            }
            b"VP8L" if payload.len() >= 5 && payload[0] == 0x2f => {
                let bits = u32::from_le_bytes(payload[1..5].try_into().unwrap());
                return Ok(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1));
            }
            b"VP8X" if payload.len() >= 10 => {
                let width = 1
                    + u32::from(payload[4])
                    + (u32::from(payload[5]) << 8)
                    + (u32::from(payload[6]) << 16);
                let height = 1
                    + u32::from(payload[7])
                    + (u32::from(payload[8]) << 8)
                    + (u32::from(payload[9]) << 16);
                return Ok((width, height));
            }
            _ => {}
        }
        offset = payload_end + (length & 1);
    }
    Err(MediaError::UnsupportedMediaType)
}

pub struct HoshidictsService {
    root: PathBuf,
    engine: Option<NativeEngine>,
    generation: u64,
}

impl HoshidictsService {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            engine: None,
            generation: 0,
        }
    }

    pub fn activate(&mut self) -> Result<usize, String> {
        if self.engine.is_none() {
            self.engine = Some(NativeEngine::load(&self.root)?);
            self.advance_generation();
        }
        Ok(self.dictionary_count())
    }

    pub fn deactivate(&mut self) {
        self.engine = None;
        self.advance_generation();
    }

    pub fn reload(&mut self) -> Result<usize, String> {
        let replacement = NativeEngine::load(&self.root)?;
        let dictionary_count = replacement.dictionary_count;
        self.engine = Some(replacement);
        self.advance_generation();
        Ok(dictionary_count)
    }

    pub fn lookup(&mut self, text: &str) -> Result<Vec<LookupResult>, String> {
        self.activate()?;
        self.engine
            .as_ref()
            .expect("engine was activated")
            .lookup(text)
    }

    pub fn lookup_kanji(&mut self, character: &str) -> Result<LookupKanji, String> {
        self.activate()?;
        self.engine
            .as_ref()
            .expect("engine was activated")
            .lookup_kanji(character)
    }

    pub fn media(
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

    pub fn generation(&self) -> u64 {
        self.generation
    }

    fn advance_generation(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        if self.generation == 0 {
            self.generation = 1;
        }
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
    const TEST_PNG: &[u8] =
        b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x02\0\0\0\x03\x08\x06\0\0\0\0\0\0\0";

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

    fn write_manifest(root: &Path, path: &str) {
        fs::write(
            root.join(MANIFEST_FILE_NAME),
            format!(r#"{{"version":1,"dictionaries":[{{"id":"test","path":"{path}"}}]}}"#),
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
        write_manifest(root, "Test");
        set_dictionary_media_count(
            &dictionary,
            u64::try_from(entries.len()).expect("media count"),
        );
        write_native_media_files(&dictionary, entries);
        dictionary
    }

    fn write_zip_archive(path: &Path, entries: &[(&str, &str)]) {
        let file = fs::File::create(path).expect("create archive");
        let mut archive = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, contents) in entries {
            archive
                .start_file(*name, options)
                .expect("start archive file");
            archive
                .write_all(contents.as_bytes())
                .expect("write archive file");
        }
        archive.finish().expect("finish archive");
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
        let file = fs::File::create(path).expect("create archive");
        let mut archive = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        archive
            .start_file("index.json", options)
            .expect("start index");
        let index = serde_json::json!({
            "title": title,
            "revision": "1",
            "format": 3,
            "sequenced": false,
            "sourceLanguage": "ja",
        })
        .to_string();
        archive.write_all(index.as_bytes()).expect("write index");
        if include_terms {
            archive
                .start_file("term_bank_1.json", options)
                .expect("start term bank");
            archive
                .write_all(
                    r#"[["食べる","たべる","","v1",0,[{"type":"structured-content","content":[{"tag":"span","content":"to eat"},{"tag":"img","path":"img/test.png","width":2,"height":3,"sizeUnits":"px"}]}],1,""]]"#
                        .as_bytes(),
                )
                .expect("write term bank");
            archive
                .start_file("term_meta_bank_1.json", options)
                .expect("start term metadata bank");
            archive
                .write_all(
                    r#"[["食べる","freq",{"reading":"たべる","frequency":{"value":123.5,"displayValue":"123.5 ★"}}],["食べる","pitch",{"reading":"たべる","pitches":[{"position":2,"nasal":[1],"devoice":[2]}]}]]"#
                        .as_bytes(),
                )
                .expect("write term metadata bank");
            archive
                .start_file("img/test.png", options)
                .expect("start media");
            archive.write_all(TEST_PNG).expect("write media");
        }
        archive
            .start_file("kanji_bank_1.json", options)
            .expect("start kanji bank");
        let kanji_entry = serde_json::json!([
            "食",
            "ショク ジキ",
            "く.う た.べる",
            "jouyou",
            ["eat", "food"],
            { "strokes": "9", "grade": "2" }
        ]);
        archive
            .write_all(
                serde_json::to_string(&vec![kanji_entry; kanji_entry_count])
                    .expect("serialize kanji bank")
                    .as_bytes(),
            )
            .expect("write kanji bank");
        archive.finish().expect("finish archive");
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
                    r#"[["食べる","freq",{"reading":"たべる","frequency":"22.5 rank"}]]"#,
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
    fn native_copy_budget_rejects_oversized_aggregate_kanji_results() {
        let chunk = vec![b'x'; MAX_NATIVE_STRING_BYTES];
        let value = HdStr {
            ptr: chunk.as_ptr().cast::<c_char>(),
            len: chunk.len(),
        };
        let mut byte_budget = NativeCopyBudget::new();
        unsafe {
            copy_hd_string_bounded(value, "test value", &mut byte_budget)
                .expect("first bounded string");
            copy_hd_string_bounded(value, "test value", &mut byte_budget)
                .expect("second bounded string");
            assert!(
                copy_hd_string_bounded(value, "test value", &mut byte_budget)
                    .expect_err("aggregate byte limit must fail")
                    .contains("aggregate response limit")
            );
        }

        let empty = HdStr {
            ptr: ptr::null(),
            len: 0,
        };
        let mut item_budget = NativeCopyBudget::new();
        unsafe {
            for _ in 0..MAX_NATIVE_AGGREGATE_STRINGS {
                copy_hd_string_bounded(empty, "test value", &mut item_budget)
                    .expect("bounded empty string");
            }
            assert!(
                copy_hd_string_bounded(empty, "test value", &mut item_budget)
                    .expect_err("aggregate item limit must fail")
                    .contains("aggregate response limit")
            );
        }
    }

    #[test]
    fn frequency_v2_preserves_fractional_values_and_nullable_display_values() {
        let dictionary = b"Frequency Test";
        let values = [
            HdFrequencyV2 {
                value: 12.5,
                display_value: HdStr {
                    ptr: ptr::null(),
                    len: 0,
                },
                display_value_is_null: 1,
            },
            HdFrequencyV2 {
                value: 7.25,
                display_value: HdStr {
                    ptr: ptr::null(),
                    len: 0,
                },
                display_value_is_null: 0,
            },
        ];
        let entries = [HdFrequencyEntryV2 {
            dict_name: HdStr {
                ptr: dictionary.as_ptr().cast(),
                len: dictionary.len(),
            },
            frequencies: values.as_ptr(),
            frequencies_count: values.len(),
        }];

        let copied = unsafe {
            copy_frequency_entries(entries.as_ptr(), entries.len()).expect("valid frequencies")
        };
        assert_eq!(
            copied,
            vec![LookupFrequencyEntry {
                dictionary: "Frequency Test".into(),
                frequencies: vec![
                    LookupFrequency {
                        value: 12.5,
                        display_value: None,
                    },
                    LookupFrequency {
                        value: 7.25,
                        display_value: Some(String::new()),
                    },
                ],
            }]
        );

        let json = serde_json::to_value(&copied).expect("serialize frequencies");
        assert!(json[0]["frequencies"][0]["displayValue"].is_null());
        assert_eq!(json[0]["frequencies"][1]["displayValue"], "");
    }

    #[test]
    fn frequency_v2_rejects_non_finite_values() {
        let values = [HdFrequencyV2 {
            value: f64::NAN,
            display_value: HdStr {
                ptr: ptr::null(),
                len: 0,
            },
            display_value_is_null: 1,
        }];
        let entries = [HdFrequencyEntryV2 {
            dict_name: HdStr {
                ptr: ptr::null(),
                len: 0,
            },
            frequencies: values.as_ptr(),
            frequencies_count: values.len(),
        }];

        assert!(
            unsafe { copy_frequency_entries(entries.as_ptr(), entries.len()) }
                .expect_err("non-finite value must fail")
                .contains("not finite")
        );
    }

    #[test]
    fn media_paths_and_raster_metadata_are_strictly_validated() {
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

        assert_eq!(raster_metadata(TEST_PNG), Ok(("image/png", 2, 3)));
        assert_eq!(
            raster_metadata(b"GIF89a\x02\0\x03\0"),
            Ok(("image/gif", 2, 3))
        );
        assert_eq!(
            raster_metadata(&[
                0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 3, 0, 2, 1, 1, 0x11, 0, 0xff, 0xd9,
            ]),
            Ok(("image/jpeg", 2, 3))
        );
        assert_eq!(
            raster_metadata(b"RIFF\x16\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0\x01\0\0\x02\0\0"),
            Ok(("image/webp", 2, 3))
        );
        assert_eq!(
            raster_metadata(b"<svg></svg>"),
            Err(MediaError::UnsupportedMediaType)
        );
        assert_eq!(
            validate_media_dimensions(MAX_MEDIA_DIMENSION + 1, 1),
            Err(MediaError::InvalidDimensions)
        );
    }

    #[test]
    fn manifest_validation_requires_marker_index_content_and_native_files() {
        let root = TestDir::new("validation");
        let dictionary = write_dictionary(&root.0, "generations/test/1/Test", 1, 0);
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
    fn dictionary_index_classifies_term_only_content() {
        let root = TestDir::new("term-only");
        let dictionary = write_dictionary_with_counts(&root.0, "dictionary", 1, &[], 0);

        let spec = validate_dictionary_directory(&dictionary).expect("term-only dictionary");
        assert!(spec.has_terms);
        assert!(!spec.has_frequency);
        assert!(!spec.has_pitch);
        assert!(!spec.has_kanji);
        assert_eq!(
            spec.query_kinds().collect::<Vec<_>>(),
            [DictionaryKind::Term]
        );
    }

    #[test]
    fn dictionary_with_media_requires_a_valid_native_media_layout() {
        let root = TestDir::new("media-validation");
        let dictionary = write_dictionary(&root.0, "Test", 1, 0);
        write_manifest(&root.0, "Test");
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
    fn dictionary_index_classifies_frequency_only_content() {
        let root = TestDir::new("frequency-only");
        let dictionary = write_dictionary_with_counts(&root.0, "dictionary", 0, &[("freq", 1)], 0);

        let spec = validate_dictionary_directory(&dictionary).expect("frequency-only dictionary");
        assert!(!spec.has_terms);
        assert!(spec.has_frequency);
        assert!(!spec.has_pitch);
        assert!(!spec.has_kanji);
        assert_eq!(
            spec.query_kinds().collect::<Vec<_>>(),
            [DictionaryKind::Frequency]
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
    fn media_index_offsets_must_reference_sorted_contiguous_records() {
        let root = TestDir::new("media-index-offsets");
        let dictionary = media_dictionary(&root.0, &[("img/a.png", &[1]), ("img/b.png", &[2])]);
        let index_path = dictionary.join("media.idx");
        let media_path = dictionary.join("media.bin");
        let valid_index = fs::read(&index_path).expect("read valid index");
        let media_size = fs::metadata(&media_path).expect("media metadata").len();

        let mut out_of_bounds = valid_index.clone();
        out_of_bounds[4..12].copy_from_slice(&media_size.to_le_bytes());
        fs::write(&index_path, out_of_bounds).expect("write out-of-bounds offset");
        assert!(load_dictionary_specs(&root.0)
            .expect_err("out-of-bounds offset must fail")
            .contains("truncated path length header"));

        let mut unsorted = valid_index.clone();
        let first = unsorted[4..12].to_vec();
        let second = unsorted[12..20].to_vec();
        unsorted[4..12].copy_from_slice(&second);
        unsorted[12..20].copy_from_slice(&first);
        fs::write(&index_path, unsorted).expect("write unsorted offsets");
        assert!(load_dictionary_specs(&root.0)
            .expect_err("unsorted indexed paths must fail")
            .contains("paths are not sorted"));

        let mut media = fs::read(&media_path).expect("read media data");
        let second_offset = u64::from_le_bytes(valid_index[12..20].try_into().unwrap());
        media.insert(usize::try_from(second_offset).unwrap(), 0xff);
        let mut gapped_index = valid_index;
        gapped_index[12..20].copy_from_slice(&(second_offset + 1).to_le_bytes());
        fs::write(&media_path, media).expect("write gapped media data");
        fs::write(&index_path, gapped_index).expect("write gapped index");
        assert!(load_dictionary_specs(&root.0)
            .expect_err("non-contiguous media records must fail")
            .contains("non-contiguous"));
    }

    #[test]
    fn media_records_reject_truncated_headers_invalid_paths_and_blob_sizes() {
        let root = TestDir::new("media-record-corruption");
        let dictionary = media_dictionary(&root.0, &[("a", &[1])]);
        let media_path = dictionary.join("media.bin");

        fs::write(&media_path, [1, 0, b'a', 1, 0]).expect("write truncated blob header");
        assert!(load_dictionary_specs(&root.0)
            .expect_err("truncated blob header must fail")
            .contains("truncated path or blob length header"));

        fs::write(&media_path, [1, 0, 0xff, 1, 0, 0, 0, 1]).expect("write invalid UTF-8 path");
        assert!(load_dictionary_specs(&root.0)
            .expect_err("invalid UTF-8 path must fail")
            .contains("non-UTF-8 path"));

        let mut oversized_blob = vec![1, 0, b'a'];
        oversized_blob.extend_from_slice(
            &u32::try_from(MAX_MEDIA_BYTES + 1)
                .expect("oversized blob length")
                .to_le_bytes(),
        );
        fs::write(&media_path, oversized_blob).expect("write oversized blob header");
        assert!(load_dictionary_specs(&root.0)
            .expect_err("oversized blob must fail")
            .contains("invalid blob length"));
    }

    #[test]
    fn undeclared_native_media_files_are_rejected_before_loading() {
        let root = TestDir::new("undeclared-media");
        let dictionary = write_dictionary(&root.0, "Test", 1, 0);
        write_manifest(&root.0, "Test");
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
    fn dictionary_index_classifies_pitch_only_content() {
        let root = TestDir::new("pitch-only");
        let dictionary = write_dictionary_with_counts(&root.0, "dictionary", 0, &[("pitch", 1)], 0);

        let spec = validate_dictionary_directory(&dictionary).expect("pitch-only dictionary");
        assert!(!spec.has_terms);
        assert!(!spec.has_frequency);
        assert!(spec.has_pitch);
        assert!(!spec.has_kanji);
        assert_eq!(
            spec.query_kinds().collect::<Vec<_>>(),
            [DictionaryKind::Pitch]
        );

        let ipa_dictionary =
            write_dictionary_with_counts(&root.0, "ipa-dictionary", 0, &[("ipa", 1)], 0);
        let ipa_spec = validate_dictionary_directory(&ipa_dictionary).expect("IPA-only dictionary");
        assert!(ipa_spec.has_pitch);
    }

    #[test]
    fn dictionary_index_classifies_kanji_only_content() {
        let root = TestDir::new("kanji-only-index");
        let dictionary = write_dictionary_with_counts(&root.0, "dictionary", 0, &[], 1);

        let spec = validate_dictionary_directory(&dictionary).expect("kanji-only dictionary");
        assert!(!spec.has_terms);
        assert!(!spec.has_frequency);
        assert!(!spec.has_pitch);
        assert!(spec.has_kanji);
        assert_eq!(
            spec.query_kinds().collect::<Vec<_>>(),
            [DictionaryKind::Kanji]
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
        write_manifest(&root.0, "Test");
        set_dictionary_media_count(&dictionary, MAX_MEDIA_RECORDS + 1);

        assert!(load_dictionary_specs(&root.0)
            .expect_err("oversized declared media count must fail")
            .contains("record limit"));
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
        fs::write(
            root.0.join(MANIFEST_FILE_NAME),
            r#"{"version":1,"dictionaries":[{"id":"test","path":"Test Dictionary"},{"id":"frequency","path":"Standalone Frequency"}]}"#,
        )
        .expect("write manifest");

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
                        value: 123.5,
                        display_value: Some("123.5 ★".into()),
                    }],
                },
                LookupFrequencyEntry {
                    dictionary: "Standalone Frequency".into(),
                    frequencies: vec![LookupFrequency {
                        value: 22.5,
                        display_value: Some("22.5 rank".into()),
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
        assert_eq!((media.width, media.height), (2, 3));
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
    fn imported_hiragana_reading_matches_kana_and_kanji_variants() {
        let root = TestDir::new("kana-width");
        let archive_path = root.0.join("kana.zip");
        write_kana_lookup_archive(&archive_path);

        let report = import_dictionary(&archive_path, &root.0);
        assert!(report.success, "dictionary import failed: {}", report.error);
        assert_eq!(report.term_count, 1);
        fs::write(
            root.0.join(MANIFEST_FILE_NAME),
            r#"{"version":1,"dictionaries":[{"id":"kana","path":"Kana Lookup"}]}"#,
        )
        .expect("write manifest");

        let mut service = HoshidictsService::new(root.0.clone());
        assert_eq!(service.activate().expect("activate dictionary"), 1);
        for source in ["ワガハイ", "ﾜｶﾞﾊｲ", "ワガハイ", "わがはい", "我輩"] {
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
        let archive_path = root.0.join("kanji.zip");
        write_test_archive(&archive_path, false);
        let report = import_dictionary(&archive_path, &root.0);
        assert!(report.success);
        assert_eq!(report.term_count, 0);
        assert_eq!(report.kanji_count, 1);
        fs::write(
            root.0.join(MANIFEST_FILE_NAME),
            r#"{"version":1,"dictionaries":[{"id":"kanji","path":"Test Dictionary"}]}"#,
        )
        .expect("write manifest");

        let mut service = HoshidictsService::new(root.0.clone());
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
        let archive_path = root.0.join("JPDBv2㋕.zip");
        write_test_archive_with_title(&archive_path, "JPDBv2㋕", true);

        let report = import_dictionary(&archive_path, &root.0);
        assert!(report.success, "{}", report.error);
        assert_eq!(report.title, "JPDBv2㋕");
        fs::write(
            root.0.join(MANIFEST_FILE_NAME),
            r#"{"version":1,"dictionaries":[{"id":"jpdb","path":"JPDBv2㋕"}]}"#,
        )
        .expect("write manifest");

        let mut service = HoshidictsService::new(root.0.clone());
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
        let archive_path = root.0.join("duplicate-kanji.zip");
        write_test_archive_with_kanji_entries(
            &archive_path,
            "Duplicate Kanji",
            false,
            MAX_KANJI_ENTRIES + 1,
        );

        let report = import_dictionary(&archive_path, &root.0);
        assert!(report.success, "{}", report.error);
        fs::write(
            root.0.join(MANIFEST_FILE_NAME),
            r#"{"version":1,"dictionaries":[{"id":"bounded","path":"Duplicate Kanji"}]}"#,
        )
        .expect("write manifest");

        let mut service = HoshidictsService::new(root.0.clone());
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
}
