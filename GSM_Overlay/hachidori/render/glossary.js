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
}(typeof window !== "undefined" ? window : globalThis, function () {
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
  // A kun'yomi ending in an u-row kana has its masu-stem in the i row
  // (す.く, すき; きら.う, きらい).
  const U_ROW_KANA = "うくぐすつぬぶむる";
  const I_ROW_KANA = "いきぎしちにびみり";
  // The final kana a sokuon can replace (一 いち, いっ).
  const SOKUON_KANA = "つちくきり";
  const NO_KANJI_READINGS = new Set();
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

  // Yomitan's getPitchCategory (japanese.js at 67db60d) with its
  // isNonNounVerbOrAdjective: a pattern's category is its first downstep and
  // any downstep of a verb or i-adjective is kifuku. The popup and
  // {pitch-accent-categories} share it.
  function pitchAccentCategory(reading, pitch, wordClasses = []) {
    const classes = new Set(wordClasses);
    const inflected = ["v1", "v5", "vk", "vs", "vz", "adj-i"].some(rule => classes.has(rule))
      && !(classes.has("vs") && classes.has("n"));
    const position = Number(pitchAccentDownstep(pitch).split(",")[0]);
    if (position === 0) return "heiban";
    if (Number.isNaN(position) || position < 0) return null;
    if (inflected) return "kifuku";
    if (position === 1) return "atamadaka";
    return position >= splitPitchAccentMorae(reading).length ? "odaka" : "nakadaka";
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
  // and data-pitch-category its accent group from the term's word classes.
  function createPronunciationPitchAccent(documentRef, reading, pitch,
    { text = true, position = true, graph = false, wordClasses = [] } = {}) {
    const positions = pitchAccentPositions(pitch);
    const morae = splitPitchAccentMorae(reading);
    const node = documentRef.createElement("li");
    node.className = "pronunciation";
    node.dataset.pitchAccentDownstepPosition = `${positions}`;
    const category = pitchAccentCategory(reading, pitch, wordClasses);
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
  // すく, すき); each of those with rendaku; and each of all these with a final
  // つ, ち, く, き or り as っ (いっ, ぱっ).
  function kanjiReadingForms(readings) {
    const forms = new Set();
    for (const reading of readings.split(" ")) {
      const [stem, okurigana = ""] = reading.split(".");
      forms.add(stem).add(stem + okurigana);
      const row = okurigana === "" ? -1 : U_ROW_KANA.indexOf(okurigana.at(-1));
      if (row >= 0) forms.add(stem + okurigana.slice(0, -1) + I_ROW_KANA[row]);
    }
    for (const form of [...forms]) {
      const codePoint = form.codePointAt(0);
      if (DAKUTEN_KANA.includes(form[0])) forms.add(String.fromCodePoint(codePoint + 1) + form.slice(1));
      if (HANDAKUTEN_KANA.includes(form[0])) forms.add(String.fromCodePoint(codePoint + 2) + form.slice(1));
    }
    for (const form of [...forms]) {
      if (SOKUON_KANA.includes(form.at(-1))) forms.add(`${form.slice(0, -1)}っ`);
    }
    return forms;
  }

  // Each kanji's reading forms over a table of KANJIDIC readings
  // ({ "好": "こう この.む す.く よ.い い.い", … }), for distributeFurigana. A
  // kanji's forms are derived the first time it is asked for.
  function createKanjiReadings(table) {
    const cache = new Map();
    return (character) => {
      let forms = cache.get(character);
      if (forms === undefined) {
        forms = Object.hasOwn(table, character) ? kanjiReadingForms(table[character]) : NO_KANJI_READINGS;
        cache.set(character, forms);
      }
      return forms;
    };
  }

  // Whether a run of kanji reads as `reading`: one form per character, in
  // order. 々 repeats the kanji before it; a character without readings (a
  // digit, a letter, 、) never reads.
  function readsAs(text, reading, kanjiReadings) {
    // Where in the reading the characters so far can end.
    let ends = new Set([0]);
    let forms = NO_KANJI_READINGS;
    for (const character of text) {
      if (character !== "々") forms = kanjiReadings(character);
      const next = new Set();
      for (const end of ends) {
        for (const form of forms) {
          if (reading.startsWith(form, end)) next.add(end + form.length);
        }
      }
      if (next.size === 0) return false;
      ends = next;
    }
    return ends.has(reading.length);
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
        || readsAs(group.text, normalizedReading.substring(0, index), kanjiReadings)
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

  // `furigana` is the term's furigana from the engine, if any (termFurigana).
  function appendExpressionRuby(
    documentRef,
    parent,
    expression,
    reading,
    onKanjiClick,
    pitchOptions = {},
    furigana = null
  ) {
    const furiganaSegments = termFurigana({ expression, reading, furigana });
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
    // The furigana's pitch also gives the headword's group, contour or not.
    const selectedPitch = selectPitchAccent(
      pitchOptions.groups,
      pitchOptions.dictionary,
      splitPitchAccentMorae(pitchReading).length
    );
    const category = selectedPitch
      ? pitchAccentCategory(pitchReading, selectedPitch.pitch, pitchOptions.wordClasses)
      : null;
    const pitchedMorae = selectedPitch && pitchOptions.enabled !== false
      ? buildPitchAccentMorae(pitchReading, pitchAccentPositions(selectedPitch.pitch))
      : null;
    if (pitchedMorae) {
      const downstep = pitchAccentDownstep(selectedPitch.pitch);
      // One column per furigana segment, so each reading sits over the text it
      // reads. Kana segments get a column too, keeping the contour unbroken.
      let segments = furiganaSegments.map((segment) => ({
        text: segment.text,
        moraCount: splitPitchAccentMorae(segment.reading || segment.text).length,
      }));
      if (
        segments.reduce((total, segment) => total + segment.moraCount, 0) !==
        pitchedMorae.length
      ) {
        segments = [{ text: expression, moraCount: pitchedMorae.length }];
      }
      const title = [
        selectedPitch.dictionary,
        `Pitch accent ${downstep}`,
      ].filter(Boolean).join(" · ");
      // "overline": the pitch list's own Yomitan text, built once for the
      // whole reading so each mora keeps its word-level pitch and next pitch
      // (見る [1] hooks み at the segment boundary), then shared out to the
      // segments. Nasal and devoice marks stay in the list: a nasal mark
      // rewrites the kana.
      const overlineMorae = pitchOptions.style === "overline"
        ? [...createPronunciationText(documentRef, pitchedMorae.map((mora) => mora.text),
            pitchAccentPositions(selectedPitch.pitch), [], []).children]
        : null;
      let moraIndex = 0;
      for (const segment of segments) {
        const ruby = documentRef.createElement("ruby");
        ruby.className = "gsm-hoshidicts-pitch-ruby";
        const base = documentRef.createElement("span");
        base.className = "gsm-hoshidicts-pitch-base";
        appendText(base, segment.text);
        ruby.appendChild(base);

        const rt = documentRef.createElement("rt");
        rt.className = "gsm-hoshidicts-pitch-reading";
        rt.dataset.pitchPosition = downstep;
        if (selectedPitch.dictionary) {
          rt.dataset.pitchDictionary = selectedPitch.dictionary;
        }
        rt.title = title;

        const contour = documentRef.createElement("span");
        contour.className = "gsm-hoshidicts-pitch-contour";
        if (overlineMorae) {
          contour.dataset.pitchStyle = "overline";
          contour.append(...overlineMorae.slice(moraIndex, moraIndex + segment.moraCount));
        } else {
          for (const mora of pitchedMorae.slice(moraIndex, moraIndex + segment.moraCount)) {
            const span = documentRef.createElement("span");
            span.className = "gsm-hoshidicts-pitch-mora";
            span.dataset.pitchLevel = mora.level;
            if (mora.transition) {
              span.dataset.pitchTransition = mora.transition;
            }
            span.textContent = mora.text;
            contour.appendChild(span);
          }
        }
        moraIndex += segment.moraCount;
        rt.appendChild(contour);
        ruby.appendChild(rt);
        parent.appendChild(ruby);
      }
      return category;
    }

    for (const segment of furiganaSegments) {
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
    return category;
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

  // Yomitan's _setMultilineTextContent: each "\n" becomes a <br>, so the text
  // copies with its line breaks. A glossary's text gets the same language
  // detection as a string in structured content.
  function appendMultilineText(documentRef, parent, text) {
    text.split("\n").forEach((line, index) => {
      if (index > 0) parent.appendChild(documentRef.createElement("br"));
      if (line) parent.appendChild(documentRef.createTextNode(line));
    });
    const language = languageFromText(text);
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
        const language = frame.language === null ? languageFromText(value) : null;
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
      appendMultilineText(documentRef, content, typeof item === "string" ? item : item.text);
    } else if (isRecord(item) && item.type === "image") {
      countStructuredNode(state, path);
      appendStructuredImage(documentRef, content, item, state);
      if (typeof item.description === "string") {
        const description = documentRef.createElement("span");
        description.className = "gloss-image-description";
        appendMultilineText(documentRef, description, item.description);
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
    if (options.layout !== "anki") {
      // The popup's glossary markup is Yomitan's: ul.gloss-list, even for one
      // element, with data-count counting the items it shows.
      const list = documentRef.createElement("ul");
      list.className = "gloss-list";
      items.forEach((item, index) => appendGlossItem(documentRef, list, item, state, index));
      list.dataset.count = String(list.children.length);
      parent.appendChild(list);
      return;
    }
    // Yomitan's Anki glossary-single template emits one element bare and
    // several as a list.
    if (items.length === 0) {
      return;
    }
    if (items.some((item) => isRecord(item) && item.type === "structured-content")) {
      parent.classList.add("structured-content");
    }
    if (items.length === 1) {
      appendStructuredValue(documentRef, parent, items[0], state, 0, ["glossary", 0]);
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
  const TEXT_BLOCK_TAGS = new Set(["div", "p", "li", "table", "thead", "tbody", "tfoot", "details", "summary"]);
  function glossaryToPlainText(glossary) {
    let value = glossary;
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { return value; }
    }
    const LINE = {}, parts = [], lists = [], rows = [];
    let lineBreak = false;
    const write = text => {
      if (lineBreak) {
        // A run of block boundaries becomes one break, without the whitespace before it.
        lineBreak = false;
        while (parts.length) {
          const last = parts.pop().trimEnd();
          if (last) { parts.push(last, "\n"); break; }
        }
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
      } else if (item.tag === "br") write("\n");
      else if (item.tag === "rt") stack.push("]", item.content, "[");
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
          const start = parts.length, always = item.style != null;
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
          if (marker) stack.push(`${marker} `);
        } else if ((item.tag === "th" || item.tag === "td") && rows.length) {
          if (rows[rows.length - 1]++) stack.push(" | "); // every cell after the row's first
        }
        if (block) stack.push(LINE);
      }
    }
    return parts.join("").trim();
  }

  return {
    glossaryToPlainText,
    appendExpressionRuby,
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
    createPronunciationDownstepPosition,
    createPronunciationGraph,
    createPronunciationPitchAccent,
    createPronunciationText,
    definitionTagList,
    distributeFurigana,
    getDownstepPositions,
    getFuriganaKanaSegments,
    isMoraPitchHigh,
    isRecord,
    normalizeMediaPath,
    parseStructuredLink,
    parseTagList,
    pitchAccentCategory,
    pitchAccentDownstep,
    pitchAccentPositions,
    segmentFurigana,
    segmentizeFurigana,
    selectPitchAccent,
    splitPitchAccentMorae,
    structuredDataAttributeName,
    termFurigana,
    toHiragana,
  };
}));
