use super::normalize_translation_source;
use std::collections::{HashMap, HashSet};

#[derive(Default)]
pub struct CharacterContext {
    pub summary: String,
    pub names: Vec<Vec<String>>,
}

#[derive(Default)]
struct NameForms {
    explicit: HashSet<String>,
    parts: HashSet<String>,
}

impl NameForms {
    fn add(&mut self, name: &str, split: bool) {
        let name = name.trim_matches(|c: char| c.is_whitespace() || matches!(c, '*' | '-' | '•'));
        let explicit = name_key(name);
        if explicit.is_empty() {
            return;
        }
        self.explicit.insert(explicit);
        if split {
            let mut words = name.split_whitespace();
            if let (Some(first), Some(last)) = (words.next(), words.next_back()) {
                self.parts.extend([name_key(first), name_key(last)]);
            }
        }
    }

    fn all(&self) -> impl Iterator<Item = &String> {
        self.explicit.iter().chain(&self.parts)
    }
}

impl CharacterContext {
    pub(super) fn relevant_to(&self, sentence: &str, dialogue: &str) -> String {
        if self.summary.trim().is_empty() {
            return String::new();
        }
        let mut characters: HashMap<String, NameForms> = HashMap::new();
        for names in &self.names {
            let identity = names
                .iter()
                .map(|name| name_key(name))
                .find(|name| !name.is_empty());
            if let Some(identity) = identity {
                let known = characters.entry(identity).or_default();
                for (index, name) in names.iter().enumerate() {
                    known.add(name, index < 2);
                }
            }
        }
        let entries: Vec<_> = self
            .summary
            .lines()
            .filter_map(|line| {
                let mut forms = entry_names(line)?;
                // Only attach metadata when the summary entry identifies a unique character.
                let mut candidates = characters
                    .iter()
                    .filter(|(_, names)| !forms.explicit.is_disjoint(&names.explicit));
                let identity =
                    if let (Some((id, names)), None) = (candidates.next(), candidates.next()) {
                        forms.explicit.extend(names.explicit.iter().cloned());
                        forms.parts.clone_from(&names.parts);
                        id.clone()
                    } else {
                        forms.explicit.iter().min()?.clone()
                    };
                Some((line, forms, identity))
            })
            .collect();
        let mut owners = HashMap::new();
        for (names, identity) in characters
            .iter()
            .map(|(id, names)| (names, id))
            .chain(entries.iter().map(|(_, names, id)| (names, id)))
        {
            for name in names.all() {
                let owner = owners
                    .entry(name.as_str())
                    .or_insert(Some(identity.as_str()));
                if *owner != Some(identity.as_str()) {
                    *owner = None;
                }
            }
        }
        let source = normalize_translation_source(&format!("{sentence}\n{dialogue}"))
            .lines()
            .map(|line| {
                line.split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .to_lowercase()
            })
            .collect::<Vec<_>>()
            .join("\n");
        let compact: Vec<String> = source.lines().map(without_spaces).collect();
        let full_names: HashSet<_> = characters
            .values()
            .chain(entries.iter().map(|(_, names, _)| names))
            .flat_map(|names| names.explicit.iter().map(String::as_str))
            .collect();
        entries
            .iter()
            .filter(|(_, names, identity)| {
                names.all().any(|name| {
                    owners[name.as_str()] == Some(identity.as_str())
                        && (if east_asian_name(name) {
                            compact.iter().any(|text| {
                                text.match_indices(name).any(|(start, _)| {
                                    names.explicit.contains(name)
                                        || standalone_name_part(text, start, name, &full_names)
                                })
                            })
                        } else {
                            source.match_indices(name).any(|(start, matching)| {
                                !source[..start].chars().next_back().is_some_and(word_char)
                                    && !source[start + matching.len()..]
                                        .chars()
                                        .next()
                                        .is_some_and(word_char)
                                    && (names.explicit.contains(name)
                                        || !inside_full_name(&source, start, name, &full_names))
                            })
                        })
                })
            })
            .map(|(line, _, _)| *line)
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn entry_names(line: &str) -> Option<NameForms> {
    let mut forms = NameForms::default();
    if let Some((header, _)) = line.split_once([':', '：']) {
        let header =
            header.trim_matches(|c: char| c.is_whitespace() || matches!(c, '*' | '-' | '•'));
        if header.eq_ignore_ascii_case("character list") {
            return None;
        }
        for name in header.split(['(', '（']) {
            forms.add(name.trim().trim_end_matches([')', '）']), true);
        }
    } else {
        let (original, romanized) = line.split_once(" -> ")?;
        let romanized = romanized.split(['(', '（']).next().unwrap_or_default();
        forms.add(original, true);
        forms.add(romanized, true);
    }
    (!forms.explicit.is_empty()).then_some(forms)
}

fn standalone_name_part(text: &str, start: usize, name: &str, full_names: &HashSet<&str>) -> bool {
    if inside_full_name(text, start, name, full_names) {
        return false;
    }
    let suffix = &text[start + name.len()..];
    // One-character names need a delimiter, particle, or honorific to reduce ordinary-word matches.
    name.chars().count() > 1
        || ["さん", "ちゃん", "くん", "さま", "先輩", "様", "君"]
            .iter()
            .any(|honorific| suffix.starts_with(*honorific))
        || (!text[..start]
            .chars()
            .next_back()
            .is_some_and(east_asian_char)
            && (!suffix.chars().next().is_some_and(east_asian_char)
                || suffix.starts_with(['は', 'が', 'を', 'に', 'と', 'の', 'も', 'へ', 'で'])))
}

fn inside_full_name(text: &str, start: usize, name: &str, full_names: &HashSet<&str>) -> bool {
    let end = start + name.len();
    full_names.iter().any(|full| {
        full.len() > name.len()
            && full.contains(name)
            && text
                .match_indices(*full)
                .any(|(pos, _)| pos <= start && pos + full.len() >= end)
    })
}

fn name_key(name: &str) -> String {
    let name = name.trim_matches(|c: char| c.is_whitespace() || matches!(c, '*' | '-'));
    let name = name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if east_asian_name(&name) {
        without_spaces(&name)
    } else {
        name
    }
}

fn without_spaces(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

fn east_asian_name(name: &str) -> bool {
    name.chars().any(east_asian_char)
}

fn east_asian_char(c: char) -> bool {
    matches!(c, '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{9fff}' | '\u{ac00}'..='\u{d7af}'
        | '\u{f900}'..='\u{faff}' | '\u{20000}'..='\u{2fa1f}')
}

fn word_char(c: char) -> bool {
    !east_asian_char(c) && (c.is_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_by_names_and_linked_aliases_without_guessing_ambiguous_mentions() {
        let cast = CharacterContext {
            summary: "**CHARACTER LIST**:\n鑑 純夏 (Kagami Sumika): bubbly\nAnn: reserved\nAnna: outgoing\nOther notes".into(),
            names: vec![
                vec!["鑑 純夏".into(), "すみちゃん".into()],
                vec!["鑑 純夏".into(), "Kagami Sumika".into()],
                vec!["Ann".into(), "Chief".into()],
                vec!["Anna".into(), "Chief".into()],
            ],
        };
        assert_eq!(
            cast.relevant_to("【鑑純夏】私が行く", "Anna said so."),
            "鑑 純夏 (Kagami Sumika): bubbly\nAnna: outgoing"
        );
        assert_eq!(
            cast.relevant_to("<b>すみちゃん</b>が来る", ""),
            "鑑 純夏 (Kagami Sumika): bubbly"
        );
        assert_eq!(cast.relevant_to("Ask Chief tomorrow.", ""), "");
        assert_eq!(cast.relevant_to("She was there.", ""), "");
        assert_eq!(cast.relevant_to("<span title=\"Ann\">Hello</span>", ""), "");
    }

    #[test]
    fn matches_standalone_parts_only_if_unique_across_the_cast() {
        let cast = CharacterContext {
            summary: "鑑 純夏 (Kagami Sumika): bubbly\nMia Park: reserved\nJordan Reed: outgoing"
                .into(),
            names: vec![
                vec!["鑑 純夏".into(), "Kagami Sumika".into(), "Class Rep".into()],
                vec!["".into(), "Mia Park".into()],
                vec!["".into(), "John Park".into()],
            ],
        };
        let sumika = "鑑 純夏 (Kagami Sumika): bubbly";
        assert_eq!(cast.relevant_to("純夏が来た。", ""), sumika);
        assert_eq!(cast.relevant_to("「鑑さん！」", ""), sumika);
        assert_eq!(cast.relevant_to("Sumika is here.", ""), sumika);
        assert_eq!(cast.relevant_to("Kagami is here.", ""), sumika);
        assert_eq!(cast.relevant_to("図鑑はここ。", ""), "");
        assert_eq!(cast.relevant_to("Class starts soon.", ""), "");
        assert_eq!(cast.relevant_to("Park arrives tomorrow.", ""), "");
        assert_eq!(
            cast.relevant_to("They called Mia.", "Reed is out."),
            "Mia Park: reserved\nJordan Reed: outgoing"
        );
    }
}
