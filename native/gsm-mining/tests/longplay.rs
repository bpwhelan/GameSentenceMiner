use gsm_mining::longplay::Recorder;
use std::{fs, path::Path, sync::Arc};

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap().replace("\r\n", "\n")
}

#[test]
fn shutdown_keeps_active_video_and_appends_last_cue_only_once() {
    let dir = tempfile::tempdir().unwrap();
    let video = dir.path().join("active.mp4");
    fs::write(&video, b"still recording").unwrap();
    let mut r = Recorder::new(dir.path().into());
    r.file(0, &video, "Game").unwrap();
    r.line(1_000_000, "final".into()).unwrap();
    r.finish_input(8_000_000).unwrap();
    r.finish_input(10_000_000).unwrap();
    assert_eq!(
        read(&video.with_extension("srt")),
        "1\n00:00:01,000 --> 00:00:07,000\nfinal\n\n"
    );
    assert!(video.exists());
}

#[test]
fn split_stop_and_duplicate_ack_preserve_both_segments_and_the_final_line() {
    let dir = tempfile::tempdir().unwrap();
    let mut r = Recorder::new(dir.path().join("temp"));
    let first = dir.path().join("01.mp4");
    let second = dir.path().join("02.mkv");
    fs::write(&first, b"recording").unwrap();
    r.start(0);
    r.line(1_125_000, Arc::from("一")).unwrap();
    r.line(4_500_000, Arc::from("二")).unwrap();
    r.file(5_000_000, &first, "Game: Name?").unwrap();
    r.file(7_750_000, &second, "Game: Name?").unwrap();
    r.line(9_250_000, Arc::from("三")).unwrap();
    r.stop(12_000_000, None, "Game: Name?").unwrap();
    r.stop(12_250_000, Some(&second), "Game: Name?").unwrap();
    assert_eq!(
        fs::read(dir.path().join("GameName_01.mp4")).unwrap(),
        b"recording"
    );
    assert_eq!(
        read(&dir.path().join("GameName_01.srt")),
        "1\n00:00:01,125 --> 00:00:03,500\n一\n\n2\n00:00:04,500 --> 00:00:06,750\n二\n\n"
    );
    assert_eq!(
        read(&second.with_extension("srt")),
        "1\n00:00:00,000 --> 00:00:00,500\n二\n\n2\n00:00:01,500 --> 00:00:03,250\n三\n\n"
    );
}

#[test]
fn late_path_after_stop_moves_single_line_and_protects_existing_outputs() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("capture.mp4");
    fs::write(&path, b"video").unwrap();
    fs::write(dir.path().join("Game_capture.mp4"), b"keep").unwrap();
    fs::write(path.with_extension("srt"), b"keep subtitles").unwrap();
    let mut r = Recorder::new(dir.path().join("temp"));
    r.stop(0, Some(&path), "Game").unwrap();
    r.start(10_000_000);
    r.line(10_050_000, Arc::from("last")).unwrap();
    r.stop(10_120_000, None, "Game").unwrap();
    r.stop(11_000_000, Some(&path), "Game").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"video");
    assert_eq!(
        fs::read(dir.path().join("Game_capture.mp4")).unwrap(),
        b"keep"
    );
    assert_eq!(
        fs::read(path.with_extension("srt")).unwrap(),
        b"keep subtitles"
    );
    let subtitles = fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|e| e == "srt") && p != &path.with_extension("srt"))
        .unwrap();
    assert_eq!(
        read(&subtitles),
        "1\n00:00:00,050 --> 00:00:00,050\nlast\n\n"
    );
}
