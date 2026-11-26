//! OCR HTTP protocols implemented in Rust. No Python SDK/subprocess.
use super::*;
use crate::pipeline::TextBox;
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::blocking::{
    Client, Response,
    multipart::{Form, Part},
};
use serde_json::{Value, json};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
pub struct Remote {
    client: Client,
    upload: Client,
    root: PathBuf,
    token: Option<(u64, String)>,
}
fn response(r: std::result::Result<Response, reqwest::Error>) -> Result<Value> {
    let r = r.map_err(|_| anyhow::anyhow!("OCR connection failed or timed out"))?;
    if !r.status().is_success() {
        bail!("OCR endpoint returned HTTP {}", r.status().as_u16());
    }
    Ok(r.json()?)
}
fn array(v: &Value) -> impl Iterator<Item = &Value> {
    v.as_array().into_iter().flatten()
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn n(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.)
}
fn union(words: &[TextBox]) -> [f64; 4] {
    words
        .iter()
        .fold([f64::INFINITY, f64::INFINITY, 0., 0.], |a, w| {
            [
                a[0].min(w.bounds[0]),
                a[1].min(w.bounds[1]),
                a[2].max(w.bounds[2]),
                a[3].max(w.bounds[3]),
            ]
        })
}
fn polygon(v: &Value, sx: f64, sy: f64) -> [f64; 4] {
    array(v).fold([f64::INFINITY, f64::INFINITY, 0., 0.], |a, p| {
        let (x, y) = (n(&p["x"]) * sx, n(&p["y"]) * sy);
        [a[0].min(x), a[1].min(y), a[2].max(x), a[3].max(y)]
    })
}
fn line(value: &Value, bounds: [f64; 4]) -> TextBox {
    TextBox {
        text: text(value).into(),
        bounds,
        ..Default::default()
    }
}
fn png(image: &RgbaImage) -> Result<Vec<u8>> {
    let mut out = std::io::Cursor::new(Vec::new());
    image.write_to(&mut out, image::ImageFormat::Png)?;
    Ok(out.into_inner())
}
impl Remote {
    pub fn new(root: &Path) -> Result<Self> {
        let cookies = std::sync::Arc::new(reqwest::cookie::Jar::default());
        let client = Client::builder()
            .cookie_provider(cookies.clone())
            .timeout(Duration::from_secs(25))
            .user_agent("Mozilla/5.0 Chrome/134.0.0.0 Safari/537.36")
            .build()?;
        let upload = Client::builder()
            .cookie_provider(cookies)
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            client,
            upload,
            root: root.into(),
            token: None,
        })
    }
    pub fn recognize(&mut self, image: &RgbaImage, engine: &str) -> Result<Recognition> {
        match engine {
            "bing" => self.bing(image),
            "gvision" => {
                let token = self.google_token()?;
                let content = STANDARD.encode(png(image)?);
                let data = response(
                    self.client
                        .post("https://vision.googleapis.com/v1/images:annotate")
                        .bearer_auth(token)
                        .json(&json!({
                            "requests": [{"image": {"content": content}, "features": [{"type": "TEXT_DETECTION"}]}]
                        }))
                        .send(),
                )?;
                if !data["responses"][0]["error"].is_null() {
                    bail!("Google Vision rejected OCR request");
                }
                Ok(parse_google(&data))
            }
            _ => bail!("Unknown HTTP OCR engine: {engine}"),
        }
    }
    fn google_token(&mut self) -> Result<String> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        if let Some((expires, token)) = &self.token {
            if *expires > now + 60 {
                return Ok(token.clone());
            }
        }
        let path = std::env::var_os("GOOGLE_APPLICATION_CREDENTIALS")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let local = self.root.join("google_vision.json");
                if local.exists() {
                    local
                } else {
                    crate::models::home()
                        .map(|home| home.join(".config/google_vision.json"))
                        .unwrap_or(local)
                }
            });
        let bytes = std::fs::read(path).map_err(|_| {
            anyhow::anyhow!("Cannot read the Google Vision service account key (google_vision.json)")
        })?;
        let credentials: Value = serde_json::from_slice(&bytes)?;
        let claims = json!({"iss":credentials["client_email"],"scope":"https://www.googleapis.com/auth/cloud-vision","aud":"https://oauth2.googleapis.com/token","iat":now,"exp":now+3600});
        let key =
            jsonwebtoken::EncodingKey::from_rsa_pem(text(&credentials["private_key"]).as_bytes())?;
        let jwt = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
            &claims,
            &key,
        )?;
        let data = response(
            self.client
                .post("https://oauth2.googleapis.com/token")
                .form(&[
                    ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                    ("assertion", &jwt),
                ])
                .send(),
        )?;
        let token = data["access_token"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Google authentication returned no token"))?
            .to_owned();
        self.token = Some((
            now + data["expires_in"].as_u64().unwrap_or(3600),
            token.clone(),
        ));
        Ok(token)
    }
    fn bing(&self, image: &RgbaImage) -> Result<Recognition> {
        let mut scaled = image.clone();
        let scale = (50. / image.width().min(image.height()) as f64)
            .max(1.)
            .min(4000. / image.width().max(image.height()) as f64);
        if scale != 1. {
            scaled = image::imageops::resize(
                image,
                (image.width() as f64 * scale).round().max(1.) as u32,
                (image.height() as f64 * scale).round().max(1.) as u32,
                image::imageops::FilterType::Lanczos3,
            );
        }
        let bytes = loop {
            let bytes = png(&scaled)?;
            if bytes.len() <= 767772 {
                break bytes;
            }
            if scaled.width().min(scaled.height()) <= 50 {
                bail!("Image exceeds Bing upload size");
            }
            scaled = image::imageops::resize(
                &scaled,
                (scaled.width() * 3 / 4).max(1),
                (scaled.height() * 3 / 4).max(1),
                image::imageops::FilterType::Triangle,
            );
        };
        let mut url =
            reqwest::Url::parse("https://www.bing.com/images/search?view=detailv2&iss=sbiupload")?;
        let mut token = None;
        let mut host = "www.bing.com".to_owned();
        for _ in 0..2 {
            host = url.host_str().unwrap_or("www.bing.com").into();
            let res = self
                .upload
                .post(url.clone())
                .header("origin", "https://www.bing.com")
                .multipart(
                    Form::new()
                        .text("imgurl", "")
                        .text("cbir", "sbi")
                        .text("imageBin", STANDARD.encode(&bytes)),
                )
                .send()?;
            let location = res
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "Bing did not return an upload token (HTTP {})",
                        res.status().as_u16()
                    )
                })?;
            let redirect = url.join(location)?;
            token = redirect
                .query_pairs()
                .find(|(k, _)| k.eq_ignore_ascii_case("insightsToken"))
                .map(|(_, v)| v.into_owned());
            if token.is_some() {
                break;
            }
            if redirect.scheme() != "https"
                || !redirect
                    .host_str()
                    .is_some_and(|h| h == "bing.com" || h.ends_with(".bing.com"))
            {
                bail!("Bing returned an unexpected redirect");
            }
            url = redirect;
        }
        let token = token.ok_or_else(|| anyhow::anyhow!("Bing upload token missing"))?;
        let request = json!({"imageInfo":{"imageInsightsToken":token,"source":"Url"},"knowledgeRequest":{"invokedSkills":["OCR"],"index":1}});
        let data = response(
            self.client
                .post(format!("https://{host}/images/api/custom/knowledge"))
                .header("origin", "https://www.bing.com")
                .header(
                    "referer",
                    format!(
                        "https://www.bing.com/images/search?view=detailV2&insightstoken={token}"
                    ),
                )
                .multipart(Form::new().part(
                    "knowledgeRequest",
                    Part::text(request.to_string()).mime_str("application/json")?,
                ))
                .send(),
        )?;
        Ok(parse_bing(
            &data,
            image.width() as f64,
            image.height() as f64,
        ))
    }
}
fn parse_google(data: &Value) -> Recognition {
    let mut lines = Vec::new();
    for page in array(&data["responses"][0]["fullTextAnnotation"]["pages"]) {
        for block in array(&page["blocks"]) {
            for paragraph in array(&block["paragraphs"]) {
                let mut words = Vec::new();
                let mut content = String::new();
                for word in array(&paragraph["words"]) {
                    let value = array(&word["symbols"])
                        .map(|s| text(&s["text"]))
                        .collect::<String>();
                    content.push_str(&value);
                    words.push(TextBox {
                        text: value,
                        bounds: polygon(&word["boundingBox"]["vertices"], 1., 1.),
                        ..Default::default()
                    });
                    let br = word["symbols"]
                        .as_array()
                        .and_then(|a| a.last())
                        .map(|s| text(&s["property"]["detectedBreak"]["type"]))
                        .unwrap_or("");
                    if matches!(br, "SPACE" | "SURE_SPACE") {
                        content.push(' ');
                    }
                    if br == "HYPHEN" {
                        content.push('-');
                    }
                    if matches!(br, "LINE_BREAK" | "EOL_SURE_SPACE" | "HYPHEN") {
                        let mut line = join_words(std::mem::take(&mut words));
                        line.text = std::mem::take(&mut content);
                        lines.push(line);
                    }
                }
                if !words.is_empty() {
                    let mut line = join_words(words);
                    line.text = content.trim_end().to_owned();
                    lines.push(line);
                }
            }
        }
    }
    Recognition::from_lines(lines)
}
fn join_words(words: Vec<TextBox>) -> TextBox {
    TextBox {
        text: words
            .iter()
            .map(|w| w.text.as_str())
            .collect::<Vec<_>>()
            .join(""),
        bounds: union(&words),
        words,
        ..Default::default()
    }
}
fn parse_bing(data: &Value, w: f64, h: f64) -> Recognition {
    fn item(v: &Value, w: f64, h: f64) -> TextBox {
        let q = &v["boundingBox"];
        let p = json!([
            q["topLeft"],
            q["topRight"],
            q["bottomRight"],
            q["bottomLeft"]
        ]);
        let mut out = line(&v["text"], polygon(&p, w, h));
        out.words = array(&v["words"]).map(|v| item(v, w, h)).collect();
        out
    }
    let mut lines = Vec::new();
    for tag in array(&data["tags"]) {
        for action in array(&tag["actions"]) {
            if action["_type"] == "ImageKnowledge/TextRecognitionAction" {
                for region in array(&action["data"]["regions"]) {
                    lines.extend(array(&region["lines"]).map(|v| item(v, w, h)));
                }
            }
        }
    }
    Recognition::from_lines(lines)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn google_preserves_explicit_spaces_without_inserting_them_into_japanese() {
        let word = |t: &str, br: &str| json!({"symbols":[{"text":t,"property":{"detectedBreak":{"type":br}}}],"boundingBox":{"vertices":[{"x":1,"y":2},{"x":30,"y":20}]}});
        let r = parse_google(
            &json!({"responses":[{"fullTextAnnotation":{"pages":[{"blocks":[{"paragraphs":[{"words":[word("Hello", "SPACE"),word("world", "LINE_BREAK"),word("日本", ""),word("語", "LINE_BREAK")]}]}]}]}}]}),
        );
        assert_eq!(r.lines[0].text, "Hello world");
        assert_eq!(r.lines[1].text, "日本語");
        assert_eq!(r.lines[0].words[0].text, "Hello");
    }
    #[test]
    #[ignore = "Requires real fixture and network; Bing service may be unavailable"]
    fn bing_real_game_frame() {
        let image = image::open(std::env::var("GSM_OCR_IMAGE").unwrap())
            .unwrap()
            .into_rgba8();
        let mut engine = Remote::new(Path::new(".")).unwrap();
        let start = std::time::Instant::now();
        let result = engine.recognize(&image, "bing").unwrap();
        assert!(!result.text.trim().is_empty());
        println!(
            "BING_REAL {}",
            json!({"milliseconds":start.elapsed().as_secs_f64()*1000.,"text":result.text,"lines":result.lines.len()})
        );
    }
    #[test]
    fn bing_maps_normalized_boxes_back_to_source() {
        let q = json!({"topLeft":{"x":0.1,"y":0.2},"topRight":{"x":0.5,"y":0.2},"bottomRight":{"x":0.5,"y":0.4},"bottomLeft":{"x":0.1,"y":0.4}});
        let r = parse_bing(
            &json!({"tags":[{"actions":[{"_type":"ImageKnowledge/TextRecognitionAction","data":{"regions":[{"lines":[{"text":"日本語","boundingBox":q}]}]}}]}]}),
            1000.,
            500.,
        );
        assert_eq!(r.lines[0].bounds, [100., 100., 500., 200.]);
    }
}
