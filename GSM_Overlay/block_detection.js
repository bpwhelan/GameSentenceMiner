(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.GSMBlockDetection = api;
  }
}(typeof window !== 'undefined' ? window : globalThis, function () {
  // Input rects are normalized [0..1]; we work in "percent of viewport"
  // (0..100) internally so the thresholds below read naturally.
  const BLOCK_DETECTION_TUNING = Object.freeze({
    // Minimum (overlap / smaller line height) for two lines to count as the
    // same visual row.
    sameRowOverlapRatio: 0.3,

    // Horizontal gap (as a multiple of median line height) above which we
    // start treating the gap as a candidate column boundary.
    columnGapMedianHeightMultiplier: 1.0,

    // X-overlap ratio needed for two candidate gaps in different rows to be
    // considered "the same column boundary".
  columnClusterOverlapRatio: 0.5,

    // A column boundary only counts if at least this many distinct rows show
    // it. This is the key rule that prevents over-segmentation: a single line
    // broken up by a wide space stays one block.
    minRowsForColumn: 2,

    // Vertically adjacent rows merge if their gap is at most this multiple of
    // the median line height.
    rowGapMedianHeightMultiplier: 1.6,

    // Floor / fallback for the median line height in percent units, so very
    // small OCR boxes don't yield nonsense thresholds.
    minMedianHeightPercent: 0.8,
    fallbackMedianHeightPercent: 1.8,
  });

  function getAxisGap(minA, maxA, minB, maxB) {
    if (maxA < minB) return minB - maxA;
    if (maxB < minA) return minA - maxB;
    return 0;
  }

  function getAxisOverlap(minA, maxA, minB, maxB) {
    return Math.max(0, Math.min(maxA, maxB) - Math.max(minA, minB));
  }

  function getMedianValue(values) {
    if (!Array.isArray(values) || values.length === 0) return 0;
    const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  function buildLineMetrics(lines) {
    return (Array.isArray(lines) ? lines : []).map((line, index) => {
      const rect = line && line.bounding_rect ? line.bounding_rect : {};
      const ax1 = Number(rect.x1) * 100;
      const ay1 = Number(rect.y1) * 100;
      const ax3 = Number(rect.x3) * 100;
      const ay3 = Number(rect.y3) * 100;

      const sx1 = Number.isFinite(ax1) ? ax1 : 0;
      const sy1 = Number.isFinite(ay1) ? ay1 : 0;
      const sx3 = Number.isFinite(ax3) ? ax3 : sx1;
      const sy3 = Number.isFinite(ay3) ? ay3 : sy1;

      const x1 = Math.min(sx1, sx3);
      const y1 = Math.min(sy1, sy3);
      const x3 = Math.max(sx1, sx3);
      const y3 = Math.max(sy1, sy3);

      return {
        index,
        x1,
        y1,
        x3,
        y3,
        width: Math.max(0.1, x3 - x1),
        height: Math.max(0.1, y3 - y1),
      };
    });
  }

  // Group line metrics into rows by vertical overlap. Returns rows sorted
  // top-to-bottom; each row's items are sorted left-to-right.
  function groupIntoRows(metrics, tuning) {
    const sorted = [...metrics].sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1);
    const rows = [];

    for (const m of sorted) {
      let target = null;
      for (const row of rows) {
        const overlap = getAxisOverlap(row.yMin, row.yMax, m.y1, m.y3);
        if (overlap <= 0) continue;
        const minH = Math.min(row.yMax - row.yMin, m.height);
        if (minH > 0 && overlap / minH >= tuning.sameRowOverlapRatio) {
          target = row;
          break;
        }
      }
      if (!target) {
        target = { yMin: m.y1, yMax: m.y3, items: [] };
        rows.push(target);
      }
      target.items.push(m);
      target.yMin = Math.min(target.yMin, m.y1);
      target.yMax = Math.max(target.yMax, m.y3);
    }

    for (const r of rows) r.items.sort((a, b) => a.x1 - b.x1);
    rows.sort((a, b) => a.yMin - b.yMin);
    return rows;
  }

  // Detect vertical "column separator" strips: empty x-corridors confirmed by
  // at least `minRowsForColumn` distinct rows. This keeps single-row layouts
  // from being split while reliably catching real multi-column layouts.
  function findColumnSeparators(rows, medianHeight, tuning) {
    const minGap = medianHeight * tuning.columnGapMedianHeightMultiplier;
    const candidates = [];

    rows.forEach((row, rowIdx) => {
      for (let i = 0; i < row.items.length - 1; i++) {
        const left = row.items[i];
        const right = row.items[i + 1];
        const gap = right.x1 - left.x3;
        if (gap > minGap) {
          candidates.push({ xStart: left.x3, xEnd: right.x1, rowIdx });
        }
      }
    });

    const clusters = [];
    for (const cand of candidates) {
      let matched = null;
      for (const cluster of clusters) {
        const overlap = getAxisOverlap(cluster.xStart, cluster.xEnd, cand.xStart, cand.xEnd);
        if (overlap <= 0) continue;
        const minWidth = Math.min(cluster.xEnd - cluster.xStart, cand.xEnd - cand.xStart);
        if (minWidth > 0 && overlap / minWidth >= tuning.columnClusterOverlapRatio) {
          matched = cluster;
          break;
        }
      }
      if (matched) {
        // Intersection of the two intervals: the strictly empty corridor.
        matched.xStart = Math.max(matched.xStart, cand.xStart);
        matched.xEnd = Math.min(matched.xEnd, cand.xEnd);
        matched.rows.add(cand.rowIdx);
      } else {
        clusters.push({
          xStart: cand.xStart,
          xEnd: cand.xEnd,
          rows: new Set([cand.rowIdx]),
        });
      }
    }

    return clusters
      .filter((c) => c.xEnd > c.xStart && c.rows.size >= tuning.minRowsForColumn)
      .map((c) => ({ xStart: c.xStart, xEnd: c.xEnd }));
  }

  function rangeCrossesSeparator(xLo, xHi, separators) {
    if (xHi <= xLo) return false;
    for (const sep of separators) {
      if (getAxisOverlap(xLo, xHi, sep.xStart, sep.xEnd) > 0) return true;
    }
    return false;
  }

  // Returns true if any item in a different row (within maxRowGap vertically)
  // has a horizontal x-overlap with `item`. Used to detect whether an item is
  // "isolated" (only on one visual row) vs. part of a multi-row run.
  function hasVerticalNeighbor(item, rowIndex, rows, maxRowGap) {
    for (let ri = 0; ri < rows.length; ri++) {
      if (ri === rowIndex) continue;
      const row = rows[ri];
      if (getAxisGap(item.y1, item.y3, row.yMin, row.yMax) > maxRowGap) continue;
      for (const other of row.items) {
        if (getAxisOverlap(item.x1, item.x3, other.x1, other.x3) > 0) return true;
      }
    }
    return false;
  }

  function detectTextBlocks(lines, tuning = BLOCK_DETECTION_TUNING) {
    const lineBlocks = new Map();
    const blockBoundaries = new Map();

    if (!Array.isArray(lines) || lines.length === 0) {
      return { lineBlocks, blockBoundaries, blockCount: 0 };
    }

    const metrics = buildLineMetrics(lines);
    const heights = metrics.map((m) => m.height).filter((h) => h > 0);
    const medianHeight = Math.max(
      tuning.minMedianHeightPercent,
      getMedianValue(heights) || tuning.fallbackMedianHeightPercent
    );

    const rows = groupIntoRows(metrics, tuning);
    const separators = findColumnSeparators(rows, medianHeight, tuning);
    const maxRowGap = medianHeight * tuning.rowGapMedianHeightMultiplier;

    const parent = metrics.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const unite = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };

    // 1. Merge horizontally-adjacent lines within each row, unless:
    //    a) their gap sits inside a confirmed column separator, or
    //    b) they are "asymmetric": one item continues into adjacent rows
    //       (has vertical neighbors) and the other is isolated to this row.
    //       This catches the common "character name + dialogue" layout where
    //       the name only appears on one row while dialogue spans several.
    //       Two truly isolated items (neither has neighbors, e.g. a single
    //       two-item row with no other content) still merge as one block.
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      for (let i = 0; i < row.items.length - 1; i++) {
        const a = row.items[i];
        const b = row.items[i + 1];
        if (rangeCrossesSeparator(a.x3, b.x1, separators)) continue;
        if (b.x1 > a.x3) {
          // There is a gap between items — check for the asymmetric pattern.
          const aHasNeighbor = hasVerticalNeighbor(a, ri, rows, maxRowGap);
          const bHasNeighbor = hasVerticalNeighbor(b, ri, rows, maxRowGap);
          if (aHasNeighbor !== bHasNeighbor) continue;
        }
        unite(a.index, b.index);
      }
    }

    // 2. Merge vertically-adjacent rows where lines overlap horizontally and
    //    that overlap doesn't fall inside a column separator.
    for (let ri = 0; ri < rows.length - 1; ri++) {
      const upper = rows[ri];
      const lower = rows[ri + 1];
      const vGap = lower.yMin - upper.yMax;
      if (vGap > maxRowGap) continue;

      for (const a of upper.items) {
        for (const b of lower.items) {
          const xLo = Math.max(a.x1, b.x1);
          const xHi = Math.min(a.x3, b.x3);
          if (xHi <= xLo) continue;
          if (rangeCrossesSeparator(xLo, xHi, separators)) continue;
          unite(a.index, b.index);
        }
      }
    }

    // Collect components and order them top-to-bottom, left-to-right.
    const components = new Map();
    for (let i = 0; i < metrics.length; i++) {
      const root = find(i);
      if (!components.has(root)) components.set(root, []);
      components.get(root).push(i);
    }

    const ordered = Array.from(components.values())
      .map((memberIndexes) => {
        let top = Infinity;
        let left = Infinity;
        let minIndex = Infinity;
        for (const idx of memberIndexes) {
          const m = metrics[idx];
          if (m.y1 < top) top = m.y1;
          if (m.x1 < left) left = m.x1;
          if (idx < minIndex) minIndex = idx;
        }
        return { memberIndexes, top, left, minIndex };
      })
      .sort((a, b) => (a.top - b.top) || (a.left - b.left) || (a.minIndex - b.minIndex));

    ordered.forEach((component, blockId) => {
      for (const idx of component.memberIndexes) {
        lineBlocks.set(idx, blockId);
      }
    });

    for (let i = 0; i < lines.length; i++) {
      const blockId = lineBlocks.get(i);
      if (blockId === undefined) continue;
      const existing = blockBoundaries.get(blockId);
      if (!existing) {
        blockBoundaries.set(blockId, { start: i, end: i });
      } else {
        if (i < existing.start) existing.start = i;
        if (i > existing.end) existing.end = i;
      }
    }

    return { lineBlocks, blockBoundaries, blockCount: ordered.length };
  }

  return {
    BLOCK_DETECTION_TUNING,
    buildLineMetrics,
    detectTextBlocks,
    findColumnSeparators,
    getAxisGap,
    getAxisOverlap,
    getMedianValue,
    groupIntoRows,
  };
}));
