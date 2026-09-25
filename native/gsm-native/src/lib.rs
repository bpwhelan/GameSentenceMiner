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
use pyo3::types::PyDict;
use spatial_text::SpatialLineInput;

type PyBoundingBox = (f64, f64, f64, f64);
type PyLayoutLine = (String, PyBoundingBox, Vec<usize>);
type PyLayoutParagraph = (PyBoundingBox, String, Vec<PyLayoutLine>);
type PyOverlayFilterDecision = (usize, bool, Vec<usize>);

#[pyfunction]
fn api_version() -> u32 {
    1
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

#[pymodule]
fn _native(module: &Bound<'_, PyModule>) -> PyResult<()> {
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
