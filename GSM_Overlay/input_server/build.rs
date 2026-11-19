fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let icon = "../../assets/gsm.ico";
    println!("cargo:rerun-if-changed={icon}");
    tauri_winres::WindowsResource::new()
        .set("FileDescription", "GSM Overlay Helper")
        .set("ProductName", "GSM")
        .set_icon(icon)
        .compile()
        .expect("embed GSM overlay helper identity");
}
