//! Projection of overlay boxes at the Python boundary. Keep the arithmetic in
//! the same order as the reference: cancelling the monitor origin algebraically
//! changes the low bits of coordinates, especially on secondary monitors.
use std::collections::{HashMap, HashSet};

use pyo3::exceptions::{PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyDict, PyFloat, PyInt, PyList, PyString};

type Axis = (f64, f64, f64, f64);

#[derive(Clone, Copy)]
enum Kind {
    OneOcr,
    Source,
    Absolute,
}

fn unsupported() -> PyErr {
    PyTypeError::new_err("Overlay payload requires the Python reference path")
}

fn exact_dict<'py>(value: &Bound<'py, PyAny>) -> PyResult<Bound<'py, PyDict>> {
    if !value.is_exact_instance_of::<PyDict>() {
        return Err(unsupported());
    }
    Ok(value.cast::<PyDict>()?.clone())
}

fn exact_list<'py>(value: &Bound<'py, PyAny>) -> PyResult<Bound<'py, PyList>> {
    if !value.is_exact_instance_of::<PyList>() {
        return Err(unsupported());
    }
    Ok(value.cast::<PyList>()?.clone())
}

fn is_number(value: &Bound<'_, PyAny>) -> bool {
    value.is_exact_instance_of::<PyFloat>()
        || value.is_exact_instance_of::<PyInt>()
        || value.is_exact_instance_of::<PyBool>()
}

pub(super) fn is_builtin_payload(value: &Bound<'_, PyAny>) -> bool {
    fn visit(value: &Bound<'_, PyAny>, seen: &mut HashSet<usize>, depth: usize) -> bool {
        if value.is_none() || is_number(value) || value.is_exact_instance_of::<PyString>() {
            return true;
        }
        if !seen.insert(value.as_ptr() as usize) {
            return true;
        }
        if depth > 64 {
            return false;
        }
        if value.is_exact_instance_of::<PyDict>() {
            return value.cast::<PyDict>().is_ok_and(|dict| {
                dict.iter().all(|(key, item)| {
                    (key.is_none() || is_number(&key) || key.is_exact_instance_of::<PyString>())
                        && visit(&item, seen, depth + 1)
                })
            });
        }
        if value.is_exact_instance_of::<PyList>() {
            return value
                .cast::<PyList>()
                .is_ok_and(|list| list.iter().all(|item| visit(&item, seen, depth + 1)));
        }
        false
    }
    visit(value, &mut HashSet::new(), 0)
}

fn project(value: f64, (scale, offset, origin, divisor): Axis, kind: Kind) -> f64 {
    match kind {
        Kind::Absolute => ((value + offset) - origin) / divisor,
        Kind::Source | Kind::OneOcr => (((value * scale) + offset + origin) - origin) / divisor,
    }
}

// JSON-shaped metadata is copied without round-tripping through serialization.
// A fresh memo per line matches deepcopy(line['words']), including shared boxes
// and cyclic metadata. Custom objects/subclasses use Python's deepcopy instead.
fn copy_value<'py>(
    py: Python<'py>,
    value: &Bound<'py, PyAny>,
    memo: &mut HashMap<usize, Bound<'py, PyAny>>,
    depth: usize,
) -> PyResult<Bound<'py, PyAny>> {
    if value.is_none() || is_number(value) || value.is_exact_instance_of::<PyString>() {
        return Ok(value.clone());
    }
    let id = value.as_ptr() as usize;
    if let Some(copy) = memo.get(&id) {
        return Ok(copy.clone());
    }
    if depth > 64 {
        return Err(unsupported());
    }
    if value.is_exact_instance_of::<PyDict>() {
        let output = PyDict::new(py);
        memo.insert(id, output.clone().into_any());
        for (key, item) in value.cast::<PyDict>()?.iter() {
            // Only immutable built-in keys can be shared with the input.
            if !(key.is_none() || is_number(&key) || key.is_exact_instance_of::<PyString>()) {
                return Err(unsupported());
            }
            output.set_item(key, copy_value(py, &item, memo, depth + 1)?)?;
        }
        return Ok(output.into_any());
    }
    if value.is_exact_instance_of::<PyList>() {
        let output = PyList::empty(py);
        memo.insert(id, output.clone().into_any());
        for item in value.cast::<PyList>()?.iter() {
            output.append(copy_value(py, &item, memo, depth + 1)?)?;
        }
        return Ok(output.into_any());
    }
    Err(unsupported())
}

struct BoxUpdate<'py> {
    target: Bound<'py, PyDict>,
    values: Vec<(Bound<'py, PyAny>, f64)>,
}

struct PreparedProjection<'py> {
    output: Bound<'py, PyList>,
    boxes: Vec<BoxUpdate<'py>>,
    texts: Vec<(Bound<'py, PyDict>, String)>,
}

fn box_update<'py>(
    py: Python<'py>,
    target: Bound<'py, PyDict>,
    kind: Kind,
    x_axis: Axis,
    y_axis: Axis,
) -> PyResult<BoxUpdate<'py>> {
    let mut values = Vec::with_capacity(target.len());
    for (key, value) in target.iter() {
        if !key.is_exact_instance_of::<PyString>() {
            return Err(unsupported());
        }
        let axis = if key.cast::<PyString>()?.to_str()?.contains('x') {
            x_axis
        } else {
            y_axis
        };
        let number = if is_number(&value) {
            value.extract::<f64>()?
        } else if matches!(kind, Kind::OneOcr) {
            return Err(unsupported());
        } else if value.is_exact_instance_of::<PyString>() {
            // Python float parsing accepts forms Rust's parser doesn't (e.g.
            // underscores and Unicode digits). Use it only for string values.
            match py.get_type::<PyFloat>().call1((&value,)) {
                Ok(number) => number.extract::<f64>()?,
                Err(error) if error.is_instance_of::<PyValueError>(py) => 0.0,
                Err(error) => return Err(error),
            }
        } else if value.is_none() {
            0.0
        } else {
            return Err(unsupported());
        };
        values.push((key, project(number, axis, kind)));
    }
    Ok(BoxUpdate { target, values })
}

fn apply(update: BoxUpdate<'_>) -> PyResult<()> {
    for (key, value) in update.values {
        update.target.set_item(key, value)?;
    }
    Ok(())
}

fn prepare_in_place<'py>(
    py: Python<'py>,
    lines: &Bound<'py, PyList>,
    x_axis: Axis,
    y_axis: Axis,
    append_space: bool,
) -> PyResult<PreparedProjection<'py>> {
    let output = PyList::empty(py);
    let mut boxes = Vec::new();
    let mut texts = Vec::new();
    let mut seen = HashSet::new();
    // Validate the *entire* frame before changing any caller-owned object, so
    // an unsupported late word can safely fall back without double projection.
    for line in lines.iter() {
        let line = exact_dict(&line)?;
        let Some(bbox) = line.get_item("bounding_rect")? else {
            continue;
        };
        let bbox = exact_dict(&bbox)?;
        if bbox.is_empty() {
            continue;
        }
        if !seen.insert(bbox.as_ptr() as usize) {
            return Err(unsupported());
        }
        boxes.push(box_update(py, bbox, Kind::OneOcr, x_axis, y_axis)?);
        output.append(&line)?;
        if let Some(words) = line.get_item("words")? {
            for word in exact_list(&words)?.iter() {
                let word = exact_dict(&word)?;
                if append_space {
                    if !seen.insert(word.as_ptr() as usize) {
                        return Err(unsupported());
                    }
                    let text = word.get_item("text")?.ok_or_else(unsupported)?;
                    if !text.is_exact_instance_of::<PyString>() {
                        return Err(unsupported());
                    }
                    texts.push((
                        word.clone(),
                        format!("{} ", text.cast::<PyString>()?.to_str()?),
                    ));
                }
                if let Some(bbox) = word.get_item("bounding_rect")? {
                    let bbox = exact_dict(&bbox)?;
                    if !bbox.is_empty() {
                        if !seen.insert(bbox.as_ptr() as usize) {
                            return Err(unsupported());
                        }
                        boxes.push(box_update(py, bbox, Kind::OneOcr, x_axis, y_axis)?);
                    }
                }
            }
        }
    }
    Ok(PreparedProjection {
        output,
        boxes,
        texts,
    })
}

fn project_copy<'py>(
    py: Python<'py>,
    lines: &Bound<'py, PyList>,
    kind: Kind,
    x_axis: Axis,
    y_axis: Axis,
) -> PyResult<Bound<'py, PyList>> {
    let output = PyList::empty(py);
    for line in lines.iter() {
        let line = exact_dict(&line)?;
        let Some(bbox) = line.get_item("bounding_rect")? else {
            continue;
        };
        let bbox = exact_dict(&bbox)?;
        if bbox.is_empty() {
            continue;
        }
        let bbox = bbox.copy()?;
        let words = match line.get_item("words")? {
            Some(words) => copy_value(py, &words, &mut HashMap::new(), 0)?,
            None => PyList::empty(py).into_any(),
        };
        let words = exact_list(&words)?;
        let copy = PyDict::new(py);
        copy.set_item(
            "text",
            line.get_item("text")?
                .unwrap_or_else(|| PyString::new(py, "").into_any()),
        )?;
        copy.set_item("bounding_rect", &bbox)?;
        copy.set_item("words", &words)?;
        apply(box_update(py, bbox, kind, x_axis, y_axis)?)?;
        for word in words.iter() {
            if let Some(bbox) = exact_dict(&word)?.get_item("bounding_rect")? {
                apply(box_update(py, exact_dict(&bbox)?, kind, x_axis, y_axis)?)?;
            }
        }
        output.append(copy)?;
    }
    Ok(output)
}

#[pyfunction]
pub fn project_overlay_coordinates<'py>(
    py: Python<'py>,
    lines: &Bound<'py, PyList>,
    kind: &str,
    x_axis: Axis,
    y_axis: Axis,
    append_space: bool,
) -> PyResult<Option<Bound<'py, PyList>>> {
    let kind = match kind {
        "oneocr" => Kind::OneOcr,
        "source" => Kind::Source,
        "absolute" => Kind::Absolute,
        _ => return Err(PyValueError::new_err("Unknown overlay projection kind")),
    };
    if x_axis.3 == 0.0 || y_axis.3 == 0.0 || !lines.is_exact_instance_of::<PyList>() {
        return Ok(None);
    }
    if matches!(kind, Kind::OneOcr) {
        let Ok(prepared) = prepare_in_place(py, lines, x_axis, y_axis, append_space) else {
            return Ok(None);
        };
        for update in prepared.boxes {
            apply(update)?;
        }
        for (word, text) in prepared.texts {
            word.set_item("text", text)?;
        }
        Ok(Some(prepared.output))
    } else {
        // Copy-mode errors leave caller-owned objects untouched as well.
        Ok(project_copy(py, lines, kind, x_axis, y_axis).ok())
    }
}

#[pyfunction]
pub fn copy_overlay_payload<'py>(
    py: Python<'py>,
    value: &Bound<'py, PyAny>,
) -> Option<Bound<'py, PyAny>> {
    copy_value(py, value, &mut HashMap::new(), 0).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_preserves_rounding_at_large_monitor_origins() {
        let value = 1.0 / 7.0;
        let axis = (1.0 / 0.73, -13.25, 1e12, 1920.0);
        let expected = (((value * axis.0) + axis.1 + axis.2) - axis.2) / axis.3;
        assert_eq!(
            project(value, axis, Kind::Source).to_bits(),
            expected.to_bits()
        );
        assert_ne!(
            expected.to_bits(),
            ((value * axis.0 + axis.1) / axis.3).to_bits()
        );
    }
}
