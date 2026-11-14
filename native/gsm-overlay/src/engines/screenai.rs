//! ScreenAI native runtime integration.
//!
//! ScreenAI exposes a small C ABI. Its OCR result is a protobuf payload; the
//! parser below intentionally reads only the line/word text fields needed by
//! this clipboard utility, while skipping fields added by newer runtimes.

use crate::pipeline::{Recognition, TextBox};
use anyhow::{Context, Result, bail};
use image::RgbaImage;
use prost::Message;

#[derive(Clone, PartialEq, Message)]
struct Annotation {
    #[prost(message, repeated, tag = "2")]
    lines: Vec<Line>,
}
#[derive(Clone, PartialEq, Message)]
struct Line {
    #[prost(message, repeated, tag = "1")]
    words: Vec<Word>,
    #[prost(message, optional, tag = "2")]
    rect: Option<Rect>,
    #[prost(string, tag = "3")]
    text: String,
}
#[derive(Clone, PartialEq, Message)]
struct Word {
    #[prost(message, optional, tag = "2")]
    rect: Option<Rect>,
    #[prost(string, tag = "3")]
    text: String,
    #[prost(bool, tag = "6")]
    space: bool,
}
#[derive(Clone, PartialEq, Message)]
struct Rect {
    #[prost(int32, tag = "1")]
    x: i32,
    #[prost(int32, tag = "2")]
    y: i32,
    #[prost(int32, tag = "3")]
    width: i32,
    #[prost(int32, tag = "4")]
    height: i32,
    #[prost(float, tag = "5")]
    angle: f32,
}
fn bounds(rect: &Option<Rect>) -> [f64; 4] {
    let Some(r) = rect else {
        return [0.0; 4];
    };
    [
        r.x as f64,
        r.y as f64,
        (r.x + r.width) as f64,
        (r.y + r.height) as f64,
    ]
}
fn parse_annotation(bytes: &[u8]) -> Result<Recognition> {
    let data = Annotation::decode(bytes)?;
    Ok(Recognition::from_lines(
        data.lines
            .into_iter()
            .map(|l| {
                let text = if l.text.is_empty() {
                    l.words
                        .iter()
                        .map(|w| format!("{}{}", w.text, if w.space { " " } else { "" }))
                        .collect::<String>()
                } else {
                    l.text
                };
                let bbox = bounds(&l.rect);
                TextBox {
                    text: text.trim().to_owned(),
                    bounds: bbox,
                    vertical: bbox[3] - bbox[1] > bbox[2] - bbox[0],
                    words: l
                        .words
                        .into_iter()
                        .map(|w| TextBox {
                            text: w.text,
                            bounds: bounds(&w.rect),
                            ..Default::default()
                        })
                        .collect(),
                }
            })
            .collect(),
    ))
}

mod native_impl {
    use super::*;
    use libloading::Library;
    use std::collections::HashMap;
    use std::ffi::{CStr, c_char, c_void};
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    type SetFileContentFunctions = unsafe extern "C" fn(*mut c_void, *mut c_void);
    type InitOcrUsingCallback = unsafe extern "C" fn() -> u8;
    type SetOcrLightMode = unsafe extern "C" fn(u8);
    type PerformOcr = unsafe extern "C" fn(*const SkBitmap, *mut u32) -> *mut c_char;
    type FreeLibraryAllocatedCharArray = unsafe extern "C" fn(*mut c_char);

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct SkColorInfo {
        color_space: *mut c_void,
        color_type: i32,
        alpha_type: i32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct SkImageSize {
        width: i32,
        height: i32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct SkImageInfo {
        color_info: SkColorInfo,
        dimensions: SkImageSize,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct SkPixmap {
        pixels: *mut c_void,
        row_bytes: usize,
        info: SkImageInfo,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct SkBitmap {
        pixel_ref: *mut c_void,
        pixmap: SkPixmap,
        flags: u32,
    }

    struct Api {
        _library: Library,
        set_file_content_functions: SetFileContentFunctions,
        init_ocr: InitOcrUsingCallback,
        set_light_mode: SetOcrLightMode,
        perform_ocr: PerformOcr,
        free_result: FreeLibraryAllocatedCharArray,
    }

    unsafe fn load_symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T> {
        Ok(*unsafe { library.get::<T>(name) }
            .with_context(|| format!("load ScreenAI symbol {}", String::from_utf8_lossy(name)))?)
    }

    impl Api {
        fn load(path: &PathBuf) -> Result<Self> {
            let library = unsafe {
                crate::models::load_library(path)
                    .with_context(|| format!("load {}", path.display()))?
            };
            Ok(Self {
                set_file_content_functions: unsafe {
                    load_symbol(&library, b"SetFileContentFunctions\0")?
                },
                init_ocr: unsafe { load_symbol(&library, b"InitOCRUsingCallback\0")? },
                set_light_mode: unsafe { load_symbol(&library, b"SetOCRLightMode\0")? },
                perform_ocr: unsafe { load_symbol(&library, b"PerformOCR\0")? },
                free_result: unsafe { load_symbol(&library, b"FreeLibraryAllocatedCharArray\0")? },
                _library: library,
            })
        }
    }

    struct ResourceState {
        root: PathBuf,
        cache: Mutex<HashMap<String, Vec<u8>>>,
    }

    static RESOURCES: OnceLock<ResourceState> = OnceLock::new();

    unsafe extern "C" fn resource_size(path: *const c_char) -> u32 {
        resource_bytes(path)
            .map(|bytes| bytes.len() as u32)
            .unwrap_or(0)
    }

    unsafe extern "C" fn resource_data(
        path: *const c_char,
        requested_size: u32,
        target: *mut c_void,
    ) {
        let Some(bytes) = resource_bytes(path) else {
            return;
        };
        let size = bytes.len().min(requested_size as usize);
        if size == 0 || target.is_null() {
            return;
        }
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), target as *mut u8, size);
        }
    }

    fn resource_bytes(path: *const c_char) -> Option<Vec<u8>> {
        if path.is_null() {
            return None;
        }
        let raw = unsafe { CStr::from_ptr(path) }.to_string_lossy();
        let normalized = normalize_resource_path(&raw)?;
        let state = RESOURCES.get()?;
        if let Ok(cache) = state.cache.lock()
            && let Some(bytes) = cache.get(&normalized)
        {
            return Some(bytes.clone());
        }
        let file_path = state.root.join(&normalized);
        let bytes = std::fs::read(file_path).ok()?;
        if let Ok(mut cache) = state.cache.lock() {
            cache.insert(normalized, bytes.clone());
        }
        Some(bytes)
    }

    fn normalize_resource_path(raw: &str) -> Option<String> {
        let normalized = raw.replace('\\', "/");
        let parts: Vec<&str> = normalized
            .trim_matches('/')
            .split('/')
            .filter(|part| !part.is_empty())
            .collect();
        if parts.is_empty() || parts.contains(&"..") {
            return None;
        }
        Some(parts.join("/"))
    }

    struct Engine {
        api: Api,
    }

    impl Engine {
        fn new() -> Result<Self> {
            let resource_dir = screenai_resource_directory()?;
            let library_path = resource_dir.join(crate::models::screenai_library());
            if !library_path.is_file() {
                bail!("ScreenAI runtime not found: {}", library_path.display());
            }
            if !resource_dir.join("files_list_ocr.txt").is_file() {
                bail!(
                    "ScreenAI OCR resource manifest not found: {}",
                    resource_dir.display()
                );
            }
            let _ = RESOURCES.set(ResourceState {
                root: resource_dir,
                cache: Mutex::new(HashMap::new()),
            });

            let api = Api::load(&library_path)?;
            unsafe {
                (api.set_file_content_functions)(
                    resource_size as *mut c_void,
                    resource_data as *mut c_void,
                );
            }
            if unsafe { (api.init_ocr)() } == 0 {
                bail!("ScreenAI InitOCRUsingCallback returned false");
            }
            unsafe { (api.set_light_mode)(0) };
            Ok(Self { api })
        }

        fn recognize(&self, image: &RgbaImage) -> Result<Recognition> {
            let mut pixels = image.as_raw().clone();
            let bitmap = SkBitmap {
                pixel_ref: std::ptr::null_mut(),
                pixmap: SkPixmap {
                    pixels: pixels.as_mut_ptr() as *mut c_void,
                    row_bytes: image.width() as usize * 4,
                    info: SkImageInfo {
                        color_info: SkColorInfo {
                            color_space: std::ptr::null_mut(),
                            color_type: 4,
                            alpha_type: 1,
                        },
                        dimensions: SkImageSize {
                            width: image.width() as i32,
                            height: image.height() as i32,
                        },
                    },
                },
                flags: 0,
            };
            let mut output_length = 0_u32;
            let result = unsafe { (self.api.perform_ocr)(&bitmap, &mut output_length) };
            if result.is_null() || output_length == 0 {
                return Ok(Recognition::default());
            }
            let payload =
                unsafe { std::slice::from_raw_parts(result as *const u8, output_length as usize) };
            let parsed = parse_visual_annotation(payload);
            unsafe { (self.api.free_result)(result) };
            parsed
        }
    }

    fn screenai_resource_directory() -> Result<PathBuf> {
        crate::models::ensure_screenai()
    }

    fn parse_visual_annotation(bytes: &[u8]) -> Result<Recognition> {
        super::parse_annotation(bytes)
    }

    static ENGINE: OnceLock<Mutex<Option<Engine>>> = OnceLock::new();

    pub fn ocr_image(image: &RgbaImage) -> Result<Recognition> {
        let lock = ENGINE.get_or_init(|| Mutex::new(None));
        let mut guard = lock
            .lock()
            .map_err(|_| anyhow::anyhow!("ScreenAI engine lock poisoned"))?;
        if guard.is_none() {
            *guard = Some(Engine::new()?);
        }
        guard
            .as_ref()
            .expect("ScreenAI engine initialized")
            .recognize(image)
    }
}

pub fn ocr_image(image: &RgbaImage) -> Result<Recognition> {
    native_impl::ocr_image(image)
}
