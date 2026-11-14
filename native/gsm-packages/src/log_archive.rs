//! Anonymized log archive builder (`.log`/`.txt`/`.jsonl`, `.gz`, `.zip` rotations).
use crate::log_redaction::LogRedactor;
use flate2::read::GzDecoder;
use gsm_settings::Result;
use regex::Regex;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const MAX_LOG_BYTES: u64 = 64 * 1024 * 1024;

pub const LOG_ANONYMIZATION_NOTICE: &str = "\
GSM anonymized log export\n\
\n\
These copies were automatically redacted before being added to this ZIP.\n\
Redaction covers local usernames, home folders, computer names, email addresses,\n\
remote IP/MAC addresses, and common password, API key, token and cookie formats.\n\
Compressed log history is decompressed and redacted too. Original logs are unchanged.\n\
Loopback addresses, timestamps, error messages and diagnostic context are retained.\n\
Current logs are at the top level; rotated and imported logs are in history/.\n\
ocr.log contains persistent OCR diagnostics. ocr-debug.jsonl is present when advanced\n\
OCR debugging has recorded events. Empty logs and internal lock files are omitted.\n\
\n\
Automatic redaction may miss personal details in free text, game text or unusual formats.\n\
Review the exported logs before sharing them.\n";

fn text_log_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\.(?:log|txt|jsonl)(?:\.\d+)?$").unwrap())
}

fn compressed_log_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\.(?:log|txt|jsonl)(?:\.\d+)?\.(?:zip|gz)$").unwrap())
}

fn is_text_log(name: &str) -> bool {
    text_log_regex().is_match(name)
}

fn is_compressed_log(name: &str) -> bool {
    compressed_log_regex().is_match(name)
}

fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy();
    #[cfg(windows)]
    {
        text.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        text.into_owned()
    }
}

pub fn list_log_files(logs_directory: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    fn visit(root: &Path, relative: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
        let dir = if relative.as_os_str().is_empty() {
            root.to_path_buf()
        } else {
            root.join(relative)
        };
        let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let name_os = entry.file_name();
            let name = name_os.to_string_lossy();
            if name.starts_with('.') {
                continue;
            }
            let file_type = entry.file_type().map_err(|e| e.to_string())?;
            if file_type.is_symlink() {
                continue;
            }
            let rel_path = relative.join(&name_os);
            if file_type.is_dir() {
                visit(root, &rel_path, files)?;
            } else if file_type.is_file() && (is_text_log(&name) || is_compressed_log(&name)) {
                match fs::metadata(root.join(&rel_path)) {
                    Ok(meta) => {
                        if meta.len() > 0 {
                            files.push(rel_path);
                        }
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(err) => return Err(err.to_string()),
                }
            }
        }
        Ok(())
    }

    visit(logs_directory, Path::new(""), &mut files)?;
    files.sort();
    Ok(files)
}

fn decode_log_bytes(raw: &[u8]) -> Result<String> {
    if raw.len() as u64 > MAX_LOG_BYTES {
        return Err("A log is not a regular file or exceeds the 64 MiB export limit.".into());
    }
    let text = if raw.starts_with(&[0xff, 0xfe]) {
        let payload = &raw[2..];
        if payload.len() % 2 != 0 {
            return Err("A log has an unsupported text encoding.".into());
        }
        let units: Vec<u16> = payload
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        String::from_utf16(&units).map_err(|_| "A log has an unsupported text encoding.")?
    } else {
        std::str::from_utf8(raw)
            .map_err(|_| "A log has an unsupported text encoding.")?
            .to_owned()
    };
    if text.contains('\0') {
        return Err("A log has an unsupported text encoding.".into());
    }
    Ok(text)
}

fn read_bounded(mut reader: impl Read, limit: u64, err_msg: &str) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut chunk = [0u8; 65536];
    let mut total = 0u64;
    loop {
        let read = reader.read(&mut chunk).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > limit {
            return Err(err_msg.into());
        }
        out.extend_from_slice(&chunk[..read]);
    }
    Ok(out)
}

#[derive(Debug)]
enum ReadLogOutcome {
    Text(String),
    NotFound,
}

fn read_log(file_path: &Path) -> Result<ReadLogOutcome> {
    let meta = match fs::symlink_metadata(file_path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ReadLogOutcome::NotFound),
        Err(e) => return Err(e.to_string()),
    };
    if !meta.file_type().is_file() || meta.len() > MAX_LOG_BYTES {
        return Err("A log is not a regular file or exceeds the 64 MiB export limit.".into());
    }

    let file = match File::open(file_path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ReadLogOutcome::NotFound),
        Err(e) => return Err(e.to_string()),
    };

    let is_gz = file_path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("gz"));
    let decoded = if is_gz {
        let decoder = GzDecoder::new(file);
        read_bounded(
            decoder,
            MAX_LOG_BYTES,
            "A log is not a regular file or exceeds the 64 MiB export limit.",
        )?
    } else {
        read_bounded(
            file,
            MAX_LOG_BYTES,
            "A log is not a regular file or exceeds the 64 MiB export limit.",
        )?
    };
    Ok(ReadLogOutcome::Text(decode_log_bytes(&decoded)?))
}

fn sanitize_archive_path(redactor: &LogRedactor, rel: &Path) -> String {
    let mut parts = Vec::new();
    for component in rel.components() {
        if let Component::Normal(segment) = component {
            parts.push(redactor.redact_segment(&segment.to_string_lossy()));
        }
    }
    if parts.is_empty() {
        "_".into()
    } else {
        parts.join("/")
    }
}

fn unique_archive_name(names: &mut HashSet<String>, base_name: &str) -> String {
    let mut candidate = base_name.to_owned();
    let mut suffix = 2u32;
    let (dir, file) = match base_name.rsplit_once('/') {
        Some((d, f)) => (Some(d), f),
        None => (None, base_name),
    };
    while !names.insert(candidate.to_lowercase()) {
        candidate = match dir {
            Some(d) => format!("{d}/{suffix}-{file}"),
            None => format!("{suffix}-{file}"),
        };
        suffix += 1;
    }
    candidate
}

pub fn create_anonymized_logs_archive(
    logs_directory: &Path,
    output_path: &Path,
    redactor: &LogRedactor,
) -> Result<()> {
    let files = list_log_files(logs_directory)?;
    if files.is_empty() {
        return Err("No log files found in the logs directory.".into());
    }

    let source_dir = fs::canonicalize(logs_directory).map_err(|e| e.to_string())?;
    let out_parent = output_path
        .parent()
        .ok_or("Output path missing parent directory")?;
    fs::create_dir_all(out_parent).map_err(|e| e.to_string())?;
    let out_dir = fs::canonicalize(out_parent).map_err(|e| e.to_string())?;
    let out_file_name = output_path
        .file_name()
        .ok_or("Output path missing file name")?;
    let dest_key = path_key(&out_dir.join(out_file_name));
    if files
        .iter()
        .any(|f| path_key(&source_dir.join(f)) == dest_key)
    {
        return Err("Choose an export location that does not overwrite a source log.".into());
    }

    let temp_path = out_dir.join(format!(".gsm-log-export-{}.zip.tmp", uuid::Uuid::new_v4()));
    let write_result = (|| -> Result<()> {
        let out_file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|e| e.to_string())?;
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        let mut writer = ZipWriter::new(out_file);

        writer
            .start_file("ANONYMIZATION.txt", options)
            .map_err(|e| e.to_string())?;
        writer
            .write_all(LOG_ANONYMIZATION_NOTICE.as_bytes())
            .map_err(|e| e.to_string())?;

        let mut names = HashSet::from([
            "anonymization.txt".to_owned(),
            "export_notes.txt".to_owned(),
        ]);
        let mut skipped: Vec<String> = Vec::new();

        for rel in &files {
            let source = logs_directory.join(rel);
            let rel_str = rel.to_string_lossy();
            let is_zip = rel
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("zip"));

            if !is_zip {
                match read_log(&source)? {
                    ReadLogOutcome::NotFound => {
                        skipped.push(rel_str.into_owned());
                    }
                    ReadLogOutcome::Text(text) => {
                        let sanitized = redactor.redact(&text);
                        let trimmed_rel = if rel_str.to_ascii_lowercase().ends_with(".gz") {
                            PathBuf::from(&rel_str[..rel_str.len() - 3])
                        } else {
                            rel.clone()
                        };
                        let base_name = sanitize_archive_path(redactor, &trimmed_rel);
                        let archive_name = unique_archive_name(&mut names, &base_name);
                        writer
                            .start_file(&archive_name, options)
                            .map_err(|e| e.to_string())?;
                        writer
                            .write_all(sanitized.as_bytes())
                            .map_err(|e| e.to_string())?;
                    }
                }
                continue;
            }

            let meta = match fs::symlink_metadata(&source) {
                Ok(m) => m,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    skipped.push(rel_str.into_owned());
                    continue;
                }
                Err(e) => return Err(e.to_string()),
            };
            if !meta.file_type().is_file() || meta.len() > MAX_LOG_BYTES {
                return Err(
                    "A compressed log is not a regular file or exceeds the 64 MiB export limit."
                        .into(),
                );
            }
            let zip_file = match File::open(&source) {
                Ok(f) => f,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    skipped.push(rel_str.into_owned());
                    continue;
                }
                Err(e) => return Err(e.to_string()),
            };
            let mut inner = ZipArchive::new(zip_file).map_err(|e| e.to_string())?;
            let mut total_uncompressed = 0u64;
            let rel_parent = rel.parent().unwrap_or_else(|| Path::new(""));

            for i in 0..inner.len() {
                let mut entry = inner.by_index(i).map_err(|e| e.to_string())?;
                let entry_name = entry.name().to_owned();
                let mode = entry.unix_mode().map(|m| m & 0o170000).unwrap_or(0);
                let is_valid_mode = mode == 0 || mode == 0o100000 || mode == 0o040000;
                total_uncompressed = total_uncompressed
                    .checked_add(entry.size())
                    .ok_or("A compressed log contains unsupported entries or exceeds the 64 MiB export limit.")?;
                if !is_valid_mode
                    || total_uncompressed > MAX_LOG_BYTES
                    || (!entry.is_dir() && !is_text_log(&entry_name))
                {
                    return Err("A compressed log contains unsupported entries or exceeds the 64 MiB export limit.".into());
                }
                if entry.is_dir() {
                    continue;
                }
                let enclosed = entry
                    .enclosed_name()
                    .ok_or("A compressed log contains unsupported entries or exceeds the 64 MiB export limit.")?;
                let bytes = read_bounded(
                    &mut entry,
                    MAX_LOG_BYTES,
                    "A compressed log contains unsupported entries or exceeds the 64 MiB export limit.",
                )?;
                let text = decode_log_bytes(&bytes)?;
                let sanitized = redactor.redact(&text);
                let combined_rel = rel_parent.join(enclosed);
                let base_name = sanitize_archive_path(redactor, &combined_rel);
                let archive_name = unique_archive_name(&mut names, &base_name);
                writer
                    .start_file(&archive_name, options)
                    .map_err(|e| e.to_string())?;
                writer
                    .write_all(sanitized.as_bytes())
                    .map_err(|e| e.to_string())?;
            }
        }

        if !skipped.is_empty() {
            let notes = redactor.redact(&format!(
                "These logs rotated or were removed while the export was being read:\n{}\n",
                skipped.join("\n")
            ));
            writer
                .start_file("EXPORT_NOTES.txt", options)
                .map_err(|e| e.to_string())?;
            writer
                .write_all(notes.as_bytes())
                .map_err(|e| e.to_string())?;
        }

        let file = writer.finish().map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(())
    })();

    if let Err(err) = write_result {
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
    use crate::log_redaction::LogRedactionContext;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use tempfile::tempdir;

    #[test]
    fn archives_plain_utf16le_gz_and_rotated_zip_logs_while_redacting_contents_and_paths() {
        let dir = tempdir().unwrap();
        let logs_dir = dir.path().join("logs");
        let history_dir = logs_dir.join("history");
        fs::create_dir_all(&history_dir).unwrap();

        fs::write(logs_dir.join("gsm.log"), "User Alice token=secret123\n").unwrap();
        fs::write(logs_dir.join("empty.log"), "").unwrap();
        fs::write(logs_dir.join(".lock"), "ignored").unwrap();

        // UTF-16LE with BOM
        let mut utf16_bytes = vec![0xFFu8, 0xFEu8];
        for code in "host=ALICE-PC ok\n".encode_utf16() {
            utf16_bytes.extend_from_slice(&code.to_le_bytes());
        }
        fs::write(logs_dir.join("win.log"), utf16_bytes).unwrap();

        // .gz compressed log
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(b"peer=198.51.100.77 user=Alice\n").unwrap();
        fs::write(history_dir.join("older.log.1.gz"), gz.finish().unwrap()).unwrap();

        // .zip rotated log with sensitive path segment
        let zip_buf = Vec::new();
        let mut inner = ZipWriter::new(std::io::Cursor::new(zip_buf));
        inner
            .start_file("Alice-session.txt", SimpleFileOptions::default())
            .unwrap();
        inner.write_all(b"C:\\Users\\Alice\\foo\n").unwrap();
        let finished_zip = inner.finish().unwrap().into_inner();
        fs::write(history_dir.join("rotated.log.zip"), finished_zip).unwrap();

        let redactor = LogRedactor::new(LogRedactionContext {
            home_paths: vec![r"C:\Users\Alice".into()],
            usernames: vec!["Alice".into()],
            hostnames: vec!["ALICE-PC".into()],
        });

        // Refuse overwriting a source log.
        assert!(create_anonymized_logs_archive(&logs_dir, &logs_dir.join("gsm.log"), &redactor).is_err());

        let out_zip = dir.path().join("export.zip");
        create_anonymized_logs_archive(&logs_dir, &out_zip, &redactor).unwrap();

        let mut reader = ZipArchive::new(File::open(&out_zip).unwrap()).unwrap();
        let mut entry_names = Vec::new();
        for i in 0..reader.len() {
            let mut file = reader.by_index(i).unwrap();
            let name = file.name().to_owned();
            let mut content = String::new();
            file.read_to_string(&mut content).unwrap();
            assert!(!name.contains("Alice"), "path escaped redaction: {name}");
            assert!(!content.contains("Alice"), "content escaped redaction in {name}: {content}");
            assert!(!content.contains("ALICE-PC"));
            assert!(!content.contains("198.51.100.77"));
            assert!(!content.contains("secret123"));
            entry_names.push(name);
        }
        assert!(entry_names.contains(&"ANONYMIZATION.txt".to_owned()));
        assert!(entry_names.contains(&"gsm.log".to_owned()));
        assert!(entry_names.contains(&"win.log".to_owned()));
        assert!(entry_names.contains(&"history/older.log.1".to_owned()));
        assert!(entry_names.contains(&"history/[USER]-session.txt".to_owned()));
    }

    #[test]
    fn rejects_zip_rotation_with_non_log_entry() {
        let dir = tempdir().unwrap();
        let logs_dir = dir.path().join("logs");
        fs::create_dir_all(&logs_dir).unwrap();

        let mut inner = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        inner
            .start_file("evil.exe", SimpleFileOptions::default())
            .unwrap();
        inner.write_all(b"mz").unwrap();
        fs::write(logs_dir.join("bad.log.zip"), inner.finish().unwrap().into_inner()).unwrap();

        let out_zip = dir.path().join("export.zip");
        let err = create_anonymized_logs_archive(&logs_dir, &out_zip, &LogRedactor::new(Default::default())).unwrap_err();
        assert!(err.contains("unsupported entries"));
        assert!(!out_zip.exists());
    }
}
