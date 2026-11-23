use crate::{Reply, Reports};
use serde_json::Value;
use std::io::BufRead;

impl Reports {
    pub fn import_kizuna(
        &self,
        generation: u64,
        file: impl BufRead,
        clear: bool,
    ) -> Result<Value, Reply> {
        self.history
            .import_kizuna(&self.database, generation, file, clear)
            .map_err(|e| {
                if e.is::<gsm_history::kizuna::InvalidFile>() {
                    Reply::error(400, &e.to_string())
                } else {
                    Reply::error(500, "Kizuna import failed. No changes were saved.")
                }
            })
    }
}
