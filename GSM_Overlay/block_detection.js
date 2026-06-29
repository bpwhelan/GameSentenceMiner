(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.GSMBlockDetection = api;
  }
}(typeof window !== 'undefined' ? window : globalThis, function () {
  // Block detection is intentionally simple: two text boxes belong to the same
  // block when the empty space between them is small relative to the text
  // height. Text that is far apart stays in separate blocks. Thresholds scale
  // with the text height so the same rule works at any font size.
  const BLOCK_DETECTION_TUNING = Object.freeze({
    minHeightPercent: 0.8,        // floor for the text-height unit (in % of frame)
    fallbackHeightPercent: 1.8,   // text-height unit when nothing is measurable
    horizontalGapMultiplier: 1.2, // max horizontal gap to merge, in text heights
    verticalGapMultiplier: 0.9,   // max vertical gap to merge, in text heights
    // Stacked lines that share a horizontal column (consecutive lines of one
    // paragraph, even with an indented first line) tolerate a looser vertical
    // gap, since line spacing varies.
    alignedVerticalGapMultiplier: 1.6,
  });

  // Empty space between two intervals on one axis (0 if they overlap).
  function getAxisGap(minA, maxA, minB, maxB) {
    if (maxA < minB) {
      return minB - maxA;
    }
    if (maxB < minA) {
      return minA - maxB;
    }
    return 0;
  }

  // Overlapping length of two intervals on one axis (0 if they don't overlap).
  function getAxisOverlap(minA, maxA, minB, maxB) {
    return Math.max(0, Math.min(maxA, maxB) - Math.max(minA, minB));
  }

  function getMedianValue(values) {
    const sorted = (Array.isArray(values) ? values : [])
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    if (sorted.length === 0) {
      return 0;
    }
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  // Normalize each line's bounding_rect into a percent-space box.
  function buildLineMetrics(lines) {
    return (Array.isArray(lines) ? lines : []).map((line, index) => {
      const rect = (line && line.bounding_rect) || {};
      const xs = [Number(rect.x1) * 100, Number(rect.x3) * 100].filter(Number.isFinite);
      const ys = [Number(rect.y1) * 100, Number(rect.y3) * 100].filter(Number.isFinite);
      const x1 = xs.length ? Math.min(...xs) : 0;
      const x3 = xs.length ? Math.max(...xs) : 0;
      const y1 = ys.length ? Math.min(...ys) : 0;
      const y3 = ys.length ? Math.max(...ys) : 0;
      return { index, x1, y1, x3, y3, height: y3 - y1 };
    });
  }

  // Two boxes are "close" when the gaps between them fit within thresholds
  // derived from the text height. Thresholds scale by THIS pair's own height
  // (floored by `floorUnit`) rather than the global median, so a screen full of
  // small UI text can't shrink the unit and split apart the taller dialogue.
  function areBoxesClose(a, b, floorUnit, tuning) {
    const gapX = getAxisGap(a.x1, a.x3, b.x1, b.x3);
    const gapY = getAxisGap(a.y1, a.y3, b.y1, b.y3);
    const overlapX = getAxisOverlap(a.x1, a.x3, b.x1, b.x3);
    const unit = Math.max(floorUnit, (a.height + b.height) / 2);

    // Vertically-stacked lines that share a horizontal column are consecutive
    // lines of one paragraph (an indented first line still overlaps the body),
    // so judge them on the vertical gap alone with a looser allowance. Boxes
    // that don't share a column stay subject to both gap checks, which keeps
    // separate columns and far-apart UI in different blocks.
    if (overlapX > 0) {
      return gapY <= unit * tuning.alignedVerticalGapMultiplier;
    }
    return gapX <= unit * tuning.horizontalGapMultiplier
      && gapY <= unit * tuning.verticalGapMultiplier;
  }

  function detectTextBlocks(lines, tuning = BLOCK_DETECTION_TUNING) {
    const lineBlocks = new Map();
    const blockBoundaries = new Map();

    if (!Array.isArray(lines) || lines.length === 0) {
      return { lineBlocks, blockBoundaries, blockCount: 0 };
    }

    const metrics = buildLineMetrics(lines);
    // Floor for the per-pair text-height unit used by areBoxesClose, so a pair
    // of zero/near-zero height boxes still gets a sane threshold.
    const unit = Math.max(
      tuning.minHeightPercent,
      getMedianValue(metrics.map((m) => m.height).filter((h) => h > 0)) || tuning.fallbackHeightPercent
    );

    // Union-find: merge every pair of boxes that are close to each other.
    const parent = metrics.map((_, idx) => idx);
    const find = (idx) => {
      let root = idx;
      while (parent[root] !== root) {
        parent[root] = parent[parent[root]];
        root = parent[root];
      }
      return root;
    };
    const unite = (a, b) => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) {
        parent[rootB] = rootA;
      }
    };

    for (let i = 0; i < metrics.length; i++) {
      for (let j = i + 1; j < metrics.length; j++) {
        if (areBoxesClose(metrics[i], metrics[j], unit, tuning)) {
          unite(i, j);
        }
      }
    }

    // Group lines by their connected component and order blocks top-to-bottom,
    // then left-to-right, then by original line order.
    const components = new Map();
    for (let i = 0; i < metrics.length; i++) {
      const root = find(i);
      if (!components.has(root)) {
        components.set(root, []);
      }
      components.get(root).push(i);
    }

    const orderedComponents = Array.from(components.values())
      .map((memberIndexes) => ({
        memberIndexes,
        top: Math.min(...memberIndexes.map((idx) => metrics[idx].y1)),
        left: Math.min(...memberIndexes.map((idx) => metrics[idx].x1)),
        minIndex: Math.min(...memberIndexes),
      }))
      .sort((a, b) => (a.top - b.top) || (a.left - b.left) || (a.minIndex - b.minIndex));

    orderedComponents.forEach((component, blockId) => {
      for (const idx of component.memberIndexes) {
        lineBlocks.set(idx, blockId);
      }
      const sorted = component.memberIndexes.slice().sort((a, b) => a - b);
      blockBoundaries.set(blockId, { start: sorted[0], end: sorted[sorted.length - 1] });
    });

    return {
      lineBlocks,
      blockBoundaries,
      blockCount: orderedComponents.length,
    };
  }

  return {
    BLOCK_DETECTION_TUNING,
    areBoxesClose,
    buildLineMetrics,
    detectTextBlocks,
    getAxisGap,
    getAxisOverlap,
    getMedianValue,
  };
}));
