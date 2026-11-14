// SPDX-License-Identifier: GPL-3.0-or-later
//! Integer character cells, ported from eval/charbox.py at VOCR revision
//! 205f47ec4e56ca87c00e7dba0a61c9aaec726707. Recognition uses PITCH | INK.
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Character {
    pub cls: i64,
    pub f0: usize,
    pub f1: usize,
    pub c: i64,
    pub x0: i64,
    pub x1: i64,
    pub i0: i64,
    pub i1: i64,
}
fn rounded(a: i64, b: i64) -> i64 {
    if a >= 0 {
        (a + b / 2) / b
    } else {
        -((-a + b / 2) / b)
    }
}
pub fn positions(best: &[i64], w: i64, h: i64, nw: i64, profile: &[i64]) -> Vec<Character> {
    let mut spans: Vec<(i64, usize, usize)> = vec![];
    let mut last = 0;
    for (frame, &class) in best.iter().enumerate() {
        if class != 0 && class != last {
            spans.push((class, frame, frame));
        } else if class != 0 {
            spans.last_mut().unwrap().2 = frame;
        }
        last = class;
    }
    spans.truncate(256);
    let n = spans.len() as i64;
    if n == 0 || w <= 0 || nw <= 0 {
        return vec![];
    }
    let mut centers: Vec<_> = spans
        .iter()
        .map(|s| rounded(16 * (8 * s.1 as i64 + 4) * w, nw).clamp(0, w * 16))
        .collect();
    let mut distances: Vec<_> = centers.windows(2).map(|p| p[1] - p[0]).collect();
    distances.sort_unstable();
    let mut pitch = if distances.is_empty() {
        h * 16
    } else {
        distances[(distances.len() - 1) / 2]
    };
    if pitch <= 0 {
        pitch = h * 16;
    }
    if n >= 4 && distances.iter().all(|d| (d - pitch).abs() * 4 <= pitch) {
        let sk = n * (n - 1) / 2;
        let skk = (n - 1) * n * (2 * n - 1) / 6;
        let sc = centers.iter().sum::<i64>();
        let skc = centers
            .iter()
            .enumerate()
            .map(|(k, c)| k as i64 * c)
            .sum::<i64>();
        let denominator = n * skk - sk * sk;
        let p = n * skc - sk * sc;
        let a = sc * skk - sk * skc;
        centers = (0..n)
            .map(|k| rounded(a + k * p, denominator).clamp(0, w * 16))
            .collect();
        pitch = rounded(p, denominator).max(1);
    }
    let cuts: Vec<_> = centers
        .windows(2)
        .map(|v| rounded(v[0] + v[1], 2))
        .collect();
    let mut output: Vec<_> = spans
        .iter()
        .enumerate()
        .map(|(i, &(cls, f0, f1))| {
            let x0 = if i == 0 {
                (centers[0] - pitch / 2).max(0)
            } else {
                cuts[i - 1]
            };
            let x1 = if i + 1 == spans.len() {
                (centers[i] + pitch / 2).min(w * 16)
            } else {
                cuts[i]
            }
            .max(x0);
            Character {
                cls,
                f0,
                f1,
                c: centers[i],
                x0,
                x1,
                i0: x0,
                i1: x1,
            }
        })
        .collect();
    if profile.len() == w as usize {
        ink(&mut output, profile, w);
    }
    output
}
fn ink(output: &mut [Character], profile: &[i64], w: i64) {
    let peak = profile.iter().copied().max().unwrap_or(0);
    if peak <= 0 {
        return;
    }
    for i in 0..output.len().saturating_sub(1) {
        let a = (output[i].c + 15) / 16;
        let b = output[i + 1].c / 16;
        if b - a < 1 {
            continue;
        }
        let minimum = profile[a as usize..b as usize]
            .iter()
            .copied()
            .min()
            .unwrap();
        let (mut best_len, mut best_start, mut run_start) = (0, a, None);
        for x in a..=b {
            let on = x < b && profile[x as usize] == minimum;
            if on && run_start.is_none() {
                run_start = Some(x);
            }
            if !on
                && let Some(start) = run_start.take()
                && x - start > best_len
            {
                best_len = x - start;
                best_start = start;
            }
        }
        let cut = best_start * 16 + best_len * 8;
        output[i].x1 = cut;
        output[i].i1 = cut;
        output[i + 1].x0 = cut;
        output[i + 1].i0 = cut;
    }
    for character in output {
        let a = character.x0 / 16;
        let b = w.min((character.x1 + 15) / 16);
        let mut first = None;
        let mut last = 0;
        for x in a..b {
            if profile[x as usize] > peak / 4 {
                first.get_or_insert(x);
                last = x;
            }
        }
        if let Some(first) = first {
            let i0 = character.x0.max(first * 16);
            let i1 = character.x1.min((last + 1) * 16);
            if i1 > i0 {
                character.i0 = i0;
                character.i1 = i1;
                character.c = (i0 + i1) / 2;
            }
        }
    }
}
