//! Batched geometry decisions: decode each box once instead of once per region.
//! Source indexes let the facade preserve metadata and deepcopy alias semantics.
use pyo3::exceptions::PyTypeError;
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyDict, PyFloat, PyInt, PyList, PyString};

use crate::overlay_coordinates::is_builtin_payload;

type Decision = (usize, Option<Vec<usize>>);

#[derive(Clone, Copy)]
struct Rect {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

impl Rect {
    fn overlaps(self, other: Self) -> bool {
        let left = self.left.max(other.left);
        let top = self.top.max(other.top);
        let right = self.right.min(other.right);
        let bottom = self.bottom.min(other.bottom);
        if left >= right || top >= bottom {
            return false;
        }
        let intersection = (right - left) * (bottom - top);
        let area = (self.right - self.left) * (self.bottom - self.top);
        area > 0.0 && intersection / area >= 0.5
    }
}

fn unsupported() -> PyErr {
    PyTypeError::new_err("Overlay geometry requires the Python reference path")
}

fn number(
    py: Python<'_>,
    dict: &Bound<'_, PyDict>,
    key: &str,
    empty_is_zero: bool,
) -> PyResult<f64> {
    let Some(value) = dict.get_item(key)? else {
        return Ok(0.0);
    };
    let number = if value.is_exact_instance_of::<PyFloat>()
        || value.is_exact_instance_of::<PyInt>()
        || value.is_exact_instance_of::<PyBool>()
    {
        value.extract::<f64>()?
    } else if value.is_exact_instance_of::<PyString>() {
        if empty_is_zero && value.cast::<PyString>()?.is_empty()? {
            0.0
        } else {
            py.get_type::<PyFloat>()
                .call1((&value,))?
                .extract::<f64>()?
        }
    } else if empty_is_zero && value.is_none() {
        0.0
    } else {
        return Err(unsupported());
    };
    // Python's ordered min/max has different NaN handling from f64::min/max.
    if number.is_finite() {
        Ok(number)
    } else {
        Err(unsupported())
    }
}

fn exact_dict<'py>(value: &Bound<'py, PyAny>) -> PyResult<Bound<'py, PyDict>> {
    if !value.is_exact_instance_of::<PyDict>() {
        return Err(unsupported());
    }
    Ok(value.cast::<PyDict>()?.clone())
}

fn bounding_box<'py>(item: &Bound<'py, PyDict>) -> PyResult<Option<Bound<'py, PyDict>>> {
    let Some(value) = item.get_item("bounding_rect")? else {
        return Ok(None);
    };
    if value.is_none() {
        return Ok(None);
    }
    let dict = exact_dict(&value)?;
    Ok((!dict.is_empty()).then_some(dict))
}

fn overlap_rect(py: Python<'_>, dict: &Bound<'_, PyDict>) -> PyResult<Rect> {
    let x1 = number(py, dict, "x1", false)?;
    let x3 = number(py, dict, "x3", false)?;
    let y1 = number(py, dict, "y1", false)?;
    let y3 = number(py, dict, "y3", false)?;
    Ok(Rect {
        left: x1.min(x3),
        right: x1.max(x3),
        top: y1.min(y3),
        bottom: y1.max(y3),
    })
}

enum Filter {
    MinimumSize(f64),
    Exclusions(Vec<Rect>),
}

impl Filter {
    fn keeps(&self, py: Python<'_>, item: &Bound<'_, PyDict>) -> PyResult<bool> {
        let bbox = bounding_box(item)?;
        match self {
            Self::Exclusions(regions) => {
                let Some(bbox) = bbox else {
                    return Ok(true);
                };
                let rect = overlap_rect(py, &bbox)?;
                Ok(!regions.iter().any(|region| rect.overlaps(*region)))
            }
            Self::MinimumSize(minimum) => {
                let Some(bbox) = bbox else {
                    return Ok(false);
                };
                let mut xs = [0.0; 4];
                let mut ys = [0.0; 4];
                for (i, (x, y)) in [("x1", "y1"), ("x2", "y2"), ("x3", "y3"), ("x4", "y4")]
                    .iter()
                    .enumerate()
                {
                    xs[i] = number(py, &bbox, x, true)?;
                    ys[i] = number(py, &bbox, y, true)?;
                }
                let width = xs.into_iter().fold(f64::NEG_INFINITY, f64::max)
                    - xs.into_iter().fold(f64::INFINITY, f64::min);
                let height = ys.into_iter().fold(f64::NEG_INFINITY, f64::max)
                    - ys.into_iter().fold(f64::INFINITY, f64::min);
                Ok(width > *minimum && height > *minimum)
            }
        }
    }
}

fn filter_lines(
    py: Python<'_>,
    lines: &Bound<'_, PyList>,
    filter: Filter,
) -> PyResult<Vec<Decision>> {
    if !is_builtin_payload(lines.as_any()) {
        return Err(unsupported());
    }
    let mut output = Vec::with_capacity(lines.len());
    for (line_id, line) in lines.iter().enumerate() {
        if !line.is_instance_of::<PyDict>() {
            continue;
        }
        let line = exact_dict(&line)?;
        if let Some(words) = line.get_item("words")? {
            if words.is_instance_of::<PyList>() {
                if !words.is_exact_instance_of::<PyList>() {
                    return Err(unsupported());
                }
                let words = words.cast::<PyList>()?;
                if !words.is_empty() {
                    let mut kept = Vec::with_capacity(words.len());
                    for (word_id, word) in words.iter().enumerate() {
                        if word.is_instance_of::<PyDict>()
                            && filter.keeps(py, &exact_dict(&word)?)?
                        {
                            kept.push(word_id);
                        }
                    }
                    if !kept.is_empty() {
                        output.push((line_id, Some(kept)));
                    }
                    continue;
                }
            }
        }
        if filter.keeps(py, &line)? {
            output.push((line_id, None));
        }
    }
    Ok(output)
}

#[pyfunction]
pub fn filter_overlay_minimum_size(
    py: Python<'_>,
    lines: &Bound<'_, PyList>,
    minimum: &Bound<'_, PyAny>,
) -> Option<Vec<Decision>> {
    let minimum = if minimum.is_exact_instance_of::<PyInt>() {
        let value = minimum.extract::<i64>().ok()?;
        // Python compares float widths to large integers without rounding the
        // integer to f64 first. Leave that uncommon case to the reference.
        if value.unsigned_abs() > (1_u64 << 53) {
            return None;
        }
        value as f64
    } else if minimum.is_exact_instance_of::<PyFloat>() || minimum.is_exact_instance_of::<PyBool>()
    {
        minimum.extract::<f64>().ok()?
    } else {
        return None;
    };
    if !(minimum > 0.0 && minimum.is_finite()) {
        return None;
    }
    filter_lines(py, lines, Filter::MinimumSize(minimum)).ok()
}

#[pyfunction]
pub fn filter_overlay_exclusions(
    py: Python<'_>,
    lines: &Bound<'_, PyList>,
    regions: &Bound<'_, PyList>,
) -> Option<Vec<Decision>> {
    if !regions.is_exact_instance_of::<PyList>() {
        return None;
    }
    let rects = regions
        .iter()
        .map(|region| overlap_rect(py, &exact_dict(&region)?))
        .collect::<PyResult<Vec<_>>>()
        .ok()?;
    filter_lines(py, lines, Filter::Exclusions(rects)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlaps_at_half_coverage_but_not_at_a_shared_edge() {
        let source = Rect {
            left: 0.0,
            top: 0.0,
            right: 10.0,
            bottom: 10.0,
        };
        assert!(source.overlaps(Rect {
            left: 5.0,
            ..source
        }));
        assert!(!source.overlaps(Rect {
            left: 5.000000001,
            ..source
        }));
        assert!(!source.overlaps(Rect {
            left: 10.0,
            right: 20.0,
            ..source
        }));
    }
}
