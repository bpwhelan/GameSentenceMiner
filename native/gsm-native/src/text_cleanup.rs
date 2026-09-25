use std::collections::HashMap;

fn runs(chars: &[char]) -> impl Iterator<Item = (char, usize)> + '_ {
    let mut offset = 0;
    std::iter::from_fn(move || {
        let &ch = chars.get(offset)?;
        let start = offset;
        offset += 1;
        while offset < chars.len() && chars[offset] == ch {
            offset += 1;
        }
        Some((ch, offset - start))
    })
}

pub fn remove_repeated_chars(text: &str, repeat_count: i64, keep_non_repeated: bool) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return String::new();
    }
    let count = if repeat_count >= 2 {
        // Counts larger than the input need no more precision than len + 1.
        usize::try_from(repeat_count).unwrap_or(usize::MAX)
    } else {
        // Preserve the Python detector's initial one-character sentinel, even
        // though it is not an actual run (it affects frequency ties).
        let mut frequencies = HashMap::from([(1usize, 1usize)]);
        for (_, length) in runs(&chars) {
            *frequencies.entry(length).or_default() += 1;
        }
        let max_frequency = frequencies.values().copied().max().unwrap_or(1);
        frequencies
            .into_iter()
            .filter(|(_, frequency)| *frequency == max_frequency)
            .map(|(length, _)| length)
            .min_by_key(|&length| (length == 1, length))
            .unwrap_or(1)
    };
    // Preserve natural pairs in auto mode; explicit counts can still remove them.
    if repeat_count < 2 && count < 3 {
        return text.to_owned();
    }
    if !keep_non_repeated {
        return chars
            .iter()
            .step_by(count)
            .take(chars.len() / count)
            .collect();
    }
    let mut result = String::with_capacity(text.len());
    for (ch, length) in runs(&chars) {
        // Only complete groups collapse; every character in a partial tail
        // survives (e.g. five A's with count=3 become three A's).
        for _ in 0..(length / count + length % count) {
            result.push(ch);
        }
    }
    result
}

pub fn remove_repeated_lines(text: &str, repeat_count: i64) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return String::new();
    }
    let unit_len = if repeat_count >= 2 {
        chars.len() / usize::try_from(repeat_count).unwrap_or(usize::MAX)
    } else {
        // The prefix function finds the shortest exact period in O(n), instead
        // of constructing and comparing every possible repetition count.
        let mut prefix = vec![0; chars.len()];
        for i in 1..chars.len() {
            let mut matched = prefix[i - 1];
            while matched > 0 && chars[i] != chars[matched] {
                matched = prefix[matched - 1];
            }
            if chars[i] == chars[matched] {
                matched += 1;
            }
            prefix[i] = matched;
        }
        let period = chars.len() - prefix[chars.len() - 1];
        if chars.len() % period == 0 {
            period
        } else {
            chars.len()
        }
    };
    if unit_len == 0 {
        text.to_owned()
    } else {
        chars[..unit_len].iter().collect()
    }
}

/// Keep first-seen order, including ties in the statistics page's stable sort.
pub fn count_kanji(texts: &[String]) -> Vec<(String, usize)> {
    let mut indices = HashMap::new();
    let mut counts: Vec<(String, usize)> = Vec::new();
    for text in texts {
        for ch in text.chars() {
            if !matches!(ch, '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' | '\u{20000}'..='\u{2a6df}')
            {
                continue;
            }
            let index = *indices.entry(ch).or_insert_with(|| {
                counts.push((ch.to_string(), 0));
                counts.len() - 1
            });
            counts[index].1 += 1;
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn character_detection_preserves_sentinel_and_partial_runs() {
        assert_eq!(remove_repeated_chars("AA", 1, true), "AA");
        assert_eq!(remove_repeated_chars("ええ……。", 1, true), "ええ……。");
        assert_eq!(remove_repeated_chars("AABB", 1, true), "AABB");
        assert_eq!(remove_repeated_chars("AABB", 1, false), "AABB");
        assert_eq!(remove_repeated_chars("AAABBB", 1, true), "AB");
        assert_eq!(remove_repeated_chars("AAAABBBBCCCC", 1, true), "ABC");
        assert_eq!(remove_repeated_chars("AABB", 2, true), "AB");
        assert_eq!(remove_repeated_chars("AABB", 2, false), "AB");
        assert_eq!(remove_repeated_chars("AAB", 1, true), "AAB");
        assert_eq!(remove_repeated_chars("AAABBB", 2, true), "AABB");
        assert_eq!(remove_repeated_chars("AAAAA", 3, true), "AAA");
        assert_eq!(remove_repeated_chars("AA", 3, true), "AA");
        assert_eq!(remove_repeated_chars("日日𠀀𠀀!", 2, false), "日𠀀");
        assert_eq!(remove_repeated_chars("abc", i64::MAX, false), "");
    }

    #[test]
    fn shortest_period_and_explicit_truncation() {
        assert_eq!(remove_repeated_lines("日本日本日本", 1), "日本");
        assert_eq!(remove_repeated_lines("ababa", 1), "ababa");
        assert_eq!(remove_repeated_lines("abcde", 2), "ab");
        assert_eq!(remove_repeated_lines("abc", 10), "abc");
        assert_eq!(remove_repeated_lines("😀𠀀😀𠀀", 1), "😀𠀀");
    }

    #[test]
    fn kanji_counts_are_ordered() {
        assert_eq!(
            count_kanji(&["日本日😀".to_owned(), "𠀀本".to_owned()]),
            vec![
                ("日".to_owned(), 2),
                ("本".to_owned(), 2),
                ("𠀀".to_owned(), 1)
            ]
        );
    }
}
