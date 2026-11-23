//! Pure-Rust mining engine for GameSentenceMiner:
//! - Profile config & AnkiCard field repair/mismatch detection (`config`)
//! - Text normalization, HTML/cloze/furigana preservation, card-to-line matcher (`text`)
//! - Process pause silence removal & timeline mapping (`pause_gaps`)
//! - FFmpeg/FFprobe media extraction, screenshots, AVIF/WebP animations (`ffmpeg`, `avif_sizing`)
//! - Saved clips loading & card matching (`clips`)
//! - Native ONNX VAD: FireRedVAD + Silero VAD v6 (`vad`)
//! - Multi-provider AI prompting, caching, study presets, overlay block translation (`ai`)
//! - AnkiBeacon push receiver & single-port HTTP/WebSocket reverse proxy gateway (`beacon`, `gateway`)
//! - Field policies, media asset rules, reuse cache, and replay audio extraction (`policy`)

pub mod ai;
pub mod avif_sizing;
pub mod beacon;
pub mod clips;
pub mod config;
pub mod ffmpeg;
pub mod gateway;
pub mod longplay;
pub mod pause_gaps;
pub mod policy;
pub mod reader_media;
pub mod reader_folder;
pub mod frame_selector;
pub mod text;
pub mod vad;

#[cfg(test)]
mod bench_tests {
    use crate::beacon::BeaconReceiver;
    use crate::config::{AnkiCard, AnkiCardField, ProfileConfig};
    use crate::gateway::start_gateway;
    use crate::pause_gaps::{remove_pause_gaps, ExpectedGap};
    use crate::text::{find_matching_line, now_epoch, GameLine};
    use crate::vad::VadSystem;
    use serde_json::json;
    use std::path::PathBuf;
    use std::time::Instant;

    fn current_rss_mb() -> f64 {
        #[cfg(windows)]
        {
            #[repr(C)]
            struct ProcessMemoryCounters {
                cb: u32,
                page_fault_count: u32,
                peak_working_set_size: usize,
                working_set_size: usize,
                quota_peak_paged_pool_usage: usize,
                quota_paged_pool_usage: usize,
                quota_peak_non_paged_pool_usage: usize,
                quota_non_paged_pool_usage: usize,
                pagefile_usage: usize,
                peak_pagefile_usage: usize,
            }
            extern "system" {
                fn GetCurrentProcess() -> isize;
                fn K32GetProcessMemoryInfo(
                    process: isize,
                    ppsmemcounters: *mut ProcessMemoryCounters,
                    cb: u32,
                ) -> i32;
            }
            unsafe {
                let mut pmc = std::mem::zeroed::<ProcessMemoryCounters>();
                pmc.cb = std::mem::size_of::<ProcessMemoryCounters>() as u32;
                if K32GetProcessMemoryInfo(GetCurrentProcess(), &mut pmc, pmc.cb) != 0 {
                    return pmc.working_set_size as f64 / (1024.0 * 1024.0);
                }
            }
        }
        0.0
    }

    #[tokio::test]
    #[ignore = "performance benchmark suite (run with --release -- --ignored --nocapture)"]
    async fn benchmark_mining_hot_paths() {
        let cfg = ProfileConfig::default();
        let rss_before_mb = current_rss_mb();

        // 1. FireRedVAD & Silero VAD v6 on 10s 16kHz audio (160,000 samples)
        let assets_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../GameSentenceMiner/assets");
        let vad = VadSystem::new(vec![assets_root]);
        let pcm: Vec<i16> = (0..160_000)
            .map(|i| {
                let t = i as f64 / 16000.0;
                if (1.0..4.5).contains(&t) || (5.5..8.8).contains(&t) {
                    ((t * 440.0 * std::f64::consts::TAU).sin() * 12000.0) as i16
                } else {
                    0
                }
            })
            .collect();
        // Warmup ONNX sessions
        let _ = vad.detect_firered_pcm(&pcm, &cfg).unwrap();
        let _ = vad.detect_silero_pcm(&pcm).unwrap();
        let rss_after_vad_mb = current_rss_mb();

        let iters_vad = 25;
        let t0 = Instant::now();
        for _ in 0..iters_vad {
            let segs = vad.detect_firered_pcm(&pcm, &cfg).unwrap();
            std::hint::black_box(segs);
        }
        let firered_ms = t0.elapsed().as_secs_f64() * 1000.0 / iters_vad as f64;

        let t0 = Instant::now();
        for _ in 0..iters_vad {
            let segs = vad.detect_silero_pcm(&pcm).unwrap();
            std::hint::black_box(segs);
        }
        let silero_ms = t0.elapsed().as_secs_f64() * 1000.0 / iters_vad as f64;

        // 2. Pause-Gap Silence Removal on 60s 48kHz stereo (5,760,000 f32 samples = 23.04 MB)
        let sr = 48_000usize;
        let channels = 2usize;
        let total_frames = sr * 60;
        let mut stereo = vec![0.15f32; total_frames * channels];
        for &(s_sec, e_sec) in &[(10usize, 13usize), (28, 32), (45, 47)] {
            stereo[s_sec * sr * channels..e_sec * sr * channels].fill(0.0);
        }
        let gaps = vec![
            ExpectedGap {
                offset: 10.0,
                duration: 3.0,
            },
            ExpectedGap {
                offset: 28.0,
                duration: 4.0,
            },
            ExpectedGap {
                offset: 45.0,
                duration: 2.0,
            },
        ];
        let iters_pause = 20;
        let t0 = Instant::now();
        for _ in 0..iters_pause {
            let (cleaned, tl) = remove_pause_gaps(&stereo, channels, sr, &gaps);
            assert_eq!(tl.cuts.len(), 3);
            std::hint::black_box(cleaned);
        }
        let pause_ms = t0.elapsed().as_secs_f64() * 1000.0 / iters_pause as f64;

        // 3. Fuzzy Card-to-Line Matching across 250 Japanese lines (with HTML/furigana tags)
        let base_t = now_epoch();
        let lines: Vec<GameLine> = (0..250)
            .map(|i| GameLine {
                id: format!("line-{i}"),
                text: if i == 187 {
                    "「本当にそんなことで大丈夫なのか？ 私はまだ納得していないぞ」".into()
                } else {
                    format!(
                        "キャラクター{}「これはテスト用のセリフ番号{}です。今日もいい天気ですね。」",
                        i % 7,
                        i
                    )
                },
                time_epoch: base_t - (250 - i) as f64 * 0.4,
                index: i,
                scene: "TestVN".into(),
                source: Some("hooker".into()),
                source_padding: Some(0.0),
                mined_time_epoch: None,
                excluded_from_stats: false,
                session_id: "s1".into(),
                first_seen_time_epoch: None,
                translation: String::new(),
                prev_id: (i > 0).then(|| format!("line-{}", i - 1)),
                next_id: (i + 1 < 250).then(|| format!("line-{}", i + 1)),
                clip_folder: None,
                clip_path: None,
                clip_end_time_epoch: None,
            })
            .collect();
        let card = AnkiCard {
            note_id: 999,
            tags: vec!["GSM".into()],
            fields: vec![
                (
                    "Expression".into(),
                    AnkiCardField {
                        value: "納得".into(),
                        order: 0,
                    },
                ),
                (
                    "Sentence".into(),
                    AnkiCardField {
                        value: "本当にそんなことで大丈夫なのか？ 私はまだ<b>納得[なっとく]</b>していないぞ"
                            .into(),
                        order: 1,
                    },
                ),
            ],
            cards: vec![1],
            model_name: "Japanese".into(),
        };
        let iters_match = 1000;
        let t0 = Instant::now();
        for _ in 0..iters_match {
            let m = find_matching_line(&card, &cfg.anki, &lines, true, true, 120.0, 65.0).unwrap();
            assert_eq!(m.id, "line-187");
            std::hint::black_box(m);
        }
        let match_us = t0.elapsed().as_secs_f64() * 1e6 / iters_match as f64;

        // 4. AnkiBeacon HTTP Gateway Latency (200 sequential POST /anki/events requests)
        let (beacon, mut _rx) = BeaconReceiver::new(512);
        let gw = start_gateway("127.0.0.1", 0, beacon).await.unwrap();
        let url = format!("http://127.0.0.1:{}/anki/events", gw.bound_addr.port());
        let client = reqwest::Client::builder()
            .no_proxy()
            .tcp_nodelay(true)
            .build()
            .unwrap();
        // Warmup connection
        let _ = client
            .post(&url)
            .json(&json!({"event":"heartbeat","session_id":"b1","heartbeat_interval_seconds":15}))
            .send()
            .await
            .unwrap();
        let iters_http = 200;
        let t0 = Instant::now();
        for i in 0..iters_http {
            let resp = client
                .post(&url)
                .json(&json!({"event":"note_added","session_id":"b1","note_id": 1000 + (i % 50)}))
                .send()
                .await
                .unwrap();
            assert!(matches!(resp.status().as_u16(), 200 | 202));
        }
        let beacon_http_ms = t0.elapsed().as_secs_f64() * 1000.0 / iters_http as f64;
        gw.shutdown();

        println!(
            "\n=== RUST GSM-MINING BENCHMARKS (release) ===\n\
             FireRedVAD (10s 16kHz audio):     {firered_ms:8.3} ms/call\n\
             Silero VAD v6 (10s 16kHz audio):  {silero_ms:8.3} ms/call\n\
             Pause-Gap Splice (60s 48kHz 2ch): {pause_ms:8.3} ms/call\n\
             Card-to-Line Match (250 lines):   {match_us:8.2} us/card\n\
             AnkiBeacon HTTP POST (loopback):  {beacon_http_ms:8.3} ms/req\n\
             Rust VAD RSS delta:               {:8.2} MB (total RSS {rss_after_vad_mb:.1} MB)\n",
            (rss_after_vad_mb - rss_before_mb).max(0.0)
        );
    }
}
