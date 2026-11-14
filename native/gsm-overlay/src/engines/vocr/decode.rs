// SPDX-License-Identifier: GPL-3.0-or-later
//! Faithful textspot8 integer decoding and reading order, adapted from
//! bee-san/vita-vn-ocr at 205f47ec4e56ca87c00e7dba0a61c9aaec726707.
use anyhow::{Result, ensure};
use image::GrayImage;
use serde::Serialize;
use std::collections::{BTreeMap, VecDeque};

#[derive(Clone, Debug, Default, Serialize)]
pub struct Box {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub vertical: i64,
    pub conf: i64,
    pub dark: i64,
    pub block: usize,
    pub tag: i64,
    pub tconf: i64,
}
impl Box {
    fn key(&self) -> (i64, i64, i64, i64, i64, i64, i64, i64, i64) {
        (
            self.x,
            self.y,
            self.w,
            self.h,
            self.vertical,
            self.conf,
            self.dark,
            self.tag,
            self.tconf,
        )
    }
    pub fn edges(&self) -> [f64; 4] {
        [
            self.x as f64,
            self.y as f64,
            (self.x + self.w) as f64,
            (self.y + self.h) as f64,
        ]
    }
}
pub struct Found {
    pub boxes: Vec<Box>,
    pub truncated: bool,
}
pub fn dark(grey: &GrayImage, b: &Box) -> i64 {
    let mut border = vec![];
    let mut histogram = [0i64; 256];
    for y in b.y..b.y + b.h {
        for x in b.x..b.x + b.w {
            histogram[grey[(x as u32, y as u32)][0] as usize] += 1;
        }
    }
    for x in b.x..b.x + b.w {
        border.push(grey[(x as u32, b.y as u32)][0]);
        border.push(grey[(x as u32, (b.y + b.h - 1) as u32)][0]);
    }
    for y in b.y..b.y + b.h {
        border.push(grey[(b.x as u32, y as u32)][0]);
        border.push(grey[((b.x + b.w - 1) as u32, y as u32)][0]);
    }
    border.sort_unstable();
    let background = i64::from(border[border.len() / 2]);
    let first = |k: i64| {
        let mut sum = 0;
        for (v, &count) in histogram.iter().enumerate() {
            sum += count;
            if sum >= k {
                return v as i64;
            }
        }
        255
    };
    let delta = 16.max((first(b.w * b.h * 98 / 100) - first(b.w * b.h * 2 / 100)) / 4);
    let mut low = 0;
    let mut high = 0;
    for (v, &n) in histogram.iter().enumerate() {
        if (v as i64) < background - delta {
            low += n;
        }
        if (v as i64) > background + delta {
            high += n;
        }
    }
    i64::from(low > 8 * high)
}
pub fn maps(
    head: &[f32],
    shape: &[i64],
    height: usize,
    width: usize,
    tags: usize,
) -> Result<(Vec<i64>, usize, usize)> {
    ensure!(
        shape.len() == 4
            && shape[0] == 1
            && shape[1] == ((4 + tags) * 4) as i64
            && shape[2] > 0
            && shape[3] > 0
            && shape[2] <= 136
            && shape[3] <= 240,
        "Invalid VOCR detector tensor"
    );
    let (rows, cols) = (shape[2] as usize, shape[3] as usize);
    let (h, w) = (height.div_ceil(4), width.div_ceil(4));
    ensure!(
        h <= rows * 2 && w <= cols * 2 && head.len() == (4 + tags) * 4 * rows * cols,
        "Invalid VOCR detector map size"
    );
    let mut result = vec![0; (4 + tags) * h * w];
    for c in 0..4 + tags {
        for y in 0..h {
            for x in 0..w {
                let sub = (y % 2) * 2 + x % 2;
                let channel = if c < 4 {
                    sub * 4 + c
                } else {
                    16 + sub * tags + c - 4
                };
                let value = head[(channel * rows + y / 2) * cols + x / 2];
                ensure!(
                    value.is_finite() && value.abs() <= 1_000_000.,
                    "Invalid VOCR detector value"
                );
                result[(c * h + y) * w + x] = value as i64;
            }
        }
    }
    Ok((result, h, w))
}
pub fn spot(
    maps: &[i64],
    channels: usize,
    rows: usize,
    cols: usize,
    grey: &GrayImage,
) -> Result<Found> {
    ensure!(
        (4..=16).contains(&channels)
            && rows > 0
            && cols > 0
            && rows <= 136
            && cols <= 240
            && maps.len() == channels * rows * cols,
        "Invalid VOCR detection maps"
    );
    let plane = rows * cols;
    let mut seen = vec![false; plane];
    let mut candidates = vec![];
    for start in 0..plane {
        if seen[start] || maps[start] <= 0 {
            continue;
        }
        seen[start] = true;
        let mut queue = VecDeque::from([start]);
        let mut cells = vec![];
        while let Some(i) = queue.pop_front() {
            cells.push(i);
            let (y, x) = (i / cols, i % cols);
            for next in [
                if x > 0 { Some(i - 1) } else { None },
                if x + 1 < cols { Some(i + 1) } else { None },
                if y > 0 { Some(i - cols) } else { None },
                if y + 1 < rows { Some(i + cols) } else { None },
            ]
            .into_iter()
            .flatten()
            {
                if !seen[next] && maps[next] > 0 {
                    seen[next] = true;
                    queue.push_back(next);
                }
            }
        }
        let n = cells.len() as i64;
        if n < 2 {
            continue;
        }
        let sums: Vec<i64> = (0..channels)
            .map(|c| cells.iter().map(|&i| maps[c * plane + i]).sum())
            .collect();
        let conf = sums[0].div_euclid(n);
        if conf < 1 {
            continue;
        }
        let vertical = sums[1] > 0;
        let mut c2 = 0;
        let mut lo = i64::MAX;
        let mut hi = 0;
        for &i in &cells {
            let (across, along) = if vertical {
                (i % cols, i / cols)
            } else {
                (i / cols, i % cols)
            };
            c2 += 8 * across as i64 + 3;
            lo = lo.min(along as i64);
            hi = hi.max(along as i64);
        }
        let near = (2 * (c2 - sums[2])).div_euclid(2 * n);
        let far = -(-2 * (c2 + sums[3])).div_euclid(2 * n);
        let across = far - near;
        if across < 8 {
            continue;
        }
        let pad = 2.max((across * 18 + 50) / 100);
        let (a0, a1, b0, b1) = (near - pad, far + pad, 8 * lo - pad, 8 * (hi + 1) + pad);
        let (x0, y0, x1, y1) = if vertical {
            (a0, b0, a1, b1)
        } else {
            (b0, a0, b1, a1)
        };
        let (x0, y0, x1, y1) = (
            x0.max(0),
            y0.max(0),
            x1.min(grey.width() as i64),
            y1.min(grey.height() as i64),
        );
        if x1 <= x0 || y1 <= y0 {
            continue;
        }
        let mut scores = vec![0];
        scores.extend_from_slice(&sums[4..]);
        let mut tag = 0;
        for i in 1..scores.len() {
            if scores[i] > scores[tag] {
                tag = i;
            }
        }
        let second = scores
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != tag)
            .map(|(_, s)| *s)
            .max();
        let tconf = second
            .map(|s| 127.min((scores[tag] - s).div_euclid(n)))
            .unwrap_or(0);
        let b = Box {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
            vertical: i64::from(vertical),
            conf,
            tag: tag as i64,
            tconf,
            ..Default::default()
        };
        candidates.push(((-conf, -n, b.vertical, b.y, b.x, b.h, b.w, b.tag), b));
    }
    candidates.sort_by_key(|(key, _)| *key);
    let truncated = candidates.len() > 64;
    let mut boxes: Vec<_> = candidates
        .into_iter()
        .take(64)
        .map(|(_, mut b)| {
            b.dark = dark(grey, &b);
            b
        })
        .collect();
    boxes = order(boxes);
    Ok(Found { boxes, truncated })
}
fn joins(a: &Box, b: &Box) -> bool {
    if a.vertical != b.vertical || a.tag != b.tag {
        return false;
    }
    let (overlap, gap, sa, sb) = if a.vertical != 0 {
        (
            (a.y + a.h).min(b.y + b.h) - a.y.max(b.y),
            a.x.max(b.x) - (a.x + a.w).min(b.x + b.w),
            a.w,
            b.w,
        )
    } else {
        (
            (a.x + a.w).min(b.x + b.w) - a.x.max(b.x),
            a.y.max(b.y) - (a.y + a.h).min(b.y + b.h),
            a.h,
            b.h,
        )
    };
    overlap > 0 && gap <= sa.max(sb) && 2 * sa.max(sb) <= 3 * sa.min(sb)
}
fn root(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}
fn order_members(mut members: Vec<Box>) -> Vec<Box> {
    let vertical = members[0].vertical != 0;
    members.sort_by_key(|b| {
        if vertical {
            (-(b.x + b.w), b.y, b.x, b.w, b.h)
        } else {
            (b.y, b.x, b.h, b.w, 0)
        }
    });
    let mut output = vec![];
    let mut run: Vec<Box> = vec![];
    let flush = |run: &mut Vec<Box>, out: &mut Vec<Box>| {
        run.sort_by_key(|b| {
            if vertical {
                (b.y, -(b.x + b.w), b.h, b.w)
            } else {
                (b.x, b.y, b.h, b.w)
            }
        });
        out.append(run);
    };
    for b in members {
        if let Some(f) = run.first() {
            let (lo, size, flo, fsize) = if vertical {
                (b.x, b.w, f.x, f.w)
            } else {
                (b.y, b.h, f.y, f.h)
            };
            if 2 * ((lo + size).min(flo + fsize) - lo.max(flo)) < size.min(fsize) {
                flush(&mut run, &mut output);
            }
        }
        run.push(b);
    }
    flush(&mut run, &mut output);
    output
}
fn order(mut boxes: Vec<Box>) -> Vec<Box> {
    boxes.sort_by_key(Box::key);
    let mut parent: Vec<_> = (0..boxes.len()).collect();
    for i in 0..boxes.len() {
        for j in i + 1..boxes.len() {
            if joins(&boxes[i], &boxes[j]) {
                let (a, b) = (root(&mut parent, i), root(&mut parent, j));
                parent[a.max(b)] = a.min(b);
            }
        }
    }
    let mut groups: BTreeMap<usize, Vec<Box>> = BTreeMap::new();
    for (i, b) in boxes.into_iter().enumerate() {
        groups.entry(root(&mut parent, i)).or_default().push(b);
    }
    let mut blocks: Vec<(Box, Vec<Box>)> = groups
        .into_values()
        .map(|members| {
            let x = members.iter().map(|b| b.x).min().unwrap();
            let y = members.iter().map(|b| b.y).min().unwrap();
            let right = members.iter().map(|b| b.x + b.w).max().unwrap();
            let bottom = members.iter().map(|b| b.y + b.h).max().unwrap();
            (
                Box {
                    x,
                    y,
                    w: right - x,
                    h: bottom - y,
                    vertical: members[0].vertical,
                    tag: members[0].tag,
                    ..Default::default()
                },
                order_members(members),
            )
        })
        .collect();
    blocks.sort_by_key(|(b, _)| (b.y, b.x, b.h, b.w, b.tag));
    let mut run: Vec<(Box, Vec<Box>)> = vec![];
    let mut output = vec![];
    let mut block = 0;
    let mut flush = |run: &mut Vec<(Box, Vec<Box>)>, out: &mut Vec<Box>| {
        let vertical = run.iter().all(|(b, _)| b.vertical != 0);
        run.sort_by_key(|(b, _)| {
            (
                if vertical { -(b.x + b.w) } else { b.x },
                b.y,
                b.h,
                b.w,
                b.tag,
            )
        });
        for (_, mut members) in run.drain(..) {
            for b in &mut members {
                b.block = block;
            }
            out.append(&mut members);
            block += 1;
        }
    };
    for pair in blocks {
        if let Some((f, _)) = run.first() {
            let b = &pair.0;
            if 2 * ((b.y + b.h).min(f.y + f.h) - b.y.max(f.y)) < b.h.min(f.h) {
                flush(&mut run, &mut output);
            }
        }
        run.push(pair);
    }
    flush(&mut run, &mut output);
    output
}
