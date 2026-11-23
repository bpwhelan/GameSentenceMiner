fn main() {
    if std::env::var("TARGET").as_deref() == Ok("x86_64-apple-darwin") {
        // The Intel bundle links ONNX Runtime from Contents/Frameworks.
        println!("cargo:rustc-link-arg-bin=gsm-desktop=-Wl,-rpath,@executable_path/../Frameworks");
    }
    // UI files are served once from packaged resources by our gsm: protocols.
    // frontendDist contains only a placeholder, not another embedded UI copy.
    tauri_build::build()
}
