//! Bounded regex execution with Python replacement-template syntax.
use fancy_regex::{Captures, RegexBuilder};
pub fn replace(text: &str, pattern: &str, replacement: &str) -> Result<String, String> {
    let regex = RegexBuilder::new(pattern)
        .backtrack_limit(100_000)
        .build()
        .map_err(|e| e.to_string())?;
    let mut output = String::new();
    let mut previous = 0;
    for capture in regex.captures_iter(text) {
        let capture = capture.map_err(|e| e.to_string())?;
        let found = capture.get(0).unwrap();
        output.push_str(&text[previous..found.start()]);
        output.push_str(&expand(&capture, replacement)?);
        previous = found.end();
    }
    output.push_str(&text[previous..]);
    Ok(output)
}
fn expand(captures: &Captures<'_>, template: &str) -> Result<String, String> {
    let mut chars = template.chars().peekable();
    let mut result = String::new();
    while let Some(c) = chars.next() {
        if c != '\\' {
            result.push(c);
            continue;
        }
        match chars.next().ok_or("Trailing slash in replacement")? {
            '\\' => result.push('\\'),
            'n' => result.push('\n'),
            't' => result.push('\t'),
            'r' => result.push('\r'),
            first @ '0'..='9' => {
                let mut index = first.to_string();
                while chars.peek().is_some_and(|c| c.is_ascii_digit()) {
                    index.push(chars.next().unwrap());
                }
                let index: usize = index.parse().map_err(|_| "Invalid group")?;
                if index >= captures.len() {
                    return Err("Unknown replacement group".into());
                }
                result.push_str(captures.get(index).map_or("", |m| m.as_str()));
            }
            'g' if chars.next() == Some('<') => {
                let mut name = String::new();
                loop {
                    match chars.next() {
                        Some('>') => break,
                        Some(c) => name.push(c),
                        None => return Err("Unclosed replacement group".into()),
                    }
                }
                let found = if let Ok(i) = name.parse::<usize>() {
                    captures.get(i)
                } else {
                    captures.name(&name)
                };
                result.push_str(found.map_or("", |m| m.as_str()));
            }
            c if !c.is_alphabetic() => {
                result.push('\\');
                result.push(c);
            }
            _ => return Err("Invalid replacement escape".into()),
        }
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn python_groups_lookarounds_and_literal_dollars() {
        assert_eq!(
            replace("日本語", r"(?<=日)(?P<word>本)(語)", r"\2\g<word>$1").unwrap(),
            "日語本$1"
        );
        assert_eq!(replace("ああ", "(?=あ)", "!").unwrap(), "!あ!あ");
        assert!(replace("text", "(", "bad").is_err());
        assert!(replace(&format!("{}!", "a".repeat(100)), r"(a|aa)+\1$", "").is_err());
    }
}
