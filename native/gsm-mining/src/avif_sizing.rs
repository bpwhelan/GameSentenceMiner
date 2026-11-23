//! Bounded binary search for an approximate animated AVIF size using encoded samples.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AvifParameters {
    pub fps: u32,
    pub width: u32,
    pub crf: u32,
}

pub fn size_candidates(caps: AvifParameters, priority: &str) -> Vec<AvifParameters> {
    let mut candidates = vec![caps];
    let mut current = caps;
    let min_width = caps.width.min(240);
    let max_crf = caps.crf.max(56);

    if priority == "balanced" {
        while current.fps > 1 || current.width > min_width || current.crf < max_crf {
            let next_fps = ((current.fps as f64 * 0.85) as u32).max(1);
            let next_width = ((((current.width as f64 * 0.90) as u32) / 2) * 2).max(min_width);
            let next_crf = (current.crf + 2).min(max_crf);
            current = AvifParameters {
                fps: next_fps,
                width: next_width,
                crf: next_crf,
            };
            candidates.push(current);
        }
        return candidates;
    }

    let stages: [&str; 2] = if priority == "prefer_fps" {
        ["detail", "fps"]
    } else {
        ["fps", "detail"]
    };
    for stage in stages {
        if stage == "fps" {
            while current.fps > 1 {
                current.fps = ((current.fps as f64 * 0.75) as u32).max(1);
                candidates.push(current);
            }
        } else {
            while current.crf < max_crf {
                current.crf = (current.crf + 2).min(max_crf);
                candidates.push(current);
            }
            while current.width > min_width {
                current.width = ((((current.width as f64 * 0.75) as u32) / 2) * 2).max(min_width);
                candidates.push(current);
            }
        }
    }
    candidates
}

pub fn choose_size_parameters<F>(
    candidates: &[AvifParameters],
    target_bytes: u64,
    mut estimate: F,
) -> Result<(AvifParameters, u64), String>
where
    F: FnMut(AvifParameters) -> Result<u64, String>,
{
    let first_size = estimate(candidates[0])?;
    if first_size <= target_bytes || candidates.len() == 1 {
        return Ok((candidates[0], first_size));
    }
    let mut lower = 0usize;
    let mut upper = candidates.len() - 1;
    let mut upper_size = estimate(candidates[upper])?;
    if upper_size > target_bytes {
        return Ok((candidates[upper], upper_size));
    }
    while upper - lower > 1 {
        let middle = (lower + upper) / 2;
        let size = estimate(candidates[middle])?;
        if size <= target_bytes {
            upper = middle;
            upper_size = size;
        } else {
            lower = middle;
        }
    }
    Ok((candidates[upper], upper_size))
}

pub fn sample_ranges(start: f64, duration: f64) -> Vec<(f64, f64)> {
    if duration <= 3.0 {
        return vec![(start, duration)];
    }
    vec![
        (start, 1.0),
        (start + (duration - 1.0) / 2.0, 1.0),
        (start + duration - 1.0, 1.0),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_and_binary_search() {
        let caps = AvifParameters {
            fps: 15,
            width: 960,
            crf: 28,
        };
        let c = size_candidates(caps, "balanced");
        assert!(c.len() > 5);
        assert_eq!(c.last().unwrap().fps, 1);
        assert_eq!(c.last().unwrap().width, 240);
        assert_eq!(c.last().unwrap().crf, 56);
        let (picked, _) = choose_size_parameters(&c, 50_000, |p| {
            Ok((p.fps as u64) * (p.width as u64) * (64 - p.crf as u64))
        })
        .unwrap();
        assert!((picked.fps as u64) * (picked.width as u64) * (64 - picked.crf as u64) <= 50_000);
    }
}
