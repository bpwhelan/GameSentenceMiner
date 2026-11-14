fn main() {
    // UI files are served once from packaged resources by our gsm: protocols.
    // frontendDist contains only a placeholder, not another embedded UI copy.
    tauri_build::build()
}
