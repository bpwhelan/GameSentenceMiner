//! OCR-tab computation. No window, webview, Python, or asynchronous runtime access.
use crate::pipeline::{self, Recognition};
use image::RgbaImage;
use serde_json::Value;
use std::time::{Duration, Instant};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};
mod replacements;

/// Cover the first pass's lines with the same 20 source-pixel margin on every side.
pub fn second_pass_crop(image: &RgbaImage, first: &Recognition) -> Option<(RgbaImage, u32, u32)> {
    let mut boxes = first
        .lines
        .iter()
        .map(|line| line.bounds)
        .chain(first.detections.iter().copied());
    let [mut left, mut top, mut right, mut bottom] = boxes.next()?;
    for [x0, y0, x1, y1] in boxes {
        left = left.min(x0);
        top = top.min(y0);
        right = right.max(x1);
        bottom = bottom.max(y1);
    }
    let x = (left - 20.).max(0.) as u32;
    let y = (top - 20.).max(0.) as u32;
    let r = (right + 20.).ceil().min(image.width() as f64) as u32;
    let b = (bottom + 20.).ceil().min(image.height() as f64) as u32;
    (r > x && b > y).then(|| {
        let crop = image::imageops::crop_imm(image, x, y, r - x, b - y).to_image();
        (crop, x, y)
    })
}

pub fn number(settings: &Value, key: &str, default: f64) -> f64 {
    settings[key]
        .as_f64()
        .filter(|x| x.is_finite())
        .unwrap_or(default)
}
pub fn flag(settings: &Value, key: &str, default: bool) -> bool {
    settings[key].as_bool().unwrap_or(default)
}
pub fn normalize(text: &str) -> String {
    text.nfkc()
        .filter(|c| c.is_alphanumeric() || is_combining_mark(*c))
        .collect()
}
/// RapidFuzz's normalized indel similarity, using Unicode scalar values.
pub fn ratio(a: &str, b: &str) -> f64 {
    if a == b {
        return 100.;
    }
    let a: Vec<_> = a.chars().collect();
    let b: Vec<_> = b.chars().collect();
    if a.is_empty() || b.is_empty() {
        return 0.;
    }
    let mut row = vec![0usize; b.len() + 1];
    for ac in &a {
        let mut diagonal = 0;
        for (j, bc) in b.iter().enumerate() {
            let previous = row[j + 1];
            row[j + 1] = if ac == bc {
                diagonal + 1
            } else {
                row[j + 1].max(row[j])
            };
            diagonal = previous;
        }
    }
    200. * row[b.len()] as f64 / (a.len() + b.len()) as f64
}
fn flat_duplicate(a: &str, b: &str, s: &Value) -> bool {
    let threshold = number(s, "duplicate_similarity_threshold", 80.);
    let score = ratio(a, b);
    if score >= threshold {
        return true;
    }
    let (short, long) = if a.chars().count() <= b.chars().count() {
        (a, b)
    } else {
        (b, a)
    };
    let n = short.chars().count();
    let chars: Vec<_> = long.chars().collect();
    if threshold < number(s, "truncation_compare_threshold_min", 70.)
        || n < number(s, "truncation_min_length", 8.) as usize
        || n as f64 / (chars.len().max(1) as f64)
            < number(s, "truncation_min_ratio_percent", 25.) / 100.
        || (threshold >= number(s, "truncation_strict_threshold_min", 75.)
            && score < threshold - number(s, "truncation_similarity_margin", 15.))
    {
        return false;
    }
    ratio(short, &chars[..n].iter().collect::<String>()).max(ratio(
        short,
        &chars[chars.len() - n..].iter().collect::<String>(),
    )) >= threshold
}
/// Incoming chunks must all be explained: appending a short new line is not a duplicate.
pub fn duplicate(previous: &[String], incoming: &[String], s: &Value) -> bool {
    let norm = |items: &[String]| {
        items
            .iter()
            .map(|s| {
                let n = normalize(s);
                if n.is_empty() { s.trim().into() } else { n }
            })
            .filter(|s: &String| !s.is_empty())
            .collect::<Vec<_>>()
    };
    let previous = norm(previous);
    let incoming = norm(incoming);
    if previous.is_empty() || incoming.is_empty() {
        return false;
    }
    let flat = previous.concat();
    incoming.iter().all(|line| {
        if flat.contains(line) || previous.iter().any(|p| flat_duplicate(p, line, s)) {
            return true;
        }
        let n = line.chars().count();
        if n < number(s, "subset_chunk_min_length", 5.) as usize {
            return false;
        }
        let minimum = if n <= number(s, "matching_block_short_chunk_char_limit", 4.) as usize {
            number(s, "matching_block_small_chunk_min_size", 1.)
        } else {
            number(s, "matching_block_default_min_size", 2.)
        };
        let metrics = crate::text_matching::match_metrics(&flat, line, minimum.max(1.) as usize);
        let coverage = ((number(s, "duplicate_similarity_threshold", 80.)
            - number(s, "subset_coverage_threshold_offset", 5.))
            / 100.)
            .min(number(s, "subset_coverage_ceiling_percent", 95.) / 100.)
            .max(number(s, "subset_coverage_floor_percent", 80.) / 100.);
        metrics.covered as f64 / n as f64 >= coverage
            && metrics.longest
                >= (number(s, "subset_longest_block_min_chars", 2.) as usize)
                    .max(n / number(s, "subset_longest_block_divisor", 4.).max(1.) as usize)
    })
}

#[derive(Default)]
pub struct Stability {
    pending: String,
    boxes: Vec<[f64; 4]>,
    first_seen: Option<(Instant, u128)>,
    stable: usize,
    processed: String,
}
impl Stability {
    pub fn observe(
        &mut self,
        result: &Recognition,
        capture_started: Instant,
        captured_at: u128,
        s: &Value,
    ) -> bool {
        let text = normalize(&result.text);
        let boxes: Vec<_> = if result.detections.is_empty() {
            result.lines.iter().map(|l| l.bounds).collect()
        } else {
            result.detections.clone()
        };
        if text.is_empty() && boxes.is_empty() {
            *self = Self::default();
            return false;
        }
        let detector = text.is_empty();
        let same_boxes = !boxes.is_empty()
            && boxes.len() == self.boxes.len()
            && boxes
                .iter()
                .zip(&self.boxes)
                .all(|(a, b)| a.iter().zip(b).all(|(a, b)| (a - b).abs() <= 3.));
        let same = if detector {
            same_boxes
        } else {
            let a = self.pending.chars().count();
            let b = text.chars().count();
            text == self.pending
                || (!self.pending.is_empty()
                    && a.abs_diff(b) <= 2.max(a.max(b) / 10)
                    && crate::text_matching::match_metrics(&self.pending, &text, 1).matched as f64
                        * 200.
                        / (a + b).max(1) as f64
                        >= number(s, "duplicate_similarity_threshold", 80.).max(90.))
        };
        if same {
            self.stable += 1;
        } else {
            let old: Vec<_> = self.pending.chars().collect();
            let new: Vec<_> = text.chars().collect();
            let n = old.len().min(new.len());
            let evolving = n > 0
                && ratio(
                    &old[..n].iter().collect::<String>(),
                    &new[..n].iter().collect::<String>(),
                ) >= number(s, "evolving_prefix_similarity_threshold", 85.);
            if self.pending.is_empty()
                || self.pending == self.processed
                || (!evolving && !same_boxes)
            {
                self.first_seen = Some((capture_started, captured_at));
            }
            self.stable = 1;
        }
        self.pending = text.clone();
        self.boxes = boxes;
        let identity = if detector {
            format!("{:?}", self.boxes)
        } else {
            text
        };
        if identity == self.processed {
            return false;
        }
        if flag(s, "text_appears_instantly", false)
            || flag(s, "force_stable", false)
            || self.stable >= 2
            || self.first_seen.is_some_and(|(first, _)| {
                capture_started.duration_since(first) >= Duration::from_secs(4)
            })
        {
            self.processed = identity;
            return true;
        }
        false
    }
    pub fn first_seen_at(&self) -> Option<u128> {
        self.first_seen.map(|(_, captured_at)| captured_at)
    }
    pub fn retry(&mut self) {
        self.processed.clear();
    }
    pub fn pending(&self) -> bool {
        !self.pending.is_empty() && self.pending != self.processed
    }
}

#[derive(Clone)]
pub struct Prepared {
    pub image: RgbaImage,
    pub offset: (u32, u32),
    pub excluded: Vec<[u32; 4]>,
    pub regions: Vec<([u32; 4], [u32; 4])>,
    pub exclusive: Vec<[u32; 4]>,
    pub black_holes: Vec<[u32; 4]>,
}
/// Areas use source pixels (or fractions of the current client size), never CSS pixels.
pub fn prepare(
    image: &RgbaImage,
    areas: &Value,
    secondary: bool,
    whole: bool,
    settings: &Value,
) -> Option<Prepared> {
    let (w, h) = image.dimensions();
    if w == 0 || h == 0 {
        return None;
    }
    let mut includes = Vec::new();
    let mut excludes = Vec::new();
    let mut configured = false;
    let mut exclusive = Vec::new();
    let mut black_holes = Vec::new();
    if !whole {
        for area in areas["rectangles"].as_array().into_iter().flatten() {
            if area["is_excluded"] != true && flag(area, "is_secondary", false) != secondary {
                continue;
            }
            if area["is_excluded"] != true {
                configured = true;
            }
            let Some(c) = area["coordinates"].as_array().filter(|v| v.len() == 4) else {
                continue;
            };
            let vals: Option<Vec<f64>> = c
                .iter()
                .map(|v| v.as_f64().filter(|v| v.is_finite()))
                .collect();
            let Some(c) = vals else {
                continue;
            };
            let (sx, sy) = if areas["coordinate_system"] == "percentage" {
                (w as f64, h as f64)
            } else {
                (1., 1.)
            };
            let r = [
                (c[0] * sx).floor().clamp(0., w as f64) as u32,
                (c[1] * sy).floor().clamp(0., h as f64) as u32,
                ((c[0] + c[2]) * sx).ceil().clamp(0., w as f64) as u32,
                ((c[1] + c[3]) * sy).ceil().clamp(0., h as f64) as u32,
            ];
            if r[2] <= r[0] || r[3] <= r[1] {
                continue;
            }
            if area["is_excluded"] == true {
                excludes.push(r);
            } else {
                includes.push(r);
                if area["is_black_hole"] == true {
                    black_holes.push(r);
                } else if area["is_exclusive"] == true && !secondary {
                    exclusive.push(r);
                }
            }
        }
    }
    if includes.is_empty() {
        if !whole && (configured || secondary) {
            return None;
        }
        includes.push([0, 0, w, h]);
    }
    let bounds = [
        includes.iter().map(|r| r[0]).min()?,
        includes.iter().map(|r| r[1]).min()?,
        includes.iter().map(|r| r[2]).max()?,
        includes.iter().map(|r| r[3]).max()?,
    ];
    let mut crop = image::imageops::crop_imm(
        image,
        bounds[0],
        bounds[1],
        bounds[2] - bounds[0],
        bounds[3] - bounds[1],
    )
    .to_image();
    let inside = |r: &[u32; 4], x, y| x >= r[0] && x < r[2] && y >= r[1] && y < r[3];
    for (x, y, px) in crop.enumerate_pixels_mut() {
        let (x, y) = (x + bounds[0], y + bounds[1]);
        if !includes.iter().any(|r| inside(r, x, y)) || excludes.iter().any(|r| inside(r, x, y)) {
            *px = image::Rgba([0, 0, 0, 255]);
        }
    }
    let mut regions = Vec::new();
    if !whole && !secondary && flag(settings, "compactBoxes", false) && includes.len() > 1 {
        let gap = number(settings, "compactBoxesGap", 12.).clamp(0., 256.) as u32;
        let mut sorted = includes.clone();
        sorted.sort_by_key(|r| (r[1], r[0]));
        let mut rows: Vec<(u32, u32, Vec<[u32; 4]>)> = Vec::new();
        for rect in sorted {
            let row = rows.last_mut().filter(|(top, bottom, _)| {
                rect[3].min(*bottom).saturating_sub(rect[1].max(*top)) as f64
                    >= 0.4 * (rect[3] - rect[1]).min(*bottom - *top) as f64
            });
            if let Some((top, bottom, items)) = row {
                *top = (*top).min(rect[1]);
                *bottom = (*bottom).max(rect[3]);
                items.push(rect);
            } else {
                rows.push((rect[1], rect[3], vec![rect]));
            }
        }
        let (mut width, mut y) = (0, 0);
        for (_, _, mut row) in rows {
            row.sort_by_key(|r| r[0]);
            let (mut x, mut height) = (0, 0);
            for r in row {
                let (w, h) = (r[2] - r[0], r[3] - r[1]);
                regions.push(([x, y, x + w, y + h], r));
                x += w + gap;
                height = height.max(h);
            }
            width = width.max(x.saturating_sub(gap));
            y += height + gap;
        }
        let height = y.saturating_sub(gap);
        if width as u64 * height as u64 > 64_000_000 {
            return None;
        }
        let mut packed = RgbaImage::from_pixel(width, height, image::Rgba([0, 0, 0, 255]));
        for (dest, src) in &regions {
            let pixels = image::imageops::crop_imm(
                &crop,
                src[0] - bounds[0],
                src[1] - bounds[1],
                src[2] - src[0],
                src[3] - src[1],
            )
            .to_image();
            image::imageops::replace(&mut packed, &pixels, dest[0] as i64, dest[1] as i64);
        }
        crop = packed;
    }
    match settings["obs_capture_preprocess"]
        .as_str()
        .unwrap_or("none")
    {
        "grayscale" | "grayscale_unsharp" => {
            let gray = image::imageops::grayscale(&crop);
            let gray = if settings["obs_capture_preprocess"] == "grayscale_unsharp" {
                image::imageops::unsharpen(&gray, 1., 3)
            } else {
                gray
            };
            crop = image::DynamicImage::ImageLuma8(gray).into_rgba8();
        }
        _ => {}
    }
    Some(Prepared {
        image: crop,
        offset: (bounds[0], bounds[1]),
        excluded: excludes,
        regions,
        exclusive,
        black_holes,
    })
}
/// Returns whether the size threshold removed all eligible text.
pub fn finish(
    result: &mut Recognition,
    prepared: &Prepared,
    settings: &Value,
    replacements: &Value,
    apply_size_threshold: bool,
) -> Result<bool, String> {
    for line in &mut result.lines {
        let center = (
            (line.bounds[0] + line.bounds[2]) / 2.,
            (line.bounds[1] + line.bounds[3]) / 2.,
        );
        let offset = prepared
            .regions
            .iter()
            .find(|(r, _)| {
                center.0 >= r[0] as f64
                    && center.0 < r[2] as f64
                    && center.1 >= r[1] as f64
                    && center.1 < r[3] as f64
            })
            .map(|(dest, src)| {
                (
                    src[0] as f64 - dest[0] as f64,
                    src[1] as f64 - dest[1] as f64,
                )
            })
            .unwrap_or((prepared.offset.0 as f64, prepared.offset.1 as f64));
        pipeline::remap_line(line, offset, (1., 1.));
    }
    let language = settings["language"]
        .as_str()
        .unwrap_or("ja")
        .split(['-', '_'])
        .next()
        .unwrap_or("ja");
    let overlaps = |b: [f64; 4], r: &[u32; 4]| {
        b[0] < r[2] as f64 && b[2] > r[0] as f64 && b[1] < r[3] as f64 && b[3] > r[1] as f64
    };
    if result.lines.iter().any(|l| {
        l.text
            .chars()
            .any(|c| crate::text_filter::is_comparable(c, language))
            && prepared.black_holes.iter().any(|r| overlaps(l.bounds, r))
    }) {
        *result = Recognition::default();
        return Ok(false);
    }
    let in_exclusive = |b: [f64; 4]| {
        prepared.exclusive.iter().any(|r| {
            b[0] >= r[0] as f64 && b[1] >= r[1] as f64 && b[2] <= r[2] as f64 && b[3] <= r[3] as f64
        })
    };
    let exclusive_active = result.lines.iter().any(|l| in_exclusive(l.bounds));
    result.lines.retain(|l| {
        if exclusive_active && !in_exclusive(l.bounds) {
            return false;
        }
        let (x, y) = (
            (l.bounds[0] + l.bounds[2]) / 2.,
            (l.bounds[1] + l.bounds[3]) / 2.,
        );
        !prepared
            .excluded
            .iter()
            .any(|r| x >= r[0] as f64 && x < r[2] as f64 && y >= r[1] as f64 && y < r[3] as f64)
            && l.text
                .chars()
                .any(|c| crate::text_filter::is_comparable(c, language))
    });
    if language == "ja" && result.lines.len() > 1 {
        // Use layout to identify furigana, keeping the engine's order and word boxes.
        let mut keep = vec![false; result.lines.len()];
        for paragraph in pipeline::order_lines(&result.lines, language, true) {
            for id in paragraph.lines.into_iter().flat_map(|line| line.source_ids) {
                keep[id] = true;
            }
        }
        let mut keep = keep.into_iter();
        result.lines.retain(|_| keep.next().unwrap());
    }
    let has_text = !result.lines.is_empty();
    let sensitivity = number(settings, "furigana_filter_sensitivity", 0.);
    if apply_size_threshold && sensitivity > 0. {
        result.lines.retain(|l| {
            l.bounds[2] - l.bounds[0] > sensitivity && l.bounds[3] - l.bounds[1] > sensitivity
        });
    }
    let all_text_filtered = has_text && result.lines.is_empty();
    let rules: Vec<(&str, &str)> = if let Some(rules) = replacements.as_array() {
        rules
            .iter()
            .filter_map(|r| Some((r[0].as_str()?, r[1].as_str()?)))
            .collect()
    } else {
        replacements
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(from, to)| Some((from.as_str(), to.as_str()?)))
            .collect()
    };
    for line in &mut result.lines {
        for &(from, to) in &rules {
            line.text = if let Some(pattern) = from.strip_prefix("re:") {
                replacements::replace(&line.text, pattern, to)?
            } else {
                replace_literal(&line.text, from, to)
            };
        }
    }
    result.text = result
        .lines
        .iter()
        .map(|l| l.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(all_text_filtered)
}
fn replace_literal(text: &str, from: &str, to: &str) -> String {
    if from.is_empty() {
        return text.into();
    }
    if !from.is_ascii() {
        return text.replace(from, to);
    }
    let word = |c: char| c == '_' || c.is_alphanumeric();
    let mut result = String::new();
    let mut previous = 0;
    for (offset, _) in text.match_indices(from) {
        let end = offset + from.len();
        if text[..offset].chars().next_back().is_some_and(word)
            || text[end..].chars().next().is_some_and(word)
        {
            continue;
        }
        result.push_str(&text[previous..offset]);
        result.push_str(to);
        previous = end;
    }
    result.push_str(&text[previous..]);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::TextBox;
    use serde_json::json;
    #[test]
    fn second_pass_covers_lines_and_detections_and_clips_padding() {
        let image = RgbaImage::new(100, 80);
        assert!(second_pass_crop(&image, &Recognition::default()).is_none());
        let mut found = line("文");
        found.detections.push([40., 50., 98., 72.]);
        let (crop, x, y) = second_pass_crop(&image, &found).unwrap();
        assert_eq!((x, y, crop.dimensions()), (0, 0, (100, 80)));
        found.lines.clear();
        let (crop, x, y) = second_pass_crop(&image, &found).unwrap();
        assert_eq!((x, y, crop.dimensions()), (20, 30, (80, 50)));
    }

    fn line(text: &str) -> Recognition {
        Recognition::from_lines(vec![TextBox {
            text: text.into(),
            bounds: [1., 2., 80., 20.],
            ..Default::default()
        }])
    }
    #[test]
    fn typewriter_waits_and_keeps_the_first_capture_time() {
        let mut gate = Stability::default();
        let settings = json!({});
        let start = Instant::now();
        let mut scan = |result: Recognition, ms: u64| {
            let ready = gate.observe(
                &result,
                start + Duration::from_millis(ms),
                10_000 + u128::from(ms),
                &settings,
            );
            (ready, gate.first_seen_at())
        };
        assert_eq!(scan(line("今日"), 0), (false, Some(10_000)));
        assert_eq!(scan(line("今日は晴れです"), 500), (false, Some(10_000)));
        assert_eq!(scan(line("今日は晴れです"), 1000), (true, Some(10_000)));
        assert_eq!(scan(line("今日は晴れです"), 1500), (false, Some(10_000)));
        assert_eq!(scan(line("別の文章"), 2000), (false, Some(12_000)));
        assert_eq!(scan(Recognition::default(), 2500), (false, None));
        assert_eq!(scan(line("別の文章"), 3000), (false, Some(13_000)));
        assert_eq!(scan(line("別の文章"), 3500), (true, Some(13_000)));
    }
    #[test]
    fn nfkc_and_punctuation_match_but_new_chunks_survive() {
        assert!(duplicate(
            &["ＡＢＣ、１２３".into()],
            &["ABC123".into()],
            &json!({})
        ));
        assert!(!duplicate(
            &["これは長い長い文章です".into()],
            &["これは長い長い文章です".into(), "新規".into()],
            &json!({})
        ));
    }
    #[test]
    fn areas_crop_and_exclusions_remain_black() {
        let image = RgbaImage::from_pixel(100, 100, image::Rgba([255, 255, 255, 255]));
        let areas = json!({"coordinate_system":"percentage", "rectangles":[
            {"coordinates":[0.2,0.3,0.5,0.4]},
            {"coordinates":[0.3,0.4,0.1,0.1],"is_excluded":true}
        ]});
        let frame = prepare(&image, &areas, false, false, &json!({})).unwrap();
        assert_eq!(frame.offset, (20, 30));
        assert_eq!(frame.image.dimensions(), (50, 40));
        assert_eq!(frame.image.get_pixel(15, 15).0, [0, 0, 0, 255]);
        assert_eq!(frame.image.get_pixel(1, 1).0, [255, 255, 255, 255]);
    }
    #[test]
    fn missing_secondary_area_and_outside_area_never_scan_whole_window() {
        let image = RgbaImage::new(100, 100);
        assert!(prepare(&image, &json!({}), true, false, &json!({})).is_none());
        assert!(
            prepare(
                &image,
                &json!({"rectangles":[{"coordinates":[20,30]}]}),
                false,
                false,
                &json!({})
            )
            .is_none(),
            "malformed saved areas must not silently select the whole window"
        );
        assert!(
            prepare(
                &image,
                &json!({"rectangles":[{"coordinates":[200,0,50,50]}]}),
                false,
                false,
                &json!({})
            )
            .is_none()
        );
    }
    #[test]
    fn forcing_stability_flushes_once_and_noisy_text_has_a_deadline() {
        let start = Instant::now();
        let later = |ms| start + Duration::from_millis(ms);
        let mut gate = Stability::default();
        let forced = json!({"force_stable":true});
        assert!(gate.observe(&line("今すぐ読み取る"), start, 10_000, &forced));
        assert_eq!(gate.first_seen_at(), Some(10_000));
        assert!(!gate.observe(&line("今すぐ読み取る"), later(500), 10_500, &forced));
        let mut gate = Stability::default();
        let settings = json!({});
        assert!(!gate.observe(&line("今夜は曇りです"), start, 10_000, &settings));
        assert!(!gate.observe(&line("文字認識の揺れ"), later(500), 10_500, &settings));
        assert!(gate.observe(&line("同じ領域の文章"), later(4100), 14_100, &settings));
        assert_eq!(gate.first_seen_at(), Some(10_000));
    }
    #[test]
    fn language_filter_and_source_coordinates_survive_a_crop() {
        let prepared = Prepared {
            image: RgbaImage::new(100, 40),
            offset: (200, 300),
            excluded: vec![],
            regions: vec![],
            exclusive: vec![],
            black_holes: vec![],
        };
        let mut result = Recognition::from_lines(vec![
            TextBox {
                text: "日本語".into(),
                bounds: [0., 0., 60., 30.],
                ..Default::default()
            },
            TextBox {
                text: "English UI".into(),
                bounds: [0., 30., 60., 40.],
                ..Default::default()
            },
        ]);
        finish(
            &mut result,
            &prepared,
            &json!({"language":"ja"}),
            &json!({}),
            true,
        )
        .unwrap();
        assert_eq!(result.text, "日本語");
        assert_eq!(result.lines[0].bounds, [200., 300., 260., 330.]);
    }
    #[test]
    fn furigana_filter_works_for_automatic_and_manual_scans() {
        let image = RgbaImage::new(400, 200);
        let prepared = prepare(&image, &Value::Null, false, false, &json!({})).unwrap();
        let recognized = Recognition::from_lines(vec![
            TextBox {
                text: "かんじ".into(),
                bounds: [20., 18., 50., 28.],
                ..Default::default()
            },
            TextBox {
                text: "漢字です".into(),
                bounds: [20., 30., 100., 50.],
                ..Default::default()
            },
            TextBox {
                text: "たてがき".into(),
                bounds: [324., 30., 334., 70.],
                vertical: true,
                ..Default::default()
            },
            TextBox {
                text: "縦書きです".into(),
                bounds: [300., 25., 320., 125.],
                vertical: true,
                ..Default::default()
            },
            TextBox {
                text: "かなだけ".into(),
                bounds: [20., 120., 60., 130.],
                ..Default::default()
            },
        ]);
        for (automatic, sensitivity) in [(false, 0), (false, 20), (true, 0)] {
            let mut result = recognized.clone();
            let settings = json!({"language":"ja-JP","furigana_filter_sensitivity":sensitivity});
            assert!(!finish(&mut result, &prepared, &settings, &json!([]), automatic).unwrap());
            assert_eq!(result.text, "漢字です\n縦書きです\nかなだけ");
            assert_eq!(result.lines[1].bounds, [300., 25., 320., 125.]);
        }
    }
    #[test]
    fn reports_when_the_furigana_filter_removes_all_eligible_text() {
        let image = RgbaImage::new(100, 40);
        let prepared = prepare(&image, &Value::Null, false, false, &json!({})).unwrap();
        let mut result = line("日本語");
        assert!(
            finish(
                &mut result,
                &prepared,
                &json!({"language":"ja","furigana_filter_sensitivity":30}),
                &json!([]),
                true,
            )
            .unwrap()
        );
        assert!(result.text.is_empty());

        let mut result = line("日本語");
        assert!(
            !finish(
                &mut result,
                &prepared,
                &json!({"language":"ja","furigana_filter_sensitivity":12}),
                &json!([]),
                true,
            )
            .unwrap()
        );
        assert_eq!(result.text, "日本語");

        let mut result = line("English UI");
        assert!(
            !finish(
                &mut result,
                &prepared,
                &json!({"language":"ja","furigana_filter_sensitivity":30}),
                &json!([]),
                true,
            )
            .unwrap()
        );
        assert!(result.text.is_empty());
    }
    #[test]
    fn replacements_keep_order_and_ascii_word_boundaries() {
        assert_eq!(
            replace_literal("cat catfish 日本cat cat_", "cat", "dog"),
            "dog catfish 日本cat cat_"
        );
        let prepared = Prepared {
            image: RgbaImage::new(100, 40),
            offset: (0, 0),
            excluded: vec![],
            regions: vec![],
            exclusive: vec![],
            black_holes: vec![],
        };
        let mut result = line("日本語の文章");
        finish(
            &mut result,
            &prepared,
            &json!({"language":"ja"}),
            &json!([["日本語", "英語"], ["英語", "翻訳"]]),
            true,
        )
        .unwrap();
        assert_eq!(result.text, "翻訳の文章");
    }
    #[test]
    fn packed_regions_restore_source_coordinates_and_exclusive_text_wins() {
        let image = RgbaImage::from_pixel(1000, 1000, image::Rgba([255, 255, 255, 255]));
        let areas = json!({"rectangles":[{"coordinates":[10,20,100,40]},{"coordinates":[700,800,100,40],"is_exclusive":true}]});
        let p = prepare(
            &image,
            &areas,
            false,
            false,
            &json!({"compactBoxes":true,"compactBoxesGap":12}),
        )
        .unwrap();
        assert_eq!(p.image.dimensions(), (100, 92));
        let mut r = Recognition::from_lines(vec![
            TextBox {
                text: "通常".into(),
                bounds: [1., 1., 80., 30.],
                ..Default::default()
            },
            TextBox {
                text: "優先".into(),
                bounds: [1., 53., 80., 82.],
                ..Default::default()
            },
        ]);
        finish(&mut r, &p, &json!({"language":"ja"}), &json!([]), true).unwrap();
        assert_eq!(r.text, "優先");
        assert_eq!(r.lines[0].bounds, [701., 801., 780., 830.]);
    }
    #[test]
    fn black_hole_voids_whole_result_before_exclusive_filtering() {
        let image = RgbaImage::new(100, 100);
        let p=prepare(&image,&json!({"rectangles":[{"coordinates":[0,0,100,100]},{"coordinates":[40,0,50,30],"is_black_hole":true}]}),false,false,&json!({})).unwrap();
        let mut r = line("日本語");
        finish(&mut r, &p, &json!({}), &json!([]), true).unwrap();
        assert!(r.text.is_empty());
        let mut r = line("English");
        finish(&mut r, &p, &json!({"language":"ja"}), &json!([]), true).unwrap();
        assert!(r.text.is_empty());
    }
}
