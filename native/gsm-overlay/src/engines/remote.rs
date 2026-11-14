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
    config: Value,
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
    pub fn new(root: &Path, config: &Value) -> Result<Self> {
        let mut ini = configparser::ini::Ini::new();
        let path = config["engine_config_path"]
            .as_str()
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("owocr_config_gsm.ini"));
        let mut options = json!({});
        if path.exists() {
            for (section, values) in ini
                .load(path)
                .map_err(|_| anyhow::anyhow!("Cannot read OCR engine settings"))?
            {
                for (key, value) in values {
                    if let Some(value) = value {
                        options[&section][&key] = json!(value);
                    }
                }
            }
        }
        if let Some(defaults) = config["engine_defaults"].as_object() {
            for (section, values) in defaults {
                for (key, value) in values.as_object().into_iter().flatten() {
                    if options[section][key].is_null()
                        || options[section][key]
                            .as_str()
                            .is_some_and(|s| s.trim().is_empty())
                    {
                        options[section][key] = value.clone();
                    }
                }
            }
        }
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
            config: options,
            root: root.into(),
            token: None,
        })
    }
    pub fn recognize(
        &mut self,
        image: &RgbaImage,
        engine: &str,
        language: &str,
    ) -> Result<Recognition> {
        // Bing has its own byte-budget encoder. Do not encode a full frame here
        // only to discard it and encode the same image again below.
        if engine == "bing" {
            return self.bing(image);
        }
        let options = self.config[engine].clone();
        let get = |key: &str, default: &str| {
            options[key]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(default)
                .to_owned()
        };
        let bytes = png(image)?;
        let b64 = STANDARD.encode(&bytes);
        let (w, h) = (image.width() as f64, image.height() as f64);
        let timeout = Duration::from_secs_f64(
            get("timeout", "25")
                .parse::<f64>()
                .unwrap_or(25.)
                .clamp(1., 120.),
        );
        match engine {
            "bing" => self.bing(image),
            "mlkitocr" => {
                let format = get("upload_format", "jpeg");
                let mut upload_bytes = bytes.clone();
                let mut content_type = "image/png";
                let mut filename = "image.png";
                if format == "jpeg"
                    || format == "jpg"
                    || (format != "png"
                        && get("adaptive_jpeg", "true") != "false"
                        && bytes.len()
                            > get("jpeg_threshold_bytes", "450000")
                                .parse::<usize>()
                                .unwrap_or(450000))
                {
                    let rgb = image::DynamicImage::ImageRgba8(image.clone()).into_rgb8();
                    let mut jpeg = Vec::new();
                    image::codecs::jpeg::JpegEncoder::new_with_quality(
                        &mut jpeg,
                        get("jpeg_quality", "88")
                            .parse::<u8>()
                            .unwrap_or(88)
                            .clamp(1, 100),
                    )
                    .encode_image(&rgb)?;
                    if format == "jpeg"
                        || format == "jpg"
                        || jpeg.len() as f64
                            <= bytes.len() as f64
                                * get("jpeg_min_savings_ratio", "0.8")
                                    .parse::<f64>()
                                    .unwrap_or(0.8)
                    {
                        upload_bytes = jpeg;
                        content_type = "image/jpeg";
                        filename = "image.jpeg";
                    }
                }
                let script = get(
                    "script",
                    match language {
                        "ja" => "japanese",
                        "zh" => "chinese",
                        "ko" => "korean",
                        "hi" | "mr" | "sa" => "devanagari",
                        _ => "latin",
                    },
                );
                let mut url = reqwest::Url::parse(&get("url", "http://192.168.1.178:8550/ocr"))?;
                url.query_pairs_mut()
                    .append_pair("schema", "v2")
                    .append_pair("script", &script);
                if get("include_words", "true") == "false" {
                    url.query_pairs_mut().append_pair("words", "0");
                }
                let request = self.client.post(url).timeout(timeout);
                let data = if get("raw_upload", "true") == "false" {
                    response(
                        request
                            .multipart(
                                Form::new()
                                    .part(
                                        "image",
                                        Part::bytes(upload_bytes.clone())
                                            .file_name(filename)
                                            .mime_str(content_type)?,
                                    )
                                    .text("script", script),
                            )
                            .send(),
                    )?
                } else {
                    response(
                        request
                            .header("content-type", content_type)
                            .body(upload_bytes)
                            .send(),
                    )?
                };
                Ok(parse_mlkit(&data))
            }
            "azure" => {
                let endpoint = get("endpoint", "");
                if endpoint.is_empty() {
                    bail!("Azure OCR requires endpoint and api_key in OCR settings");
                }
                let data=response(self.client.post(format!("{}/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read",endpoint.trim_end_matches('/'))).header("Ocp-Apim-Subscription-Key",get("api_key","")).header("content-type","application/octet-stream").body(bytes).timeout(timeout).send())?;
                let mut lines = Vec::new();
                for block in array(&data["readResult"]["blocks"]) {
                    for l in array(&block["lines"]) {
                        let mut out = line(&l["text"], polygon(&l["boundingPolygon"], 1., 1.));
                        out.words = array(&l["words"])
                            .map(|word| {
                                line(&word["text"], polygon(&word["boundingPolygon"], 1., 1.))
                            })
                            .collect();
                        lines.push(out);
                    }
                }
                Ok(Recognition::from_lines(lines))
            }
            "ocrspace" => {
                let lang = match language {
                    "ja" => "jpn",
                    "zh" => "chs",
                    "ko" => "kor",
                    "ar" => "ara",
                    "ru" => "rus",
                    "el" => "gre",
                    "th" => "tha",
                    _ => "auto",
                };
                let form = Form::new()
                    .text("apikey", get("api_key", ""))
                    .text("language", lang)
                    .text("OCREngine", get("engine_version", "2"))
                    .text("isOverlayRequired", "True")
                    .part(
                        "file",
                        Part::bytes(bytes)
                            .file_name("image.png")
                            .mime_str("image/png")?,
                    );
                let data = response(
                    self.client
                        .post("https://api.ocr.space/parse/image")
                        .multipart(form)
                        .timeout(timeout)
                        .send(),
                )?;
                if data["IsErroredOnProcessing"] == true {
                    bail!("OCRSpace could not process this image");
                }
                let mut lines = Vec::new();
                for result in array(&data["ParsedResults"]) {
                    for l in array(&result["TextOverlay"]["Lines"]) {
                        let words: Vec<_> = array(&l["Words"])
                            .map(|word| {
                                let (x, y) = (n(&word["Left"]), n(&word["Top"]));
                                line(
                                    &word["WordText"],
                                    [x, y, x + n(&word["Width"]), y + n(&word["Height"])],
                                )
                            })
                            .collect();
                        let mut out = line(&l["LineText"], union(&words));
                        out.words = words;
                        if out.text.is_empty() {
                            out.text = out
                                .words
                                .iter()
                                .map(|w| w.text.as_str())
                                .collect::<Vec<_>>()
                                .join(" ");
                        }
                        lines.push(out);
                    }
                }
                Ok(Recognition::from_lines(lines))
            }
            "gvision" => {
                let token = self.google_token()?;
                let data=response(self.client.post("https://vision.googleapis.com/v1/images:annotate").bearer_auth(token).json(&json!({"requests":[{"image":{"content":b64},"features":[{"type":"TEXT_DETECTION"}]}]})).send())?;
                if !data["responses"][0]["error"].is_null() {
                    bail!("Google Vision rejected OCR request");
                }
                Ok(parse_google(&data))
            }
            "gemini" => {
                let model = get("model", "");
                let key = get("api_key", "");
                if model.is_empty() || key.is_empty() {
                    bail!("Gemini OCR requires model and api_key in OCR settings");
                }
                let prompt = get(
                    "prompt",
                    "Extract dialogue text from the image. Omit furigana, speaker labels and commentary. Do not translate. Return only the text, or an empty string.",
                );
                let data=response(self.client.post(format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent")).header("x-goog-api-key",key).json(&json!({"contents":[{"parts":[{"inline_data":{"mime_type":"image/png","data":b64}},{"text":prompt}]}],"generationConfig":{"temperature":0,"maxOutputTokens":2000}})).timeout(timeout).send())?;
                let value = array(&data["candidates"][0]["content"]["parts"])
                    .filter(|p| p["thought"] != true)
                    .map(|p| text(&p["text"]))
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(plain(&value, w, h))
            }
            "local_llm_ocr" => {
                let mut endpoint = get("url", &get("api_url", "https://api.openai.com/v1"))
                    .trim_end_matches('/')
                    .to_owned();
                if !endpoint.ends_with("/chat/completions") {
                    endpoint.push_str("/chat/completions");
                }
                let model = get("model", "");
                if model.is_empty() {
                    bail!("OpenAI-compatible OCR requires a model in OCR or GSM AI settings");
                }
                let prompt = get(
                    "prompt",
                    &format!(
                        "Extract all {language} text. Ignore furigana. Return text only; do not translate or add commentary."
                    ),
                );
                let mut body = json!({"model":model,"messages":[{"role":"user","content":[{"type":"text","text":prompt},{"type":"image_url","image_url":{"url":format!("data:image/png;base64,{b64}")}}]}],"max_tokens":get("max_tokens","4096").parse::<u64>().unwrap_or(4096),"temperature":get("temperature","0.1").parse::<f64>().unwrap_or(0.1)});
                for attempt in 0..3 {
                    let r = self
                        .client
                        .post(&endpoint)
                        .bearer_auth(get("api_key", "sk-no-key-required"))
                        .json(&body)
                        .timeout(timeout)
                        .send()
                        .map_err(|_| anyhow::anyhow!("OCR endpoint connection failed"))?;
                    let status = r.status();
                    let data: Value = r.json()?;
                    if status.is_success() {
                        return Ok(plain(text(&data["choices"][0]["message"]["content"]), w, h));
                    }
                    let error = text(&data["error"]["message"]);
                    if attempt < 2 && error.contains("max_completion_tokens") {
                        let value = body
                            .as_object_mut()
                            .unwrap()
                            .remove("max_tokens")
                            .unwrap_or(json!(4096));
                        body["max_completion_tokens"] = value;
                        continue;
                    }
                    if attempt < 2 && error.contains("temperature") {
                        body.as_object_mut().unwrap().remove("temperature");
                        continue;
                    }
                    bail!("OCR endpoint returned HTTP {}", status.as_u16());
                }
                bail!("OCR endpoint rejected generation settings")
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
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let local = self.root.join("google_vision.json");
                if local.exists() {
                    local
                } else {
                    directories::BaseDirs::new()
                        .unwrap()
                        .home_dir()
                        .join(".config/google_vision.json")
                }
            });
        let credentials: Value = serde_json::from_slice(
            &std::fs::read(path)
                .map_err(|_| anyhow::anyhow!("Cannot read Google Vision credentials"))?,
        )?;
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
fn plain(text: &str, w: f64, h: f64) -> Recognition {
    Recognition::from_lines(
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| line(&json!(l), [0., 0., w, h]))
            .collect(),
    )
}
fn parse_mlkit(data: &Value) -> Recognition {
    fn item(v: &Value) -> TextBox {
        let b = &v["box"];
        let (x, y, w, h) = if b.is_array() {
            (n(&b[0]), n(&b[1]), n(&b[2]), n(&b[3]))
        } else {
            (n(&b["x"]), n(&b["y"]), n(&b["width"]), n(&b["height"]))
        };
        let mut out = line(&v["text"], [x, y, x + w, y + h]);
        out.words = array(&v["words"]).map(item).collect();
        out
    }
    Recognition::from_lines(array(&data["lines"]).map(item).collect())
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
    // Exercise the actual HTTP client and encoding against a local socket, so
    // protocol regressions are caught without keys or a paid API call.
    fn endpoint(
        responses: Vec<(u16, Value)>,
    ) -> (String, std::thread::JoinHandle<Vec<(String, Vec<u8>)>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let thread = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let deadline = std::time::Instant::now() + Duration::from_secs(10);
                let mut stream = loop {
                    if let Ok((stream, _)) = listener.accept() {
                        break stream;
                    }
                    assert!(std::time::Instant::now() < deadline, "missing HTTP request");
                    std::thread::sleep(Duration::from_millis(5));
                };
                // Winsock may inherit the listener's nonblocking mode.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let end = loop {
                    let mut buf = [0; 4096];
                    let n = stream.read(&mut buf).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buf[..n]);
                    if let Some(i) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
                let length: usize = headers
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|s| s.trim().parse().unwrap())
                    })
                    .unwrap();
                while bytes.len() < end + length {
                    let mut buf = [0; 4096];
                    let n = stream.read(&mut buf).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buf[..n]);
                }
                requests.push((headers, bytes[end..end + length].to_vec()));
                let body = body.to_string();
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            requests
        });
        (url, thread)
    }
    #[test]
    fn mlkit_uploads_real_encoded_images_and_language_options() {
        for format in ["png", "jpeg"] {
            let (url, server) = endpoint(vec![(
                200,
                json!({"lines":[{"text":"日本語","box":[1,2,20,10]}]}),
            )]);
            let mut engine = Remote::new(Path::new("."), &json!({"engine_defaults":{"mlkitocr":{"url":url,"upload_format":format,"include_words":"false"}}})).unwrap();
            let result = engine
                .recognize(&RgbaImage::new(32, 16), "mlkitocr", "ja")
                .unwrap();
            assert_eq!(result.text, "日本語");
            let request = server.join().unwrap().remove(0);
            assert!(request.0.contains("schema=v2&script=japanese&words=0"));
            assert!(request.0.contains(&format!("content-type: image/{format}")));
            assert_eq!(image::load_from_memory(&request.1).unwrap().width(), 32);
        }
    }
    #[test]
    fn openai_compatible_ocr_adapts_rejected_generation_parameters() {
        let (url, server) = endpoint(vec![
            (
                400,
                json!({"error":{"message":"use max_completion_tokens"}}),
            ),
            (
                400,
                json!({"error":{"message":"temperature is not supported"}}),
            ),
            (200, json!({"choices":[{"message":{"content":"日本語"}}]})),
        ]);
        let mut engine = Remote::new(Path::new("."), &json!({"engine_defaults":{"local_llm_ocr":{"url":format!("{url}/v1"),"model":"test-model","api_key":"","prompt":"Read dialogue"}}})).unwrap();
        assert_eq!(
            engine
                .recognize(&RgbaImage::new(32, 16), "local_llm_ocr", "ja")
                .unwrap()
                .text,
            "日本語"
        );
        let requests = server.join().unwrap();
        let bodies: Vec<Value> = requests
            .iter()
            .map(|r| serde_json::from_slice(&r.1).unwrap())
            .collect();
        assert!(
            requests
                .iter()
                .all(|r| r.0.starts_with("POST /v1/chat/completions "))
        );
        assert!(requests[0].0.contains("Bearer sk-no-key-required"));
        assert_eq!(
            bodies[0]["messages"][0]["content"][0]["text"],
            "Read dialogue"
        );
        assert!(
            bodies[0]["messages"][0]["content"][1]["image_url"]["url"]
                .as_str()
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
        assert!(bodies[1]["max_tokens"].is_null());
        assert_eq!(bodies[1]["max_completion_tokens"], 4096);
        assert!(bodies[2]["temperature"].is_null());
    }
    #[test]
    #[ignore = "Requires real fixture and network; Bing service may be unavailable"]
    fn bing_real_game_frame() {
        let image = image::open(std::env::var("GSM_OCR_IMAGE").unwrap())
            .unwrap()
            .into_rgba8();
        let mut engine = Remote::new(Path::new("."), &json!({})).unwrap();
        let start = std::time::Instant::now();
        let result = engine.recognize(&image, "bing", "ja").unwrap();
        assert!(!result.text.trim().is_empty());
        println!(
            "BING_REAL {}",
            json!({"milliseconds":start.elapsed().as_secs_f64()*1000.,"text":result.text,"lines":result.lines.len()})
        );
    }
    #[test]
    fn mlkit_preserves_pixel_boxes_and_words() {
        let r = parse_mlkit(
            &json!({"lines":[{"text":"日本語","box":[10,20,90,30],"words":[{"text":"日本語","box":{"x":10,"y":20,"width":90,"height":30}}]}]}),
        );
        assert_eq!(r.lines[0].bounds, [10., 20., 100., 50.]);
        assert_eq!(r.lines[0].words[0].text, "日本語");
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
