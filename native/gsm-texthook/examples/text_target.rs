//! Disposable, self-owned target for the real injection smoke test. No game is
//! opened or modified. Both x86 and x64 builds exercise the same GDI text API.
#[cfg(windows)]
fn main() {
    use windows::Win32::Graphics::Gdi::*;
    unsafe {
        let dc = CreateCompatibleDC(None);
        // A failed driver cannot leave the fixture running indefinitely.
        for counter in 0..160 {
            let text = format!("GSM native hook 日本語🦀 {counter}")
                .encode_utf16()
                .chain(Some(0))
                .collect::<Vec<_>>();
            let _ = TextOutW(dc, 0, 0, &text[..text.len() - 1]);
            // Leave a quiet interval so the engines' own sentence timer flushes.
            std::thread::sleep(std::time::Duration::from_millis(750));
        }
    }
}
#[cfg(not(windows))]
fn main() {
    panic!("The GDI injection fixture requires Windows");
}
