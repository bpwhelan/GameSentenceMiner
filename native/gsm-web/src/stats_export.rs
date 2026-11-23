use super::{Preferences, Reply, Reports, Result};
pub use gsm_history::stats_export::ExportFile;
use gsm_history::stats_export::{ExportFormat, ExportOptions, ExportPreferences};
use serde_json::{json, Value};
use std::sync::Arc;

pub fn export_formats() -> Value {
    json!({"formats":[
        {"id":"kechimochi","label":"Kechimochi Activity Logs","description":"Exports GSM stats as Kechimochi-compatible daily activity CSV.","supports_date_range":true,"supports_external_stats":true},
        {"id":"kechimochi_library","label":"Kechimochi Media Library","description":"Exports your GSM library metadata as a separate Kechimochi media library CSV.","supports_date_range":false,"supports_external_stats":false}
    ]})
}

pub struct ExportWork {
    reports: Arc<Reports>,
    prefs: Arc<Preferences>,
    language: &'static str,
    options: ExportOptions,
    generation: u64,
}

impl Reports {
    pub fn export_generation(&self) -> Result<u64> {
        self.history.generation()
    }

    pub fn prepare_export(
        self: &Arc<Self>,
        body: &Value,
        name: fn(&str) -> &'static str,
    ) -> std::result::Result<Option<ExportWork>, Reply> {
        let key = body["format"].as_str().unwrap_or("").trim();
        let format = ExportFormat::parse(key)
            .ok_or_else(|| Reply::error(400, &format!("Unsupported export format: {key}")))?;
        let prefs = self
            .preferences()
            .map_err(|e| Reply::error(500, &e.to_string()))?;
        if format == ExportFormat::Activity && prefs.cleaner.is_none() {
            return Ok(None);
        }
        let generation = self.begin_file_import()?;
        let scope = body["scope"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("all_time")
            .trim()
            .to_lowercase();
        let external = body.get("include_external_stats").is_none_or(|v| match v {
            Value::Null => false,
            Value::Bool(enabled) => *enabled,
            Value::Number(n) => n.as_f64() != Some(0.0),
            Value::String(s) => !s.is_empty(),
            Value::Array(a) => !a.is_empty(),
            Value::Object(o) => !o.is_empty(),
        });
        let options = ExportOptions {
            format,
            scope,
            start_date: body["start_date"].as_str().map(str::to_owned),
            end_date: body["end_date"].as_str().map(str::to_owned),
            include_external_stats: external,
        };
        Ok(Some(ExportWork {
            reports: self.clone(),
            language: name(&prefs.language),
            prefs,
            options,
            generation,
        }))
    }
}

impl ExportWork {
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn format(&self) -> &'static str {
        self.options.format.key()
    }
    pub fn write(self, progress: impl FnMut(u8, &str)) -> Result<ExportFile> {
        let default = Default::default();
        let prefs = ExportPreferences {
            language: self.language,
            session_gap: self.prefs.gap,
            cleaner: self.prefs.cleaner.as_ref().unwrap_or(&default),
        };
        self.reports.history.write_stats_export(
            &self.reports.database,
            self.generation,
            &self.options,
            &prefs,
            progress,
        )
    }
}
