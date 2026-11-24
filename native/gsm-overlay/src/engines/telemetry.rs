use anyhow::Result;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageSnapshot {
    pub id: String,
    pub category: &'static str,
    pub name: String,
    pub detail: Option<String>,
    pub instances: u32,
    pub file_bytes: u64,
    pub estimated_ram_bytes: Option<u64>,
    pub idle_seconds: u64,
    pub unloads_on_idle: bool,
    pub storage: &'static str,
}

struct RegistryEntry {
    name: &'static str,
    detail: Option<String>,
    instances: u32,
    file_bytes: u64,
    estimated_ram_bytes: Option<u64>,
    last_used: Instant,
    unloads_on_idle: bool,
}

static REGISTRY: OnceLock<Mutex<BTreeMap<&'static str, RegistryEntry>>> = OnceLock::new();

fn registry() -> &'static Mutex<BTreeMap<&'static str, RegistryEntry>> {
    REGISTRY.get_or_init(|| Mutex::new(BTreeMap::new()))
}

#[cfg(windows)]
fn current_process_private_working_set() -> Option<u64> {
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX2,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    let mut counters: PROCESS_MEMORY_COUNTERS_EX2 = unsafe { std::mem::zeroed() };
    counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32;
    let ok = unsafe {
        K32GetProcessMemoryInfo(
            GetCurrentProcess(),
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX2).cast::<PROCESS_MEMORY_COUNTERS>(),
            counters.cb,
        )
    };
    (ok != 0).then_some(counters.PrivateWorkingSetSize as u64)
}

#[cfg(not(windows))]
fn current_process_private_working_set() -> Option<u64> {
    None
}

pub(crate) struct ModelRegistration {
    id: &'static str,
    ram_delta: Option<u64>,
}

impl ModelRegistration {
    pub(crate) fn measure_load<T>(
        id: &'static str,
        name: &'static str,
        detail: Option<String>,
        file_bytes: u64,
        unloads_on_idle: bool,
        loader: impl FnOnce() -> Result<T>,
    ) -> Result<(T, Self)> {
        let before = current_process_private_working_set();
        let value = loader()?;
        let after = current_process_private_working_set();
        let ram_delta = before.zip(after).map(|(b, a)| a.saturating_sub(b));
        let now = Instant::now();
        if let Ok(mut guard) = registry().lock() {
            let entry = guard.entry(id).or_insert_with(|| RegistryEntry {
                name,
                detail: detail.clone(),
                instances: 0,
                file_bytes,
                estimated_ram_bytes: ram_delta.map(|_| 0),
                last_used: now,
                unloads_on_idle,
            });
            entry.name = name;
            entry.detail = detail;
            entry.instances = entry.instances.saturating_add(1);
            entry.file_bytes = file_bytes;
            entry.last_used = now;
            entry.unloads_on_idle = unloads_on_idle;
            if let Some(delta) = ram_delta {
                entry.estimated_ram_bytes = Some(
                    entry
                        .estimated_ram_bytes
                        .unwrap_or(0)
                        .saturating_add(delta),
                );
            }
        }
        Ok((value, Self { id, ram_delta }))
    }

    pub(crate) fn touch(&self) {
        if let Ok(mut guard) = registry().try_lock() {
            if let Some(entry) = guard.get_mut(self.id) {
                entry.last_used = Instant::now();
            }
        }
    }
}

impl Drop for ModelRegistration {
    fn drop(&mut self) {
        if let Ok(mut guard) = registry().lock() {
            let remove = if let Some(entry) = guard.get_mut(self.id) {
                entry.instances = entry.instances.saturating_sub(1);
                if let (Some(total), Some(delta)) =
                    (entry.estimated_ram_bytes.as_mut(), self.ram_delta)
                {
                    *total = total.saturating_sub(delta);
                }
                entry.instances == 0
            } else {
                false
            };
            if remove {
                guard.remove(self.id);
            }
        }
    }
}

pub fn snapshot() -> Vec<ModelUsageSnapshot> {
    let Ok(guard) = registry().try_lock() else {
        return Vec::new();
    };
    let now = Instant::now();
    guard
        .iter()
        .map(|(id, entry)| ModelUsageSnapshot {
            id: (*id).to_string(),
            category: "ocr",
            name: entry.name.to_string(),
            detail: entry.detail.clone(),
            instances: entry.instances,
            file_bytes: entry.file_bytes,
            estimated_ram_bytes: entry.estimated_ram_bytes,
            idle_seconds: now.saturating_duration_since(entry.last_used).as_secs(),
            unloads_on_idle: entry.unloads_on_idle,
            storage: "ram",
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_adds_and_removes_model_from_snapshot() {
        let (_, reg) = ModelRegistration::measure_load(
            "test_ocr_model",
            "Test OCR",
            Some("tiny".into()),
            1234,
            true,
            || Ok(()),
        )
        .unwrap();
        let snap = snapshot();
        let item = snap.iter().find(|item| item.id == "test_ocr_model").unwrap();
        assert_eq!(item.name, "Test OCR");
        assert_eq!(item.detail.as_deref(), Some("tiny"));
        assert_eq!(item.instances, 1);
        assert_eq!(item.file_bytes, 1234);
        assert!(item.unloads_on_idle);

        reg.touch();
        drop(reg);
        let snap_after = snapshot();
        assert!(!snap_after.iter().any(|item| item.id == "test_ocr_model"));
    }
}
