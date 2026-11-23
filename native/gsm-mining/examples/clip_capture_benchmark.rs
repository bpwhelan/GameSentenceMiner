use gsm_mining::{
    clips::ClipWindow,
    config::ProfileConfig,
    ffmpeg::{file_mtime_epoch, MediaTools},
    frame_selector::{self, Layout},
    pause_gaps::PauseHistory,
    reader_media::LineReplay,
    text::GameLine,
    vad::VadSystem,
};
use serde_json::json;
use std::{
    io::{self, BufRead},
    path::PathBuf,
    time::Instant,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("fixture directory missing")?,
    );
    let replay = dir.join("source.mkv");
    let end = file_mtime_epoch(&replay).ok_or("missing replay")?;
    let media = MediaTools::discover(Some(&dir), dir.join("temp"));
    let pauses = PauseHistory::new(&dir);
    pauses.remember_pauses(&[(end - 6.0, end - 5.75)]);
    let mut lines = (0..5)
        .map(|i| {
            serde_json::from_value::<GameLine>(
                json!({"id":format!("line-{i}"),"text":format!("台詞{i}"),
        "time_epoch":end-9.5+i as f64*1.5,"scene":"ゲーム","source":"manual","source_padding":0}),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    let after = lines.split_off(3);
    let window = ClipWindow {
        selected: lines.pop().unwrap(),
        before: lines,
        after,
    };
    let mut seq = 0;
    let vad = VadSystem::new(Vec::new());
    let mut config = ProfileConfig::default();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    config.screenshot.width = 160;
    config.screenshot.height = 0;
    config.screenshot.trim_black_bars_wip = false;
    config.screenshot.extension = "jpg".into();
    config.paths.output_folder = dir.join("exports-rust").to_string_lossy().into_owned();
    println!("ready {}", std::process::id());
    for command in io::stdin().lock().lines() {
        let (operation, calls, verify): (String, u32, bool) = serde_json::from_str(&command?)?;
        let start = Instant::now();
        let mut path = PathBuf::new();
        for _ in 0..calls {
            seq += 1;
            let input = dir.join(format!("replay-rust-{seq}.mkv"));
            std::fs::hard_link(&replay, &input)?;
            let line = LineReplay {
                line: &window.selected,
                next_line_time: window.after.first().map(|l| l.time_epoch),
                path: &input,
                recording_end: None,
            };
            path = match operation.as_str() {
                "frames" => {
                    let layout = Layout::probe(&media, &input, 6.125, "middle")?;
                    let page = layout.page(0);
                    let (_tx, rx) = tokio::sync::watch::channel(1);
                    let frames = runtime.block_on(frame_selector::decode_page(
                        &media,
                        &config,
                        &input,
                        &page,
                        &media.temp_dir,
                        rx,
                        1,
                    ))?;
                    let chosen = frame_selector::export(
                        &media,
                        &config,
                        &[frames[12].clone(), frames[2].clone()],
                        || false,
                    )?;
                    let result = dir.join("frames-rust.json");
                    if verify {
                        let mut images = Vec::new();
                        for frame in frames {
                            let frame = std::sync::Arc::try_unwrap(frame)
                                .map_err(|_| "Frame remains selected")?;
                            images.push((frame.path.keep()?, frame.position.seconds));
                        }
                        std::fs::write(
                            &result,
                            json!({"frames":images,"exported":chosen.release()}).to_string(),
                        )?;
                    }
                    result
                }
                "audio" => line.audio(&media, &config, &pauses, &vad, false)?.keep()?,
                "folder" => {
                    config.paths.copy_trimmed_replay_to_output_folder = true;
                    let text = format!("{}{}", window.selected.text, window.after[0].text);
                    let folder = gsm_mining::reader_folder::Folder::new(
                        &dir.join(format!("folder-rust-{seq}")),
                        &text,
                        chrono::Local::now(),
                    )?;
                    let mut errors = Vec::new();
                    let path = folder.finish(
                        line,
                        Some(window.after[1].time_epoch),
                        &media,
                        &config,
                        &pauses,
                        &vad,
                        false,
                        |e| errors.push(e),
                    )?;
                    if !errors.is_empty() {
                        return Err(errors.join(", ").into());
                    }
                    path
                }
                "trim" => {
                    line.export_video(&media, &config, &pauses, &vad, false, chrono::Local::now())?
                }
                "save" => window.save(&dir.join(format!("rust-{seq}")), &input, &media, &pauses)?,
                _ => return Err(format!("Unknown operation {operation}").into()),
            };
        }
        println!(
            "{}",
            json!({"ms":start.elapsed().as_secs_f64()*1000./f64::from(calls),"folder":path})
        );
    }
    Ok(())
}
