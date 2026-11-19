//! Classify a processed dialogue observation against the newest line and any
//! open speech hypothesis. Neither a decision nor a retry mutates either line.
use rapidfuzz::fuzz::ratio;
use serde::Deserialize;
use std::borrow::Cow;

#[derive(Deserialize)]
pub struct Incoming<'a> {
    pub text: &'a str,
    pub source: &'a str,
    pub instance: &'a str,
    pub scene: &'a str,
    pub now_ns: i64,
    pub relay: bool,
    pub prefix: bool,
    pub merge: bool,
    pub final_speech: bool,
    pub landing: bool,
}

#[derive(Deserialize)]
pub struct Line<'a> {
    pub text: &'a str,
    pub source: &'a str,
    pub instance: &'a str,
    pub scene: &'a str,
    pub first_ns: i64,
    pub relay: bool,
    pub frozen: bool,
    pub skipped: bool,
}

#[derive(Deserialize)]
pub struct Windows {
    pub same_ns: i64,
    pub cross_ns: i64,
    pub similarity: f64,
}

fn space(ch: char) -> bool {
    ch.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&ch)
}

fn compact(text: &str) -> Cow<'_, str> {
    match text.find(space) {
        None => Cow::Borrowed(text),
        Some(first) => {
            let mut out = String::with_capacity(text.len());
            out.push_str(&text[..first]);
            out.extend(text[first..].chars().filter(|&c| !space(c)));
            Cow::Owned(out)
        }
    }
}

impl Line<'_> {
    fn same_context(&self, input: &Incoming) -> bool {
        self.relay == input.relay
            && (self.scene.is_empty() || input.scene.is_empty() || self.scene == input.scene)
    }

    fn age(&self, now: i64) -> i64 {
        now.saturating_sub(self.first_ns).max(0)
    }
}

// Return a suffix only when it actually replaced the input. The common
// append/revise and duplicate results don't copy text over the caller boundary.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision<'a> {
    Append(Option<&'a str>),
    Revise,
    RepeatedLine,
    RepeatedSourcePayload,
    MatchesFrozenLine,
    RepeatedSpeech,
    ShorterSpeech,
}

impl<'a> Decision<'a> {
    pub fn wire(self) -> (&'static str, &'static str, Option<&'a str>) {
        match self {
            Self::Append(suffix) => ("append", "", suffix),
            Self::Revise => ("revise", "", None),
            Self::RepeatedLine => (
                "duplicate_newest",
                "same text as immediately previous record",
                None,
            ),
            Self::RepeatedSourcePayload => (
                "duplicate_newest",
                "same full text as immediately previous source payload",
                None,
            ),
            Self::MatchesFrozenLine => (
                "duplicate_newest",
                "correlated with newest frozen record",
                None,
            ),
            Self::RepeatedSpeech => ("duplicate_open", "same speech hypothesis", None),
            Self::ShorterSpeech => ("duplicate_open", "shorter partial speech hypothesis", None),
        }
    }
}

pub fn classify<'a>(
    input: &Incoming<'a>,
    newest: Option<&Line>,
    open: Option<&Line>,
    previous: Option<(&str, bool)>,
    deadline_ns: Option<i64>,
    windows: &Windows,
) -> Decision<'a> {
    const SPEECH: &str = "speech_recognition";
    if newest.is_some_and(|n| n.text == input.text) {
        return Decision::RepeatedLine;
    }
    let mut full = compact(input.text);
    let recent = newest.map(|line| compact(line.text));
    if recent.as_deref() == Some(full.as_ref()) {
        return Decision::RepeatedLine;
    }
    let mut suffix = None;
    if input.prefix && input.source != SPEECH {
        if let Some((prior, is_newest)) = previous {
            if input.text == prior && is_newest {
                return Decision::RepeatedSourcePayload;
            }
            if let Some(rest) = input.text.strip_prefix(prior) {
                let rest = rest.trim_start_matches(space);
                if !rest.is_empty() {
                    suffix = Some(rest);
                    full = compact(rest);
                }
            }
        }
    }
    if let (Some(line), Some(current)) = (newest, recent) {
        if line.frozen
            && line.source != SPEECH
            && input.source != SPEECH
            && line.same_context(input)
            && !(line.skipped && input.landing)
            && !current.is_empty()
            && !full.is_empty()
        {
            let age = line.age(input.now_ns);
            let matches = if line.source == input.source {
                input.instance == line.instance && age <= windows.same_ns && current == full
            } else {
                age <= windows.cross_ns
                    && (current == full
                        || ratio(current.chars(), full.chars()) * 100.0 >= windows.similarity)
            };
            if matches {
                return Decision::MatchesFrozenLine;
            }
        }
    }
    if let Some(line) = open {
        if !line.frozen
            && !line.skipped
            && line.source == SPEECH
            && input.source == SPEECH
            && input.instance == line.instance
            && line.same_context(input)
            && !full.is_empty()
        {
            let current = compact(line.text);
            if !current.is_empty()
                && ((current == full && line.age(input.now_ns) <= windows.same_ns)
                    || (input.merge && deadline_ns.is_some_and(|d| input.now_ns <= d)))
            {
                if input.text == line.text {
                    return Decision::RepeatedSpeech;
                }
                if !input.final_speech && current.starts_with(full.as_ref()) {
                    return Decision::ShorterSpeech;
                }
                return Decision::Revise;
            }
        }
    }
    Decision::Append(suffix)
}
