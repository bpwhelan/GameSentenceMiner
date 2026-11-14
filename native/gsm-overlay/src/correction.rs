//! Correct equal-length recognition mistakes without moving glyph hit boxes.
use crate::{
    pipeline::TextBox,
    text_matching::{match_metrics, matching_blocks},
};
use std::collections::VecDeque;

#[derive(Default)]
pub struct History(VecDeque<String>);
impl History {
    pub fn clear(&mut self) {
        self.0.clear();
    }
    pub fn apply(&mut self, lines: &mut [TextBox], current: &str) {
        if current.is_empty() || current.chars().count() > 4096 {
            return;
        }
        let text = lines.iter().map(|l| l.text.as_str()).collect::<String>();
        if text.chars().count() > 10000 {
            return;
        }
        self.0.retain(|past| {
            let size = past.chars().count().max(1);
            if match_metrics(past, current, 1).matched * 2 >= size {
                return true;
            }
            if match_metrics(past, &text, 1).matched * 100 < size * 80 {
                return true;
            }
            correct(lines, past);
            false
        });
        correct(lines, current);
        if self.0.back().is_none_or(|p| p != current) {
            self.0.push_back(current.into());
        }
        while self.0.len() > 8 {
            self.0.pop_front();
        }
    }
}

fn correct(lines: &mut [TextBox], reference: &str) {
    let mut buffers = Vec::<(usize, Option<usize>, Vec<char>)>::new();
    for (i, line) in lines.iter().enumerate() {
        if line.words.is_empty() {
            buffers.push((i, None, line.text.chars().collect()));
        } else {
            for (j, word) in line.words.iter().enumerate() {
                buffers.push((i, Some(j), word.text.chars().collect()));
            }
        }
    }
    let mut chars = buffers
        .iter()
        .flat_map(|(_, _, s)| s.iter().copied())
        .collect::<Vec<_>>();
    if chars.len() > 10000 {
        return;
    }
    for (a, b) in [('冗', '談'), ('痙', '攣')] {
        if reference.contains(&format!("{a}{b}")) {
            for i in 0..chars.len().saturating_sub(1) {
                if chars[i] == b && chars[i + 1] == a {
                    chars.swap(i, i + 1);
                }
            }
        }
    }
    let text = chars.iter().collect::<String>();
    let target = reference.chars().collect::<Vec<_>>();
    let mut blocks = matching_blocks(&text, reference);
    // Refuse unrelated hook text, retaining menus and nameplates as recognized.
    if blocks.iter().map(|b| b.2).sum::<usize>() * 2 < target.len().min(chars.len()) {
        return;
    }
    blocks.push((chars.len(), target.len(), 0));
    let (mut a, mut b) = (0, 0);
    for (i, j, n) in blocks {
        if i - a == j - b && i > a {
            chars[a..i].copy_from_slice(&target[b..j]);
        }
        a = i + n;
        b = j + n;
    }
    let mut offset = 0;
    for (i, j, old) in buffers {
        let text = chars[offset..offset + old.len()].iter().collect::<String>();
        offset += old.len();
        if let Some(j) = j {
            lines[i].words[j].text = text;
        } else {
            lines[i].text = text;
        }
    }
    for line in lines {
        if !line.words.is_empty() {
            line.text = line.words.iter().map(|w| w.text.as_str()).collect();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repairs_current_and_backlog_without_changing_word_boxes_or_menu_text() {
        let mut h = History::default();
        let make = |text: &str| TextBox {
            text: text.into(),
            bounds: [10., 20., 80., 50.],
            ..Default::default()
        };
        let mut first = vec![make("今日は良い天気ですね。")];
        h.apply(&mut first, "今日は良い天気ですね。");
        let mut lines = vec![
            make("今日は良ぃ天気ですね。"),
            make("明日は雨が降りま才。"),
            make("設定"),
        ];
        h.apply(&mut lines, "明日は雨が降ります。");
        assert_eq!(lines[0].text, "今日は良い天気ですね。");
        assert_eq!(lines[1].text, "明日は雨が降ります。");
        assert_eq!(lines[2].text, "設定");
        assert_eq!(lines[0].bounds, [10., 20., 80., 50.]);
        let mut line = make("これは談冗です。");
        line.words = vec![make("これは"), make("談冗"), make("です。")];
        correct(std::slice::from_mut(&mut line), "これは冗談です。");
        assert_eq!(line.words[1].text, "冗談");
    }
}
