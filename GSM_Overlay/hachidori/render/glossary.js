/*
 * Structured-content, furigana, and dictionary-style rendering for the
 * Hachidori popup.
 *
 * Ported from GameSentenceMiner PR #549
 * (GSM_Overlay/features/hoshidicts/reader.js). Structured content follows
 * Yomitan's structured-content schema; the furigana segmentation and
 * pitch-accent ruby are adapted from Hoshi Reader:
 * https://github.com/Manhhao/Hoshi-Reader/tree/c31c9d0ce376ff83bf6a91d908bf9f8e0fb4947b/Features/Popup
 *
 * Copyright (C) 2026 Manhhao
 * Copyright (C) 2023-2026 Yomitan Authors
 * Copyright (C) 2021-2022 Yomichan Authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.HDGlossary = api;
  }
}(globalThis, function () {
  "use strict";

  const MAX_TEXT_LENGTH = 128 * 1024;
  const MAX_LOOKUP_TEXT_BYTES = 4 * 1024;
  const MAX_MEDIA_DISPLAY_SIZE = 1024;
  const MAX_STRUCTURED_NODES = 1_048_576;
  const MAX_STRUCTURED_LOCATION_SEGMENTS = 64;
  const MAX_STRUCTURED_DATA_ATTRIBUTES = 64;
  const MAX_STRUCTURED_DATA_KEY_LENGTH = 64;
  const MAX_STRUCTURED_DATA_VALUE_LENGTH = 4096;
  const MAX_DICTIONARY_STYLE_BYTES = 256 * 1024;
  const MAX_DICTIONARY_STYLES_BYTES = 2 * 1024 * 1024;
  // These compatibility aliases are typed at each use site. Even a page's
  // @property registration must not turn their values into resource URLs.
  const DICTIONARY_STYLE_VARIABLES = new Set([
    "--text-color", "--background-color", "--fg", "--canvas", "--font-size-no-units",
  ]);
  const DICTIONARY_STYLE_GROUPS = new Set([
    "CSSMediaRule", "CSSSupportsRule", "CSSContainerRule",
  ]);
  const DICTIONARY_FONT_FAMILIES = new Set([
    "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
    "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "fangsong",
    "inherit", "initial", "unset", "revert", "revert-layer",
  ]);
  const HAN_CHARACTER_PATTERN =
    /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}]/u;
  // Yomitan's isCodePointKana: the Hiragana and Katakana blocks. Halfwidth
  // katakana is not kana there, so it joins the characters beside it.
  const KANA_PATTERN = /[\u3040-\u30ff]/u;
  // The kana rendaku voices (箱 はこ, ばこ). Each voiced kana follows its base
  // in Unicode, and the は row's half-voiced kana follows that (発 はつ, ぱつ).
  const DAKUTEN_KANA = "かきくけこさしすせそたちつてとはひふへほ";
  const HANDAKUTEN_KANA = "はひふへほ";
  // Modern kana usage writes a voiced ち or つ as じ or ず in a compound no
  // longer felt as two words (世界中 せかいじゅう, 稲妻 いなずま), as ぢ or づ in
  // others (鼻血 はなぢ).
  const ZI_ZU_KANA = { ち: "じ", つ: "ず" };
  // A kun'yomi ending in an u-row kana has its masu-stem in the i row
  // (す.く, すき; きら.う, きらい).
  const U_ROW_KANA = "うくぐすつぬぶむる";
  const I_ROW_KANA = "いきぎしちにびみり";
  // The final kana a sokuon can replace (一 いち, いっ).
  const SOKUON_KANA = "つちくきり";
  const NO_KANJI_READINGS = new Set();
  const NO_KANJI_COMPOUNDS = [];
  // readKanwaRun's shares where more than one split reads.
  const AMBIGUOUS_SPLIT = Symbol("ambiguous split");
  const PITCH_SMALL_KANA = new Set(Array.from(
    "ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ"
  ));
  const COMBINING_MARK_PATTERN = /\p{Mark}/u;
  // Yomitan's getLanguageFromText (text-utilities.js, with ja/japanese.js and
  // zh/chinese.js ranges) for text with no inherited language: any Japanese
  // character makes it "ja"; otherwise a Chinese-only character (bopomofo,
  // small and vertical forms, ideographic symbols) makes it "zh".
  const JAPANESE_TEXT_PATTERN =
    /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff01-\uff1f\uff21-\uff3f\uff41-\uff9f\uffe0-\uffee\u{20000}-\u{2a6df}\u{2a700}-\u{2ee5f}\u{2f800}-\u{2fa1f}\u{30000}-\u{323af}]/u;
  const CHINESE_TEXT_PATTERN = /[\u3100-\u312f\u31a0-\u31bf\ufe10-\ufe1f\ufe50-\ufe6f\u{16fe0}-\u{16fff}]/u;

  const ALLOWED_STRUCTURED_TAGS = new Set([
    "a",
    "br",
    "code",
    "details",
    "div",
    "em",
    "img",
    "li",
    "ol",
    "p",
    "rp",
    "rt",
    "ruby",
    "small",
    "span",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
  ]);
  const IGNORED_STRUCTURED_TAGS = new Set([
    "audio",
    "button",
    "canvas",
    "iframe",
    "input",
    "script",
    "source",
    "style",
    "svg",
    "video",
  ]);
  const STRUCTURED_TAGS_WITHOUT_CONTENT = new Set(["br", "img"]);
  // Yomitan's _setStructuredContentElementStyle (structured-content-generator.js
  // at 67db60d), in its order: each shorthand is set before the longhands that
  // refine it. textDecorationLine sets the text-decoration shorthand there too.
  const STRUCTURED_STYLE_PROPERTIES = [
    ["fontStyle", "font-style"],
    ["fontWeight", "font-weight"],
    ["fontSize", "font-size"],
    ["color", "color"],
    ["background", "background"],
    ["backgroundColor", "background-color"],
    ["verticalAlign", "vertical-align"],
    ["textAlign", "text-align"],
    ["textEmphasis", "text-emphasis"],
    ["textShadow", "text-shadow"],
    ["textDecorationLine", "text-decoration"],
    ["textDecorationStyle", "text-decoration-style"],
    ["textDecorationColor", "text-decoration-color"],
    ["borderColor", "border-color"],
    ["borderStyle", "border-style"],
    ["borderRadius", "border-radius"],
    ["borderWidth", "border-width"],
    ["clipPath", "clip-path"],
    ["margin", "margin"],
    ["marginTop", "margin-top"],
    ["marginLeft", "margin-left"],
    ["marginRight", "margin-right"],
    ["marginBottom", "margin-bottom"],
    ["padding", "padding"],
    ["paddingTop", "padding-top"],
    ["paddingLeft", "padding-left"],
    ["paddingRight", "padding-right"],
    ["paddingBottom", "padding-bottom"],
    ["wordBreak", "word-break"],
    ["whiteSpace", "white-space"],
    ["cursor", "cursor"],
    ["listStyleType", "list-style-type"],
  ];
  // Functions that could fetch a resource or reach past the dictionary's own
  // declarations (attributes, page-registered worklets and custom functions).
  // The popup is a shadow root in the page's origin, so dictionary stylesheets
  // and inline styles both refuse them; CSSOM judges everything else, as the
  // browser does for Yomitan.
  const UNSAFE_STYLE_FUNCTION =
    /\b(?:url|src|image-set|paint|attr)\s*\(|(?<![\w\P{ASCII}-])--[\w\P{ASCII}-]+\(/iu;

  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function boundedString(value, maxLength = MAX_TEXT_LENGTH) {
    return typeof value === "string" ? value.slice(0, maxLength) : "";
  }

  function structuredContentLocation(path) {
    const omitted = Math.max(0, path.length - MAX_STRUCTURED_LOCATION_SEGMENTS);
    const segments = omitted > 0
      ? [...path.slice(0, MAX_STRUCTURED_LOCATION_SEGMENTS / 2),
          `[${omitted} path segments omitted]`,
          ...path.slice(-MAX_STRUCTURED_LOCATION_SEGMENTS / 2)]
      : path;
    let location = "";
    for (const segment of segments) {
      if (typeof segment === "string" && segment.startsWith("[")) {
        location += segment;
        continue;
      }
      location += typeof segment === "number"
        ? `[${segment}]`
        : `${location ? "." : ""}${segment}`;
    }
    return location || "structuredContent";
  }

  function structuredContentLimitError(kind, actual, limit, path) {
    const error = new RangeError(
      `Structured content ${kind} ${actual} exceeds limit ${limit} at ${structuredContentLocation(path)}`
    );
    error.code = "structured-content-limit";
    error.structuredContentActual = actual;
    error.structuredContentLimit = limit;
    error.structuredContentLimitKind = kind;
    error.structuredContentLocation = structuredContentLocation(path);
    return error;
  }

  function countStructuredNode(state, path) {
    if (state.nodes >= MAX_STRUCTURED_NODES) {
      throw structuredContentLimitError("node count", state.nodes + 1, MAX_STRUCTURED_NODES, path);
    }
    state.nodes += 1;
  }

  function toHiragana(text) {
    return String(text || "").replace(
      /[\u30a1-\u30f6]/gu,
      (character) => String.fromCharCode(character.charCodeAt(0) - 0x60)
    );
  }

  function splitPitchAccentMorae(reading) {
    const morae = [];
    for (const character of Array.from(String(reading || "").normalize("NFC"))) {
      const previousIndex = morae.length - 1;
      if (
        previousIndex >= 0 &&
        (PITCH_SMALL_KANA.has(character) || COMBINING_MARK_PATTERN.test(character))
      ) {
        morae[previousIndex] += character;
      } else {
        morae.push(character);
      }
    }
    return morae;
  }

  // A downstep within the word, or a pattern giving each mora's level and
  // optionally the following particle's. moraCount null accepts any length.
  function isPitchForMorae(positions, moraCount) {
    if (typeof positions === "string") {
      return /^[HL]+$/u.test(positions)
        && (moraCount === null || (positions.length >= moraCount && positions.length <= moraCount + 1));
    }
    return Number.isInteger(positions) && positions >= 0 && (moraCount === null || positions <= moraCount);
  }

  function buildPitchAccentMorae(reading, positions) {
    const morae = splitPitchAccentMorae(reading);
    if (morae.length === 0 || !isPitchForMorae(positions, morae.length)) {
      return null;
    }

    const levels = morae.map((_, index) => isMoraPitchHigh(index, positions) ? "high" : "low");
    const levelAfterWord = isMoraPitchHigh(morae.length, positions) ? "high" : "low";
    return morae.map((text, index) => {
      const level = levels[index];
      const nextLevel = levels[index + 1] || levelAfterWord;
      return {
        text,
        level,
        transition: level === nextLevel
          ? null
          : level === "low" ? "rise" : "drop",
      };
    });
  }

  // Yomitan's japanese.js at 67db60d. A pitch is a downstep position or a
  // string of H/L levels, one per mora and optionally the particle's.
  function isMoraPitchHigh(moraIndex, pitchPositions) {
    if (typeof pitchPositions === "string") {
      return pitchPositions[moraIndex] === "H";
    }
    switch (pitchPositions) {
      case 0: return moraIndex > 0;
      case 1: return moraIndex < 1;
      default: return moraIndex > 0 && moraIndex < pitchPositions;
    }
  }

  function getDownstepPositions(pitchString) {
    const downsteps = [];
    for (let index = 1; index < pitchString.length; index += 1) {
      if (pitchString[index - 1] === "H" && pitchString[index] === "L") {
        downsteps.push(index);
      }
    }
    if (downsteps.length === 0) {
      downsteps.push(pitchString.startsWith("L") ? 0 : -1);
    }
    return downsteps;
  }

  // hoshidicts keeps Yomitan's string form in `pattern` beside a placeholder
  // numeric position of 0, so any pattern is the pitch: an unsupported one is
  // refused where it is drawn, never read as heiban.
  function pitchAccentPositions(pitch) {
    return typeof pitch?.pattern === "string" && pitch.pattern !== "" ? pitch.pattern : pitch?.position;
  }

  // The [n] a pitch shows: the downstep mora, or each one for a pattern.
  function pitchAccentDownstep(pitch) {
    const positions = pitchAccentPositions(pitch);
    return String(typeof positions === "string" ? getDownstepPositions(positions) : positions);
  }

  // The endings of the dictionary forms Yomitan's japanese-transforms.js
  // (d3c54c1) deinflects each class to, with the classical forms dictionaries
  // give the same classes (聞こゆ, 相語らふ; サ変 期す, ザ変 禁ず). As a
  // dictionary can give a word the wrong one of two related classes (驚く as
  // v1), v1, v5 and vk share every verb ending and vs and vz every suru and
  // zuru ending. An i-adjective ends in い: 講談社 日本語大辞典 gives adj-i to
  // nouns ending in し (遠回し), so a classical one (遅し) does not count. A
  // verb or adjective ending also matches in katakana (ムカツク, キツイ), but a
  // suru one does not: ハッスル (精選版 vs) would end in one.
  const VERB_ENDING = /[うくぐすずつづぬふぶむゆるウクグスズツヅヌフブムユル]$/u;
  const SURU_ENDING = new RegExp(`(?:する|為る|ずる|${HAN_CHARACTER_PATTERN.source}[すず])$`, "u");
  const DICTIONARY_FORM_ENDINGS = [
    ["v1", VERB_ENDING], ["v5", VERB_ENDING], ["vk", VERB_ENDING],
    ["vs", SURU_ENDING], ["vz", SURU_ENDING], ["adj-i", /[いイ]$/u],
  ];

  // Yomitan's getPitchCategory (japanese.js:367 at d3c54c1) with its
  // isNonNounVerbOrAdjective (dictionary-data-util.js:320): a pattern's
  // category is its first downstep and any downstep of a verb or i-adjective is
  // kifuku. Unlike Yomitan, a word class counts only where the term's
  // expression ends as that class's dictionary form does, because some
  // dictionaries tag nouns and na-adjectives with one (自由, #608). This only
  // takes kifuku away. Also unlike Yomitan, a pattern that rises again after
  // its first downstep has no category (#596). Within one accent phrase the
  // pitch never rises after it falls, so such a pattern is not one phrase: it
  // has several and does not say where the next one starts, 二十四時間
  // に＼じゅう・よじ＼かん (atamadaka, then nakadaka) and 十人十色 じゅ＼うにん・と＼いろ
  // (atamadaka twice) both being HLLLHLL, or it is a pitch no group describes.
  // A kana term is written as its reading. The popup and
  // {pitch-accent-categories} share it.
  function pitchAccentCategory(reading, pitch, wordClasses = [], expression = reading) {
    const position = Number(pitchAccentDownstep(pitch).split(",")[0]);
    if (position === 0) return "heiban";
    if (Number.isNaN(position) || position < 0) return null;
    const positions = pitchAccentPositions(pitch);
    if (typeof positions === "string" && positions.includes("H", position)) return null;
    const classes = new Set(wordClasses);
    if (!(classes.has("vs") && classes.has("n"))
      && DICTIONARY_FORM_ENDINGS.some(([rule, ending]) => classes.has(rule) && ending.test(expression))) return "kifuku";
    if (position === 1) return "atamadaka";
    return position >= splitPitchAccentMorae(reading).length ? "odaka" : "nakadaka";
  }

  // Yomitan's getFrequencyNumbers and getFrequencyHarmonic/-Average
  // (ext/js/data/anki-note-data-creator.js:178-245 at yomidevs/yomitan@d3c54c1).
  // A value's number is the leading digits of its display value, else the value
  // itself, when positive; "312, 19896㋕" is 312 and "14,200" is 14, as there.
  function frequencyNumber(frequency) {
    const digits = typeof frequency?.displayValue === "string" ? /^\d+/u.exec(frequency.displayValue) : null;
    const display = digits ? Number.parseInt(digits[0], 10) : 0;
    return display > 0 ? display : frequency?.value;
  }

  // Each dictionary's first value only: one whose first value has no positive
  // number adds nothing. The groups are already filtered by mode.
  function frequencyNumbers(groups) {
    const numbers = [];
    const seen = new Set();
    for (const group of groups) {
      if (seen.has(group.dictionary)) continue;
      seen.add(group.dictionary);
      const value = group.frequencies.length > 0 ? frequencyNumber(group.frequencies[0]) : null;
      if (Number.isFinite(value) && value > 0) numbers.push(value);
    }
    return numbers;
  }

  // Yomitan's mode filter (anki-note-data-creator.js:184): a dictionary counts
  // for a requested mode unless it declares another one, so one without a mode
  // counts for every mode. A mode that is neither of Yomitan's two counts as none,
  // as everywhere else in Hachidori: Yomitan's index schema refuses one.
  const FREQUENCY_MODES = new Set(["rank-based", "occurrence-based"]);
  function frequencyModeMatches(frequencyMode, requested) {
    return !FREQUENCY_MODES.has(frequencyMode) || frequencyMode === requested;
  }

  // The floored harmonic (or arithmetic) mean; null where Yomitan returns -1.
  // The popup's averages and the Anki frequency markers share it.
  function frequencyMean(groups, harmonic = true) {
    const numbers = frequencyNumbers(groups);
    if (numbers.length === 0) return null;
    const total = numbers.reduce((sum, value) => sum + (harmonic ? 1 / value : value), 0);
    return Math.floor(harmonic ? numbers.length / total : total / numbers.length);
  }

  // japanese.js DIACRITIC_MAPPING: the character a dakuten form is built on.
  const DAKUTEN_BASES = new Map();
  {
    const kana = "うゔ-かが-きぎ-くぐ-けげ-こご-さざ-しじ-すず-せぜ-そぞ-ただ-ちぢ-つづ-てで-とど-はばぱひびぴふぶぷへべぺほぼぽワヷ-ヰヸ-ウヴ-ヱヹ-ヲヺ-カガ-キギ-クグ-ケゲ-コゴ-サザ-シジ-スズ-セゼ-ソゾ-タダ-チヂ-ツヅ-テデ-トド-ハバパヒビピフブプヘベペホボポ";
    for (let index = 0; index < kana.length; index += 3) {
      DAKUTEN_BASES.set(kana[index + 1], kana[index]);
      if (kana[index + 2] !== "-") DAKUTEN_BASES.set(kana[index + 2], kana[index]);
    }
  }

  // Yomitan's PronunciationGenerator (ext/js/display/pronunciation-generator.js
  // at 67db60d): the overlined text with its downstep hook and nasal and
  // devoice marks, the [n] notation and the SVG graph.
  function createPronunciationText(documentRef, morae, pitchPositions, nasalPositions, devoicePositions) {
    const nasalPositionsSet = nasalPositions.length > 0 ? new Set(nasalPositions) : null;
    const devoicePositionsSet = devoicePositions.length > 0 ? new Set(devoicePositions) : null;
    const container = documentRef.createElement("span");
    container.className = "pronunciation-text";
    for (let index = 0; index < morae.length; index += 1) {
      const next = index + 1;
      const mora = morae[index];
      const mora1 = documentRef.createElement("span");
      mora1.className = "pronunciation-mora";
      mora1.dataset.position = `${index}`;
      mora1.dataset.pitch = isMoraPitchHigh(index, pitchPositions) ? "high" : "low";
      mora1.dataset.pitchNext = isMoraPitchHigh(next, pitchPositions) ? "high" : "low";

      const characterNodes = [];
      for (const character of mora) {
        const characterNode = documentRef.createElement("span");
        characterNode.className = "pronunciation-character";
        characterNode.textContent = character;
        mora1.appendChild(characterNode);
        characterNodes.push(characterNode);
      }

      if (devoicePositionsSet !== null && devoicePositionsSet.has(next)) {
        mora1.dataset.devoice = "true";
        const indicator = documentRef.createElement("span");
        indicator.className = "pronunciation-devoice-indicator";
        mora1.appendChild(indicator);
      }
      if (nasalPositionsSet !== null && nasalPositionsSet.has(next) && characterNodes.length > 0) {
        mora1.dataset.nasal = "true";
        const group = documentRef.createElement("span");
        group.className = "pronunciation-character-group";
        const characterNode = characterNodes[0];
        const character = characterNode.textContent;
        const base = DAKUTEN_BASES.get(character);
        if (base !== undefined) {
          mora1.dataset.originalText = mora;
          characterNode.dataset.originalText = character;
          characterNode.textContent = base;
        }
        const diacritic = documentRef.createElement("span");
        diacritic.className = "pronunciation-nasal-diacritic";
        diacritic.textContent = "\u309a"; // Combining handakuten
        group.appendChild(diacritic);
        const indicator = documentRef.createElement("span");
        indicator.className = "pronunciation-nasal-indicator";
        group.appendChild(indicator);
        characterNode.parentNode.replaceChild(group, characterNode);
        group.insertBefore(characterNode, group.firstChild);
      }

      const line = documentRef.createElement("span");
      line.className = "pronunciation-mora-line";
      mora1.appendChild(line);
      container.appendChild(mora1);
    }
    return container;
  }

  function createPronunciationGraph(documentRef, morae, pitchPositions) {
    const count = morae.length;
    const svgns = "http://www.w3.org/2000/svg";
    const svg = documentRef.createElementNS(svgns, "svg");
    svg.setAttribute("xmlns", svgns);
    svg.setAttribute("class", "pronunciation-graph");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("viewBox", `0 0 ${50 * (count + 1)} 100`);
    if (count <= 0) return svg;

    const path1 = documentRef.createElementNS(svgns, "path");
    svg.appendChild(path1);
    const path2 = documentRef.createElementNS(svgns, "path");
    svg.appendChild(path2);
    const circle = (className, x, y, radius) => {
      const node = documentRef.createElementNS(svgns, "circle");
      node.setAttribute("class", className);
      node.setAttribute("cx", `${x}`);
      node.setAttribute("cy", `${y}`);
      node.setAttribute("r", radius);
      svg.appendChild(node);
    };

    const pathPoints = [];
    for (let index = 0; index < count; index += 1) {
      const highPitch = isMoraPitchHigh(index, pitchPositions);
      const x = index * 50 + 25;
      const y = highPitch ? 25 : 75;
      if (highPitch && !isMoraPitchHigh(index + 1, pitchPositions)) {
        circle("pronunciation-graph-dot-downstep1", x, y, "15");
        circle("pronunciation-graph-dot-downstep2", x, y, "5");
      } else {
        circle("pronunciation-graph-dot", x, y, "15");
      }
      pathPoints.push(`${x} ${y}`);
    }
    path1.setAttribute("class", "pronunciation-graph-line");
    path1.setAttribute("d", `M${pathPoints.join(" L")}`);

    pathPoints.splice(0, count - 1);
    const x = count * 50 + 25;
    const y = isMoraPitchHigh(count, pitchPositions) ? 25 : 75;
    const triangle = documentRef.createElementNS(svgns, "path");
    triangle.setAttribute("class", "pronunciation-graph-triangle");
    triangle.setAttribute("d", "M0 13 L15 -13 L-15 -13 Z");
    triangle.setAttribute("transform", `translate(${x},${y})`);
    svg.appendChild(triangle);
    pathPoints.push(`${x} ${y}`);
    path2.setAttribute("class", "pronunciation-graph-line-tail");
    path2.setAttribute("d", `M${pathPoints.join(" L")}`);
    return svg;
  }

  function createPronunciationDownstepPosition(documentRef, downstepPositions) {
    const downsteps = typeof downstepPositions === "string" ? getDownstepPositions(downstepPositions) : downstepPositions;
    const downstepPositionString = `${downsteps}`;
    const notation = documentRef.createElement("span");
    notation.className = "pronunciation-downstep-notation";
    notation.dataset.downstepPosition = downstepPositionString;
    for (const [className, text] of [["prefix", "["], ["number", downstepPositionString], ["suffix", "]"]]) {
      const part = documentRef.createElement("span");
      part.className = `pronunciation-downstep-notation-${className}`;
      part.textContent = text;
      notation.appendChild(part);
    }
    return notation;
  }

  // display-generator.js _createPronunciationPitchAccent with templates-display.html
  // "pronunciation": one pitch accent's li.pronunciation. A notation the
  // options hide is not built. data-pronunciation is its `reading [n]` label,
  // and data-pitch-category its accent group from the term's word classes and
  // expression.
  function createPronunciationPitchAccent(documentRef, reading, pitch,
    { text = true, position = true, graph = false, wordClasses = [], expression = reading } = {}) {
    const positions = pitchAccentPositions(pitch);
    const morae = splitPitchAccentMorae(reading);
    const node = documentRef.createElement("li");
    node.className = "pronunciation";
    node.dataset.pitchAccentDownstepPosition = `${positions}`;
    const category = pitchAccentCategory(reading, pitch, wordClasses, expression);
    if (category) node.dataset.pitchCategory = category;
    node.dataset.pronunciationType = "pitch-accent";
    if (pitch.nasal.length > 0) node.dataset.nasalMoraPosition = pitch.nasal.join(" ");
    if (pitch.devoice.length > 0) node.dataset.devoiceMoraPosition = pitch.devoice.join(" ");
    node.dataset.tagCount = "0";
    node.dataset.pronunciation = `${reading} [${pitchAccentDownstep(pitch)}]`;
    const child = (className, parent = node) => {
      const element = documentRef.createElement("span");
      element.className = className;
      parent.appendChild(element);
      return element;
    };
    child("pronunciation-tag-list tag-list").dataset.count = "0";
    Object.assign(child("pronunciation-disambiguation-list").dataset, { count: "0", termCount: "0", readingCount: "0" });
    const representations = child("pronunciation-representation-list");
    if (text) {
      const container = child("pronunciation-text-container", representations);
      container.lang = "ja";
      container.appendChild(createPronunciationText(documentRef, morae, positions, pitch.nasal, pitch.devoice));
    }
    if (position) {
      child("pronunciation-downstep-notation-container", representations)
        .appendChild(createPronunciationDownstepPosition(documentRef, positions));
    }
    if (graph) {
      child("pronunciation-graph-container", representations)
        .appendChild(createPronunciationGraph(documentRef, morae, positions));
    }
    return node;
  }

  function selectPitchAccent(
    pitchGroups,
    preferredDictionary = null,
    moraCount = null
  ) {
    const groups = Array.isArray(pitchGroups) ? pitchGroups : [];
    const maximumPosition = Number.isInteger(moraCount) && moraCount >= 0
      ? moraCount
      : null;
    const preferred = typeof preferredDictionary === "string"
      ? preferredDictionary.trim()
      : "";
    const orderedGroups = preferred
      ? [
          ...groups.filter((group) => group?.dictionary === preferred),
          ...groups.filter((group) => group?.dictionary !== preferred),
        ]
      : groups;
    for (const group of orderedGroups) {
      if (!isRecord(group) || !Array.isArray(group.pitches)) {
        continue;
      }
      for (const pitch of group.pitches) {
        if (isRecord(pitch) && isPitchForMorae(pitchAccentPositions(pitch), maximumPosition)) {
          return {
            dictionary: boundedString(group.dictionary, 4096),
            pitch,
          };
        }
      }
    }
    return null;
  }

  function createFuriganaSegment(text, reading) {
    return { text, reading };
  }

  function getFuriganaKanaSegments(text, reading) {
    const newSegments = [];
    let start = 0;
    let state = reading[0] === text[0];
    for (let index = 1; index < text.length; index += 1) {
      const nextState = reading[index] === text[index];
      if (state === nextState) {
        continue;
      }
      newSegments.push(
        createFuriganaSegment(
          text.substring(start, index),
          state ? "" : reading.substring(start, index)
        )
      );
      state = nextState;
      start = index;
    }
    // The reading runs on past this group; the last run ends with the group.
    newSegments.push(
      createFuriganaSegment(
        text.substring(start),
        state ? "" : reading.substring(start, text.length)
      )
    );
    return newSegments;
  }

  // The ways a kanji can be read inside a word, from its KANJIDIC readings
  // (on'yomi in hiragana, kun'yomi with "." before the okurigana): each
  // reading; a kun'yomi's stem, stem and okurigana, and masu-stem (す.く: す,
  // すく, すき), and its stem with the start of its okurigana, for a word that
  // leaves the rest unwritten (う.える: うえ, as in 植木 うえき); each of those
  // with rendaku; and each of all these with a final つ, ち, く, き or り as っ
  // (いっ, ぱっ).
  function kanjiReadingForms(readings) {
    const forms = new Set();
    for (const reading of readings.split(" ")) {
      const [stem, okurigana = ""] = reading.split(".");
      forms.add(stem).add(stem + okurigana);
      for (let length = 1; length < okurigana.length; length += 1) forms.add(stem + okurigana.slice(0, length));
      const row = okurigana === "" ? -1 : U_ROW_KANA.indexOf(okurigana.at(-1));
      if (row >= 0) forms.add(stem + okurigana.slice(0, -1) + I_ROW_KANA[row]);
    }
    for (const form of [...forms]) {
      const codePoint = form.codePointAt(0);
      if (DAKUTEN_KANA.includes(form[0])) forms.add(String.fromCodePoint(codePoint + 1) + form.slice(1));
      if (HANDAKUTEN_KANA.includes(form[0])) forms.add(String.fromCodePoint(codePoint + 2) + form.slice(1));
      if (Object.hasOwn(ZI_ZU_KANA, form[0])) forms.add(ZI_ZU_KANA[form[0]] + form.slice(1));
    }
    for (const form of [...forms]) {
      if (SOKUON_KANA.includes(form.at(-1))) forms.add(`${form.slice(0, -1)}っ`);
    }
    return forms;
  }

  // Each kanji's reading forms over a table of readings in KANJIDIC's notation
  // ({ "好": "こう この.む す.く よ.い い.い", … }), for distributeFurigana. With
  // `base` (another createKanjiReadings), a kanji's forms are base's and those
  // of its readings in `table`, and a kanji that `table` lacks has base's. A
  // kanji's forms are derived the first time it is asked for.
  function createKanjiReadings(table, base = null) {
    const cache = new Map();
    return (character) => {
      let forms = cache.get(character);
      if (forms === undefined) {
        if (!Object.hasOwn(table, character)) forms = base === null ? NO_KANJI_READINGS : base(character);
        else if (base === null) forms = kanjiReadingForms(table[character]);
        else forms = new Set([...base(character), ...kanjiReadingForms(table[character])]);
        cache.set(character, forms);
      }
      return forms;
    };
  }

  // The compounds that start each place in a run of characters, over a table
  // of compound readings ({ "日本": "に|ほん やまと", "今日": "きょう", … }), for
  // readKanwaRun. A reading is one part over the whole compound (今日 きょう) or
  // one part per character, "|" between them (日本 に|ほん); each reading keeps
  // where each character's share starts in it, null for a character after the
  // first of a compound read as a whole. The compounds that start with a
  // character are parsed the first time a run starts with it; `starts` tells
  // whether any does.
  function createKanjiCompounds(table) {
    const byFirst = new Map();
    for (const compound of Object.keys(table)) {
      const first = String.fromCodePoint(compound.codePointAt(0));
      const group = byFirst.get(first);
      if (group === undefined) byFirst.set(first, [compound]);
      else group.push(compound);
    }
    const parsed = new Map();
    const startingWith = (character) => {
      let compounds = parsed.get(character);
      if (compounds === undefined) {
        compounds = (byFirst.get(character) ?? NO_KANJI_COMPOUNDS)
          .map((compound) => parseKanjiCompound(compound, table[compound]));
        parsed.set(character, compounds);
      }
      return compounds;
    };
    return {
      starts: (character) => byFirst.has(character),
      at: (characters, start) => startingWith(characters[start]).filter((compound) =>
        compound.characters.every((character, index) => characters[start + index] === character)),
    };
  }

  // A compound and its readings as createKanjiCompounds keeps them.
  function parseKanjiCompound(compound, readings) {
    const characters = Array.from(compound);
    return { characters, readings: readings.split(" ").map((reading) => {
      const parts = reading.split("|");
      let start = 0;
      const shares = parts.length === 1
        ? characters.map((_, index) => (index === 0 ? 0 : null))
        : parts.map((part) => (start += part.length) - part.length);
      return { reading: parts.join(""), shares };
    }) };
  }

  // What Jitendex's kanwa data adds to `kanjiReadings` (createKanjiReadings),
  // for readKanwaRun (#641), over a table in kanwa-readings.json's shape:
  // `readings`, the character readings that KANJIDIC lacks (２ ふた, not 日 にち),
  // and `compounds` (createKanjiCompounds). `adds` tells whether kanwa gives a
  // character such a reading or names a compound that starts with it.
  function createKanwaReadings({ readings, compounds }, kanjiReadings) {
    const known = createKanjiCompounds(compounds);
    return {
      kanjiReadings: createKanjiReadings(readings, kanjiReadings),
      compounds: known.at,
      adds: (character) => Object.hasOwn(readings, character) || known.starts(character),
    };
  }

  // How a run of kanji reads as `reading`: one form per character, in order.
  // 々 repeats the kanji before it; a character without readings (a digit, a
  // letter, 、) never reads. Where each character's share of the reading starts,
  // then the reading's length, when exactly one split reads; an empty list when
  // more than one does; null when none does.
  function readKanjiRun(text, reading, kanjiReadings) {
    // Where the characters so far can end in the reading, each with where the
    // last one's share starts there, or -1 where more than one split ends there.
    let ends = new Map([[0, 0]]);
    const steps = [];
    let forms = NO_KANJI_READINGS;
    for (const character of text) {
      if (character !== "々") forms = kanjiReadings(character);
      const next = new Map();
      for (const [end, start] of ends) {
        for (const form of forms) {
          if (!reading.startsWith(form, end)) continue;
          const shareEnd = end + form.length;
          next.set(shareEnd, next.has(shareEnd) || start < 0 ? -1 : end);
        }
      }
      if (next.size === 0) return null;
      steps.push(next);
      ends = next;
    }
    if (!ends.has(reading.length)) return null;
    if (ends.get(reading.length) < 0) return [];
    const bounds = [];
    bounds[steps.length] = reading.length;
    for (let index = steps.length - 1; index >= 0; index -= 1) bounds[index] = steps[index].get(bounds[index + 1]);
    return bounds;
  }

  // How a run of kanji reads as `reading` by `kanwa` (createKanwaReadings), for
  // a run that no split reads by KANJIDIC (#641): each character by one of its
  // forms, as in readKanjiRun, or a known compound by one of its readings, one
  // part per character (日本 に|ほん) or one over them all (今日 きょう). Of the
  // splits that read, those that read the most characters by compounds count,
  // as Jitendex reads a known compound before its characters. readKanjiRun's
  // result, with null for a character after the first of a compound read as a
  // whole; null too where kanwa adds no reading or compound to the run.
  function readKanwaRun(characters, reading, kanwa) {
    // A run without a character that kanwa adds to reads as it did by KANJIDIC.
    if (!characters.some(kanwa.adds)) return null;
    const starting = characters.map((_, index) => kanwa.compounds(characters, index));
    let forms = NO_KANJI_READINGS;
    const characterForms = characters.map((character) => {
      if (character !== "々") forms = kanwa.kanjiReadings(character);
      return forms;
    });
    // The best splits of the characters from `index` over the reading from
    // `end`: how many characters they read by compounds, and where each
    // character's share starts in the one such split, or AMBIGUOUS_SPLIT where
    // they differ. null where none reads.
    const best = new Map();
    const read = (index, end) => {
      if (index === characters.length) return end === reading.length ? { count: 0, shares: [] } : null;
      const key = index * (reading.length + 1) + end;
      if (best.has(key)) return best.get(key);
      let found = null;
      for (const { characters: { length }, readings } of starting[index]) {
        for (const { reading: whole, shares } of readings) {
          if (!reading.startsWith(whole, end)) continue;
          found = betterSplit(found, length, shares.map((share) => (share === null ? null : end + share)),
            read(index + length, end + whole.length));
        }
      }
      for (const form of characterForms[index]) {
        if (reading.startsWith(form, end)) found = betterSplit(found, 0, [end], read(index + 1, end + form.length));
      }
      best.set(key, found);
      return found;
    };
    const split = read(0, 0);
    if (split === null) return null;
    return split.shares === AMBIGUOUS_SPLIT ? [] : [...split.shares, reading.length];
  }

  // readKanwaRun's best split so far, `found`, against the one that starts with
  // `shares` over `count` characters read by compounds and goes on as `rest`.
  function betterSplit(found, count, shares, rest) {
    if (rest === null) return found;
    const split = { count: count + rest.count,
      shares: rest.shares === AMBIGUOUS_SPLIT ? AMBIGUOUS_SPLIT : [...shares, ...rest.shares] };
    if (found === null || split.count > found.count) return split;
    if (split.count < found.count || sameSplit(split.shares, found.shares)) return found;
    return { count: found.count, shares: AMBIGUOUS_SPLIT };
  }

  function sameSplit(left, right) {
    return left !== AMBIGUOUS_SPLIT && right !== AMBIGUOUS_SPLIT && left.length === right.length
      && left.every((share, index) => share === right[index]);
  }

  // With kanjiReadings, a non-kana group takes only a share of the reading
  // its kanji can be read as.
  function segmentizeFurigana(reading, normalizedReading, groups, groupStart, kanjiReadings = null) {
    const groupCount = groups.length - groupStart;
    if (groupCount <= 0) {
      return reading.length === 0 ? [] : null;
    }

    const group = groups[groupStart];
    if (group.isKana) {
      if (
        group.normalizedText !== null &&
        normalizedReading.startsWith(group.normalizedText)
      ) {
        const segments = segmentizeFurigana(
          reading.substring(group.text.length),
          normalizedReading.substring(group.text.length),
          groups,
          groupStart + 1,
          kanjiReadings
        );
        if (segments !== null) {
          if (reading.startsWith(group.text)) {
            segments.unshift(createFuriganaSegment(group.text, ""));
          } else {
            segments.unshift(...getFuriganaKanaSegments(group.text, reading));
          }
          return segments;
        }
      }
      return null;
    }

    let result = null;
    for (let index = reading.length; index >= group.text.length; index -= 1) {
      const segments = kanjiReadings === null
        || readKanjiRun(group.text, normalizedReading.substring(0, index), kanjiReadings) !== null
        ? segmentizeFurigana(
          reading.substring(index),
          normalizedReading.substring(index),
          groups,
          groupStart + 1,
          kanjiReadings
        )
        : null;
      if (segments !== null) {
        if (result !== null) {
          return null;
        }
        segments.unshift(
          createFuriganaSegment(group.text, reading.substring(0, index))
        );
        result = segments;
      }
      if (groupCount === 1) {
        break;
      }
    }
    return result;
  }

  // Yomitan's distributeFurigana, but null where Yomitan falls back to one
  // ruby over the whole word: no split, or more than one, spells the reading.
  // With kanjiReadings (createKanjiReadings), only the splits whose kanji runs
  // read by their KANJIDIC readings count.
  function distributeFurigana(expression, reading, kanjiReadings = null) {
    if (!reading || reading === expression) {
      return [{ text: expression, reading: "" }];
    }

    // Yomitan's distributeFurigana: one group per run of kana or of other
    // code points, so a digit or letter joins the kanji beside it.
    const groups = [];
    for (const character of String(expression)) {
      const isKana = KANA_PATTERN.test(character);
      const group = groups.at(-1);
      if (group?.isKana === isKana) {
        group.text += character;
      } else {
        groups.push({ isKana, text: character, normalizedText: null });
      }
    }
    for (const group of groups) {
      if (group.isKana) {
        group.normalizedText = toHiragana(group.text);
      }
    }

    return segmentizeFurigana(
      reading,
      toHiragana(reading),
      groups,
      0,
      kanjiReadings
    );
  }

  function segmentFurigana(expression, reading) {
    return distributeFurigana(expression, reading) ?? [{ text: expression, reading }];
  }

  // A split with each run of two or more kanji read one kanji at a time where
  // exactly one split of the run's reading reads (readKanjiRun): 二十四時間
  // にじゅうよじかん is 二(に)十(じゅう)四(よ)時(じ)間(かん). With `kanwa`
  // (createKanwaReadings), a run that no split reads by `kanjiReadings` is read
  // again with kanwa's readings and compounds (#641): 日本 にほん is 日(に)本(ほん),
  // ２人 ふたり is ２(ふた)人(り), and a compound read as a whole keeps one ruby
  // inside its run (今日中 きょうじゅう is 今日(きょう)中(じゅう)). A run that no split
  // reads, such as jukujikun that kanwa does not list (景色 けしき), or that more
  // than one does, keeps one ruby. `segments` itself where no run splits.
  function splitKanjiRuns(segments, kanjiReadings, kanwa = null) {
    const split = segments.flatMap((segment) => {
      const characters = Array.from(segment.text);
      if (characters.length < 2 || !segment.reading) return [segment];
      const reading = toHiragana(segment.reading);
      const bounds = readKanjiRun(characters, reading, kanjiReadings)
        ?? (kanwa === null ? null : readKanwaRun(characters, reading, kanwa));
      if (!(bounds?.length > 0)) return [segment];
      // A segment from each share's start to the next; a compound read as a
      // whole has no share of its own after its first character.
      const parts = [];
      for (let start = 0, end = 1; end <= characters.length; end += 1) {
        if (bounds[end] === null) continue;
        parts.push(createFuriganaSegment(end - start === 1 ? characters[start] : characters.slice(start, end).join(""),
          segment.reading.slice(bounds[start], bounds[end])));
        start = end;
      }
      return parts;
    });
    return split.length === segments.length ? segments : split;
  }

  // The split a headword's kanji readings (createKanjiReadings) give it, or
  // null where that is its local split (segmentFurigana): where the kana alone
  // leave more than one split, the one that reads (#459), and each run of
  // kanji read one kanji at a time (#605), by `kanwa` (createKanwaReadings) as
  // well where KANJIDIC's readings read none (#641).
  function kanjiFurigana(expression, reading, kanjiReadings, kanwa = null) {
    const local = distributeFurigana(expression, reading);
    const segments = local ?? distributeFurigana(expression, reading, kanjiReadings);
    if (segments === null) return null;
    const furigana = splitKanjiRuns(segments, kanjiReadings, kanwa);
    return furigana === local ? null : furigana;
  }

  // A term's furigana: the engine's split (term.furigana, from the kanji
  // readings) when the term carries one that spells its expression, else the
  // local split. A linked browser's term is untrusted, so a malformed or stale
  // split falls back too.
  function termFurigana({ expression, reading, furigana }) {
    return Array.isArray(furigana) && furigana.length > 0
      && furigana.every((segment) => typeof segment?.text === "string" && typeof segment.reading === "string")
      && furigana.map((segment) => segment.text).join("") === expression
      ? furigana
      : segmentFurigana(expression, reading);
  }

  // Yomitan's distributeFuriganaInflected: the furigana of `matched`, the text a
  // lookup matched for the term. The reading covers the stem shared by the
  // dictionary form and the matched text; the inflected ending has none. Text
  // spelled from the reading (いる for 居る, ダメ for 駄目) needs none at all.
  function matchedFurigana(term, matched) {
    const { expression, reading } = term;
    if (matched === expression) return termFurigana(term);
    const stemLength = (text) => {
      let length = 0;
      while (length < text.length && length < matched.length
        && toHiragana(text[length]) === toHiragana(matched[length])) length += 1;
      return length;
    };
    const stem = stemLength(expression);
    const readingStem = stemLength(reading);
    if (readingStem > 0 && readingStem >= stem) return [{ text: matched, reading: "" }];
    const ending = expression.slice(stem);
    if (stem === 0 || !reading.endsWith(ending)) return [{ text: matched, reading }];
    return [...segmentFurigana(expression.slice(0, stem), reading.slice(0, reading.length - ending.length)),
      { text: matched.slice(stem), reading: "" }];
  }

  // The headword's pitch over `text`, its reading or its own kana: a row of
  // morae with a line over high ones and under low ones and a stroke at each
  // rise and drop, or with the "overline" style the pitch list's own Yomitan
  // text. Nasal and devoice marks stay in the list: a nasal mark rewrites the
  // kana. Null when the pitch does not fit the text's morae.
  function createPitchContour(documentRef, text, { dictionary, pitch }, style, className) {
    const positions = pitchAccentPositions(pitch);
    const morae = buildPitchAccentMorae(text, positions);
    if (!morae) return null;
    const downstep = pitchAccentDownstep(pitch);
    const contour = documentRef.createElement("span");
    contour.className = className;
    contour.dataset.pitchPosition = downstep;
    if (dictionary) contour.dataset.pitchDictionary = dictionary;
    contour.title = [dictionary, `Pitch accent ${downstep}`].filter(Boolean).join(" · ");
    if (style === "overline") {
      contour.dataset.pitchStyle = "overline";
      contour.append(...createPronunciationText(documentRef, morae.map((mora) => mora.text), positions, [], []).children);
      return contour;
    }
    for (const mora of morae) {
      const span = documentRef.createElement("span");
      span.className = "gsm-hoshidicts-pitch-mora";
      span.dataset.pitchLevel = mora.level;
      if (mora.transition) span.dataset.pitchTransition = mora.transition;
      span.textContent = mora.text;
      contour.appendChild(span);
    }
    return contour;
  }

  // `furigana` is the term's furigana from the engine, if any (termFurigana).
  // The pitch is not drawn in the furigana (#606), which stays as it is with the
  // pitch off, but on the reading after the headword, where Yomitan's "Term
  // furigana and reading" display puts it. A headword without kanji spelt in
  // its reading's kana (てくてく, テレビ) carries the pitch on its own kana
  // instead, with no furigana, as JL marks one. A headword in kanji whose
  // reading is itself has no reading to show, as in Yomitan
  // (data-reading-is-same), and no kana to carry the pitch.
  function appendExpressionRuby(
    documentRef,
    parent,
    expression,
    reading,
    onKanjiClick,
    pitchOptions = {},
    furigana = null
  ) {
    const appendText = (target, text) => {
      for (const character of Array.from(text)) {
        if (!HAN_CHARACTER_PATTERN.test(character) || typeof onKanjiClick !== "function") {
          target.appendChild(documentRef.createTextNode(character));
          continue;
        }
        const button = documentRef.createElement("button");
        button.type = "button";
        button.className = "gsm-hoshidicts-kanji-link";
        button.textContent = character;
        button.setAttribute("aria-label", `Look up kanji ${character}`);
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          onKanjiClick(character, button);
        });
        target.appendChild(button);
      }
    };
    const pitchReading = reading || expression;
    // The reading's pitch also gives the headword's group, drawn or not.
    const selectedPitch = selectPitchAccent(
      pitchOptions.groups,
      pitchOptions.dictionary,
      splitPitchAccentMorae(pitchReading).length
    );
    const category = selectedPitch
      ? pitchAccentCategory(pitchReading, selectedPitch.pitch, pitchOptions.wordClasses, expression)
      : null;
    const kana = !HAN_CHARACTER_PATTERN.test(expression) && toHiragana(pitchReading) === toHiragana(expression);
    // The text the pitch is drawn on: a kana headword's own kana, else its own reading.
    const pitchText = kana ? expression : reading !== expression && reading;
    const contourClass = kana ? "gsm-hoshidicts-pitch-contour" : "gsm-hoshidicts-pitch-reading gsm-hoshidicts-pitch-contour";
    const contour = selectedPitch && pitchOptions.enabled !== false && pitchText
      ? createPitchContour(documentRef, pitchText, selectedPitch, pitchOptions.style, contourClass)
      : null;
    if (contour && kana) {
      parent.appendChild(contour);
      return category;
    }

    for (const segment of termFurigana({ expression, reading, furigana })) {
      if (!segment.reading) {
        appendText(parent, segment.text);
        continue;
      }
      const ruby = documentRef.createElement("ruby");
      appendText(ruby, segment.text);
      const rt = documentRef.createElement("rt");
      rt.textContent = segment.reading;
      ruby.appendChild(rt);
      parent.appendChild(ruby);
    }
    if (contour) parent.appendChild(contour);
    return category;
  }

  function setAttributes(element, attributes) {
    for (const [name, value] of Object.entries(attributes ?? {})) element.setAttribute(name, value);
    return element;
  }

  // docs/languages.md 10.5 and 11.2: the headword as the language's ruby mode
  // draws it, with its displayed forms. Kana ruby (Japanese) is
  // appendExpressionRuby exactly. `syllable` puts one reading syllable over
  // each character when the counts agree, `word` one ruby over the word;
  // without ruby a reading that differs from the headword is a reading line
  // beside it. Characters the language links call onCharacterClick.
  function appendHeadword(documentRef, parent, result, language, onCharacterClick, pitchOptions = {}) {
    const expression = String(language.display(result, "expression") || "").trim();
    const reading = String(language.display(result, "reading") || "").trim();
    const alignment = language.capabilities?.ruby?.alignment ?? null;
    if (alignment === "kana") {
      return appendExpressionRuby(documentRef, parent, expression, reading, onCharacterClick, pitchOptions,
        result.term?.furigana ?? null);
    }
    const name = String(language.labels?.character || "").toLowerCase();
    const appendText = (target, text) => {
      for (const character of Array.from(text)) {
        if (typeof onCharacterClick !== "function" || !language.isCharacterLink(character)) {
          target.appendChild(documentRef.createTextNode(character));
          continue;
        }
        const button = documentRef.createElement("button");
        button.type = "button";
        button.className = "gsm-hoshidicts-kanji-link";
        button.textContent = character;
        button.setAttribute("aria-label", `Look up ${name} ${character}`);
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          onCharacterClick(character, button);
        });
        target.appendChild(button);
      }
    };
    const ruby = (text, value) => {
      const element = documentRef.createElement("ruby");
      appendText(element, text);
      const rt = setAttributes(documentRef.createElement("rt"), language.readingAttributes());
      rt.textContent = value;
      element.appendChild(rt);
      parent.appendChild(element);
    };
    const shown = reading !== expression ? reading : "";
    if (shown && alignment === "syllable") {
      const characters = Array.from(expression);
      const syllables = shown.split(/\s+/u).filter(Boolean);
      if (syllables.length === characters.length) {
        characters.forEach((character, index) => ruby(character, syllables[index]));
        return null;
      }
    }
    if (shown && (alignment === "syllable" || alignment === "word")) {
      ruby(expression, shown);
      return null;
    }
    appendText(parent, expression);
    if (shown) {
      const line = setAttributes(documentRef.createElement("span"), language.readingAttributes());
      line.className = "gsm-hoshidicts-reading";
      line.textContent = shown;
      parent.appendChild(line);
    }
    return null;
  }

  // Yomitan's DictionaryDatabase._splitField: tag, rule and reading lists are
  // split on U+0020 only. Jitendex writes the spaces inside a tag name as
  // U+00A0 ("special reading"), so each name stays one tag.
  function parseTagList(value) {
    return String(value || "").split(" ").filter(Boolean);
  }

  // A lookup glossary's definition tags: the engine's tag-bank tags, in
  // Yomitan's order with their category and notes, or, from a sharing host
  // that sends none, each name of definitionTags alone.
  function definitionTagList(glossary) {
    return Array.isArray(glossary?.tags) ? glossary.tags : parseTagList(glossary?.definitionTags).map((name) => ({ name }));
  }

  function languageFromText(text) {
    return JAPANESE_TEXT_PATTERN.test(text) ? "ja" : CHINESE_TEXT_PATTERN.test(text) ? "zh" : null;
  }

  // Text in a profile's language (docs/languages.md 10.2, 10.3 and 11.2). It
  // applies only once the records have profiles: callers pass a marked
  // language object, and without one every function below keeps today's
  // markup and text.
  // Unicode's right-to-left scripts (ISO 15924), as far as Chrome 128 knows them.
  const RTL_SCRIPTS = new Set(["Adlm", "Arab", "Armi", "Avst", "Chrs", "Cprt", "Elym", "Hatr", "Hebr", "Hung",
    "Khar", "Lydi", "Mand", "Mani", "Mend", "Merc", "Mero", "Narb", "Nbat", "Nkoo", "Orkh", "Ougr", "Palm",
    "Phli", "Phlp", "Phnx", "Prti", "Rohg", "Samr", "Sarb", "Sogd", "Sogo", "Syrc", "Thaa", "Yezi"]);
  const RTL_SCRIPT_CLASS = [...RTL_SCRIPTS].map((code) => String.raw`\p{Script=${code}}`).join("");
  // Each pattern below is compiled the first time it is used. V8 builds the
  // character set of a Unicode property escape when it parses a regular
  // expression literal and again when it creates the expression, so as
  // constants they would cost every frame of every page at injection
  // (docs/languages.md 19); only text in another language reaches them.
  const lazyPattern = (source, flags) => {
    let pattern = null;
    return () => pattern ??= new RegExp(source, flags);
  };
  // One class, letters in those scripts: a lookahead per character scans
  // a long glossary several times slower.
  const RTL_LETTERS = lazyPattern(String.raw`[\p{L}&&[${RTL_SCRIPT_CLASS}]]`, "gv");
  const RTL_LETTER = lazyPattern(String.raw`[\p{L}&&[${RTL_SCRIPT_CLASS}]]`, "v");
  const LETTERS = lazyPattern(String.raw`\p{L}`, "gu");
  const LETTER = lazyPattern(String.raw`\p{L}`, "u");
  const NON_LATIN_LETTER = lazyPattern(String.raw`(?!\p{Script=Latin})\p{L}`, "u");
  const NON_HAN_LETTER = lazyPattern(String.raw`(?!\p{Script=Han})\p{L}`, "u");
  const HAN_OR_CJK_PUNCTUATION = lazyPattern(String.raw`[\p{Script=Han}\u3000-\u303f\ufe30-\ufe4f\uff01-\uff65]`, "u");
  const KANA_LETTER = lazyPattern(String.raw`[\p{Script=Hiragana}\p{Script=Katakana}]`, "u");
  const HANGUL_LETTER = lazyPattern(String.raw`\p{Script=Hangul}`, "u");
  const BOPOMOFO_LETTER = lazyPattern(String.raw`\p{Script=Bopomofo}`, "u");
  // Codes that are Han alone, and every code that includes Han (7.3, 10.3).
  const HAN_ONLY_SCRIPTS = new Set(["Hani", "Hans", "Hant", "Hanb"]);
  const HAN_SCRIPTS = new Set([...HAN_ONLY_SCRIPTS, "Jpan", "Kore"]);
  const HAN_LANGUAGES = new Set(["ja", "ko", "zh"]);
  const ISOLATES = { ltr: "\u2066", rtl: "\u2067" };
  const POP_ISOLATE = "\u2069";

  // Each of those scripts is encoded where Unicode reserves code points for
  // right-to-left text (its default R and AL ranges), so a test of code
  // units rules out most text before the exact test.
  const RTL_RANGES = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff\ud802\ud803\ud83a\ud83b]/;
  const hasRtlText = (text) => {
    const value = String(text ?? "");
    return RTL_RANGES.test(value) && RTL_LETTER().test(value);
  };

  // The majority rule (10.2): right to left when more than half of the
  // letters are right-to-left letters; text without letters has no direction.
  function textDirection(text) {
    const value = String(text ?? "");
    if (!hasRtlText(value)) return LETTER().test(value) ? "ltr" : null;
    const letters = Array.from(value.matchAll(LETTERS())).length;
    return Array.from(value.matchAll(RTL_LETTERS())).length * 2 > letters ? "rtl" : "ltr";
  }

  function scriptDirection(script) {
    return RTL_SCRIPTS.has(script) ? "rtl" : "ltr";
  }

  // A target language without a pack in this build (10.2): the platform's
  // likely script for the tag, or null when it knows none.
  function localeScript(tag) {
    try {
      return new Intl.Locale(tag).maximize().script ?? null;
    } catch {
      return null;
    }
  }

  const primarySubtag = (tag) => String(tag || "").split(/[-_]/u)[0].toLowerCase();
  const LANGUAGE_INFO = new WeakMap();

  // A pack as detection reads it: its tag, scripts and the characters of its
  // text pattern that are not Latin (10.3 step 3; Han counts only for a pack
  // whose every non-Latin script is a Han script).
  function textLanguage(pack) {
    let info = LANGUAGE_INFO.get(pack);
    if (info) return info;
    const scripts = Array.isArray(pack?.scripts) ? pack.scripts : [];
    const nonLatin = scripts.filter((code) => code !== "Latn");
    let native = null;
    if (nonLatin.length > 0 && typeof pack?.text?.pattern === "string") {
      const excluded = nonLatin.every((code) => HAN_ONLY_SCRIPTS.has(code)) ? "" : String.raw`\p{Script=Han}`;
      try {
        native = new RegExp(String.raw`(?![\p{Script=Latin}${excluded}])${pack.text.pattern}`, "u");
      } catch {
        native = null;
      }
    }
    info = { code: pack?.code ?? "", bcp47: pack?.bcp47 || pack?.code || "", scripts, native,
      latinOnly: scripts.length > 0 && nonLatin.length === 0,
      han: scripts.some((code) => HAN_SCRIPTS.has(code)) };
    if (pack && typeof pack === "object") LANGUAGE_INFO.set(pack, info);
    return info;
  }

  // A dictionary's target language (10.2, 10.3 steps 4 and 5): the pack's
  // scripts and direction when this build has one, else the platform's
  // script. `direction` is null when neither knows the language.
  function targetLanguage(tag, packFor = () => null) {
    if (typeof tag !== "string" || !tag) return null;
    const primary = primarySubtag(tag);
    const pack = packFor(primary);
    const script = pack ? null : localeScript(tag);
    const scripts = pack?.scripts ?? (script ? [script] : null);
    let direction = script ? scriptDirection(script) : null;
    if (pack?.direction === "rtl" || pack?.direction === "ltr") direction = pack.direction;
    return { tag, direction,
      latin: scripts ? scripts.includes("Latn") : null,
      han: HAN_LANGUAGES.has(primary) || Boolean(scripts?.some((code) => HAN_SCRIPTS.has(code))) };
  }

  const hanAlone = (text) => HAN_OR_CJK_PUNCTUATION().test(text) && !NON_HAN_LETTER().test(text);

  // Steps 2 to 4 of 10.3, which read only the text and the profile.
  function scriptLanguage(text, profile, target) {
    if (KANA_LETTER().test(text)) return "ja";
    if (HANGUL_LETTER().test(text)) return "ko";
    if (BOPOMOFO_LETTER().test(text)) return "zh";
    if (profile.native?.test(text)) return profile.bcp47;
    if (profile.latinOnly && target?.latin === false && LETTER().test(text) && !NON_LATIN_LETTER().test(text)) {
      return profile.bcp47;
    }
    return null;
  }

  // 10.3 for one glossary string outside the Japanese profile: steps 2 to 7,
  // where step 5 is the dictionary's target language.
  function glossaryTextLanguage(text, profile, target) {
    const value = String(text ?? "");
    const detected = scriptLanguage(value, profile, target);
    if (detected) return detected;
    const alone = hanAlone(value);
    if (target && !(alone && !target.han)) return target.tag;
    return alone && profile.han ? profile.bcp47 : null;
  }

  // The labelling pass (10.1) outside the Japanese profile: 10.3's steps 2 to
  // 6, where step 5 is the language the text inherits, so it adds no label.
  function inheritedTextLanguage(text, profile, inherited, isDefault) {
    const value = String(text ?? "");
    const detected = scriptLanguage(value, profile, isDefault ? inherited : null);
    if (detected) return detected;
    const alone = hanAlone(value);
    return alone && !inherited?.han && profile.han ? profile.bcp47 : null;
  }

  // Text mode (11.2): the text of a paragraph whose direction differs from
  // its dictionary's keeps its own order inside a directional isolate.
  function isolateParagraph(text, direction = "ltr") {
    const own = textDirection(text);
    return own && own !== direction ? `${ISOLATES[own]}${text}${POP_ISOLATE}` : text;
  }

  // Structured blocks for the paragraph rule (10.2).
  const DIRECTION_BLOCK_TAGS = new Set(["div", "p", "li", "ol", "ul", "table", "td", "th", "details", "summary"]);
  const LIST_TAGS = new Set(["ol", "ul"]);
  const isDirectionBlock = (node) => node.nodeType === 1 && DIRECTION_BLOCK_TAGS.has(node.localName);

  // 10.2's paragraph rule over rendered glossary content: a block takes the
  // direction of its own letters, or of all its letters when it has none of
  // its own, and is marked with `dir` where that differs from the direction
  // it inherits (its nearest marked ancestor's, else the dictionary's). It
  // gets `text-align: start` unless a dictionary style on it or an ancestor
  // inside the glossary aligns it. A list that holds an item of the other
  // direction gets `listPadding` as its inline padding (Anki), or is marked
  // for the theme host's labelling pass, which pads it from its computed
  // start padding. Nothing is marked under a dictionary without
  // right-to-left text, so left-to-right markup stays today's.
  function markBlockDirections(root, direction, { listPadding = null } = {}) {
    const counts = new Map();
    const count = (block, field) => counts.get(block)?.[field] ?? 0;
    // Every element in document order, without recursion: dictionaries nest deeply.
    const order = [];
    const stack = [root];
    while (stack.length > 0) {
      const element = stack.pop();
      order.push(element);
      for (let child = element.lastElementChild; child; child = child.previousElementSibling) stack.push(child);
    }
    // `own` counts a block's text outside its nested blocks; inline elements
    // pass theirs up to the block that holds them.
    for (let index = order.length - 1; index >= 0; index -= 1) {
      const element = order[index];
      let own = 0, ownRtl = 0, all = 0, allRtl = 0;
      for (let child = element.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          const letters = child.data.match(LETTERS())?.length ?? 0;
          if (letters > 0) {
            const rtl = child.data.match(RTL_LETTERS())?.length ?? 0;
            own += letters; ownRtl += rtl; all += letters; allRtl += rtl;
          }
        } else if (child.nodeType === 1) {
          all += count(child, "all"); allRtl += count(child, "allRtl");
          if (!isDirectionBlock(child)) { own += count(child, "own"); ownRtl += count(child, "ownRtl"); }
        }
      }
      if (all > 0) counts.set(element, { own, ownRtl, all, allRtl });
    }
    const blockDirection = (block) => {
      const own = count(block, "own");
      const [letters, rtl] = own > 0 ? [own, count(block, "ownRtl")] : [count(block, "all"), count(block, "allRtl")];
      if (letters === 0) return null;
      return rtl * 2 > letters ? "rtl" : "ltr";
    };
    // Only dictionary styles count: the walk reads each block before marking it.
    const aligned = (element) => Boolean(element.style?.textAlign);
    const walk = [[root, direction, false]];
    while (walk.length > 0) {
      const [element, inherited, alignedAbove] = walk.pop();
      let current = inherited;
      const styled = alignedAbove || aligned(element);
      if (element !== root && isDirectionBlock(element)) {
        const own = blockDirection(element);
        if (own && own !== inherited) {
          element.setAttribute("dir", own);
          if (!styled) element.style.textAlign = "start";
          current = own;
          const list = element.parentElement;
          if (element.localName === "li" && list && LIST_TAGS.has(list.localName)) {
            if (listPadding) list.style.paddingInline = listPadding;
            else list.dataset.hdMixedList = "";
          }
        }
      }
      for (let child = element.lastElementChild; child; child = child.previousElementSibling) {
        if (counts.has(child)) walk.push([child, current, styled]);
      }
    }
  }

  // Yomitan's _setMultilineTextContent: each "\n" becomes a <br>, so the text
  // copies with its line breaks. A glossary's text gets the same language
  // detection as a string in structured content.
  function appendMultilineText(documentRef, parent, text, state = null) {
    text.split("\n").forEach((line, index) => {
      if (index > 0) parent.appendChild(documentRef.createElement("br"));
      if (line) parent.appendChild(documentRef.createTextNode(line));
    });
    const language = state?.detectLanguage ? state.detectLanguage(text, parent) : languageFromText(text);
    if (language) parent.lang = language;
  }

  // An inline value also refuses var(): a dictionary stylesheet's own custom
  // properties are renamed by applyDictionaryStyles, but a reference here would
  // read whatever the page sets on the popup host. A backslash could escape a
  // refused function name.
  function isSafeStructuredStyleValue(value) {
    return typeof value === "string" && !value.includes("\\")
      && !UNSAFE_STYLE_FUNCTION.test(value) && !/\bvar\s*\(/iu.test(value);
  }

  function setStructuredStyle(element, cssProperty, value) {
    if (isSafeStructuredStyleValue(value)) {
      element.style.setProperty(cssProperty, value);
    }
  }

  function applyStructuredStyle(element, rawStyle) {
    if (!isRecord(rawStyle)) {
      return;
    }
    for (const [property, cssProperty] of STRUCTURED_STYLE_PROPERTIES) {
      let value = rawStyle[property];
      // As in Yomitan, numeric margin longhands are em and a decoration-line
      // array is one value; any other value must be a string.
      if (typeof value === "number" && /^margin[A-Z]/u.test(property)) {
        value = `${value}em`;
      } else if (Array.isArray(value) && property === "textDecorationLine") {
        value = value.join(" ");
      }
      setStructuredStyle(element, cssProperty, value);
    }
  }

  function normalizeMediaPath(value) {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 4096 ||
      /[\\\u0000-\u001f\u007f]/u.test(value) ||
      value.startsWith("/") ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
    ) {
      return null;
    }
    const components = value.split("/");
    return components.some((component) => !component || component === "." || component === "..")
      ? null
      : value;
  }

  // hd_media_result carries a data: URL; PR #549 resolved media to blob: URLs
  // from its own object-URL cache. Either way the bytes came from this
  // extension. The character class stops the URL escaping the CSS url("…")
  // context appendStructuredImage interpolates it into.
  function isRenderableMediaUrl(url) {
    return typeof url === "string" && /^(?:blob|data):[^"'()\s\\]+$/u.test(url);
  }

  function appendStructuredImage(documentRef, parent, value, state) {
    const path = normalizeMediaPath(value.path);
    if (!path) return;
    // The Anki exporter shares structured parsing, but writes inert portable
    // image markup instead of installing a popup's asynchronous preview owner.
    if (typeof state.appendImage === "function") {
      state.appendImage(documentRef, parent, value, { dictionary: state.dictionary, path });
      return;
    }
    if (typeof state.resolveMedia !== "function") {
      return;
    }

    const useNaturalDimensions = !["width", "height", "preferredWidth", "preferredHeight"]
      .some((key) => Object.prototype.hasOwnProperty.call(value, key))
      && value.sizeUnits !== "px"
      && value.sizeUnits !== "em";
    const declaredWidth = Number.isFinite(Number(value.width)) && Number(value.width) > 0
      ? Number(value.width)
      : null;
    const declaredHeight = Number.isFinite(Number(value.height)) && Number(value.height) > 0
      ? Number(value.height)
      : null;
    const preferredWidth = Number.isFinite(Number(value.preferredWidth)) &&
      Number(value.preferredWidth) > 0
      ? Number(value.preferredWidth)
      : null;
    const preferredHeight = Number.isFinite(Number(value.preferredHeight)) &&
      Number(value.preferredHeight) > 0
      ? Number(value.preferredHeight)
      : null;
    // A bank's width/height are Yomitan's preferred size; its importer
    // (_createImageData) stores the media's natural size beside them.
    // hoshidicts hands over the raw bank, so one declared side alone
    // (日本国語大辞典's accent labels give only `height: 1.2em`) reserves a
    // square of that size, then takes the decoded image's aspect ratio.
    const loneSide = preferredWidth === null && preferredHeight === null
      && (declaredWidth === null) !== (declaredHeight === null);
    const width = declaredWidth ?? (loneSide ? declaredHeight : 100);
    const height = declaredHeight ?? (loneSide ? declaredWidth : 100);
    const aspectWidth = preferredWidth || width;
    const aspectHeight = preferredHeight || height;
    let usedWidth = preferredWidth || (
      preferredHeight ? preferredHeight * width / height : width
    );
    if (preferredWidth === null && preferredHeight !== null && (!Number.isFinite(usedWidth) || usedWidth === 0)) {
      // The product can overflow/underflow even when the final width fits.
      // Keep valid original results; try the other groupings only on failure.
      usedWidth = preferredHeight * (width / height);
      if (!Number.isFinite(usedWidth) || usedWidth === 0) {
        usedWidth = (preferredHeight / height) * width;
      }
    }
    const units = value.sizeUnits === "em" ? "em" : "px";
    const maximumSize = units === "em" ? 64 : MAX_MEDIA_DISPLAY_SIZE;
    const displayWidth = Math.max(0.1, Math.min(maximumSize, usedWidth));
    // Glyphs sized in em, or no larger than 32px on either side, sit in the
    // text as brackets and labels; the "large" hover preview skips them.
    const inlineGlyph = units === "em"
      || (displayWidth <= 32 && displayWidth * Math.min(100, aspectHeight / aspectWidth) <= 32);

    const link = documentRef.createElement("a");
    link.className = "gloss-image-link gloss-sc-a";
    applyStructuredData(link, value.data);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.dataset.path = path;
    if (typeof state.dictionary === "string") link.dataset.dictionary = state.dictionary;
    link.dataset.imageLoadState = "not-loaded";
    link.dataset.hasAspectRatio = "true";
    link.dataset.imageRendering = typeof value.imageRendering === "string"
      ? value.imageRendering
      : value.pixelated === true
        ? "pixelated"
        : "auto";
    link.dataset.appearance = typeof value.appearance === "string"
      ? value.appearance
      : "auto";
    link.dataset.background = String(
      typeof value.background === "boolean" ? value.background : true
    );
    link.dataset.collapsed = String(value.collapsed === true);
    link.dataset.collapsible = String(value.collapsible !== false);
    if (typeof value.verticalAlign === "string") {
      link.dataset.verticalAlign = value.verticalAlign;
    }
    if (preferredWidth !== null || preferredHeight !== null || units === "em") {
      link.dataset.sizeUnits = units;
    }

    const container = documentRef.createElement("span");
    container.className = "gloss-image-container";
    container.style.width = `${displayWidth}${units}`;
    if (typeof value.title === "string" && value.title.length <= 4096) {
      container.title = value.title;
    }
    // Yomitan assigns both verbatim.
    setStructuredStyle(container, "border", value.border);
    setStructuredStyle(container, "border-radius", value.borderRadius);

    const sizer = documentRef.createElement("span");
    sizer.className = "gloss-image-sizer";
    // One sizing rule owns the ratio; raw CSS aspect-ratio bypasses this cap.
    sizer.style.paddingTop = `${Math.min(10_000, aspectHeight / aspectWidth * 100)}%`;
    const background = documentRef.createElement("span");
    background.className = "gloss-image-background";
    const overlay = documentRef.createElement("span");
    overlay.className = "gloss-image-container-overlay";
    const image = documentRef.createElement("img");
    image.className = "gloss-image gloss-sc-img gsm-hoshidicts-structured-image";
    image.alt = isRecord(value.data) && typeof value.data.alt === "string"
      ? value.data.alt.slice(0, 1024)
      : typeof value.alt === "string"
        ? value.alt.slice(0, 1024)
        : "";
    image.decoding = "async";
    image.draggable = false;
    image.style.width = "100%";
    image.style.height = "100%";
    // Yomitan paints this layer on a <canvas>, which a dictionary's `img`
    // rules never match. Inline values outrank such a rule's margin and
    // padding, which would shift the layer inside its clipping container.
    image.style.margin = "0";
    image.style.padding = "0";
    container.append(sizer, background, overlay, image);
    link.appendChild(container);
    const linkText = documentRef.createElement("span");
    linkText.className = "gloss-image-link-text";
    linkText.textContent = "Image";
    link.appendChild(linkText);
    const onLayoutChange = typeof state.onLayoutChange === "function"
      ? state.onLayoutChange
      : () => {};
    const ownsView = typeof state.isCurrent === "function" ? state.isCurrent : () => true;
    const isCurrent = () => image.isConnected && ownsView();
    const ownsDisplayedImage = state.isImageCurrent
      || (() => image.isConnected && (state.isCurrentLink || ownsView)());
    let imageContext = state.imageContext || {};
    let appliedSources = imageContext.popupImageSources ?? null;
    let attempt = 0;
    let supplier = null;
    let sourceLabel = null;
    function updateSourceLabel() {
      if (!supplier || supplier === state.dictionary) {
        if (!sourceLabel) return false;
        sourceLabel.remove();
        sourceLabel = null;
        return true;
      }
      const name = imageContext.dictionaryPresentation?.find(entry => entry.title === supplier)?.displayName || supplier;
      const text = `Image: ${name}`;
      if (sourceLabel?.textContent === text && sourceLabel.dataset.dictionary === supplier) return false;
      if (!sourceLabel) {
        sourceLabel = documentRef.createElement("span");
        sourceLabel.className = "gloss-image-source";
        if (state.imageSourceLabelHost) state.imageSourceLabelHost.appendChild(sourceLabel);
        else link.after(sourceLabel);
      }
      sourceLabel.textContent = text;
      sourceLabel.dataset.dictionary = supplier;
      sourceLabel.title = supplier;
      return true;
    }
    let previewHovered = false;
    let previewFocused = false;
    const showPreview = () => {
      if (!isCurrent()) return;
      state.requestImagePreview?.(link, image, inlineGlyph);
    };
    const hidePreview = () => {
      state.hideImagePreview?.(link);
    };
    const hideUnownedPreview = () => {
      if (!previewHovered && !previewFocused) hidePreview();
    };
    link.addEventListener("mouseenter", () => {
      previewHovered = true;
      showPreview();
    });
    link.addEventListener("mouseleave", () => {
      previewHovered = false;
      hideUnownedPreview();
    });
    link.addEventListener("focus", () => {
      previewFocused = true;
      showPreview();
    });
    link.addEventListener("blur", () => {
      previewFocused = false;
      link.removeAttribute("tabindex");
      hideUnownedPreview();
    });
    const failImage = () => {
      if (!isCurrent()) return;
      hidePreview();
      image.hidden = true;
      link.removeAttribute("href");
      background.style.removeProperty("--image");
      link.dataset.imageLoadState = "load-error";
      link.setAttribute("role", "img");
      linkText.textContent = image.alt ? `${image.alt}: Image failed to load` : "Image failed to load";
      link.setAttribute("aria-label", linkText.textContent);
      supplier = null;
      updateSourceLabel();
      state.onImageError?.();
      onLayoutChange();
    };
    parent.appendChild(link);
    let onLoad = null;
    let onError = null;
    function loadImage(refresh = false) {
      const currentAttempt = ++attempt;
      const ownsAttempt = () => attempt === currentAttempt && ownsView();
      const canPublish = () => image.isConnected && ownsAttempt();
      if (onLoad) image.removeEventListener("load", onLoad);
      if (onError) image.removeEventListener("error", onError);
      onLoad = () => {
        if (!canPublish() || image.hidden) return;
        if (useNaturalDimensions && image.naturalWidth > 0 && image.naturalHeight > 0) {
          const naturalWidth = Math.max(0.1, Math.min(MAX_MEDIA_DISPLAY_SIZE, image.naturalWidth));
          container.style.width = `${naturalWidth}px`;
          sizer.style.paddingTop = `${Math.min(10_000, image.naturalHeight / image.naturalWidth * 100)}%`;
        } else if (loneSide && image.naturalWidth > 0 && image.naturalHeight > 0) {
          // Yomitan's preferredHeight / (height / width), in the same bounds.
          const ratio = image.naturalHeight / image.naturalWidth;
          if (declaredWidth === null) {
            container.style.width = `${Math.max(0.1, Math.min(maximumSize, declaredHeight / ratio))}${units}`;
          }
          sizer.style.paddingTop = `${Math.min(10_000, ratio * 100)}%`;
        }
        link.dataset.imageLoadState = "loaded";
        onLayoutChange();
        state.refreshImagePreview?.(link, image);
      };
      const failAttempt = () => { if (canPublish()) failImage(); };
      onError = () => { if (!image.hidden) failAttempt(); };
      image.addEventListener("load", onLoad);
      image.addEventListener("error", onError);
      if (refresh) {
        const retainedFocus = link.getRootNode().activeElement === link;
        state.onImageStart?.();
        image.hidden = true;
        image.removeAttribute("src");
        // Keep a deliberately focused control keyboard-focusable while its
        // old URL is unavailable. The successful href restores native focus.
        if (retainedFocus) link.tabIndex = 0;
        link.removeAttribute("href");
        link.removeAttribute("role");
        link.removeAttribute("aria-label");
        linkText.textContent = "Image";
        background.style.removeProperty("--image");
        link.dataset.imageLoadState = "not-loaded";
        supplier = null;
        updateSourceLabel();
        state.refreshImagePreview?.(link, image);
        // Chrome 128 can drop focus when href is removed even though tabindex
        // was installed first. Restore it synchronously so the popup's
        // focusout microtask sees the refreshed control, not a false departure.
        if (retainedFocus && link.getRootNode().activeElement !== link) {
          link.tabIndex = 0;
          link.focus({ preventScroll: true });
        }
      }
      let resolvedSupplier = state.dictionary;
      let mediaPromise;
      try {
        mediaPromise = Promise.resolve(state.resolveMedia({ path, width, height, isCurrent: ownsAttempt,
          onResolvedSource(title) { if (ownsAttempt()) resolvedSupplier = title; },
        }));
      } catch (error) {
        mediaPromise = Promise.reject(error);
      }
      mediaPromise.then((url) => {
        if (!canPublish()) return;
        if (!isRenderableMediaUrl(url)) throw new Error("dictionary image is unavailable");
        image.hidden = false;
        image.src = url;
        link.href = url;
        link.removeAttribute("tabindex");
        link.dataset.imageLoadState = "loaded";
        background.style.setProperty("--image", `url("${url}")`);
        supplier = resolvedSupplier;
        // The image's load/error callback positions its new label too.
        updateSourceLabel();
      }).catch(failAttempt);
    }
    state.onImageCreated?.({
      isCurrent: ownsDisplayedImage,
      updatePresentation(context) {
        imageContext = context;
        if (appliedSources === (context.popupImageSources ?? null) || !ownsView()) return updateSourceLabel();
        appliedSources = context.popupImageSources ?? null;
        loadImage(true);
        return true;
      },
    });
    loadImage();
  }

  // Yomitan writes `element.dataset["sc" + Key]`, so dictionary CSS is written
  // against the attribute names the dataset setter derives: ASCII capitals
  // become hyphen-lowercase and every other character, including Japanese
  // keys such as 付録 or 外字, is kept as is (`data-sc付録`). A key the setter
  // would reject (a hyphen before an ASCII lowercase letter) is dropped, as
  // Yomitan drops it; setAttribute rejects the remaining invalid names.
  function structuredDataAttributeName(rawKey) {
    if (
      typeof rawKey !== "string" ||
      rawKey.length === 0 ||
      rawKey.length > MAX_STRUCTURED_DATA_KEY_LENGTH
    ) {
      return null;
    }
    const property = `sc${rawKey[0].toUpperCase()}${rawKey.slice(1)}`;
    if (/-[a-z]/u.test(property)) return null;
    return `data-${property.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;
  }

  function applyStructuredData(element, data) {
    if (!isRecord(data)) {
      return;
    }
    let count = 0;
    for (const [key, rawValue] of Object.entries(data)) {
      if (count >= MAX_STRUCTURED_DATA_ATTRIBUTES) {
        break;
      }
      if (
        typeof rawValue !== "string" &&
        typeof rawValue !== "number" &&
        typeof rawValue !== "boolean"
      ) {
        continue;
      }
      const attribute = structuredDataAttributeName(key);
      const value = String(rawValue);
      if (
        !attribute ||
        value.length > MAX_STRUCTURED_DATA_VALUE_LENGTH ||
        /[\u0000-\u001f\u007f]/u.test(value)
      ) {
        continue;
      }
      try {
        element.setAttribute(attribute, value);
      } catch {
        continue;
      }
      count += 1;
    }
  }

  function parseStructuredLink(href) {
    if (typeof href !== "string" || href.length === 0 || href.length > 4096) {
      return null;
    }
    if (href.startsWith("?")) {
      const params = new Map();
      try {
        for (const part of href.slice(1).split("&")) {
          const separator = part.indexOf("=");
          const rawKey = separator < 0 ? part : part.slice(0, separator);
          const rawValue = separator < 0 ? "" : part.slice(separator + 1);
          const key = decodeURIComponent(rawKey.replace(/\+/gu, " "));
          if (!params.has(key)) {
            params.set(
              key,
              decodeURIComponent(rawValue.replace(/\+/gu, " "))
            );
          }
        }
      } catch {
        return null;
      }
      const query = boundedString(params.get("query"), MAX_LOOKUP_TEXT_BYTES).trim();
      if (!query) {
        return null;
      }
      return {
        internal: true,
        primaryReading: boundedString(
          params.get("primary_reading"),
          MAX_LOOKUP_TEXT_BYTES
        ).trim(),
        query,
      };
    }
    const url = globalThis.HDExternalLinks.normaliseExternalUrl(href);
    return url ? { href: url, internal: false } : null;
  }

  function ownsStructuredLink(element, state) {
    const isCurrent = state.isCurrentLink || state.isCurrent;
    return element.isConnected && (typeof isCurrent !== "function" || isCurrent());
  }

  function appendStructuredValue(
    documentRef,
    parent,
    value,
    state,
    _depth,
    path = ["structuredContent"]
  ) {
    const currentPath = [...path];
    // `language` is the nearest dictionary-set lang, as in Yomitan's
    // _appendStructuredContent: below one, text is not detected again.
    const stack = [{ kind: "value", parent, value, language: null }];
    const pushChild = (childParent, childValue, segment, language) => {
      stack.push({ kind: "leave" });
      stack.push({ kind: "value", parent: childParent, value: childValue, language });
      stack.push({ kind: "enter", segment });
    };
    while (stack.length > 0) {
      const frame = stack.pop();
      if (frame.kind === "enter") {
        currentPath.push(frame.segment);
        continue;
      }
      if (frame.kind === "leave") {
        currentPath.pop();
        continue;
      }
      if (frame.kind === "array") {
        if (frame.index < frame.value.length) {
          stack.push({ ...frame, index: frame.index + 1 });
          pushChild(frame.parent, frame.value[frame.index], frame.index, frame.language);
        }
        continue;
      }
      if (frame.kind === "append-external-icon") {
        const icon = documentRef.createElement("span");
        icon.className = "gloss-link-external-icon icon";
        icon.dataset.icon = "external-link";
        icon.setAttribute("aria-hidden", "true");
        frame.element.appendChild(icon);
        continue;
      }

      // Bound traversal work, including containers and values that render no DOM.
      countStructuredNode(state, currentPath);
      value = frame.value;
      parent = frame.parent;
      if (typeof value === "string") {
        parent.appendChild(documentRef.createTextNode(value));
        let language = null;
        if (frame.language === null) language = state.detectLanguage ? state.detectLanguage(value, parent) : languageFromText(value);
        if (language) parent.lang = language;
        continue;
      }
      if (typeof value === "number" || typeof value === "boolean") {
        parent.appendChild(documentRef.createTextNode(String(value)));
        continue;
      }
      if (Array.isArray(value)) {
        stack.push({ kind: "array", parent, value, index: 0, language: frame.language });
        continue;
      }
      if (!isRecord(value)) {
        continue;
      }

      if (value.type === "structured-content") {
        pushChild(parent, value.content, "content", frame.language);
        continue;
      }
      if (value.type === "text") {
        const property = Object.prototype.hasOwnProperty.call(value, "text") ? "text" : "content";
        pushChild(parent, value[property], property, frame.language);
        continue;
      }
      if (value.type === "image") {
        value = { ...value, tag: "img" };
      }

      const tag = typeof value.tag === "string" ? value.tag.toLowerCase() : "";
      if (IGNORED_STRUCTURED_TAGS.has(tag)) {
        continue;
      }
      if (!ALLOWED_STRUCTURED_TAGS.has(tag)) {
        if (Object.prototype.hasOwnProperty.call(value, "content")) {
          pushChild(parent, value.content, "content", frame.language);
        }
        continue;
      }

      if (tag === "img") {
        appendStructuredImage(documentRef, parent, value, state);
        continue;
      }

      const element = documentRef.createElement(tag);
      element.classList.add(`gloss-sc-${tag}`);
      applyStructuredStyle(element, value.style);
      applyStructuredData(element, value.data);
      let language = frame.language;
      if (
        typeof value.lang === "string" &&
        /^[A-Za-z0-9-]{1,35}$/u.test(value.lang)
      ) {
        element.setAttribute("lang", value.lang);
        language = value.lang;
      }
      if (tag === "td" || tag === "th") {
        for (const [property, attribute] of [
          ["colSpan", "colspan"],
          ["rowSpan", "rowspan"],
        ]) {
          const span = Number(value[property]);
          if (Number.isInteger(span) && span >= 1 && span <= 32) {
            element.setAttribute(attribute, String(span));
          }
        }
      }
      if (tag === "details" && typeof state.onLayoutChange === "function") {
        element.addEventListener("toggle", state.onLayoutChange);
      }
      if (typeof value.title === "string" && value.title.length <= 4096) {
        element.title = value.title;
      }
      if (tag === "details" && value.open === true) {
        element.open = true;
      }
      if (tag === "a") {
        element.classList.add("gloss-link", "gsm-hoshidicts-structured-link");
        const link = parseStructuredLink(value.href);
        if (link?.internal) {
          element.setAttribute("href", "#");
          element.dataset.external = "false";
          element.dataset.hoshidictsQuery = link.query;
          if (link.primaryReading) {
            element.dataset.hoshidictsReading = link.primaryReading;
          }
          element.addEventListener("click", (event) => {
            if (event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            if (ownsStructuredLink(element, state) && typeof state.onInternalLink === "function") {
              state.onInternalLink({
                anchor: element,
                focusChild: event.detail === 0,
                primaryReading: link.primaryReading,
                query: link.query,
              });
            }
          });
        } else if (link) {
          element.href = link.href;
          element.target = "_blank";
          element.rel = "noopener noreferrer";
          element.dataset.external = "true";
          const activate = (event) => {
            if (event.defaultPrevented || event.button !== (event.type === "auxclick" ? 1 : 0)) return;
            event.preventDefault();
            event.stopPropagation();
            if (!ownsStructuredLink(element, state)) return;
            if (typeof state.onExternalLink === "function") {
              state.onExternalLink({
                url: link.href,
                active: event.shiftKey || !(event.button === 1 || event.ctrlKey || event.metaKey),
              });
            }
          };
          element.addEventListener("click", activate);
          element.addEventListener("auxclick", activate);
        }
      }
      let contentParent = element;
      if (tag === "a") {
        contentParent = documentRef.createElement("span");
        contentParent.className = "gloss-link-text";
        element.appendChild(contentParent);
      }
      if (tag === "table") {
        const container = documentRef.createElement("div");
        container.className = "gloss-sc-table-container";
        container.appendChild(element);
        parent.appendChild(container);
      } else {
        parent.appendChild(element);
      }
      if (tag === "a" && element.dataset.external === "true") {
        stack.push({ kind: "append-external-icon", element });
      }
      if (
        !STRUCTURED_TAGS_WITHOUT_CONTENT.has(tag) &&
        Object.prototype.hasOwnProperty.call(value, "content")
      ) {
        pushChild(contentParent, value.content, "content", language);
      }
    }
  }

  // display-generator.js _createTermDefinitionEntry with templates-display.html
  // "gloss-item": one item per glossary element Yomitan displays, in order,
  // each inside the row's node budget.
  function appendGlossItem(documentRef, list, item, state, index) {
    // A [term, rules] element is form-of data Yomitan's translator consumes
    // and never displays.
    if (Array.isArray(item)) return;
    const path = ["glossary", index];
    const content = documentRef.createElement("span");
    content.className = "gloss-content";
    if (typeof item === "string" || (isRecord(item) && item.type === "text" && typeof item.text === "string")) {
      countStructuredNode(state, path);
      appendMultilineText(documentRef, content, typeof item === "string" ? item : item.text, state);
    } else if (isRecord(item) && item.type === "image") {
      countStructuredNode(state, path);
      appendStructuredImage(documentRef, content, item, state);
      if (typeof item.description === "string") {
        const description = documentRef.createElement("span");
        description.className = "gloss-image-description";
        appendMultilineText(documentRef, description, item.description, state);
        content.append(" ", description);
      }
    } else if (isRecord(item) && item.type === "structured-content") {
      content.classList.add("structured-content");
      appendStructuredValue(documentRef, content, item, state, 0, path);
    } else {
      // A value outside Yomitan's schema, which its importer refuses, still
      // renders when the structured renderer makes something of it.
      appendStructuredValue(documentRef, content, item, state, 0, path);
      if (!content.hasChildNodes()) return;
    }
    const glossItem = documentRef.createElement("li");
    glossItem.className = "gloss-item click-scannable";
    glossItem.dataset.index = String(list.children.length);
    const separator = documentRef.createElement("span");
    separator.className = "gloss-separator";
    separator.textContent = " ";
    glossItem.append(separator, content);
    list.appendChild(glossItem);
  }

  function appendTextOnlyGlossary(documentRef, parent, rawGlossary, options = {}) {
    const value = typeof rawGlossary === "string" ? rawGlossary : "";
    if (!value) {
      return;
    }
    let parsed = value;
    try {
      parsed = JSON.parse(value);
    } catch {
      // Plain glossary strings are rendered literally, including any HTML-like text.
    }
    // `glossary` is the whole glossary array of one term-bank row, and each of
    // its elements is a separate sense. appendStructuredValue concatenates an
    // array into its parent, which is right for a structured-content `content`
    // run but would run two senses together here ("to eatto live on ..."), so
    // the top level is split into one item each, as Yomitan does.
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const state = {
      nodes: 0,
      dictionary: options.dictionary,
      appendImage: options.appendImage,
      imageContext: options.imageContext,
      onImageCreated: options.onImageCreated,
      isCurrent: options.isCurrent,
      isCurrentLink: options.isCurrentLink,
      onExternalLink: options.onExternalLink,
      onInternalLink: options.onInternalLink,
      onLayoutChange: options.onLayoutChange,
      requestImagePreview: options.requestImagePreview,
      refreshImagePreview: options.refreshImagePreview,
      hideImagePreview: options.hideImagePreview,
      resolveMedia: typeof options.resolveMedia === "function"
        ? ({ path, width, height, isCurrent, onResolvedSource }) => options.resolveMedia({
            dictionary: options.dictionary,
            generation: options.generation,
            height,
            isCurrent,
            onResolvedSource,
            path,
            width,
          })
        : null,
    };
    // Once the records have profiles (a marked language), strings take 10.3's
    // language, labelled only where it differs from the block's default, and
    // blocks of the other direction keep their own (10.2). The dictionary's
    // direction comes from `options.direction`, else from the language.
    const language = options.language?.marked === true ? options.language : null;
    let direction = null;
    if (language) {
      const blockLanguage = language.dictionaryLanguage?.(options.dictionary) ?? null;
      // A label only where the language differs from the one the text
      // inherits: from a block above it inside the glossary, else the
      // dictionary's default.
      state.detectLanguage = (text, parent) => {
        const detected = language.detectGlossary(text, options.dictionary);
        if (!detected) return null;
        const inherited = parent?.closest?.("[lang]")?.getAttribute("lang") ?? blockLanguage;
        return detected !== inherited ? detected : null;
      };
      direction = options.direction ?? language.dictionaryDirection?.(options.dictionary) ?? "ltr";
    }
    const markDirections = (root, listPadding = null) => {
      if (direction && (direction === "rtl" || hasRtlText(value))) markBlockDirections(root, direction, { listPadding });
    };
    if (options.layout !== "anki") {
      // The popup's glossary markup is Yomitan's: ul.gloss-list, even for one
      // element, with data-count counting the items it shows.
      const list = documentRef.createElement("ul");
      list.className = "gloss-list";
      items.forEach((item, index) => appendGlossItem(documentRef, list, item, state, index));
      list.dataset.count = String(list.children.length);
      parent.appendChild(list);
      markDirections(list);
      return;
    }
    // Yomitan's Anki glossary-single template emits one element bare and
    // several as a list, or joined by " | " under Compact popup and Anki.
    if (items.length === 0) {
      return;
    }
    // A note has no stylesheet: lists of mixed direction get inline padding
    // (section 12), and only a caller that names the direction is marked.
    if (options.direction === undefined) direction = null;
    if (items.some((item) => isRecord(item) && item.type === "structured-content")) {
      parent.classList.add("structured-content");
    }
    if (items.length === 1 || options.compactGlossaries === true) {
      items.forEach((item, index) => {
        if (index > 0) parent.append(" | ");
        appendStructuredValue(documentRef, parent, item, state, 0, ["glossary", index]);
      });
      markDirections(parent, "40px");
      return;
    }
    const list = documentRef.createElement("ul");
    list.className = "gloss-list";
    for (let index = 0; index < items.length; index += 1) {
      const listItem = documentRef.createElement("li");
      listItem.className = "gloss-item";
      appendStructuredValue(documentRef, listItem, items[index], state, 0, ["glossary", index]);
      list.appendChild(listItem);
    }
    parent.appendChild(list);
    markDirections(list, "40px");
  }

  function utf8Length(value) {
    return typeof TextEncoder === "function"
      ? new TextEncoder().encode(value).length
      : value.length;
  }

  function isSafeDictionaryStyle(style) {
    const declarations = style.cssText;
    // Check the whole browser-serialized block: var() shorthands enumerate as
    // empty longhands until substitution. Residual escapes can disguise both
    // function names and variable delimiters; drop that cosmetic rule rather
    // than reinterpret CSS tokens. Do not strip comment-like text in strings.
    if (declarations.includes("\\") || UNSAFE_STYLE_FUNCTION.test(declarations)) return false;
    for (const property of style) {
      // Named fonts can activate an outer page's @font-face without a URL here.
      // CSSOM expands non-variable font shorthands into font-family as well.
      if (property === "font-family" && !style.getPropertyValue(property).split(",")
        .every((family) => DICTIONARY_FONT_FAMILIES.has(family.trim().toLowerCase()))) return false;
    }
    return true;
  }

  function typeDictionaryStyleVariables(style, prefix) {
    const declarations = style.cssText;
    if (!declarations.includes("--")) return;
    const suffixes = [];
    // CSSOM has already balanced the declaration block, and residual escapes
    // were rejected. Keep strings/comments opaque while pairing parentheses.
    // Aliases are typed at each var(); the dictionary's own names are renamed
    // wherever they appear, in declarations and references alike.
    style.cssText = declarations.replace(
      /"[^"]*"|'[^']*'|\/\*[\s\S]*?\*\/|\bvar\(\s*(--[\w\P{ASCII}-]+)|(?<![\w\P{ASCII}-])--[\w\P{ASCII}-]+|[()]/giu,
      (token, variable) => {
        const name = variable ?? (token.startsWith("--") ? token : null);
        if (name && !DICTIONARY_STYLE_VARIABLES.has(name)) {
          if (variable) suffixes.push("");
          return token.replace(name, prefix + name.slice(2));
        }
        if (variable) {
          const numeric = variable === "--font-size-no-units";
          suffixes.push(numeric ? " * 1)" : " 100%, transparent)");
          return (numeric ? "calc(" : "color-mix(in srgb, ") + token;
        }
        if (token === "(") suffixes.push("");
        return token === ")" ? token + suffixes.pop() : token;
      },
    );
  }

  function filterDictionaryStyleRules(parent, prefix) {
    for (let index = parent.cssRules.length - 1; index >= 0; index -= 1) {
      const rule = parent.cssRules[index];
      const kind = rule.constructor.name;
      if (kind === "CSSStyleRule" || kind === "CSSNestedDeclarations") {
        if (!isSafeDictionaryStyle(rule.style)) {
          parent.deleteRule(index);
          continue;
        }
        typeDictionaryStyleVariables(rule.style, prefix);
      } else if (!DICTIONARY_STYLE_GROUPS.has(kind)) {
        // Global definitions (@font-face, @property, keyframes, imports, etc.)
        // are not glossary-local even when written inside an @scope block.
        parent.deleteRule(index);
        continue;
      }
      if (rule.cssRules) filterDictionaryStyleRules(rule, prefix);
    }
  }

  // A selector list's top-level members; commas inside functions, attribute
  // selectors and strings stay with their selector.
  function splitSelectorList(selectorText) {
    const selectors = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let index = 0; index < selectorText.length; index += 1) {
      const character = selectorText[index];
      if (character === "\\") {
        index += 1;
      } else if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === "\"" || character === "'") {
        quote = character;
      } else if (character === "(" || character === "[") {
        depth += 1;
      } else if (character === ")" || character === "]") {
        depth -= 1;
      } else if (character === "," && depth === 0) {
        selectors.push(selectorText.slice(start, index).trim());
        start = index + 1;
      }
    }
    selectors.push(selectorText.slice(start).trim());
    return selectors;
  }

  // Yomitan's addScopeToCssLegacy (core/utilities.js at 67db60d): every
  // selector gains the scope as an ancestor, because Anki still ships
  // Chromium builds without @scope. Nested rules stay relative to their
  // prefixed parent. A rule the browser will not reparse is dropped rather
  // than left unscoped.
  function prefixDictionaryStyleRules(parent, scope) {
    for (let index = parent.cssRules.length - 1; index >= 0; index -= 1) {
      const rule = parent.cssRules[index];
      if (rule.constructor.name === "CSSStyleRule") {
        const previous = rule.selectorText;
        rule.selectorText = splitSelectorList(previous).map((selector) => `${scope} ${selector}`).join(", ");
        if (rule.selectorText === previous) parent.deleteRule(index);
      } else if (rule.cssRules) {
        prefixDictionaryStyleRules(rule, scope);
      }
    }
  }

  // Replaces whatever styles a previous generation installed in `host` rather
  // than tracking the elements outside, so a caller can re-apply at any time.
  // `host` is the shadow root (or document head) the popup lives in. With
  // `scope`, each dictionary's rules are prefixed by `scope(title)` instead of
  // wrapped in @scope.
  function applyDictionaryStyles(documentRef, host, generation, entries, { scope = null } = {}) {
    for (const element of host.querySelectorAll(
      "style[data-hoshidicts-dictionary-style]"
    )) {
      element.remove();
    }
    const applied = [];
    const dictionaries = new Set();
    let totalBytes = 0;
    // Other custom properties belong to the dictionary. They are renamed under
    // a prefix the page cannot read through the closed shadow root, so neither
    // an inherited page value nor an @property registration can reach them.
    const prefix = `--hd${Array.from(
      documentRef.defaultView.crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")}-`;
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!isRecord(entry)) {
        continue;
      }
      const dictionary = boundedString(entry.dictionary, 4096);
      const entryStyles = boundedString(entry.styles, MAX_DICTIONARY_STYLE_BYTES + 1);
      const styleBytes = utf8Length(entryStyles);
      // Keep the existing stylesheet transport bounds. Containment is enforced
      // by parsed scoping and the trusted card's paint boundary, not its size.
      if (
        !dictionary ||
        !entryStyles ||
        dictionaries.has(dictionary) ||
        styleBytes > MAX_DICTIONARY_STYLE_BYTES ||
        totalBytes + styleBytes > MAX_DICTIONARY_STYLES_BYTES
      ) {
        continue;
      }
      dictionaries.add(dictionary);
      totalBytes += styleBytes;
      // Detached parsing cannot fetch resources. Only browser-serialized rules
      // enter the controlled scope; raw closing braces must never reach it.
      const sheet = new documentRef.defaultView.CSSStyleSheet();
      sheet.replaceSync(entryStyles);
      filterDictionaryStyleRules(sheet, prefix);
      const style = documentRef.createElement("style");
      style.dataset.hoshidictsDictionaryStyle = dictionary;
      style.dataset.hoshidictsGeneration = String(generation);
      if (scope) {
        prefixDictionaryStyleRules(sheet, scope(dictionary));
        style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
      } else {
        style.textContent = [
          `@scope (.gsm-hoshidicts-glossary-content[data-hoshidicts-dictionary=${documentRef.defaultView.CSS.escape(dictionary)}]) {`,
          ...[...sheet.cssRules].map((rule) => rule.cssText),
          "}",
        ].join("\n");
      }
      host.appendChild(style);
      applied.push(style);
    }
    return applied;
  }

  // Walk dictionary data directly. Text mode never constructs rich DOM or media.
  // Layout follows JL's text flattening: tag spans are spaced, furigana reads
  // 昨日[きのう], list items get markers, table rows read "| a | b |", and block
  // boundaries add one line break instead of stacking blank lines.
  // With a marked language (the records have profiles; 11.2), each line whose
  // direction by 10.2's rule differs from `direction`, the dictionary's, is
  // wrapped after its list marker in a left-to-right or right-to-left isolate.
  // Outside the Japanese profile tag pills are always spaced and readings use
  // the language's `readingBrackets`. Without one it is today's flattener.
  const TEXT_BLOCK_TAGS = new Set(["div", "p", "li", "table", "thead", "tbody", "tfoot", "details", "summary"]);
  function glossaryToPlainText(glossary, language = null, { direction = "ltr" } = {}) {
    const marked = language?.marked === true;
    const otherLanguage = marked && language.code !== "ja";
    const base = direction === "rtl" ? "rtl" : "ltr";
    let value = glossary;
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch {
        return marked ? value.split("\n").map(line => isolateParagraph(line, base)).join("\n") : value;
      }
    }
    const [open, close] = otherLanguage && Array.isArray(language.labels?.readingBrackets)
      ? language.labels.readingBrackets : ["[", "]"];
    const LINE = {}, parts = [], lists = [], rows = [];
    let lineBreak = false;
    // The first part of the current line after its list marker.
    let lineStart = 0;
    const finishLine = () => {
      if (!marked || parts.length <= lineStart) return;
      const own = textDirection(parts.slice(lineStart).join(""));
      if (own && own !== base) {
        parts.splice(lineStart, 0, ISOLATES[own]);
        parts.push(POP_ISOLATE);
      }
    };
    const write = text => {
      if (lineBreak) {
        // A run of block boundaries becomes one break, without the whitespace before it.
        lineBreak = false;
        while (parts.length) {
          const last = parts.pop().trimEnd();
          if (last) {
            parts.push(last);
            finishLine();
            parts.push("\n");
            break;
          }
        }
        lineStart = parts.length;
      }
      if (text) parts.push(text);
    };
    const stack = [Array.isArray(value) ? value.flatMap(item => [item, LINE]) : value];
    while (stack.length) {
      const item = stack.pop();
      if (item == null) continue;
      if (item === LINE) lineBreak = true;
      else if (typeof item === "function") item();
      else if (Array.isArray(item)) {
        for (let index = item.length - 1; index >= 0; index--) stack.push(item[index]);
      } else if (typeof item !== "object") write(String(item));
      else if (item.tag === "img" || item.type === "image") {
        if (item.title) stack.push(LINE, String(item.title));
      } else if (item.tag === "br") {
        if (marked) {
          // An isolate cannot cross a line break.
          write("");
          finishLine();
          parts.push("\n");
          lineStart = parts.length;
        } else write("\n");
      } else if (item.tag === "rt") stack.push(close, item.content, open);
      else if (item.tag === "ul" || item.tag === "ol") {
        lists.push({ tag: item.tag, type: item.style?.listStyleType, number: 0 });
        stack.push(LINE, () => lists.pop(), item.content, LINE);
      } else if (item.tag === "tr") {
        rows.push(0);
        stack.push(LINE, () => rows.pop(), " |", item.content, "| ", LINE);
      } else if (item.tag !== "rp") {
        const block = TEXT_BLOCK_TAGS.has(item.tag);
        if (block) stack.push(LINE);
        // JL's rule for tag pills: a styled span spaces itself only with a right
        // margin; an unstyled classed span does when its text starts with ASCII.
        if (item.tag === "span" && (item.style ? item.style.marginRight != null : item.data?.class != null)) {
          write(""); // settle a pending break so parts[start] is the pill's own text
          const start = parts.length, always = item.style != null || otherLanguage;
          stack.push(() => { if (parts.length > start && (always || parts[start].charCodeAt(0) < 128)) parts.push(" "); });
        }
        // Icon-only cells such as Jitendex's form markers carry their meaning in the title.
        stack.push(item.content ?? (typeof item.title === "string" ? item.title : null));
        if (item.tag === "li" && lists.length) {
          const list = lists.at(-1), type = item.style?.listStyleType ?? list.type;
          list.number++;
          // A quoted type is a literal CSS marker, such as Jitendex's "①".
          let marker = /^(["'])(.*)\1$/u.exec(type ?? "")?.[2] ?? (list.tag === "ol" ? `${list.number}.` : "•");
          if (type === "none") marker = "";
          // The line's own text starts after its marker.
          if (marker && marked) stack.push(() => { lineStart = parts.length; });
          if (marker) stack.push(`${marker} `);
        } else if ((item.tag === "th" || item.tag === "td") && rows.length) {
          if (rows[rows.length - 1]++) stack.push(" | "); // every cell after the row's first
        }
        if (block) stack.push(LINE);
      }
    }
    if (marked) {
      while (parts.length) {
        const last = parts.pop().trimEnd();
        if (last) { parts.push(last); break; }
      }
      finishLine();
    }
    return parts.join("").trim();
  }

  return {
    glossaryToPlainText,
    appendExpressionRuby,
    appendHeadword,
    appendStructuredImage,
    appendStructuredValue,
    appendTextOnlyGlossary,
    applyDictionaryStyles,
    applyStructuredData,
    applyStructuredStyle,
    boundedString,
    buildPitchAccentMorae,
    createFuriganaSegment,
    createKanjiReadings,
    createKanwaReadings,
    createPronunciationDownstepPosition,
    createPronunciationGraph,
    createPronunciationPitchAccent,
    createPronunciationText,
    definitionTagList,
    distributeFurigana,
    frequencyMean,
    frequencyModeMatches,
    frequencyNumber,
    getDownstepPositions,
    getFuriganaKanaSegments,
    glossaryTextLanguage,
    hasRtlText,
    inheritedTextLanguage,
    isMoraPitchHigh,
    isRecord,
    isolateParagraph,
    kanjiFurigana,
    languageFromText,
    markBlockDirections,
    matchedFurigana,
    normalizeMediaPath,
    parseStructuredLink,
    parseTagList,
    pitchAccentCategory,
    pitchAccentDownstep,
    pitchAccentPositions,
    segmentFurigana,
    segmentizeFurigana,
    selectPitchAccent,
    setAttributes,
    splitPitchAccentMorae,
    structuredDataAttributeName,
    targetLanguage,
    termFurigana,
    textDirection,
    textLanguage,
    toHiragana,
  };
}));
