(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.GSMBlockDetection = api;
  }
}(typeof window !== 'undefined' ? window : globalThis, function () {
  const BLOCK_DETECTION_TUNING = Object.freeze({
    minDimensionPercent: 0.1,
    minMedianHeightPercent: 0.8,
    fallbackMedianHeightPercent: 1.8,
    sameRow: Object.freeze({
      verticalOverlapRatioMin: 0.35,
      centerYMultiplier: 1.0,
      centerYMinPercent: 1.0,
      centerYMaxPercent: 4.0,
      horizontalGapWidthMultiplier: 0.5,
      horizontalGapPaddingPercent: 3,
      horizontalGapMinPercent: 4,
      horizontalGapMaxPercent: 32,
    }),
    crossRow: Object.freeze({
      verticalGapMinPercent: 1.2,
      verticalGapMedianHeightMultiplier: 0.9,
      verticalGapAvgHeightMultiplier: 0.85,
      centerYMinPercent: 1.5,
      centerYMedianHeightMultiplier: 1.1,
      centerYAvgHeightMultiplier: 1.1,
      xOverlapRatioMin: 0.28,
      minCharWidthPercent: 0.15,
      leftEdgeDiffMinPercent: 2,
      leftEdgeDiffCharWidthMultiplier: 3,
      horizontalGapMinPercent: 3.5,
      horizontalGapCharWidthMultiplier: 4.5,
    }),
    crossRowRelaxed: Object.freeze({
      verticalGapMedianHeightMultiplier: 1.7,
      verticalGapAvgHeightMultiplier: 1.5,
      centerYMedianHeightMultiplier: 2.4,
      centerYAvgHeightMultiplier: 2.2,
      xSpanCoverageRatioMin: 0.18,
      edgeDiffMinPercent: 3,
      edgeDiffCharWidthMultiplier: 6,
      centerXMinPercent: 5,
      centerXWidthMultiplier: 0.65,
    }),
    persistentGap: Object.freeze({
      minGapPercent: 8,
      gapMedianHeightMultiplier: 2,
      rowVerticalOverlapRatioMin: 0.35,
      rowCenterYMinPercent: 1,
      rowCenterYMedianHeightMultiplier: 1.15,
      intervalOverlapRatioMin: 0.55,
      minSupportingRows: 2,
      distinctRowMinSeparationMultiplier: 0.55,
      minVerticalSpanMultiplier: 1.6,
      minSeparatorWidthPercent: 5,
    }),
  });

  function getAxisGap(minA, maxA, minB, maxB) {
    if (maxA < minB) {
      return minB - maxA;
    }
    if (maxB < minA) {
      return minA - maxB;
    }
    return 0;
  }

  function getAxisOverlap(minA, maxA, minB, maxB) {
    return Math.max(0, Math.min(maxA, maxB) - Math.max(minA, minB));
  }

  function getMedianValue(values) {
    if (!Array.isArray(values) || values.length === 0) {
      return 0;
    }
    const sorted = values
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    if (sorted.length === 0) {
      return 0;
    }
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
  }

  function orderMetricsByX(lineA, lineB) {
    return lineA.x1 <= lineB.x1
      ? { left: lineA, right: lineB }
      : { left: lineB, right: lineA };
  }

  function getIntervalOverlapRatio(startA, endA, startB, endB, minDimensionPercent = 0.1) {
    const overlap = getAxisOverlap(startA, endA, startB, endB);
    if (overlap <= 0) {
      return 0;
    }
    const minSpan = Math.max(minDimensionPercent, Math.min(endA - startA, endB - startB));
    return overlap / minSpan;
  }

  function countDistinctBands(values, minSeparation) {
    const sorted = values
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    if (sorted.length === 0) {
      return 0;
    }

    let count = 1;
    let last = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if ((sorted[i] - last) >= minSeparation) {
        count += 1;
        last = sorted[i];
      }
    }
    return count;
  }

  function buildLineMetrics(lines, tuning = BLOCK_DETECTION_TUNING) {
    return (Array.isArray(lines) ? lines : []).map((line, index) => {
      const rect = line && line.bounding_rect ? line.bounding_rect : {};
      const rawX1 = Number(rect.x1) * 100;
      const rawY1 = Number(rect.y1) * 100;
      const rawX3 = Number(rect.x3) * 100;
      const rawY3 = Number(rect.y3) * 100;

      const safeX1 = Number.isFinite(rawX1) ? rawX1 : 0;
      const safeY1 = Number.isFinite(rawY1) ? rawY1 : 0;
      const safeX3 = Number.isFinite(rawX3) ? rawX3 : safeX1;
      const safeY3 = Number.isFinite(rawY3) ? rawY3 : safeY1;

      const x1 = Math.min(safeX1, safeX3);
      const y1 = Math.min(safeY1, safeY3);
      const x3 = Math.max(safeX1, safeX3);
      const y3 = Math.max(safeY1, safeY3);

      const textLength = typeof line?.text === 'string' && line.text.length > 0 ? line.text.length : 1;
      const width = Math.max(tuning.minDimensionPercent, x3 - x1);
      const height = Math.max(tuning.minDimensionPercent, y3 - y1);

      return {
        index,
        x1,
        y1,
        x3,
        y3,
        width,
        height,
        centerY: (y1 + y3) / 2,
        charWidth: width / textLength,
      };
    });
  }

  function getPersistentGapRowCandidate(lineA, lineB, medianHeight, tuning = BLOCK_DETECTION_TUNING) {
    const persistentGapCfg = tuning.persistentGap;
    const sameRowCfg = tuning.sameRow;
    const { left, right } = orderMetricsByX(lineA, lineB);
    const gapWidth = getAxisGap(left.x1, left.x3, right.x1, right.x3);
    if (gapWidth <= 0) {
      return null;
    }

    const avgHeight = Math.max(tuning.minDimensionPercent, (left.height + right.height) / 2);
    const minHeight = Math.max(tuning.minDimensionPercent, Math.min(left.height, right.height));
    const centerYDiff = Math.abs(left.centerY - right.centerY);
    const verticalOverlap = getAxisOverlap(left.y1, left.y3, right.y1, right.y3);
    const verticalOverlapRatio = verticalOverlap / minHeight;
    const rowCenterYThreshold = Math.max(
      persistentGapCfg.rowCenterYMinPercent,
      Math.min(sameRowCfg.centerYMaxPercent, avgHeight * sameRowCfg.centerYMultiplier),
      medianHeight * persistentGapCfg.rowCenterYMedianHeightMultiplier
    );
    const gapThreshold = Math.max(
      persistentGapCfg.minGapPercent,
      medianHeight * persistentGapCfg.gapMedianHeightMultiplier
    );

    if (
      gapWidth < gapThreshold ||
      (
        verticalOverlapRatio < persistentGapCfg.rowVerticalOverlapRatioMin &&
        centerYDiff > rowCenterYThreshold
      )
    ) {
      return null;
    }

    return {
      leftIndex: left.index,
      rightIndex: right.index,
      gapStart: left.x3,
      gapEnd: right.x1,
      gapWidth,
      rowTop: Math.min(left.y1, right.y1),
      rowBottom: Math.max(left.y3, right.y3),
      rowCenterY: (left.centerY + right.centerY) / 2,
    };
  }

  function buildPersistentGapSeparators(metrics, medianHeight, tuning = BLOCK_DETECTION_TUNING) {
    const persistentGapCfg = tuning.persistentGap;
    const rowCandidates = [];
    for (let i = 0; i < metrics.length; i++) {
      for (let j = i + 1; j < metrics.length; j++) {
        const candidate = getPersistentGapRowCandidate(metrics[i], metrics[j], medianHeight, tuning);
        if (candidate) {
          rowCandidates.push(candidate);
        }
      }
    }

    if (rowCandidates.length === 0) {
      return [];
    }

    rowCandidates.sort((a, b) => (
      (a.gapStart - b.gapStart) ||
      (a.gapEnd - b.gapEnd) ||
      (a.rowCenterY - b.rowCenterY)
    ));

    const clusters = [];
    for (const candidate of rowCandidates) {
      let matchedCluster = null;
      for (const cluster of clusters) {
        const overlapRatio = getIntervalOverlapRatio(
          cluster.gapStart,
          cluster.gapEnd,
          candidate.gapStart,
          candidate.gapEnd,
          tuning.minDimensionPercent
        );
        if (overlapRatio < persistentGapCfg.intervalOverlapRatioMin) {
          continue;
        }
        matchedCluster = cluster;
        break;
      }

      if (!matchedCluster) {
        clusters.push({
          gapStart: candidate.gapStart,
          gapEnd: candidate.gapEnd,
          yMin: candidate.rowTop,
          yMax: candidate.rowBottom,
          rowCenters: [candidate.rowCenterY],
          pairs: [candidate],
        });
        continue;
      }

      matchedCluster.gapStart = Math.max(matchedCluster.gapStart, candidate.gapStart);
      matchedCluster.gapEnd = Math.min(matchedCluster.gapEnd, candidate.gapEnd);
      matchedCluster.yMin = Math.min(matchedCluster.yMin, candidate.rowTop);
      matchedCluster.yMax = Math.max(matchedCluster.yMax, candidate.rowBottom);
      matchedCluster.rowCenters.push(candidate.rowCenterY);
      matchedCluster.pairs.push(candidate);
    }

    const minDistinctRowSeparation = medianHeight * persistentGapCfg.distinctRowMinSeparationMultiplier;
    return clusters
      .filter((cluster) => cluster.gapEnd > cluster.gapStart)
      .map((cluster) => ({
        xStart: cluster.gapStart,
        xEnd: cluster.gapEnd,
        xCenter: (cluster.gapStart + cluster.gapEnd) / 2,
        yMin: cluster.yMin,
        yMax: cluster.yMax,
        rowCount: countDistinctBands(cluster.rowCenters, minDistinctRowSeparation),
      }))
      .filter((cluster) => (
        cluster.rowCount >= persistentGapCfg.minSupportingRows &&
        (cluster.yMax - cluster.yMin) >= (medianHeight * persistentGapCfg.minVerticalSpanMultiplier) &&
        (cluster.xEnd - cluster.xStart) >= persistentGapCfg.minSeparatorWidthPercent
      ));
  }

  function pairCrossesPersistentSeparator(lineA, lineB, persistentSeparators) {
    if (!Array.isArray(persistentSeparators) || persistentSeparators.length === 0) {
      return false;
    }

    const { left, right } = orderMetricsByX(lineA, lineB);
    const pairGapStart = left.x3;
    const pairGapEnd = right.x1;
    if (pairGapEnd <= pairGapStart) {
      return false;
    }

    const pairYMin = Math.min(left.y1, right.y1);
    const pairYMax = Math.max(left.y3, right.y3);
    return persistentSeparators.some((separator) => (
      getAxisOverlap(pairGapStart, pairGapEnd, separator.xStart, separator.xEnd) > 0 &&
      getAxisOverlap(pairYMin, pairYMax, separator.yMin, separator.yMax) > 0
    ));
  }

  function shouldLinesShareBlock(lineA, lineB, medianHeight, tuning = BLOCK_DETECTION_TUNING, persistentSeparators = []) {
    const sameRowCfg = tuning.sameRow;
    const crossRowCfg = tuning.crossRow;
    const crossRowRelaxedCfg = tuning.crossRowRelaxed;
    const avgHeight = Math.max(tuning.minDimensionPercent, (lineA.height + lineB.height) / 2);
    const minHeight = Math.max(tuning.minDimensionPercent, Math.min(lineA.height, lineB.height));
    const centerYDiff = Math.abs(lineA.centerY - lineB.centerY);
    const verticalOverlap = getAxisOverlap(lineA.y1, lineA.y3, lineB.y1, lineB.y3);
    const verticalOverlapRatio = verticalOverlap / minHeight;
    const horizontalGap = getAxisGap(lineA.x1, lineA.x3, lineB.x1, lineB.x3);
    const xOverlap = getAxisOverlap(lineA.x1, lineA.x3, lineB.x1, lineB.x3);
    const minWidth = Math.max(tuning.minDimensionPercent, Math.min(lineA.width, lineB.width));
    const maxWidth = Math.max(tuning.minDimensionPercent, Math.max(lineA.width, lineB.width));
    const xOverlapRatio = xOverlap / minWidth;
    const xSpanCoverageRatio = xOverlap / maxWidth;
    const leftEdgeDiff = Math.abs(lineA.x1 - lineB.x1);
    const rightEdgeDiff = Math.abs(lineA.x3 - lineB.x3);
    const centerXDiff = Math.abs(((lineA.x1 + lineA.x3) / 2) - ((lineB.x1 + lineB.x3) / 2));
    const avgCharWidth = Math.max(crossRowCfg.minCharWidthPercent, (lineA.charWidth + lineB.charWidth) / 2);

    if (pairCrossesPersistentSeparator(lineA, lineB, persistentSeparators)) {
      return false;
    }

    const sameRowYThreshold = Math.max(
      sameRowCfg.centerYMinPercent,
      Math.min(sameRowCfg.centerYMaxPercent, avgHeight * sameRowCfg.centerYMultiplier)
    );
    const sameRowGapThreshold = Math.max(
      sameRowCfg.horizontalGapMinPercent,
      Math.min(
        sameRowCfg.horizontalGapMaxPercent,
        ((lineA.width + lineB.width) * sameRowCfg.horizontalGapWidthMultiplier) + sameRowCfg.horizontalGapPaddingPercent
      )
    );
    const sameRow =
      (verticalOverlapRatio >= sameRowCfg.verticalOverlapRatioMin || centerYDiff <= sameRowYThreshold) &&
      horizontalGap <= sameRowGapThreshold;

    if (sameRow) {
      return true;
    }

    const verticalGap = getAxisGap(lineA.y1, lineA.y3, lineB.y1, lineB.y3);
    const verticalGapThreshold = Math.max(
      crossRowCfg.verticalGapMinPercent,
      medianHeight * crossRowCfg.verticalGapMedianHeightMultiplier,
      avgHeight * crossRowCfg.verticalGapAvgHeightMultiplier
    );
    const centerYThreshold = Math.max(
      crossRowCfg.centerYMinPercent,
      medianHeight * crossRowCfg.centerYMedianHeightMultiplier,
      avgHeight * crossRowCfg.centerYAvgHeightMultiplier
    );
    const strictCrossRowMatch =
      verticalGap <= verticalGapThreshold &&
      centerYDiff <= centerYThreshold &&
      (
        xOverlapRatio >= crossRowCfg.xOverlapRatioMin ||
        leftEdgeDiff <= Math.max(crossRowCfg.leftEdgeDiffMinPercent, avgCharWidth * crossRowCfg.leftEdgeDiffCharWidthMultiplier) ||
        horizontalGap <= Math.max(crossRowCfg.horizontalGapMinPercent, avgCharWidth * crossRowCfg.horizontalGapCharWidthMultiplier)
      );
    if (strictCrossRowMatch) {
      return true;
    }

    const relaxedVerticalGapThreshold = Math.max(
      verticalGapThreshold,
      medianHeight * crossRowRelaxedCfg.verticalGapMedianHeightMultiplier,
      avgHeight * crossRowRelaxedCfg.verticalGapAvgHeightMultiplier
    );
    if (verticalGap > relaxedVerticalGapThreshold) {
      return false;
    }

    const relaxedCenterYThreshold = Math.max(
      centerYThreshold,
      medianHeight * crossRowRelaxedCfg.centerYMedianHeightMultiplier,
      avgHeight * crossRowRelaxedCfg.centerYAvgHeightMultiplier
    );
    if (centerYDiff > relaxedCenterYThreshold) {
      return false;
    }

    if (xSpanCoverageRatio < crossRowRelaxedCfg.xSpanCoverageRatioMin) {
      return false;
    }

    const relaxedEdgeThreshold = Math.max(
      crossRowRelaxedCfg.edgeDiffMinPercent,
      avgCharWidth * crossRowRelaxedCfg.edgeDiffCharWidthMultiplier
    );
    const relaxedCenterXThreshold = Math.max(
      crossRowRelaxedCfg.centerXMinPercent,
      maxWidth * crossRowRelaxedCfg.centerXWidthMultiplier
    );

    return (
      leftEdgeDiff <= relaxedEdgeThreshold ||
      rightEdgeDiff <= relaxedEdgeThreshold ||
      centerXDiff <= relaxedCenterXThreshold
    );
  }

  function detectTextBlocks(lines, tuning = BLOCK_DETECTION_TUNING) {
    const lineBlocks = new Map();
    const blockBoundaries = new Map();

    if (!Array.isArray(lines) || lines.length === 0) {
      return { lineBlocks, blockBoundaries, blockCount: 0 };
    }

    const metrics = buildLineMetrics(lines, tuning);
    const medianHeight = Math.max(
      tuning.minMedianHeightPercent,
      getMedianValue(metrics.map((metric) => metric.height).filter((height) => Number.isFinite(height) && height > 0)) || tuning.fallbackMedianHeightPercent
    );
    const persistentSeparators = buildPersistentGapSeparators(metrics, medianHeight, tuning);

    const parent = metrics.map((_, idx) => idx);
    const find = (idx) => {
      let current = idx;
      while (parent[current] !== current) {
        parent[current] = parent[parent[current]];
        current = parent[current];
      }
      return current;
    };
    const unite = (a, b) => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA === rootB) {
        return;
      }
      parent[rootB] = rootA;
    };

    for (let i = 0; i < metrics.length; i++) {
      for (let j = i + 1; j < metrics.length; j++) {
        if (shouldLinesShareBlock(metrics[i], metrics[j], medianHeight, tuning, persistentSeparators)) {
          unite(i, j);
        }
      }
    }

    const components = new Map();
    for (let i = 0; i < metrics.length; i++) {
      const root = find(i);
      if (!components.has(root)) {
        components.set(root, []);
      }
      components.get(root).push(i);
    }

    const orderedComponents = Array.from(components.values())
      .map((memberIndexes) => {
        let top = Infinity;
        let left = Infinity;
        let minIndex = Infinity;
        for (const idx of memberIndexes) {
          const metric = metrics[idx];
          top = Math.min(top, metric.y1);
          left = Math.min(left, metric.x1);
          minIndex = Math.min(minIndex, metric.index);
        }
        return { memberIndexes, top, left, minIndex };
      })
      .sort((a, b) => (a.top - b.top) || (a.left - b.left) || (a.minIndex - b.minIndex));

    orderedComponents.forEach((component, blockId) => {
      for (const idx of component.memberIndexes) {
        lineBlocks.set(idx, blockId);
      }
    });

    for (let i = 0; i < lines.length; i++) {
      const blockId = lineBlocks.get(i);
      if (blockId === undefined) {
        continue;
      }
      if (!blockBoundaries.has(blockId)) {
        blockBoundaries.set(blockId, { start: i, end: i });
      } else {
        const boundary = blockBoundaries.get(blockId);
        boundary.start = Math.min(boundary.start, i);
        boundary.end = Math.max(boundary.end, i);
      }
    }

    return {
      lineBlocks,
      blockBoundaries,
      blockCount: orderedComponents.length,
    };
  }

  return {
    BLOCK_DETECTION_TUNING,
    buildLineMetrics,
    buildPersistentGapSeparators,
    detectTextBlocks,
    getAxisGap,
    getAxisOverlap,
    getMedianValue,
    getPersistentGapRowCandidate,
    pairCrossesPersistentSeparator,
    shouldLinesShareBlock,
  };
}));
