use gsm_overlay::{
    adaptive::{Focus, HookTiming, LearnedDelay, Region, Retry, normalize},
    pipeline::{TextBox, remap_line},
    presence::{Decision, Presence, match_lines},
};
use image::{Rgba, RgbaImage};

fn line(text: &str, bounds: [f64; 4]) -> TextBox {
    TextBox {
        text: text.into(),
        bounds,
        ..Default::default()
    }
}

#[test]
fn focus_follows_dialogue_and_refreshes_the_full_frame() {
    let mut focus = Focus::default();
    let lines = vec![
        line("背景の表示", [300., 180., 1400., 400.]),
        line("おまえらの目の前にある", [220., 915., 1100., 980.]),
        line("発光した扉だ", [220., 995., 870., 1050.]),
    ];
    focus.observe(
        &lines,
        (2000, 1200),
        "おまえらの目の前にある発光した扉だ",
        0.,
        true,
    );
    let region = focus.region((2000, 1200), 0.1).unwrap();
    assert!(region.top > 400 && region.bottom >= 1050);
    assert!(region.left <= 220 && region.right >= 1800);
    assert!(region.width() * region.height() < 2000 * 1200 / 2);
    assert!(focus.region((2000, 1200), 3.1).is_none());
    assert!(focus.region((800, 600), 0.2).is_none());
}

#[test]
fn crop_falls_back_on_blank_unrelated_or_clipped_text() {
    let r = Region {
        left: 100,
        top: 200,
        right: 900,
        bottom: 500,
    };
    assert!(Focus::needs_full(&[], "", r, (1000, 600)));
    assert!(Focus::needs_full(
        &[line("unrelated", [60., 60., 300., 100.])],
        "日本語の文章",
        r,
        (1000, 600)
    ));
    assert!(Focus::needs_full(
        &[line("growing", [4., 60., 250., 110.])],
        "",
        r,
        (1000, 600)
    ));
    assert!(!Focus::needs_full(
        &[line("growing", [4., 60., 250., 110.])],
        "",
        Region { left: 0, ..r },
        (1000, 600)
    ));
}

#[test]
fn crop_offset_moves_words_as_well_as_lines() {
    let mut l = line("日本語", [10., 20., 80., 40.]);
    l.words.push(line("日", [10., 20., 30., 40.]));
    remap_line(&mut l, (100., 400.), (1., 1.));
    assert_eq!(l.bounds, [110., 420., 180., 440.]);
    assert_eq!(l.words[0].bounds, [110., 420., 130., 440.]);
}

#[test]
fn retries_follow_typewriter_growth_and_do_not_finish_on_a_short_pause() {
    let mut retry = Retry::new("日本語の文章", 6, true);
    assert!(!retry.observe("日", 0., 0.04).finished);
    let step = retry.observe("日本", 0.15, 0.19);
    assert!(!step.finished && step.delay <= 0.01);
    assert!(!retry.observe("日本", 1.5, 1.55).finished);
    assert!(retry.observe("日本語の文章", 1.7, 1.75).finished);
}

#[test]
fn retries_back_off_on_blanks_and_have_a_deadline() {
    let mut retry = Retry::new("expected", 6, true);
    let first = retry.observe("", 0., 0.02);
    let second = retry.observe("", 0.15, 0.17);
    assert!(second.delay > first.delay);
    assert!(retry.observe("", 6., 6.02).finished);
    assert!(
        Retry::new("expected", 1, true)
            .observe("", 0., 0.1)
            .finished
    );
}

#[test]
fn slow_ocr_does_not_turn_close_captures_into_quiet_agreement() {
    let mut retry = Retry::new("", 6, true);
    retry.observe("same", 0., 0.01);
    assert!(!retry.observe("same", 0.1, 1.2).finished);
    assert!(retry.observe("same", 1.3, 1.4).finished);
}

#[test]
fn learned_hook_delay_requires_repeated_confirmed_late_reveals() {
    let mut learned = LearnedDelay::default();
    for _ in 0..3 {
        let mut timing = HookTiming::new("日本語の文章");
        timing.observe("", 0.);
        timing.observe("日本語の文章", 0.2);
        learned.record(&timing);
    }
    assert!((learned.delay - 0.05).abs() < 0.001);
    let mut partial = HookTiming::new("日本語の文章");
    partial.observe("日本語", 0.);
    partial.observe("日本語の文章", 0.5);
    for _ in 0..10 {
        learned.record(&partial);
    }
    assert!((learned.delay - 0.05).abs() < 0.001);
}

fn frame(text: bool, noise: u8) -> RgbaImage {
    RgbaImage::from_fn(240, 100, |x, y| {
        let value = if text
            && (25..180).contains(&x)
            && (30..65).contains(&y)
            && ((x % 16 < 4) || (y % 16 < 3))
        {
            240
        } else {
            30 + ((x * 7 + y * 13 + noise as u32 * 11) % 20) as u8
        };
        Rgba([value, value, value, 255])
    })
}

#[test]
fn presence_ignores_background_noise_confirms_misses_and_restores() {
    let expected = vec![line("日本語の文章", [23., 28., 182., 67.])];
    let mut presence = Presence::new(&frame(true, 0), expected).unwrap();
    assert_eq!(presence.observe(&frame(true, 5)), Decision::Unchanged);
    assert_eq!(presence.observe(&frame(false, 0)), Decision::Unchanged);
    assert_eq!(presence.observe(&frame(false, 1)), Decision::Confirm);
    presence.invalidate();
    assert_eq!(presence.observe(&frame(false, 2)), Decision::Unchanged);
    assert_eq!(presence.observe(&frame(true, 9)), Decision::Restore);
}

#[test]
fn matching_all_previous_lines_handles_wrapping_width_and_small_misreads() {
    let expected = vec![
        line("今日は、いい天気ですね！", [0.; 4]),
        line("１２３", [0.; 4]),
    ];
    let actual = vec![
        line("MENU", [0.; 4]),
        line("123", [0.; 4]),
        line("今日はいい", [0.; 4]),
        line("天汽ですね", [0.; 4]),
    ];
    let matched = match_lines(&expected, &actual).unwrap();
    assert_eq!(
        matched.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(),
        vec!["123", "今日はいい", "天汽ですね"]
    );
    assert!(match_lines(&expected, &actual[..3]).is_none());
    assert!(
        match_lines(
            &[line("OCR", [0.; 4]), line("OCR", [0.; 4])],
            &[line("OCR", [0.; 4])]
        )
        .is_none()
    );
    assert_eq!(normalize("１２３、 日本 語！"), "123日本語");
}

#[test]
fn stable_short_prefix_cannot_finish_a_known_sentence() {
    let mut retry = Retry::new("日本語の長い文章", 6, true);
    retry.observe("日本", 0., 0.1);
    assert!(!retry.observe("日本", 1.2, 1.3).finished);
    assert!(retry.observe("日本", 6., 6.1).finished);
}

#[test]
fn timing_does_not_learn_from_unconfirmed_or_partial_text_and_is_bounded() {
    let mut learned = LearnedDelay::default();
    let mut unconfirmed = HookTiming::new("日本語の文章");
    unconfirmed.observe("", 0.);
    for _ in 0..10 {
        learned.record(&unconfirmed);
    }
    assert_eq!(learned.delay, 0.);
    for _ in 0..30 {
        let mut late = HookTiming::new("日本語の文章");
        late.observe("", 0.);
        late.observe("日本語の文章", 1.);
        learned.record(&late);
    }
    assert!((learned.delay - 0.15).abs() < 0.001);
    for _ in 0..8 {
        let mut ready = HookTiming::new("日本語の文章");
        ready.observe("日本語の文章", 0.);
        learned.record(&ready);
    }
    assert!((learned.delay - 0.145).abs() < 0.001);
}

#[test]
fn landing_probe_is_bounded_even_with_animation() {
    let mut gate = gsm_overlay::presence::Landing::default();
    for i in 0..8 {
        let image = RgbaImage::from_pixel(100, 100, Rgba([if i % 2 == 0 { 0 } else { 255 }; 4]));
        assert_eq!(gate.observe(&image), i == 7);
    }
}

#[test]
fn presence_checks_each_text_region_without_using_the_scenery_between_them() {
    let first = frame(true, 0);
    let mut image = RgbaImage::from_pixel(240, 300, Rgba([50, 50, 50, 255]));
    image::imageops::replace(&mut image, &first, 0, 0);
    image::imageops::replace(&mut image, &first, 0, 200);
    let lines = vec![
        line("first", [23., 28., 182., 67.]),
        line("second", [23., 228., 182., 267.]),
    ];
    let mut presence = Presence::new(&image, lines).unwrap();
    for y in 90..200 {
        for x in 0..240 {
            image.put_pixel(x, y, Rgba([((x * 13 + y * 17) % 256) as u8; 4]));
        }
    }
    assert_eq!(presence.observe(&image), Decision::Unchanged);
    image::imageops::replace(&mut image, &frame(false, 0), 0, 200);
    assert_eq!(presence.observe(&image), Decision::Unchanged);
    assert_eq!(presence.observe(&image), Decision::Confirm);
}
