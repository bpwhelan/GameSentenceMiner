use crate::dialogue_journal::{Journal, Stats};
use pyo3::exceptions::PyValueError;
use pyo3::gc::{PyTraverseError, PyVisit};
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyInt, PyList, PyString, PyTuple};
use smallvec::SmallVec;
use std::borrow::Cow;

// Legacy adapters can deliver unpaired UTF-16 surrogates in IDs, instances or
// scenes. Surrogate-pass UTF-8 is injective and ordinary strings stay borrowed.
fn bytes<'a>(value: &'a Bound<'_, PyString>) -> PyResult<Cow<'a, [u8]>> {
    match value.to_str() {
        Ok(s) => Ok(Cow::Borrowed(s.as_bytes())),
        Err(_) => {
            let encoded = value.call_method1(
                pyo3::intern!(value.py(), "encode"),
                ("utf-8", "surrogatepass"),
            )?;
            Ok(Cow::Owned(encoded.cast::<PyBytes>()?.as_bytes().to_vec()))
        }
    }
}

type KeyFields<'a, 'py> = (&'a str, Bound<'py, PyString>, bool, Bound<'py, PyString>);
type ShortKey = SmallVec<[u8; 24]>;
type SourceKey = (ShortKey, ShortKey, bool, ShortKey);
type Context = (
    u64,
    bool,
    Option<Py<PyAny>>,
    Option<Py<PyAny>>,
    Option<Py<PyTuple>>,
);

fn source_key((kind, instance, relay, scene): KeyFields<'_, '_>) -> PyResult<SourceKey> {
    Ok((
        kind.as_bytes().into(),
        bytes(&instance)?.as_ref().into(),
        relay,
        bytes(&scene)?.as_ref().into(),
    ))
}

struct Row {
    projection: Py<PyAny>,
    can_expire: bool,
}

fn selected<'py, 'r>(
    py: Python<'py>,
    rows: impl Iterator<Item = &'r Row>,
) -> PyResult<Bound<'py, PyList>> {
    let result = PyList::empty(py);
    for row in rows {
        result.append(row.projection.bind(py))?;
    }
    Ok(result)
}

#[pyclass(module = "GameSentenceMiner._native")]
pub struct DialogueJournal {
    log: Journal<Row, SourceKey, Py<PyTuple>>,
    snapshot_rows: Option<Py<PyTuple>>,
}

#[pymethods]
impl DialogueJournal {
    #[new]
    fn new() -> Self {
        Self {
            log: Journal::new(),
            snapshot_rows: None,
        }
    }

    fn observe(&mut self, id: &Bound<'_, PyString>, capacity: &Bound<'_, PyInt>) -> PyResult<bool> {
        let limit = match capacity.extract::<usize>() {
            Ok(n) => n,
            Err(_) if capacity.gt(usize::MAX)? => usize::MAX,
            Err(_) => return Err(PyValueError::new_err("negative observation capacity")),
        };
        Ok(self.log.observe(&bytes(id)?, limit))
    }

    fn latest(&self, py: Python<'_>) -> Option<Py<PyAny>> {
        self.log.latest().map(|r| r.projection.clone_ref(py))
    }

    fn get(&self, py: Python<'_>, id: Option<&Bound<'_, PyString>>) -> PyResult<Option<Py<PyAny>>> {
        Ok(match id {
            Some(id) => self
                .log
                .get(&bytes(id)?)
                .map(|r| r.projection.clone_ref(py)),
            None => None,
        })
    }

    #[pyo3(signature=(open_id, key))]
    fn context(
        &self,
        py: Python<'_>,
        open_id: Option<&Bound<'_, PyString>>,
        key: Option<KeyFields<'_, '_>>,
    ) -> PyResult<Context> {
        let previous = match key {
            Some(key) => self.log.prefix(&source_key(key)?).map(|p| p.clone_ref(py)),
            None => None,
        };
        Ok((
            self.log.sequence(),
            self.log.has_pending(),
            self.latest(py),
            self.get(py, open_id)?,
            previous,
        ))
    }

    #[pyo3(signature=(id, projection, append, lifecycle, source))]
    fn publish(
        &mut self,
        id: &Bound<'_, PyString>,
        projection: Py<PyAny>,
        append: bool,
        lifecycle: (bool, &str, Option<i128>),
        source: Option<(KeyFields<'_, '_>, Py<PyTuple>)>,
    ) -> PyResult<()> {
        let (frozen, stats, observed_ns) = lifecycle;
        let source = match source {
            Some((key, previous)) => Some((source_key(key)?, previous)),
            None => None,
        };
        let row = Row {
            projection,
            can_expire: frozen && !matches!(stats, "pending" | "pending_manual"),
        };
        self.log
            .publish(
                &bytes(id)?,
                row,
                append,
                source,
                Stats {
                    frozen,
                    status: stats,
                    observed_ns,
                },
            )
            .map_err(PyValueError::new_err)?;
        self.snapshot_rows = None;
        Ok(())
    }

    fn pending<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
        selected(py, self.log.pending())
    }

    fn ready<'py>(
        &self,
        py: Python<'py>,
        now_ns: i128,
        window_ns: i128,
    ) -> PyResult<Bound<'py, PyList>> {
        selected(py, self.log.ready(now_ns.saturating_sub(window_ns)))
    }

    fn for_exclusion<'py>(&self, py: Python<'py>, confirmed: bool) -> PyResult<Bound<'py, PyList>> {
        selected(py, self.log.for_exclusion(confirmed))
    }

    #[pyo3(signature=(max_records=None))]
    fn snapshot(
        &mut self,
        py: Python<'_>,
        max_records: Option<usize>,
    ) -> PyResult<(u64, Py<PyTuple>)> {
        let len = self.log.rows().len();
        if let Some(limit) = max_records.filter(|limit| *limit < len) {
            let rows = match &self.snapshot_rows {
                Some(cached) => cached.bind(py).get_slice(len - limit, len),
                None => {
                    let newest: Vec<_> = self
                        .log
                        .rows()
                        .rev()
                        .take(limit)
                        .map(|r| r.projection.bind(py))
                        .collect();
                    PyTuple::new(py, newest.into_iter().rev())?
                }
            };
            return Ok((self.log.sequence(), rows.unbind()));
        }
        let rows = match &self.snapshot_rows {
            Some(cached) => cached.clone_ref(py),
            None => {
                let rows =
                    PyTuple::new(py, self.log.rows().map(|r| r.projection.bind(py)))?.unbind();
                self.snapshot_rows = Some(rows.clone_ref(py));
                rows
            }
        };
        Ok((self.log.sequence(), rows))
    }

    fn expire<'py>(&mut self, cutoff: &Bound<'py, PyAny>) -> PyResult<Bound<'py, PyTuple>> {
        let py = cutoff.py();
        let expired = self.log.expire(|row| {
            if !row.can_expire {
                return Ok(false);
            }
            row.projection
                .bind(py)
                .getattr(pyo3::intern!(py, "first_seen_at_utc"))?
                .lt(cutoff)
        })?;
        if !expired.is_empty() {
            self.snapshot_rows = None;
        }
        PyTuple::new(py, expired.into_iter().map(|r| r.projection))
    }

    fn __traverse__(&self, visit: PyVisit<'_>) -> Result<(), PyTraverseError> {
        if let Some(rows) = &self.snapshot_rows {
            visit.call(rows)?;
        }
        for row in self.log.rows() {
            visit.call(&row.projection)?;
        }
        for source in self.log.prefixes() {
            visit.call(source)?;
        }
        Ok(())
    }

    fn __clear__(&mut self) {
        *self = Self::new();
    }
}
