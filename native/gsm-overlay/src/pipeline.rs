use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TextBox {
    pub text: String,
    pub bounds: [f64; 4],
    #[serde(default)]
    pub words: Vec<TextBox>,
    #[serde(default)]
    pub vertical: bool,
}
impl TextBox {
    pub fn character_size(&self) -> f64 {
        if self.vertical {
            self.bounds[2] - self.bounds[0]
        } else {
            self.bounds[3] - self.bounds[1]
        }
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Recognition {
    pub text: String,
    pub lines: Vec<TextBox>,
    #[serde(default)]
    pub detections: Vec<[f64; 4]>,
    #[serde(default)]
    pub model: Value,
}
impl Recognition {
    pub fn from_lines(lines: Vec<TextBox>) -> Self {
        Self {
            text: lines
                .iter()
                .map(|l| l.text.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            lines,
            ..Self::default()
        }
    }
}
pub fn remap_line(line: &mut TextBox, offset: (f64, f64), scale: (f64, f64)) {
    for i in [0, 2] {
        line.bounds[i] = line.bounds[i] * scale.0 + offset.0;
    }
    for i in [1, 3] {
        line.bounds[i] = line.bounds[i] * scale.1 + offset.1;
    }
    for word in &mut line.words {
        remap_line(word, offset, scale);
    }
}

pub fn from_legacy(value: &Value) -> Option<TextBox> {
    let b = &value["bounding_rect"];
    let xs = [
        b["x1"].as_f64()?,
        b["x2"].as_f64()?,
        b["x3"].as_f64()?,
        b["x4"].as_f64()?,
    ];
    let ys = [
        b["y1"].as_f64()?,
        b["y2"].as_f64()?,
        b["y3"].as_f64()?,
        b["y4"].as_f64()?,
    ];
    let bounds = [
        xs.into_iter().fold(f64::INFINITY, f64::min),
        ys.into_iter().fold(f64::INFINITY, f64::min),
        xs.into_iter().fold(f64::NEG_INFINITY, f64::max),
        ys.into_iter().fold(f64::NEG_INFINITY, f64::max),
    ];
    Some(TextBox {
        text: value["text"].as_str()?.into(),
        bounds,
        words: value["words"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(from_legacy)
            .collect(),
        vertical: bounds[3] - bounds[1] > bounds[2] - bounds[0],
    })
}

/// Convert the existing OCR/texthook coordinate contract to this scan's pixels.
pub fn precomputed(value: &Value, p: &Projection) -> Option<Vec<TextBox>> {
    if value["schema"] != "gsm_overlay_coords_v1" {
        return None;
    }
    let space = &value["coordinate_space"];
    let width = space["source_width"].as_f64().filter(|n| *n > 0.)?;
    let height = space["source_height"].as_f64().filter(|n| *n > 0.)?;
    let mut lines: Vec<_> = value["lines"]
        .as_array()?
        .iter()
        .filter_map(from_legacy)
        .collect();
    let (offset, scale) = if space["mode"] == "absolute_screen" {
        let sx = p.image_size.0 as f64 / p.capture[2];
        let sy = p.image_size.1 as f64 / p.capture[3];
        (
            (
                (space["capture_origin"]["x"].as_f64().unwrap_or(0.) - p.capture[0]) * sx,
                (space["capture_origin"]["y"].as_f64().unwrap_or(0.) - p.capture[1]) * sy,
            ),
            (sx, sy),
        )
    } else {
        (
            (0., 0.),
            (
                p.image_size.0 as f64 / width,
                p.image_size.1 as f64 / height,
            ),
        )
    };
    for line in &mut lines {
        remap_line(line, offset, scale);
    }
    Some(lines)
}

pub fn overlaps(a: &TextBox, b: &TextBox) -> bool {
    let w = (a.bounds[2].min(b.bounds[2]) - a.bounds[0].max(b.bounds[0])).max(0.);
    let h = (a.bounds[3].min(b.bounds[3]) - a.bounds[1].max(b.bounds[1])).max(0.);
    w * h > 0.5 * (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1])
}

#[derive(Clone, Debug, PartialEq)]
pub struct Projection {
    /// Physical desktop coordinates, including negative monitor origins.
    pub monitor: [f64; 4],
    pub capture: [f64; 4],
    pub image_size: (u32, u32),
}

pub(crate) fn order_lines(
    lines: &[TextBox],
    language: &str,
    furigana_filter: bool,
) -> Vec<crate::layout::LayoutParagraphOutput> {
    let input = lines
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let [left, top, right, bottom] = l.bounds;
            let direction = if l.vertical {
                "TOP_TO_BOTTOM"
            } else {
                "LEFT_TO_RIGHT"
            };
            (
                i,
                l.text.clone(),
                (left + right) / 2.,
                (top + bottom) / 2.,
                right - left,
                bottom - top,
                Some(direction.into()),
                None,
            )
        })
        .collect();
    // TextBox bounds are already in pixels.
    crate::layout::order_layout(input, 1., 1., language, furigana_filter, true, false)
}

fn union(words: &[TextBox]) -> [f64; 4] {
    words.iter().fold(
        [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ],
        |mut b, w| {
            b[0] = b[0].min(w.bounds[0]);
            b[1] = b[1].min(w.bounds[1]);
            b[2] = b[2].max(w.bounds[2]);
            b[3] = b[3].max(w.bounds[3]);
            b
        },
    )
}

/// Group scene text into spatial blocks without joining separate screen regions.
pub fn text_blocks(recognition: Recognition, language: &str) -> Vec<String> {
    if recognition.lines.is_empty() {
        return recognition
            .text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(str::to_owned)
            .collect();
    }
    let (positioned, unpositioned): (Vec<_>, Vec<_>) = recognition
        .lines
        .into_iter()
        .filter(|line| !line.text.trim().is_empty())
        .flat_map(|line| visual_lines(line, language))
        .partition(|line| line.bounds[2] > line.bounds[0] && line.bounds[3] > line.bounds[1]);
    order_lines(&positioned, language, language == "ja")
        .into_iter()
        .map(|block| {
            block
                .lines
                .into_iter()
                .map(|line| line.text)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .chain(unpositioned.into_iter().map(|line| line.text))
        .filter(|text| !text.trim().is_empty())
        .collect()
}

/// Some engines put wrapped rows into one line. Split on word geometry before
/// paragraph grouping, so lookups and translations share the visible reading order.
fn visual_lines(line: TextBox, language: &str) -> Vec<TextBox> {
    if line.words.len() < 2 {
        return vec![line];
    }
    let axis = if line.vertical { 0 } else { 1 };
    let mut rows: Vec<Vec<TextBox>> = Vec::new();
    for word in &line.words {
        let center = (word.bounds[axis] + word.bounds[axis + 2]) / 2.;
        if let Some(row) = rows.iter_mut().find(|row| {
            let b = union(row);
            (center - (b[axis] + b[axis + 2]) / 2.).abs()
                < 0.6 * (b[axis + 2] - b[axis]).max(word.bounds[axis + 2] - word.bounds[axis])
        }) {
            row.push(word.clone());
        } else {
            rows.push(vec![word.clone()]);
        }
    }
    if rows.len() == 1 {
        return vec![line];
    }
    rows.sort_by(|a, b| {
        let order = union(a)[axis].total_cmp(&union(b)[axis]);
        if line.vertical {
            order.reverse()
        } else {
            order
        }
    });
    rows.into_iter()
        .map(|mut words| {
            let along = 1 - axis;
            words.sort_by(|a, b| a.bounds[along].total_cmp(&b.bounds[along]));
            let separator = if matches!(language, "ja" | "zh" | "th" | "lo" | "km" | "my" | "bo") {
                ""
            } else {
                " "
            };
            TextBox {
                text: words
                    .iter()
                    .map(|w| w.text.trim())
                    .collect::<Vec<_>>()
                    .join(separator),
                bounds: union(&words),
                words,
                vertical: line.vertical,
            }
        })
        .collect()
}

pub fn prepare(
    lines: Vec<TextBox>,
    language: &str,
    minimum: f64,
    filter: bool,
    projection: &Projection,
) -> Value {
    let mut output = Vec::new();
    let mut blocks = Vec::new();
    let valid = |b: &[f64; 4]| b.iter().all(|v| v.is_finite()) && b[2] > b[0] && b[3] > b[1];
    if projection.image_size.0 == 0
        || projection.image_size.1 == 0
        || projection.monitor[2] <= 0.
        || projection.monitor[3] <= 0.
    {
        return json!({"type":"word_coordinates","data":[],"native_layout":true,"blocks":[]});
    }
    let mut lines: Vec<_> = lines
        .into_iter()
        .filter(|l| valid(&l.bounds) && l.character_size() >= minimum && !l.text.trim().is_empty())
        .collect();
    lines.retain_mut(|line| {
        let count = line.words.len();
        for word in &mut line.words {
            word.vertical = line.vertical;
        }
        line.words
            .retain(|w| valid(&w.bounds) && w.character_size() >= minimum);
        if count > 0 && line.words.is_empty() {
            return false;
        }
        if line.words.len() != count {
            line.text = line
                .words
                .iter()
                .map(|w| w.text.as_str())
                .collect::<String>();
            line.bounds = union(&line.words);
        }
        true
    });
    lines = lines
        .into_iter()
        .flat_map(|line| visual_lines(line, language))
        .collect();
    if filter {
        let decisions = crate::overlay_filter::filter_overlay_language(
            language,
            lines
                .iter()
                .enumerate()
                .map(|(i, l)| {
                    (
                        i,
                        l.text.clone(),
                        l.words
                            .iter()
                            .enumerate()
                            .map(|(j, w)| (j, w.text.clone()))
                            .collect(),
                    )
                })
                .collect(),
        );
        lines = decisions
            .iter()
            .map(|d| lines[d.source_id].clone())
            .collect();
    }
    let paragraphs = order_lines(&lines, language, filter && language == "ja");
    let box_json = |b: [f64; 4]| {
        let x = |v| {
            (v * projection.capture[2] / projection.image_size.0 as f64 + projection.capture[0]
                - projection.monitor[0])
                / projection.monitor[2]
        };
        let y = |v| {
            (v * projection.capture[3] / projection.image_size.1 as f64 + projection.capture[1]
                - projection.monitor[1])
                / projection.monitor[3]
        };
        json!({"x1":x(b[0]),"y1":y(b[1]),"x2":x(b[2]),"y2":y(b[1]),"x3":x(b[2]),"y3":y(b[3]),"x4":x(b[0]),"y4":y(b[3])})
    };
    let spaced = !matches!(
        language,
        "ja" | "zh" | "ko" | "th" | "lo" | "km" | "my" | "bo"
    );
    for (id, paragraph) in paragraphs.into_iter().enumerate() {
        let start = output.len();
        for ordered in paragraph.lines {
            let (cx, cy, w, h) = ordered.bounding_box;
            let mut words = Vec::new();
            for source in ordered.source_ids {
                let line = &lines[source];
                let source_words = if line.words.is_empty() {
                    std::slice::from_ref(line)
                } else {
                    &line.words
                };
                for word in source_words {
                    let text = if spaced {
                        format!("{} ", word.text.trim_end())
                    } else {
                        word.text.clone()
                    };
                    words.push(json!({"text":text,"bounding_rect":box_json(word.bounds)}));
                }
            }
            output.push(json!({"text":ordered.text,"bounding_rect":box_json([cx-w/2.,cy-h/2.,cx+w/2.,cy+h/2.]),"words":words,"block_id":id,"is_vertical":paragraph.writing_direction=="TOP_TO_BOTTOM"}));
        }
        if output.len() > start {
            blocks.push(json!({"id":id,"start":start,"end":output.len()-1,"role":"text"}));
        }
    }
    json!({"type":"word_coordinates","data":output,"native_layout":true,"blocks":blocks,"is_sentence_recycled":false})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn line(text: &str, b: [f64; 4]) -> TextBox {
        TextBox {
            text: text.into(),
            bounds: b,
            ..Default::default()
        }
    }
    fn projection() -> Projection {
        Projection {
            monitor: [-1920., 0., 1920., 1080.],
            capture: [-1820., 100., 1000., 600.],
            image_size: (500, 300),
        }
    }
    #[test]
    fn scene_blocks_keep_wrapped_dialogue_separate_from_the_menu() {
        let scene = Recognition::from_lines(vec![
            line("設定", [720., 40., 760., 62.]),
            line("今日の放課後は", [100., 480., 240., 502.]),
            line("図書館で待とう", [100., 508., 240., 530.]),
        ]);
        let blocks = text_blocks(scene, "ja");
        assert_eq!(blocks.len(), 2);
        assert!(blocks.contains(&"設定".into()));
        assert!(blocks.contains(&"今日の放課後は\n図書館で待とう".into()));
    }
    #[test]
    fn projection_handles_scaled_window_on_negative_monitor() {
        let result = prepare(
            vec![line("テスト", [50., 50., 150., 70.])],
            "ja",
            0.,
            true,
            &projection(),
        );
        assert!(
            (result["data"][0]["bounding_rect"]["x1"].as_f64().unwrap() - 200. / 1920.).abs()
                < 1e-9
        );
        assert!(
            (result["data"][0]["bounding_rect"]["y1"].as_f64().unwrap() - 200. / 1080.).abs()
                < 1e-9
        );
        assert_eq!(result["native_layout"], true);
    }
    #[test]
    fn language_and_size_filters_preserve_valid_words() {
        let result = prepare(
            vec![
                line("MENU", [0., 0., 80., 20.]),
                line("かな", [0., 30., 80., 35.]),
                line("日本語", [0., 60., 80., 80.]),
            ],
            "ja",
            10.,
            true,
            &projection(),
        );
        assert_eq!(result["data"].as_array().unwrap().len(), 1);
        assert_eq!(result["data"][0]["text"], "日本語");
    }
    #[test]
    fn japanese_overlay_filters_furigana_with_text_filtering_enabled() {
        let lines = vec![
            line("にほんご", [10., 18., 50., 28.]),
            line("日本語の文章", [10., 30., 130., 50.]),
        ];
        let filtered = prepare(lines.clone(), "ja", 0., true, &projection());
        assert_eq!(filtered["data"].as_array().unwrap().len(), 1);
        assert_eq!(filtered["data"][0]["text"], "日本語の文章");

        let unfiltered = prepare(lines, "ja", 0., false, &projection());
        assert_eq!(unfiltered["data"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn separate_choices_do_not_join_dialogue() {
        let result = prepare(
            vec![
                line("一つ目", [20., 10., 120., 30.]),
                line("二つ目", [20., 110., 120., 130.]),
            ],
            "ja",
            0.,
            true,
            &projection(),
        );
        assert_eq!(result["blocks"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn invalid_geometry_is_discarded() {
        let result = prepare(
            vec![line("日本語", [f64::NAN, 0., 1., 2.])],
            "ja",
            0.,
            true,
            &projection(),
        );
        assert_eq!(result["data"], json!([]));
    }
    #[test]
    fn recorded_oneocr_dialogue_groups_without_losing_words() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../GSM_Overlay/tests/fixtures/wrapped-dialogue-oneocr.json"
        ))
        .unwrap();
        let source = fixture["lines"].as_array().unwrap();
        let lines = source.iter().filter_map(from_legacy).collect();
        let p = Projection {
            monitor: [0., 0., 2560., 1440.],
            capture: [0., 0., 2560., 1440.],
            image_size: (2560, 1440),
        };
        let output = prepare(lines, "ja", 0., true, &p);
        assert_eq!(output["blocks"].as_array().unwrap().len(), 1);
        assert_eq!(
            output["data"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| l["words"].as_array().unwrap().len())
                .sum::<usize>(),
            source
                .iter()
                .map(|l| l["words"].as_array().unwrap().len())
                .sum::<usize>()
        );
    }
    #[test]
    fn wrapped_engine_line_is_split_using_word_geometry() {
        let mut source = line("一行目二行目", [0., 0., 100., 60.]);
        source.words = vec![
            line("一行目", [0., 0., 100., 20.]),
            line("二行目", [0., 40., 100., 60.]),
        ];
        let lines = visual_lines(source, "ja");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "一行目");
        assert_eq!(lines[1].bounds, [0., 40., 100., 60.]);
    }
    #[test]
    fn removing_small_words_does_not_restore_them_as_a_whole_line() {
        let mut source = line("かな", [0., 0., 100., 40.]);
        source.words = vec![line("かな", [0., 0., 40., 4.])];
        let result = prepare(vec![source], "ja", 10., true, &projection());
        assert_eq!(result["data"], json!([]));
    }
    #[test]
    fn absolute_precomputed_boxes_keep_capture_origin() {
        let value = json!({"schema":"gsm_overlay_coords_v1","coordinate_space":{"mode":"absolute_screen","source_width":1000,"source_height":600,"capture_origin":{"x":-1800,"y":100}},"lines":[{"text":"日本語","bounding_rect":{"x1":0,"x2":80,"x3":80,"x4":0,"y1":20,"y2":20,"y3":40,"y4":40}}]});
        let p = projection();
        let result = prepare(precomputed(&value, &p).unwrap(), "ja", 0., true, &p);
        assert!(
            (result["data"][0]["bounding_rect"]["x1"].as_f64().unwrap() - 120. / 1920.).abs()
                < 1e-9
        );
    }
}
