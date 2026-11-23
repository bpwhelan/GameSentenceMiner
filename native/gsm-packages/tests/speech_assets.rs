use gsm_packages::speech::prepare_bundle;
use std::{fs, io::Write};
use zip::{write::SimpleFileOptions, ZipWriter};

#[test]
fn offline_archive_is_reusable_and_failed_extraction_does_not_publish() {
    let temp = tempfile::tempdir().unwrap();
    let cache = temp.path().join("windows-speech");
    let archive = temp.path().join("offline.zip");
    let url = reqwest::Url::from_file_path(&archive).unwrap();
    let write = |invalid: bool| {
        let mut zip = ZipWriter::new(fs::File::create(&archive).unwrap());
        for file in [
            "DirectLiveCaptions/Microsoft.CognitiveServices.Speech.core.dll",
            "DirectLiveCaptions/MicrosoftWindows.Speech.ja-JP.1_fixture/sr.ini",
            "DirectLiveCaptions/MicrosoftWindows.Speech.ja-JP.1_fixture/svad.quantized.onnx",
        ] {
            zip.start_file(file, SimpleFileOptions::default()).unwrap();
            zip.write_all(b"fixture").unwrap();
        }
        if invalid {
            zip.start_file("../unexpected", SimpleFileOptions::default())
                .unwrap();
        }
        zip.finish().unwrap();
    };
    write(true);
    assert!(prepare_bundle(&cache, url.as_str(), &|_, _| {}).is_err());
    assert!(!cache.join("DirectLiveCaptions").exists());
    write(false);
    let root = prepare_bundle(&cache, url.as_str(), &|_, _| {}).unwrap();
    assert!(root
        .join("Microsoft.CognitiveServices.Speech.core.dll")
        .is_file());
    assert!(archive.is_file());
    fs::remove_file(archive).unwrap();
    assert_eq!(
        prepare_bundle(&cache, url.as_str(), &|_, _| {}).unwrap(),
        root
    );
}
