// SPDX-License-Identifier: MPL-2.0
use super::*;
use image::imageops::FilterType;

pub(super) struct Decoder {
    model: Model,
    tokens: Vec<String>,
    pixels_per_frame: u32,
    start_shift: f32,
    end_shift: f32,
    space_width: f32,
}
fn pairs(path: PathBuf) -> Result<Vec<(String, String)>> {
    Ok(fs::read_to_string(&path)
        .with_context(|| format!("Read {}", path.display()))?
        .trim_start_matches('\u{feff}')
        .lines()
        .filter_map(|line| {
            let (a, b) = line.trim_end_matches('\r').rsplit_once(' ')?;
            Some((a.to_owned(), b.to_owned()))
        })
        .collect())
}
impl Decoder {
    pub(super) fn load(root: &Path, entry: &Value) -> Result<Self> {
        let raw = pairs(resource(root, &entry["phone_to_idx_path"])?)?;
        let composite = entry
            .get("composite_chars_map_path")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty());
        let replacements: HashMap<_, _> = if let Some(path) = composite {
            pairs(resource(root, &Value::from(path))?)?
                .into_iter()
                .collect()
        } else {
            HashMap::new()
        };
        let mut tokens = Vec::new();
        for (symbol, index) in raw {
            let index = index.parse::<usize>()?;
            ensure!(index < 250_000, "Invalid OneOCR character index");
            if tokens.len() <= index {
                tokens.resize(index + 1, String::new());
            }
            tokens[index] = replacements.get(&symbol).cloned().unwrap_or(symbol);
        }
        ensure!(
            tokens.iter().any(|t| t == "<blank>"),
            "OneOCR alphabet has no blank token"
        );
        let pixels_per_frame = entry["pixels_per_frame"]
            .as_u64()
            .or_else(|| entry["pixels_per_frame"].as_str()?.parse().ok())
            .unwrap_or(4)
            .clamp(1, 32) as u32;
        let pixels = |key: &str, default: i32| {
            entry[key]
                .as_i64()
                .and_then(|n| i32::try_from(n).ok())
                .or_else(|| entry[key].as_str()?.parse().ok())
                .unwrap_or(default) as f32
        };
        Ok(Self {
            model: model(root, entry)?,
            tokens,
            pixels_per_frame,
            start_shift: pixels("start_frame_shift", 0),
            end_shift: pixels("end_frame_shift", 0),
            space_width: pixels("pixels_per_space", 12),
        })
    }
    pub(super) fn recognize(
        &mut self,
        image: &RgbaImage,
        line: &Line,
        flip: bool,
        script: usize,
    ) -> Result<Option<TextBox>> {
        let step = self.pixels_per_frame;
        let width = (image.width() + step - image.width() % step).max(16);
        let img = imageops::resize(image, width, 60, FilterType::Triangle);
        let data = tensor(&img, true, 1. / 255.)?;
        let seq = Tensor::from_array(([1usize], vec![(width / step) as i32].into_boxed_slice()))?;
        let runs = self.model.infer(|session| {
            let output = session.run(ort::inputs!["data"=>&data,"seq_lengths"=>&seq])?;
            let (shape, probs) = output["logsoftmax"].try_extract_tensor::<f32>()?;
            let classes =
                usize::try_from(*shape.last().context("Recognizer returned no classes")?)?;
            ensure!(
                classes > 0 && probs.len() % classes == 0,
                "Invalid OneOCR recognizer output"
            );
            let frames = probs.len() / classes;
            let mut runs: Vec<(usize, f32, f32, f32)> = Vec::new();
            for (t, scores) in probs.chunks_exact(classes).enumerate() {
                let (idx, score) = scores
                    .iter()
                    .enumerate()
                    .max_by(|a, b| a.1.total_cmp(b.1))
                    .unwrap();
                let end = (t + 1) as f32 / frames as f32;
                if let Some(last) = runs.last_mut().filter(|r| r.0 == idx) {
                    last.2 = end;
                    last.3 = last.3.max(*score);
                } else {
                    runs.push((idx, t as f32 / frames as f32, end, *score));
                }
            }
            Ok(runs)
        })?;
        let mut spans = Vec::new();
        let mut sentence = String::new();
        let mut current = String::new();
        let (mut start, mut end) = (0., 0.);
        let mut confidence = 0.;
        let mut letters = 0;
        let flush = |spans: &mut Vec<_>, s: &mut String, lo: f32, hi: f32| {
            if !s.is_empty() {
                spans.push((std::mem::take(s), lo, hi));
            }
        };
        for (id, lo, hi, score) in runs {
            let Some(symbol) = self.tokens.get(id) else {
                continue;
            };
            if symbol == "<space>" || symbol == "<trash_as_space>" {
                flush(&mut spans, &mut current, start, end);
                if !sentence.is_empty() && !sentence.ends_with(' ') {
                    sentence.push(' ');
                }
                continue;
            }
            if symbol.is_empty() || symbol.starts_with('<') && symbol.ends_with('>') {
                continue;
            }
            let single = script == 1
                && symbol.chars().any(|c| {
                    matches!(c as u32,
                0x3000..=0x30ff | 0x3400..=0x9fff | 0xac00..=0xd7af | 0x20000..=0x323af)
                });
            if single {
                flush(&mut spans, &mut current, start, end);
            }
            if current.is_empty() {
                start = lo;
            }
            end = hi;
            current.push_str(symbol);
            sentence.push_str(symbol);
            confidence += score;
            letters += 1;
            if single {
                flush(&mut spans, &mut current, start, end);
            }
        }
        flush(&mut spans, &mut current, start, end);
        let mut text = sentence.trim_end().to_owned();
        if text.is_empty() || letters == 0 || confidence / (letters as f32) < -3. {
            return Ok(None);
        }
        // A CTC peak identifies the letter's anchor, not its visual width.
        // Apply this recognizer's pixel offsets and reserve the next word's space.
        let scale = width as f32;
        let mut words = Vec::with_capacity(spans.len());
        let mut previous_end = 0.0_f32;
        let mut spans = spans.into_iter().peekable();
        while let Some((text, start, end)) = spans.next() {
            let lo = (start + self.start_shift / scale).clamp(previous_end, 1.);
            let limit = spans.peek().map_or(1., |(_, next, _)| {
                next + (self.start_shift - self.space_width) / scale
            });
            let hi = (end + (self.end_shift - step as f32) / scale)
                .min(limit)
                .max(lo + step as f32 / scale)
                .min(1.);
            previous_end = hi;
            let (lo, hi) = if flip { (1. - hi, 1. - lo) } else { (lo, hi) };
            words.push(TextBox {
                text,
                bounds: line.bounds(lo, hi),
                words: Vec::new(),
                vertical: line.vertical,
            });
        }
        if matches!(script, 4 | 8) {
            text = logical_text(&text);
            words.reverse();
            for word in &mut words {
                word.text = logical_text(&word.text);
            }
        }
        Ok(Some(TextBox {
            text,
            bounds: line.bounds(0., 1.),
            words,
            vertical: line.vertical,
        }))
    }
}

// Recognition emits glyphs in visual order. Keep European digits and Latin
// runs in reading order within a right-to-left line.
fn logical_text(text: &str) -> String {
    let mut chars: Vec<_> = text.chars().rev().collect();
    let mut start = 0;
    while start < chars.len() {
        if chars[start].is_ascii_alphanumeric() {
            let mut end = start + 1;
            while end < chars.len() && chars[end].is_ascii_alphanumeric() {
                end += 1;
            }
            chars[start..end].reverse();
            start = end;
        } else {
            start += 1;
        }
    }
    chars.into_iter().collect()
}
