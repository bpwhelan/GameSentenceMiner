use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;
#[test]
fn external_models_are_verified_and_missing_or_modified_files_fail() -> Result<()> {
    verify_bundled()?;
    let directory = tempfile::tempdir()?;
    assert!(verified_model(directory.path(), SMALL).is_err());
    std::fs::write(directory.path().join(SMALL), b"changed model")?;
    assert!(
        verified_model(directory.path(), SMALL)
            .unwrap_err()
            .to_string()
            .contains("checksum")
    );
    let original = verified_model(&asset_directory()?, SMALL)?;
    std::fs::write(directory.path().join(SMALL), &original)?;
    assert_eq!(verified_model(directory.path(), SMALL)?, original);
    assert!(verified_model(directory.path(), "../small-faithful.onnx").is_err());
    Ok(())
}
fn reference() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/vocr_geometry.json")).unwrap()
}
fn patterned(w: u32, h: u32, x: u32, y: u32) -> image::GrayImage {
    image::GrayImage::from_fn(w, h, |a, b| image::Luma([((a * x + b * y) % 256) as u8]))
}
#[test]
fn line_preparation_matches_opencv_on_odd_tiny_and_clamped_images() {
    for case in reference()["preprocess"].as_array().unwrap() {
        let (w, h) = (
            case["w"].as_u64().unwrap() as u32,
            case["h"].as_u64().unwrap() as u32,
        );
        let (values, width) = pixels::prepare(&patterned(w, h, 17, 13), case["dark"] == true);
        assert_eq!(width, case["width"].as_u64().unwrap() as u32);
        let actual: Vec<_> = values
            .iter()
            .map(|v| ((v + 1.) * 127.5).round_ties_even() as u8)
            .collect();
        let expected = STANDARD.decode(case["pixels"].as_str().unwrap()).unwrap();
        assert_eq!(actual.len(), expected.len());
        let differences: Vec<_> = actual
            .iter()
            .zip(&expected)
            .enumerate()
            .filter(|(_, (a, b))| a != b)
            .take(12)
            .collect();
        assert!(
            differences.is_empty(),
            "{w}x{h}, dark={}: {differences:?}",
            case["dark"]
        );
    }
}
#[test]
fn character_cells_and_detection_order_match_the_reference() {
    let fixture = reference();
    for case in fixture["positions"].as_array().unwrap() {
        let actual = charbox::positions(
            &serde_json::from_value::<Vec<i64>>(case["best"].clone()).unwrap(),
            case["w"].as_i64().unwrap(),
            case["h"].as_i64().unwrap(),
            case["nw"].as_i64().unwrap(),
            &serde_json::from_value::<Vec<i64>>(case["profile"].clone()).unwrap(),
        );
        assert_eq!(serde_json::to_value(actual).unwrap(), case["expected"]);
    }
    for case in fixture["spot"].as_array().unwrap() {
        let shape: Vec<usize> = serde_json::from_value(case["shape"].clone()).unwrap();
        let maps: Vec<i64> = serde_json::from_value(case["maps"].clone()).unwrap();
        let actual = decode::spot(
            &maps,
            shape[0],
            shape[1],
            shape[2],
            &patterned(192, 128, 7, 11),
        )
        .unwrap();
        assert_eq!(serde_json::to_value(actual.boxes).unwrap(), case["boxes"]);
        assert_eq!(actual.truncated, case["truncated"] == true);
    }
}
#[test]
fn gradient_fallback_preserves_polarity_and_refuses_truncation() {
    for case in reference()["grad"].as_array().unwrap() {
        let count = case["count"].as_u64().unwrap() as u32;
        let mut grey = image::GrayImage::from_pixel(200, 64.max(count * 30), image::Luma([255]));
        for line in 0..count {
            for x in (12..182).step_by(12) {
                for y in 8 + line * 30..22 + line * 30 {
                    for xx in x..x + 6 {
                        grey[(xx, y)][0] = 0;
                    }
                }
            }
        }
        let result = grad::find(&grey);
        assert_eq!(
            json!(
                result
                    .boxes
                    .iter()
                    .map(|b| [b.x, b.y, b.w, b.h])
                    .collect::<Vec<_>>()
            ),
            case["boxes"]
        );
        assert_eq!(
            json!(result.boxes.iter().map(|b| b.dark).collect::<Vec<_>>()),
            case["dark"]
        );
        assert_eq!(result.truncated, case["truncated"] == true);
    }
}
#[test]
fn bundled_models_recognize_japanese_and_preserve_per_character_geometry_without_downloads()
-> Result<()> {
    let image =
        image::load_from_memory(include_bytes!("../../../tests/fixtures/dialogue.png"))?.to_rgba8();
    let fixture = reference();
    for model in [Tier::Small, Tier::Normal, Tier::Large] {
        let mut runtime = Vocr::new(model)?;
        let actual = runtime.recognize(&image)?;
        let lines:Vec<_>=actual.lines.iter().map(|line|json!({"text":line.text,"box":[line.bounds[0],line.bounds[1],line.bounds[2]-line.bounds[0],line.bounds[3]-line.bounds[1]],"characters":line.words.iter().map(|c|json!({"text":c.text,"box":[c.bounds[0],c.bounds[1],c.bounds[2]-c.bounds[0],c.bounds[3]-c.bounds[1]]})).collect::<Vec<_>>()})).collect();
        // JSON numeric representation differs, so compare parsed numeric edges.
        let expected = &fixture["recognition"][model.name()];
        assert_eq!(lines.len(), expected.as_array().unwrap().len());
        for (a, e) in lines.iter().zip(expected.as_array().unwrap()) {
            assert_eq!(a["text"], e["text"], "{}", model.name());
            for (a, e) in a["box"]
                .as_array()
                .unwrap()
                .iter()
                .zip(e["box"].as_array().unwrap())
            {
                assert_eq!(a.as_f64(), e.as_f64());
            }
            assert_eq!(
                a["characters"].as_array().unwrap().len(),
                e["characters"].as_array().unwrap().len()
            );
            for (a, e) in a["characters"]
                .as_array()
                .unwrap()
                .iter()
                .zip(e["characters"].as_array().unwrap())
            {
                assert_eq!(a["text"], e["text"]);
                for (a, e) in a["box"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .zip(e["box"].as_array().unwrap())
                {
                    assert_eq!(a.as_f64(), e.as_f64());
                }
            }
        }
        for color in [0, 255] {
            assert!(
                runtime
                    .recognize(&RgbaImage::from_pixel(
                        99,
                        51,
                        image::Rgba([color, color, color, 255])
                    ))?
                    .lines
                    .is_empty()
            );
        }
    }
    Ok(())
}
#[test]
fn model_selection_is_atomic_shared_and_does_not_copy_model_files() -> Result<()> {
    let root = tempfile::tempdir()?;
    assert_eq!(Tier::read(root.path())?, Tier::Normal);
    Tier::Small.select(root.path())?;
    assert_eq!(Tier::read(root.path())?, Tier::Small);
    let directory = Tier::directory(root.path())?;
    let files: Vec<_> = std::fs::read_dir(&directory)?.collect::<std::io::Result<Vec<_>>>()?;
    assert_eq!(files.len(), 2);
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(directory.join("selection.lock"))?;
    lock.try_lock()?;
    assert!(Tier::Large.select(root.path()).is_err());
    assert_eq!(Tier::read(root.path())?, Tier::Small);
    drop(lock);
    Tier::Large.select(root.path())?;
    assert_eq!(Tier::read(root.path())?, Tier::Large);
    Ok(())
}

#[test]
fn main_and_overlay_engine_dispatch_observe_the_shared_vocr_model_choice() -> Result<()> {
    let root = tempfile::tempdir()?;
    let image =
        image::load_from_memory(include_bytes!("../../../tests/fixtures/dialogue.png"))?.to_rgba8();
    let mut engines = crate::engines::Engines::new(root.path());
    let detected = engines.recognize(&image, "vocr_detector", "ja")?;
    assert_eq!(detected.detections.len(), 2);
    assert!(detected.lines.is_empty());
    let normal = engines.recognize(&image, "vitaocr", "ja")?;
    assert!(normal.text.contains("GameSentenceMiner"));
    Tier::Small.select(root.path())?;
    let small = engines.recognize(&image, "vitaocr", "ja")?;
    assert!(small.text.contains("GarmeSentenCeMiner"));
    assert_eq!(normal.model["size"], "normal");
    assert_eq!(small.model["size"], "small");
    assert_eq!(small.model["revision"], super::selection::REVISION);
    assert!(!root.path().join("ocr_models").exists());
    Ok(())
}
