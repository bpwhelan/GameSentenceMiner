//! Approximate matching for saved Python-style punctuation rules.
use super::DEFAULT_PUNCTUATION;
use fuzzy_regex::{FuzzyRegex, FuzzyRegexBuilder};
use regex::Regex;
use std::{
    borrow::Cow,
    cell::RefCell,
    sync::{Arc, LazyLock},
};

pub(crate) struct Rule(Arc<str>);

// The matcher owns a lazy DFA and is thread-confined. Reports, rollups and
// intake share the immutable expression and keep one compiled rule per worker.
thread_local! {
    static CACHED: RefCell<Option<(Arc<str>, FuzzyRegex)>> = const { RefCell::new(None) };
}

fn build(pattern: &str) -> crate::Result<FuzzyRegex> {
    FuzzyRegexBuilder::new(pattern)
        .unicode(true)
        .greedy_first(true)
        .build()
        .map_err(|e| e.to_string().into())
}

impl Rule {
    pub(super) fn compile(pattern: String) -> Option<Self> {
        let pattern: Arc<str> = pattern.into();
        let matcher = build(&pattern).ok()?;
        CACHED.with(|cache| *cache.borrow_mut() = Some((pattern.clone(), matcher)));
        Some(Self(pattern))
    }

    pub(super) fn strip<'a>(&self, text: &'a str) -> crate::Result<Cow<'a, str>> {
        CACHED.with(|cached| {
            let mut slot = cached.borrow_mut();
            if slot
                .as_ref()
                .is_none_or(|(pattern, _)| **pattern != *self.0)
            {
                *slot = Some((self.0.clone(), build(&self.0)?));
            }
            let matcher = &slot.as_ref().unwrap().1;
            let mut matches: Vec<_> = matcher
                .find_iter(text)
                .filter(|m| m.start() < m.end())
                .map(|m| {
                    let (substitutions, insertions, deletions) = m.fuzzy_counts();
                    (m.range(), substitutions + insertions + deletions)
                })
                .collect();
            if matches.is_empty() {
                return Ok(DEFAULT_PUNCTUATION.replace_all(text, ""));
            }
            // The matcher can rank approximate hits by quality. Substitution
            // consumes nonoverlapping spans from the left.
            matches.sort_by_key(|(span, edits)| (span.start, *edits));
            // Remove standard punctuation in the intervening slices. Both
            // branches match against the original string, including lookarounds.
            let mut output = String::with_capacity(text.len());
            let mut end = 0;
            for (span, _) in matches {
                if span.start < end {
                    continue;
                }
                let gap = text
                    .get(end..span.start)
                    .ok_or("Invalid fuzzy match boundary")?;
                output.push_str(&DEFAULT_PUNCTUATION.replace_all(gap, ""));
                end = span.end;
            }
            output.push_str(
                &DEFAULT_PUNCTUATION
                    .replace_all(text.get(end..).ok_or("Invalid fuzzy match end")?, ""),
            );
            Ok(Cow::Owned(output))
        })
    }
}

/// Expand the common single-edit literal directly into ordered PCRE branches.
/// Python first consumes the exact prefix, then tries a substitution, insertion
/// or deletion. It disallows an insertion at the current search origin.
pub(super) fn one_edit_literal(pattern: &str) -> Option<String> {
    static LITERAL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^\((?:\?:)?([\p{L}\p{N}_ -]{1,64})\)\{([eisd])<=1\}$").unwrap()
    });
    let captures = LITERAL.captures(pattern)?;
    let literal = captures.get(1)?.as_str();
    let op = captures.get(2)?.as_str();
    let mut choices = vec![literal.to_owned()];
    for (offset, ch) in literal.char_indices().rev() {
        let prefix = &literal[..offset];
        let suffix = &literal[offset + ch.len_utf8()..];
        if matches!(op, "e" | "s") {
            choices.push(format!(r"{prefix}(?s:.){suffix}"));
        }
        if matches!(op, "e" | "i") {
            let guard = if offset == 0 { r"(?!\G)" } else { "" };
            choices.push(format!(r"{prefix}{guard}(?s:.){ch}{suffix}"));
        }
        if matches!(op, "e" | "d") {
            choices.push(format!("{prefix}{suffix}"));
        }
    }
    Some(choices.join("|"))
}

/// Distinguish Python's fuzzy constraints from counted repetitions, escaped
/// braces, character classes and Unicode property escapes. Transposition is a
/// separate operation in the native matcher and costs two edits in Python.
pub(super) fn adapt(pattern: &str) -> Option<String> {
    if !pattern.contains('{') {
        return None;
    }
    static FUZZY: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^\{(?:[idse](?:[,}:]|[<=>])|\d+[idse][+<=>]|\d+<=?[idse])").unwrap()
    });
    let mut output = String::new();
    let mut last = 0;
    let mut escaped = false;
    let mut escape_argument = false;
    let mut in_class = false;
    for (offset, ch) in pattern.char_indices() {
        if escaped {
            escaped = false;
            escape_argument = matches!(ch, 'p' | 'P' | 'x' | 'o' | 'N' | 'g' | 'k');
            continue;
        }
        let brace_argument = std::mem::take(&mut escape_argument);
        match ch {
            '\\' => escaped = true,
            '[' => in_class = true,
            ']' => in_class = false,
            '{' if !in_class
                && !brace_argument
                && offset >= last
                && FUZZY.is_match(&pattern[offset..]) =>
            {
                let tail = &pattern[offset..];
                let end = offset + tail.find([':', '}']).unwrap_or(tail.len());
                output.push_str(&pattern[last..end]);
                output.push_str(",t<=0");
                last = end;
            }
            _ => {}
        }
    }
    if output.is_empty() {
        return None;
    }
    output.push_str(&pattern[last..]);
    Some(output)
}
