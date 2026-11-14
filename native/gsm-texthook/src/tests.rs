use crate::protocol::*;
use serde_json::{json, Value};

fn session(engine: &str, delay: u64) -> Session {
    Session::new(
        json!({"engine":engine,"pid":42,"exeName":"game.exe","arch":"x64",
        "flushDelayMs":delay,"maxBufferSize":3000,"source":"user"}),
    )
}
fn line(engine: &str, id: &str, text: &str) -> Vec<u8> {
    let prefix = if engine == "luna" {
        format!("#{id}|0:ABCD:F0AB70:921:0:TextOutW:HS@0")
    } else {
        format!("{id}:ABCD:F0AB70:921:0:TextOutW:HS@0")
    };
    format!("[{prefix}] {text}\r\n")
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect()
}
fn texts(events: Vec<Event>) -> Vec<Value> {
    events
        .into_iter()
        .filter_map(|e| {
            if let Event::Text(v) = e {
                Some(v)
            } else {
                None
            }
        })
        .collect()
}
fn selected(engine: &str, delay: u64) -> Session {
    let mut s = session(engine, delay);
    s.feed(&line(engine, "43", "candidate"), 0);
    assert!(s.select("43", 0));
    s.drain();
    s
}
#[test]
fn unicode_survives_every_byte_boundary_and_status_is_never_dialogue() {
    for engine in ["luna", "textractor"] {
        let mut s = selected(engine, 0);
        let data = line(engine, "43", "日本語🦀\n二行目");
        for byte in data {
            s.feed(&[byte], 10);
        }
        let statuses = "Selected hook: 43Now showing text only from 1 selected hook(s).\r\nunframed output\r\n";
        s.feed(
            &statuses
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
            10,
        );
        assert_eq!(
            texts(s.drain())
                .iter()
                .map(|v| v["text"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["日本語🦀", "二行目"]
        );
    }
}
#[test]
fn cumulative_fragments_keep_original_capture_time_and_flush_only_once() {
    let mut s = selected("luna", 100);
    for (time, text) in [(10, "你"), (50, "你好"), (60, "你好！"), (70, "你好")] {
        s.feed(&line("luna", "43", text), time);
    }
    s.tick(169);
    assert!(texts(s.drain()).is_empty());
    s.tick(170);
    let output = texts(s.drain());
    assert_eq!(output.len(), 1);
    assert_eq!(output[0]["text"], "你好！");
    assert_eq!(output[0]["capturedAt"], 10);
    assert_eq!(output[0]["mergeFragments"], false);
    s.flush();
    assert!(texts(s.drain()).is_empty());
}
#[test]
fn redraws_are_suppressed_without_losing_changed_or_reselected_text() {
    for engine in ["luna", "textractor"] {
        let mut s = selected(engine, 0);
        for _ in 0..1000 {
            s.feed(&line(engine, "43", "字幕%D$vl123;"), 10);
        }
        s.feed(&line(engine, "44", "other"), 20);
        s.feed(&line(engine, "43", "字幕"), 60000);
        s.feed(&line(engine, "43", "次"), 60001);
        s.feed(&line(engine, "43", "字幕"), 60002);
        assert!(s.select("43", 60003));
        s.feed(&line(engine, "43", "字幕"), 60004);
        assert_eq!(
            texts(s.drain())
                .iter()
                .map(|v| v["text"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["字幕", "次", "字幕", "字幕"]
        );
    }
}
#[test]
fn rejects_huge_split_lines_and_backlogs_then_recovers() {
    let mut s = selected("luna", 0);
    for bytes in line("luna", "43", &"x".repeat(200_000)).chunks(7) {
        s.feed(bytes, 10);
    }
    s.feed(&line("luna", "43", &"「text」".repeat(11)), 10);
    s.feed(&line("luna", "43", "safe🦀"), 20);
    assert_eq!(
        texts(s.drain())
            .iter()
            .map(|v| v["text"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["safe🦀"]
    );
    assert_eq!(truncate("a🦀b", 2), "a");
}
#[test]
fn profile_matches_context_and_legacy_name_and_console_is_not_a_hook() {
    for name in ["TextOutW", "TextOutW (921:0)"] {
        let mut s = Session::new(
            json!({"engine":"luna","autoSelectHookId":"99","autoSelectHookFunction":name,"flushDelayMs":0}),
        );
        s.feed(&line("luna", "43", "dialogue"), 10);
        assert_eq!(s.status()["selectedHookId"], "43");
        assert_eq!(texts(s.drain()).len(), 1);
    }
    let mut s = session("textractor", 0);
    s.feed(&line("textractor", "43", "candidate"), 10);
    let console =
        "[0:0:0:0:0:Console:HB0@0] info\r\ncontinuation\r\n[1:0:0:0:0:Clipboard:HS@0] secret\r\n";
    s.feed(
        &console
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
        10,
    );
    assert_eq!(s.hooks()["hooks"].as_array().unwrap().len(), 1);
}
#[test]
fn changing_hook_flushes_old_pending_payload_before_new_selection() {
    let mut s = selected("luna", 100);
    s.feed(&line("luna", "43", "old"), 10);
    s.feed(&line("luna", "44", "candidate"), 20);
    assert!(s.select("44", 30));
    s.feed(&line("luna", "44", "new"), 40);
    s.flush();
    let output = texts(s.drain());
    assert_eq!(
        output
            .iter()
            .map(|v| v["hookId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["43", "44"]
    );
    assert!(s.manual("HS@0\nattach -P1").is_err());
    assert!(s.manual("HS@401000").is_ok());
}

#[test]
fn changing_delay_reschedules_and_zero_flushes_pending_previews_and_text() {
    let mut s = selected("luna", 100);
    s.feed(&line("luna", "43", "pending"), 10);
    s.configure("flushDelayMs", json!(200), 50);
    s.tick(249);
    assert!(texts(s.drain()).is_empty());
    s.configure("flushDelayMs", json!(0), 250);
    assert_eq!(texts(s.drain())[0]["text"], "pending");
    assert!(s.hooks()["hooks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|h| h["preview"].as_str().is_some_and(|t| t.contains("pending"))));
}
#[test]
fn selection_like_dialogue_is_preserved_and_distinct_contexts_do_not_auto_match() {
    let mut s = selected("luna", 0);
    s.feed(
        &line(
            "luna",
            "43",
            "first\nSelected hook: the one in the story\nNow showing text only from the game.",
        ),
        1,
    );
    assert_eq!(texts(s.drain()).len(), 3);
    let mut s = Session::new(json!({"engine":"luna","autoSelectHookFunction":"TextOutW (999:0)"}));
    s.feed(&line("luna", "43", "text"), 1);
    assert_eq!(s.status()["selectedHookId"], Value::Null);
}
#[test]
fn architecture_mismatch_is_a_control_event_and_samples_are_bounded() {
    let mut s = selected("luna", 0);
    s.diagnostic("Architecture mismatch: only LunaHostCLI x86 can inject into this process.");
    assert!(s
        .drain()
        .iter()
        .any(|e| matches!(e,Event::Architecture(arch) if arch=="x86")));
    for n in 0..20 {
        s.feed(&line("luna", "43", &format!("sample{n}")), n);
    }
    assert_eq!(
        s.hooks()["hooks"][0]["samples"].as_array().unwrap().len(),
        5
    );
    s.feed(&line("luna", "43", &"x".repeat(10_001)), 21);
    assert_eq!(texts(s.drain()).len(), 20);
}
