//! Fast-forward evidence uses the volume of newly revealed dialogue, per source.
use std::collections::VecDeque;

const WINDOW: i128 = 1_500_000_000;
const MAX_QUIET: i128 = 2_500_000_000;
const OVERLAP: usize = 512;

// These ranges are NFKC-stable letters/numbers or known separators in all
// supported Python Unicode tables. Combining marks take the compatibility
// route for the entire string, so composition across boundaries is preserved.
pub fn simple_text(text: &str) -> Option<String> {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            'a'..='z'
            | 'A'..='Z'
            | '0'..='9'
            | 'ぁ'..='ゖ'
            | 'ァ'..='ヺ'
            | 'ー'
            | '々'
            | '一'..='鿿' => out.push(c),
            c if c.is_ascii() => {}
            '　' | '、' | '。' | '「' | '」' | '『' | '』' | '・' | '！' | '？' => {}
            _ => return None,
        }
    }
    Some(out)
}

// Longest suffix/prefix overlap in Unicode scalar values. Match at most
// 512 characters, independently of how many characters the hook retained.
fn overlap(old: &str, new: &str) -> usize {
    if old.len().min(new.len()) < 8 {
        return 0;
    }
    let pattern: Vec<_> = new.chars().take(OVERLAP).collect();
    if pattern.len() < 8 {
        return 0;
    }
    let start = old
        .char_indices()
        .rev()
        .nth(pattern.len() - 1)
        .map_or(0, |(i, _)| i);
    let mut prefix = [0u16; OVERLAP];
    let mut n = 0;
    for i in 1..pattern.len() {
        while n > 0 && pattern[i] != pattern[n] {
            n = usize::from(prefix[n - 1]);
        }
        if pattern[i] == pattern[n] {
            n += 1;
        }
        prefix[i] = n as u16;
    }
    n = 0;
    for ch in old[start..].chars() {
        while n > 0 && ch != pattern[n] {
            n = usize::from(prefix[n - 1]);
        }
        if ch == pattern[n] {
            n += 1;
        }
    }
    if n >= 8 {
        n
    } else {
        0
    }
}

struct Sample {
    at: i128,
    novel: usize,
    replacement: bool,
    control: bool,
}

fn quiet_interval(samples: &VecDeque<Sample>, gaps: &mut Vec<i128>) -> Option<i128> {
    gaps.clear();
    let mut last = None;
    for sample in samples.iter().filter(|s| s.novel >= 12) {
        if let Some(previous) = last {
            if sample.at > previous {
                gaps.push(sample.at.saturating_sub(previous));
            }
        }
        last = Some(sample.at);
    }
    if gaps.is_empty() {
        return None;
    }
    let half = gaps.len() / 2;
    let even = gaps.len() % 2 == 0;
    let (low, pivot, _) = gaps.select_nth_unstable(half);
    // Twice the median preserves half-nanosecond gaps through scaling.
    let twice = pivot.saturating_add(if even {
        *low.iter().max().unwrap()
    } else {
        *pivot
    });
    Some((twice.saturating_mul(3) / 2).clamp(WINDOW, MAX_QUIET))
}

#[derive(Default)]
struct Source {
    kind: String,
    instance: Vec<u8>,
    text: String,
    samples: VecDeque<Sample>,
}

pub struct Detector {
    sources: VecDeque<Source>,
    gaps: Vec<i128>,
    pub suspended: bool,
    pub confirmed: bool,
    pub reason: &'static str,
    pub quiet_ns: i128,
    last_activity: i128,
    last_suspicion: i128,
    last_confirmation: i128,
}

impl Default for Detector {
    fn default() -> Self {
        Self {
            sources: VecDeque::new(),
            gaps: Vec::new(),
            suspended: false,
            confirmed: false,
            reason: "",
            quiet_ns: WINDOW,
            last_activity: 0,
            last_suspicion: 0,
            last_confirmation: 0,
        }
    }
}

impl Detector {
    pub fn observe(
        &mut self,
        kind: &str,
        instance: &[u8],
        text: String,
        now: i128,
        control: bool,
    ) -> bool {
        if text.is_empty() {
            return false;
        }
        let index = self
            .sources
            .iter()
            .position(|s| s.kind == kind && s.instance == instance);
        let source = match index {
            Some(i) => &mut self.sources[i],
            None => {
                self.sources.push_back(Source {
                    kind: kind.to_owned(),
                    instance: instance.to_owned(),
                    ..Source::default()
                });
                self.sources.back_mut().unwrap()
            }
        };
        if source.text.starts_with(&text) {
            return false;
        }
        let rest = (!source.text.is_empty())
            .then(|| text.strip_prefix(&source.text))
            .flatten();
        let novel = rest.map_or_else(
            || text.chars().count() - overlap(&source.text, &text),
            |s| s.chars().count(),
        );
        let replacement = rest.is_none();
        source.text = text;
        let samples = &mut source.samples;
        if samples.len() == 256 {
            samples.pop_front();
        }
        samples.push_back(Sample {
            at: now,
            novel,
            replacement,
            control,
        });
        while samples
            .front()
            .is_some_and(|s| now.saturating_sub(s.at) > WINDOW)
        {
            samples.pop_front();
        }
        self.last_activity = now;
        let span = now.saturating_sub(samples.front().unwrap().at);
        let (mut total, mut max, mut recent, mut recent_len, mut controlled, mut controlled_len) =
            (0, 0, 0, 0, 0, 0);
        for sample in samples.iter() {
            total += sample.novel;
            max = max.max(sample.novel);
            if sample.novel >= 12 && sample.replacement {
                if now.saturating_sub(sample.at) <= 750_000_000 {
                    recent += 1;
                    recent_len += sample.novel;
                }
                if sample.control {
                    controlled += 1;
                    controlled_len += sample.novel;
                }
            }
        }
        let other = total - max;
        if span >= 150_000_000 {
            let reason = if total >= 300 && other >= 180 {
                Some("text volume")
            } else if controlled >= 2 && controlled_len >= 48 {
                Some("Ctrl with changing dialogue")
            } else if recent >= 4 && recent_len >= 100 {
                Some("rapid dialogue replacements")
            } else {
                None
            };
            if let Some(reason) = reason {
                self.confirmed = true;
                self.reason = reason;
                self.last_confirmation = now;
            }
        }
        let suspect = other >= 48 && total >= 100 && (100_000_000..=750_000_000).contains(&span);
        if suspect {
            self.last_suspicion = now;
        }
        self.suspended |= suspect || self.confirmed;
        if self.suspended {
            if let Some(interval) = quiet_interval(samples, &mut self.gaps) {
                self.quiet_ns = interval;
            }
        }
        if self.sources.len() > 32 {
            self.sources.pop_front();
        }
        true
    }

    pub fn quiet(&self, now: i128) -> bool {
        self.suspended
            && (now.saturating_sub(self.last_activity) >= self.quiet_ns
                || if self.confirmed {
                    now.saturating_sub(self.last_confirmation) > MAX_QUIET
                } else {
                    now.saturating_sub(self.last_suspicion) > WINDOW
                })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_overlaps_match_a_scalar_reference_at_both_limits() {
        for n in [1, 7, 8, 9, 30, 511, 512, 513, 800] {
            for pattern in ["ああ", "abc𠀀", "abababac"] {
                let a: String = pattern.chars().cycle().take(n).collect();
                let old = format!("語{a}");
                let new = format!("{a}次");
                let before: Vec<_> = old.chars().collect();
                let after: Vec<_> = new.chars().collect();
                let expect = (8..=before.len().min(after.len()).min(512))
                    .rev()
                    .find(|&k| before.ends_with(&after[..k]))
                    .unwrap_or(0);
                assert_eq!(overlap(&old, &new), expect);
            }
        }
    }
}
