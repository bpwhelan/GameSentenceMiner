//! Cut exact digital silence left by GSM process pauses when aligned with recorded pauses.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MIN_ZERO_RUN_SECONDS: f64 = 0.001;
pub const MIN_PAUSE_SECONDS: f64 = 0.05;
pub const DURATION_TOLERANCE_SECONDS: f64 = 0.3;
pub const MAX_LAG_SECONDS: f64 = 5.0;
pub const ALIGN_TOLERANCE_SECONDS: f64 = 0.25;
pub const MIN_LAG_RUN_SECONDS: f64 = 0.05;
pub const SUSPEND_STUTTER_WINDOW_SECONDS: f64 = 0.08;
pub const STUTTER_WINDOW_SECONDS: f64 = 0.15;
pub const MAX_STUTTER_RUN_SECONDS: f64 = 0.1;
pub const FADE_FLOOR_DBFS: f64 = -45.0;
pub const FADE_STEP_SECONDS: f64 = 0.0005;
pub const MAX_FADE_WIDEN_SECONDS: f64 = 0.02;
pub const CROSSFADE_SECONDS: f64 = 0.002;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ExpectedGap {
    pub offset: f64,
    pub duration: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AudioTimeline {
    pub cuts: Vec<(f64, f64)>,
}

impl AudioTimeline {
    pub fn is_empty(&self) -> bool {
        self.cuts.is_empty()
    }

    pub fn removed_seconds(&self) -> f64 {
        self.cuts.iter().map(|(s, e)| e - s).sum()
    }

    pub fn to_audio(&self, source_time: f64) -> f64 {
        let mut removed = 0.0;
        for &(start, end) in &self.cuts {
            if source_time <= start {
                break;
            }
            if source_time < end {
                return start - removed;
            }
            removed += end - start;
        }
        source_time - removed
    }

    pub fn to_source(&self, audio_time: f64, before_cut: bool) -> f64 {
        let mut removed = 0.0;
        for &(start, end) in &self.cuts {
            let splice_point = start - removed;
            if audio_time < splice_point || (before_cut && audio_time <= splice_point) {
                break;
            }
            removed += end - start;
        }
        audio_time + removed
    }
}

pub fn expected_gaps(
    pauses: &[(f64, f64)],
    recording_end: f64,
    recording_length: f64,
) -> Vec<ExpectedGap> {
    let recording_start = recording_end - recording_length;
    let mut sorted = pauses.to_vec();
    sorted.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    let mut gaps = Vec::new();
    for (s, e) in sorted {
        let start = s.max(recording_start) - recording_start;
        let end = e.min(recording_end) - recording_start;
        if end - start >= MIN_PAUSE_SECONDS {
            gaps.push(ExpectedGap {
                offset: start,
                duration: end - start,
            });
        }
    }
    gaps
}

fn zero_runs(samples: &[f32], channels: usize, min_len: usize) -> Vec<(usize, usize)> {
    if channels == 0 || samples.is_empty() {
        return Vec::new();
    }
    let frames = samples.len() / channels;
    let mut runs = Vec::new();
    let mut run_start: Option<usize> = None;
    for f in 0..frames {
        let slice = &samples[f * channels..(f + 1) * channels];
        let silent = slice.iter().all(|&v| v == 0.0);
        match (silent, run_start) {
            (true, None) => run_start = Some(f),
            (false, Some(s)) => {
                if f - s >= min_len {
                    runs.push((s, f));
                }
                run_start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = run_start {
        if frames - s >= min_len {
            runs.push((s, frames));
        }
    }
    runs
}

fn widen(samples: &[f32], channels: usize, sr: usize, start: usize, end: usize) -> (usize, usize) {
    let frames = samples.len() / channels;
    let step = ((sr as f64 * FADE_STEP_SECONDS) as usize).max(1);
    let limit = (sr as f64 * MAX_FADE_WIDEN_SECONDS) as usize;
    let floor = 10f64.powf(FADE_FLOOR_DBFS / 20.0);

    let quiet = |lo: usize, hi: usize| -> bool {
        let slice = &samples[lo * channels..hi * channels];
        if slice.is_empty() {
            return true;
        }
        let sum_sq: f64 = slice.iter().map(|&v| (v as f64) * (v as f64)).sum();
        (sum_sq / slice.len() as f64).sqrt() < floor
    };

    let mut lo = start;
    while lo >= step && start - (lo - step) <= limit && quiet(lo - step, lo) {
        lo -= step;
    }
    let mut hi = end;
    while hi + step <= frames && (hi + step) - end <= limit && quiet(hi, hi + step) {
        hi += step;
    }
    (lo, hi)
}

fn bisect_right_f64(slice: &[f64], target: f64) -> usize {
    slice.partition_point(|&x| x <= target)
}

fn fitting_run(starts: &[f64], ends: &[f64], gap: ExpectedGap, lag: f64) -> Option<usize> {
    let expected_start = gap.offset + lag;
    let expected_end = expected_start + gap.duration;
    let min_overlap = (gap.duration - DURATION_TOLERANCE_SECONDS).max(gap.duration / 2.0);
    let mut idx = bisect_right_f64(starts, expected_start + ALIGN_TOLERANCE_SECONDS);
    while idx > 0 {
        idx -= 1;
        if ends[idx] < expected_start - ALIGN_TOLERANCE_SECONDS {
            break;
        }
        if starts[idx] - ALIGN_TOLERANCE_SECONDS <= expected_start
            && expected_end <= ends[idx] + ALIGN_TOLERANCE_SECONDS
            && ends[idx].min(expected_end) - starts[idx].max(expected_start) >= min_overlap
        {
            return Some(idx);
        }
    }
    None
}

fn estimate_lag(starts: &[f64], ends: &[f64], gaps: &[ExpectedGap]) -> Option<f64> {
    let mut candidates = BTreeSet::<i64>::new();
    candidates.insert(0);
    for gap in gaps {
        let lo = bisect_right_f64(starts, gap.offset - MAX_LAG_SECONDS - ALIGN_TOLERANCE_SECONDS);
        let hi = bisect_right_f64(starts, gap.offset + MAX_LAG_SECONDS);
        for (&run_start, &run_end) in starts[lo..hi].iter().zip(&ends[lo..hi]) {
            if run_end - run_start < MIN_LAG_RUN_SECONDS {
                continue;
            }
            for lag in [run_start - gap.offset, run_end - (gap.offset + gap.duration)] {
                if lag.abs() <= MAX_LAG_SECONDS {
                    candidates.insert((lag * 1000.0).round() as i64);
                }
            }
        }
    }
    let mut ordered: Vec<f64> = candidates.into_iter().map(|m| m as f64 / 1000.0).collect();
    ordered.sort_by(|a, b| a.abs().total_cmp(&b.abs()).then(a.total_cmp(b)));

    let mut best: Option<f64> = None;
    let mut best_weight = 0.0;
    for lag in ordered {
        let weight: f64 = gaps
            .iter()
            .filter(|g| fitting_run(starts, ends, **g, lag).is_some())
            .map(|g| g.duration)
            .sum();
        if weight > best_weight {
            best = Some(lag);
            best_weight = weight;
        }
    }
    best
}

pub fn find_pause_cuts(
    samples: &[f32],
    channels: usize,
    sr: usize,
    gaps: &[ExpectedGap],
) -> Vec<(usize, usize)> {
    let min_len = ((sr as f64 * MIN_ZERO_RUN_SECONDS) as usize).max(1);
    let runs = zero_runs(samples, channels, min_len);
    if gaps.is_empty() || runs.is_empty() {
        return Vec::new();
    }
    let starts: Vec<f64> = runs.iter().map(|&(s, _)| s as f64 / sr as f64).collect();
    let ends: Vec<f64> = runs.iter().map(|&(_, e)| e as f64 / sr as f64).collect();
    let Some(lag) = estimate_lag(&starts, &ends, gaps) else {
        return Vec::new();
    };

    let mut claims: HashMap<usize, Vec<ExpectedGap>> = HashMap::new();
    for &gap in gaps {
        if let Some(i) = fitting_run(&starts, &ends, gap, lag) {
            claims.entry(i).or_default().push(gap);
        }
    }

    let max_stutter = (sr as f64 * MAX_STUTTER_RUN_SECONDS) as usize;
    let suspend_window = (sr as f64 * SUSPEND_STUTTER_WINDOW_SECONDS) as usize;
    let stutter_window = (sr as f64 * STUTTER_WINDOW_SECONDS) as usize;
    let mut used: HashSet<usize> = claims.keys().copied().collect();
    let mut cuts = Vec::new();

    for (i, claimed) in claims {
        let (start, end) = runs[i];
        let max_end = claimed
            .iter()
            .map(|g| g.offset + g.duration)
            .fold(f64::NEG_INFINITY, f64::max);
        let paused = max_end - claimed[0].offset;
        if (end - start) as f64 / sr as f64 > paused + DURATION_TOLERANCE_SECONDS {
            for gap in claimed {
                let length = (gap.duration * sr as f64) as usize;
                let desired = ((gap.offset + lag) * sr as f64).max(0.0) as usize;
                let cut_start = desired.max(start).min(end.saturating_sub(length));
                cuts.push((cut_start, cut_start + length));
            }
            continue;
        }
        cuts.push(widen(samples, channels, sr, start, end));
        let first = runs.partition_point(|&(_, e)| e < start.saturating_sub(suspend_window));
        let last = runs.partition_point(|&(s, _)| s <= end.saturating_add(stutter_window));
        for (j, &(s_start, s_end)) in runs.iter().enumerate().take(last).skip(first) {
            if !used.contains(&j) && s_end - s_start <= max_stutter {
                used.insert(j);
                cuts.push(widen(samples, channels, sr, s_start, s_end));
            }
        }
    }

    cuts.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in cuts {
        if let Some(last) = merged.last_mut() {
            if start <= last.1 {
                last.1 = last.1.max(end);
                continue;
            }
        }
        merged.push((start, end));
    }
    merged
}

pub fn splice(
    samples: &[f32],
    channels: usize,
    sr: usize,
    cuts: &[(usize, usize)],
) -> (Vec<f32>, AudioTimeline) {
    if cuts.is_empty() || channels == 0 {
        return (samples.to_vec(), AudioTimeline::default());
    }
    let frames = samples.len() / channels;
    let fade = ((sr as f64 * CROSSFADE_SECONDS) as usize).max(1);
    let mut bounds = Vec::with_capacity(cuts.len() * 2 + 2);
    bounds.push(0usize);
    for &(s, e) in cuts {
        bounds.push(s.min(frames));
        bounds.push(e.min(frames));
    }
    bounds.push(frames);

    // Precompute crossfade weights (cos, sin) once for `fade` frames.
    let mut fade_weights = Vec::with_capacity(fade);
    for k in 0..fade {
        let theta = if fade > 1 {
            (k as f32) * std::f32::consts::FRAC_PI_2 / ((fade - 1) as f32)
        } else {
            0.0
        };
        fade_weights.push((theta.cos(), theta.sin()));
    }

    // Single-pass assembly directly into one pre-allocated output buffer (eliminating 2 extra
    // full-buffer allocations and copies).
    let kept_frames: usize = bounds
        .chunks_exact(2)
        .map(|pair| pair[1].saturating_sub(pair[0]))
        .sum();
    let mut flat = Vec::with_capacity(kept_frames * channels);
    let first_lo = bounds[0] * channels;
    let first_hi = bounds[1] * channels;
    flat.extend_from_slice(&samples[first_lo..first_hi]);

    let mut timeline_cuts = Vec::with_capacity(cuts.len());
    for (&(start, end), pair) in cuts.iter().zip(bounds[2..].chunks_exact(2)) {
        let piece_start_frame = pair[0];
        let piece_end_frame = pair[1];
        let next_frames = piece_end_frame.saturating_sub(piece_start_frame);
        let prev_frames = flat.len() / channels;

        if prev_frames >= fade && next_frames >= fade {
            let tail_start = (prev_frames - fade) * channels;
            let piece_base = piece_start_frame * channels;
            for (k, &(c, s)) in fade_weights.iter().enumerate() {
                let flat_idx = tail_start + k * channels;
                let piece_idx = piece_base + k * channels;
                for ch in 0..channels {
                    flat[flat_idx + ch] = flat[flat_idx + ch] * c + samples[piece_idx + ch] * s;
                }
            }
            let rest_lo = (piece_start_frame + fade) * channels;
            let rest_hi = piece_end_frame * channels;
            flat.extend_from_slice(&samples[rest_lo..rest_hi]);
            timeline_cuts.push((
                (start as f64 - fade as f64 / 2.0) / sr as f64,
                (end as f64 + fade as f64 / 2.0) / sr as f64,
            ));
        } else {
            let lo = piece_start_frame * channels;
            let hi = piece_end_frame * channels;
            flat.extend_from_slice(&samples[lo..hi]);
            timeline_cuts.push((start as f64 / sr as f64, end as f64 / sr as f64));
        }
    }

    (flat, AudioTimeline { cuts: timeline_cuts })
}

pub fn remove_pause_gaps(
    samples: &[f32],
    channels: usize,
    sr: usize,
    gaps: &[ExpectedGap],
) -> (Vec<f32>, AudioTimeline) {
    let cuts = find_pause_cuts(samples, channels, sr, gaps);
    splice(samples, channels, sr, &cuts)
}

#[derive(Default)]
struct CachedDiskPauses {
    stamp: Option<(u64, u128)>,
    pauses: Vec<(f64, f64)>,
}

/// Thread-safe pause history reader (disk `<app_dir>/process_pause_history.json` + remembered clip pauses).
pub struct PauseHistory {
    history_file: PathBuf,
    remembered: Mutex<Vec<(f64, f64)>>,
    disk_cache: Mutex<CachedDiskPauses>,
}

impl PauseHistory {
    pub fn new(app_dir: &Path) -> Self {
        Self {
            history_file: app_dir.join("process_pause_history.json"),
            remembered: Mutex::new(Vec::new()),
            disk_cache: Mutex::new(CachedDiskPauses::default()),
        }
    }

    pub fn remember_pauses(&self, spans: &[(f64, f64)]) {
        if spans.is_empty() {
            return;
        }
        if let Ok(mut guard) = self.remembered.lock() {
            for &span in spans {
                if !guard.contains(&span) {
                    guard.push(span);
                }
            }
        }
    }

    pub fn get_pauses_between(&self, start: f64, end: f64) -> Vec<(f64, f64)> {
        let mut all = self.read_disk_pauses();
        if let Ok(guard) = self.remembered.lock() {
            all.extend(guard.iter().copied());
        }
        all.retain(|&(s, e)| e > start && s < end);
        all.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
        all.dedup();
        all
    }

    fn read_disk_pauses(&self) -> Vec<(f64, f64)> {
        let Ok(meta) = std::fs::metadata(&self.history_file) else {
            return Vec::new();
        };
        let modified_ns = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let stamp = (meta.len(), modified_ns);
        if let Ok(guard) = self.disk_cache.lock() {
            if guard.stamp == Some(stamp) {
                return guard.pauses.clone();
            }
        }
        let Ok(bytes) = std::fs::read(&self.history_file) else {
            return Vec::new();
        };
        let Ok(val) = serde_json::from_slice::<Value>(&bytes) else {
            return Vec::new();
        };
        let parsed: Vec<(f64, f64)> = val
            .get("pauses")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        let pair = item.as_array()?;
                        let s = pair.first()?.as_f64()?;
                        let e = pair.get(1)?.as_f64()?;
                        Some((s, e))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if let Ok(mut guard) = self.disk_cache.lock() {
            guard.stamp = Some(stamp);
            guard.pauses = parsed.clone();
        }
        parsed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_aligned_pause_and_maps_timeline() {
        let sr = 1000;
        let mut samples = vec![0.5f32; sr * 4]; // 4s mono tone
        // Insert 1s exact digital silence at [1.5s, 2.5s]
        for s in &mut samples[1500..2500] {
            *s = 0.0;
        }
        let gaps = vec![ExpectedGap {
            offset: 1.4,
            duration: 1.0,
        }];
        let (cleaned, timeline) = remove_pause_gaps(&samples, 1, sr, &gaps);
        assert!(!timeline.is_empty());
        assert!((timeline.removed_seconds() - 1.0).abs() < 0.01);
        assert!((cleaned.len() as f64 / sr as f64 - 3.0).abs() < 0.02);
        assert!((timeline.to_audio(3.0) - 2.0).abs() < 0.01);
        assert!((timeline.to_source(2.0, false) - 3.0).abs() < 0.01);
    }
}
