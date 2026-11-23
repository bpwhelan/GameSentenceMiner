//! Exact, insertion-ordered membership for the overlay's recycled-line indicator.
use crate::recycled_index::{Index, Key};
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyString};
use smallvec::{smallvec, SmallVec};
use std::collections::HashMap;

#[pyclass(module = "GameSentenceMiner._native")]
pub struct RecycledLines {
    index: Index,
    minimum: usize,
    // Pages are classified lazily with the *running interpreter's* Unicode tables.
    load_page: Py<PyAny>,
    ignored: HashMap<u32, [u8; 32]>,
}

impl RecycledLines {
    fn ignored(&mut self, py: Python<'_>, cp: u32) -> PyResult<bool> {
        if (0x4e00..=0x9fff).contains(&cp) {
            return Ok(false);
        }
        let page = cp >> 8;
        let bits = match self.ignored.entry(page) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                let mask = self.load_page.call1(py, (page,))?;
                let bytes = mask.cast_bound::<PyBytes>(py)?.as_bytes();
                entry.insert(bytes.try_into().map_err(|_| {
                    pyo3::exceptions::PyValueError::new_err("expected a 256-bit Unicode page")
                })?)
            }
        };
        Ok(bits[((cp & 255) >> 3) as usize] & (1 << (cp & 7)) != 0)
    }

    fn key(&mut self, text: &Bound<'_, PyString>) -> PyResult<Option<Key>> {
        // Both functions are stable ABI. The bound string stays alive and immutable.
        // UCS4 preserves lone surrogates and avoids pinning a second, UTF-8 copy
        // on long-lived Python GameLine strings. Small lines fit on the stack.
        let len = unsafe { pyo3::ffi::PyUnicode_GetLength(text.as_ptr()) };
        if len < 0 {
            return Err(PyErr::fetch(text.py()));
        }
        if (len as usize) < self.minimum {
            return Ok(None);
        }
        let mut chars: SmallVec<[u32; 80]> = smallvec![0; len as usize];
        // SAFETY: chars has room for len code points. copy_null=0 needs no terminator.
        if unsafe { pyo3::ffi::PyUnicode_AsUCS4(text.as_ptr(), chars.as_mut_ptr(), len, 0) }
            .is_null()
        {
            return Err(PyErr::fetch(text.py()));
        }
        let mut kept = 0;
        let mut largest = 0;
        for i in 0..chars.len() {
            let cp = chars[i];
            if !self.ignored(text.py(), cp)? {
                largest = largest.max(cp);
                chars[kept] = cp;
                kept += 1;
            }
        }
        if kept < self.minimum {
            return Ok(None);
        }
        // One, two or four bytes per retained scalar. A width tag makes the
        // representation injective even for embedded NUL and surrogate pairs.
        let width = if largest <= 0xff {
            1
        } else if largest <= 0xffff {
            2
        } else {
            4
        };
        let mut key = Key::with_capacity(1 + kept * width);
        key.push(width as u8);
        for &cp in &chars[..kept] {
            key.extend_from_slice(&cp.to_le_bytes()[..width]);
        }
        Ok(Some(key))
    }
}

#[pymethods]
impl RecycledLines {
    #[new]
    fn new(limit: usize, minimum: usize, load_page: Py<PyAny>) -> Self {
        Self {
            index: Index::new(limit),
            minimum,
            load_page,
            ignored: HashMap::new(),
        }
    }

    fn __len__(&self) -> usize {
        self.index.len()
    }

    fn __contains__(&mut self, text: &Bound<'_, PyString>) -> PyResult<bool> {
        if self.index.len() == 0 {
            return Ok(false);
        }
        let Some(key) = self.key(text)? else {
            return Ok(false);
        };
        Ok(self.index.contains(&key))
    }

    fn add(&mut self, text: &Bound<'_, PyString>) -> PyResult<()> {
        if let Some(key) = self.key(text)? {
            self.index.add(key);
        }
        Ok(())
    }
}
