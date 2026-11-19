use gsm_settings::{paths::Paths, workspace::Workspace};
use serde_json::{json, Value};
use std::io::{self, Read};
use std::process::ExitCode;

fn preview() -> Result<String, String> {
    let mut input = Vec::new();
    io::stdin()
        .take(gsm_text_preview::SIZE_LIMIT as u64 + 1)
        .read_to_end(&mut input)
        .map_err(|e| e.to_string())?;
    if input.len() > gsm_text_preview::SIZE_LIMIT {
        return Err("Preview input exceeds the size limit.".into());
    }
    let payload: Value = serde_json::from_slice(&input).map_err(|e| e.to_string())?;
    let language = match payload["target_language"].as_str() {
        Some(value) => value.to_owned(),
        None => Workspace::new(&Paths::resolve()?.active).target_language()?,
    };
    gsm_text_preview::process(&payload, &language)
}

fn main() -> ExitCode {
    if !std::env::args().skip(1).eq(["--preview-json"]) {
        eprintln!("Usage: gsm-text-preview --preview-json < request.json");
        return ExitCode::from(2);
    }
    match preview() {
        Ok(result) => {
            println!("{}", json!({"result": result}));
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{}", json!({"error": error}));
            ExitCode::FAILURE
        }
    }
}
