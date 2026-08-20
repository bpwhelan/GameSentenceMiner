use std::collections::{HashSet, VecDeque};

use crate::text_filter::{contains_japanese_text, contains_kanji};

pub type LayoutInput = (
    usize,
    String,
    f64,
    f64,
    f64,
    f64,
    Option<String>,
    Option<String>,
);

pub type BoundingBoxOutput = (f64, f64, f64, f64);

#[derive(Debug, PartialEq)]
pub struct LayoutLineOutput {
    pub text: String,
    pub bounding_box: BoundingBoxOutput,
    pub source_ids: Vec<usize>,
}

#[derive(Debug, PartialEq)]
pub struct LayoutParagraphOutput {
    pub bounding_box: BoundingBoxOutput,
    pub writing_direction: String,
    pub lines: Vec<LayoutLineOutput>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct BoundingBox {
    center_x: f64,
    center_y: f64,
    width: f64,
    height: f64,
}

impl BoundingBox {
    fn left(self) -> f64 {
        self.center_x - self.width / 2.0
    }

    fn right(self) -> f64 {
        self.center_x + self.width / 2.0
    }

    fn top(self) -> f64 {
        self.center_y - self.height / 2.0
    }

    fn bottom(self) -> f64 {
        self.center_y + self.height / 2.0
    }

    fn union<'a>(boxes: impl Iterator<Item = &'a BoundingBox>) -> Self {
        let boxes = boxes.copied().collect::<Vec<_>>();
        let left = boxes
            .iter()
            .map(|bbox| bbox.left())
            .fold(f64::INFINITY, f64::min);
        let right = boxes
            .iter()
            .map(|bbox| bbox.right())
            .fold(f64::NEG_INFINITY, f64::max);
        let top = boxes
            .iter()
            .map(|bbox| bbox.top())
            .fold(f64::INFINITY, f64::min);
        let bottom = boxes
            .iter()
            .map(|bbox| bbox.bottom())
            .fold(f64::NEG_INFINITY, f64::max);
        Self {
            center_x: (left + right) / 2.0,
            center_y: (top + bottom) / 2.0,
            width: right - left,
            height: bottom - top,
        }
    }

    fn as_tuple(self) -> BoundingBoxOutput {
        (self.center_x, self.center_y, self.width, self.height)
    }
}

#[derive(Clone, Debug)]
struct Line {
    text: String,
    bounding_box: BoundingBox,
    source_ids: Vec<usize>,
    is_vertical: Option<bool>,
    is_rtl: bool,
    character_size: f64,
    has_japanese_text: bool,
    has_kanji: bool,
    is_furigana: bool,
    paragraph_id: Option<usize>,
}

#[derive(Clone, Debug)]
struct Paragraph {
    bounding_box: BoundingBox,
    lines: Vec<Line>,
    writing_direction: String,
}

#[derive(Clone, Debug)]
struct ParagraphCandidate {
    paragraph: Paragraph,
    character_size: f64,
}

#[derive(Clone, Debug)]
struct Row {
    paragraphs: Vec<Paragraph>,
    is_vertical_or_rtl: bool,
}

struct LayoutEngine<'a> {
    language: &'a str,
    image_width: f64,
    image_height: f64,
    furigana_filter: bool,
    support_center_aligned_text: bool,
    merge_close_paragraphs: bool,
}

pub fn order_layout(
    input: Vec<LayoutInput>,
    image_width: f64,
    image_height: f64,
    language: &str,
    furigana_filter: bool,
    support_center_aligned_text: bool,
    merge_close_paragraphs: bool,
) -> Vec<LayoutParagraphOutput> {
    let engine = LayoutEngine {
        language,
        image_width,
        image_height,
        furigana_filter,
        support_center_aligned_text,
        merge_close_paragraphs,
    };
    let lines = input
        .into_iter()
        .filter_map(|line| engine.create_line(line))
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return Vec::new();
    }

    let candidates = engine.create_paragraphs_from_lines(&lines);
    let paragraphs = engine.merge_close_paragraphs(&candidates);
    let rows = engine.group_paragraphs_into_rows(&paragraphs);
    let rows = engine.reorder_paragraphs_in_rows(rows);
    engine
        .flatten_rows_to_paragraphs(rows)
        .into_iter()
        .map(|paragraph| {
            let lines = paragraph
                .lines
                .into_iter()
                .map(|line| LayoutLineOutput {
                    text: line.text,
                    bounding_box: line.bounding_box.as_tuple(),
                    source_ids: line.source_ids,
                })
                .collect();
            LayoutParagraphOutput {
                bounding_box: paragraph.bounding_box.as_tuple(),
                writing_direction: paragraph.writing_direction,
                lines,
            }
        })
        .collect()
}

impl LayoutEngine<'_> {
    fn create_line(&self, input: LayoutInput) -> Option<Line> {
        let (
            source_id,
            text,
            center_x,
            center_y,
            width,
            height,
            line_direction,
            paragraph_direction,
        ) = input;
        if text.trim().is_empty() {
            return None;
        }

        let bounding_box = BoundingBox {
            center_x,
            center_y,
            width,
            height,
        };
        let direction = line_direction
            .filter(|direction| !direction.is_empty())
            .or_else(|| paragraph_direction.filter(|direction| !direction.is_empty()));
        let (is_vertical, is_rtl) = if let Some(direction) = direction {
            (
                Some(direction == "TOP_TO_BOTTOM"),
                direction == "RIGHT_TO_LEFT",
            )
        } else {
            let is_vertical = self.is_line_vertical(&text, bounding_box);
            let is_rtl = is_vertical != Some(true) && matches!(self.language, "ar" | "he");
            (is_vertical, is_rtl)
        };
        let line_dimension = if is_vertical == Some(true) {
            height
        } else {
            width
        };
        let character_count = text.chars().count();
        let character_size = if character_count > 0 {
            line_dimension / character_count as f64
        } else {
            0.0
        };

        Some(Line {
            has_japanese_text: contains_japanese_text(&text),
            has_kanji: contains_kanji(&text),
            text,
            bounding_box,
            source_ids: vec![source_id],
            is_vertical,
            is_rtl,
            character_size,
            is_furigana: false,
            paragraph_id: None,
        })
    }

    fn is_line_vertical(&self, text: &str, bounding_box: BoundingBox) -> Option<bool> {
        if text.chars().count() < 3 {
            return None;
        }
        let pixel_width = bounding_box.width * self.image_width;
        let pixel_height = bounding_box.height * self.image_height;
        if pixel_height <= 0.0 {
            return Some(false);
        }
        Some(pixel_width / pixel_height < 0.8)
    }

    fn create_paragraphs_from_lines(&self, lines: &[Line]) -> Vec<ParagraphCandidate> {
        let mut grouped = HashSet::new();
        let mut paragraphs = Vec::new();

        for (is_vertical, is_rtl) in [(true, false), (false, true), (false, false)] {
            let indices = lines
                .iter()
                .enumerate()
                .filter_map(|(index, line)| {
                    ((line.is_vertical == Some(is_vertical) || line.is_vertical.is_none())
                        && line.is_rtl == is_rtl
                        && !grouped.contains(&index))
                    .then_some(index)
                })
                .collect::<Vec<_>>();
            if indices.len() < 2 {
                continue;
            }

            let selected = indices
                .iter()
                .map(|index| lines[*index].clone())
                .collect::<Vec<_>>();
            let components = find_connected_components(
                &selected,
                |left, right| self.should_group_in_same_paragraph(left, right, is_vertical),
                |line| {
                    if is_vertical {
                        line.bounding_box.top()
                    } else if is_rtl {
                        line.bounding_box.right()
                    } else {
                        line.bounding_box.left()
                    }
                },
                |line| {
                    if is_vertical {
                        line.bounding_box.bottom()
                    } else if is_rtl {
                        line.bounding_box.left()
                    } else {
                        line.bounding_box.right()
                    }
                },
            );

            for component in components
                .into_iter()
                .filter(|component| component.len() > 1)
            {
                let original_indices = component
                    .iter()
                    .map(|index| indices[*index])
                    .collect::<Vec<_>>();
                let paragraph_lines = original_indices
                    .iter()
                    .map(|index| lines[*index].clone())
                    .collect::<Vec<_>>();
                if let Some(paragraph) =
                    self.create_paragraph_from_lines(paragraph_lines, Some(is_vertical), false)
                {
                    paragraphs.push(paragraph);
                    grouped.extend(original_indices);
                }
            }
        }

        for (index, line) in lines.iter().enumerate() {
            if !grouped.contains(&index) {
                if let Some(paragraph) =
                    self.create_paragraph_from_lines(vec![line.clone()], None, false)
                {
                    paragraphs.push(paragraph);
                }
            }
        }
        paragraphs
    }

    fn create_paragraph_from_lines(
        &self,
        mut lines: Vec<Line>,
        is_vertical: Option<bool>,
        merging_step: bool,
    ) -> Option<ParagraphCandidate> {
        if lines.is_empty() {
            return None;
        }

        let (bounding_box, writing_direction) = if lines.len() > 1 {
            if is_vertical == Some(true) {
                lines.sort_by(|left, right| {
                    right
                        .bounding_box
                        .right()
                        .total_cmp(&left.bounding_box.right())
                });
            } else {
                lines.sort_by(|left, right| {
                    left.bounding_box.top().total_cmp(&right.bounding_box.top())
                });
            }
            lines = self.merge_overlapping_lines(lines, is_vertical == Some(true));
            if !merging_step && self.furigana_filter {
                lines = self.furigana_filter_lines(&lines, is_vertical == Some(true));
            }
            if lines.is_empty() {
                return None;
            }
            let bounding_box = BoundingBox::union(lines.iter().map(|line| &line.bounding_box));
            let writing_direction = if is_vertical == Some(true) {
                "TOP_TO_BOTTOM"
            } else if lines[0].is_rtl {
                "RIGHT_TO_LEFT"
            } else {
                "LEFT_TO_RIGHT"
            };
            (bounding_box, writing_direction.to_owned())
        } else {
            let line = &lines[0];
            let writing_direction = if line.is_vertical == Some(true) {
                "TOP_TO_BOTTOM"
            } else if line.is_rtl {
                "RIGHT_TO_LEFT"
            } else {
                "LEFT_TO_RIGHT"
            };
            (line.bounding_box, writing_direction.to_owned())
        };

        if merging_step {
            let paragraph_ids = lines
                .iter()
                .filter_map(|line| line.paragraph_id)
                .collect::<HashSet<_>>();
            if paragraph_ids.len() > 1 {
                return None;
            }
        }

        let largest_line = if is_vertical == Some(true) {
            lines
                .iter()
                .max_by(|left, right| left.bounding_box.width.total_cmp(&right.bounding_box.width))
        } else {
            lines.iter().max_by(|left, right| {
                left.bounding_box
                    .height
                    .total_cmp(&right.bounding_box.height)
            })
        }?;
        let character_size = largest_line.character_size;
        Some(ParagraphCandidate {
            paragraph: Paragraph {
                bounding_box,
                lines,
                writing_direction,
            },
            character_size,
        })
    }

    fn should_group_in_same_paragraph(
        &self,
        line1: &Line,
        line2: &Line,
        is_vertical: bool,
    ) -> bool {
        let bbox1 = line1.bounding_box;
        let bbox2 = line2.bounding_box;
        let character_size = line1.character_size.max(line2.character_size);

        if is_vertical {
            let horizontal_distance = calculate_horizontal_distance(bbox1, bbox2);
            let line_width = bbox1.width.max(bbox2.width);
            if horizontal_distance >= line_width * 2.0 {
                return false;
            }
            if bbox1.top() - bbox2.top() < 2.0 * character_size {
                return true;
            }
        } else {
            let vertical_distance = calculate_vertical_distance(bbox1, bbox2);
            let maximum_line_height = bbox1.height.max(bbox2.height);
            if vertical_distance >= maximum_line_height * 2.0 {
                return false;
            }
            let (coord1, coord2) = if line1.is_rtl {
                (bbox2.right(), bbox1.right())
            } else {
                (bbox1.left(), bbox2.left())
            };
            if coord1 - coord2 < 2.0 * character_size {
                return true;
            }
            if self.support_center_aligned_text && horizontal_overlap(bbox1, bbox2) > 0.9 {
                return true;
            }
        }

        self.furigana_filter_lines(&[line1.clone(), line2.clone()], is_vertical)
            .len()
            == 1
    }

    fn merge_overlapping_lines(&self, lines: Vec<Line>, is_vertical: bool) -> Vec<Line> {
        if lines.len() < 2 {
            return lines;
        }
        let mut merged = Vec::new();
        let mut used = HashSet::new();

        for (index, current) in lines.iter().enumerate() {
            if used.contains(&index) {
                continue;
            }
            let mut group = vec![current.clone()];
            used.insert(index);
            let mut last = current;
            for (candidate_index, candidate) in lines.iter().enumerate().skip(index + 1) {
                if used.contains(&candidate_index) {
                    continue;
                }
                if should_merge_lines(last, candidate, is_vertical) {
                    group.push(candidate.clone());
                    used.insert(candidate_index);
                    last = candidate;
                }
            }
            if group.len() > 1 {
                merged.push(merge_multiple_lines(group, is_vertical));
            } else {
                merged.push(current.clone());
            }
        }
        merged
    }

    fn furigana_filter_lines(&self, lines: &[Line], is_vertical: bool) -> Vec<Line> {
        let mut filtered = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            let Some(next_line) = lines.get(index + 1) else {
                filtered.push(line.clone());
                continue;
            };
            if !(line.has_japanese_text && next_line.has_japanese_text)
                || line.has_kanji
                || !next_line.has_kanji
                || next_line.is_furigana
            {
                filtered.push(line.clone());
                continue;
            }
            if line.is_furigana {
                continue;
            }

            let current_bbox = line.bounding_box;
            let next_bbox = next_line.bounding_box;
            let passed_position = if is_vertical {
                let minimum_distance = (next_bbox.width - current_bbox.width).abs() / 2.0;
                let maximum_distance = next_bbox.width + current_bbox.width / 2.0;
                let distance = current_bbox.center_x - next_bbox.center_x;
                minimum_distance < distance
                    && distance < maximum_distance
                    && vertical_overlap(current_bbox, next_bbox) > 0.4
            } else {
                let minimum_distance = (next_bbox.height - current_bbox.height).abs() / 2.0;
                let maximum_distance = next_bbox.height + current_bbox.height / 2.0;
                let distance = next_bbox.center_y - current_bbox.center_y;
                minimum_distance < distance
                    && distance < maximum_distance
                    && horizontal_overlap(current_bbox, next_bbox) > 0.4
            };
            if !passed_position {
                filtered.push(line.clone());
                continue;
            }

            let passed_size = if is_vertical {
                line.character_size < next_line.character_size * 0.85
            } else {
                current_bbox.height < next_bbox.height * 0.85
            };
            if !passed_size {
                filtered.push(line.clone());
            }
        }
        filtered
    }

    fn merge_close_paragraphs(&self, paragraphs: &[ParagraphCandidate]) -> Vec<Paragraph> {
        if !self.merge_close_paragraphs || paragraphs.len() < 2 {
            return paragraphs
                .iter()
                .map(|candidate| candidate.paragraph.clone())
                .collect();
        }
        let mut merged = Vec::new();

        for is_vertical in [true, false] {
            let indices = paragraphs
                .iter()
                .enumerate()
                .filter_map(|(index, candidate)| {
                    ((candidate.paragraph.writing_direction == "TOP_TO_BOTTOM") == is_vertical)
                        .then_some(index)
                })
                .collect::<Vec<_>>();
            if indices.is_empty() {
                continue;
            }
            if indices.len() == 1 {
                merged.push(paragraphs[indices[0]].paragraph.clone());
                continue;
            }

            let selected = indices
                .iter()
                .map(|index| paragraphs[*index].clone())
                .collect::<Vec<_>>();
            let components = find_connected_components(
                &selected,
                |left, right| should_merge_close_paragraphs(left, right, is_vertical),
                |candidate| {
                    if is_vertical {
                        candidate.paragraph.bounding_box.left()
                    } else {
                        candidate.paragraph.bounding_box.top()
                    }
                },
                |candidate| {
                    if is_vertical {
                        candidate.paragraph.bounding_box.right()
                    } else {
                        candidate.paragraph.bounding_box.bottom()
                    }
                },
            );
            for component in components {
                let candidates = component
                    .iter()
                    .map(|index| selected[*index].clone())
                    .collect::<Vec<_>>();
                if candidates.len() == 1 {
                    merged.push(candidates[0].paragraph.clone());
                } else if let Some(paragraph) =
                    self.merge_multiple_paragraphs(&candidates, is_vertical)
                {
                    merged.push(paragraph);
                } else {
                    merged.extend(candidates.into_iter().map(|candidate| candidate.paragraph));
                }
            }
        }
        merged
    }

    fn merge_multiple_paragraphs(
        &self,
        paragraphs: &[ParagraphCandidate],
        is_vertical: bool,
    ) -> Option<Paragraph> {
        let mut lines = Vec::new();
        for (paragraph_index, candidate) in paragraphs.iter().enumerate() {
            for line in &candidate.paragraph.lines {
                let mut line = line.clone();
                line.is_vertical = Some(is_vertical);
                line.is_rtl = candidate.paragraph.writing_direction == "RIGHT_TO_LEFT";
                line.character_size = 0.0;
                line.has_japanese_text = false;
                line.has_kanji = false;
                line.is_furigana = false;
                line.paragraph_id = Some(paragraph_index + 1);
                lines.push(line);
            }
        }
        self.create_paragraph_from_lines(lines, Some(is_vertical), true)
            .map(|candidate| candidate.paragraph)
    }

    fn group_paragraphs_into_rows(&self, paragraphs: &[Paragraph]) -> Vec<Row> {
        if paragraphs.len() < 2 {
            return vec![Row {
                paragraphs: paragraphs.to_vec(),
                is_vertical_or_rtl: paragraphs
                    .first()
                    .is_some_and(|paragraph| paragraph.writing_direction != "LEFT_TO_RIGHT"),
            }];
        }
        let components = find_connected_components(
            paragraphs,
            |left, right| vertical_overlap(left.bounding_box, right.bounding_box) > 0.2,
            |paragraph| paragraph.bounding_box.top(),
            |paragraph| paragraph.bounding_box.bottom(),
        );
        components
            .into_iter()
            .map(|component| {
                let row_paragraphs = component
                    .into_iter()
                    .map(|index| paragraphs[index].clone())
                    .collect::<Vec<_>>();
                let vertical_or_rtl_count = row_paragraphs
                    .iter()
                    .filter(|paragraph| paragraph.writing_direction != "LEFT_TO_RIGHT")
                    .count();
                Row {
                    is_vertical_or_rtl: vertical_or_rtl_count * 2 >= row_paragraphs.len(),
                    paragraphs: row_paragraphs,
                }
            })
            .collect()
    }

    fn reorder_paragraphs_in_rows(&self, rows: Vec<Row>) -> Vec<Row> {
        rows.into_iter()
            .map(|mut row| {
                if row.paragraphs.len() < 2 {
                    return row;
                }
                row.paragraphs.sort_by(|left, right| {
                    left.bounding_box
                        .left()
                        .total_cmp(&right.bounding_box.left())
                });
                if row.is_vertical_or_rtl {
                    row.paragraphs.reverse();
                }
                row.paragraphs =
                    reorder_mixed_orientation_blocks(row.paragraphs, row.is_vertical_or_rtl);
                row
            })
            .collect()
    }

    fn flatten_rows_to_paragraphs(&self, mut rows: Vec<Row>) -> Vec<Paragraph> {
        rows.sort_by(|left, right| {
            let left_top = left
                .paragraphs
                .iter()
                .map(|paragraph| paragraph.bounding_box.top())
                .fold(f64::INFINITY, f64::min);
            let right_top = right
                .paragraphs
                .iter()
                .map(|paragraph| paragraph.bounding_box.top())
                .fold(f64::INFINITY, f64::min);
            left_top.total_cmp(&right_top)
        });
        rows.into_iter().flat_map(|row| row.paragraphs).collect()
    }
}

fn merge_multiple_lines(mut lines: Vec<Line>, is_vertical: bool) -> Line {
    let is_rtl = lines[0].is_rtl;
    if is_vertical {
        lines.sort_by(|left, right| {
            left.bounding_box
                .center_y
                .total_cmp(&right.bounding_box.center_y)
        });
    } else {
        lines.sort_by(|left, right| {
            left.bounding_box
                .center_x
                .total_cmp(&right.bounding_box.center_x)
        });
        if is_rtl {
            lines.reverse();
        }
    }

    let mut text = String::new();
    let mut source_ids = Vec::new();
    let mut no_space_size = 0.0;
    let mut has_japanese_text = false;
    let mut has_kanji = false;
    let mut is_furigana = false;
    for line in &lines {
        text.push_str(&line.text);
        source_ids.extend(&line.source_ids);
        no_space_size += if is_vertical {
            line.bounding_box.height
        } else {
            line.bounding_box.width
        };
        has_japanese_text |= line.has_japanese_text;
        if line.is_furigana && !has_kanji {
            is_furigana = true;
        }
        if line.has_kanji {
            is_furigana = false;
            has_kanji = true;
        }
    }
    let character_count = text.chars().count();
    let character_size = if character_count > 0 {
        no_space_size / character_count as f64
    } else {
        0.0
    };
    let bounding_box = BoundingBox::union(lines.iter().map(|line| &line.bounding_box));
    Line {
        text,
        bounding_box,
        source_ids,
        is_vertical: Some(is_vertical),
        is_rtl,
        character_size,
        has_japanese_text,
        has_kanji,
        is_furigana,
        paragraph_id: None,
    }
}

fn should_merge_lines(line1: &Line, line2: &Line, is_vertical: bool) -> bool {
    if is_vertical {
        horizontal_overlap(line1.bounding_box, line2.bounding_box) > 0.8
            && vertical_overlap(line1.bounding_box, line2.bounding_box) < 0.4
    } else {
        vertical_overlap(line1.bounding_box, line2.bounding_box) > 0.8
            && horizontal_overlap(line1.bounding_box, line2.bounding_box) < 0.4
    }
}

fn should_merge_close_paragraphs(
    paragraph1: &ParagraphCandidate,
    paragraph2: &ParagraphCandidate,
    is_vertical: bool,
) -> bool {
    let bbox1 = paragraph1.paragraph.bounding_box;
    let bbox2 = paragraph2.paragraph.bounding_box;
    let character_size = paragraph1.character_size.max(paragraph2.character_size);
    if is_vertical {
        calculate_vertical_distance(bbox1, bbox2) <= 2.0 * character_size
            && horizontal_overlap(bbox1, bbox2) > 0.9
    } else {
        paragraph1.paragraph.writing_direction == paragraph2.paragraph.writing_direction
            && calculate_horizontal_distance(bbox1, bbox2) <= 3.0 * character_size
            && vertical_overlap(bbox1, bbox2) > 0.9
    }
}

fn reorder_mixed_orientation_blocks(
    paragraphs: Vec<Paragraph>,
    row_is_vertical_or_rtl: bool,
) -> Vec<Paragraph> {
    if paragraphs.len() < 2 {
        return paragraphs;
    }
    let mut iterator = paragraphs.into_iter();
    let first = iterator.next().expect("length checked");
    let mut current_orientation = first.writing_direction != "LEFT_TO_RIGHT";
    let mut current_block = vec![first];
    let mut result = Vec::new();

    for paragraph in iterator {
        let orientation = paragraph.writing_direction != "LEFT_TO_RIGHT";
        if orientation == current_orientation {
            current_block.push(paragraph);
        } else {
            if current_orientation != row_is_vertical_or_rtl {
                current_block.reverse();
            }
            result.append(&mut current_block);
            current_block.push(paragraph);
            current_orientation = orientation;
        }
    }
    if current_orientation != row_is_vertical_or_rtl {
        current_block.reverse();
    }
    result.append(&mut current_block);
    result
}

fn calculate_horizontal_distance(bbox1: BoundingBox, bbox2: BoundingBox) -> f64 {
    if bbox1.right() < bbox2.left() {
        bbox2.left() - bbox1.right()
    } else if bbox2.right() < bbox1.left() {
        bbox1.left() - bbox2.right()
    } else {
        0.0
    }
}

fn calculate_vertical_distance(bbox1: BoundingBox, bbox2: BoundingBox) -> f64 {
    if bbox1.bottom() < bbox2.top() {
        bbox2.top() - bbox1.bottom()
    } else if bbox2.bottom() < bbox1.top() {
        bbox1.top() - bbox2.bottom()
    } else {
        0.0
    }
}

fn horizontal_overlap(bbox1: BoundingBox, bbox2: BoundingBox) -> f64 {
    let overlap = bbox1.right().min(bbox2.right()) - bbox1.left().max(bbox2.left());
    if overlap <= 0.0 {
        return 0.0;
    }
    let smaller_width = bbox1.width.min(bbox2.width);
    if smaller_width > 0.0 {
        overlap / smaller_width
    } else {
        0.0
    }
}

fn vertical_overlap(bbox1: BoundingBox, bbox2: BoundingBox) -> f64 {
    let overlap = bbox1.bottom().min(bbox2.bottom()) - bbox1.top().max(bbox2.top());
    if overlap <= 0.0 {
        return 0.0;
    }
    let smaller_height = bbox1.height.min(bbox2.height);
    if smaller_height > 0.0 {
        overlap / smaller_height
    } else {
        0.0
    }
}

fn find_connected_components<T, Connect, Start, End>(
    items: &[T],
    should_connect: Connect,
    start_coordinate: Start,
    end_coordinate: End,
) -> Vec<Vec<usize>>
where
    Connect: Fn(&T, &T) -> bool,
    Start: Fn(&T) -> f64,
    End: Fn(&T) -> f64,
{
    let mut graph = vec![Vec::new(); items.len()];
    let mut sorted = (0..items.len()).collect::<Vec<_>>();
    sorted.sort_by(|left, right| {
        start_coordinate(&items[*left]).total_cmp(&start_coordinate(&items[*right]))
    });
    let mut active: Vec<(usize, f64)> = Vec::new();

    for original_index in sorted {
        let current_start = start_coordinate(&items[original_index]);
        active.retain(|(_, active_end)| *active_end > current_start);
        for (active_index, _) in &active {
            if should_connect(&items[original_index], &items[*active_index]) {
                graph[original_index].push(*active_index);
                graph[*active_index].push(original_index);
            }
        }
        active.push((original_index, end_coordinate(&items[original_index])));
    }

    let mut visited = HashSet::new();
    let mut components = Vec::new();
    for index in 0..items.len() {
        if !visited.insert(index) {
            continue;
        }
        let mut component = Vec::new();
        let mut queue = VecDeque::from([index]);
        while let Some(node) = queue.pop_front() {
            component.push(node);
            for neighbor in &graph[node] {
                if visited.insert(*neighbor) {
                    queue.push_back(*neighbor);
                }
            }
        }
        components.push(component);
    }
    components
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn horizontal_lines_are_ordered_top_to_bottom() {
        let result = order_layout(
            vec![
                (
                    0,
                    "二行目".to_owned(),
                    0.5,
                    0.35,
                    0.5,
                    0.1,
                    None,
                    Some("LEFT_TO_RIGHT".to_owned()),
                ),
                (
                    1,
                    "一行目".to_owned(),
                    0.5,
                    0.15,
                    0.5,
                    0.1,
                    None,
                    Some("LEFT_TO_RIGHT".to_owned()),
                ),
            ],
            1000.0,
            1000.0,
            "ja",
            false,
            true,
            true,
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].lines[0].text, "一行目");
        assert_eq!(result[0].lines[1].text, "二行目");
    }
}
