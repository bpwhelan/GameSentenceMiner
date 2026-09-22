(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.GSMBlockDetection = api;
  }
}(typeof window !== 'undefined' ? window : globalThis, function () {
  // Reconstruct text runs from the OCR's word boxes, then join neighboring rows
  // with compatible typography and spacing. Each axis uses its own measured
  // units: character advance along a row, font size between rows.
  const BLOCK_DETECTION_TUNING = Object.freeze({
    minHeightPercent: 0.8,        // floor for the text-height unit (in % of frame)
    fallbackHeightPercent: 1.8,   // text-height unit when nothing is measurable
    horizontalGapMultiplier: 1.6, // max inline gap, in typical character advances
    // Stacked lines that share a horizontal column (consecutive lines of one
    // paragraph, even with an indented first line) tolerate a looser vertical
    // gap, since line spacing varies.
    alignedVerticalGapMultiplier: 1.6,
    rowOverlapRatio: 0.5,
    maxFontSizeRatio: 1.5,
    wordGapMultiplier: 2.5,
    maxWordGapMultiplier: 2.2,
    paragraphGapContrastRatio: 1.8,
    paragraphGapTolerance: 0.15,
    paragraphMinGapMultiplier: 0.6,
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
    // A single dialogue line has no repeated row spacing to compare. Require
    // a much narrower nameplate and a clear gap relative to the local font.
    characterNameSingleLineMaxWidthRatio: 0.35,
    characterNameSingleLineMinGapMultiplier: 0.6,
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

  function readBox(rect) {
    if (!rect || !['x1', 'y1', 'x3', 'y3'].every((key) => (
      rect[key] != null && Number.isFinite(Number(rect[key]))
    ))) return null;
    const axisValues = (axis) => [1, 2, 3, 4].flatMap((corner) => (
      rect[`${axis}${corner}`] != null && Number.isFinite(Number(rect[`${axis}${corner}`]))
        ? [Number(rect[`${axis}${corner}`]) * 100] : []
    ));
    const xs = axisValues('x'), ys = axisValues('y');
    const x1 = Math.min(...xs), x3 = Math.max(...xs);
    const y1 = Math.min(...ys), y3 = Math.max(...ys);
    if (x3 <= x1 || y3 <= y1) return null;
    return { x1, y1, x3, y3, width: x3 - x1, height: y3 - y1 };
  }

  function unionBoxes(boxes) {
    const x1 = Math.min(...boxes.map((box) => box.x1));
    const y1 = Math.min(...boxes.map((box) => box.y1));
    const x3 = Math.max(...boxes.map((box) => box.x3));
    const y3 = Math.max(...boxes.map((box) => box.y3));
    return { x1, y1, x3, y3, width: x3 - x1, height: y3 - y1 };
  }

  function getWordBoxes(line) {
    return (Array.isArray(line?.words) ? line.words : []).flatMap((word, index) => {
      const box = readBox(word?.bounding_rect);
      return box && typeof word.text === 'string' && /\S/u.test(word.text)
        ? [{ ...box, text: word.text, word, index }]
        : [];
    });
  }

  function getWordTextOffsets(line, words) {
    const source = typeof line?.text === 'string' ? line.text : '';
    const starts = [];
    let cursor = 0;
    for (const word of words) {
      const start = source.indexOf(word.text, cursor);
      if (start < 0 || /\S/u.test(source.slice(cursor, start))) return null;
      starts.push(start);
      cursor = start + word.text.length;
    }
    return /\S/u.test(source.slice(cursor)) ? null : starts;
  }

  function inferVertical(line, words, options) {
    if (typeof line?.isVertical === 'boolean') return line.isVertical;
    if (!words.length || !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(line.text || '')) {
      return false;
    }
    const aspect = (options.viewportWidth || 1) / (options.viewportHeight || 1);
    let horizontal = 0, vertical = 0;
    words.forEach((word, i) => {
      if (getVisibleTextSymbols(word).length > 1) {
        if (word.width * aspect > word.height * 1.2) horizontal += 2;
        if (word.height > word.width * aspect * 1.2) vertical += 2;
      }
      if (i === 0) return;
      const previous = words[i - 1];
      if (getAxisOverlap(word.y1, word.y3, previous.y1, previous.y3) >= Math.min(word.height, previous.height) * 0.5) horizontal++;
      if (getAxisOverlap(word.x1, word.x3, previous.x1, previous.x3) >= Math.min(word.width, previous.width) * 0.5) vertical++;
    });
    return vertical > horizontal;
  }

  function withAxes(box, vertical) {
    return {
      ...box,
      vertical,
      inlineStart: vertical ? box.y1 : box.x1,
      inlineEnd: vertical ? box.y3 : box.x3,
      crossStart: vertical ? box.x1 : box.y1,
      crossEnd: vertical ? box.x3 : box.y3,
    };
  }

  function sharesRow(a, b, tuning) {
    const overlap = getAxisOverlap(a.crossStart, a.crossEnd, b.crossStart, b.crossEnd);
    return a.vertical === b.vertical && overlap > 0
      && overlap >= Math.min(a.crossEnd - a.crossStart, b.crossEnd - b.crossStart) * tuning.rowOverlapRatio;
  }

  function getTypography(boxes, vertical, tuning) {
    const axes = boxes.map((box) => withAxes(box, vertical));
    // Small punctuation ink boxes must not determine the surrounding font size.
    const letters = axes.filter((box) => /[\p{L}\p{N}]/u.test(box.text || ''));
    const reference = letters.length ? letters : axes;
    const fontSize = getMedianValue(reference.map((box) => box.crossEnd - box.crossStart));
    const advance = getMedianValue(reference.map((box) => (
      (box.inlineEnd - box.inlineStart) / Math.max(1, getVisibleTextSymbols(box).length)
    )));
    const gaps = [];
    for (let i = 1; i < axes.length; i++) {
      const previous = axes[i - 1], current = axes[i];
      const gap = current.inlineStart - previous.inlineEnd;
      if (sharesRow(previous, current, tuning) && gap >= 0 && gap <= advance * tuning.maxWordGapMultiplier) gaps.push(gap);
    }
    return { fontSize, advance, spacing: getMedianValue(gaps) };
  }

  function inlineGapLimit(a, b, tuning) {
    const advance = Math.min(a.advance, b.advance);
    return Math.min(
      advance * tuning.maxWordGapMultiplier,
      Math.max(advance * tuning.horizontalGapMultiplier, Math.min(a.spacing, b.spacing) * tuning.wordGapMultiplier)
    );
  }

  // Tight word geometry replaces padded OCR line bounds. Legacy inputs without
  // words still work, using average character advance from their text and box.
  function buildLineMetrics(lines, options = {}, tuning = BLOCK_DETECTION_TUNING) {
    return (Array.isArray(lines) ? lines : []).map((line, index) => {
      const wordBoxes = getWordBoxes(line);
      const words = getWordTextOffsets(line, wordBoxes) ? wordBoxes : [];
      const box = words.length ? unionBoxes(words) : readBox(line?.bounding_rect);
      const vertical = inferVertical(line, words, options);
      const bounds = box || { x1: 0, y1: 0, x3: 0, y3: 0, width: 0, height: 0 };
      const typography = getTypography(words.length ? words : [{ ...bounds, text: line?.text }], vertical, tuning);
      return {
        ...withAxes(bounds, vertical), ...typography, index, valid: !!box,
        glyphCount: getVisibleTextSymbols(line).length,
        punctuationOnly: /\S/u.test(line?.text || '') && !/[\p{L}\p{N}]/u.test(line?.text || ''),
      };
    });
  }

  // Split only at observed word boundaries. Inventing per-character boxes inside
  // a word cannot recover real whitespace and would risk corrupting OCR text.
  function prepareTextLines(lines, options = {}) {
    const tuning = { ...BLOCK_DETECTION_TUNING, ...(options.tuning || {}) };
    return (Array.isArray(lines) ? lines : []).flatMap((line) => {
      const words = getWordBoxes(line);
      if (!words.length) return [line];
      // OCR corrections sometimes change only line.text. Do not trim or split
      // such a line using a word list that no longer covers its visible text.
      const starts = getWordTextOffsets(line, words);
      if (!starts) return [line];
      const vertical = inferVertical(line, words, options);
      const typography = getTypography(words, vertical, tuning);
      const runs = [];
      for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
        const word = words[wordIndex];
        const punctuationOnly = !/[\p{L}\p{N}]/u.test(word.text);
        const current = {
          ...withAxes(word, vertical),
          ...getTypography([word], vertical, tuning),
          spacing: typography.spacing,
          punctuationOnly,
          glyphCount: getVisibleTextSymbols(word).length,
        };
        const run = runs[runs.length - 1];
        const previous = run?.[run.length - 1];
        // Punctuation has narrow/shallow ink but shares its neighbors' font.
        // Other words use their own size so a large heading cannot inflate
        // whitespace allowances for small labels elsewhere in the OCR line.
        if (punctuationOnly) {
          const reference = previous || getTypography(
            words.slice(wordIndex + 1).filter((box) => /[\p{L}\p{N}]/u.test(box.text)).slice(0, 1), vertical, tuning
          );
          if (reference.advance > 0) current.advance = reference.advance;
        }
        if (!previous || !sharesRow(previous, current, tuning)
          || !compatibleInlineFont(previous, current, tuning)
          || current.inlineStart < previous.inlineStart - current.advance * 0.5
          || current.inlineStart - previous.inlineEnd > inlineGapLimit(previous, current, tuning)) {
          runs.push([current]);
        } else {
          run.push(current);
        }
      }

      const tightLine = (run, text, runWords) => {
        const box = unionBoxes(run);
        return { ...line, text, words: runWords, isVertical: vertical, bounding_rect: {
          x1: box.x1 / 100, y1: box.y1 / 100, x3: box.x3 / 100, y3: box.y3 / 100,
        } };
      };
      // Slice the original text at the matched word offsets, retaining every
      // whitespace and punctuation character across the resulting runs.
      const source = line.text;
      if (runs.length === 1) return [tightLine(words, line.text, line.words)];
      let wordOffset = 0;
      return runs.map((run, i) => {
        const start = i === 0 ? 0 : starts[wordOffset];
        wordOffset += run.length;
        const end = i === runs.length - 1 ? source.length : starts[wordOffset];
        // Retain metadata and word identities, including any whitespace tokens
        // between visible words, so downstream text offsets remain meaningful.
        const firstWord = i === 0 ? 0 : run[0].index;
        const lastWord = i === runs.length - 1 ? line.words.length : runs[i + 1][0].index;
        return tightLine(run, source.slice(start, end), line.words.slice(firstWord, lastWord));
      });
    });
  }

  function compatibleFont(a, b, tuning) {
    return a.fontSize > 0 && b.fontSize > 0
      && Math.max(a.fontSize, b.fontSize) <= Math.min(a.fontSize, b.fontSize) * tuning.maxFontSizeRatio;
  }

  function compatibleInlineFont(a, b, tuning) {
    if (compatibleFont(a, b, tuning) || a.punctuationOnly || b.punctuationOnly) return true;
    // A single glyph such as ー or 一 has shallow ink at the normal character
    // advance. Width is better font evidence than height for those shapes.
    return (a.glyphCount === 1 || b.glyphCount === 1)
      && Math.min(a.advance, b.advance) > 0
      && Math.max(a.advance, b.advance) <= Math.min(a.advance, b.advance) * 1.3;
  }

  function alignedRows(a, b) {
    const overlap = getAxisOverlap(a.inlineStart, a.inlineEnd, b.inlineStart, b.inlineEnd);
    return (overlap > 0 && overlap >= Math.min(a.inlineEnd - a.inlineStart, b.inlineEnd - b.inlineStart) * 0.25)
      || (overlap === 0 && getAxisGap(a.inlineStart, a.inlineEnd, b.inlineStart, b.inlineEnd) <= Math.min(a.advance, b.advance) * 0.75);
  }

  function areBoxesClose(a, b, floorUnit, tuning = BLOCK_DETECTION_TUNING) {
    // Accept the historical public box shape as well as enriched line metrics.
    const enrich = (box) => box.inlineStart == null ? {
      ...withAxes(box, false), fontSize: box.height, advance: box.height,
      spacing: 0, valid: box.width > 0 && box.height > 0,
    } : box;
    a = enrich(a); b = enrich(b);
    if (!a.valid || !b.valid || a.vertical !== b.vertical) return false;
    if (sharesRow(a, b, tuning)) {
      if (!compatibleInlineFont(a, b, tuning)) return false;
      if (a.punctuationOnly && !b.punctuationOnly) a = { ...a, advance: b.advance, spacing: b.spacing };
      if (b.punctuationOnly && !a.punctuationOnly) b = { ...b, advance: a.advance, spacing: a.spacing };
      return getAxisGap(a.inlineStart, a.inlineEnd, b.inlineStart, b.inlineEnd) <= inlineGapLimit(a, b, tuning);
    }
    return compatibleFont(a, b, tuning) && alignedRows(a, b)
      && getAxisGap(a.crossStart, a.crossEnd, b.crossStart, b.crossEnd)
        <= Math.min(a.fontSize, b.fontSize) * tuning.alignedVerticalGapMultiplier;
  }

  function createGroups(count) {
    const parent = Array.from({ length: count }, (_, index) => index);
    const find = (index) => {
      while (parent[index] !== index) {
        parent[index] = parent[parent[index]];
        index = parent[index];
      }
      return index;
    };
    return {
      unite(a, b) { parent[find(b)] = find(a); },
      values() {
        const groups = new Map();
        parent.forEach((_, index) => {
          const key = find(index);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(index);
        });
        return [...groups.values()];
      },
    };
  }

  function buildTextRows(metrics, lines, tuning) {
    const groups = createGroups(metrics.length);
    for (let i = 0; i < metrics.length; i++) {
      for (let j = i + 1; j < metrics.length; j++) {
        if (sharesRow(metrics[i], metrics[j], tuning)
          && areBoxesClose(metrics[i], metrics[j], 0, tuning)) groups.unite(i, j);
      }
    }
    return groups.values().map((memberIndexes, index) => {
      const members = memberIndexes.map((i) => metrics[i]);
      const letters = members.filter((member) => !member.punctuationOnly);
      const reference = letters.length ? letters : members;
      const largestFont = Math.max(...reference.map((member) => member.fontSize));
      const fontReference = reference.filter((member) => (
        member.fontSize >= largestFont / tuning.maxFontSizeRatio
      ));
      return {
        ...withAxes(unionBoxes(members), members[0].vertical),
        fontSize: getMedianValue(fontReference.map((member) => member.fontSize)),
        advance: getMedianValue(reference.map((member) => member.advance)),
        spacing: getMedianValue(reference.map((member) => member.spacing)),
        punctuationOnly: letters.length === 0,
        valid: members.every((member) => member.valid),
        text: getBlockRawText(memberIndexes, lines),
        memberIndexes,
        index,
      };
    });
  }

  function findRowNeighbors(rows, tuning) {
    const edges = [];
    const nearestBefore = rows.map(() => Infinity);
    const nearestAfter = rows.map(() => Infinity);
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        if (sharesRow(rows[i], rows[j], tuning) || !areBoxesClose(rows[i], rows[j], 0, tuning)) continue;
        const [before, after] = rows[i].crossStart < rows[j].crossStart ? [i, j] : [j, i];
        const gap = Math.max(0, rows[after].crossStart - rows[before].crossEnd);
        const unit = Math.min(rows[before].fontSize, rows[after].fontSize);
        edges.push({ before, after, gap, unit });
        nearestAfter[before] = Math.min(nearestAfter[before], gap);
        nearestBefore[after] = Math.min(nearestBefore[after], gap);
      }
    }
    // Only facing neighbors can join paragraphs. Otherwise one large OCR box
    // can hop over an intervening row and bridge two unrelated groups.
    return edges.filter(({ before, after, gap, unit }) => (
      gap <= nearestAfter[before] + unit * 0.2
      && gap <= nearestBefore[after] + unit * 0.2
    ));
  }

  function groupTextRows(rows, tuning) {
    const edges = findRowNeighbors(rows, tuning);
    const groups = createGroups(rows.length);
    for (const edge of edges) {
      // Compare with neighboring gaps in this column, never the screen-wide
      // median (a menu or a heading may use entirely different typography).
      const neighboringGaps = edges.filter((other) => (
        other !== edge && (other.after === edge.before || other.before === edge.after)
      )).map((other) => other.gap / other.unit);
      const localGap = getMedianValue(neighboringGaps);
      const isSpacingBreak = neighboringGaps.length > 0
        && edge.gap / edge.unit > Math.max(
          tuning.paragraphMinGapMultiplier,
          localGap * tuning.paragraphGapContrastRatio + tuning.paragraphGapTolerance
        );
      if (!isSpacingBreak) groups.unite(edge.before, edge.after);
    }
    return groups.values();
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

  function getTextEditDistance(left, right, maxDistance) {
    if (left === right) {
      return 0;
    }
    if (!left) {
      return right.length;
    }
    if (!right) {
      return left.length;
    }

    // Equal prefixes/suffixes cannot change Levenshtein distance. Compare UTF-16
    // code units as before, including strings containing supplementary glyphs.
    let start = 0, leftEnd = left.length, rightEnd = right.length;
    while (start < leftEnd && start < rightEnd && left[start] === right[start]) start++;
    while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) {
      leftEnd--;
      rightEnd--;
    }
    const leftLength = leftEnd - start, rightLength = rightEnd - start;
    if (!leftLength) return rightLength;
    if (!rightLength) return leftLength;
    const limit = maxDistance + 1;
    if (Math.abs(leftLength - rightLength) > maxDistance) return limit;
    let previousRow = new Uint32Array(rightLength + 1);
    let currentRow = new Uint32Array(rightLength + 1);
    previousRow.fill(limit);
    for (let j = 0; j <= Math.min(rightLength, maxDistance); j++) previousRow[j] = j;
    for (let i = 1; i <= leftLength; i++) {
      const first = Math.max(1, i - maxDistance);
      const last = Math.min(rightLength, i + maxDistance);
      currentRow[first - 1] = first === 1 ? i : limit;
      let minimum = limit;
      for (let j = first; j <= last; j++) {
        const value = Math.min(
          currentRow[j - 1] + 1,
          previousRow[j] + 1,
          previousRow[j - 1] + (left[start + i - 1] === right[start + j - 1] ? 0 : 1)
        );
        currentRow[j] = value;
        minimum = Math.min(minimum, value);
      }
      if (minimum > maxDistance) return limit;
      if (last < rightLength) currentRow[last + 1] = limit;
      [previousRow, currentRow] = [currentRow, previousRow];
    }
    return previousRow[rightLength];
  }

  function getNormalizedBlockMatchSimilarity(normalizedCandidate, normalizedRecent) {
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

    // One extra edit keeps this bound conservative at floating-point threshold
    // boundaries. The original similarity comparison remains authoritative.
    const maxDistance = Math.floor(longestLength * 0.15) + 1;
    const similarity = 1 - getTextEditDistance(normalizedCandidate, normalizedRecent, maxDistance) / longestLength;
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
    return getNormalizedBlockMatchSimilarity(normalizedCandidate, normalizedLatest);
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

  function findRecentBlockMatchAt(orderedIndexes, start, lines, recentRawTexts, normalizedHistory = null) {
    let candidateText = '';
    let bestMatch = null;
    const history = normalizedHistory || recentRawTexts.map(normalizeRecentBlockText);

    for (let end = start; end < orderedIndexes.length; end++) {
      const line = lines[orderedIndexes[end]];
      candidateText += line && typeof line.text === 'string' ? line.text : '';
      const normalizedCandidate = normalizeRecentBlockText(candidateText);
      for (let historyIndex = recentRawTexts.length - 1; historyIndex >= 0; historyIndex--) {
        const similarity = getNormalizedBlockMatchSimilarity(normalizedCandidate, history[historyIndex]);
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
    const normalizedHistory = usableRawTexts.map(normalizeRecentBlockText);
    let cursor = 0;
    while (cursor < orderedIndexes.length) {
      const match = findRecentBlockMatchAt(
        orderedIndexes,
        cursor,
        lines,
        usableRawTexts,
        normalizedHistory
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
        && !findRecentBlockMatchAt(orderedIndexes, nextKnownStart, lines, usableRawTexts, normalizedHistory)
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
    if (memberIndexes.some((index) => metrics[index].vertical)) return null;

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
    // before assigning the semantic role.
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
      && candidateGap >= medianBodyHeight * tuning.characterNameMinGapMultiplier
      && candidateGap >= medianBodyGap * tuning.characterNameGapContrastRatio
    );
    // A single dialogue line has no internal spacing to compare. Use its local
    // text height and a stricter width contrast to recognize a detached name
    // even when OCR measures its font as the same size as the dialogue.
    const hasSingleLineHeaderSpacing = (
      bodyIndexes.length === 1
      && candidate.width <= widestBodyLine * tuning.characterNameSingleLineMaxWidthRatio
      && candidateGap >= Math.max(candidate.height, medianBodyHeight)
        * tuning.characterNameSingleLineMinGapMultiplier
    );
    if (!hasSmallerNameFont && !hasHeaderSpacing && !hasSingleLineHeaderSpacing) {
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

    const metrics = buildLineMetrics(lines, options, tuning);
    const unit = Math.max(
      tuning.minHeightPercent,
      getMedianValue(metrics.map((m) => m.height).filter((h) => h > 0)) || tuning.fallbackHeightPercent
    );
    const rows = buildTextRows(metrics, lines, tuning);
    const neighborhoods = createGroups(rows.length);
    findRowNeighbors(rows, tuning).forEach(({ before, after }) => neighborhoods.unite(before, after));

    // Split a high-confidence character-name prefix from its dialogue body.
    // Retain both as navigable blocks and attach a relationship key so the
    // renderer can expose explicit roles for navigation and future filtering.
    let relationshipKey = 0;
    const semanticComponents = [];
    const appendParagraphs = (rowIndexes, role, key) => {
      const selectedRows = rowIndexes.map((index) => rows[index]);
      for (const paragraph of groupTextRows(selectedRows, tuning)) {
        semanticComponents.push({
          memberIndexes: paragraph.flatMap((index) => selectedRows[index].memberIndexes),
          role,
          relationshipKey: key,
        });
      }
    };
    for (const memberIndexes of neighborhoods.values()) {
      const nameSplit = isLikelyCharacterNamePrefix(
        memberIndexes,
        rows,
        rows,
        unit,
        tuning
      );
      if (!nameSplit) {
        appendParagraphs(memberIndexes, 'text', null);
        continue;
      }

      const currentRelationshipKey = relationshipKey++;
      semanticComponents.push({
        memberIndexes: rows[nameSplit.candidateIndex].memberIndexes,
        role: 'character-name',
        relationshipKey: currentRelationshipKey,
      });
      appendParagraphs(nameSplit.bodyIndexes, 'dialogue', currentRelationshipKey);
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
    prepareTextLines,
    insertBlockSeparatorAfter,
    splitComponentByRecentBlocks,
  };
}));
