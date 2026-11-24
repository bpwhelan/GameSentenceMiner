//! CPU OCR benchmark. Reads one pre-decoded PNG per input path, outside the timer.
//! Usage: ocr_corpus ENGINE PROFILE IMAGE_DIRECTORY [REPEATS]
use anyhow::{Context, Result, ensure};
use gsm_overlay::engines::{Engines, vocr};
use gsm_overlay::{
    ocr::second_pass_crop,
    pipeline::{Recognition, remap_line},
};
use image::RgbaImage;
use serde_json::json;
use std::{path::Path, time::Instant};

fn read(engines: &mut Engines, image: &RgbaImage, engine: &str) -> Result<Recognition> {
    let (stability, main) = match engine {
        "mida_screenai" => ("mida_detector", "screenai"),
        "mida_mida_vocr" => ("mida_detector", "mida_vocr"),
        "meiki_screenai" => ("meiki_text_detector", "screenai"),
        _ => return engines.recognize(image, engine, "ja"),
    };
    // Inference for a settled frame at 100% first-pass scale, excluding the user's wait interval.
    let first = engines.recognize(image, stability, "ja")?;
    let Some((crop, x, y)) = second_pass_crop(image, &first) else {
        return Ok(Recognition::default());
    };
    let mut result = engines.recognize(&crop, main, "ja")?;
    for line in &mut result.lines {
        remap_line(line, (x as f64, y as f64), (1., 1.));
    }
    Ok(result)
}

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(
        (4..=5).contains(&args.len()),
        "Expected ENGINE PROFILE IMAGE_DIRECTORY [REPEATS]"
    );
    ensure!(
        matches!(
            args[1].as_str(),
            "meikiocr"
                | "mida_vocr"
                | "mida_detector"
                | "mida_screenai"
                | "mida_mida_vocr"
                | "meiki_screenai"
                | "vitaocr"
                | "vocr_detector"
                | "oneocr"
                | "screenai"
                | "meiki_text_detector"
        ),
        "Select a local CPU OCR engine"
    );
    let repeats: usize = args.get(4).map(|s| s.parse()).transpose()?.unwrap_or(1);
    ensure!(repeats > 0, "Expected at least one reading");
    let mut paths = std::fs::read_dir(&args[3])?
        .map(|p| Ok(p?.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    paths.retain(|p| p.extension().is_some_and(|e| e == "png"));
    paths.sort();
    let cache = tempfile::tempdir()?;
    vocr::set_asset_directory(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../GameSentenceMiner/assets/vocr"),
        cache.path().to_owned(),
    )?;
    let mut engines = Engines::new(Path::new(&args[2]));
    let warmup = image::open(paths.last().context("No PNGs in the input folder")?)?.to_rgba8();
    read(&mut engines, &warmup, &args[1])?;
    for path in paths {
        let mut image = image::open(&path)?.to_rgba8();
        for repeat in 0..repeats {
            // Model a changing frame with unchanged dialogue. Detection still runs.
            image.get_pixel_mut(0, 0)[0] ^= 1;
            let start = Instant::now();
            let result = read(&mut engines, &image, &args[1])?;
            let ms = start.elapsed().as_secs_f64() * 1000.;
            println!(
                "{}",
                json!({"file":path.file_name().unwrap().to_string_lossy(),"repeat":repeat,"ms":ms,"result":result})
            );
        }
    }
    Ok(())
}
