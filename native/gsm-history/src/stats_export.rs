//! Downloadable Kechimochi CSVs and their per-profile incremental cursors.
pub(crate) mod activity;
pub(crate) mod library;

use crate::{History, ReportCleaner, Result};
use chrono::Local;
use rusqlite::{params, OptionalExtension};
use std::{io::Write, path::Path, time::SystemTime};
use tempfile::TempPath;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Activity,
    Library,
}

impl ExportFormat {
    pub fn parse(key: &str) -> Option<Self> {
        match key {
            "kechimochi" => Some(Self::Activity),
            "kechimochi_library" => Some(Self::Library),
            _ => None,
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Self::Activity => "kechimochi",
            Self::Library => "kechimochi_library",
        }
    }
}

pub struct ExportOptions {
    pub format: ExportFormat,
    pub scope: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    pub include_external_stats: bool,
}

pub struct ExportPreferences<'a> {
    pub language: &'a str,
    pub session_gap: f64,
    pub cleaner: &'a ReportCleaner,
}

pub struct ExportFile {
    pub path: TempPath,
    pub filename: String,
    pub rows: usize,
    pub first_incremental: bool,
}

impl History {
    pub fn write_stats_export(
        &self,
        database: &Path,
        generation: u64,
        options: &ExportOptions,
        prefs: &ExportPreferences<'_>,
        mut progress: impl FnMut(u8, &str),
    ) -> Result<ExportFile> {
        if self.generation()? != generation {
            return Err("Job cancelled because the database closed".into());
        }
        let key = options.format.key();
        let mut file = tempfile::Builder::new()
            .prefix("gsm_stats_export_")
            .suffix(".csv")
            .tempfile()?;
        file.write_all(&[0xef, 0xbb, 0xbf])?;
        let mut csv = csv::WriterBuilder::new()
            .terminator(csv::Terminator::Any(b'\n'))
            .from_writer(file.as_file_mut());
        // Anchor the cursor before the read snapshot. An edit committed while a
        // large cover is written must still make it into the next download.
        let start = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)?
            .as_secs_f64();
        let (rows, first) = self.with_reader(database, |conn| {
            let tx = conn.transaction()?;
            let last: Option<f64> = tx
                .query_row(
                    "SELECT CAST(last_successful_export_at AS REAL)
                FROM stats_export_state WHERE format_key=?",
                    [key],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            let count = match options.format {
                ExportFormat::Library => {
                    library::write(&tx, &mut csv, prefs.language, &mut progress)?
                }
                ExportFormat::Activity => {
                    activity::write(&tx, &mut csv, options, prefs, last, &mut progress)?
                }
            };
            Ok((
                count,
                options.scope == "since_last_export" && last.is_none(),
            ))
        })?;
        csv.flush()?;
        drop(csv);
        let prefix = match options.format {
            ExportFormat::Activity => "gsm_kechimochi_activity_logs",
            ExportFormat::Library => "gsm_kechimochi_media_library",
        };
        let filename = format!("{prefix}_{}.csv", Local::now().format("%Y%m%d_%H%M%S"));
        self.with_writer_generation(database, Some(generation), |conn| {
            conn.execute("INSERT INTO stats_export_state(format_key,last_successful_export_at,created_at,updated_at)
                VALUES(?1,?2,?2,?2) ON CONFLICT(format_key) DO UPDATE SET
                last_successful_export_at=excluded.last_successful_export_at, updated_at=excluded.updated_at
                WHERE stats_export_state.last_successful_export_at IS NULL OR CAST(stats_export_state.last_successful_export_at AS REAL) < ?2",
                params![key,start])?;
            Ok(())
        })?;
        Ok(ExportFile {
            path: file.into_temp_path(),
            filename,
            rows,
            first_incremental: first,
        })
    }
}
