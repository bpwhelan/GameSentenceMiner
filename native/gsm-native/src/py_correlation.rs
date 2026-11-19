use crate::correlation::{classify, Incoming, Line, Windows};
use crate::skip_detection::{simple_text, Detector};
use pyo3::prelude::*;
use pyo3::types::{PyString, PyStringMethods};

#[pyfunction]
pub fn compact_dialogue(text: &Bound<'_, PyString>) -> Option<String> {
    text.to_str().ok().and_then(simple_text)
}

#[pyclass(module = "GameSentenceMiner._native")]
pub struct DialogueSkipDetector(Detector);

#[pymethods]
impl DialogueSkipDetector {
    #[new]
    fn new() -> Self {
        Self(Detector::default())
    }

    fn observe(
        &mut self,
        kind: &str,
        instance: &[u8],
        text: &Bound<'_, PyString>,
        now: i128,
        control: bool,
        compacted: bool,
    ) -> PyResult<Option<(bool, bool, bool)>> {
        let value = if compacted {
            text.to_str()?.to_owned()
        } else {
            let Some(value) = text.to_str().ok().and_then(simple_text) else {
                return Ok(None);
            };
            value
        };
        let added = self.0.observe(kind, instance, value, now, control);
        Ok(Some((added, self.0.suspended, self.0.confirmed)))
    }

    fn quiet(&self, now: i128) -> bool {
        self.0.quiet(now)
    }
    #[getter]
    fn reason(&self) -> &'static str {
        self.0.reason
    }
    #[getter]
    fn quiet_ns(&self) -> i128 {
        self.0.quiet_ns
    }
    fn reset(&mut self) {
        self.0 = Detector::default();
    }
}

type IncomingFields<'a> = (
    &'a str,
    &'a str,
    &'a str,
    &'a str,
    i64,
    bool,
    bool,
    bool,
    bool,
    bool,
);
type LineFields<'a> = (&'a str, &'a str, &'a str, &'a str, i64, bool, bool, bool);

fn line(fields: LineFields<'_>) -> Line<'_> {
    let (text, source, instance, scene, first_ns, relay, frozen, skipped) = fields;
    Line {
        text,
        source,
        instance,
        scene,
        first_ns,
        relay,
        frozen,
        skipped,
    }
}

#[pyfunction]
#[pyo3(signature=(incoming, newest, open, previous, deadline_ns, windows))]
pub fn classify_dialogue(
    py: Python<'_>,
    incoming: IncomingFields<'_>,
    newest: Option<LineFields<'_>>,
    open: Option<LineFields<'_>>,
    previous: Option<(&str, bool)>,
    deadline_ns: Option<i64>,
    windows: (i64, i64, f64),
) -> (&'static str, &'static str, Option<String>) {
    let (text, source, instance, scene, now_ns, relay, prefix, merge, final_speech, landing) =
        incoming;
    let incoming = Incoming {
        text,
        source,
        instance,
        scene,
        now_ns,
        relay,
        prefix,
        merge,
        final_speech,
        landing,
    };
    let newest = newest.map(line);
    let open = open.map(line);
    let (same_ns, cross_ns, similarity) = windows;
    let windows = Windows {
        same_ns,
        cross_ns,
        similarity,
    };
    let run = || {
        let (action, reason, suffix) = classify(
            &incoming,
            newest.as_ref(),
            open.as_ref(),
            previous,
            deadline_ns,
            &windows,
        )
        .wire();
        (action, reason, suffix.map(str::to_owned))
    };
    // Only the long fuzzy comparisons justify a GIL handoff.
    if text.len() + newest.as_ref().map_or(0, |n| n.text.len()) >= 4096 {
        py.detach(run)
    } else {
        run()
    }
}
