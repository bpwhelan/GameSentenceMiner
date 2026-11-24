//! OneOCR native runtime integration.
//!
//! This mirrors the small C ABI exposed by the `oneocr` Python package, but
//! calls the DLL directly so the tray application does not need an OCR HTTP
//! server or a Python process.

use crate::pipeline::Recognition;
use anyhow::Result;
use image::RgbaImage;
use std::{
    borrow::Cow,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
#[cfg(unix)]
mod portable;
#[cfg(unix)]
use portable::Engine;
#[cfg(windows)]
use windows_impl::Engine;

#[cfg(windows)]
mod windows_impl {
    use super::*;
    use crate::pipeline::TextBox;
    use anyhow::{bail, Context};
    use libloading::Library;

    use std::ffi::{CStr, CString, c_char};

    const DLL_NAME: &str = "oneocr.dll";
    const MODEL_NAME: &str = "oneocr.onemodel";
    const MODEL_KEY: &[u8] = b"kj)TGtrK>f]b[Piow.gU+nC@s\"\"\"\"\"\"4";

    type CreateOcrInitOptions = unsafe extern "system" fn(*mut i64) -> i64;
    type OcrInitOptionsSetUseModelDelayLoad = unsafe extern "system" fn(i64, i8) -> i64;
    type CreateOcrPipeline =
        unsafe extern "system" fn(*const c_char, *const c_char, i64, *mut i64) -> i64;
    type CreateOcrProcessOptions = unsafe extern "system" fn(*mut i64) -> i64;
    type OcrProcessOptionsSetMaxRecognitionLineCount = unsafe extern "system" fn(i64, i64) -> i64;
    type RunOcrPipeline =
        unsafe extern "system" fn(i64, *const ImageStructure, i64, *mut i64) -> i64;
    type GetOcrLineCount = unsafe extern "system" fn(i64, *mut i64) -> i64;
    type GetOcrLine = unsafe extern "system" fn(i64, i64, *mut i64) -> i64;
    type GetOcrLineContent = unsafe extern "system" fn(i64, *mut *const c_char) -> i64;
    type GetBoundingBox = unsafe extern "system" fn(i64, *mut *const BoundingBox) -> i64;
    #[repr(C)]
    struct BoundingBox {
        points: [f32; 8],
    }
    type ReleaseOcrResult = unsafe extern "system" fn(i64);
    type ReleaseOcrInitOptions = unsafe extern "system" fn(i64);
    type ReleaseOcrPipeline = unsafe extern "system" fn(i64);
    type ReleaseOcrProcessOptions = unsafe extern "system" fn(i64);

    #[repr(C)]
    struct ImageStructure {
        image_type: i32,
        width: i32,
        height: i32,
        reserved: i32,
        step_size: i64,
        data_ptr: *const u8,
    }

    struct Api {
        _library: Library,
        create_init_options: CreateOcrInitOptions,
        set_delay_load: OcrInitOptionsSetUseModelDelayLoad,
        create_pipeline: CreateOcrPipeline,
        create_process_options: CreateOcrProcessOptions,
        set_max_line_count: OcrProcessOptionsSetMaxRecognitionLineCount,
        run_pipeline: RunOcrPipeline,
        get_line_count: GetOcrLineCount,
        get_line: GetOcrLine,
        get_line_content: GetOcrLineContent,
        get_line_bounds: GetBoundingBox,
        get_word_count: GetOcrLineCount,
        get_word: GetOcrLine,
        get_word_content: GetOcrLineContent,
        get_word_bounds: GetBoundingBox,
        release_result: ReleaseOcrResult,
        release_init_options: ReleaseOcrInitOptions,
        release_pipeline: ReleaseOcrPipeline,
        release_process_options: ReleaseOcrProcessOptions,
    }

    unsafe fn load_symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T> {
        // The symbol is copied out while the Library is retained in Api.
        Ok(*unsafe { library.get::<T>(name) }
            .with_context(|| format!("load OneOCR symbol {}", String::from_utf8_lossy(name)))?)
    }

    impl Api {
        fn load(directory: &std::path::Path) -> Result<Self> {
            let library = unsafe {
                crate::models::load_library(&directory.join(DLL_NAME))
                    .with_context(|| format!("load {}", directory.join(DLL_NAME).display()))?
            };

            Ok(Self {
                create_init_options: unsafe { load_symbol(&library, b"CreateOcrInitOptions\0")? },
                set_delay_load: unsafe {
                    load_symbol(&library, b"OcrInitOptionsSetUseModelDelayLoad\0")?
                },
                create_pipeline: unsafe { load_symbol(&library, b"CreateOcrPipeline\0")? },
                create_process_options: unsafe {
                    load_symbol(&library, b"CreateOcrProcessOptions\0")?
                },
                set_max_line_count: unsafe {
                    load_symbol(&library, b"OcrProcessOptionsSetMaxRecognitionLineCount\0")?
                },
                run_pipeline: unsafe { load_symbol(&library, b"RunOcrPipeline\0")? },
                get_line_count: unsafe { load_symbol(&library, b"GetOcrLineCount\0")? },
                get_line: unsafe { load_symbol(&library, b"GetOcrLine\0")? },
                get_line_content: unsafe { load_symbol(&library, b"GetOcrLineContent\0")? },
                get_line_bounds: unsafe { load_symbol(&library, b"GetOcrLineBoundingBox\0")? },
                get_word_count: unsafe { load_symbol(&library, b"GetOcrLineWordCount\0")? },
                get_word: unsafe { load_symbol(&library, b"GetOcrWord\0")? },
                get_word_content: unsafe { load_symbol(&library, b"GetOcrWordContent\0")? },
                get_word_bounds: unsafe { load_symbol(&library, b"GetOcrWordBoundingBox\0")? },
                release_result: unsafe { load_symbol(&library, b"ReleaseOcrResult\0")? },
                release_init_options: unsafe { load_symbol(&library, b"ReleaseOcrInitOptions\0")? },
                release_pipeline: unsafe { load_symbol(&library, b"ReleaseOcrPipeline\0")? },
                release_process_options: unsafe {
                    load_symbol(&library, b"ReleaseOcrProcessOptions\0")?
                },
                _library: library,
            })
        }
    }

    pub(super) struct Engine {
        api: Api,
        init_options: i64,
        pipeline: i64,
        process_options: i64,
        reg: crate::engines::telemetry::ModelRegistration,
    }

    fn oneocr_file_bytes(directory: &std::path::Path) -> u64 {
        [DLL_NAME, MODEL_NAME, "onnxruntime.dll"]
            .into_iter()
            .filter_map(|name| std::fs::metadata(directory.join(name)).ok())
            .map(|m| m.len())
            .sum()
    }

    impl Engine {
        pub(super) fn new() -> Result<Self> {
            let directory = crate::models::oneocr::directory()?;
            crate::models::oneocr::prepare(&directory, &|_, _| {})?;
            let file_bytes = oneocr_file_bytes(&directory);
            let ((api, init_options, pipeline, process_options), reg) =
                crate::engines::telemetry::ModelRegistration::measure_load(
                    "oneocr",
                    "OneOCR",
                    None,
                    file_bytes,
                    true,
                    || {
                        let api = Api::load(&directory)?;
                        let mut init_options = 0_i64;
                        check(
                            unsafe { (api.create_init_options)(&mut init_options) },
                            "create init options",
                        )?;
                        check(
                            unsafe { (api.set_delay_load)(init_options, 0) },
                            "configure model loading",
                        )?;

                        let model_path = CString::new(
                            directory.join(MODEL_NAME).to_string_lossy().as_bytes(),
                        )
                        .context("encode OneOCR model path")?;
                        let model_key =
                            CString::new(MODEL_KEY).context("encode OneOCR model key")?;
                        let mut pipeline = 0_i64;
                        if let Err(error) = check(
                            unsafe {
                                (api.create_pipeline)(
                                    model_path.as_ptr(),
                                    model_key.as_ptr(),
                                    init_options,
                                    &mut pipeline,
                                )
                            },
                            "create pipeline",
                        ) {
                            unsafe { (api.release_init_options)(init_options) };
                            return Err(error);
                        }

                        let mut process_options = 0_i64;
                        if let Err(error) = check(
                            unsafe { (api.create_process_options)(&mut process_options) },
                            "create process options",
                        ) {
                            unsafe {
                                (api.release_pipeline)(pipeline);
                                (api.release_init_options)(init_options);
                            }
                            return Err(error);
                        }
                        if let Err(error) = check(
                            unsafe { (api.set_max_line_count)(process_options, 1000) },
                            "configure maximum line count",
                        ) {
                            unsafe {
                                (api.release_process_options)(process_options);
                                (api.release_pipeline)(pipeline);
                                (api.release_init_options)(init_options);
                            }
                            return Err(error);
                        }
                        Ok((api, init_options, pipeline, process_options))
                    },
                )?;

            Ok(Self {
                api,
                init_options,
                pipeline,
                process_options,
                reg,
            })
        }

        pub(super) fn recognize(&self, image: &RgbaImage) -> Result<Recognition> {
            self.reg.touch();
            let structure = ImageStructure {
                image_type: 3,
                width: image.width() as i32,
                height: image.height() as i32,
                reserved: 0,
                step_size: (image.width() * 4) as i64,
                // GSM's Python adapter passes RGBA bytes unchanged. The native
                // pipeline reads the image synchronously; retain its owner here.
                data_ptr: image.as_raw().as_ptr(),
            };
            let mut result = 0_i64;
            check(
                unsafe {
                    (self.api.run_pipeline)(
                        self.pipeline,
                        &structure,
                        self.process_options,
                        &mut result,
                    )
                },
                "run OneOCR",
            )?;

            let parsed = self.read_result(result);
            unsafe { (self.api.release_result)(result) };
            parsed
        }

        fn read_result(&self, result: i64) -> Result<Recognition> {
            let mut count = 0_i64;
            check(
                unsafe { (self.api.get_line_count)(result, &mut count) },
                "read OneOCR line count",
            )?;
            let mut lines = Vec::new();
            for index in 0..count.max(0) {
                let mut line = 0_i64;
                if unsafe { (self.api.get_line)(result, index, &mut line) } != 0 {
                    continue;
                }
                let mut content: *const c_char = std::ptr::null();
                if unsafe { (self.api.get_line_content)(line, &mut content) } == 0
                    && !content.is_null()
                {
                    let text = unsafe { CStr::from_ptr(content) }
                        .to_string_lossy()
                        .trim()
                        .to_string();
                    if !text.is_empty() {
                        let bounds = self.bounds(line, self.api.get_line_bounds)?;
                        let mut words = Vec::new();
                        let mut word_count = 0;
                        check(
                            unsafe { (self.api.get_word_count)(line, &mut word_count) },
                            "read word count",
                        )?;
                        for index in 0..word_count.max(0) {
                            let mut word = 0;
                            check(
                                unsafe { (self.api.get_word)(line, index, &mut word) },
                                "read word",
                            )?;
                            let mut content = std::ptr::null();
                            check(
                                unsafe { (self.api.get_word_content)(word, &mut content) },
                                "read word content",
                            )?;
                            if !content.is_null() {
                                words.push(TextBox {
                                    text: unsafe { CStr::from_ptr(content) }
                                        .to_string_lossy()
                                        .into_owned(),
                                    bounds: self.bounds(word, self.api.get_word_bounds)?,
                                    ..Default::default()
                                });
                            }
                        }
                        lines.push(TextBox {
                            text,
                            bounds,
                            words,
                            vertical: bounds[3] - bounds[1] > bounds[2] - bounds[0],
                        });
                    }
                }
            }
            Ok(Recognition::from_lines(lines))
        }
        fn bounds(&self, handle: i64, read: GetBoundingBox) -> Result<[f64; 4]> {
            let mut value = std::ptr::null();
            check(unsafe { read(handle, &mut value) }, "read bounding box")?;
            if value.is_null() {
                return Ok([0.0; 4]);
            }
            let p = &unsafe { &*value }.points;
            Ok([
                p.iter().step_by(2).copied().fold(f32::INFINITY, f32::min) as f64,
                p.iter()
                    .skip(1)
                    .step_by(2)
                    .copied()
                    .fold(f32::INFINITY, f32::min) as f64,
                p.iter()
                    .step_by(2)
                    .copied()
                    .fold(f32::NEG_INFINITY, f32::max) as f64,
                p.iter()
                    .skip(1)
                    .step_by(2)
                    .copied()
                    .fold(f32::NEG_INFINITY, f32::max) as f64,
            ])
        }
    }

    impl Drop for Engine {
        fn drop(&mut self) {
            unsafe {
                if self.process_options != 0 {
                    (self.api.release_process_options)(self.process_options);
                }
                if self.pipeline != 0 {
                    (self.api.release_pipeline)(self.pipeline);
                }
                if self.init_options != 0 {
                    (self.api.release_init_options)(self.init_options);
                }
            }
        }
    }

    fn check(code: i64, operation: &str) -> Result<()> {
        if code == 0 {
            Ok(())
        } else {
            bail!("{operation} failed (OneOCR code {code})")
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        #[ignore = "Requires the installed OneOCR runtime/model"]
        fn idle_pipeline_is_released_and_can_be_loaded_again() {
            let image = RgbaImage::from_pixel(200, 100, image::Rgba([255, 255, 255, 255]));
            let first = ocr_image(&image).unwrap();
            assert!(!release_idle(Duration::from_secs(60)));
            assert!(release_idle(Duration::ZERO));
            assert!(!release_idle(Duration::ZERO));
            let second = ocr_image(&image).unwrap();
            assert_eq!(first.text, second.text);
            assert!(release_idle(Duration::ZERO));
        }
        #[test]
        fn regular_images_keep_the_python_rgba_bytes_without_copying() {
            let image = RgbaImage::from_pixel(100, 60, image::Rgba([11, 71, 239, 255]));
            let prepared = prepare_image(&image);
            assert!(matches!(prepared, Cow::Borrowed(_)));
            assert_eq!(prepared.as_raw().as_ptr(), image.as_raw().as_ptr());
            assert_eq!(prepared.get_pixel(0, 0).0, [11, 71, 239, 255]);
        }
        #[test]
        fn small_images_are_centered_in_opaque_black_padding() {
            let image = RgbaImage::from_pixel(7, 9, image::Rgba([11, 71, 239, 255]));
            let prepared = prepare_image(&image);
            assert_eq!(prepared.dimensions(), (51, 51));
            assert_eq!(prepared.get_pixel(22, 21), image.get_pixel(0, 0));
            assert_eq!(prepared.get_pixel(0, 0).0, [0, 0, 0, 255]);
        }
    }
}

fn prepare_image(image: &RgbaImage) -> Cow<'_, RgbaImage> {
    let mut width = image.width();
    let mut height = image.height();
    if width < 51 || height < 51 {
        width = width.max(51);
        height = height.max(51);
        let mut padded = RgbaImage::from_pixel(width, height, image::Rgba([0, 0, 0, 255]));
        image::imageops::overlay(
            &mut padded,
            image,
            ((width - image.width()) / 2) as i64,
            ((height - image.height()) / 2) as i64,
        );
        return Cow::Owned(padded);
    }
    if width > 10_000 || height > 10_000 {
        let scale = (10_000.0 / width as f64).min(10_000.0 / height as f64);
        width = ((width as f64 * scale).round() as u32).max(1);
        height = ((height as f64 * scale).round() as u32).max(1);
        return Cow::Owned(image::imageops::resize(
            image,
            width,
            height,
            image::imageops::FilterType::Lanczos3,
        ));
    }
    Cow::Borrowed(image)
}

static ENGINE: OnceLock<Mutex<Option<(Engine, Instant)>>> = OnceLock::new();

pub fn release_idle(idle_for: Duration) -> bool {
    let Some(lock) = ENGINE.get() else {
        return false;
    };
    // Inference holds this lock. Never wait for or evict an in-flight scan.
    let Ok(mut guard) = lock.try_lock() else {
        return false;
    };
    if guard
        .as_ref()
        .is_some_and(|(_, used)| used.elapsed() >= idle_for)
    {
        *guard = None;
        return true;
    }
    false
}

pub fn ocr_image(image: &RgbaImage) -> Result<Recognition> {
    let lock = ENGINE.get_or_init(|| Mutex::new(None));
    let mut guard = lock
        .lock()
        .map_err(|_| anyhow::anyhow!("OneOCR engine lock poisoned"))?;
    if guard.is_none() {
        *guard = Some((Engine::new()?, Instant::now()));
    }
    let (engine, used) = guard.as_mut().expect("OneOCR engine initialized");
    let original = image.dimensions();
    let image = prepare_image(image);
    let result = engine.recognize(&image).map(|mut result| {
        let (offset, scale) = if original.0 < 51 || original.1 < 51 {
            (
                (
                    -(((image.width() - original.0) / 2) as f64),
                    -(((image.height() - original.1) / 2) as f64),
                ),
                (1.0, 1.0),
            )
        } else {
            (
                (0.0, 0.0),
                (
                    original.0 as f64 / image.width() as f64,
                    original.1 as f64 / image.height() as f64,
                ),
            )
        };
        for line in &mut result.lines {
            crate::pipeline::remap_line(line, offset, scale);
        }
        result
    });
    *used = Instant::now();
    #[cfg(unix)]
    if result.is_err() {
        *guard = None;
    }
    result
}
