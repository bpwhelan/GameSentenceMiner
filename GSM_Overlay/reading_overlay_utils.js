// Unified "reading overlay" module.
//
// Owns the logic for turning a line of text into reading annotations that the
// overlay renders above each character (furigana for Japanese, pinyin for
// Chinese, and potentially other reading systems in the future).
//
// Every backend produces the same annotation shape that the renderer consumes:
//   { start, end, text, reading }
// where `start`/`end` are JS string indices into the line text.
//
// - Japanese: delegates to furigana_utils.js (backend tokenizer segments).
// - Chinese: uses the pinyin-pro library, which runs entirely in the renderer
//   and needs no tokenizer backend.
(function (root, factory) {
  let FuriganaUtils = null;
  try {
    FuriganaUtils = (typeof require === 'function') ? require('./furigana_utils.js') : null;
  } catch (e) {
    FuriganaUtils = null;
  }
  if (!FuriganaUtils && root && root.GSMFuriganaUtils) {
    FuriganaUtils = root.GSMFuriganaUtils;
  }

  let PinyinPro = null;
  try {
    PinyinPro = (typeof require === 'function') ? require('pinyin-pro') : null;
  } catch (e) {
    PinyinPro = null;
  }
  if (!PinyinPro && root && root.pinyinPro) {
    PinyinPro = root.pinyinPro;
  }

  const api = factory(FuriganaUtils, PinyinPro);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.GSMReadingOverlay = api;
  }
}(typeof window !== 'undefined' ? window : globalThis, function (FuriganaUtils, PinyinPro) {
  const LANGUAGE = Object.freeze({
    JAPANESE: 'japanese',
    CHINESE: 'chinese',
  });

  // ---------------------------------------------------------------------------
  // Pinyin grouping mode.
  //
  // Flip this constant to change how Chinese pinyin is laid out above the text:
  //   'character' -> one pinyin syllable above each individual Han character.
  //   'word'      -> pinyin grouped above whole words (pinyin-pro segmentation).
  //
  // The user wanted both implemented so the behaviour can be compared by
  // changing this single value.
  // ---------------------------------------------------------------------------
  const PINYIN_GROUPING_MODE = 'word'; // 'character' | 'word'

  // Tone notation for pinyin readings. 'symbol' = diacritic tone marks (mā má mǎ mà).
  const PINYIN_TONE_TYPE = 'symbol';

  function normalizeLanguage(value) {
    const text = String(value || '').trim().toLowerCase();
    return text === LANGUAGE.CHINESE ? LANGUAGE.CHINESE : LANGUAGE.JAPANESE;
  }

  function pinyinAvailable() {
    return !!(PinyinPro && typeof PinyinPro.pinyin === 'function');
  }

  // Languages that need an external tokenizer backend (MeCab/Sudachi/Yomitan/etc.)
  // before readings can be produced. Chinese pinyin is computed locally, so it
  // returns false and the renderer skips the backend round-trip entirely.
  function requiresBackend(language) {
    return normalizeLanguage(language) === LANGUAGE.JAPANESE;
  }

  // Whether readings can currently be produced for the language without relying
  // on the renderer's backend-readiness check. Japanese defers to the caller
  // (returns true here and lets index.html gate on the tokenizer backend).
  function isReady(language) {
    if (normalizeLanguage(language) === LANGUAGE.CHINESE) {
      return pinyinAvailable();
    }
    return true;
  }

  // ---- Japanese -------------------------------------------------------------

  function buildJapaneseAnnotations(lineText, segments) {
    const text = typeof lineText === 'string' ? lineText : '';
    const normalizedSegments = (FuriganaUtils && typeof FuriganaUtils.normalizeBackendSegments === 'function')
      ? FuriganaUtils.normalizeBackendSegments(text, segments || [], { source: 'overlay-renderer' })
      : (Array.isArray(segments) ? segments : []);

    const annotations = [];
    const seen = new Set();

    normalizedSegments.forEach((segment) => {
      if (!segment) {
        return;
      }

      const segmentAnnotations = Array.isArray(segment.annotations) && segment.annotations.length > 0
        ? segment.annotations
        : ((segment.hasReading && segment.reading)
          ? [{
              start: segment.start,
              end: segment.end,
              text: segment.text,
              reading: segment.reading,
            }]
          : []);

      segmentAnnotations.forEach((annotation) => {
        if (!annotation || !annotation.reading) {
          return;
        }
        const start = Number(annotation.start);
        const end = Number(annotation.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
          return;
        }

        const key = `${start}:${end}:${annotation.reading}`;
        if (seen.has(key)) {
          return;
        }
        seen.add(key);

        annotations.push({
          start,
          end,
          text: annotation.text || text.slice(start, end),
          reading: annotation.reading,
        });
      });
    });

    annotations.sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));
    return annotations;
  }

  // ---- Chinese (pinyin) -----------------------------------------------------

  // pinyin-pro reports tone as `num`: 1-4 for the four tones and 0 for the
  // neutral tone (轻声). Map to 1-5 so the renderer can color-code each syllable.
  function toneFromNum(num) {
    const n = Number(num);
    if (!Number.isFinite(n) || n <= 0 || n > 4) {
      return 5; // neutral / unknown
    }
    return n;
  }

  // Per-character pinyin objects, 1:1 with the source string indices.
  // Each entry is { origin, pinyin, isZh, num, ... } from pinyin-pro.
  function pinyinCharObjects(lineText) {
    if (!pinyinAvailable()) {
      return [];
    }
    try {
      const result = PinyinPro.pinyin(lineText, { type: 'all', toneType: PINYIN_TONE_TYPE });
      return Array.isArray(result) ? result : [];
    } catch (e) {
      return [];
    }
  }

  function buildPinyinAnnotationsByCharacter(lineText) {
    const objs = pinyinCharObjects(lineText);
    const annotations = [];
    let index = 0;
    for (const obj of objs) {
      const origin = (obj && typeof obj.origin === 'string') ? obj.origin : '';
      const length = origin.length || 1;
      const reading = obj && typeof obj.pinyin === 'string' ? obj.pinyin.trim() : '';
      if (obj && obj.isZh && reading) {
        annotations.push({
          start: index,
          end: index + length,
          text: origin,
          reading,
          // One syllable per character; `parts` carries tone for color-coding.
          parts: [{ text: reading, tone: toneFromNum(obj.num) }],
        });
      }
      index += length;
    }
    return annotations;
  }

  function buildPinyinAnnotationsByWord(lineText) {
    if (!pinyinAvailable() || typeof PinyinPro.segment !== 'function') {
      return buildPinyinAnnotationsByCharacter(lineText);
    }

    // Per-character readings give context-aware (polyphonic) pinyin and let us
    // join syllables with spaces over a word span.
    const chars = pinyinCharObjects(lineText);

    let segments;
    try {
      segments = PinyinPro.segment(lineText);
    } catch (e) {
      return buildPinyinAnnotationsByCharacter(lineText);
    }
    if (!Array.isArray(segments)) {
      return buildPinyinAnnotationsByCharacter(lineText);
    }

    const annotations = [];
    let index = 0;
    for (const seg of segments) {
      const origin = seg && typeof seg.origin === 'string' ? seg.origin : '';
      const length = origin.length;
      if (length <= 0) {
        continue;
      }

      const slice = chars.slice(index, index + length);
      const zhEntries = slice.filter((c) => c && c.isZh && typeof c.pinyin === 'string' && c.pinyin.trim());
      if (zhEntries.length > 0) {
        // Span only the contiguous portion covered by Han characters.
        let firstZh = -1;
        let lastZh = -1;
        for (let i = 0; i < slice.length; i++) {
          if (slice[i] && slice[i].isZh && slice[i].pinyin && slice[i].pinyin.trim()) {
            if (firstZh < 0) firstZh = i;
            lastZh = i;
          }
        }
        const parts = zhEntries.map((c) => ({ text: c.pinyin.trim(), tone: toneFromNum(c.num) }));
        const reading = parts.map((p) => p.text).join(' ');
        annotations.push({
          start: index + firstZh,
          end: index + lastZh + 1,
          text: origin,
          reading,
          // Each syllable in the word keeps its own tone for color-coding.
          parts,
        });
      }

      index += length;
    }
    return annotations;
  }

  function buildPinyinAnnotations(lineText) {
    if (typeof lineText !== 'string' || !lineText) {
      return [];
    }
    if (PINYIN_GROUPING_MODE === 'word') {
      return buildPinyinAnnotationsByWord(lineText);
    }
    return buildPinyinAnnotationsByCharacter(lineText);
  }

  // ---- Dispatch -------------------------------------------------------------

  function getAnnotationsForLine(language, lineText, segments) {
    const text = typeof lineText === 'string' ? lineText : '';
    if (!text) {
      return [];
    }
    if (normalizeLanguage(language) === LANGUAGE.CHINESE) {
      return buildPinyinAnnotations(text);
    }
    return buildJapaneseAnnotations(text, segments);
  }

  return {
    LANGUAGE,
    PINYIN_GROUPING_MODE,
    normalizeLanguage,
    requiresBackend,
    isReady,
    pinyinAvailable,
    getAnnotationsForLine,
    buildJapaneseAnnotations,
    buildPinyinAnnotations,
  };
}));
