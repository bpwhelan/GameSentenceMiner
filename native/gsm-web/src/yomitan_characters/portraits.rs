use base64::{engine::general_purpose::STANDARD, Engine};
use image::{ImageFormat, ImageReader};
use reqwest::blocking::Client;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Read, Write},
    path::Path,
    sync::OnceLock,
    time::Duration,
};

const MAX_BYTES: u64 = 64 * 1024 * 1024;
pub(super) struct Portrait {
    pub path: String,
    pub bytes: Vec<u8>,
}
struct Image {
    ext: &'static str,
    bytes: Vec<u8>,
}

impl Image {
    fn from_uri(uri: &str) -> Option<Self> {
        let (header, data) = uri.split_once(',').unwrap_or(("", uri));
        let header = header.to_ascii_lowercase();
        let ext = ["png", "gif", "webp"]
            .into_iter()
            .find(|ext| header.contains(ext))
            .unwrap_or("jpg");
        let bytes = STANDARD.decode(data.trim()).ok()?;
        Some(Self { ext, bytes })
    }
    fn dimensions(&self) -> Option<(u32, u32)> {
        ImageReader::new(Cursor::new(&self.bytes))
            .with_guessed_format()
            .ok()?
            .into_dimensions()
            .ok()
    }
    fn download(url: &str) -> Option<Self> {
        static HTTP: OnceLock<Client> = OnceLock::new();
        if HTTP.get().is_none() {
            let _ = HTTP.set(
                Client::builder()
                    .timeout(Duration::from_secs(10))
                    .build()
                    .ok()?,
            );
        }
        let response = HTTP.get()?.get(url).send().ok()?;
        if !response.status().is_success()
            || response.content_length().is_some_and(|n| n > MAX_BYTES)
        {
            return None;
        }
        let mut bytes = Vec::new();
        response.take(MAX_BYTES + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() as u64 > MAX_BYTES {
            return None;
        }
        let format = image::guess_format(&bytes).ok()?;
        let decoded = ImageReader::with_format(Cursor::new(&bytes), format)
            .decode()
            .ok()?;
        let ext = match format {
            ImageFormat::Jpeg => "jpg",
            ImageFormat::Png => "png",
            ImageFormat::Gif => "gif",
            ImageFormat::WebP => "webp",
            _ => {
                let mut out = Cursor::new(Vec::new());
                decoded
                    .to_rgba8()
                    .write_to(&mut out, ImageFormat::Png)
                    .ok()?;
                bytes = out.into_inner();
                "png"
            }
        };
        Some(Self { ext, bytes })
    }
    fn recover(url: &str, cache: &Path) -> Option<Self> {
        let path = cache.join(format!("{:x}.data-uri", Sha256::digest(url.as_bytes())));
        if let Some(cached) = fs::read_to_string(&path)
            .ok()
            .and_then(|s| Self::from_uri(&s))
        {
            if ImageReader::new(Cursor::new(&cached.bytes))
                .with_guessed_format()
                .ok()
                .is_some_and(|r| r.decode().is_ok())
            {
                return Some(cached);
            }
        }
        let image = Self::download(url)?;
        let save = || -> std::io::Result<()> {
            fs::create_dir_all(cache)?;
            let mut temp = tempfile::NamedTempFile::new_in(cache)?;
            let mime = if image.ext == "jpg" {
                "jpeg"
            } else {
                image.ext
            };
            write!(temp, "data:image/{mime};base64,")?;
            let mut encoder = base64::write::EncoderWriter::new(&mut temp, &STANDARD);
            encoder.write_all(&image.bytes)?;
            encoder.finish()?;
            drop(encoder);
            temp.persist(&path)?;
            Ok(())
        };
        let _ = save();
        Some(image)
    }
}

pub(super) fn get(c: &Value, cache: &Path) -> Option<Portrait> {
    let id = match &c["id"] {
        Value::String(s) => s.to_owned(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    if id.is_empty() || id.contains(['/', '\\', ':']) || id.chars().any(char::is_control) {
        return None;
    }
    let saved = c["image_base64"].as_str().and_then(Image::from_uri);
    let url = c["image_url"].as_str().filter(|s| !s.is_empty());
    let image = if let Some(url) = url.filter(|_| {
        !saved
            .as_ref()
            .and_then(Image::dimensions)
            .is_some_and(|(w, h)| w > 80 || h > 100)
    }) {
        Image::recover(url, cache).or(saved)
    } else {
        saved
    }?;
    Some(Portrait {
        path: format!("img/c{id}.{}", image.ext),
        bytes: image.bytes,
    })
}
