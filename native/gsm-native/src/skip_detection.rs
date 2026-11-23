//! Fast-forward evidence uses the volume of newly revealed dialogue, per source.
use std::collections::VecDeque;

const WINDOW: i128 = 1_500_000_000;
const SUSTAINED_WINDOW: i128 = 3_500_000_000;
const FAST_WINDOW: i128 = 750_000_000;
const CONFIRMED_QUIET_MIN: i128 = 2_000_000_000;
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

fn quiet_interval(
    samples: &VecDeque<Sample>,
    now: i128,
    floor: i128,
    gaps: &mut Vec<i128>,
) -> Option<i128> {
    gaps.clear();
    let mut last = None;
    for sample in samples
        .iter()
        .filter(|s| now.saturating_sub(s.at) <= WINDOW && s.novel >= 12)
    {
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
    Some((twice.saturating_mul(3) / 2).clamp(floor, MAX_QUIET))
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
            .is_some_and(|s| now.saturating_sub(s.at) > SUSTAINED_WINDOW)
        {
            samples.pop_front();
        }
        self.last_activity = now;
        let sustained_span = now.saturating_sub(samples.front().unwrap().at);
        let mut first_short = None;
        let mut first_fast = None;
        let (mut total, mut max) = (0usize, 0usize);
        let (mut fast_total, mut fast_max) = (0usize, 0usize);
        let (mut recent, mut recent_len, mut recent_max) = (0usize, 0usize, 0usize);
        let (mut controlled, mut controlled_len) = (0usize, 0usize);
        let (mut sustained_total, mut sustained_max, mut sustained_repl) = (0usize, 0usize, 0usize);
        for sample in samples.iter() {
            sustained_total += sample.novel;
            sustained_max = sustained_max.max(sample.novel);
            if sample.novel >= 12 && sample.replacement {
                sustained_repl += 1;
            }
            let age = now.saturating_sub(sample.at);
            if age <= WINDOW {
                first_short.get_or_insert(sample.at);
                total += sample.novel;
                max = max.max(sample.novel);
                if sample.novel >= 12 && sample.replacement && sample.control {
                    controlled += 1;
                    controlled_len += sample.novel;
                }
            }
            if age <= FAST_WINDOW {
                first_fast.get_or_insert(sample.at);
                fast_total += sample.novel;
                fast_max = fast_max.max(sample.novel);
                if sample.novel >= 12 && sample.replacement {
                    recent += 1;
                    recent_len += sample.novel;
                    recent_max = recent_max.max(sample.novel);
                }
            }
        }
        let span = now.saturating_sub(first_short.unwrap_or(now));
        let fast_span = now.saturating_sub(first_fast.unwrap_or(now));
        let other = total - max;
        let fast_other = fast_total - fast_max;
        let recent_other = recent_len - recent_max;
        let sustained_other = sustained_total - sustained_max;

        let volume = (total >= 200 && other >= 80 && span >= 150_000_000)
            || (fast_total >= 300 && fast_other >= 55 && fast_span >= 150_000_000);
        let control_burst = controlled >= 2 && controlled_len >= 48 && span >= 150_000_000;
        let rapid = fast_span >= 150_000_000
            && ((recent >= 4 && recent_len >= 100)
                || (recent >= 3 && recent_len >= 120 && recent_other >= 45));
        let sustained = sustained_span >= 150_000_000
            && sustained_total >= 240
            && sustained_other >= 130
            && sustained_repl >= 3;

        let reason = if volume {
            Some("text volume")
        } else if control_burst {
            Some("Ctrl with changing dialogue")
        } else if rapid {
            Some("rapid dialogue replacements")
        } else if sustained {
            Some("sustained text volume")
        } else {
            None
        };
        if let Some(reason) = reason {
            self.confirmed = true;
            self.reason = reason;
            self.last_confirmation = now;
        } else if self.confirmed
            && ((total >= 120 && other >= 50 && span >= 150_000_000)
                || (recent >= 2 && recent_len >= 75 && fast_span >= 150_000_000))
        {
            self.last_confirmation = now;
        }
        let suspect = (other >= 48 && total >= 100 && (100_000_000..=FAST_WINDOW).contains(&span))
            || (novel >= 30
                && other >= 80
                && total >= 150
                && (100_000_000..=WINDOW).contains(&span));
        if suspect {
            self.last_suspicion = now;
        }
        self.suspended |= suspect || self.confirmed;
        if self.suspended {
            let floor = if self.confirmed {
                CONFIRMED_QUIET_MIN
            } else {
                WINDOW
            };
            if let Some(interval) = quiet_interval(samples, now, floor, &mut self.gaps) {
                self.quiet_ns = interval;
            } else {
                self.quiet_ns = self.quiet_ns.max(floor);
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
