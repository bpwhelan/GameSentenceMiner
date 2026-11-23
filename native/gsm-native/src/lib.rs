mod card_matching;
mod correlation;
mod dialogue_journal;
mod py_journal;
mod py_correlation;
mod recycled_index;
mod recycled_lines;
mod skip_detection;
mod layout;
mod overlay_coordinates;
mod overlay_filter;
mod overlay_geometry;
mod spatial_text;
mod text_cleanup;
mod text_filter;
mod text_matching;

use layout::LayoutInput;
use overlay_filter::OverlayFilterInput;
use pyo3::prelude::*;
use pyo3::pybacked::PyBackedStr;
use pyo3::types::PyDict;
use spatial_text::SpatialLineInput;
use std::path::PathBuf;

type PyBoundingBox = (f64, f64, f64, f64);
type PyLayoutLine = (String, PyBoundingBox, Vec<usize>);
type PyLayoutParagraph = (PyBoundingBox, String, Vec<PyLayoutLine>);
type PyOverlayFilterDecision = (usize, bool, Vec<usize>);

#[pyfunction]
fn save_layered_settings(py: Python<'_>, path: PathBuf, before: String, after: String) -> PyResult<()> {
    py.detach(move || {
        let before = serde_json::from_str(&before).map_err(|e| e.to_string())?;
        let after = serde_json::from_str(&after).map_err(|e| e.to_string())?;
        gsm_settings::profile_editor::save_standalone_edits(&path, &before, &after)
    }).map_err(pyo3::exceptions::PyRuntimeError::new_err)
}

#[pyfunction]
fn migrate_history_schema(py: Python<'_>, path: PathBuf, language: String) -> PyResult<()> {
    py.detach(move || gsm_db::migrate_file(&path, &language))
        .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))
}

type ImportRow = (String, i64, f64, String, String);

#[pyfunction]
fn configure_vocabulary_schema(py: Python<'_>, path: PathBuf, enabled: bool) -> PyResult<()> {
    py.detach(move || gsm_db::vocabulary::configure(&mut gsm_db::open_writer(&path)?, enabled))
        .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))
}

#[pyfunction]
fn compressed_history_snapshot(
    py: Python<'_>,
    source: PathBuf,
    destination: PathBuf,
) -> PyResult<()> {
    py.detach(move || gsm_db::backup::compressed_snapshot(&source, &destination))
        .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))
}

#[pyfunction]
fn history_snapshot(py: Python<'_>, source: PathBuf, destination: PathBuf) -> PyResult<()> {
    py.detach(move || gsm_db::backup::snapshot(&source, &destination))
        .map_err(|e| {
            if e.is::<gsm_db::backup::IntegrityError>() {
                let error = py.import("GameSentenceMiner.util.database.sqlite_core")
                    .and_then(|m| m.getattr("DatabaseIntegrityError"))
                    .and_then(|ty| ty.call1((e.to_string(),)));
                return error.map(PyErr::from_value).unwrap_or_else(|err| err);
            }
            pyo3::exceptions::PyRuntimeError::new_err(e.to_string())
        })
}

#[pyfunction]
fn import_reading_stats(
    py: Python<'_>,
    path: PathBuf,
    rows: Vec<ImportRow>,
    clear_source: Option<String>,
) -> PyResult<usize> {
    py.detach(move || {
        let entries = rows
            .into_iter()
            .map(
                |(date, characters, seconds, source, label)| gsm_db::imports::Entry {
                    date,
                    characters,
                    seconds,
                    source,
                    label,
                },
            )
            .collect::<Vec<_>>();
        gsm_db::imports::import_file(&path, clear_source.as_deref(), &entries)
    })
    .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))
}

#[pyfunction]
fn api_version() -> u32 {
    1
}

#[pyfunction]
fn rank_card_lines(
    py: Python<'_>,
    rows: &Bound<'_, PyAny>,
    sentence: (String, String, String),
    context: (String, Vec<(usize, usize)>, bool),
    prefer_recent: bool,
    minimum_score: f64,
) -> PyResult<Option<Py<PyAny>>> {
    let (sentence, punctuation, expression) = sentence;
    let (context, spans, bold) = context;
    let mut matcher = card_matching::Matcher::new(card_matching::Query {
        sentence,
        punctuation,
        expression,
        context,
        spans,
        bold,
        recent: prefer_recent,
        minimum: minimum_score,
    });
    let mut rows = rows.try_iter()?;
    // Bound conversion memory independently of history size and release the GIL for scoring.
    const BATCH_SIZE: usize = 8;
    let mut batch =
        Vec::<(Py<PyAny>, PyBackedStr, PyBackedStr, PyBackedStr)>::with_capacity(BATCH_SIZE);
    loop {
        for row in (&mut rows).take(BATCH_SIZE) {
            batch.push(row?.extract()?);
        }
        let last = batch.len() < BATCH_SIZE;
        if let Some(winner) = py.detach(|| {
            batch
                .drain(..)
                .find_map(|(original, id, line, punctuation)| {
                    matcher.observe(original, id, &line, &punctuation)
                })
        }) {
            return Ok(Some(winner));
        }
        if last {
            return Ok(py.detach(|| matcher.finish()));
        }
    }
}

#[pyfunction]
fn filter_ocr_text(
    py: Python<'_>,
    source_text: String,
    blocks: Vec<String>,
    language: String,
    previous_blocks: Vec<String>,
    historic_compare_blocks: Vec<String>,
) -> (String, Vec<String>, Vec<Option<String>>) {
    let output = py.detach(move || {
        text_filter::filter_text(
            &source_text,
            &blocks,
            &language,
            &previous_blocks,
            &historic_compare_blocks,
        )
    });
    (output.text, output.all_blocks, output.compare_blocks)
}

#[pyfunction]
#[pyo3(signature = (
    lines,
    image_width,
    image_height,
    language,
    furigana_filter,
    support_center_aligned_text,
    merge_close_paragraphs
))]
// Keep the Python boundary explicit and keyword-friendly. The pure Rust layout
// implementation stores these values in its internal engine configuration.
#[allow(clippy::too_many_arguments)]
fn order_ocr_layout(
    py: Python<'_>,
    lines: Vec<LayoutInput>,
    image_width: f64,
    image_height: f64,
    language: String,
    furigana_filter: bool,
    support_center_aligned_text: bool,
    merge_close_paragraphs: bool,
) -> Vec<PyLayoutParagraph> {
    let paragraphs = py.detach(move || {
        layout::order_layout(
            lines,
            image_width,
            image_height,
            &language,
            furigana_filter,
            support_center_aligned_text,
            merge_close_paragraphs,
        )
    });
    paragraphs
        .into_iter()
        .map(|paragraph| {
            let lines = paragraph
                .lines
                .into_iter()
                .map(|line| (line.text, line.bounding_box, line.source_ids))
                .collect();
            (paragraph.bounding_box, paragraph.writing_direction, lines)
        })
        .collect()
}

#[pyfunction]
#[pyo3(signature = (
    lines,
    same_axis_height_ratio=0.6,
    blank_line_height_ratio=2.0,
    blank_line_token=None
))]
fn build_spatial_text(
    py: Python<'_>,
    lines: Vec<SpatialLineInput>,
    same_axis_height_ratio: f64,
    blank_line_height_ratio: f64,
    blank_line_token: Option<String>,
) -> String {
    py.detach(move || {
        spatial_text::build_spatial_text(
            &lines,
            same_axis_height_ratio,
            blank_line_height_ratio,
            blank_line_token.as_deref(),
        )
    })
}

#[pyfunction]
fn filter_overlay_language(
    py: Python<'_>,
    lines: Vec<OverlayFilterInput>,
    language: String,
) -> Vec<PyOverlayFilterDecision> {
    py.detach(move || overlay_filter::filter_overlay_language(&language, lines))
        .into_iter()
        .map(|decision| {
            (
                decision.source_id,
                decision.use_words,
                decision.source_word_ids,
            )
        })
        .collect()
}

#[pyfunction]
fn matching_block_stats(
    py: Python<'_>,
    reference: String,
    candidate: String,
    min_block_size: usize,
) -> (f64, usize) {
    py.detach(move || {
        let metrics = text_matching::match_metrics(&reference, &candidate, min_block_size);
        let coverage = if metrics.candidate_len == 0 {
            0.0
        } else {
            metrics.covered as f64 / metrics.candidate_len as f64
        };
        (coverage, metrics.longest)
    })
}

#[pyfunction]
fn sequence_ratio(py: Python<'_>, reference: String, candidate: String) -> f64 {
    py.detach(move || {
        let metrics = text_matching::match_metrics(&reference, &candidate, 1);
        let total = metrics.reference_len + metrics.candidate_len;
        if total == 0 {
            1.0
        } else {
            2.0 * metrics.matched as f64 / total as f64
        }
    })
}

#[pyfunction]
fn remove_repeated_chars(
    py: Python<'_>,
    text: String,
    repeat_count: i64,
    keep_non_repeated: bool,
) -> String {
    py.detach(move || text_cleanup::remove_repeated_chars(&text, repeat_count, keep_non_repeated))
}

#[pyfunction]
fn remove_repeated_lines(py: Python<'_>, text: String, repeat_count: i64) -> String {
    py.detach(move || text_cleanup::remove_repeated_lines(&text, repeat_count))
}

#[pyfunction]
fn count_kanji(py: Python<'_>, texts: Vec<String>) -> PyResult<Bound<'_, PyDict>> {
    let counts = py.detach(move || text_cleanup::count_kanji(&texts));
    let result = PyDict::new(py);
    for (character, count) in counts {
        result.set_item(character, count)?;
    }
    Ok(result)
}

#[pyfunction]
#[pyo3(signature = (url, destination, sha256=None, *, limit=gsm_downloads::MAX_BYTES, progress=None))]
fn download_file(
    py: Python<'_>,
    url: String,
    destination: PathBuf,
    sha256: Option<String>,
    limit: u64,
    progress: Option<Py<PyAny>>,
) -> PyResult<()> {
    py.detach(|| {
        gsm_downloads::download(
            &url,
            &destination,
            sha256.as_deref(),
            limit,
            &|done, total| {
                if let Some(callback) = &progress {
                    Python::attach(|py| {
                        if let Err(error) = callback.call1(py, (done, total)) {
                            error.write_unraisable(py, Some(callback.bind(py)));
                        }
                    });
                }
            },
        )
    })
    .map_err(pyo3::exceptions::PyOSError::new_err)
}

#[pyfunction]
fn ensure_download_asset(
    py: Python<'_>,
    cache: PathBuf,
    id: String,
    bundled: Option<PathBuf>,
) -> PyResult<PathBuf> {
    py.detach(|| gsm_downloads::ensure_asset(&cache, &id, bundled.as_deref()))
        .map_err(pyo3::exceptions::PyOSError::new_err)
}

#[pyfunction]
fn cached_download_asset(cache: PathBuf, id: String) -> Option<PathBuf> {
    gsm_downloads::cached_asset(&cache, &id, None)
}

#[pymodule]
fn _native(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_function(wrap_pyfunction!(save_layered_settings, module)?)?;
    module.add_function(wrap_pyfunction!(rank_card_lines, module)?)?;
    module.add_function(wrap_pyfunction!(py_correlation::classify_dialogue, module)?)?;
    module.add_class::<py_correlation::DialogueSkipDetector>()?;
    module.add_class::<py_journal::DialogueJournal>()?;
    module.add_class::<recycled_lines::RecycledLines>()?;
    module.add_function(wrap_pyfunction!(py_correlation::compact_dialogue, module)?)?;
    module.add_function(wrap_pyfunction!(download_file, module)?)?;
    module.add_function(wrap_pyfunction!(ensure_download_asset, module)?)?;
    module.add_function(wrap_pyfunction!(cached_download_asset, module)?)?;
    module.add_function(wrap_pyfunction!(migrate_history_schema, module)?)?;
    module.add_function(wrap_pyfunction!(configure_vocabulary_schema, module)?)?;
    module.add_function(wrap_pyfunction!(import_reading_stats, module)?)?;
    module.add_function(wrap_pyfunction!(compressed_history_snapshot, module)?)?;
    module.add_function(wrap_pyfunction!(history_snapshot, module)?)?;
    module.add_function(wrap_pyfunction!(api_version, module)?)?;
    module.add_function(wrap_pyfunction!(filter_ocr_text, module)?)?;
    module.add_function(wrap_pyfunction!(order_ocr_layout, module)?)?;
    module.add_function(wrap_pyfunction!(build_spatial_text, module)?)?;
    module.add_function(wrap_pyfunction!(filter_overlay_language, module)?)?;
    module.add_function(wrap_pyfunction!(matching_block_stats, module)?)?;
    module.add_function(wrap_pyfunction!(sequence_ratio, module)?)?;
    module.add_function(wrap_pyfunction!(remove_repeated_chars, module)?)?;
    module.add_function(wrap_pyfunction!(remove_repeated_lines, module)?)?;
    module.add_function(wrap_pyfunction!(count_kanji, module)?)?;
    module.add_function(wrap_pyfunction!(
        overlay_coordinates::project_overlay_coordinates,
        module
    )?)?;
    module.add_function(wrap_pyfunction!(
        overlay_coordinates::copy_overlay_payload,
        module
    )?)?;
    module.add_function(wrap_pyfunction!(
        overlay_geometry::filter_overlay_minimum_size,
        module
    )?)?;
    module.add_function(wrap_pyfunction!(
        overlay_geometry::filter_overlay_exclusions,
        module
    )?)?;
    Ok(())
}
