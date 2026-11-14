//! Direct bridge to the same macOS Live Text API used by GSM's existing OCR engine.
use crate::pipeline::{Recognition, TextBox};
use anyhow::{Context, Result, bail};
use block2::RcBlock;
use image::RgbaImage;
use objc2::{
    msg_send,
    rc::{Allocated, Retained, autoreleasepool},
    runtime::{AnyClass, AnyObject},
};
use objc2_foundation::{NSArray, NSData, NSRect, NSString};
use std::{
    ffi::c_void,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFRunLoopDefaultMode: *const c_void;
    fn CFRunLoopRunInMode(mode: *const c_void, seconds: f64, return_after_source: u8) -> i32;
}

unsafe fn parse(analysis: *mut AnyObject, size: (u32, u32)) -> Recognition {
    // The analysis and all its children remain owned by the completion callback.
    unsafe {
        let entries: Retained<NSArray<AnyObject>> = msg_send![analysis, allLines];
        let make_box = |object: &AnyObject| {
            let text: Retained<NSString> = msg_send![object, string];
            let quad: Retained<AnyObject> = msg_send![object, quad];
            let b: NSRect = msg_send![&quad, boundingBox];
            let x = b.origin.x * size.0 as f64;
            let y = b.origin.y * size.1 as f64;
            let w = b.size.width * size.0 as f64;
            let h = b.size.height * size.1 as f64;
            TextBox {
                text: text.to_string(),
                bounds: [x, y, x + w, y + h],
                vertical: h > w,
                ..Default::default()
            }
        };
        let mut lines = Vec::new();
        for object in entries.iter() {
            let mut line = make_box(&object);
            let children: Retained<NSArray<AnyObject>> = msg_send![&object, children];
            line.words = children.iter().map(|w| make_box(&w)).collect();
            lines.push(line);
        }
        Recognition::from_lines(lines)
    }
}

pub fn recognize(image: &RgbaImage, language: &str) -> Result<Recognition> {
    static FRAMEWORK: OnceLock<Result<libloading::Library, String>> = OnceLock::new();
    FRAMEWORK
        .get_or_init(|| {
            unsafe {
                libloading::Library::new(
                    "/System/Library/PrivateFrameworks/VisionKitCore.framework/VisionKitCore",
                )
            }
            .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| anyhow::anyhow!("Apple Live Text is unavailable: {e}"))?;
    autoreleasepool(|_| unsafe {
        let analyzer_class = AnyClass::get(c"VKCImageAnalyzer")
            .context("Apple Live Text requires a supported macOS version")?;
        let request_class = AnyClass::get(c"VKCImageAnalyzerRequest")
            .context("Apple Live Text request API is unavailable")?;
        let image_class =
            AnyClass::get(c"NSImage").context("macOS image support is unavailable")?;
        let data = NSData::with_bytes(&super::png(image)?);
        let allocated: Allocated<AnyObject> = msg_send![image_class, alloc];
        let native_image: Retained<AnyObject> = msg_send![allocated, initWithData:&*data];
        let analyzer: Retained<AnyObject> = msg_send![analyzer_class, new];
        let allocated: Allocated<AnyObject> = msg_send![request_class, alloc];
        let request: Retained<AnyObject> =
            msg_send![allocated, initWithImage:&*native_image, requestType:1usize];
        let locales =
            NSArray::from_retained_slice(&[NSString::from_str(language), NSString::from_str("en")]);
        let _: () = msg_send![&request, setLocales:&*locales];
        let result: Arc<Mutex<Option<Result<Recognition>>>> = Arc::new(Mutex::new(None));
        let completed = result.clone();
        let size = image.dimensions();
        let progress = RcBlock::new(|_: f64| {});
        let completion = RcBlock::new(move |analysis: *mut AnyObject, error: *mut AnyObject| {
            let value = if !error.is_null() || analysis.is_null() {
                Err(anyhow::anyhow!(
                    "Apple Live Text could not analyze this image"
                ))
            } else {
                Ok(parse(analysis, size))
            };
            if let Ok(mut result) = completed.lock() {
                *result = Some(value);
            }
        });
        let _: usize = msg_send![&analyzer, processRequest:&*request, progressHandler:&*progress, completionHandler:&*completion];
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if let Some(result) = result
                .lock()
                .map_err(|_| anyhow::anyhow!("Live Text callback failed"))?
                .take()
            {
                return result;
            }
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, 0);
        }
        bail!("Apple Live Text timed out")
    })
}
