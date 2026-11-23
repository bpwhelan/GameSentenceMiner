use gsm_mining::frame_selector::Layout;

#[test]
fn anchors_pages_to_the_exact_line_and_clamps_the_last_video_frame() {
    let l = Layout::new(31.0, 24.0, 17.123, "middle").unwrap();
    let page = l.page(0);
    assert_eq!(page.len(), 25);
    assert_eq!(page[12].seconds, 17.123);
    let earlier = l.page(-1);
    let later = l.page(1);
    assert_eq!(earlier.last().unwrap().index + 1, page[0].index);
    assert_eq!(page[24].index + 1, later[0].index);
    assert!(earlier[0].seconds >= 0.0 && later.last().unwrap().seconds < 31.0);
    assert!(l.page(i64::MAX).is_empty());
    let short = Layout::new(0.03, 24.0, 100.0, "end").unwrap();
    assert_eq!(short.page(0)[0].seconds, 0.0);
    assert!(short.page(-1).is_empty() && short.page(1).is_empty());
    assert!(Layout::new(0.0, 30.0, 0.0, "beginning").is_err());
}
