use super::*;
use serde_json::json;
use std::io::{BufRead, Write};

#[test]
fn punctuation_and_repetitions_agree_across_reports_and_live_counts() {
    for (pattern, text, expected) in [
        ("(?<=文)字", " \u{1e}文字字。猫猫猫猫", "文字猫猫猫"),
        ("字(?=文)", "文字字文", "文字文"),
        (r"(猫|犬)\1", "猫犬犬猫猫犬", "猫犬"),
        ("【.*?】", "【名前】 「猫。」\n猫猫猫猫", "猫\n猫猫猫"),
        (r"[a&&b]", "a&b猫", "猫"),
        (r"(?=a)|a", "aa猫", "猫"),
        (r"\p{Script=Latin}", "abc猫", "猫"),
        (r"(?:speaker){e<=1}", "speker猫。speaxer犬", "猫犬"),
        (r"(?:voice){s<=1}", "voixe猫。v0i0e犬", "猫v0i0e犬"),
        (r"(?:cat){e<=1}", "catxcat", "x"),
        (r"(?:cat){e<=1}", "cats", "s"),
        (r"(?:cat){e<=1}", "ccat", ""),
        (r"(?:cat){e<=1}", "caat", "t"),
        (r"(?:speaker){s<=1,i<=0}", "speaxer猫。speaker犬", "猫犬"),
        (r"a.*?b.*?c", "a猫b犬c猫", "猫"),
    ] {
        let cleaner = ReportCleaner::compile(pattern, true).unwrap();
        let mut live = crate::live::Cleaner::default();
        live.configure(pattern, true);
        assert_eq!(cleaner.visit(text, str::to_owned).unwrap(), expected);
        assert_eq!(live.count(text), expected.chars().count());
    }
    assert!(fuzzy::adapt(r"\x{e}|\{e\}|[{e}]").is_none());
    for pattern in ["(", "(?P<missing"] {
        assert!(
            ReportCleaner::compile(pattern, false).is_none(),
            "{pattern}"
        );
    }
}

#[test]
#[ignore = "Reads cleaner benchmark requests from stdin"]
fn benchmark_worker() {
    println!("ready {}", std::process::id());
    for line in std::io::stdin().lock().lines() {
        let ((pattern, repeat, lines), count, verify): ((String, bool, Vec<String>), usize, bool) =
            serde_json::from_str(&line.unwrap()).unwrap();
        let cleaner = ReportCleaner::compile(&pattern, repeat).unwrap();
        let start = std::time::Instant::now();
        for _ in 0..count {
            for text in &lines {
                std::hint::black_box(cleaner.count(text).unwrap());
            }
        }
        let elapsed = start.elapsed().as_secs_f64() * 1000.0 / count as f64;
        let outputs: Vec<_> = if verify {
            lines
                .iter()
                .map(|v| cleaner.visit(v, str::to_owned).unwrap())
                .collect()
        } else {
            vec![]
        };
        println!("{}", json!({"ms":elapsed,"outputs":outputs}));
        std::io::stdout().flush().unwrap();
    }
}
