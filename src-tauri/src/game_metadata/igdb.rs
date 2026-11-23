use super::{
    get_json,
    search_results::{cover, igdb_url},
    Sources,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use gsm_history::library::igdb_slug;
use image::{
    codecs::png::{CompressionType, FilterType, PngEncoder},
    ImageEncoder,
};
use serde_json::{json, Value};
use std::{collections::HashSet, time::Duration};

impl Sources {
    pub(super) async fn igdb_request(&self, action: &str, payload: Value) -> Option<Value> {
        let version = env!("CARGO_PKG_VERSION");
        let request = self
            .http
            .post(format!("{}/api/cloud/igdb/{action}", self.cloud))
            .header("User-Agent", format!("GameSentenceMiner/{version}"))
            .header("X-GSM-Client", "gsm-desktop")
            .header("X-GSM-Version", version)
            .json(&payload);
        get_json(request, 8).await
    }
    pub(super) async fn igdb_metadata(&self, lookup: &str) -> Option<Value> {
        let slug = igdb_slug(lookup)?.trim();
        if !slug.chars().all(|c| c.is_alphanumeric() || c == '-') {
            return None;
        }
        let mut payload = self.igdb_request("game", json!({"igdb_slug":slug})).await?;
        let row = payload.get_mut("igdb")?.take();
        if row.as_object()?.is_empty() {
            return None;
        }
        let text = |key: &str| row[key].as_str().unwrap_or("").trim();
        let url = [text("igdb_url"), text("igdb_slug"), slug]
            .into_iter()
            .find(|v| !v.is_empty())?;
        let canonical = igdb_url(url);
        let mut links = Vec::new();
        let mut seen = HashSet::new();
        for mut link in std::iter::once(json!({"url":canonical,"linkType":1}))
            .chain(row["links"].as_array().into_iter().flatten().cloned())
        {
            if link.is_string() {
                link = json!({"url":link,"linkType":1});
            }
            let Some(url) = link["url"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            if seen.insert(url.to_lowercase()) {
                link.as_object_mut()?.entry("linkType").or_insert(1.into());
                links.push(link);
            }
        }
        let tags = row["tags"]
            .as_array()
            .filter(|a| !a.is_empty())
            .cloned()
            .unwrap_or_else(|| {
                row["platforms"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(|p| format!("Platform: {p}").into())
                    .collect()
            });
        let kind = text("media_type_string");
        Some(
            json!({"title_original":text("title"),"title_romaji":text("title"),"title_english":text("title"),
            "description":text("description_candidate"),"release_date":text("release_date"),"cover_url":cover(text("cover_url")),
            "genres":row["genres"],"links":links,"tags":tags,"media_type_string":if kind.is_empty(){"Game"}else{kind}}),
        )
    }
    pub(super) async fn igdb_cover(&self, url: &str) -> Option<String> {
        let url = if url.contains("/games/") {
            self.igdb_metadata(url).await?["cover_url"]
                .as_str()?
                .to_owned()
        } else {
            url.into()
        };
        self.thumbnail(&url).await
    }
    pub(super) async fn thumbnail(&self, url: &str) -> Option<String> {
        let response = self
            .http
            .get(url)
            .header(
                "Accept",
                "image/webp,image/apng,image/png,image/jpeg,image/*,*/*;q=0.8",
            )
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let bytes = response.bytes().await.ok()?;
        tokio::task::spawn_blocking(move || encode_cover(&bytes))
            .await
            .ok()?
    }
}

fn encode_cover(bytes: &[u8]) -> Option<String> {
    let image = image::load_from_memory(bytes).ok()?;
    let rgb = if image.color().has_alpha() {
        let mut frame = image::RgbImage::new(image.width(), image.height());
        for (dest, pixel) in frame.pixels_mut().zip(image.to_rgba8().pixels()) {
            let a = u32::from(pixel[3]);
            for c in 0..3 {
                dest[c] = ((u32::from(pixel[c]) * a + 255 * (255 - a) + 127) / 255) as u8;
            }
        }
        frame
    } else {
        image.into_rgb8()
    };
    let rgb = if rgb.width() > 300 || rgb.height() > 400 {
        image::DynamicImage::ImageRgb8(rgb)
            .resize(300, 400, image::imageops::FilterType::Lanczos3)
            .into_rgb8()
    } else {
        rgb
    };
    let mut bytes = Vec::new();
    PngEncoder::new_with_quality(&mut bytes, CompressionType::Best, FilterType::Adaptive)
        .write_image(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .ok()?;
    Some(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}
