//! Minimal Google Lens OCR client.
//!
//! Talks to the same private Lens endpoint that GameSentenceMiner uses. The
//! protobuf messages below are hand-declared with `prost` derive macros (only
//! the handful of fields we actually need) so there is no `protoc`/build step.
//! Field numbers were taken from the Lens overlay protos shipped with GSM.

use crate::pipeline::{Recognition, TextBox};
use anyhow::{Context, Result, bail};
use image::RgbaImage;
use prost::Message;
use rand::RngExt;

const ENDPOINT: &str = "https://lensfrontend-pa.googleapis.com/v1/crupload";
const PUBLIC_API_KEY: &str = "AIzaSyDr2UxVnv_U85AbhhY8XSHSIavUW0DC-sY";
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

// Enum values (encoded on the wire as plain varints, same as int32).
const PLATFORM_WEB: i32 = 3;
const SURFACE_CHROMIUM: i32 = 4;
const AUTO_FILTER: i32 = 7;

// Lens downscales anything larger than this before upload.
const MAX_PIXELS: u64 = 3_000_000;

// ---------------------------------------------------------------------------
// Request messages
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Message)]
struct ServerRequest {
    #[prost(message, optional, tag = "1")]
    objects_request: Option<ObjectsRequest>,
}

#[derive(Clone, PartialEq, Message)]
struct ObjectsRequest {
    #[prost(message, optional, tag = "1")]
    request_context: Option<RequestContext>,
    #[prost(message, optional, tag = "3")]
    image_data: Option<ImageData>,
}

#[derive(Clone, PartialEq, Message)]
struct RequestContext {
    #[prost(message, optional, tag = "3")]
    request_id: Option<RequestId>,
    #[prost(message, optional, tag = "4")]
    client_context: Option<ClientContext>,
}

#[derive(Clone, PartialEq, Message)]
struct RequestId {
    #[prost(uint64, tag = "1")]
    uuid: u64,
    #[prost(int32, tag = "2")]
    sequence_id: i32,
    #[prost(int32, tag = "3")]
    image_sequence_id: i32,
    #[prost(bytes = "vec", tag = "4")]
    analytics_id: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
struct ClientContext {
    #[prost(int32, tag = "1")]
    platform: i32,
    #[prost(int32, tag = "2")]
    surface: i32,
    #[prost(message, optional, tag = "4")]
    locale_context: Option<LocaleContext>,
    #[prost(string, tag = "6")]
    app_id: String,
    #[prost(message, optional, tag = "17")]
    client_filters: Option<AppliedFilters>,
}

#[derive(Clone, PartialEq, Message)]
struct LocaleContext {
    #[prost(string, tag = "1")]
    language: String,
    #[prost(string, tag = "2")]
    region: String,
    #[prost(string, tag = "3")]
    time_zone: String,
}

#[derive(Clone, PartialEq, Message)]
struct AppliedFilters {
    #[prost(message, repeated, tag = "1")]
    filter: Vec<AppliedFilter>,
}

#[derive(Clone, PartialEq, Message)]
struct AppliedFilter {
    #[prost(int32, tag = "1")]
    filter_type: i32,
}

#[derive(Clone, PartialEq, Message)]
struct ImageData {
    #[prost(message, optional, tag = "1")]
    payload: Option<ImagePayload>,
    #[prost(message, optional, tag = "3")]
    image_metadata: Option<ImageMetadata>,
}

#[derive(Clone, PartialEq, Message)]
struct ImagePayload {
    #[prost(bytes = "vec", tag = "1")]
    image_bytes: Vec<u8>,
}

#[derive(Clone, PartialEq, Message)]
struct ImageMetadata {
    #[prost(int32, tag = "1")]
    width: i32,
    #[prost(int32, tag = "2")]
    height: i32,
}

// ---------------------------------------------------------------------------
// Response messages (unknown fields are skipped by prost during decode)
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Message)]
struct ServerResponse {
    #[prost(message, optional, tag = "2")]
    objects_response: Option<ObjectsResponse>,
}

#[derive(Clone, PartialEq, Message)]
struct ObjectsResponse {
    #[prost(message, optional, tag = "3")]
    text: Option<TextField>,
}

#[derive(Clone, PartialEq, Message)]
struct TextField {
    #[prost(message, optional, tag = "1")]
    text_layout: Option<TextLayout>,
}

#[derive(Clone, PartialEq, Message)]
struct TextLayout {
    #[prost(message, repeated, tag = "1")]
    paragraphs: Vec<Paragraph>,
}

#[derive(Clone, PartialEq, Message)]
struct Paragraph {
    #[prost(message, repeated, tag = "2")]
    lines: Vec<Line>,
    #[prost(int32, tag = "4")]
    writing_direction: i32,
}

#[derive(Clone, PartialEq, Message)]
struct Line {
    #[prost(message, repeated, tag = "1")]
    words: Vec<Word>,
    #[prost(message, optional, tag = "2")]
    geometry: Option<Geometry>,
}

#[derive(Clone, PartialEq, Message)]
struct Word {
    #[prost(string, tag = "2")]
    plain_text: String,
    #[prost(string, tag = "3")]
    text_separator: String,
    #[prost(message, optional, tag = "4")]
    geometry: Option<Geometry>,
}

#[derive(Clone, PartialEq, Message)]
struct Geometry {
    #[prost(message, optional, tag = "1")]
    bounding_box: Option<CenterBox>,
}
#[derive(Clone, PartialEq, Message)]
struct CenterBox {
    #[prost(float, tag = "1")]
    center_x: f32,
    #[prost(float, tag = "2")]
    center_y: f32,
    #[prost(float, tag = "3")]
    width: f32,
    #[prost(float, tag = "4")]
    height: f32,
    #[prost(float, tag = "5")]
    rotation: f32,
    #[prost(int32, tag = "6")]
    coordinate_type: i32,
}

// ---------------------------------------------------------------------------

pub struct Lens {
    client: reqwest::blocking::Client,
}

impl Lens {
    pub fn new() -> Result<Self> {
        Ok(Self {
            client: reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .context("build Lens HTTP client")?,
        })
    }

    /// Retain the client across scans, including its TLS connection pool.
    pub fn recognize(&self, img: &RgbaImage, language: &str) -> Result<Recognition> {
        self.recognize_at(img, language, ENDPOINT)
    }

    fn recognize_at(&self, img: &RgbaImage, language: &str, endpoint: &str) -> Result<Recognition> {
        let (payload, width, height) = preprocess(img)?;
        let request = build_request(payload, width, height, language);
        let body = request.encode_to_vec();

        let response = self
            .client
            .post(endpoint)
            .header("X-Goog-Api-Key", PUBLIC_API_KEY)
            .header(reqwest::header::CONTENT_TYPE, "application/x-protobuf")
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .header("Sec-Fetch-Site", "none")
            .header("Sec-Fetch-Mode", "no-cors")
            .header("Sec-Fetch-Dest", "empty")
            .header(reqwest::header::ACCEPT_LANGUAGE, "ja-JP;q=0.6,ja;q=0.5")
            .body(body)
            .send()
            .context("send request to Google Lens")?;

        let status = response.status();
        let bytes = response.bytes().context("read Lens response body")?;
        if !status.is_success() {
            bail!("Google Lens returned HTTP {status}");
        }

        let parsed = ServerResponse::decode(bytes).context("decode Lens protobuf response")?;
        Ok(extract_result(
            &parsed,
            (width as u32, height as u32),
            img.dimensions(),
        ))
    }
}

fn build_request(image_bytes: Vec<u8>, width: i32, height: i32, language: &str) -> ServerRequest {
    let mut rng = rand::rng();
    let analytics_id: [u8; 16] = rng.random();

    ServerRequest {
        objects_request: Some(ObjectsRequest {
            request_context: Some(RequestContext {
                request_id: Some(RequestId {
                    uuid: rng.random(),
                    sequence_id: 0,
                    image_sequence_id: 0,
                    analytics_id: analytics_id.to_vec(),
                }),
                client_context: Some(ClientContext {
                    platform: PLATFORM_WEB,
                    surface: SURFACE_CHROMIUM,
                    locale_context: Some(LocaleContext {
                        language: language.to_string(),
                        region: "Asia/Tokyo".to_string(),
                        time_zone: String::new(),
                    }),
                    app_id: String::new(),
                    client_filters: Some(AppliedFilters {
                        filter: vec![AppliedFilter {
                            filter_type: AUTO_FILTER,
                        }],
                    }),
                }),
            }),
            image_data: Some(ImageData {
                payload: Some(ImagePayload { image_bytes }),
                image_metadata: Some(ImageMetadata { width, height }),
            }),
        }),
    }
}

/// Downscale oversized images (matching GSM) and PNG-encode for upload.
fn preprocess(img: &RgbaImage) -> Result<(Vec<u8>, i32, i32)> {
    let (mut w, mut h) = (img.width(), img.height());
    let pixels = w as u64 * h as u64;

    let encoded = if pixels > MAX_PIXELS {
        let aspect = w as f64 / h as f64;
        let new_w = ((MAX_PIXELS as f64 * aspect).sqrt()) as u32;
        let new_h = (new_w as f64 / aspect) as u32;
        w = new_w.max(1);
        h = new_h.max(1);
        let resized = image::imageops::resize(img, w, h, image::imageops::FilterType::Lanczos3);
        encode_png(&resized)?
    } else {
        encode_png(img)?
    };

    Ok((encoded, w as i32, h as i32))
}

fn encode_png(img: &RgbaImage) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    image::codecs::png::PngEncoder::new(&mut buf)
        .write_image(
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgba8,
        )
        .context("encode PNG")?;
    Ok(buf)
}

fn geometry_bounds(
    geometry: &Option<Geometry>,
    uploaded: (u32, u32),
    original: (u32, u32),
) -> [f64; 4] {
    let Some(b) = geometry.as_ref().and_then(|g| g.bounding_box.as_ref()) else {
        return [0.0; 4];
    };
    let (sx, sy) = if b.coordinate_type == 2 {
        (
            original.0 as f64 / uploaded.0 as f64,
            original.1 as f64 / uploaded.1 as f64,
        )
    } else {
        (original.0 as f64, original.1 as f64)
    };
    let (cx, cy, w, h) = (
        b.center_x as f64 * sx,
        b.center_y as f64 * sy,
        b.width as f64 * sx,
        b.height as f64 * sy,
    );
    let (sin, cos) = (b.rotation as f64).sin_cos();
    let half_w = (w * cos.abs() + h * sin.abs()) / 2.0;
    let half_h = (h * cos.abs() + w * sin.abs()) / 2.0;
    [cx - half_w, cy - half_h, cx + half_w, cy + half_h]
}

fn extract_result(
    response: &ServerResponse,
    uploaded: (u32, u32),
    original: (u32, u32),
) -> Recognition {
    let Some(layout) = response
        .objects_response
        .as_ref()
        .and_then(|o| o.text.as_ref())
        .and_then(|t| t.text_layout.as_ref())
    else {
        return Recognition::default();
    };
    let mut lines = Vec::new();
    for paragraph in &layout.paragraphs {
        for line in &paragraph.lines {
            let text = line
                .words
                .iter()
                .map(|w| format!("{}{}", w.plain_text, w.text_separator))
                .collect::<String>()
                .trim()
                .to_owned();
            if text.is_empty() {
                continue;
            }
            let vertical = paragraph.writing_direction == 2;
            let words = line
                .words
                .iter()
                .filter(|w| !w.plain_text.is_empty())
                .map(|w| TextBox {
                    text: w.plain_text.clone(),
                    bounds: geometry_bounds(&w.geometry, uploaded, original),
                    vertical,
                    ..Default::default()
                })
                .collect();
            lines.push(TextBox {
                text,
                bounds: geometry_bounds(&line.geometry, uploaded, original),
                words,
                vertical,
            });
        }
    }
    Recognition::from_lines(lines)
}

use image::ImageEncoder as _;

#[cfg(test)]
mod connection_tests {
    use super::*;
    use std::io::{BufRead, Read, Write};

    #[test]
    fn successive_scans_reuse_the_same_connection() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/ocr", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            // Accept exactly one connection and require both scans on it.
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut stream = std::io::BufReader::new(stream);
            for _ in 0..2 {
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    assert!(stream.read_line(&mut line).unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse::<usize>().unwrap();
                    }
                }
                let mut body = vec![0; length];
                stream.read_exact(&mut body).unwrap();
                assert!(ServerRequest::decode(body.as_slice()).is_ok());
                stream
                    .get_mut()
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n",
                    )
                    .unwrap();
                stream.get_mut().flush().unwrap();
            }
        });
        let lens = Lens::new().unwrap();
        let image = RgbaImage::new(60, 60);
        for _ in 0..2 {
            lens.recognize_at(&image, "ja", &endpoint).unwrap();
        }
        server.join().unwrap();
    }
}
