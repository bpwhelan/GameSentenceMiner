//! Shared OS thread scheduling, core-parking, and ONNX thread limits for OCR and Overlay.
//!
//! Applies best-effort thread priority, power/efficiency QoS, and soft CPU affinity
//! (Windows CPU Sets, Linux `sched_setaffinity`, macOS QoS classes) to both long-lived
//! worker threads (`gsm-ocr`, `gsm-overlay`) and ONNX Runtime intra-op worker pools.

use serde::Serialize;
use serde_json::Value;
#[cfg(windows)]
use std::sync::OnceLock;

/// Maximum logical CPU index accepted from user-provided custom core lists.
const MAX_CORE_INDEX: usize = 1024;
/// Minimum logical CPU count before automatic background-core partitioning restricts cores.
const MIN_CPUS_FOR_BACKGROUND_SPLIT: usize = 4;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ThreadPriority {
    Low,
    BelowNormal,
    #[default]
    Normal,
    AboveNormal,
    High,
}

impl ThreadPriority {
    pub fn from_str_lossy(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "low" => Self::Low,
            "below_normal" => Self::BelowNormal,
            "above_normal" => Self::AboveNormal,
            "high" => Self::High,
            _ => Self::Normal,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::BelowNormal => "below_normal",
            Self::Normal => "normal",
            Self::AboveNormal => "above_normal",
            Self::High => "high",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CpuParkingMode {
    /// OS default scheduling (clears any custom CPU Sets or EcoQoS throttling).
    #[default]
    Auto,
    /// Prefer efficiency / background cores via OS QoS (Windows EcoQoS + E-core CPU Sets
    /// when present; macOS background QoS; Linux lower priority).
    Efficiency,
    /// Park OCR/ONNX work away from primary game/UI cores:
    /// - Hybrid CPUs (e.g. Intel P+E): E-cores
    /// - Multi-LLC / Dual-CCD CPUs (e.g. AMD X3D): secondary CCD / LLC
    /// - Homogeneous CPUs (>= 4 logical CPUs): upper half of logical CPUs
    BackgroundCores,
    /// Soft-park onto explicit logical CPU indices (e.g. `4-7` or `8,10-15`).
    Custom,
}

impl CpuParkingMode {
    pub fn from_str_lossy(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "efficiency" => Self::Efficiency,
            "background_cores" => Self::BackgroundCores,
            "custom" => Self::Custom,
            _ => Self::Auto,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Efficiency => "efficiency",
            Self::BackgroundCores => "background_cores",
            Self::Custom => "custom",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ThreadPolicy {
    pub priority: ThreadPriority,
    pub cpu_parking: CpuParkingMode,
    /// Sorted, deduplicated logical CPU indices used when `cpu_parking == CpuParkingMode::Custom`.
    pub custom_cores: Vec<usize>,
    /// Optional explicit cap on ONNX intra-op thread count (`None` = engine default).
    pub onnx_threads: Option<usize>,
}

impl ThreadPolicy {
    /// Parse a shared policy from an OCR settings JSON object.
    pub fn from_ocr_settings(settings: &Value) -> Self {
        let priority = settings
            .get("processPriority")
            .and_then(Value::as_str)
            .map(ThreadPriority::from_str_lossy)
            .unwrap_or_default();
        let cpu_parking = settings
            .get("cpuParkingMode")
            .and_then(Value::as_str)
            .map(CpuParkingMode::from_str_lossy)
            .unwrap_or_default();
        let custom_cores = settings
            .get("cpuParkingCores")
            .and_then(Value::as_str)
            .map(parse_core_list)
            .unwrap_or_default();
        let onnx_threads = settings
            .get("onnxMaxThreads")
            .and_then(|v| {
                v.as_u64()
                    .or_else(|| v.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
            })
            .filter(|&n| n > 0)
            .map(|n| (n as usize).clamp(1, 64));
        Self {
            priority,
            cpu_parking,
            custom_cores,
            onnx_threads,
        }
    }

    /// Whether ONNX Runtime sessions need a custom `ThreadManager` to apply thread scheduling
    /// on newly spawned intra-op worker threads.
    pub fn needs_custom_thread_manager(&self) -> bool {
        self.priority != ThreadPriority::Normal || self.cpu_parking != CpuParkingMode::Auto
    }

    /// Resolve the ONNX intra-op thread count for an engine whose default is `default_threads`.
    pub fn resolve_onnx_threads(&self, default_threads: usize) -> usize {
        let available = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1)
            .max(1);
        if let Some(explicit) = self.onnx_threads {
            return explicit.clamp(1, available);
        }
        let base = default_threads.clamp(1, available);
        match self.target_core_count() {
            Some(target) if target > 0 => base.min(target).max(1),
            _ => base,
        }
    }

    /// Number of logical CPUs targeted by the active parking mode, if constrained.
    pub fn target_core_count(&self) -> Option<usize> {
        let topology = cpu_topology();
        match self.cpu_parking {
            CpuParkingMode::Auto => None,
            CpuParkingMode::Efficiency => {
                let ids = select_efficiency_cores(&topology);
                (!ids.is_empty()).then_some(ids.len())
            }
            CpuParkingMode::BackgroundCores => {
                let ids = select_background_cores(&topology);
                (!ids.is_empty()).then_some(ids.len())
            }
            CpuParkingMode::Custom => {
                let ids = select_custom_cores(&topology, &self.custom_cores);
                (!ids.is_empty()).then_some(ids.len())
            }
        }
    }

    /// Apply priority, power QoS, and core-parking preferences to the calling OS thread.
    ///
    /// Always best-effort: unsupported platforms or restricted process environments
    /// silently fall back to OS defaults.
    pub fn apply_to_current_thread(&self) {
        platform::apply_current_thread(self);
    }
}

/// Parse a user-supplied core specification such as `"4-7"`, `"8,10-15"`, or `"4 5 6"`.
///
/// Invalid tokens are ignored; valid indices are deduplicated and sorted ascending.
pub fn parse_core_list(spec: &str) -> Vec<usize> {
    let mut cores = Vec::new();
    for token in spec.split(|c: char| c == ',' || c == ';' || c.is_whitespace()) {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        if let Some((start_str, end_str)) = token.split_once('-') {
            let Ok(a) = start_str.trim().parse::<usize>() else {
                continue;
            };
            let Ok(b) = end_str.trim().parse::<usize>() else {
                continue;
            };
            let lo = a.min(b).min(MAX_CORE_INDEX - 1);
            let hi = a.max(b).min(MAX_CORE_INDEX - 1);
            for cpu in lo..=hi {
                cores.push(cpu);
            }
        } else if let Ok(cpu) = token.parse::<usize>() {
            if cpu < MAX_CORE_INDEX {
                cores.push(cpu);
            }
        }
    }
    cores.sort_unstable();
    cores.dedup();
    cores
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CpuEntry {
    pub id: u32,
    pub logical_index: usize,
    pub llc_index: u8,
    pub efficiency_class: u8,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuTopologyInfo {
    pub logical_cores: usize,
    pub efficiency_core_count: usize,
    pub has_efficiency_cores: bool,
    pub llc_group_count: usize,
    pub has_multiple_ccds: bool,
    pub background_cores: Vec<usize>,
    pub background_strategy: &'static str,
}

/// Inspect the host CPU topology for UI hints and diagnostics.
pub fn cpu_topology_info() -> CpuTopologyInfo {
    let entries = cpu_topology();
    topology_info_from_entries(&entries)
}

fn topology_info_from_entries(entries: &[CpuEntry]) -> CpuTopologyInfo {
    let logical_cores = entries.len();
    let eff = select_efficiency_cores(entries);
    let mut llcs: Vec<u8> = entries.iter().map(|e| e.llc_index).collect();
    llcs.sort_unstable();
    llcs.dedup();
    let llc_group_count = llcs.len().max(usize::from(logical_cores > 0));
    let has_efficiency_cores = !eff.is_empty();
    let has_multiple_ccds = llc_group_count > 1;
    let background_entries = select_background_cores(entries);
    let background_strategy = if has_efficiency_cores && background_entries.len() == eff.len() {
        "efficiency_cores"
    } else if has_multiple_ccds && !background_entries.is_empty() && !has_efficiency_cores {
        "secondary_ccd"
    } else if !background_entries.is_empty() {
        "upper_half"
    } else {
        "none"
    };
    CpuTopologyInfo {
        logical_cores,
        efficiency_core_count: eff.len(),
        has_efficiency_cores,
        llc_group_count,
        has_multiple_ccds,
        background_cores: background_entries.iter().map(|e| e.logical_index).collect(),
        background_strategy,
    }
}

fn select_efficiency_cores(entries: &[CpuEntry]) -> Vec<CpuEntry> {
    if entries.is_empty() {
        return Vec::new();
    }
    let min_eff = entries
        .iter()
        .map(|e| e.efficiency_class)
        .min()
        .unwrap_or(0);
    let max_eff = entries
        .iter()
        .map(|e| e.efficiency_class)
        .max()
        .unwrap_or(0);
    if min_eff >= max_eff {
        return Vec::new();
    }
    entries
        .iter()
        .copied()
        .filter(|e| e.efficiency_class < max_eff)
        .collect()
}

fn select_background_cores(entries: &[CpuEntry]) -> Vec<CpuEntry> {
    if entries.len() < MIN_CPUS_FOR_BACKGROUND_SPLIT {
        return Vec::new();
    }
    // 1. Prefer efficiency cores on hybrid CPUs (e.g. Intel P+E / Core Ultra).
    let eff = select_efficiency_cores(entries);
    if eff.len() >= 2 || (!eff.is_empty() && entries.len() <= 6) {
        return eff;
    }
    // 2. Prefer secondary LLC / CCD on dual-CCD CPUs (e.g. AMD Ryzen X3D where
    //    CCD0 holds 3D V-Cache for games).
    let first_llc = entries[0].llc_index;
    let secondary_llc: Vec<CpuEntry> = entries
        .iter()
        .copied()
        .filter(|e| e.llc_index != first_llc)
        .collect();
    if !secondary_llc.is_empty() {
        return secondary_llc;
    }
    // 3. Homogeneous single-CCD CPU: park on the upper half of logical CPUs,
    //    leaving cores 0..N/2 free for game/UI threads.
    let split = entries.len() / 2;
    entries[split..].to_vec()
}

fn select_custom_cores(entries: &[CpuEntry], requested: &[usize]) -> Vec<CpuEntry> {
    if requested.is_empty() {
        return Vec::new();
    }
    entries
        .iter()
        .copied()
        .filter(|e| requested.binary_search(&e.logical_index).is_ok())
        .collect()
}

fn cpu_topology() -> Vec<CpuEntry> {
    platform::query_topology()
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::ptr;
    use windows_sys::Win32::System::SystemInformation::{
        GetSystemCpuSetInformation, SYSTEM_CPU_SET_INFORMATION,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentThread, SetThreadAffinityMask, SetThreadInformation, SetThreadPriority,
        SetThreadSelectedCpuSets, THREAD_POWER_THROTTLING_CURRENT_VERSION,
        THREAD_POWER_THROTTLING_EXECUTION_SPEED, THREAD_POWER_THROTTLING_STATE,
        THREAD_PRIORITY_ABOVE_NORMAL, THREAD_PRIORITY_BELOW_NORMAL, THREAD_PRIORITY_HIGHEST,
        THREAD_PRIORITY_LOWEST, THREAD_PRIORITY_NORMAL, ThreadPowerThrottling,
    };

    static TOPOLOGY_CACHE: OnceLock<Vec<CpuEntry>> = OnceLock::new();

    pub(super) fn query_topology() -> Vec<CpuEntry> {
        TOPOLOGY_CACHE
            .get_or_init(query_windows_cpu_sets)
            .clone()
    }

    fn query_windows_cpu_sets() -> Vec<CpuEntry> {
        let mut needed: u32 = 0;
        unsafe {
            let _ = GetSystemCpuSetInformation(ptr::null_mut(), 0, &mut needed, ptr::null_mut(), 0);
        }
        if needed == 0 {
            return fallback_entries();
        }
        let mut buffer = vec![0u8; needed as usize];
        let mut returned: u32 = 0;
        let ok = unsafe {
            GetSystemCpuSetInformation(
                buffer.as_mut_ptr().cast::<SYSTEM_CPU_SET_INFORMATION>(),
                needed,
                &mut returned,
                ptr::null_mut(),
                0,
            )
        };
        if ok == 0 || returned == 0 {
            return fallback_entries();
        }

        let mut raw = Vec::new();
        let mut offset = 0usize;
        let limit = (returned as usize).min(buffer.len());
        while offset + size_of::<SYSTEM_CPU_SET_INFORMATION>() <= limit {
            let info = unsafe {
                ptr::read_unaligned(
                    buffer
                        .as_ptr()
                        .add(offset)
                        .cast::<SYSTEM_CPU_SET_INFORMATION>(),
                )
            };
            let entry_size = info.Size as usize;
            if entry_size == 0 || offset + entry_size > limit {
                break;
            }
            // CpuSetInformation == 0
            if info.Type == 0 {
                let cpu = unsafe { info.Anonymous.CpuSet };
                raw.push((
                    cpu.Group,
                    cpu.LogicalProcessorIndex,
                    cpu.Id,
                    cpu.LastLevelCacheIndex,
                    cpu.EfficiencyClass,
                ));
            }
            offset += entry_size;
        }
        if raw.is_empty() {
            return fallback_entries();
        }
        raw.sort_by_key(|&(group, lp, id, _, _)| (group, lp, id));
        raw.into_iter()
            .enumerate()
            .map(|(logical_index, (_, _, id, llc_index, efficiency_class))| CpuEntry {
                id,
                logical_index,
                llc_index,
                efficiency_class,
            })
            .collect()
    }

    fn fallback_entries() -> Vec<CpuEntry> {
        let count = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1);
        (0..count)
            .map(|i| CpuEntry {
                id: 0,
                logical_index: i,
                llc_index: 0,
                efficiency_class: 0,
            })
            .collect()
    }

    pub(super) fn apply_current_thread(policy: &ThreadPolicy) {
        let thread = unsafe { GetCurrentThread() };

        // 1. Thread priority
        let prio = match policy.priority {
            ThreadPriority::Low => THREAD_PRIORITY_LOWEST,
            ThreadPriority::BelowNormal => THREAD_PRIORITY_BELOW_NORMAL,
            ThreadPriority::Normal => THREAD_PRIORITY_NORMAL,
            ThreadPriority::AboveNormal => THREAD_PRIORITY_ABOVE_NORMAL,
            ThreadPriority::High => THREAD_PRIORITY_HIGHEST,
        };
        unsafe {
            let _ = SetThreadPriority(thread, prio);
        }

        // 2. EcoQoS / Efficiency Mode hint (explicitly cleared when not in Efficiency mode
        //    so switching back to Auto restores full thread clocks).
        let enable_eco = policy.cpu_parking == CpuParkingMode::Efficiency
            && !matches!(
                policy.priority,
                ThreadPriority::AboveNormal | ThreadPriority::High
            );
        let throttle = THREAD_POWER_THROTTLING_STATE {
            Version: THREAD_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask: THREAD_POWER_THROTTLING_EXECUTION_SPEED,
            StateMask: if enable_eco {
                THREAD_POWER_THROTTLING_EXECUTION_SPEED
            } else {
                0
            },
        };
        unsafe {
            let _ = SetThreadInformation(
                thread,
                ThreadPowerThrottling,
                (&throttle as *const THREAD_POWER_THROTTLING_STATE).cast::<c_void>(),
                size_of::<THREAD_POWER_THROTTLING_STATE>() as u32,
            );
        }

        // 3. Soft CPU Sets (preferred over hard SetThreadAffinityMask so Windows can
        //    prevent starvation/priority-inversion and handle >64 logical CPUs cleanly).
        let topology = query_topology();
        let selected = match policy.cpu_parking {
            CpuParkingMode::Auto => Vec::new(),
            CpuParkingMode::Efficiency => select_efficiency_cores(&topology),
            CpuParkingMode::BackgroundCores => select_background_cores(&topology),
            CpuParkingMode::Custom => select_custom_cores(&topology, &policy.custom_cores),
        };

        let ids: Vec<u32> = selected
            .iter()
            .filter_map(|entry| (entry.id != 0).then_some(entry.id))
            .collect();

        if ids.is_empty() {
            unsafe {
                let _ = SetThreadSelectedCpuSets(thread, ptr::null(), 0);
            }
            // Fallback to affinity mask only if CPU set IDs were unavailable on custom mode.
            if policy.cpu_parking == CpuParkingMode::Custom && !selected.is_empty() {
                let mut mask: usize = 0;
                for entry in &selected {
                    if entry.logical_index < usize::BITS as usize {
                        mask |= 1usize << entry.logical_index;
                    }
                }
                if mask != 0 {
                    unsafe {
                        let _ = SetThreadAffinityMask(thread, mask);
                    }
                }
            }
        } else {
            unsafe {
                let _ = SetThreadSelectedCpuSets(thread, ids.as_ptr(), ids.len() as u32);
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    pub(super) fn query_topology() -> Vec<CpuEntry> {
        let count = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1);
        (0..count)
            .map(|i| CpuEntry {
                id: i as u32,
                logical_index: i,
                llc_index: 0,
                efficiency_class: 0,
            })
            .collect()
    }

    pub(super) fn apply_current_thread(policy: &ThreadPolicy) {
        // 1. Thread niceness (unprivileged processes can always raise niceness).
        let nice = match policy.priority {
            ThreadPriority::Low => 15,
            ThreadPriority::BelowNormal => 10,
            ThreadPriority::Normal if policy.cpu_parking == CpuParkingMode::Efficiency => 10,
            ThreadPriority::Normal => 0,
            ThreadPriority::AboveNormal => -5,
            ThreadPriority::High => -10,
        };
        unsafe {
            let _ = libc::setpriority(libc::PRIO_PROCESS, 0, nice);
        }

        // 2. CPU affinity via sched_setaffinity.
        let topology = query_topology();
        let selected = match policy.cpu_parking {
            CpuParkingMode::Auto => topology,
            CpuParkingMode::Efficiency | CpuParkingMode::BackgroundCores => {
                let bg = select_background_cores(&topology);
                if bg.is_empty() { topology } else { bg }
            }
            CpuParkingMode::Custom => {
                let custom = select_custom_cores(&topology, &policy.custom_cores);
                if custom.is_empty() { topology } else { custom }
            }
        };
        unsafe {
            let mut set: libc::cpu_set_t = std::mem::zeroed();
            libc::CPU_ZERO(&mut set);
            let mut count = 0usize;
            for entry in selected {
                if entry.logical_index < libc::CPU_SETSIZE as usize {
                    libc::CPU_SET(entry.logical_index, &mut set);
                    count += 1;
                }
            }
            if count > 0 {
                let _ = libc::sched_setaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &set);
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    pub(super) fn query_topology() -> Vec<CpuEntry> {
        let count = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1);
        (0..count)
            .map(|i| CpuEntry {
                id: i as u32,
                logical_index: i,
                llc_index: 0,
                efficiency_class: 0,
            })
            .collect()
    }

    pub(super) fn apply_current_thread(policy: &ThreadPolicy) {
        // Apple Silicon parks QOS_CLASS_BACKGROUND / QOS_CLASS_UTILITY threads onto E-cores.
        let qos = match (policy.cpu_parking, policy.priority) {
            (CpuParkingMode::Efficiency, _) | (_, ThreadPriority::Low) => {
                libc::qos_class_t::QOS_CLASS_BACKGROUND
            }
            (CpuParkingMode::BackgroundCores, _) | (_, ThreadPriority::BelowNormal) => {
                libc::qos_class_t::QOS_CLASS_UTILITY
            }
            (_, ThreadPriority::AboveNormal | ThreadPriority::High) => {
                libc::qos_class_t::QOS_CLASS_USER_INITIATED
            }
            _ => libc::qos_class_t::QOS_CLASS_DEFAULT,
        };
        unsafe {
            let _ = libc::pthread_set_qos_class_self_np(qos, 0);
        }
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
mod platform {
    use super::*;

    pub(super) fn query_topology() -> Vec<CpuEntry> {
        let count = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1);
        (0..count)
            .map(|i| CpuEntry {
                id: i as u32,
                logical_index: i,
                llc_index: 0,
                efficiency_class: 0,
            })
            .collect()
    }

    pub(super) fn apply_current_thread(_policy: &ThreadPolicy) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_entry(index: usize, llc: u8, eff: u8) -> CpuEntry {
        CpuEntry {
            id: 256 + index as u32,
            logical_index: index,
            llc_index: llc,
            efficiency_class: eff,
        }
    }

    #[test]
    fn parse_core_list_handles_ranges_lists_and_duplicates() {
        assert_eq!(parse_core_list(""), Vec::<usize>::new());
        assert_eq!(parse_core_list("4-7"), vec![4, 5, 6, 7]);
        assert_eq!(parse_core_list("7-4, 4, 10; 12-13"), vec![4, 5, 6, 7, 10, 12, 13]);
        assert_eq!(parse_core_list("bad, 2-x, 3"), vec![3]);
        assert_eq!(parse_core_list("999999"), Vec::<usize>::new());
    }

    #[test]
    fn hybrid_cpu_selects_efficiency_cores_for_both_efficiency_and_background_modes() {
        // 8 P-core threads (eff=1) + 4 E-cores (eff=0)
        let mut entries: Vec<CpuEntry> = (0..8).map(|i| make_entry(i, 0, 1)).collect();
        entries.extend((8..12).map(|i| make_entry(i, 0, 0)));

        let eff: Vec<usize> = select_efficiency_cores(&entries)
            .into_iter()
            .map(|e| e.logical_index)
            .collect();
        let bg: Vec<usize> = select_background_cores(&entries)
            .into_iter()
            .map(|e| e.logical_index)
            .collect();
        assert_eq!(eff, vec![8, 9, 10, 11]);
        assert_eq!(bg, vec![8, 9, 10, 11]);

        let info = topology_info_from_entries(&entries);
        assert!(info.has_efficiency_cores);
        assert_eq!(info.efficiency_core_count, 4);
        assert_eq!(info.background_strategy, "efficiency_cores");
    }

    #[test]
    fn dual_ccd_cpu_parks_background_work_off_primary_ccd() {
        // 8 threads on CCD0 (llc=0), 8 threads on CCD1 (llc=1)
        let mut entries: Vec<CpuEntry> = (0..8).map(|i| make_entry(i, 0, 0)).collect();
        entries.extend((8..16).map(|i| make_entry(i, 1, 0)));

        assert!(select_efficiency_cores(&entries).is_empty());
        let bg: Vec<usize> = select_background_cores(&entries)
            .into_iter()
            .map(|e| e.logical_index)
            .collect();
        assert_eq!(bg, vec![8, 9, 10, 11, 12, 13, 14, 15]);

        let info = topology_info_from_entries(&entries);
        assert!(info.has_multiple_ccds);
        assert_eq!(info.llc_group_count, 2);
        assert_eq!(info.background_strategy, "secondary_ccd");
    }

    #[test]
    fn homogeneous_cpu_uses_upper_half_when_at_least_four_threads() {
        let entries: Vec<CpuEntry> = (0..8).map(|i| make_entry(i, 0, 0)).collect();
        let bg: Vec<usize> = select_background_cores(&entries)
            .into_iter()
            .map(|e| e.logical_index)
            .collect();
        assert_eq!(bg, vec![4, 5, 6, 7]);

        let tiny: Vec<CpuEntry> = (0..2).map(|i| make_entry(i, 0, 0)).collect();
        assert!(select_background_cores(&tiny).is_empty());
    }

    #[test]
    fn parses_thread_policy_from_ocr_settings_json() {
        let policy = ThreadPolicy::from_ocr_settings(&json!({
            "processPriority": "below_normal",
            "cpuParkingMode": "custom",
            "cpuParkingCores": "4-5, 7",
            "onnxMaxThreads": 2
        }));
        assert_eq!(policy.priority, ThreadPriority::BelowNormal);
        assert_eq!(policy.cpu_parking, CpuParkingMode::Custom);
        assert_eq!(policy.custom_cores, vec![4, 5, 7]);
        assert_eq!(policy.onnx_threads, Some(2));
        assert!(policy.needs_custom_thread_manager());
    }

    #[test]
    fn default_policy_does_not_require_custom_thread_manager() {
        let policy = ThreadPolicy::from_ocr_settings(&json!({}));
        assert_eq!(policy, ThreadPolicy::default());
        assert!(!policy.needs_custom_thread_manager());
    }

    #[test]
    fn apply_to_current_thread_is_safe_and_reversible() {
        let policy = ThreadPolicy {
            priority: ThreadPriority::BelowNormal,
            cpu_parking: CpuParkingMode::BackgroundCores,
            custom_cores: Vec::new(),
            onnx_threads: Some(2),
        };
        policy.apply_to_current_thread();
        ThreadPolicy::default().apply_to_current_thread();
    }
}
