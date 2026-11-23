use crate::{Reply, Reports};
use gsm_history::exstatic::{Imported, InvalidCsv};
use serde_json::json;
use std::io::BufRead;

pub struct ExStaticImport {
    lines: Imported,
    dictionary: &'static str,
}

impl ExStaticImport {
    pub fn take_index_ids(&mut self) -> (&'static str, Vec<String>) {
        (self.dictionary, std::mem::take(&mut self.lines.index_ids))
    }

    pub fn reply(self, queued: bool) -> Reply {
        let Imported {
            count,
            games,
            warnings,
            ..
        } = self.lines;
        let (status, message) = if queued {
            ("queued", "Daily rollup has been queued.")
        } else {
            ("failed", "Daily rollup could not be queued.")
        };
        let mut body = json!({
            "message":format!("Successfully imported {count} lines from {} games. {message}",games.len()),
            "imported_count":count, "games_count":games.len(), "games":games,
            "rollup_status":status, "rollup_message":message,
        });
        if !warnings.is_empty() {
            body["warning_count"] = warnings.len().into();
            body["warnings"] = warnings.into();
        }
        Reply { status: 200, body }
    }
}

impl Reports {
    pub fn import_exstatic(
        &self,
        generation: u64,
        file: impl BufRead,
    ) -> Result<ExStaticImport, Reply> {
        let prefs = self
            .preferences()
            .map_err(|e| Reply::error(500, &e.to_string()))?;
        let lines = self
            .history
            .import_exstatic(
                &self.database,
                generation,
                file,
                &prefs.language,
                prefs.tokenization,
            )
            .map_err(|e| {
                if e.is::<InvalidCsv>() {
                    Reply::error(400, &e.to_string())
                } else {
                    Reply::error(500, &format!("Import failed: {e}"))
                }
            })?;
        Ok(ExStaticImport {
            lines,
            dictionary: prefs.dictionary,
        })
    }
}
