//! Exercise the same OCR/layout pipeline as Tauri against a saved screenshot.
use gsm_overlay::{
    engines::Engines,
    pipeline::{Projection, prepare},
};
fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(args.len() == 3, "Usage: recognize ENGINE IMAGE");
    gsm_overlay::engines::vocr::set_asset_directory(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../GameSentenceMiner/assets/vocr"),
    )?;
    let image = image::open(&args[2])?.to_rgba8();
    let root = tempfile::tempdir()?;
    let mut engines = Engines::new(root.path());
    let result = engines.recognize(&image, &args[1], "ja")?;
    let projection = Projection {
        monitor: [0., 0., image.width() as f64, image.height() as f64],
        capture: [0., 0., image.width() as f64, image.height() as f64],
        image_size: image.dimensions(),
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&prepare(result.lines, "ja", 0., false, &projection))?
    );
    Ok(())
}
