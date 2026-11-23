use gsm_history::Result;
use serde_json::Value;
use std::{collections::HashSet, sync::LazyLock};

type Pairs = Vec<(&'static str, &'static str)>;
fn pairs(table: &'static str) -> Pairs {
    table
        .lines()
        .map(|line| line.split_once('\t').expect("two columns"))
        .collect()
}
static SUFFIXES: LazyLock<Pairs> = LazyLock::new(|| pairs(include_str!("honorifics.tsv")));
use gsm_history::characters::names::{katakana, reading};

pub(super) fn visit(
    character: &Value,
    mut emit: impl FnMut(&str, &str) -> Result<()>,
) -> Result<()> {
    let roman = character["name"].as_str().unwrap_or("");
    let name = character["name_original"]
        .as_str()
        .filter(|n| !n.is_empty())
        .unwrap_or(roman);
    if name.is_empty() {
        return Ok(());
    }
    let mut seen = HashSet::new();
    let mut add = |term: &str, pronunciation: &str| -> Result<bool> {
        if term.is_empty() || seen.contains(term) {
            return Ok(false);
        }
        seen.insert(term.to_owned());
        emit(term, pronunciation)?;
        Ok(true)
    };
    fn suffixes(
        base: &str,
        kana: &str,
        add: &mut impl FnMut(&str, &str) -> Result<bool>,
    ) -> Result<()> {
        if !base.is_empty() {
            let mut term = base.to_owned();
            let mut pronunciation = kana.to_owned();
            for &(suffix, reading) in SUFFIXES.iter() {
                term.push_str(suffix);
                pronunciation.push_str(reading);
                add(&term, &pronunciation)?;
                term.truncate(base.len());
                pronunciation.truncate(kana.len());
            }
        }
        Ok(())
    }
    let full;
    if let Some((family, given)) = name.split_once(' ') {
        let (first, second) = roman.split_once(' ').unwrap_or((roman, ""));
        let f = reading(family, first);
        let g = reading(given, second);
        full = format!("{f}{g}");
        let (kf, kg) = (katakana(&f), katakana(&g));
        let combined = format!("{family}{given}");
        let kata = format!("{kf}{kg}");
        for (term, pronunciation) in [
            (name, full.as_str()),
            (&combined, &full),
            (family, &f),
            (given, &g),
            (&full, &full),
            (&format!("{f} {g}"), &full),
            (&f, &f),
            (&g, &g),
            (&kata, &full),
            (&format!("{kf} {kg}"), &full),
            (&kf, &f),
            (&kg, &g),
        ] {
            add(term, pronunciation)?;
        }
        for (base, kana) in [
            (family, f.as_str()),
            (given, &g),
            (&combined, &full),
            (name, &full),
            (&f, &f),
            (&g, &g),
            (&full, &full),
            (&kf, &f),
            (&kg, &g),
            (&kata, &full),
        ] {
            suffixes(base, kana, &mut add)?;
        }
    } else {
        full = reading(name, roman);
        let katakana = katakana(&full);
        for base in [name, &full, &katakana] {
            add(base, &full)?;
        }
        for base in [name, &full, &katakana] {
            suffixes(base, &full, &mut add)?;
        }
    }
    for alias in character["aliases"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if add(alias, &full)? {
            suffixes(alias, &full, &mut add)?;
        }
    }
    Ok(())
}
