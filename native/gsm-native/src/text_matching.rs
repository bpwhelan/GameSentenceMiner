//! The string-only, no-junk variant of difflib's matching-block algorithm.
//! Keep its earliest-a/earliest-b tie breaking: edit distance is not equivalent.

use std::collections::HashMap;

type Block = (usize, usize, usize);

#[derive(Debug, PartialEq)]
pub struct MatchMetrics {
    pub covered: usize,
    pub longest: usize,
    pub matched: usize,
    pub reference_len: usize,
    pub candidate_len: usize,
}

fn longest_match(
    a: &[char],
    positions: &HashMap<char, Vec<usize>>,
    alo: usize,
    ahi: usize,
    blo: usize,
    bhi: usize,
) -> Block {
    let mut best = (alo, blo, 0);
    // Sparse dynamic programming, without allocating a hash table per row.
    // A stamp identifies which a-row produced each length; stale rows mean 0.
    let mut rows = vec![usize::MAX; bhi - blo];
    let mut lengths = vec![0; bhi - blo];
    for (i, ch) in a.iter().enumerate().take(ahi).skip(alo) {
        let Some(indices) = positions.get(ch) else {
            continue;
        };
        let start = indices.partition_point(|&j| j < blo);
        let end = indices.partition_point(|&j| j < bhi);
        // Descending j leaves the previous row's j-1 entry intact.
        for &j in indices[start..end].iter().rev() {
            let offset = j - blo;
            let size = if offset > 0 && i > alo && rows[offset - 1] == i - 1 {
                lengths[offset - 1] + 1
            } else {
                1
            };
            rows[offset] = i;
            lengths[offset] = size;
            let block = (i + 1 - size, j + 1 - size, size);
            if size > best.2 || (size == best.2 && (block.0, block.1) < (best.0, best.1)) {
                best = block;
            }
        }
    }
    best
}

pub fn match_metrics(reference: &str, candidate: &str, minimum: usize) -> MatchMetrics {
    let a: Vec<char> = reference.chars().collect();
    let b: Vec<char> = candidate.chars().collect();
    let mut metrics = MatchMetrics {
        covered: 0,
        longest: 0,
        matched: 0,
        reference_len: a.len(),
        candidate_len: b.len(),
    };
    if a == b {
        metrics.covered = if a.len() >= minimum { a.len() } else { 0 };
        metrics.longest = a.len();
        metrics.matched = a.len();
        return metrics;
    }
    if a.is_empty() || b.is_empty() {
        return metrics;
    }
    let mut positions: HashMap<char, Vec<usize>> = HashMap::new();
    for (j, ch) in b.iter().enumerate() {
        positions.entry(*ch).or_default().push(j);
    }
    let mut pending = vec![(0, a.len(), 0, b.len())];
    let mut blocks = Vec::new();
    while let Some((alo, ahi, blo, bhi)) = pending.pop() {
        let (i, j, size) = longest_match(&a, &positions, alo, ahi, blo, bhi);
        if size == 0 {
            continue;
        }
        blocks.push((i, j, size));
        if alo < i && blo < j {
            pending.push((alo, i, blo, j));
        }
        if i + size < ahi && j + size < bhi {
            pending.push((i + size, ahi, j + size, bhi));
        }
    }
    blocks.sort_unstable();
    let mut merged: Vec<Block> = Vec::with_capacity(blocks.len());
    for block in blocks {
        if let Some(last) = merged.last_mut() {
            if last.0 + last.2 == block.0 && last.1 + last.2 == block.1 {
                last.2 += block.2;
                continue;
            }
        }
        merged.push(block);
    }
    for (_, _, size) in merged {
        metrics.matched += size;
        metrics.longest = metrics.longest.max(size);
        if size >= minimum {
            metrics.covered += size;
        }
    }
    metrics
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ties_follow_difflib_and_are_asymmetric() {
        assert_eq!(match_metrics("tide", "diet", 1).matched, 1);
        assert_eq!(match_metrics("diet", "tide", 1).matched, 2);
        assert_eq!(match_metrics("ab", "acab", 2).longest, 2);
    }

    #[test]
    fn counts_characters_and_filters_small_blocks() {
        let result = match_metrics("日😀本", "日𠀀本", 2);
        assert_eq!(result.covered, 0);
        assert_eq!(result.longest, 1);
        assert_eq!(result.matched, 2);
        assert_eq!(result.candidate_len, 3);
        assert_eq!(match_metrics("", "", 1).matched, 0);
    }

    #[test]
    fn popular_characters_are_never_junk() {
        let a = "ab".repeat(200);
        let b = "ba".repeat(200);
        assert_eq!(match_metrics(&a, &b, 2).matched, 399);
    }
}
