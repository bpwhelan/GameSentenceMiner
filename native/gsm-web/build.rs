use flate2::{write::GzEncoder, Compression};
use sha2::{Digest, Sha256};
use std::{
    env,
    fmt::Write as _,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

fn files(root: &Path, out: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            files(&entry.path(), out)?;
        }
        if kind.is_file() {
            out.push(entry.path());
        }
    }
    Ok(())
}

fn main() -> io::Result<()> {
    let root = Path::new("../../GameSentenceMiner/web");
    let dest = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let mut assets = String::from("pub fn asset(path:&str)->Option<Asset>{Some(match path {\n");
    let mut templates =
        String::from("fn template_source(name:&str)->Option<&'static str>{Some(match name {\n");
    let mut sorting = Vec::new();
    let mut sorting_modified = 0;
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    let epoch = env::var("SOURCE_DATE_EPOCH").ok().and_then(|s| s.parse::<u64>().ok());
    for dir in ["static", "templates"] {
        let folder = root.join(dir);
        println!("cargo:rerun-if-changed={}", folder.display());
        let mut inputs = Vec::new();
        files(&folder, &mut inputs)?;
        inputs.sort();
        for file in inputs {
            let key = file
                .strip_prefix(&folder)
                .unwrap()
                .to_str()
                .unwrap()
                .replace('\\', "/");
            let modified = epoch.unwrap_or_else(|| file.metadata().ok().and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |t| t.as_secs()));
            let path = file.canonicalize()?;
            let path = path.to_str().unwrap();
            if let Some(name) = key
                .strip_prefix("components/kanji_grid/")
                .filter(|s| s.ends_with(".json") && !s.contains('/'))
            {
                use serde_json::{json, Value};
                let value: Value = serde_json::from_slice(&fs::read(&file)?)?;
                let stem = name.strip_suffix(".json").unwrap();
                let groups = match value.get("groups") {
                    None => 0,
                    Some(Value::Array(a)) => a.len(),
                    Some(Value::Object(o)) => o.len(),
                    Some(Value::String(s)) => s.chars().count(),
                    _ => {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            format!("{name}: invalid groups"),
                        ))
                    }
                };
                sorting.push(json!({"filename":name,"name":value.get("name").cloned().unwrap_or(json!(stem)),
                    "version":value.get("version").cloned().unwrap_or(json!(1)),"lang":value.get("lang").cloned().unwrap_or(json!("ja")),
                    "source":value.get("source").cloned().unwrap_or(json!("")),"group_count":groups}));
                let url = format!("/api/kanji-sorting-config/{stem}");
                let key = format!("{url:?} | {:?}", format!("{url}.json"));
                sorting_modified = sorting_modified.max(modified);
                json_asset(&mut assets, &dest, &key, &value, modified)?;
                continue;
            }
            if dir == "templates" && key != "index.html" {
                if key.ends_with(".html") {
                    writeln!(templates, "{key:?} => include_str!({path:?}),").unwrap();
                }
                continue;
            }
            let ext = file.extension().and_then(|s| s.to_str()).unwrap_or("");
            let mime = match ext {
                "html" => "text/html; charset=utf-8",
                "js" => "text/javascript; charset=utf-8",
                "css" => "text/css; charset=utf-8",
                "ico" => "image/vnd.microsoft.icon",
                "png" => "image/png",
                "svg" => "image/svg+xml; charset=utf-8",
                "webmanifest" => "application/manifest+json",
                _ => continue,
            };
            let bytes = fs::read(&file)?;
            let hash = format!("{:x}", Sha256::digest(&bytes));
            let mut gzip_hash = String::new();
            let mut compressed = "None".to_owned();
            if bytes.len() >= 500 && matches!(ext, "html" | "js" | "css" | "svg" | "webmanifest") {
                let mut gz = GzEncoder::new(Vec::new(), Compression::default());
                gz.write_all(&bytes)?;
                let encoded = gz.finish()?;
                if encoded.len() < bytes.len() {
                    let target = dest.join(format!("{hash}.gz"));
                    gzip_hash = format!("{:x}", Sha256::digest(&encoded));
                    fs::write(&target, encoded)?;
                    compressed = format!("Some(include_bytes!({:?}))", target.to_str().unwrap());
                }
            }
            let url = if dir == "templates" {
                "/texthooker".into()
            } else {
                format!("/static/{key}")
            };
            if url == "/static/favicon.ico" {
                assets.push_str("\"/favicon.ico\" | ");
            }
            writeln!(assets, "{url:?} => Asset{{ bytes:include_bytes!({path:?}), gzip:{compressed}, content_type:{mime:?}, modified:{modified}, etag:{:?}, gzip_etag:{:?} }},",format!("\"{hash}\""), format!("\"{gzip_hash}\"")).unwrap();
        }
    }
    sorting.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    json_asset(
        &mut assets,
        &dest,
        "\"/api/kanji-sorting-configs\"",
        &serde_json::json!({"configs":sorting}),
        sorting_modified,
    )?;
    for code in [&mut assets, &mut templates] {
        code.push_str("_ => return None,})}\n");
    }
    fs::write(dest.join("assets.rs"), assets)?;
    fs::write(dest.join("templates.rs"), templates)
}

fn json_asset(
    code: &mut String,
    dest: &Path,
    pattern: &str,
    value: &serde_json::Value,
    modified: u64,
) -> io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let file = dest.join(format!("{hash}.json"));
    fs::write(&file, &bytes)?;
    let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
    gzip.write_all(&bytes)?;
    let compressed = dest.join(format!("{hash}.gz"));
    let encoded = gzip.finish()?;
    let gzip_hash = format!("{:x}", Sha256::digest(&encoded));
    fs::write(&compressed, encoded)?;
    writeln!(code,"{pattern} => Asset{{bytes:include_bytes!({file:?}), gzip:Some(include_bytes!({compressed:?})), content_type:\"application/json\", modified:{modified}, etag:{:?}, gzip_etag:{:?} }},",format!("\"{hash}\""), format!("\"{gzip_hash}\"")).unwrap();
    Ok(())
}
