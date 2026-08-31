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
    // A conservative character-name heuristic. Names are commonly rendered as
    // one short line just above a much wider dialogue body. Keep the width
    // contrast strict so short first lines of ordinary dialogue stay grouped.
    characterNameMinLength: 2,
    characterNameMaxLength: 16,
    characterNameMaxWidthRatio: 0.65,
    characterNameMaxHeightRatio: 1.15,
    characterNameStrongHeightRatio: 0.9,
    characterNameGapContrastRatio: 1.35,
    characterNameMinGapMultiplier: 0.35,
  });
  const RECENT_BLOCK_HISTORY_LIMIT = 5;

  function createRecentBlockHistory(maxEntries = RECENT_BLOCK_HISTORY_LIMIT) {
    const limit = Number.isInteger(maxEntries) && maxEntries > 0
      ? maxEntries
      : RECENT_BLOCK_HISTORY_LIMIT;
    let results = [];
    let anonymousResultId = 0;

    function remember(rawText, resultKey = null) {
      if (typeof rawText !== 'string' || rawText.length === 0) {
        return;
      }
      rememberAll([rawText], resultKey);
    }

    function rememberAll(texts, resultKey = null) {
      const rawTexts = Array.from(new Set(
        (Array.isArray(texts) ? texts : [])
          .filter((text) => typeof text === 'string' && text.length > 0)
      ));
      if (rawTexts.length === 0) {
        return;
      }

      // OCR retries share a line ID. Replace that result's snapshot so partial
      // reads do not become separate history entries or match themselves.
      const key = resultKey == null
        ? `gsm-anonymous-block-result-${++anonymousResultId}`
        : resultKey;
      results = results.filter((result) => result.key !== key);
      results.push({ key, rawTexts });
      if (results.length > limit) {
        results.splice(0, results.length - limit);
      }
    }

    return {
      clear() {
        results = [];
      },
      getRawTexts(excludedResultKey = null) {
        const rawTexts = [];
        for (const result of results) {
          if (excludedResultKey != null && result.key === excludedResultKey) {
            continue;
          }
          for (const rawText of result.rawTexts) {
            const existingIndex = rawTexts.indexOf(rawText);
            if (existingIndex >= 0) {
              rawTexts.splice(existingIndex, 1);
            }
            rawTexts.push(rawText);
          }
        }
        return rawTexts;
      },
      remember,
      rememberAll,
    };
  }

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
      return {
        index,
        x1,
        y1,
        x3,
        y3,
        width: x3 - x1,
        height: y3 - y1,
      };
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

  function getVisibleTextSymbols(line) {
    const text = line && typeof line.text === 'string' ? line.text : '';
    return Array.from(text).filter((symbol) => !/\s/u.test(symbol));
  }

  function getBlockRawText(memberIndexes, lines) {
    return memberIndexes
      .slice()
      .sort((a, b) => a - b)
      .map((idx) => (
        lines[idx] && typeof lines[idx].text === 'string' ? lines[idx].text : ''
      ))
      .join('');
  }

  function normalizeRecentBlockText(text) {
    return String(text || '')
      .normalize('NFKC')
      .replace(/[\s\p{P}\p{S}]/gu, '');
  }

  function getTextEditDistance(left, right) {
    if (left === right) {
      return 0;
    }
    if (!left) {
      return right.length;
    }
    if (!right) {
      return left.length;
    }

    let previousRow = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 0; leftIndex < left.length; leftIndex++) {
      const currentRow = [leftIndex + 1];
      for (let rightIndex = 0; rightIndex < right.length; rightIndex++) {
        const substitutionCost = left[leftIndex] === right[rightIndex] ? 0 : 1;
        currentRow.push(Math.min(
          currentRow[rightIndex] + 1,
          previousRow[rightIndex + 1] + 1,
          previousRow[rightIndex] + substitutionCost
        ));
      }
      previousRow = currentRow;
    }
    return previousRow[right.length];
  }

  function getRecentBlockMatchSimilarity(candidateText, recentText) {
    const normalizedCandidate = normalizeRecentBlockText(candidateText);
    const normalizedRecent = normalizeRecentBlockText(recentText);
    if (!normalizedCandidate || !normalizedRecent) {
      return 0;
    }
    if (normalizedCandidate === normalizedRecent) {
      return 1;
    }

    const longestLength = Math.max(normalizedCandidate.length, normalizedRecent.length);
    const shortestLength = Math.min(normalizedCandidate.length, normalizedRecent.length);
    if (shortestLength < 6 || shortestLength / longestLength < 0.8) {
      return 0;
    }

    const similarity = 1 - getTextEditDistance(normalizedCandidate, normalizedRecent) / longestLength;
    return similarity >= 0.85 ? similarity : 0;
  }

  function getLatestTextMatchScore(candidateText, latestText) {
    const normalizedCandidate = normalizeRecentBlockText(candidateText);
    const normalizedLatest = normalizeRecentBlockText(latestText);
    if (!normalizedCandidate || !normalizedLatest) {
      return 0;
    }
    if (normalizedCandidate === normalizedLatest) {
      return 4;
    }
    if (normalizedCandidate.includes(normalizedLatest)) {
      return 3 + normalizedLatest.length / normalizedCandidate.length;
    }
    if (
      normalizedLatest.includes(normalizedCandidate)
      && normalizedCandidate.length >= normalizedLatest.length * 0.8
    ) {
      return 2 + normalizedCandidate.length / normalizedLatest.length;
    }
    return getRecentBlockMatchSimilarity(candidateText, latestText);
  }

  function findLatestTextComponentIndex(components, lines, latestText) {
    let bestIndex = -1;
    let bestScore = 0;
    components.forEach((component, index) => {
      const score = getLatestTextMatchScore(
        getBlockRawText(component.memberIndexes, lines),
        latestText
      );
      if (score > bestScore || (score > 0 && score === bestScore && index > bestIndex)) {
        bestIndex = index;
        bestScore = score;
      }
    });
    return bestIndex;
  }

  function findRecentBlockMatchAt(orderedIndexes, start, lines, recentRawTexts) {
    let candidateText = '';
    let bestMatch = null;

    for (let end = start; end < orderedIndexes.length; end++) {
      const line = lines[orderedIndexes[end]];
      candidateText += line && typeof line.text === 'string' ? line.text : '';
      for (let historyIndex = recentRawTexts.length - 1; historyIndex >= 0; historyIndex--) {
        const similarity = getRecentBlockMatchSimilarity(candidateText, recentRawTexts[historyIndex]);
        if (similarity === 0) {
          continue;
        }
        if (
          !bestMatch
          || similarity > bestMatch.similarity
          || (similarity === bestMatch.similarity && candidateText.length > bestMatch.rawText.length)
        ) {
          bestMatch = {
            end: end + 1,
            historyIndex,
            rawText: candidateText,
            similarity,
          };
        }
      }
    }

    return bestMatch;
  }

  // NVL games retain old dialogue and append new lines into the same nearby
  // screen region. Geometry alone sees one connected component. Exact raw-text
  // matches recover the boundaries detected on recent frames, leaving each
  // unmatched run as a new block.
  function splitComponentByRecentBlocks(component, lines, recentRawTexts) {
    const orderedIndexes = component.memberIndexes.slice().sort((a, b) => a - b);
    const usableRawTexts = (Array.isArray(recentRawTexts) ? recentRawTexts : [])
      .filter((text) => typeof text === 'string' && text.length > 0);
    if (orderedIndexes.length < 2 || usableRawTexts.length === 0) {
      return [{ ...component, memberIndexes: orderedIndexes }];
    }

    const segments = [];
    let cursor = 0;
    while (cursor < orderedIndexes.length) {
      const match = findRecentBlockMatchAt(
        orderedIndexes,
        cursor,
        lines,
        usableRawTexts
      );
      if (match) {
        segments.push(orderedIndexes.slice(cursor, match.end));
        cursor = match.end;
        continue;
      }

      // Keep new consecutive lines together until the next known block. In the
      // usual NVL append case there is no later match, so the entire new suffix
      // becomes one block.
      let nextKnownStart = cursor + 1;
      while (
        nextKnownStart < orderedIndexes.length
        && !findRecentBlockMatchAt(orderedIndexes, nextKnownStart, lines, usableRawTexts)
      ) {
        nextKnownStart++;
      }
      segments.push(orderedIndexes.slice(cursor, nextKnownStart));
      cursor = nextKnownStart;
    }

    return segments.map((memberIndexes) => ({
      ...component,
      memberIndexes,
    }));
  }

  function isLikelyCharacterNamePrefix(memberIndexes, metrics, lines, floorUnit, tuning) {
    if (!Array.isArray(memberIndexes) || memberIndexes.length < 2) {
      return null;
    }

    const orderedIndexes = memberIndexes.slice().sort((a, b) => (
      (metrics[a].y1 - metrics[b].y1)
      || (metrics[a].x1 - metrics[b].x1)
      || (a - b)
    ));
    const candidateIndex = orderedIndexes[0];
    const bodyIndexes = orderedIndexes.slice(1);
    const candidate = metrics[candidateIndex];
    const firstBody = metrics[bodyIndexes[0]];
    const candidateSymbols = getVisibleTextSymbols(lines[candidateIndex]);
    const candidateText = candidateSymbols.join('');

    if (
      candidateSymbols.length < tuning.characterNameMinLength
      || candidateSymbols.length > tuning.characterNameMaxLength
      || !candidate.width
      || !candidate.height
      || /[。！？!?…‥.,，、：:；;]$/u.test(candidateText)
    ) {
      return null;
    }

    // Names sit wholly above the dialogue and must be close to at least one of
    // its lines. The closest line is not always the first: centered nameplates
    // can sit to the right of a short first line but over a wider line below.
    const bodyMetrics = bodyIndexes.map((idx) => metrics[idx]);
    if (
      candidate.y3 > firstBody.y1
      || !bodyMetrics.some((bodyMetric) => (
        areBoxesClose(candidate, bodyMetric, floorUnit, tuning)
      ))
    ) {
      return null;
    }

    const bodyLeft = Math.min(...bodyMetrics.map((bodyMetric) => bodyMetric.x1));
    const bodyRight = Math.max(...bodyMetrics.map((bodyMetric) => bodyMetric.x3));
    const horizontalOverlap = getAxisOverlap(
      candidate.x1,
      candidate.x3,
      bodyLeft,
      bodyRight
    );
    const gapToBodyFootprint = getAxisGap(
      candidate.x1,
      candidate.x3,
      bodyLeft,
      bodyRight
    );
    if (horizontalOverlap <= 0 && gapToBodyFootprint > floorUnit) {
      return null;
    }

    const widestBodyLine = Math.max(...bodyIndexes.map((idx) => metrics[idx].width));
    const medianBodyHeight = getMedianValue(bodyIndexes.map((idx) => metrics[idx].height));
    if (
      widestBodyLine <= 0
      || medianBodyHeight <= 0
      || candidate.width > widestBodyLine * tuning.characterNameMaxWidthRatio
      || candidate.height > medianBodyHeight * tuning.characterNameMaxHeightRatio
    ) {
      return null;
    }

    // A short first dialogue line can have the same width contrast as a name.
    // Require either a visibly smaller name font or header-like extra spacing
    // above a multi-line body before assigning the semantic role.
    const candidateGap = Math.max(0, firstBody.y1 - candidate.y3);
    const orderedBodyMetrics = bodyIndexes
      .map((idx) => metrics[idx])
      .sort((a, b) => (a.y1 - b.y1) || (a.x1 - b.x1) || (a.index - b.index));
    const bodyLineGaps = [];
    for (let i = 1; i < orderedBodyMetrics.length; i++) {
      bodyLineGaps.push(Math.max(0, orderedBodyMetrics[i].y1 - orderedBodyMetrics[i - 1].y3));
    }
    const medianBodyGap = getMedianValue(bodyLineGaps);
    const hasSmallerNameFont = (
      candidate.height <= medianBodyHeight * tuning.characterNameStrongHeightRatio
    );
    const hasHeaderSpacing = (
      bodyLineGaps.length > 0
      && candidateGap >= floorUnit * tuning.characterNameMinGapMultiplier
      && candidateGap >= medianBodyGap * tuning.characterNameGapContrastRatio
    );
    if (!hasSmallerNameFont && !hasHeaderSpacing) {
      return null;
    }

    return { candidateIndex, bodyIndexes };
  }

  function detectTextBlocks(
    lines,
    tuning = BLOCK_DETECTION_TUNING,
    recentBlockHistory = null,
    options = {}
  ) {
    tuning = {
      ...BLOCK_DETECTION_TUNING,
      ...(tuning || {}),
    };
    const lineBlocks = new Map();
    const blockBoundaries = new Map();
    const blockMetadata = new Map();

    if (!Array.isArray(lines) || lines.length === 0) {
      return {
        lineBlocks,
        blockBoundaries,
        blockMetadata,
        blockCount: 0,
      };
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

    // Group lines by their connected component.
    const components = new Map();
    for (let i = 0; i < metrics.length; i++) {
      const root = find(i);
      if (!components.has(root)) {
        components.set(root, []);
      }
      components.get(root).push(i);
    }

    // Split a high-confidence character-name prefix from its dialogue body.
    // Retain both as navigable blocks and attach a relationship key so the
    // renderer can expose explicit roles for navigation and future filtering.
    let relationshipKey = 0;
    const semanticComponents = [];
    for (const memberIndexes of components.values()) {
      const nameSplit = isLikelyCharacterNamePrefix(
        memberIndexes,
        metrics,
        lines,
        unit,
        tuning
      );
      if (!nameSplit) {
        semanticComponents.push({ memberIndexes, role: 'text', relationshipKey: null });
        continue;
      }

      const currentRelationshipKey = relationshipKey++;
      semanticComponents.push({
        memberIndexes: [nameSplit.candidateIndex],
        role: 'character-name',
        relationshipKey: currentRelationshipKey,
      });
      semanticComponents.push({
        memberIndexes: nameSplit.bodyIndexes,
        role: 'dialogue',
        relationshipKey: currentRelationshipKey,
      });
    }

    // Order blocks top-to-bottom, then left-to-right, then by original line
    // order. The gamepad layer uses the semantic role, not this visual order,
    // to choose the initial block.
    const recentRawTexts = recentBlockHistory
      && typeof recentBlockHistory.getRawTexts === 'function'
      ? recentBlockHistory.getRawTexts(options.resultKey)
      : [];
    let nvlChainKey = 0;
    const historyAwareComponents = semanticComponents.flatMap((component) => {
      const splitComponents = splitComponentByRecentBlocks(component, lines, recentRawTexts);
      if (splitComponents.length < 2) {
        return splitComponents;
      }

      const currentNvlChainKey = nvlChainKey++;
      return splitComponents.map((splitComponent) => ({
        ...splitComponent,
        nvlChainKey: currentNvlChainKey,
      }));
    });
    const orderedComponents = historyAwareComponents
      .map((component) => ({
        ...component,
        top: Math.min(...component.memberIndexes.map((idx) => metrics[idx].y1)),
        left: Math.min(...component.memberIndexes.map((idx) => metrics[idx].x1)),
        minIndex: Math.min(...component.memberIndexes),
      }))
      .sort((a, b) => (a.top - b.top) || (a.left - b.left) || (a.minIndex - b.minIndex));
    const latestTextComponentIndex = findLatestTextComponentIndex(
      orderedComponents,
      lines,
      options.latestText
    );

    const relationshipBlockIds = new Map();
    orderedComponents.forEach((component, blockId) => {
      for (const idx of component.memberIndexes) {
        lineBlocks.set(idx, blockId);
      }
      const sorted = component.memberIndexes.slice().sort((a, b) => a - b);
      blockBoundaries.set(blockId, { start: sorted[0], end: sorted[sorted.length - 1] });
      blockMetadata.set(blockId, {
        role: component.role,
        ...(blockId === latestTextComponentIndex ? { isLatestLine: true } : {}),
        ...(Number.isInteger(component.nvlChainKey)
          ? { nvlChainId: component.nvlChainKey }
          : {}),
      });
      if (component.relationshipKey !== null) {
        if (!relationshipBlockIds.has(component.relationshipKey)) {
          relationshipBlockIds.set(component.relationshipKey, []);
        }
        relationshipBlockIds.get(component.relationshipKey).push(blockId);
      }
    });

    relationshipBlockIds.forEach((blockIds) => {
      if (blockIds.length !== 2) {
        return;
      }
      const [firstBlockId, secondBlockId] = blockIds;
      blockMetadata.get(firstBlockId).relatedBlockId = secondBlockId;
      blockMetadata.get(secondBlockId).relatedBlockId = firstBlockId;
    });

    if (recentBlockHistory && typeof recentBlockHistory.rememberAll === 'function') {
      recentBlockHistory.rememberAll(
        orderedComponents.map((component) => (
          getBlockRawText(component.memberIndexes, lines)
        )),
        options.resultKey
      );
    }

    return {
      lineBlocks,
      blockBoundaries,
      blockMetadata,
      blockCount: orderedComponents.length,
    };
  }

  // Recalibration reuses the existing block containers. Insert the newline
  // relative to its block instead of appending it to <body>, otherwise every
  // recreated separator ends up after all of the reused blocks.
  function insertBlockSeparatorAfter(documentRef, blockContainer) {
    if (!documentRef || !blockContainer || !blockContainer.parentNode) {
      return null;
    }

    const separator = documentRef.createElement('span');
    separator.className = 'block-separator';
    separator.style.position = 'absolute';
    separator.style.pointerEvents = 'none';
    separator.appendChild(documentRef.createTextNode('\n'));
    blockContainer.parentNode.insertBefore(separator, blockContainer.nextSibling);
    return separator;
  }

  return {
    BLOCK_DETECTION_TUNING,
    RECENT_BLOCK_HISTORY_LIMIT,
    areBoxesClose,
    buildLineMetrics,
    createRecentBlockHistory,
    detectTextBlocks,
    findRecentBlockMatchAt,
    getBlockRawText,
    getVisibleTextSymbols,
    getAxisGap,
    getAxisOverlap,
    getMedianValue,
    isLikelyCharacterNamePrefix,
    insertBlockSeparatorAfter,
    splitComponentByRecentBlocks,
  };
}));
