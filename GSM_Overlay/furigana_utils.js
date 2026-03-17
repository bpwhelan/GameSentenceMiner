(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.GSMFuriganaUtils = api;
  }
}(typeof window !== 'undefined' ? window : globalThis, function () {
  const KANA_REGEX = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/u;
  const STRICT_READING_REPLACEMENTS = new Map([
    ['私\tわたくし', 'わたし'],
  ]);

  function isKanjiLikeCharacter(char) {
    if (typeof char !== 'string' || !char) return false;
    const codePoint = char.codePointAt(0);
    return (
      (codePoint >= 0x4E00 && codePoint <= 0x9FFF) ||
      (codePoint >= 0x3400 && codePoint <= 0x4DBF) ||
      (codePoint >= 0x20000 && codePoint <= 0x2A6DF) ||
      char === '々' ||
      char === '〆' ||
      char === 'ヶ'
    );
  }

  function isKanaCharacter(char) {
    return typeof char === 'string' && KANA_REGEX.test(char);
  }

  function textContainsKanji(text) {
    if (typeof text !== 'string' || !text) return false;
    for (const char of text) {
      if (isKanjiLikeCharacter(char)) {
        return true;
      }
    }
    return false;
  }

  function normalizeKana(value) {
    const source = typeof value === 'string' ? value : '';
    let normalized = '';
    for (const char of source) {
      const codePoint = char.codePointAt(0);
      if (codePoint >= 0x30A1 && codePoint <= 0x30F6) {
        normalized += String.fromCodePoint(codePoint - 0x60);
      } else {
        normalized += char;
      }
    }
    return normalized;
  }

  function normalizeReading(value) {
    return normalizeKana(String(value || '').trim()).replace(/\s+/g, '');
  }

  function applyStrictReadingReplacement(surfaceText, reading) {
    const normalizedSurface = typeof surfaceText === 'string' ? surfaceText.trim() : '';
    const normalizedReading = normalizeReading(reading);
    if (!normalizedSurface || !normalizedReading) {
      return normalizedReading;
    }

    return STRICT_READING_REPLACEMENTS.get(`${normalizedSurface}\t${normalizedReading}`) || normalizedReading;
  }

  function classifySurfaceChar(char) {
    if (isKanjiLikeCharacter(char)) {
      return 'kanji';
    }
    if (isKanaCharacter(char)) {
      return 'kana';
    }
    return 'other';
  }

  function chunkSurfaceText(surfaceText) {
    const chunks = [];
    if (typeof surfaceText !== 'string' || !surfaceText) {
      return chunks;
    }

    let index = 0;
    while (index < surfaceText.length) {
      const char = surfaceText[index];
      const type = classifySurfaceChar(char);
      const start = index;
      let text = char;
      index += 1;
      while (index < surfaceText.length && classifySurfaceChar(surfaceText[index]) === type) {
        text += surfaceText[index];
        index += 1;
      }
      chunks.push({ type, text, start, end: index });
    }

    return chunks;
  }

  function normalizeAnnotationList(surfaceText, annotations, segmentStart) {
    const seen = new Set();
    const safeStart = Number.isFinite(segmentStart) ? Math.max(0, Math.floor(segmentStart)) : 0;
    const normalized = [];

    (Array.isArray(annotations) ? annotations : []).forEach((annotation) => {
      if (!annotation || typeof annotation !== 'object') return;

      const start = Number.isFinite(Number(annotation.start))
        ? Math.floor(Number(annotation.start))
        : null;
      const end = Number.isFinite(Number(annotation.end))
        ? Math.floor(Number(annotation.end))
        : null;
      const rawReading = normalizeReading(annotation.reading);

      if (start === null || end === null || end <= start || !rawReading) {
        return;
      }

      const relativeStart = start - safeStart;
      const relativeEnd = end - safeStart;
      if (relativeStart < 0 || relativeEnd > surfaceText.length) {
        return;
      }

      const text = surfaceText.slice(relativeStart, relativeEnd);
      if (!text || !textContainsKanji(text)) {
        return;
      }

      const reading = applyStrictReadingReplacement(text, rawReading);

      const key = `${start}:${end}:${reading}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);

      normalized.push({
        start,
        end,
        text,
        reading,
      });
    });

    normalized.sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));
    return normalized;
  }

  function buildAnnotationsFromSurfaceAndReading(surfaceText, reading, segmentStart) {
    const normalizedReading = normalizeReading(reading);
    const safeStart = Number.isFinite(segmentStart) ? Math.max(0, Math.floor(segmentStart)) : 0;

    if (!surfaceText || !normalizedReading || !textContainsKanji(surfaceText)) {
      return [];
    }

    const chunks = chunkSurfaceText(surfaceText);
    if (chunks.length === 0) {
      return [];
    }

    const annotations = [];
    let readingCursor = 0;

    chunks.forEach((chunk, index) => {
      if (chunk.type !== 'kanji') {
        const literal = normalizeReading(chunk.text);
        if (!literal) {
          return;
        }

        const literalIndex = normalizedReading.indexOf(literal, readingCursor);
        if (literalIndex >= readingCursor) {
          readingCursor = literalIndex + literal.length;
        }
        return;
      }

      let nextLiteral = '';
      for (let i = index + 1; i < chunks.length; i++) {
        if (chunks[i].type === 'kanji') {
          continue;
        }
        nextLiteral = normalizeReading(chunks[i].text);
        if (nextLiteral) {
          break;
        }
      }

      let readingEnd = normalizedReading.length;
      if (nextLiteral) {
        const literalIndex = normalizedReading.indexOf(nextLiteral, readingCursor);
        if (literalIndex >= readingCursor) {
          readingEnd = literalIndex;
        }
      }

      const chunkReading = normalizedReading.slice(readingCursor, readingEnd);
      if (chunkReading) {
        annotations.push({
          start: safeStart + chunk.start,
          end: safeStart + chunk.end,
          text: chunk.text,
          reading: chunkReading,
        });
      }

      readingCursor = readingEnd;
    });

    const normalized = normalizeAnnotationList(surfaceText, annotations, safeStart);
    if (normalized.length > 0) {
      return normalized;
    }

    return normalizeAnnotationList(surfaceText, [{
      start: safeStart,
      end: safeStart + surfaceText.length,
      text: surfaceText,
      reading: normalizedReading,
    }], safeStart);
  }

  function buildAnnotationsFromJitenReadingMarkup(surfaceText, markup, segmentStart) {
    const source = typeof markup === 'string' ? markup.trim() : '';
    const safeStart = Number.isFinite(segmentStart) ? Math.max(0, Math.floor(segmentStart)) : 0;

    if (!surfaceText || !source || !textContainsKanji(surfaceText)) {
      return [];
    }

    const annotations = [];
    let surfaceCursor = 0;
    let baseStart = -1;
    let baseText = '';

    for (let index = 0; index < source.length; index++) {
      const char = source[index];
      if (char === '[') {
        const closeIndex = source.indexOf(']', index + 1);
        if (closeIndex < 0) {
          break;
        }

        const reading = normalizeReading(source.slice(index + 1, closeIndex));
        if (baseText && reading) {
          annotations.push({
            start: safeStart + baseStart,
            end: safeStart + surfaceCursor,
            text: baseText,
            reading,
          });
        }

        baseStart = -1;
        baseText = '';
        index = closeIndex;
        continue;
      }

      if (char === ']') {
        continue;
      }

      const nextSurfaceIndex = surfaceText.indexOf(char, surfaceCursor);
      if (nextSurfaceIndex < 0) {
        continue;
      }

      surfaceCursor = nextSurfaceIndex;
      if (isKanjiLikeCharacter(char)) {
        if (!baseText) {
          baseStart = surfaceCursor;
        }
        baseText += char;
      } else {
        baseStart = -1;
        baseText = '';
      }

      surfaceCursor += char.length;
    }

    return normalizeAnnotationList(surfaceText, annotations, safeStart);
  }

  function advanceSurfaceCursor(surfaceText, literal, surfaceCursor) {
    if (!literal) {
      return surfaceCursor;
    }
    if (surfaceText.startsWith(literal, surfaceCursor)) {
      return surfaceCursor + literal.length;
    }
    const nextIndex = surfaceText.indexOf(literal, surfaceCursor);
    if (nextIndex >= surfaceCursor) {
      return nextIndex + literal.length;
    }
    return surfaceCursor;
  }

  function buildAnnotationsFromJpdbFurigana(surfaceText, furigana, segmentStart) {
    const safeStart = Number.isFinite(segmentStart) ? Math.max(0, Math.floor(segmentStart)) : 0;
    if (!surfaceText || !Array.isArray(furigana) || !textContainsKanji(surfaceText)) {
      return [];
    }

    const annotations = [];
    let surfaceCursor = 0;

    furigana.forEach((part) => {
      if (typeof part === 'string') {
        surfaceCursor = advanceSurfaceCursor(surfaceText, part, surfaceCursor);
        return;
      }

      if (!Array.isArray(part) || typeof part[0] !== 'string') {
        return;
      }

      const baseText = part[0];
      const reading = normalizeReading(part[1]);
      const baseStart = surfaceText.startsWith(baseText, surfaceCursor)
        ? surfaceCursor
        : surfaceText.indexOf(baseText, surfaceCursor);
      if (baseStart < 0) {
        return;
      }

      const baseEnd = baseStart + baseText.length;
      if (reading) {
        annotations.push({
          start: safeStart + baseStart,
          end: safeStart + baseEnd,
          text: baseText,
          reading,
        });
      }
      surfaceCursor = baseEnd;
    });

    return normalizeAnnotationList(surfaceText, annotations, safeStart);
  }

  function normalizeSegment(surfaceText, segment, lineText, segmentSource, segmentStart, segmentEnd) {
    const text = typeof surfaceText === 'string' ? surfaceText : '';
    const start = Number.isFinite(Number(segmentStart))
      ? Math.max(0, Math.floor(Number(segmentStart)))
      : 0;
    const end = Number.isFinite(Number(segmentEnd))
      ? Math.max(start, Math.floor(Number(segmentEnd)))
      : Math.max(start, start + text.length);

    if (!text) {
      return {
        text: '',
        start,
        end,
        hasReading: false,
        reading: null,
        annotations: [],
        source: segmentSource || null,
      };
    }

    let annotations = [];
    if (Array.isArray(segment && segment.annotations)) {
      annotations = normalizeAnnotationList(text, segment.annotations, start);
    }

    if (annotations.length === 0 && segment && Array.isArray(segment.jpdbFurigana)) {
      annotations = buildAnnotationsFromJpdbFurigana(text, segment.jpdbFurigana, start);
    }

    if (annotations.length === 0 && segment && typeof segment.jitenReadingMarkup === 'string') {
      annotations = buildAnnotationsFromJitenReadingMarkup(text, segment.jitenReadingMarkup, start);
    }

    if (annotations.length === 0) {
      annotations = buildAnnotationsFromSurfaceAndReading(text, segment && segment.reading, start);
    }

    const normalizedReading = applyStrictReadingReplacement(text, segment && segment.reading);

    return {
      text,
      start,
      end,
      hasReading: annotations.length > 0,
      reading: normalizedReading || null,
      annotations,
      source: segmentSource || null,
      lineText: typeof lineText === 'string' ? lineText : '',
    };
  }

  function normalizeBackendSegments(lineText, rawSegments, options = {}) {
    const source = typeof options.source === 'string' ? options.source : null;
    const safeText = typeof lineText === 'string' ? lineText : '';
    const rawList = Array.isArray(rawSegments) ? rawSegments : [];

    const normalized = rawList
      .map((segment) => {
        if (!segment || typeof segment !== 'object') {
          return null;
        }

        const start = Number.isFinite(Number(segment.start))
          ? Math.max(0, Math.floor(Number(segment.start)))
          : null;
        const end = Number.isFinite(Number(segment.end))
          ? Math.max(0, Math.floor(Number(segment.end)))
          : null;
        const text = typeof segment.text === 'string'
          ? segment.text
          : ((start !== null && end !== null) ? safeText.slice(start, end) : '');

        const resolvedStart = start !== null ? start : 0;
        const resolvedEnd = end !== null ? end : resolvedStart + text.length;

        return normalizeSegment(text, segment, safeText, source, resolvedStart, resolvedEnd);
      })
      .filter(Boolean);

    if (normalized.length > 0) {
      return normalized;
    }

    return [{
      text: safeText,
      start: 0,
      end: safeText.length,
      hasReading: false,
      reading: null,
      annotations: [],
      source,
      lineText: safeText,
    }];
  }

  return {
    isKanjiLikeCharacter,
    isKanaCharacter,
    textContainsKanji,
    normalizeKana,
    normalizeReading,
    applyStrictReadingReplacement,
    buildAnnotationsFromSurfaceAndReading,
    buildAnnotationsFromJitenReadingMarkup,
    buildAnnotationsFromJpdbFurigana,
    normalizeBackendSegments,
  };
}));