// SPDX-License-Identifier: GPL-3.0-or-later
//! Bounded gradient fallback for textspot8 captures exceeding its 64-box cap.
use super::decode::{Box, Found, dark};
use image::GrayImage;

pub fn find(grey: &GrayImage) -> Found {
    let (w, h) = (grey.width() as usize, grey.height() as usize);
    if w == 0 || h == 0 {
        return Found {
            boxes: vec![],
            truncated: false,
        };
    }
    let mut contrast = vec![0u8; w * h];
    let mut histogram = [0usize; 256];
    for y in 0..h {
        for x in 0..w {
            let (mut lo, mut hi) = (255, 0);
            for yy in y.saturating_sub(1)..=(y + 1).min(h - 1) {
                for xx in x.saturating_sub(1)..=(x + 1).min(w - 1) {
                    let p = grey[(xx as u32, yy as u32)][0];
                    lo = lo.min(p);
                    hi = hi.max(p);
                }
            }
            contrast[y * w + x] = hi - lo;
            histogram[(hi - lo) as usize] += 1;
        }
    }
    let mut sum = 0;
    let mut p99 = 255;
    for (i, &count) in histogram.iter().enumerate() {
        sum += count;
        if sum * 100 >= w * h * 99 {
            p99 = i;
            break;
        }
    }
    let threshold = 40.max(2 * p99 / 5);
    let on: Vec<_> = contrast.iter().map(|&p| p as usize >= threshold).collect();
    let mut kept = vec![false; w * h];
    let mut profile = vec![0usize; h];
    for y in 0..h {
        let mut start = None;
        let mut last = 0;
        for x in 0..=w {
            if x < w && on[y * w + x] {
                if start.is_none() {
                    start = Some(x);
                } else if x - last > 10 {
                    let s = start.unwrap();
                    if last + 1 - s >= 16 {
                        kept[y * w + s..y * w + last + 1].fill(true);
                        profile[y] += last + 1 - s;
                    }
                    start = Some(x);
                }
                last = x;
            } else if x == w
                && let Some(s) = start
                && last + 1 - s >= 16
            {
                kept[y * w + s..y * w + last + 1].fill(true);
                profile[y] += last + 1 - s;
            }
        }
    }
    let threshold = 16.max(profile.iter().copied().max().unwrap_or(0) / 16);
    let active: Vec<_> = profile.iter().map(|&n| n >= threshold).collect();
    let mut bands = vec![];
    let mut y = 0;
    while y < h {
        if !active[y] {
            y += 1;
            continue;
        }
        let (mut start, mut run_start, mut last) = (y, y, y);
        y += 1;
        while y < h && (active[y] || y - last <= 2) {
            if active[y] {
                if y - last > 1 {
                    let mut k = y;
                    while k < h && active[k] {
                        k += 1;
                    }
                    if profile[last + 1..y].contains(&0) && last + 1 - run_start >= 8 && k - y >= 8
                    {
                        bands.push((start, last + 1));
                        start = y;
                    }
                    run_start = y;
                }
                last = y;
            }
            y += 1;
        }
        if last + 1 - start >= 8 {
            bands.push((start, last + 1));
        }
    }
    let mut candidates = vec![];
    for (i, &(a, b)) in bands.iter().enumerate() {
        let height = b - a;
        let kc: Vec<usize> = (0..w)
            .map(|x| (a..b).filter(|&y| kept[y * w + x]).count())
            .collect();
        let columns: Vec<_> = (0..w).filter(|&x| kc[x] > 0).collect();
        if columns.is_empty() {
            continue;
        }
        let mut start = 0;
        let (mut x1, mut x2, mut mass) = (0, 0, 0);
        for end in 0..columns.len() {
            if end + 1 == columns.len() || columns[end + 1] - columns[end] > 2 * height {
                let current = kc[columns[start]..=columns[end]].iter().sum();
                if current > mass {
                    mass = current;
                    x1 = columns[start];
                    x2 = columns[end] + 1;
                }
                start = end + 1;
            }
        }
        let oc: Vec<_> = (0..w).map(|x| (a..b).any(|y| on[y * w + x])).collect();
        let gap = 4.max(height);
        for (x, &is_on) in oc.iter().enumerate().skip(x2) {
            if is_on {
                if x - (x2 - 1) > gap {
                    break;
                }
                x2 = x + 1;
            }
        }
        for x in (0..x1).rev() {
            if oc[x] {
                if x1 - x > gap {
                    break;
                }
                x1 = x;
            }
        }
        let up = (height / 2).min(if i > 0 { (a - bands[i - 1].1) / 2 } else { a });
        let down = (height / 2).min(if i + 1 < bands.len() {
            (bands[i + 1].0 - b) / 2
        } else {
            h - b
        });
        let rows_on: Vec<usize> = (0..h)
            .map(|y| (x1..x2).filter(|&x| on[y * w + x]).count())
            .collect();
        let (mut top, mut bottom) = (a, b);
        while a - top < up && rows_on[top - 1] >= 2 {
            top -= 1;
        }
        while bottom - b < down && rows_on[bottom] >= 2 {
            bottom += 1;
        }
        candidates.push((x1, top, x2, bottom));
    }
    let mut boxes = vec![];
    let mut truncated = false;
    let mut heights: Vec<_> = candidates
        .iter()
        .map(|&(_, top, _, bottom)| bottom - top)
        .collect();
    heights.sort_unstable();
    if !heights.is_empty() {
        let median = heights[heights.len() / 2];
        for (left, top, right, bottom) in candidates {
            if 100 * (bottom - top) < 55 * median {
                continue;
            }
            if boxes.len() == 16 {
                truncated = true;
                break;
            }
            let x = left.saturating_sub(3) as i64;
            let y = top.saturating_sub(3) as i64;
            let mut b = Box {
                x,
                y,
                w: (right + 3).min(w) as i64 - x,
                h: (bottom + 3).min(h) as i64 - y,
                conf: 127,
                ..Default::default()
            };
            b.dark = dark(grey, &b);
            boxes.push(b);
        }
    }
    Found { boxes, truncated }
}
