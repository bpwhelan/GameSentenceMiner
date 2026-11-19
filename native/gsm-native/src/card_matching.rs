//! Choose the original history entry for a mined Anki sentence. Input is newest first.
use rapidfuzz::{distance::indel::BatchComparator, fuzz::ratio};
use std::cmp::Reverse;
use std::{collections::HashMap, hash::Hash};

pub(crate) struct Query {
    pub sentence: String,
    pub punctuation: String,
    pub expression: String,
    pub context: String,
    pub spans: Vec<(usize, usize)>,
    pub bold: bool,
    pub recent: bool,
    pub minimum: f64,
}

struct Anchor {
    start: usize,
    length: usize,
    text: String,
}

struct Pick<T> {
    line: T,
    order: usize,
    expression: bool,
    similarity: f64,
}

struct SourceLine<T> {
    context_score: Option<f64>,
    newest: Option<Pick<T>>,
    most_similar: Option<Pick<T>>,
}

impl<T> SourceLine<T> {
    fn new() -> Self {
        Self {
            context_score: None,
            newest: None,
            most_similar: None,
        }
    }

    fn record(&mut self, pick: Pick<T>) {
        let Some(newest) = &self.newest else {
            self.newest = Some(pick);
            return;
        };
        if pick.expression && !newest.expression {
            self.newest = Some(pick);
            self.most_similar = None;
        } else if pick.expression == newest.expression
            && self.context_score.is_none()
            && pick.similarity > self.most_similar.as_ref().unwrap_or(newest).similarity
        {
            self.most_similar = Some(pick);
        }
    }

    fn winner(self) -> Option<Pick<T>> {
        let mut pick = self.most_similar.or(self.newest)?;
        if let Some(score) = self.context_score {
            pick.similarity = score;
        }
        Some(pick)
    }
}

pub(crate) struct Matcher<T, Id> {
    query: Query,
    sentence_length: usize,
    scorer: BatchComparator<char>,
    context: Vec<char>,
    anchors: Vec<Anchor>,
    matches: HashMap<Id, SourceLine<T>>,
    order: usize,
    best_sentence: Option<((bool, f64), T)>,
    recent_fallback: Option<T>,
}

impl<T, Id: Eq + Hash> Matcher<T, Id> {
    pub fn new(query: Query) -> Self {
        let context: Vec<_> = query.context.chars().collect();
        let anchors = query
            .spans
            .iter()
            .filter_map(|&(start, end)| {
                let text = context.get(start..end)?;
                (!text.is_empty()).then(|| Anchor {
                    start,
                    length: text.len(),
                    text: text.iter().collect(),
                })
            })
            .collect();
        Self {
            sentence_length: query.sentence.chars().count(),
            scorer: BatchComparator::new(query.sentence.chars()),
            context,
            anchors,
            query,
            matches: HashMap::new(),
            order: 0,
            best_sentence: None,
            recent_fallback: None,
        }
    }

    fn context_score(&self, line: &str) -> f64 {
        let mut chars = None;
        let mut best: f64 = 0.0;
        for anchor in &self.anchors {
            let mut previous_byte = 0;
            let mut position = 0;
            for (byte, _) in line.match_indices(&anchor.text) {
                position += line[previous_byte..byte].chars().count();
                previous_byte = byte;
                let chars = chars.get_or_insert_with(|| line.chars().collect::<Vec<_>>());
                let left = &chars[position.saturating_sub(anchor.start)..];
                let right = &self.context[anchor.start.saturating_sub(position)..];
                let overlap = left.len().min(right.len());
                if overlap >= 5.max(anchor.length) {
                    let score =
                        ratio(left.iter().copied(), right[..overlap].iter().copied()) * 100.0;
                    best = best.max(score);
                    if best == 100.0 {
                        return best;
                    }
                }
            }
        }
        best
    }

    /// A returned line is decisive even if more (older) entries remain.
    pub fn observe(&mut self, original: T, id: Id, line: &str, punctuation: &str) -> Option<T> {
        let q = &self.query;
        let (matches, similarity) = if line.is_empty() || q.sentence.is_empty() {
            (!punctuation.is_empty() && punctuation == q.punctuation, 0.0)
        } else if line == q.sentence {
            (true, 100.0)
        } else {
            let length = line.chars().count();
            let short = length.min(self.sentence_length);
            let long = length.max(self.sentence_length);
            let contained = (short >= 5 || short as f64 >= 0.3 * long as f64)
                && (line.contains(&q.sentence) || q.sentence.contains(line));
            let score = self.scorer.normalized_similarity(line.chars()) * 100.0;
            (contained || score >= 80.0, score)
        };
        let ordinary = matches && (q.minimum <= 0.0 || similarity >= q.minimum);
        let context_score = self.context_score(line);
        let anchored = context_score >= q.minimum.max(80.0);
        if !ordinary && !anchored {
            return None;
        }
        if q.recent {
            if (q.bold && anchored) || (!q.bold && ordinary) {
                return Some(original);
            }
            self.recent_fallback.get_or_insert(original);
            return None;
        }
        let expression = !q.expression.is_empty()
            && q.sentence.contains(&q.expression)
            && line.contains(&q.expression);
        if self.anchors.is_empty() || (q.bold && !anchored) {
            let priority = (expression, similarity);
            if self
                .best_sentence
                .as_ref()
                .is_none_or(|(old, _)| priority > *old)
            {
                self.best_sentence = Some((priority, original));
            }
            return None;
        }
        let source = self.matches.entry(id).or_insert_with(SourceLine::new);
        if anchored {
            // Copies in overlapping saved clips share the oldest qualifying
            // context score, even if an individual copy only matched the sentence.
            source.context_score = Some(context_score);
            source.most_similar = None;
        }
        if ordinary || q.bold {
            source.record(Pick {
                line: original,
                order: self.order,
                expression,
                similarity,
            });
            self.order += 1;
        }
        None
    }

    pub fn finish(self) -> Option<T> {
        if self.query.recent {
            return self.recent_fallback;
        }
        if self.matches.is_empty() {
            return self.best_sentence.map(|(_, line)| line);
        }
        self.matches
            .into_values()
            .filter_map(SourceLine::winner)
            .max_by(|a, b| {
                a.expression
                    .cmp(&b.expression)
                    .then(a.similarity.total_cmp(&b.similarity))
                    .then(Reverse(a.order).cmp(&Reverse(b.order)))
            })
            .map(|pick| pick.line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(recent: bool) -> Query {
        Query {
            sentence: "昨日の図書館で待っていた".into(),
            punctuation: String::new(),
            expression: "図書館".into(),
            context: "昨日の図書館で待っていた".into(),
            spans: vec![(3, 6)],
            bold: true,
            recent,
            minimum: 80.0,
        }
    }

    #[test]
    fn overlapping_clips_share_the_original_line_context_score() {
        let mut matcher = Matcher::new(query(false));
        for (source, id, text) in [
            ("new copy", "shared", "昨日の図書館で待っていた"),
            ("independent", "other", "昨日の図書館で待っていた"),
            ("old copy", "shared", "昨日の図書館で待っていたよ"),
        ] {
            assert_eq!(matcher.observe(source, id, text, ""), None);
        }
        assert_eq!(matcher.finish(), Some("independent"));
    }

    #[test]
    fn recent_overlay_can_select_an_aligned_fragment() {
        let mut matcher = Matcher::new(query(true));
        assert_eq!(matcher.observe(7, "a", "図書館で待って", ""), Some(7));
    }

    #[test]
    fn insertion_similarity_uses_both_unicode_lengths() {
        // The card's stripped field keeps "amp" from an HTML entity. Its
        // shorter source still clears 80% under normalized Indel similarity.
        let mut q = query(false);
        q.sentence = "waitampsee👋".into();
        q.expression.clear();
        q.spans.clear();
        q.bold = false;
        let mut matcher = Matcher::new(q);
        assert_eq!(matcher.observe(4, "line", "waitsee👋", ""), None);
        assert_eq!(matcher.finish(), Some(4));
    }
}
