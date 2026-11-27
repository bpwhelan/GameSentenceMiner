use crate::text_filter::is_comparable;

pub type OverlayFilterInput = (usize, String, Vec<(usize, String)>);

#[derive(Debug, PartialEq, Eq)]
pub struct OverlayFilterDecision {
    pub source_id: usize,
    pub use_words: bool,
    pub source_word_ids: Vec<usize>,
}

pub fn filter_overlay_language(
    language: &str,
    lines: Vec<OverlayFilterInput>,
) -> Vec<OverlayFilterDecision> {
    lines
        .into_iter()
        .filter_map(|(source_id, line_text, words)| {
            let line_matches = matches_overlay_language(&line_text, language);
            if !words.is_empty() {
                let source_word_ids = words
                    .iter()
                    .filter_map(|(word_id, text)| is_visible(text).then_some(*word_id))
                    .collect::<Vec<_>>();
                let word_matches = words
                    .iter()
                    .any(|(_, text)| matches_overlay_language(text, language));
                if !source_word_ids.is_empty() && (line_matches || word_matches) {
                    return Some(OverlayFilterDecision {
                        source_id,
                        use_words: true,
                        source_word_ids,
                    });
                }
            }

            line_matches.then_some(OverlayFilterDecision {
                source_id,
                use_words: false,
                source_word_ids: Vec::new(),
            })
        })
        .collect()
}

fn is_visible(text: &str) -> bool {
    text.chars().any(|character| !character.is_whitespace())
}

fn matches_overlay_language(text: &str, language: &str) -> bool {
    text.chars().any(|character| {
        is_comparable(character, language)
            || matches!(character, '々' | '〆' | '〇' | '〻' | 'ヶ' | 'ヵ')
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_visible_words_when_line_matches_target_script() {
        let result = filter_overlay_language(
            "ja",
            vec![
                (
                    0,
                    "HP です".to_owned(),
                    vec![(0, "HP".to_owned()), (1, "です".to_owned())],
                ),
                (1, "hello".to_owned(), vec![]),
            ],
        );

        assert_eq!(
            result,
            vec![OverlayFilterDecision {
                source_id: 0,
                use_words: true,
                source_word_ids: vec![0, 1],
            }]
        );
    }

    #[test]
    fn keeps_extended_cjk_iteration_marks() {
        let result = filter_overlay_language("ja", vec![(0, "々".to_owned(), vec![])]);

        assert_eq!(
            result,
            vec![OverlayFilterDecision {
                source_id: 0,
                use_words: false,
                source_word_ids: vec![],
            }]
        );
    }
}
