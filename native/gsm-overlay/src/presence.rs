//! Visual checks are cheap and conservative. A visual miss asks the worker for
//! local OCR confirmation; it never removes text on its own.
use crate::{
    adaptive::{Region, normalize},
    pipeline::TextBox,
};
use image::{GrayImage, RgbaImage};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Unchanged,
    Confirm,
    Restore,
}

struct Signature {
    size: (u32, u32),
    bright: Vec<bool>,
    dark: Vec<bool>,
}
impl Signature {
    fn new(image: &RgbaImage, region: Region) -> Self {
        let mut gray = GrayImage::from_fn(region.width(), region.height(), |x, y| {
            let p = image.get_pixel(x + region.left, y + region.top).0;
            image::Luma([
                ((77 * p[0] as u32 + 150 * p[1] as u32 + 29 * p[2] as u32 + 128) >> 8) as u8,
            ])
        });
        let scale = (640. / gray.width() as f64)
            .min(256. / gray.height() as f64)
            .min(1.);
        if scale < 1. {
            gray = image::imageops::resize(
                &gray,
                (gray.width() as f64 * scale).round().max(3.) as u32,
                (gray.height() as f64 * scale).round().max(3.) as u32,
                image::imageops::FilterType::Triangle,
            );
        }
        let smooth = image::imageops::blur(&gray, 2.);
        let detail: Vec<i16> = gray
            .as_raw()
            .iter()
            .zip(smooth.as_raw())
            .map(|(a, b)| *a as i16 - *b as i16)
            .collect();
        let mut contrast: Vec<_> = detail.iter().map(|v| v.abs()).collect();
        let index = contrast.len() * 88 / 100;
        let threshold = (*contrast.select_nth_unstable(index).1).max(10);
        Self {
            size: gray.dimensions(),
            bright: detail.iter().map(|v| *v >= threshold).collect(),
            dark: detail.iter().map(|v| *v <= -threshold).collect(),
        }
    }
    fn similarity(&self, other: &Self) -> f64 {
        if self.size != other.size {
            return 0.;
        }
        tolerant_f1(&self.bright, &other.bright, self.size).max(tolerant_f1(
            &self.dark,
            &other.dark,
            self.size,
        ))
    }
    fn useful(&self) -> bool {
        self.bright
            .iter()
            .filter(|v| **v)
            .count()
            .max(self.dark.iter().filter(|v| **v).count())
            >= 4
    }
}
fn tolerant_f1(reference: &[bool], current: &[bool], size: (u32, u32)) -> f64 {
    let count_a = reference.iter().filter(|v| **v).count();
    let count_b = current.iter().filter(|v| **v).count();
    if count_a == 0 || count_b == 0 {
        return 0.;
    }
    let neighbor = |mask: &[bool], index: usize| {
        let (x, y) = (index % size.0 as usize, index / size.0 as usize);
        (y.saturating_sub(1)..=(y + 1).min(size.1 as usize - 1)).any(|row| {
            (x.saturating_sub(1)..=(x + 1).min(size.0 as usize - 1))
                .any(|col| mask[row * size.0 as usize + col])
        })
    };
    let recall = reference
        .iter()
        .enumerate()
        .filter(|(i, v)| **v && neighbor(current, *i))
        .count() as f64
        / count_a as f64;
    let precision = current
        .iter()
        .enumerate()
        .filter(|(i, v)| **v && neighbor(reference, *i))
        .count() as f64
        / count_b as f64;
    if recall + precision == 0. {
        0.
    } else {
        2. * recall * precision / (recall + precision)
    }
}

pub struct Presence {
    pub lines: Vec<TextBox>,
    size: (u32, u32),
    signatures: Vec<(Region, Signature)>,
    misses: u8,
    invalidated: bool,
}
impl Presence {
    pub fn invalidated(&self) -> bool {
        self.invalidated
    }
    pub fn new(image: &RgbaImage, lines: Vec<TextBox>) -> Option<Self> {
        let size = image.dimensions();
        let signatures = lines
            .iter()
            .filter_map(|l| {
                Region::from_bounds(
                    [
                        l.bounds[0] - 1.,
                        l.bounds[1] - 1.,
                        l.bounds[2] + 1.,
                        l.bounds[3] + 1.,
                    ],
                    size,
                )
            })
            .filter(|b| b.width() >= 3 && b.height() >= 3)
            .filter_map(|b| {
                let signature = Signature::new(image, b);
                signature.useful().then_some((b, signature))
            })
            .collect::<Vec<_>>();
        if signatures.is_empty() {
            return None;
        }
        Some(Self {
            lines,
            size,
            signatures,
            misses: 0,
            invalidated: false,
        })
    }
    pub fn observe(&mut self, image: &RgbaImage) -> Decision {
        if image.dimensions() != self.size {
            return Decision::Confirm;
        }
        // Do not let animated scenery between dialogue and HUD lines dominate
        // the signature, or let an unchanged HUD hide disappearing dialogue.
        let score = self
            .signatures
            .iter()
            .map(|(region, signature)| signature.similarity(&Signature::new(image, *region)))
            .fold(1., f64::min);
        if score >= 0.65 {
            self.misses = 0;
            if self.invalidated {
                self.invalidated = false;
                Decision::Restore
            } else {
                Decision::Unchanged
            }
        } else if self.invalidated {
            Decision::Unchanged
        } else {
            self.misses = self.misses.saturating_add(1);
            if self.misses >= 2 {
                Decision::Confirm
            } else {
                Decision::Unchanged
            }
        }
    }
    pub fn invalidate(&mut self) {
        self.invalidated = true;
        self.misses = 0;
    }
}

/// Match every old line, consuming characters once and tolerating changed OCR
/// wrapping/order and a small number of substitutions in longer sentences.
pub fn match_lines(expected: &[TextBox], scanned: &[TextBox]) -> Option<Vec<TextBox>> {
    let mut expected: Vec<Vec<char>> = expected
        .iter()
        .map(|l| normalize(&l.text).chars().collect())
        .filter(|s: &Vec<char>| !s.is_empty())
        .collect();
    if expected.is_empty() {
        return None;
    }
    expected.sort_by_key(|s| std::cmp::Reverse(s.len()));
    let mut available = Vec::new();
    let mut spans = Vec::new();
    for (i, line) in scanned.iter().enumerate() {
        let start = available.len();
        available.extend(normalize(&line.text).chars());
        if available.len() > start {
            spans.push((start, available.len(), i));
        }
    }
    let mut selected = vec![false; scanned.len()];
    for text in expected {
        let (start, end) = find_span(&text, &available)?;
        for &(s, e, i) in &spans {
            if s < end && e > start {
                selected[i] = true;
            }
        }
        available[start..end].fill('\0');
    }
    Some(
        scanned
            .iter()
            .zip(selected)
            .filter(|(_, keep)| *keep)
            .map(|(l, _)| l.clone())
            .collect(),
    )
}
fn find_span(needle: &[char], haystack: &[char]) -> Option<(usize, usize)> {
    if let Some(start) = haystack.windows(needle.len()).position(|w| w == needle) {
        return Some((start, start + needle.len()));
    }
    if needle.len() < 6 || needle.len() > 4096 || haystack.len() > 32768 {
        return None;
    }
    let tolerance = (needle.len() / 12).max(1);
    // Semiglobal edit distance: free leading/trailing screen text, but the
    // entire expected sentence must align. A short prefix cannot satisfy it.
    let mut costs = vec![0usize; haystack.len() + 1];
    let mut starts: Vec<_> = (0..=haystack.len()).collect();
    for (row, &ch) in needle.iter().enumerate() {
        let mut next = vec![row + 1; haystack.len() + 1];
        let mut next_starts = vec![0; haystack.len() + 1];
        for (j, &other) in haystack.iter().enumerate() {
            if other == '\0' {
                next[j + 1] = needle.len() + haystack.len();
                next_starts[j + 1] = j + 1;
                continue;
            }
            let choices = [
                (costs[j] + usize::from(ch != other), starts[j]),
                (costs[j + 1] + 1, starts[j + 1]),
                (next[j] + 1, next_starts[j]),
            ];
            let &(cost, start) = choices.iter().min_by_key(|(c, _)| *c).unwrap();
            next[j + 1] = cost;
            next_starts[j + 1] = start;
        }
        costs = next;
        starts = next_starts;
    }
    (1..=haystack.len())
        .filter(|&end| {
            costs[end] <= tolerance
                && end.saturating_sub(starts[end]) >= needle.len() - tolerance
                && !haystack[starts[end]..end].contains(&'\0')
        })
        .min_by_key(|&end| costs[end])
        .map(|end| (starts[end], end))
}

/// A bounded skip-landing probe. Sampling avoids converting full screenshots.
#[derive(Default)]
pub struct Landing {
    previous: Vec<u8>,
    stable: u8,
    samples: u8,
}
impl Landing {
    pub fn observe(&mut self, image: &RgbaImage) -> bool {
        let mut samples = Vec::with_capacity(96 * 54);
        for y in 0..54 {
            for x in 0..96 {
                let p = image
                    .get_pixel(x * image.width() / 96, y * image.height() / 54)
                    .0;
                samples
                    .push(((77 * p[0] as u32 + 150 * p[1] as u32 + 29 * p[2] as u32) >> 8) as u8);
            }
        }
        let difference = samples
            .iter()
            .zip(&self.previous)
            .map(|(a, b)| a.abs_diff(*b) as u64)
            .sum::<u64>() as f64
            / samples.len() as f64;
        if self.previous.len() == samples.len() && difference < 3. {
            self.stable += 1;
        } else {
            self.stable = 0;
        }
        self.previous = samples;
        self.samples += 1;
        self.stable >= 3 || self.samples >= 8
    }
}
