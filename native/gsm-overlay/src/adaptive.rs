//! Crop selection and retry timing. Times are capture-relative seconds so the
//! policy can be tested without sleeping or depending on OCR execution speed.
use crate::pipeline::TextBox;
use image::RgbaImage;
use std::collections::{HashMap, VecDeque};
use unicode_normalization::UnicodeNormalization;

pub fn normalize(text: &str) -> String {
    text.nfkc().filter(|c| c.is_alphanumeric()).collect()
}

/// LCS length using ordered character positions, without a quadratic matrix.
pub fn matched(a: &str, b: &str) -> usize {
    if a.chars().count() > 4096 || b.chars().count() > 32768 {
        return 0;
    }
    let mut positions: HashMap<char, Vec<usize>> = HashMap::new();
    for (i, c) in b.chars().enumerate() {
        positions.entry(c).or_default().push(i);
    }
    let mut tails = Vec::new();
    for c in a.chars() {
        for &p in positions.get(&c).into_iter().flatten().rev() {
            let i = tails.partition_point(|&v| v < p);
            if i == tails.len() {
                tails.push(p);
            } else {
                tails[i] = p;
            }
        }
    }
    tails.len()
}
fn affinity(a: &str, b: &str) -> f64 {
    let count = a.chars().count().min(b.chars().count());
    if count < 2 {
        return 0.;
    }
    matched(a, b) as f64 / count as f64
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Region {
    pub left: u32,
    pub top: u32,
    pub right: u32,
    pub bottom: u32,
}
impl Region {
    pub fn full(size: (u32, u32)) -> Self {
        Self {
            left: 0,
            top: 0,
            right: size.0,
            bottom: size.1,
        }
    }
    pub fn width(self) -> u32 {
        self.right - self.left
    }
    pub fn height(self) -> u32 {
        self.bottom - self.top
    }
    pub fn from_bounds(b: [f64; 4], size: (u32, u32)) -> Option<Self> {
        if !b.iter().all(|v| v.is_finite()) {
            return None;
        }
        let r = Self {
            left: b[0].floor().clamp(0., size.0 as f64) as u32,
            top: b[1].floor().clamp(0., size.1 as f64) as u32,
            right: b[2].ceil().clamp(0., size.0 as f64) as u32,
            bottom: b[3].ceil().clamp(0., size.1 as f64) as u32,
        };
        (r.right > r.left && r.bottom > r.top).then_some(r)
    }
    pub fn union(self, other: Self) -> Self {
        Self {
            left: self.left.min(other.left),
            top: self.top.min(other.top),
            right: self.right.max(other.right),
            bottom: self.bottom.max(other.bottom),
        }
    }
    pub fn image(self, image: &RgbaImage) -> RgbaImage {
        image::imageops::crop_imm(image, self.left, self.top, self.width(), self.height())
            .to_image()
    }
}

#[derive(Default)]
pub struct Focus {
    region: Option<Region>,
    last_full: Option<f64>,
    size: (u32, u32),
}
impl Focus {
    pub fn clear(&mut self) {
        *self = Self::default();
    }
    pub fn region(&self, size: (u32, u32), now: f64) -> Option<Region> {
        if self.size != size || now - self.last_full? >= 3. {
            return None;
        }
        self.region
    }
    pub fn needs_full(lines: &[TextBox], reference: &str, r: Region, size: (u32, u32)) -> bool {
        let lines: Vec<_> = lines
            .iter()
            .filter_map(|l| Region::from_bounds(l.bounds, (r.width(), r.height())).map(|b| (l, b)))
            .collect();
        if lines.is_empty() {
            return true;
        }
        let reference = normalize(reference);
        if !reference.is_empty()
            && !lines
                .iter()
                .any(|(l, _)| affinity(&normalize(&l.text), &reference) >= 0.9)
        {
            return true;
        }
        lines.iter().any(|(_, b)| {
            (r.left > 0 && b.left <= 12)
                || (r.top > 0 && b.top <= 12)
                || (r.right < size.0 && b.right.saturating_add(12) >= r.width())
                || (r.bottom < size.1 && b.bottom.saturating_add(12) >= r.height())
        })
    }
    pub fn observe(
        &mut self,
        lines: &[TextBox],
        size: (u32, u32),
        reference: &str,
        now: f64,
        full: bool,
    ) {
        if size != self.size {
            self.clear();
            self.size = size;
        }
        if full {
            self.last_full = Some(now);
        }
        let mut remaining: Vec<_> = lines
            .iter()
            .filter_map(|l| {
                let b = Region::from_bounds(l.bounds, size)?;
                let text = normalize(&l.text);
                if text.chars().count() < 2
                    || if l.vertical {
                        b.width() as f64 > size.0 as f64 * 0.25
                    } else {
                        b.height() as f64 > size.1 as f64 * 0.25
                    }
                {
                    return None;
                }
                Some((l, b, text))
            })
            .collect();
        if remaining.is_empty() {
            if full {
                self.region = None;
            }
            return;
        }
        let close = |a: Region, b: Region| {
            let xgap = a.left.max(b.left).saturating_sub(a.right.min(b.right));
            let ygap = a.top.max(b.top).saturating_sub(a.bottom.min(b.bottom));
            xgap as f64 <= (size.0 as f64 * 0.04).max(30.)
                && ygap as f64 <= (a.height().max(b.height()) as f64 * 1.2).max(24.)
        };
        let mut clusters = Vec::new();
        while let Some(first) = remaining.pop() {
            let mut cluster = vec![first];
            loop {
                let Some(i) = remaining
                    .iter()
                    .position(|(_, b, _)| cluster.iter().any(|(_, a, _)| close(*a, *b)))
                else {
                    break;
                };
                cluster.push(remaining.remove(i));
            }
            clusters.push(cluster);
        }
        let reference = normalize(reference);
        let score = |c: &Vec<(&TextBox, Region, String)>| {
            let mut ordered: Vec<_> = c.iter().collect();
            ordered.sort_by_key(|(_, b, _)| (b.top, b.left));
            let joined = ordered
                .iter()
                .map(|(_, _, t)| t.as_str())
                .collect::<String>();
            let affinity = c
                .iter()
                .map(|(_, _, t)| affinity(t, &reference))
                .fold(affinity(&joined, &reference), f64::max);
            (
                (if affinity >= 0.65 {
                    affinity * 1000.
                } else {
                    0.
                }) as u32,
                joined.chars().count(),
                c.len(),
            )
        };
        let cluster = clusters.iter().max_by_key(|c| score(c)).unwrap();
        let b = cluster
            .iter()
            .map(|(_, b, _)| *b)
            .reduce(Region::union)
            .unwrap();
        let vertical = cluster.iter().filter(|(l, _, _)| l.vertical).count() * 2 > cluster.len();
        let width = ((b.width() as f64 + 2. * (size.0 as f64 * 0.06).max(48.))
            .max(size.0 as f64 * if vertical { 0.3 } else { 0.9 }))
        .ceil()
        .min(size.0 as f64) as u32;
        let height = ((b.height() as f64 + 2. * (size.1 as f64 * 0.045).max(36.))
            .max(size.1 as f64 * if vertical { 0.9 } else { 0.3 }))
        .ceil()
        .min(size.1 as f64) as u32;
        let left = ((b.left as i64 + b.right as i64 - width as i64) / 2)
            .clamp(0, (size.0 - width) as i64) as u32;
        let top = ((b.top as i64 + b.bottom as i64 - height as i64) / 2)
            .clamp(0, (size.1 - height) as i64) as u32;
        self.region = (width as f64 * (height as f64) < size.0 as f64 * size.1 as f64 * 0.8)
            .then_some(Region {
                left,
                top,
                right: left + width,
                bottom: top + height,
            });
    }
}

pub struct RetryStep {
    pub finished: bool,
    pub delay: f64,
}
pub struct Retry {
    reference: String,
    previous: String,
    unchanged: f64,
    uncertain: u32,
    best: Option<usize>,
    progress: Option<f64>,
    base: Option<f64>,
    hard: Option<f64>,
    limit: u32,
    count: u32,
    adaptive: bool,
}
impl Retry {
    pub fn new(reference: &str, limit: u32, adaptive: bool) -> Self {
        Self {
            reference: normalize(reference),
            previous: String::new(),
            unchanged: 0.,
            uncertain: 0,
            best: None,
            progress: None,
            base: None,
            hard: None,
            limit: limit.max(1),
            count: 0,
            adaptive,
        }
    }
    pub fn observe(&mut self, text: &str, captured: f64, finished: f64) -> RetryStep {
        let text = normalize(text);
        let window = self.limit.saturating_sub(1) as f64;
        let base = *self.base.get_or_insert(finished + window);
        let hard = *self.hard.get_or_insert(finished + 30.);
        self.count += 1;
        if !self.reference.is_empty() {
            let n = matched(&self.reference, &text);
            if self.best.is_some_and(|old| n > old) {
                self.progress = Some(captured);
            }
            self.best = Some(self.best.unwrap_or(0).max(n));
        }
        let growing = !self.previous.is_empty()
            && text.chars().count() > self.previous.chars().count()
            && matched(&self.previous, &text) == self.previous.chars().count();
        if text.is_empty() || text != self.previous {
            self.unchanged = captured;
        }
        let sufficiently_complete = self.reference.is_empty() || {
            let length = self.reference.chars().count();
            let tolerance = if length >= 6 { (length / 12).max(1) } else { 0 };
            self.best
                .is_some_and(|_| matched(&self.reference, &text) >= length - tolerance)
        };
        let quiet = sufficiently_complete
            && !text.is_empty()
            && text == self.previous
            && captured - self.unchanged >= 1.
            && self.progress.is_none_or(|p| captured >= p + window);
        let exact = !self.reference.is_empty() && text.contains(&self.reference);
        let mut delay = if growing {
            self.uncertain = 0;
            0.01
        } else {
            let d = (0.1 * 2f64.powi(self.uncertain as i32)).min(1.);
            self.uncertain = (self.uncertain + 1).min(4);
            d
        };
        if !self.adaptive || finished >= base {
            delay = if text.is_empty() { 0.1 } else { 1. };
        }
        let deadline = base
            .max(self.progress.map_or(base, |p| p + window))
            .min(hard);
        let exhausted = if self.adaptive {
            finished >= deadline
        } else {
            self.count >= self.limit && self.progress.is_none_or(|p| finished >= p + window)
        };
        self.previous = text;
        RetryStep {
            finished: self.limit == 1 || exact || quiet || exhausted || finished >= hard,
            delay: if !self.adaptive && self.count < self.limit {
                delay
            } else {
                delay.min((deadline - finished).max(0.))
            },
        }
    }
}

pub struct HookTiming {
    reference: String,
    first: Option<f64>,
    first_match: Option<f64>,
    ready: Option<f64>,
    partial: bool,
}
impl HookTiming {
    pub fn new(reference: &str) -> Self {
        Self {
            reference: normalize(reference),
            first: None,
            first_match: None,
            ready: None,
            partial: false,
        }
    }
    pub fn observe(&mut self, text: &str, captured: f64) {
        let len = self.reference.chars().count();
        if len < 3 || self.ready.is_some() {
            return;
        }
        let text = normalize(text);
        let fully_present = text.contains(&self.reference);
        let ratio = if fully_present {
            1.
        } else {
            matched(&self.reference, &text) as f64 / len as f64
        };
        if self.first.is_none() {
            self.first = Some(captured);
            self.first_match = Some(ratio);
        }
        if fully_present {
            self.ready = Some(captured);
        } else if ratio > 0.1 {
            self.partial = true;
        }
    }

    pub fn summary(&self, initial_delay: f64, next_delay: f64) -> String {
        let outcome = match self.ready {
            None if self.reference.chars().count() < 3 => "short_reference",
            None => "unconfirmed",
            ready if ready == self.first => "first_capture_ready",
            Some(_) if self.partial => "partial_text",
            Some(_) => "late_reveal",
        };
        let capture_ms = |seconds: Option<f64>| {
            seconds.map_or_else(|| "unknown".into(), |s| format!("{:.0}ms", s * 1000.))
        };
        let initial_match = self
            .first_match
            .map_or_else(|| "unknown".into(), |ratio| format!("{:.0}%", ratio * 100.));
        format!(
            "initial delay: {:.0}ms -> {:.0}ms, initial match: {initial_match}, timing: {outcome}, first capture: {}, ready capture: {}",
            initial_delay * 1000.,
            next_delay * 1000.,
            capture_ms(self.first),
            capture_ms(self.ready),
        )
    }
}
#[derive(Default)]
pub struct LearnedDelay {
    pub delay: f64,
    successes: usize,
    recent: VecDeque<bool>,
}
impl LearnedDelay {
    pub fn record(&mut self, timing: &HookTiming) {
        let late = timing.ready.is_some() && timing.ready != timing.first && !timing.partial;
        self.recent.push_back(late);
        if self.recent.len() > 5 {
            self.recent.pop_front();
        }
        if timing.ready.is_none() {
            self.successes = 0;
            return;
        }
        if timing.ready == timing.first {
            self.successes += 1;
            if self.successes >= 8 {
                self.delay = (self.delay - 0.005).max(0.);
                self.successes = 0;
            }
        } else {
            self.successes = 0;
            if late && self.recent.iter().filter(|v| **v).count() >= 3 {
                self.delay = (self.delay + 0.05).min(0.15);
                self.recent.clear();
            }
        }
    }
}
