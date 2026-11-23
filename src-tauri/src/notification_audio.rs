use rodio::{buffer::SamplesBuffer, DeviceSinkBuilder, MixerDeviceSink, Source};
use serde::Deserialize;
use std::{
    f32::consts::TAU,
    num::NonZero,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

const SAMPLE_RATE: NonZero<u32> = NonZero::new(48_000).unwrap();
const ATTACK: f32 = 0.008;
const RELEASE: f32 = 0.01;
const PEAK: f32 = 0.24;
const DECAY_FLOOR: f32 = 0.0001;

#[derive(Deserialize)]
pub struct Playback {
    tones: Vec<Tone>,
    volume: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tone {
    frequency: f32,
    duration: f32,
    #[serde(default)]
    delay: f32,
    end_frequency: Option<f32>,
    harmonic: Option<f32>,
}

impl Tone {
    fn is_valid(&self) -> bool {
        let pitches = 20.0..=4_000.0;
        pitches.contains(&self.frequency)
            && pitches.contains(&self.end_frequency.unwrap_or(self.frequency))
            && (0.02..=1.0).contains(&self.duration)
            && (0.0..=1.0).contains(&self.delay)
            && (1.0..=4.0).contains(&self.harmonic.unwrap_or(1.0))
    }

    fn mix_into(&self, samples: &mut Vec<f32>) {
        let rate = SAMPLE_RATE.get() as f32;
        let start = (self.delay * rate).round() as usize;
        let frames = ((self.duration + RELEASE) * rate).round() as usize;
        samples.resize(samples.len().max(start + frames), 0.0);

        let partials = [(1.0, 1.0), (self.harmonic.unwrap_or(1.0), 0.18)];
        let count = if self.harmonic.is_some() { 2 } else { 1 };
        let sweep = (self.end_frequency.unwrap_or(self.frequency) / self.frequency)
            .powf(1.0 / (self.duration * rate));
        for &(ratio, level) in &partials[..count] {
            let peak = PEAK * level;
            let decay = (DECAY_FLOOR / peak).powf(1.0 / (self.duration - ATTACK));
            let mut phase = 0.0_f32;
            let mut phase_step = TAU * self.frequency * ratio / rate;
            for (frame, sample) in samples[start..start + frames].iter_mut().enumerate() {
                let time = frame as f32 / rate;
                let gain = if time < ATTACK {
                    peak * time / ATTACK
                } else if time < self.duration {
                    peak * decay.powf(time - ATTACK)
                } else {
                    DECAY_FLOOR * (1.0 - (time - self.duration) / RELEASE)
                };
                *sample += phase.sin() * gain;
                phase = (phase + phase_step) % TAU;
                if time < self.duration {
                    phase_step *= sweep;
                }
            }
        }
    }
}

impl Playback {
    fn into_source(self) -> Result<Option<impl Source + Send>, String> {
        if self.volume > 100
            || !(1..=8).contains(&self.tones.len())
            || !self.tones.iter().all(Tone::is_valid)
        {
            return Err("Invalid notification sound".into());
        }
        if self.volume == 0 {
            return Ok(None);
        }
        let mut samples = Vec::new();
        for tone in &self.tones {
            tone.mix_into(&mut samples);
        }
        let volume = f32::from(self.volume) / 100.0;
        Ok(Some(
            SamplesBuffer::new(NonZero::new(1).unwrap(), SAMPLE_RATE, samples).amplify(volume),
        ))
    }
}

struct Output {
    sink: MixerDeviceSink,
    failed: Arc<AtomicBool>,
}

impl Output {
    fn open() -> Result<Self, String> {
        let failed = Arc::new(AtomicBool::new(false));
        let stream_failed = Arc::clone(&failed);
        let mut sink = DeviceSinkBuilder::from_default_device()
            .and_then(|builder| {
                builder
                    .with_error_callback(move |error| {
                        if !stream_failed.swap(true, Ordering::Relaxed) {
                            crate::desktop_log::stderr_only(
                                "audio",
                                "WARNING",
                                format!("Notification audio output failed: {error}"),
                            );
                        }
                    })
                    .open_sink_or_fallback()
            })
            .map_err(|error| format!("Could not open notification audio output: {error}"))?;
        sink.log_on_drop(false);
        Ok(Self { sink, failed })
    }
}

#[derive(Default)]
pub struct NotificationAudio(Mutex<Option<Output>>);

impl NotificationAudio {
    pub fn play(&self, request: Playback) -> Result<(), String> {
        let Some(source) = request.into_source()? else {
            return Ok(());
        };
        self.mixer()?.add(source);
        Ok(())
    }

    pub(crate) fn mixer(&self) -> Result<rodio::mixer::Mixer,String> {
        let mut output = self.0.lock().map_err(|error| error.to_string())?;
        let stream = match output.as_ref() {
            Some(stream) if !stream.failed.load(Ordering::Relaxed) => stream,
            _ => {
                *output = None;
                output.insert(Output::open()?)
            }
        };
        Ok(stream.sink.mixer().clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{from_value, json};

    #[test]
    fn synthesizes_delayed_sweeps_and_harmonics_with_a_quiet_release() {
        let request: Playback = from_value(json!({
            "tones": [{ "frequency": 400, "endFrequency": 900, "duration": 0.15, "delay": 0.05, "harmonic": 2 }],
            "volume": 15
        })).unwrap();
        let samples: Vec<_> = request.into_source().unwrap().unwrap().collect();
        assert_eq!(samples.len(), 10_080);
        assert!(samples[..2400].iter().all(|sample| *sample == 0.0));
        assert!(samples.iter().any(|sample| sample.abs() > 0.015));
        assert!(samples
            .iter()
            .all(|sample| sample.abs() <= PEAK * 1.18 * 0.15));
        assert!(samples.last().unwrap().abs() < 0.00001);
    }

    #[test]
    fn mute_leaves_the_output_closed_and_invalid_requests_are_rejected() {
        let audio = NotificationAudio::default();
        let muted =
            from_value(json!({ "tones": [{ "frequency": 880, "duration": 0.24 }], "volume": 0 }))
                .unwrap();
        audio.play(muted).unwrap();
        for (frequency, volume) in [(880, 101), (0, 15)] {
            let request = from_value(json!({ "tones": [{ "frequency": frequency, "duration": 0.24 }], "volume": volume })).unwrap();
            assert!(audio.play(request).is_err());
        }
        assert!(audio.0.lock().unwrap().is_none());
    }
}
