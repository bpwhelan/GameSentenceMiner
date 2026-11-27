//! Native ONNX Voice Activity Detection: FireRedVAD (Kaldi 80-bin Fbank + CMVN) and Silero VAD v6.
//! Whisper VAD has been retired in the Rust mining stack.
use crate::config::{ProfileConfig, FIRERED, OFF, SILERO};
use crate::ffmpeg::MediaTools;
use crate::text::GameLine;
use ort::session::Session;
use ort::value::Tensor;
use serde::{Deserialize, Serialize};
use std::f64::consts::PI;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const VAD_IDLE_UNLOAD_AFTER: Duration = Duration::from_secs(3 * 60);

const FIRERED_FRAME_LENGTH_S: f64 = 0.025;
const FIRERED_FRAME_SHIFT_S: f64 = 0.010;
const CLEAN_PREROLL_WINDOW_SECONDS: f64 = 0.03;
const CLEAN_PREROLL_MIN_LEAD_SECONDS: f64 = 0.06;
const CLEAN_PREROLL_MAX_QUIET_RMS: f32 = 0.01;
const CLEAN_PREROLL_MIN_RESIDUE_RMS: f32 = 0.01;
const CLEAN_PREROLL_CONTRAST_RATIO: f32 = 3.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadResult {
    pub success: bool,
    pub start: f64,
    pub end: f64,
    pub model: String,
    #[serde(default)]
    pub segments: Vec<Segment>,
    #[serde(skip)]
    pub condensed_ranges: Vec<[f64; 2]>,
    #[serde(default)]
    pub output_audio: String,
    #[serde(default)]
    pub trimmed_audio_path: String,
    #[serde(default)]
    pub tts_used: bool,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub voice_detected: bool,
}

impl VadResult {
    pub fn new(success: bool, start: f64, end: f64, model: impl Into<String>) -> Self {
        let model = model.into();
        let voice_detected =
            success && !model.is_empty() && model != "No VAD" && model != OFF;
        Self {
            success,
            start,
            end,
            model,
            segments: Vec::new(),
            condensed_ranges: Vec::new(),
            output_audio: String::new(),
            trimmed_audio_path: String::new(),
            tts_used: false,
            error: String::new(),
            voice_detected,
        }
    }
}

/// Read 16 kHz PCM-16 WAV into mono `i16` samples (matching `_load_pcm16_mono_audio_from_wav`).
pub fn load_pcm16_mono_wav(path: &Path) -> Result<Vec<i16>, String> {
    let data = std::fs::read(path).map_err(|e| format!("Failed to read wav {}: {e}", path.display()))?;
    if data.len() < 44 || &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return Err(format!("Invalid WAV header in '{}'", path.display()));
    }
    let mut pos = 12usize;
    let mut channels = 0u16;
    let mut sample_rate = 0u32;
    let mut bits_per_sample = 0u16;
    let mut pcm_bytes: Option<&[u8]> = None;

    while pos + 8 <= data.len() {
        let id = &data[pos..pos + 4];
        let size = u32::from_le_bytes([data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]]) as usize;
        let body = pos + 8;
        let end = (body + size).min(data.len());
        if id == b"fmt " && end - body >= 16 {
            channels = u16::from_le_bytes([data[body + 2], data[body + 3]]);
            sample_rate = u32::from_le_bytes([
                data[body + 4],
                data[body + 5],
                data[body + 6],
                data[body + 7],
            ]);
            bits_per_sample = u16::from_le_bytes([data[body + 14], data[body + 15]]);
        } else if id == b"data" {
            pcm_bytes = Some(&data[body..end]);
            break;
        }
        pos = body + size + (size % 2);
    }

    if sample_rate != 16000 {
        return Err(format!(
            "VAD expected 16 kHz audio, got {sample_rate} Hz from '{}'",
            path.display()
        ));
    }
    if bits_per_sample != 16 {
        return Err(format!(
            "VAD expected 16-bit PCM audio, got {bits_per_sample}-bit from '{}'",
            path.display()
        ));
    }
    let raw = pcm_bytes.ok_or_else(|| format!("WAV '{}' has no data chunk", path.display()))?;
    if raw.len() < 2 || channels == 0 {
        return Err(format!("WAV '{}' contains no samples", path.display()));
    }

    let sample_count = raw.len() / 2;
    if channels == 1 {
        let mut out = Vec::with_capacity(sample_count);
        for chunk in raw.chunks_exact(2) {
            out.push(i16::from_le_bytes([chunk[0], chunk[1]]));
        }
        Ok(out)
    } else {
        let ch = channels as usize;
        let frames = sample_count / ch;
        let mut out = Vec::with_capacity(frames);
        for f in 0..frames {
            let mut sum = 0i32;
            for c in 0..ch {
                let off = (f * ch + c) * 2;
                sum += i16::from_le_bytes([raw[off], raw[off + 1]]) as i32;
            }
            out.push((sum / ch as i32) as i16);
        }
        Ok(out)
    }
}

pub fn select_clean_preroll_start(
    audio: &[f32],
    sample_rate: usize,
    requested_start: f64,
    detected_start: f64,
) -> f64 {
    let requested_start = requested_start.max(0.0);
    let detected_start = detected_start.max(requested_start);
    let window_samples = ((CLEAN_PREROLL_WINDOW_SECONDS * sample_rate as f64).round() as usize).max(1);
    let hop_samples = ((0.01 * sample_rate as f64).round() as usize).max(1);
    let requested_sample = (requested_start * sample_rate as f64).round().max(0.0) as usize;
    let lead_end = ((detected_start - CLEAN_PREROLL_MIN_LEAD_SECONDS) * sample_rate as f64).round() as isize
        - window_samples as isize;
    let max_valid = audio.len() as isize - window_samples as isize;
    let latest_window_start = max_valid.min(lead_end);
    if latest_window_start <= requested_sample as isize {
        return requested_start;
    }
    let latest = latest_window_start as usize;
    let mut window_starts: Vec<usize> = (requested_sample..=latest).step_by(hop_samples).collect();
    if window_starts.last().copied() != Some(latest) {
        window_starts.push(latest);
    }

    let mut rms_values = Vec::with_capacity(window_starts.len());
    for &start in &window_starts {
        let slice = &audio[start..start + window_samples];
        let sum_sq: f32 = slice.iter().map(|&x| x * x).sum();
        rms_values.push((sum_sq / slice.len() as f32).sqrt());
    }
    let mut quietest_idx = 0usize;
    let mut quiet_rms = rms_values[0];
    for (idx, &v) in rms_values.iter().enumerate().skip(1) {
        if v < quiet_rms {
            quiet_rms = v;
            quietest_idx = idx;
        }
    }
    if quietest_idx == 0 {
        return requested_start;
    }
    let preceding_peak = rms_values[..quietest_idx]
        .iter()
        .copied()
        .fold(0.0f32, f32::max);
    if quiet_rms > CLEAN_PREROLL_MAX_QUIET_RMS
        || preceding_peak < CLEAN_PREROLL_MIN_RESIDUE_RMS
        || preceding_peak < quiet_rms * CLEAN_PREROLL_CONTRAST_RATIO
    {
        return requested_start;
    }
    window_starts[quietest_idx] as f64 / sample_rate as f64
}

// --- Kaldi Binary CMVN Loader & 80-bin Mel Fbank Extractor for FireRedVAD ---

pub fn load_firered_cmvn(path: &Path) -> Result<(Vec<f32>, Vec<f32>), String> {
    let data = std::fs::read(path).map_err(|e| format!("Reading CMVN {}: {e}", path.display()))?;
    if data.len() < 4 || &data[0..2] != b"\0B" {
        return Err(format!("Invalid FireRedVAD CMVN file '{}': expected Kaldi binary marker", path.display()));
    }
    let mut pos = 2usize;
    let token_start = pos;
    while pos < data.len() && data[pos] != b' ' {
        pos += 1;
    }
    if pos >= data.len() {
        return Err("Invalid FireRedVAD CMVN file: missing matrix token".into());
    }
    pos += 1; // include trailing space
    let token = &data[token_start..pos];
    let item_size = match token {
        b"DM " => 8usize,
        b"FM " => 4usize,
        _ => return Err(format!("Unsupported CMVN matrix token {:?}", String::from_utf8_lossy(token))),
    };

    let read_i32 = |pos: &mut usize| -> Result<usize, String> {
        if *pos + 5 > data.len() {
            return Err("Truncated CMVN header".into());
        }
        let sz = data[*pos];
        *pos += 1;
        if sz != 4 {
            return Err(format!("Unsupported CMVN int size {sz}"));
        }
        let val = i32::from_le_bytes([data[*pos], data[*pos + 1], data[*pos + 2], data[*pos + 3]]);
        *pos += 4;
        usize::try_from(val).map_err(|_| "Negative CMVN dimension".into())
    };

    let rows = read_i32(&mut pos)?;
    let cols = read_i32(&mut pos)?;
    if rows != 2 || cols < 2 {
        return Err(format!("Expected 2-row CMVN stats matrix, got {rows}x{cols}"));
    }
    let expected_bytes = rows * cols * item_size;
    if pos + expected_bytes > data.len() {
        return Err("Truncated CMVN matrix data".into());
    }
    let mut stats = vec![0.0f64; rows * cols];
    for i in 0..rows * cols {
        let off = pos + i * item_size;
        stats[i] = if item_size == 8 {
            f64::from_le_bytes(data[off..off + 8].try_into().unwrap())
        } else {
            f32::from_le_bytes(data[off..off + 4].try_into().unwrap()) as f64
        };
    }

    let dim = cols - 1;
    let count = stats[dim];
    if count < 1.0 {
        return Err(format!("Invalid CMVN frame count {count}"));
    }
    let mut means = Vec::with_capacity(dim);
    let mut inv_std = Vec::with_capacity(dim);
    for d in 0..dim {
        let mean = stats[d] / count;
        let var = (stats[cols + d] / count) - mean * mean;
        means.push(mean as f32);
        inv_std.push((1.0 / var.max(1e-20).sqrt()) as f32);
    }
    Ok((means, inv_std))
}

struct KaldiFbank {
    means: Vec<f32>,
    inv_std: Vec<f32>,
    povey_window: Vec<f32>,
    mel_bins: Vec<(usize, Vec<f32>)>,
}

impl KaldiFbank {
    fn new(cmvn_path: &Path) -> Result<Self, String> {
        let (means, inv_std) = load_firered_cmvn(cmvn_path)?;
        let window_size = 400usize; // 25ms @ 16kHz
        let mut povey_window = Vec::with_capacity(window_size);
        let a = 2.0 * PI / ((window_size - 1) as f64);
        for i in 0..window_size {
            let hann = 0.5 - 0.5 * (a * i as f64).cos();
            povey_window.push(hann.powf(0.85) as f32);
        }

        // Kaldi Mel filterbank: 80 bins, 20Hz..8000Hz, 512-pt FFT @ 16kHz.
        let num_bins = 80usize;
        let samp_freq = 16000.0f64;
        let fft_size = 512usize;
        let num_fft_bins = fft_size / 2;
        let fft_bin_width = samp_freq / fft_size as f64;
        let mel = |f: f64| 1127.0 * (1.0 + f / 700.0).ln();
        let mel_low = mel(20.0);
        let mel_high = mel(samp_freq / 2.0);
        let mel_delta = (mel_high - mel_low) / (num_bins + 1) as f64;

        let mut mel_bins = Vec::with_capacity(num_bins);
        for bin in 0..num_bins {
            let left_mel = mel_low + bin as f64 * mel_delta;
            let center_mel = mel_low + (bin + 1) as f64 * mel_delta;
            let right_mel = mel_low + (bin + 2) as f64 * mel_delta;
            let mut first_index = None;
            let mut last_index = 0usize;
            let mut weights = vec![0.0f32; num_fft_bins];
            for i in 0..num_fft_bins {
                let freq = fft_bin_width * i as f64;
                let m = mel(freq);
                if m > left_mel && m < right_mel {
                    let w = if m <= center_mel {
                        (m - left_mel) / (center_mel - left_mel)
                    } else {
                        (right_mel - m) / (right_mel - center_mel)
                    };
                    weights[i] = w as f32;
                    if first_index.is_none() {
                        first_index = Some(i);
                    }
                    last_index = i;
                }
            }
            if let Some(first) = first_index {
                mel_bins.push((first, weights[first..=last_index].to_vec()));
            } else {
                mel_bins.push((0, Vec::new()));
            }
        }

        Ok(Self {
            means,
            inv_std,
            povey_window,
            mel_bins,
        })
    }

    /// Extract CMVN-normalized `[num_frames, 80]` f32 features from 16kHz PCM-16 mono audio.
    fn extract(&self, pcm: &[i16]) -> (Vec<f32>, usize, f64) {
        let duration = pcm.len() as f64 / 16000.0;
        let frame_len = 400usize;
        let frame_shift = 160usize;
        if pcm.len() < frame_len {
            return (Vec::new(), 0, duration);
        }
        let num_frames = 1 + (pcm.len() - frame_len) / frame_shift;
        let mut features = Vec::with_capacity(num_frames * 80);
        let mut buf_re = [0.0f32; 512];
        let mut buf_im = [0.0f32; 512];
        let mut power = [0.0f32; 257];

        for frame_idx in 0..num_frames {
            let offset = frame_idx * frame_shift;
            // 1. Copy frame as f32 (Kaldi uses raw int16 numeric scale [-32768, 32767])
            let mut mean = 0.0f64;
            for i in 0..frame_len {
                let v = pcm[offset + i] as f32;
                buf_re[i] = v;
                mean += v as f64;
            }
            // 2. Remove DC offset
            let mean_f32 = (mean / frame_len as f64) as f32;
            for v in buf_re.iter_mut().take(frame_len) {
                *v -= mean_f32;
            }
            // 3. Preemphasis (0.97)
            for i in (1..frame_len).rev() {
                buf_re[i] -= 0.97 * buf_re[i - 1];
            }
            buf_re[0] *= 1.0 - 0.97;
            // 4. Povey window + zero-pad to 512
            for i in 0..frame_len {
                buf_re[i] *= self.povey_window[i];
            }
            for i in frame_len..512 {
                buf_re[i] = 0.0;
            }
            buf_im.fill(0.0);

            // 5. 512-point radix-2 FFT
            fft_512(&mut buf_re, &mut buf_im);
            for k in 0..=256 {
                power[k] = buf_re[k] * buf_re[k] + buf_im[k] * buf_im[k];
            }

            // 6. 80 Mel bins -> log energy -> CMVN
            for (bin_idx, (first, weights)) in self.mel_bins.iter().enumerate() {
                let mut energy = 0.0f32;
                for (j, &w) in weights.iter().enumerate() {
                    energy += power[first + j] * w;
                }
                let log_e = energy.max(f32::EPSILON).ln();
                let norm = (log_e - self.means[bin_idx]) * self.inv_std[bin_idx];
                features.push(norm);
            }
        }
        (features, num_frames, duration)
    }
}

struct Fft512Tables {
    bit_rev: [u16; 512],
    /// Twiddle factors for stages len = 2, 4, 8, ..., 512 (total 1 + 2 + 4 + ... + 256 = 511 entries).
    twiddles: Vec<(f32, f32)>,
}

fn fft_512_tables() -> &'static Fft512Tables {
    static TABLES: OnceLock<Fft512Tables> = OnceLock::new();
    TABLES.get_or_init(|| {
        let n = 512usize;
        let mut bit_rev = [0u16; 512];
        let mut j = 0usize;
        for i in 1..n {
            let mut bit = n >> 1;
            while j & bit != 0 {
                j ^= bit;
                bit >>= 1;
            }
            j ^= bit;
            bit_rev[i] = j as u16;
        }
        let mut twiddles = Vec::with_capacity(511);
        let mut len = 2usize;
        while len <= n {
            let half = len >> 1;
            let ang = -2.0 * PI / (len as f64);
            for k in 0..half {
                let theta = ang * (k as f64);
                twiddles.push((theta.cos() as f32, theta.sin() as f32));
            }
            len <<= 1;
        }
        Fft512Tables { bit_rev, twiddles }
    })
}

/// Fast in-place 512-point radix-2 Cooley-Tukey FFT using precomputed bit-reversal & twiddle tables.
fn fft_512(re: &mut [f32; 512], im: &mut [f32; 512]) {
    let tables = fft_512_tables();
    for i in 1..512 {
        let j = tables.bit_rev[i] as usize;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut tw_offset = 0usize;
    let mut len = 2usize;
    while len <= 512 {
        let half = len >> 1;
        let stage_tw = &tables.twiddles[tw_offset..tw_offset + half];
        let mut start = 0usize;
        while start < 512 {
            for (k, &(w_re, w_im)) in stage_tw.iter().enumerate() {
                let idx0 = start + k;
                let idx1 = idx0 + half;
                let u_re = re[idx0];
                let u_im = im[idx0];
                let v_re = re[idx1];
                let v_im = im[idx1];
                let t_re = v_re * w_re - v_im * w_im;
                let t_im = v_re * w_im + v_im * w_re;
                re[idx0] = u_re + t_re;
                im[idx0] = u_im + t_im;
                re[idx1] = u_re - t_re;
                im[idx1] = u_im - t_im;
            }
            start += len;
        }
        tw_offset += half;
        len <<= 1;
    }
}

// --- FireRedVAD Postprocessor (exact port of FireRedVADPostprocessor) ---

#[derive(Debug, Clone)]
pub struct FireRedPostprocessor {
    pub smooth_window_size: usize,
    pub speech_threshold: f32,
    pub min_speech_frame: usize,
    pub max_speech_frame: usize,
    pub min_silence_frame: usize,
    pub merge_silence_frame: usize,
    pub extend_speech_frame: usize,
}

impl FireRedPostprocessor {
    pub fn from_config(cfg: &ProfileConfig) -> Self {
        Self {
            smooth_window_size: cfg.vad.firered_smooth_window_size.max(1),
            speech_threshold: cfg.vad.firered_speech_threshold,
            min_speech_frame: cfg.vad.firered_min_speech_frame,
            max_speech_frame: cfg.vad.firered_max_speech_frame,
            min_silence_frame: cfg.vad.firered_min_silence_frame,
            merge_silence_frame: cfg.vad.firered_merge_silence_frame,
            extend_speech_frame: cfg.vad.firered_extend_speech_frame,
        }
    }

    pub fn process(&self, raw_probs: &[f32]) -> Vec<u8> {
        if raw_probs.is_empty() {
            return Vec::new();
        }
        let smoothed = self.smooth_prob(raw_probs);
        let binary: Vec<u8> = smoothed
            .iter()
            .map(|&p| u8::from(p >= self.speech_threshold))
            .collect();
        let d = self.state_machine(&binary);
        let d = self.fix_smooth_window_start(&d);
        let d = self.merge_short_silence(&d);
        let d = self.extend_speech(&d);
        self.split_long_speech(&d, raw_probs)
    }

    pub fn decision_to_segments(&self, decisions: &[u8], wav_duration: Option<f64>) -> Vec<Segment> {
        let mut segments = Vec::new();
        let mut speech_start: Option<usize> = None;
        for (idx, &dec) in decisions.iter().enumerate() {
            if dec == 1 && speech_start.is_none() {
                speech_start = Some(idx);
            } else if dec == 0 {
                if let Some(s) = speech_start.take() {
                    let start = ((s as f64 * FIRERED_FRAME_SHIFT_S) * 1000.0).round() / 1000.0;
                    let end = ((idx as f64 * FIRERED_FRAME_SHIFT_S) * 1000.0).round() / 1000.0;
                    if end > start {
                        segments.push(Segment { start, end });
                    }
                }
            }
        }
        if let Some(s) = speech_start {
            let mut end_time =
                decisions.len() as f64 * FIRERED_FRAME_SHIFT_S + FIRERED_FRAME_LENGTH_S;
            if let Some(dur) = wav_duration {
                end_time = end_time.min(dur);
            }
            let start = ((s as f64 * FIRERED_FRAME_SHIFT_S) * 1000.0).round() / 1000.0;
            let end = (end_time * 1000.0).round() / 1000.0;
            if end > start {
                segments.push(Segment { start, end });
            }
        }
        segments
    }

    fn smooth_prob(&self, probs: &[f32]) -> Vec<f32> {
        let w = self.smooth_window_size;
        if w <= 1 {
            return probs.to_vec();
        }
        let mut out = Vec::with_capacity(probs.len());
        let mut running = 0.0f64;
        for i in 0..probs.len() {
            running += probs[i] as f64;
            if i >= w {
                running -= probs[i - w] as f64;
                out.push((running / w as f64) as f32);
            } else {
                out.push((running / (i + 1) as f64) as f32);
            }
        }
        out
    }

    fn state_machine(&self, binary: &[u8]) -> Vec<u8> {
        const SILENCE: u8 = 0;
        const POSSIBLE_SPEECH: u8 = 1;
        const SPEECH: u8 = 2;
        const POSSIBLE_SILENCE: u8 = 3;

        let mut decisions = vec![0u8; binary.len()];
        let mut state = SILENCE;
        let mut speech_start: usize = 0;
        let mut silence_start: usize = 0;

        for (idx, &is_speech) in binary.iter().enumerate() {
            let sp = is_speech != 0;
            match state {
                SILENCE => {
                    if sp {
                        state = POSSIBLE_SPEECH;
                        speech_start = idx;
                    }
                }
                POSSIBLE_SPEECH => {
                    if sp {
                        if idx - speech_start >= self.min_speech_frame {
                            state = SPEECH;
                            for d in &mut decisions[speech_start..idx] {
                                *d = 1;
                            }
                        }
                    } else {
                        state = SILENCE;
                    }
                }
                SPEECH => {
                    if !sp {
                        state = POSSIBLE_SILENCE;
                        silence_start = idx;
                    }
                }
                POSSIBLE_SILENCE => {
                    if !sp {
                        if idx - silence_start >= self.min_silence_frame {
                            state = SILENCE;
                            for d in &mut decisions[silence_start..=idx] {
                                *d = 0;
                            }
                        }
                    } else {
                        state = SPEECH;
                    }
                }
                _ => {}
            }
            if state == SPEECH || state == POSSIBLE_SILENCE {
                decisions[idx] = 1;
            }
        }
        decisions
    }

    fn fix_smooth_window_start(&self, decisions: &[u8]) -> Vec<u8> {
        let mut out = decisions.to_vec();
        for i in 1..decisions.len() {
            if decisions[i - 1] == 0 && decisions[i] == 1 {
                let start = i.saturating_sub(self.smooth_window_size);
                for d in &mut out[start..i] {
                    *d = 1;
                }
            }
        }
        out
    }

    fn merge_short_silence(&self, decisions: &[u8]) -> Vec<u8> {
        if self.merge_silence_frame == 0 {
            return decisions.to_vec();
        }
        let mut out = decisions.to_vec();
        let mut silence_start: Option<usize> = None;
        for i in 1..decisions.len() {
            if decisions[i - 1] == 1 && decisions[i] == 0 && silence_start.is_none() {
                silence_start = Some(i);
            } else if decisions[i - 1] == 0 && decisions[i] == 1 {
                if let Some(s) = silence_start.take() {
                    if i - s < self.merge_silence_frame {
                        for d in &mut out[s..i] {
                            *d = 1;
                        }
                    }
                }
            }
        }
        out
    }

    fn extend_speech(&self, decisions: &[u8]) -> Vec<u8> {
        let ext = self.extend_speech_frame;
        if ext == 0 {
            return decisions.to_vec();
        }
        let n = decisions.len();
        let mut out = vec![0u8; n];
        for i in 0..n {
            if decisions[i] == 1 {
                let lo = i.saturating_sub(ext);
                let hi = (i + ext + 1).min(n);
                for d in &mut out[lo..hi] {
                    *d = 1;
                }
            }
        }
        out
    }

    fn split_long_speech(&self, decisions: &[u8], probs: &[f32]) -> Vec<u8> {
        let mut out = decisions.to_vec();
        for seg in self.decision_to_segments(decisions, None) {
            let start_frame = (seg.start / FIRERED_FRAME_SHIFT_S) as usize;
            let end_frame = ((seg.end / FIRERED_FRAME_SHIFT_S) as usize).min(probs.len());
            if end_frame <= start_frame || end_frame - start_frame <= self.max_speech_frame {
                continue;
            }
            let seg_probs = &probs[start_frame..end_frame];
            let mut start = 0usize;
            while start < seg_probs.len() && seg_probs.len() - start > self.max_speech_frame {
                let w_start = start + self.max_speech_frame / 2;
                let w_end = (start + self.max_speech_frame).min(seg_probs.len());
                if w_start >= w_end {
                    break;
                }
                let mut min_i = w_start;
                let mut min_v = seg_probs[w_start];
                for (i, &v) in seg_probs.iter().enumerate().take(w_end).skip(w_start + 1) {
                    if v < min_v {
                        min_v = v;
                        min_i = i;
                    }
                }
                let split_frame = start_frame + min_i;
                if split_frame < out.len() {
                    out[split_frame] = 0;
                }
                start = min_i + 1;
            }
        }
        out
    }
}

// --- Silero VAD v6 Speech Timestamps (exact port of faster_whisper/vad.py) ---

pub fn silero_speech_timestamps(
    speech_probs: &[f32],
    audio_length_samples: usize,
) -> Vec<Segment> {
    let threshold = 0.5f32;
    let neg_threshold = (threshold - 0.15).max(0.01);
    let sampling_rate = 16000usize;
    let window_size_samples = 512usize;
    let min_speech_samples = (sampling_rate * 250) / 1000;
    let min_silence_samples = (sampling_rate * 100) / 1000;
    let speech_pad_samples = (sampling_rate * 30) / 1000;

    let mut triggered = false;
    let mut speeches: Vec<(usize, usize)> = Vec::new();
    let mut current_start: Option<usize> = None;
    let mut temp_end: usize = 0;

    for (i, &prob) in speech_probs.iter().enumerate() {
        let pos = window_size_samples * i;
        if prob >= threshold && temp_end != 0 {
            temp_end = 0;
        }
        if prob >= threshold && !triggered {
            triggered = true;
            current_start = Some(pos);
            continue;
        }
        if prob < neg_threshold && triggered {
            if temp_end == 0 {
                temp_end = pos;
            }
            if pos - temp_end < min_silence_samples {
                continue;
            }
            if let Some(s) = current_start.take() {
                if temp_end.saturating_sub(s) > min_speech_samples {
                    speeches.push((s, temp_end));
                }
            }
            temp_end = 0;
            triggered = false;
        }
    }
    if let Some(s) = current_start {
        if audio_length_samples.saturating_sub(s) > min_speech_samples {
            speeches.push((s, audio_length_samples));
        }
    }

    let count = speeches.len();
    for i in 0..count {
        if i == 0 {
            speeches[i].0 = speeches[i].0.saturating_sub(speech_pad_samples);
        }
        if i + 1 < count {
            let silence_dur = speeches[i + 1].0.saturating_sub(speeches[i].1);
            if silence_dur < 2 * speech_pad_samples {
                let half = silence_dur / 2;
                speeches[i].1 += half;
                speeches[i + 1].0 = speeches[i + 1].0.saturating_sub(half);
            } else {
                speeches[i].1 = (speeches[i].1 + speech_pad_samples).min(audio_length_samples);
                speeches[i + 1].0 = speeches[i + 1].0.saturating_sub(speech_pad_samples);
            }
        } else {
            speeches[i].1 = (speeches[i].1 + speech_pad_samples).min(audio_length_samples);
        }
    }

    speeches
        .into_iter()
        .filter(|(s, e)| e > s)
        .map(|(s, e)| Segment {
            start: s as f64 / sampling_rate as f64,
            end: e as f64 / sampling_rate as f64,
        })
        .collect()
}

// --- ONNX Sessions & Shared VadSystem ---

struct FireRedEngine {
    session: Session,
    fbank: KaldiFbank,
    last_used: Instant,
    file_bytes: u64,
    estimated_ram_bytes: Option<u64>,
}

struct SileroEngine {
    session: Session,
    last_used: Instant,
    file_bytes: u64,
    estimated_ram_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VadModelSnapshot {
    pub id: &'static str,
    pub name: &'static str,
    pub file_bytes: u64,
    pub estimated_ram_bytes: Option<u64>,
    pub idle_seconds: u64,
}

pub struct VadSystem {
    assets_roots: Vec<PathBuf>,
    firered: Mutex<Option<FireRedEngine>>,
    silero: Mutex<Option<SileroEngine>>,
    memory_probe: Option<fn() -> Option<u64>>,
}

impl VadSystem {
    pub fn new(assets_roots: Vec<PathBuf>) -> Self {
        Self {
            assets_roots,
            firered: Mutex::new(None),
            silero: Mutex::new(None),
            memory_probe: None,
        }
    }

    pub fn with_memory_probe(mut self, probe: fn() -> Option<u64>) -> Self {
        self.memory_probe = Some(probe);
        self
    }

    /// Release resident ONNX sessions that have been idle longer than `idle_timeout`
    /// (default 3 minutes), freeing ONNX Runtime memory when not mining.
    pub fn unload_if_idle(&self, idle_timeout: Duration) -> bool {
        let now = Instant::now();
        let mut unloaded = false;
        if let Ok(mut guard) = self.firered.try_lock() {
            if guard
                .as_ref()
                .is_some_and(|e| now.saturating_duration_since(e.last_used) >= idle_timeout)
            {
                *guard = None;
                unloaded = true;
            }
        }
        if let Ok(mut guard) = self.silero.try_lock() {
            if guard
                .as_ref()
                .is_some_and(|e| now.saturating_duration_since(e.last_used) >= idle_timeout)
            {
                *guard = None;
                unloaded = true;
            }
        }
        unloaded
    }

    pub fn loaded_models_snapshot(&self) -> Vec<VadModelSnapshot> {
        let now = Instant::now();
        let mut models = Vec::new();
        if let Ok(guard) = self.firered.try_lock() {
            if let Some(eng) = guard.as_ref() {
                models.push(VadModelSnapshot {
                    id: "vad_firered",
                    name: "FireRedVAD",
                    file_bytes: eng.file_bytes,
                    estimated_ram_bytes: eng.estimated_ram_bytes,
                    idle_seconds: now.saturating_duration_since(eng.last_used).as_secs(),
                });
            }
        }
        if let Ok(guard) = self.silero.try_lock() {
            if let Some(eng) = guard.as_ref() {
                models.push(VadModelSnapshot {
                    id: "vad_silero",
                    name: "Silero VAD v6",
                    file_bytes: eng.file_bytes,
                    estimated_ram_bytes: eng.estimated_ram_bytes,
                    idle_seconds: now.saturating_duration_since(eng.last_used).as_secs(),
                });
            }
        }
        models
    }

    pub fn unload_default_idle(&self) -> bool {
        self.unload_if_idle(VAD_IDLE_UNLOAD_AFTER)
    }

    fn find_asset(&self, rel: &str) -> Result<PathBuf, String> {
        for root in &self.assets_roots {
            let candidate = root.join(rel);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        Err(format!("VAD asset '{rel}' not found in configured asset roots"))
    }

    pub fn preload(&self, config: &ProfileConfig) {
        if !config.vad.do_vad_postprocessing || !config.vad.preload_vad_model {
            return;
        }
        if config.vad.is_firered() {
            let _ = self.ensure_firered();
        }
        if config.vad.is_silero() {
            let _ = self.ensure_silero();
        }
    }

    fn ensure_firered(&self) -> Result<(), String> {
        let mut guard = self.firered.lock().map_err(|_| "FireRed lock poisoned")?;
        if let Some(ref mut eng) = *guard {
            eng.last_used = Instant::now();
            return Ok(());
        }
        let model_path = self.find_asset("fireredvad/fireredvad_vad.onnx")?;
        let cmvn_path = self.find_asset("fireredvad/cmvn.ark")?;
        let file_bytes = std::fs::metadata(&model_path)
            .map(|m| m.len())
            .unwrap_or(0)
            .saturating_add(std::fs::metadata(&cmvn_path).map(|m| m.len()).unwrap_or(0));
        let before = self.memory_probe.and_then(|probe| probe());
        let intra = std::thread::available_parallelism()
            .map(|n| n.get().clamp(1, 4))
            .unwrap_or(2);
        let session = Session::builder()
            .map_err(|e| e.to_string())?
            .with_no_environment_execution_providers()
            .map_err(|e| e.to_string())?
            .with_execution_providers([ort::ep::CPU::default()
                .with_arena_allocator(false)
                .build()
                .error_on_failure()])
            .map_err(|e| e.to_string())?
            .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
            .map_err(|e| e.to_string())?
            .with_intra_threads(intra)
            .map_err(|e| e.to_string())?
            .with_inter_threads(1)
            .map_err(|e| e.to_string())?
            .with_intra_op_spinning(false)
            .map_err(|e| e.to_string())?
            .with_inter_op_spinning(false)
            .map_err(|e| e.to_string())?
            .with_memory_pattern(false)
            .map_err(|e| e.to_string())?
            .commit_from_file(&model_path)
            .map_err(|e| format!("Loading FireRedVAD ONNX {}: {e}", model_path.display()))?;
        let fbank = KaldiFbank::new(&cmvn_path)?;
        let after = self.memory_probe.and_then(|probe| probe());
        *guard = Some(FireRedEngine {
            session,
            fbank,
            last_used: Instant::now(),
            file_bytes,
            estimated_ram_bytes: before.zip(after).map(|(b, a)| a.saturating_sub(b)),
        });
        Ok(())
    }

    fn ensure_silero(&self) -> Result<(), String> {
        let mut guard = self.silero.lock().map_err(|_| "Silero lock poisoned")?;
        if let Some(ref mut eng) = *guard {
            eng.last_used = Instant::now();
            return Ok(());
        }
        let model_path = self.find_asset("silero/silero_vad_v6.onnx")?;
        let file_bytes = std::fs::metadata(&model_path).map(|m| m.len()).unwrap_or(0);
        let before = self.memory_probe.and_then(|probe| probe());
        let session = Session::builder()
            .map_err(|e| e.to_string())?
            .with_no_environment_execution_providers()
            .map_err(|e| e.to_string())?
            .with_execution_providers([ort::ep::CPU::default()
                .with_arena_allocator(false)
                .build()
                .error_on_failure()])
            .map_err(|e| e.to_string())?
            .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
            .map_err(|e| e.to_string())?
            .with_intra_threads(1)
            .map_err(|e| e.to_string())?
            .with_inter_threads(1)
            .map_err(|e| e.to_string())?
            .with_intra_op_spinning(false)
            .map_err(|e| e.to_string())?
            .with_inter_op_spinning(false)
            .map_err(|e| e.to_string())?
            .with_memory_pattern(false)
            .map_err(|e| e.to_string())?
            .commit_from_file(&model_path)
            .map_err(|e| format!("Loading Silero VAD ONNX {}: {e}", model_path.display()))?;
        let after = self.memory_probe.and_then(|probe| probe());
        *guard = Some(SileroEngine {
            session,
            last_used: Instant::now(),
            file_bytes,
            estimated_ram_bytes: before.zip(after).map(|(b, a)| a.saturating_sub(b)),
        });
        Ok(())
    }

    pub fn detect_firered_pcm(
        &self,
        pcm: &[i16],
        config: &ProfileConfig,
    ) -> Result<Vec<Segment>, String> {
        self.ensure_firered()?;
        let mut guard = self.firered.lock().map_err(|_| "FireRed lock poisoned")?;
        let engine = guard.as_mut().ok_or("FireRed engine unavailable")?;
        engine.last_used = Instant::now();
        let (features, num_frames, duration) = engine.fbank.extract(pcm);
        if num_frames == 0 {
            return Ok(Vec::new());
        }
        let input = Tensor::from_array(([1usize, num_frames, 80usize], features))
            .map_err(|e| e.to_string())?;
        let outputs = engine
            .session
            .run(ort::inputs!["feat" => input])
            .map_err(|e| format!("FireRedVAD inference failed: {e}"))?;
        let (_, probs) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;
        let post = FireRedPostprocessor::from_config(config);
        let decisions = post.process(probs);
        Ok(post.decision_to_segments(&decisions, Some(duration)))
    }

    pub fn detect_firered_wav(
        &self,
        wav_path: &Path,
        config: &ProfileConfig,
    ) -> Result<Vec<Segment>, String> {
        let pcm = load_pcm16_mono_wav(wav_path)?;
        self.detect_firered_pcm(&pcm, config)
    }

    pub fn detect_silero_pcm(&self, pcm: &[i16]) -> Result<Vec<Segment>, String> {
        self.ensure_silero()?;
        let audio_len = pcm.len();
        let num_samples = 512usize;
        let context_size = 64usize;
        let rem = audio_len % num_samples;
        let pad = num_samples - rem;
        let padded_len = audio_len + pad;
        let num_chunks = padded_len / num_samples;
        let chunk_width = num_samples + context_size;
        let scale = 1.0f32 / 32768.0f32;

        let mut guard = self.silero.lock().map_err(|_| "Silero lock poisoned")?;
        let engine = guard.as_mut().ok_or("Silero engine unavailable")?;
        engine.last_used = Instant::now();
        let mut h = vec![0.0f32; 128];
        let mut c = vec![0.0f32; 128];
        let mut all_probs = Vec::with_capacity(num_chunks);
        let batch_limit = 2_048usize;

        for start_chunk in (0..num_chunks).step_by(batch_limit) {
            let count = (num_chunks - start_chunk).min(batch_limit);
            let mut batch_buf = vec![0.0f32; count * chunk_width];
            for local_i in 0..count {
                let i = start_chunk + local_i;
                let dst = &mut batch_buf[local_i * chunk_width..(local_i + 1) * chunk_width];
                if i > 0 {
                    let prev_tail_start = i * num_samples - context_size;
                    for (k, slot) in dst[..context_size].iter_mut().enumerate() {
                        let sample_idx = prev_tail_start + k;
                        if sample_idx < audio_len {
                            *slot = pcm[sample_idx] as f32 * scale;
                        }
                    }
                }
                let chunk_start = i * num_samples;
                for (k, slot) in dst[context_size..].iter_mut().enumerate() {
                    let sample_idx = chunk_start + k;
                    if sample_idx < audio_len {
                        *slot = pcm[sample_idx] as f32 * scale;
                    }
                }
            }
            let input_t = Tensor::from_array(([count, chunk_width], batch_buf))
                .map_err(|e| e.to_string())?;
            let h_t = Tensor::from_array(([1usize, 1usize, 128usize], h.clone()))
                .map_err(|e| e.to_string())?;
            let c_t = Tensor::from_array(([1usize, 1usize, 128usize], c.clone()))
                .map_err(|e| e.to_string())?;
            let outputs = engine
                .session
                .run(ort::inputs!["input" => input_t, "h" => h_t, "c" => c_t])
                .map_err(|e| format!("Silero VAD inference failed: {e}"))?;
            let (_, probs) = outputs[0]
                .try_extract_tensor::<f32>()
                .map_err(|e| e.to_string())?;
            all_probs.extend_from_slice(probs);
            let (_, next_h) = outputs[1]
                .try_extract_tensor::<f32>()
                .map_err(|e| e.to_string())?;
            let (_, next_c) = outputs[2]
                .try_extract_tensor::<f32>()
                .map_err(|e| e.to_string())?;
            h.copy_from_slice(next_h);
            c.copy_from_slice(next_c);
        }

        Ok(silero_speech_timestamps(&all_probs, audio_len))
    }

    pub fn detect_silero_wav(&self, wav_path: &Path) -> Result<Vec<Segment>, String> {
        let pcm = load_pcm16_mono_wav(wav_path)?;
        self.detect_silero_pcm(&pcm)
    }

    pub fn trim_audio_with_vad(
        &self,
        media: &MediaTools,
        input_audio: &Path,
        output_audio: &Path,
        game_line: Option<&GameLine>,
        has_next_line: bool,
        config: &ProfileConfig,
    ) -> VadResult {
        if !config.vad.do_vad_postprocessing {
            return VadResult::new(false, 0.0, 0.0, OFF);
        }
        let primary = self.run_single_model(
            &config.vad.selected_vad_model_v2,
            media,
            input_audio,
            output_audio,
            game_line,
            has_next_line,
            config,
        );
        if !primary.success && config.vad.backup_vad_model != OFF {
            return self.run_single_model(
                &config.vad.backup_vad_model,
                media,
                input_audio,
                output_audio,
                game_line,
                has_next_line,
                config,
            );
        }
        primary
    }

    #[allow(clippy::too_many_arguments)]
    fn run_single_model(
        &self,
        model: &str,
        media: &MediaTools,
        input_audio: &Path,
        output_audio: &Path,
        game_line: Option<&GameLine>,
        has_next_line: bool,
        config: &ProfileConfig,
    ) -> VadResult {
        if model == OFF || model.is_empty() {
            return VadResult::new(false, 0.0, 0.0, OFF);
        }
        let use_filters = model == SILERO;
        let pcm = match Self::decode_input_audio(media, input_audio, use_filters) {
            Ok(samples) => samples,
            Err(e) => {
                let mut r = VadResult::new(false, 0.0, 0.0, model);
                r.error = format!("Voice detection failed with {model}: {e}");
                return r;
            }
        };

        let detect_res = match model {
            FIRERED => self.detect_firered_pcm(&pcm, config),
            SILERO => self.detect_silero_pcm(&pcm),
            other => Err(format!("Unsupported VAD model: {other}")),
        };

        let segments = match detect_res {
            Ok(segs) => segs,
            Err(e) => {
                let mut r = VadResult::new(false, 0.0, 0.0, model);
                r.error = format!("Voice detection failed with {model}: {e}");
                return r;
            }
        };

        let Some((start_time, end_time)) =
            validate_detection(&segments, game_line, has_next_line, media, input_audio, config)
        else {
            return VadResult::new(false, 0.0, 0.0, model);
        };

        match self.render_decision(
            media,
            model,
            &segments,
            start_time,
            end_time,
            input_audio,
            output_audio,
            &pcm,
            config,
        ) {
            Ok(r) => r,
            Err(e) => {
                let mut r = VadResult::new(false, 0.0, 0.0, model);
                r.error = format!("Voice detection failed with {model}: {e}");
                r
            }
        }
    }

    fn decode_input_audio(
        media: &MediaTools,
        input_audio: &Path,
        use_filters: bool,
    ) -> Result<Vec<i16>, String> {
        if !input_audio.is_file() {
            return Err(format!("Input audio does not exist: '{}'", input_audio.display()));
        }
        let in_size = std::fs::metadata(input_audio).map(|m| m.len()).unwrap_or(0);
        if in_size == 0 {
            return Err(format!("Input audio is empty: '{}'", input_audio.display()));
        }
        media.decode_vad_audio(input_audio, use_filters)
    }

    #[allow(clippy::too_many_arguments)]
    fn render_decision(
        &self,
        media: &MediaTools,
        model_name: &str,
        segments: &[Segment],
        start_time: f64,
        end_time: f64,
        input_audio: &Path,
        output_audio: &Path,
        pcm: &[i16],
        config: &ProfileConfig,
    ) -> Result<VadResult, String> {
        let mut output_start = (start_time + config.vad.beginning_offset).max(0.0);
        let output_end = (end_time + config.audio.end_offset).max(0.0);
        let mut condensed_ranges = Vec::new();
        if config.vad.cut_and_splice_segments {
            condensed_ranges = extract_and_combine_segments(
                media,
                input_audio,
                segments,
                output_audio,
                config.vad.splice_padding,
                config.audio.end_offset,
                config,
            )?;
        } else {
            let mut fade_in = 0.05;
            if config.vad.trim_beginning
                && config.vad.adaptive_preroll
                && config.vad.beginning_offset < 0.0
                && !pcm.is_empty()
            {
                let audio: Vec<f32> = pcm.iter().map(|&s| s as f32 * (1.0 / 32768.0)).collect();
                let clean = select_clean_preroll_start(&audio, 16000, output_start, start_time);
                if clean > output_start {
                    output_start = clean;
                    fade_in = 0.01;
                }
            }
            media.trim_audio(
                input_audio,
                output_start,
                output_end,
                output_audio,
                config.vad.trim_beginning,
                fade_in,
                0.0,
                config,
            )?;
        }
        let mut result = VadResult::new(true, output_start, output_end, model_name);
        result.segments = segments.to_vec();
        result.condensed_ranges = condensed_ranges;
        result.output_audio = output_audio.to_string_lossy().into_owned();
        Ok(result)
    }
}

fn validate_detection(
    segments: &[Segment],
    game_line: Option<&GameLine>,
    has_next_line: bool,
    media: &MediaTools,
    input_audio: &Path,
    config: &ProfileConfig,
) -> Option<(f64, f64)> {
    if segments.is_empty() {
        return None;
    }
    let start_time = segments[0].start;
    let mut end_time = segments.last().unwrap().end;
    if has_next_line && segments.len() > 1 {
        let audio_len = media.get_audio_length(input_audio);
        if 0.0 > audio_len - segments.last().unwrap().start + config.audio.beginning_offset {
            end_time = segments[segments.len() - 2].end;
        }
    }
    if let Some(line) = game_line {
        if !line.text.is_empty() {
            let expected_min = config
                .vad
                .short_audio_min_seconds
                .max(line.text.chars().count() as f64 * config.vad.short_audio_seconds_per_char);
            if (end_time - start_time) < expected_min {
                return None;
            }
        }
    }
    Some((start_time, end_time))
}

fn extract_and_combine_segments(
    media: &MediaTools,
    input_audio: &Path,
    segments: &[Segment],
    output_audio: &Path,
    padding: f64,
    end_padding: f64,
    config: &ProfileConfig,
) -> Result<Vec<[f64; 2]>, String> {
    let mut files = Vec::new();
    let mut ranges = Vec::new();
    let mut current_start: Option<f64> = None;
    let ext = &config.audio.extension;

    for (i, seg) in segments.iter().enumerate() {
        if i + 1 < segments.len() && (segments[i + 1].start - seg.end) < (padding * 2.0 + padding / 2.0) {
            if current_start.is_none() {
                current_start = Some(seg.start);
            }
            continue;
        }
        let temp_file = media.unique_temp_path(&format!(".{ext}"));
        let start = (current_start.unwrap_or(seg.start) - padding * 2.0).max(0.0);
        let mut end = seg.end + padding / 2.0;
        if i + 1 == segments.len() {
            end += end_padding;
        }
        let _ = media.trim_audio(input_audio, start, end, &temp_file, true, 0.05, 0.05, config);
        if temp_file.is_file() && std::fs::metadata(&temp_file).is_ok_and(|m| m.len() > 0) {
            files.push(temp_file);
            // Match the precision of the FFmpeg seek and end times in trim_audio.
            ranges.push([start, end].map(|time| (time * 100.0).round() / 100.0));
        } else {
            let _ = std::fs::remove_file(temp_file);
        }
        current_start = None;
    }

    if files.is_empty() {
        return Err("cut-and-splice produced no valid segment files".into());
    }
    if files.len() == 1 {
        std::fs::rename(&files[0], output_audio).or_else(|_| {
            std::fs::copy(&files[0], output_audio)?;
            let _ = std::fs::remove_file(&files[0]);
            Ok(())
        }).map_err(|e: std::io::Error| e.to_string())?;
    } else {
        let result = media.combine_audio_files(&files, output_audio, config);
        for f in &files {
            let _ = std::fs::remove_file(f);
        }
        result?;
    }
    Ok(ranges)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_test_wav(path: &Path, samples: &[i16]) {
        let data_len = (samples.len() * 2) as u32;
        let mut buf = Vec::with_capacity(44 + data_len as usize);
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&(36 + data_len).to_le_bytes());
        buf.extend_from_slice(b"WAVEfmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
        buf.extend_from_slice(&1u16.to_le_bytes()); // mono
        buf.extend_from_slice(&16000u32.to_le_bytes());
        buf.extend_from_slice(&32000u32.to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes());
        buf.extend_from_slice(&16u16.to_le_bytes());
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_len.to_le_bytes());
        for &s in samples {
            buf.extend_from_slice(&s.to_le_bytes());
        }
        std::fs::write(path, buf).unwrap();
    }

    #[test]
    fn firered_postprocessor_handles_speech_and_silence() {
        let cfg = ProfileConfig::default();
        let post = FireRedPostprocessor::from_config(&cfg);
        let mut probs = vec![0.05f32; 100];
        for p in &mut probs[20..60] {
            *p = 0.9;
        }
        let dec = post.process(&probs);
        let segs = post.decision_to_segments(&dec, Some(1.0));
        assert_eq!(segs.len(), 1);
        assert!(segs[0].start < 0.25 && segs[0].end > 0.55);
    }

    #[test]
    fn silero_and_firered_onnx_models_run_on_real_assets() {
        let assets_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../resources/assets");
        if !assets_root.join("fireredvad/fireredvad_vad.onnx").is_file()
            || !assets_root.join("silero/silero_vad_v6.onnx").is_file()
        {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("silence.wav");
        write_test_wav(&wav, &vec![0i16; 16000]);
        let vad = VadSystem::new(vec![assets_root]);
        let cfg = ProfileConfig::default();
        let fr = vad.detect_firered_wav(&wav, &cfg).unwrap();
        let si = vad.detect_silero_wav(&wav).unwrap();
        assert!(fr.is_empty(), "silence should produce no FireRed speech: {fr:?}");
        assert!(si.is_empty(), "silence should produce no Silero speech: {si:?}");
    }

    #[test]
    fn loaded_models_snapshot_and_idle_unload_do_not_block() {
        let vad = VadSystem::new(vec![]);
        assert!(vad.loaded_models_snapshot().is_empty());
        assert!(!vad.unload_if_idle(Duration::ZERO));
    }
}
