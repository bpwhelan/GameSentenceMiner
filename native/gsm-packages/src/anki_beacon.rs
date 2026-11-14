//! AnkiBeacon `.ankiaddon` package configurator using in-memory ZIP streaming.
use gsm_settings::Result;
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::Path;
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

const ANKI_BEACON_CONFIG_FILE: &str = "config.json";
const GSM_ANKI_EVENTS_PATH: &str = "/anki/events";

pub fn validate_port(port: u16) -> Result<()> {
    if port == 0 {
        return Err(format!("Invalid GSM port: {port}"));
    }
    Ok(())
}

fn is_local_gsm_event_url(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let is_local = host == "127.0.0.1" || host == "localhost" || host == "[::1]" || host == "::1";
    is_local && url.path() == GSM_ANKI_EVENTS_PATH
}

fn with_port(raw: &str, port: u16) -> Result<String> {
    let mut url = reqwest::Url::parse(raw).map_err(|e| e.to_string())?;
    url.set_port(Some(port))
        .map_err(|_| format!("Invalid GSM port: {port}"))?;
    Ok(url.into())
}

pub fn configure_anki_beacon_config(config: &Value, gsm_port: u16) -> Result<Value> {
    validate_port(gsm_port)?;
    let Some(root) = config.as_object() else {
        return Err("AnkiBeacon package has an unsupported config.json".into());
    };
    let Some(ops_val) = root.get("operations").and_then(Value::as_array) else {
        return Err("AnkiBeacon package has an unsupported config.json".into());
    };

    let mut found_note_added = false;
    let mut next_ops = Vec::with_capacity(ops_val.len());

    for operation in ops_val {
        let Some(op_map) = operation.as_object() else {
            next_ops.push(operation.clone());
            continue;
        };
        if op_map.get("operation").and_then(Value::as_str) != Some("note_added") {
            next_ops.push(operation.clone());
            continue;
        }

        found_note_added = true;
        let current_urls = op_map
            .get("urls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut updated_local_url = false;
        let mut next_urls = Vec::with_capacity(current_urls.len() + 1);
        for val in current_urls {
            if let Some(s) = val.as_str() {
                if is_local_gsm_event_url(s) {
                    updated_local_url = true;
                    next_urls.push(Value::String(with_port(s, gsm_port)?));
                    continue;
                }
            }
            next_urls.push(val);
        }
        if !updated_local_url {
            next_urls.push(Value::String(format!(
                "http://127.0.0.1:{gsm_port}{GSM_ANKI_EVENTS_PATH}"
            )));
        }

        let mut next_op = op_map.clone();
        next_op.insert("urls".into(), Value::Array(next_urls));
        next_op.insert("payload_mode".into(), json!("note"));
        next_ops.push(Value::Object(next_op));
    }

    if !found_note_added {
        return Err("AnkiBeacon package does not define a note_added operation".into());
    }

    let mut next_root = root.clone();
    next_root.insert("operations".into(), Value::Array(next_ops));
    Ok(Value::Object(next_root))
}

pub fn write_configured_anki_beacon_addon(
    addon_bytes: &[u8],
    output_path: &Path,
    gsm_port: u16,
) -> Result<()> {
    validate_port(gsm_port)?;
    let out_dir = output_path
        .parent()
        .ok_or("Missing AnkiBeacon output parent directory")?;
    fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    let temp_path = out_dir.join(format!(
        ".anki-beacon-{}.ankiaddon.tmp",
        uuid::Uuid::new_v4()
    ));

    let write_res = (|| -> Result<()> {
        let mut archive = ZipArchive::new(Cursor::new(addon_bytes)).map_err(|e| e.to_string())?;
        let mut seen_config = false;
        let out_file = File::create(&temp_path).map_err(|e| e.to_string())?;
        let mut writer = ZipWriter::new(out_file);

        for idx in 0..archive.len() {
            let mut entry = archive.by_index(idx).map_err(|e| e.to_string())?;
            let name = entry.name().to_owned();
            if name == ANKI_BEACON_CONFIG_FILE {
                seen_config = true;
                let mut raw = String::new();
                entry.read_to_string(&mut raw).map_err(|e| e.to_string())?;
                let parsed: Value = serde_json::from_str(raw.trim_start_matches('\u{feff}'))
                    .map_err(|e| e.to_string())?;
                let configured = configure_anki_beacon_config(&parsed, gsm_port)?;
                let formatted = format!(
                    "{}\n",
                    serde_json::to_string_pretty(&configured).map_err(|e| e.to_string())?
                );
                writer
                    .start_file(&name, SimpleFileOptions::default())
                    .map_err(|e| e.to_string())?;
                writer
                    .write_all(formatted.as_bytes())
                    .map_err(|e| e.to_string())?;
            } else {
                writer.raw_copy_file(entry).map_err(|e| e.to_string())?;
            }
        }

        if !seen_config {
            return Err("AnkiBeacon package is missing config.json".into());
        }

        let finished = writer.finish().map_err(|e| e.to_string())?;
        finished.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })();

    if let Err(err) = write_res {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }

    if output_path.exists() {
        fs::remove_file(output_path).map_err(|e| e.to_string())?;
    }
    fs::rename(&temp_path, output_path).map_err(|e| {
        let _ = fs::remove_file(&temp_path);
        e.to_string()
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rewrites_local_port_or_appends_url_and_raw_copies_other_entries() {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut buf);
            zip.start_file("__init__.py", SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"print('beacon')").unwrap();
            zip.start_file("config.json", SimpleFileOptions::default())
                .unwrap();
            zip.write_all(
                br#"{"operations":[{"operation":"note_added","urls":["http://localhost:7275/anki/events","https://example.com/other"]},{"operation":"other"}]}"#,
            )
            .unwrap();
            zip.finish().unwrap();
        }

        let dir = tempdir().unwrap();
        let output = dir.path().join("anki_beacon.ankiaddon");
        write_configured_anki_beacon_addon(buf.get_ref(), &output, 8383).unwrap();

        let mut reader = ZipArchive::new(File::open(&output).unwrap()).unwrap();
        let mut init_py = String::new();
        reader
            .by_name("__init__.py")
            .unwrap()
            .read_to_string(&mut init_py)
            .unwrap();
        assert_eq!(init_py, "print('beacon')");

        let mut cfg_raw = String::new();
        reader
            .by_name("config.json")
            .unwrap()
            .read_to_string(&mut cfg_raw)
            .unwrap();
        let cfg: Value = serde_json::from_str(&cfg_raw).unwrap();
        assert_eq!(
            cfg["operations"][0]["urls"][0],
            json!("http://localhost:8383/anki/events")
        );
        assert_eq!(cfg["operations"][0]["payload_mode"], json!("note"));
        assert_eq!(cfg["operations"][0]["urls"][1], json!("https://example.com/other"));
    }

    #[test]
    fn appends_local_url_when_missing_and_rejects_port_zero() {
        assert!(validate_port(0).is_err());
        let configured = configure_anki_beacon_config(
            &json!({"operations": [{"operation": "note_added", "urls": []}]}),
            9001,
        )
        .unwrap();
        assert_eq!(
            configured["operations"][0]["urls"],
            json!(["http://127.0.0.1:9001/anki/events"])
        );
    }
}
