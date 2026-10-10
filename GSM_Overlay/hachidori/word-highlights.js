// SPDX-License-Identifier: GPL-3.0-or-later
//
// Word highlighting (#520): marks the Japanese words a frame shows with their
// Anki status through the CSS Custom Highlight API, so the page's DOM is never
// changed. The local engine segments the text (`hd_segment`) and the worker's
// cached Anki index answers each word's status (`hd_anki_word_status`); the
// worker's change signal re-reads the statuses of the words already marked
// without segmenting the page again. A word marked as known or ignored from
// the popup (createWordStatusActions below) takes that status instead.
//
// content.js supplies how page text is read, the way a hover reads it: the
// blocks under a node whose own text includes Japanese, the block whose own
// text a node is part of, each block's runs as text node parts
// ({ node, start, end }), and a run's character entries
// ({ node, offset, sourceLength, text, collapsed }) once it is needed.
(function () {
  "use strict";

  const STATUSES = ["unknown", "learning", "known", "ignored"];
  const HIGHLIGHT_NAMES = Object.fromEntries(STATUSES.map(status => [status, `hd-word-${status}`]));
  const OPTION_KEYS = { unknown: "wordHighlightUnknown", learning: "wordHighlightLearning", known: "wordHighlightKnown",
    ignored: "wordHighlightIgnored" };
  // Each status takes a colour of the popup palette chosen in Design, or of
  // the default palette for a theme renderer that brings none. Ignored is the
  // popup's own faint text, reader.css's --hoshidicts-text-faint: its content
  // colour 56% into its base.
  const PALETTE_TOKENS = { unknown: "error", learning: "warning", known: "success" };
  const FAINT_TOKENS = ["base-content", "base-100"];
  const FAINT_SHARE = 0.56;
  const DEFAULT_COLORS = { unknown: "#c67d80", learning: "#c29a65", known: "#7fa58d", ignored: "#939199" };
  // WCAG's contrast for a line against its background, and for coloured text.
  const LINE_CONTRAST = 3;
  const TEXT_CONTRAST = 4.5;
  const ENGINE_TARGET = "hoshidicts-offscreen";
  const ANKI_TARGET = "hachidori-anki";
  // A hover waits for the chunk the engine is segmenting, so a chunk is a
  // sentence, cut at a clause break only when it runs past this many units.
  const MAX_CHUNK_LENGTH = 128;
  const SENTENCE_END = new Set(["。", "．", "！", "？", "!", "?", "…", "‥"]);
  const CLAUSE_END = new Set(["、", "，", ",", " ", "　"]);
  const MAX_BATCH_CHUNKS = 32;
  const MAX_BATCH_LENGTH = 2048;
  // The latest segmentations, by their exact text, so repeated texthooker
  // lines and redrawn subtitles are free; a texthooker runs for hours.
  const SEGMENT_CACHE_ENTRIES = 4096;
  const RETRY_MS = 1000;
  const MAX_RETRY_MS = 60_000;
  const RECHECK_MS = 100;

  // A word with a card, or one marked as known or ignored: anything but unknown.
  const isDecided = status => status !== "unknown";

  // sRGB relative luminance and contrast ratio, as WCAG defines them.
  function luminance(rgb) {
    return rgb.map(channel => channel / 255)
      .map(channel => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  }

  function contrast(first, second) {
    const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
  }

  // The colour moved toward black or white, whichever the background contrasts
  // with more, until it reaches `ratio` against the background.
  function legible(color, background, ratio) {
    const toward = contrast([0, 0, 0], background) >= contrast([255, 255, 255], background)
      ? [0, 0, 0] : [255, 255, 255];
    for (let step = 0; step <= 20; step += 1) {
      const mixed = color.map((channel, index) => Math.round(channel + (toward[index] - channel) * step / 20));
      if (contrast(mixed, background) >= ratio) return mixed;
    }
    return toward;
  }

  // Where a sentence that has reached MAX_CHUNK_LENGTH at `index` is cut:
  // after its last clause break in the second half of that length, or at the
  // length itself, and never between the halves of a surrogate pair.
  function longChunkEnd(text, start, index) {
    let end = index + 1;
    for (let back = index; back > start + MAX_CHUNK_LENGTH / 2; back -= 1) {
      if (CLAUSE_END.has(text[back])) {
        end = back + 1;
        break;
      }
    }
    const unit = text.codePointAt(end);
    return unit >= 0xdc00 && unit <= 0xdfff ? end + 1 : end;
  }

  // A run's sentences as { start, text }, a long one cut by longChunkEnd(). A
  // chunk without Japanese is dropped.
  function chunksOf(text, isJapanese) {
    const chunks = [];
    let start = 0;
    let index = 0;
    while (index < text.length) {
      let end = null;
      if (SENTENCE_END.has(text[index])) end = index + 1;
      else if (index + 1 - start >= MAX_CHUNK_LENGTH) end = longChunkEnd(text, start, index);
      if (end === null) {
        index += 1;
        continue;
      }
      const piece = text.slice(start, end);
      if (isJapanese(piece)) chunks.push({ start, text: piece });
      start = end;
      index = end;
    }
    const rest = text.slice(start);
    if (rest && isJapanese(rest)) chunks.push({ start, text: rest });
    return chunks;
  }

  // A phrase that is one dictionary entry and also splits into words around
  // a function word (今日は as 今日 + は). A compound of content words alone
  // (学生 as 学 + 生) is a word of its own, as its card would be.
  function alternativeApplies(span) {
    const words = Array.isArray(span.alternative) ? span.alternative : [];
    return words.some(word => word.functionWord) && words.some(word => !word.functionWord);
  }

  // A run's text, and the pieces mapping it onto the page: run text
  // [start, start + length) is node text [offset, end), one code unit for one
  // except a collapsed whitespace piece, which stands for its whole source.
  function runOf(entries) {
    const pieces = [];
    let text = "";
    for (const entry of entries) {
      const last = pieces.at(-1);
      if (last && !last.collapsed && !entry.collapsed && last.node === entry.node && last.end === entry.offset) {
        last.end += entry.sourceLength;
        last.length += entry.text.length;
      } else {
        pieces.push({ node: entry.node, offset: entry.offset, end: entry.offset + entry.sourceLength,
          start: text.length, length: entry.text.length, collapsed: entry.collapsed === true });
      }
      text += entry.text;
    }
    return { text, pieces };
  }

  function createWordHighlighter({ window, send, textBlocks, blockOf, textRuns, runEntries, isJapanese, prepare, readPalette }) {
    const { document } = window;
    const highlights = Object.fromEntries(STATUSES.map(status => {
      const highlight = new window.Highlight();
      // Below the hover's source highlight, which keeps the default priority.
      highlight.priority = -1;
      return [status, highlight];
    }));
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    let probe = null;
    let sheet = null;
    let options = null;
    let running = false;
    // Bumped by start() and stop(): an answer to an older session is dropped.
    let session = 0;
    // Bumped by invalidate() too, for segmentations of older dictionaries.
    let segmentEpoch = 0;
    let ready = false;
    let preparing = false;
    let suspended = 0;
    let intersections = null;
    let mutations = null;
    let scheduled = false;
    let recheckTimer = null;
    let retryTimer = null;
    let failures = 0;
    const blocks = new Map();
    const visible = new Set();
    const segments = new Map();
    let generation = null;
    let segmenting = false;
    // Status by headword, every one shown read at statusRevision for
    // statusesEpoch, or later. Every change signal bumps statusEpoch, so the
    // words shown are read again.
    const statuses = new Map();
    let statusEpoch = 0;
    let statusesEpoch = -1;
    let statusRevision = null;
    // Unknown until the worker answers. False means the cached index has no
    // rows for the first Anki Template, so nothing is segmented or marked.
    let available = null;
    let statusing = false;
    // Mark as known and Ignore, by headword (word-status-overrides.js). They
    // win over the Anki status and need no request: content.js hands over the
    // stored record whenever it changes.
    let overrides = new Map();

    function schedule() {
      if (scheduled || !running) return;
      scheduled = true;
      window.queueMicrotask(pump);
    }

    function retryLater() {
      failures += 1;
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        schedule();
      }, Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** (failures - 1)));
    }

    // ------------------------------------------------------------ page text

    function track(element) {
      const block = blocks.get(element);
      if (block) {
        block.dirty = true;
        return;
      }
      blocks.set(element, { element, runs: [], dirty: true, recheck: true });
      intersections.observe(element);
    }

    function drop(block) {
      for (const run of block.runs) unpaint(run);
      intersections.unobserve(block.element);
      blocks.delete(block.element);
      visible.delete(block);
    }

    function rebuild(block) {
      for (const run of block.runs) unpaint(run);
      block.runs = textRuns(block.element)
        .filter(parts => parts.some(({ node, start, end }) => isJapanese(node.data.slice(start, end))))
        .map(parts => ({ parts, text: null, pieces: null, chunks: null, wanted: false, stale: true, painted: [] }));
      block.dirty = false;
      block.recheck = true;
    }

    // A run's text and chunks, read the first time it is wanted.
    function build(run) {
      ({ text: run.text, pieces: run.pieces } = runOf(runEntries(run.parts)));
      run.chunks = chunksOf(run.text, isJapanese);
    }

    // Runs are wanted, segmented and painted, only within a viewport of the
    // visible area, so a long page, or one huge block of it (an Aozora Bunko
    // novel is a single block of <br>-separated lines), keeps only the ranges
    // near what is shown. Chrome revalidates every registered range whenever
    // any highlight changes, the hover's source highlight included.
    function runRect(run) {
      const first = run.parts[0];
      const last = run.parts.at(-1);
      const range = document.createRange();
      try {
        range.setStart(first.node, first.start);
        range.setEnd(last.node, last.end);
      } catch {
        return null;
      }
      return range.getBoundingClientRect();
    }

    // -1 when a rect lies before that area along the block's direction (above
    // it for horizontal text, right of it for vertical-rl, left for
    // vertical-lr), 1 after it, 0 within it.
    function sideOf(writingMode) {
      const { innerWidth: width, innerHeight: height } = window;
      if (writingMode.endsWith("-rl")) return rect => (rect.left > 2 * width ? -1 : Number(rect.right < -width));
      if (writingMode.endsWith("-lr")) return rect => (rect.right < -width ? -1 : Number(rect.left > 2 * width));
      return rect => (rect.bottom < -height ? -1 : Number(rect.top > 2 * height));
    }

    // A block's runs follow its direction in document order, so the near ones
    // are found by bisection; a block set in columns is checked run by run.
    function recheck(block) {
      block.recheck = false;
      const { runs } = block;
      // The observer has already found a one-run block near the viewport.
      if (runs.length === 1) {
        runs[0].wanted = true;
        return;
      }
      const style = window.getComputedStyle(block.element);
      const side = sideOf(style.writingMode);
      const place = run => {
        const rect = runRect(run);
        return rect ? side(rect) : 1;
      };
      let near;
      if ([style.columnCount, style.columnWidth].some(value => value && value !== "auto")) {
        near = runs.map(run => place(run) === 0);
      } else {
        let first = 0;
        let last = runs.length;
        while (first < last) {
          const middle = (first + last) >> 1;
          if (place(runs[middle]) < 0) first = middle + 1;
          else last = middle;
        }
        let end = first;
        while (end < runs.length && place(runs[end]) <= 0) end += 1;
        near = runs.map((_, index) => index >= first && index < end);
      }
      runs.forEach((run, index) => {
        if (run.wanted && !near[index]) {
          unpaint(run);
          run.stale = true;
        }
        run.wanted = near[index];
      });
    }

    function onIntersection(entries) {
      for (const entry of entries) {
        const block = blocks.get(entry.target);
        if (!block) continue;
        if (entry.isIntersecting) {
          visible.add(block);
          block.recheck = true;
        } else if (visible.delete(block)) {
          // Text that leaves the viewport keeps no ranges; its segmentation
          // stays cached for its return.
          for (const run of block.runs) {
            unpaint(run);
            run.wanted = false;
            run.stale = true;
          }
        }
      }
      schedule();
    }

    function trackBlocks(node) {
      for (const element of textBlocks(node)) track(element);
    }

    // Marks what a mutation changed; true when it removed nodes. The block
    // whose own text holds the target, the node whose text or children
    // changed, is the one whose runs can have changed: a line appended to a
    // nested block's list leaves the blocks around it alone, while a nested
    // block removed from its parent re-reads the parent. A target already out
    // of the document belongs to a removed block, which onMutations drops.
    function noteMutation(record) {
      const block = record.target.isConnected ? blocks.get(blockOf(record.target)) : undefined;
      if (block) block.dirty = true;
      if (record.type === "characterData") trackBlocks(record.target);
      for (const node of record.addedNodes) trackBlocks(node);
      return record.removedNodes.length > 0;
    }

    function onMutations(records) {
      let removed = false;
      for (const record of records) removed = noteMutation(record) || removed;
      // A Map iterator stays valid while drop() deletes its current entry.
      if (removed) {
        for (const block of blocks.values()) {
          if (!block.element.isConnected) drop(block);
        }
      }
      schedule();
    }

    function onViewportChange() {
      if (recheckTimer !== null) return;
      recheckTimer = window.setTimeout(() => {
        recheckTimer = null;
        for (const block of visible) {
          if (block.runs.length > 1) block.recheck = true;
        }
        schedule();
      }, RECHECK_MS);
    }

    // --------------------------------------------------------------- status

    const surfaceOf = (span, text) => text.slice(span.start, span.start + span.length);

    function markable(span, text) {
      return !span.functionWord && Array.isArray(span.candidates) && span.candidates.length > 0
        && isJapanese(surfaceOf(span, text));
    }

    // A kana-written word can be another candidate's reading: かわいい on the
    // page against a 可愛い card.
    function readingCandidates(span, text) {
      const surface = surfaceOf(span, text);
      return span.candidates.slice(1).filter(candidate => (candidate.reading || candidate.expression) === surface);
    }

    function spanHeadwords(span, text) {
      if (!markable(span, text)) return [];
      const headwords = [span.candidates[0].expression,
        ...readingCandidates(span, text).map(candidate => candidate.expression)];
      if (alternativeApplies(span)) {
        for (const word of span.alternative) headwords.push(...spanHeadwords(word, text));
      }
      return headwords;
    }

    // A headword's status: its override, else its card's.
    const statusOf = headword => overrides.get(headword) ?? statuses.get(headword);

    // The popup's first result decides, so a mark agrees with what a hover
    // shows; when it is unknown, a candidate the surface spells out may decide.
    function spanStatus(span, text) {
      const first = statusOf(span.candidates[0].expression);
      if (isDecided(first)) return first;
      return readingCandidates(span, text).map(candidate => statusOf(candidate.expression))
        .find(isDecided) ?? "unknown";
    }

    // Marks are { start, length, status } in the chunk's text. A phrase that
    // is unknown, made only of words that are not, is marked as those words.
    function spanMarks(span, text) {
      if (!markable(span, text)) return [];
      const status = spanStatus(span, text);
      if (status === "unknown" && alternativeApplies(span)
          && span.alternative.every(word => !markable(word, text) || isDecided(spanStatus(word, text)))) {
        return span.alternative.flatMap(word => spanMarks(word, text));
      }
      return [{ start: span.start, length: span.length, status }];
    }

    function runHeadwords(run) {
      const headwords = [];
      for (const chunk of run.chunks) {
        for (const span of segments.get(chunk.text) ?? []) headwords.push(...spanHeadwords(span, chunk.text));
      }
      return headwords;
    }

    // The run's marks in its own text, or null until every chunk is segmented
    // and every status the marks need has been read.
    function runMarks(run) {
      if (available === false) return [];
      const marks = [];
      for (const chunk of run.chunks) {
        const spans = segments.get(chunk.text);
        if (spans === undefined) return null;
        for (const span of spans) {
          if (!spanHeadwords(span, chunk.text).every(headword => statuses.has(headword))) return null;
          for (const mark of spanMarks(span, chunk.text)) marks.push({ ...mark, start: mark.start + chunk.start });
        }
      }
      return marks;
    }

    // ------------------------------------------------------------- painting

    // One static range per text node a mark covers, so ruby annotations
    // between them stay unmarked and page mutations need no range upkeep.
    function markRanges(run, start, end) {
      const { pieces } = run;
      let low = 0;
      let high = pieces.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (pieces[middle].start + pieces[middle].length <= start) low = middle + 1;
        else high = middle;
      }
      const parts = [];
      for (let index = low; index < pieces.length && pieces[index].start < end; index += 1) {
        const piece = pieces[index];
        const from = piece.collapsed ? piece.offset : piece.offset + Math.max(0, start - piece.start);
        const to = piece.collapsed ? piece.end : piece.offset + Math.min(piece.length, end - piece.start);
        const part = parts.at(-1);
        if (part?.node === piece.node && part.end === from) part.end = to;
        else parts.push({ node: piece.node, start: from, end: to });
      }
      return parts.map(part => new window.StaticRange({
        startContainer: part.node, startOffset: part.start, endContainer: part.node, endOffset: part.end,
      }));
    }

    function unpaint(run) {
      for (const [status, range] of run.painted) highlights[status].delete(range);
      run.painted = [];
    }

    function paint(run) {
      const marks = runMarks(run);
      if (marks === null) return;
      unpaint(run);
      for (const { start, length, status } of marks) {
        for (const range of markRanges(run, start, start + length)) {
          highlights[status].add(range);
          run.painted.push([status, range]);
        }
      }
      run.stale = false;
    }

    // Each run keeps its marks until its new ones are ready.
    function repaintAll() {
      for (const block of visible) {
        for (const run of block.runs) run.stale = true;
      }
    }

    function register() {
      if (!running || !ready) return;
      for (const status of STATUSES) {
        const name = HIGHLIGHT_NAMES[status];
        if (suspended === 0 && options[OPTION_KEYS[status]]) window.CSS.highlights.set(name, highlights[status]);
        else if (window.CSS.highlights.get(name) === highlights[status]) window.CSS.highlights.delete(name);
      }
    }

    // sRGB bytes of any CSS colour, oklch() included, as Chrome paints it.
    function rgba(value) {
      probe ??= new window.OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = "#0000";
      probe.fillStyle = value;
      probe.fillRect(0, 0, 1, 1);
      return [...probe.getImageData(0, 0, 1, 1).data];
    }

    // The page's own background, which the marks are made legible against.
    function pageBackground() {
      for (const element of [document.body, document.documentElement]) {
        if (!element) continue;
        const [red, green, blue, alpha] = rgba(window.getComputedStyle(element).backgroundColor);
        if (alpha > 0) return [red, green, blue];
      }
      // A transparent root shows the canvas, which is dark only for a page
      // whose colour scheme allows dark.
      const schemes = new Set(window.getComputedStyle(document.documentElement).colorScheme.split(/\s+/u));
      const dark = schemes.has("dark") && (!schemes.has("light") || colorScheme.matches);
      return dark ? [18, 18, 18] : [255, 255, 255];
    }

    // A status's sRGB colour from the palette's tokens, or the default palette's.
    function statusColor(palette, status) {
      const token = name => palette?.getPropertyValue(`--hoshidicts-palette-${name}`).trim();
      if (status !== "ignored") return rgba(token(PALETTE_TOKENS[status]) || DEFAULT_COLORS[status]).slice(0, 3);
      const [content, base] = FAINT_TOKENS.map(token);
      if (!content || !base) return rgba(DEFAULT_COLORS.ignored).slice(0, 3);
      const [from, to] = [rgba(content), rgba(base)];
      return from.slice(0, 3).map((channel, index) => Math.round(channel * FAINT_SHARE + to[index] * (1 - FAINT_SHARE)));
    }

    // content.css draws each status with its own line style. This owned sheet
    // gives it the palette's colour, or swaps the line for coloured text or a
    // tinted background. Under forced colours Chrome paints every highlight in
    // Highlight and HighlightText whatever its author colours, so the sheet
    // stands aside and the line styles alone tell the statuses apart.
    function refreshColors() {
      if (!running || !ready) return;
      const palette = readPalette();
      const background = pageBackground();
      const rules = STATUSES.map(status => {
        const color = statusColor(palette, status);
        let declarations = `text-decoration-color: rgb(${legible(color, background, LINE_CONTRAST).join(" ")});`;
        if (options.wordHighlightStyle === "color") {
          declarations = `text-decoration-line: none; color: rgb(${legible(color, background, TEXT_CONTRAST).join(" ")});`;
        } else if (options.wordHighlightStyle === "background") {
          declarations = `text-decoration-line: none; background-color: rgb(${color.join(" ")} / 34%);`;
        }
        return `  ::highlight(${HIGHLIGHT_NAMES[status]}) { ${declarations} }`;
      });
      sheet ??= new window.CSSStyleSheet();
      sheet.replaceSync(`@media not (forced-colors: active) {\n${rules.join("\n")}\n}`);
      if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }

    // ------------------------------------------------------------- requests

    function* wantedRuns() {
      for (const block of visible) {
        for (const run of block.runs) {
          if (run.wanted) yield run;
        }
      }
    }

    // The next texts to segment, in viewport order, within the batch limits.
    function nextBatch() {
      const batch = new Set();
      let length = 0;
      for (const run of wantedRuns()) {
        for (const chunk of run.chunks) {
          if (segments.has(chunk.text) || batch.has(chunk.text)) continue;
          batch.add(chunk.text);
          length += chunk.text.length;
          if (batch.size >= MAX_BATCH_CHUNKS || length >= MAX_BATCH_LENGTH) return [...batch];
        }
      }
      return [...batch];
    }

    function adoptSegments(texts, reply) {
      // A dictionary commit between two chunks leaves a batch of two
      // generations, so a changed generation discards every segmentation.
      if (generation !== null && reply.generation !== generation) {
        segments.clear();
        repaintAll();
      } else {
        for (const { id, spans } of reply.segments) {
          segments.delete(texts[id]);
          segments.set(texts[id], spans);
        }
        while (segments.size > SEGMENT_CACHE_ENTRIES) segments.delete(segments.keys().next().value);
      }
      generation = reply.generation;
    }

    async function requestSegments() {
      if (segmenting || retryTimer !== null || available !== true) return;
      const texts = nextBatch();
      if (texts.length === 0) return;
      const epoch = segmentEpoch;
      segmenting = true;
      let reply;
      try {
        reply = await send("hd_segment", {
          chunks: texts.map((text, id) => ({ id, text })),
          scanLength: options.scanLength,
          options: { frequencyDictionary: options.frequencyDictionary, frequencyOrder: options.frequencyOrder,
            personalDictionary: options.personalDictionaryEnabled },
        }, ENGINE_TARGET);
      } catch {
        if (epoch === segmentEpoch) {
          segmenting = false;
          retryLater();
        }
        return;
      }
      if (epoch !== segmentEpoch) return;
      segmenting = false;
      failures = 0;
      adoptSegments(texts, reply);
      schedule();
    }

    // The headwords of the words shown: all of them for a refresh, else
    // those not read yet.
    function headwordsToAsk(refresh) {
      const headwords = new Set();
      for (const run of wantedRuns()) {
        for (const headword of runHeadwords(run)) {
          if (refresh || !statuses.has(headword)) headwords.add(headword);
        }
      }
      return [...headwords];
    }

    function adoptStatuses(asked, reply, refresh) {
      // Only a refresh reads every status shown, so only a refresh says which
      // revision the marks show. A read of new headwords alone can be answered
      // at a revision whose change signal is still on its way, and that signal
      // must still re-read the rest.
      if (refresh) {
        statuses.clear();
        statusesEpoch = statusEpoch;
        statusRevision = reply.revision;
        repaintAll();
      }
      available = Array.isArray(reply.statuses);
      if (available) asked.forEach((headword, index) => statuses.set(headword, reply.statuses[index]));
    }

    async function requestStatuses() {
      if (statusing || retryTimer !== null) return;
      const refresh = statusesEpoch !== statusEpoch;
      if (!refresh && available !== true) return;
      const asked = headwordsToAsk(refresh);
      // A refresh with nothing segmented yet still learns whether the index
      // can answer, before any text is segmented.
      if (asked.length === 0 && !refresh) return;
      const token = session;
      const epoch = statusEpoch;
      statusing = true;
      let reply;
      try {
        reply = await send("hd_anki_word_status", { request: { headwords: asked } }, ANKI_TARGET);
      } catch {
        if (token === session) {
          statusing = false;
          retryLater();
        }
        return;
      }
      if (token !== session) return;
      statusing = false;
      failures = 0;
      // A newer change signal makes this answer stale, and the words are asked again.
      if (epoch === statusEpoch) adoptStatuses(asked, reply, refresh);
      schedule();
    }

    function refreshBlock(block) {
      if (block.dirty) rebuild(block);
      if (block.recheck) recheck(block);
      for (const run of block.runs) {
        if (!run.wanted) continue;
        if (run.text === null) build(run);
        if (run.stale) paint(run);
      }
    }

    function pump() {
      scheduled = false;
      if (!running) return;
      for (const block of visible) refreshBlock(block);
      // A frame with no Japanese text near its viewport, such as most
      // advertising frames, sends nothing and builds no popup host.
      if (visible.size === 0) return;
      if (!preparing) void prepareColors();
      void requestStatuses();
      void requestSegments();
    }

    // The marks wait for the popup host, whose palette colours them.
    async function prepareColors() {
      preparing = true;
      const token = session;
      try {
        await prepare();
      } catch {
        // Without the popup host the marks take the default palette's colours.
      }
      if (token !== session) return;
      ready = true;
      // Added after the popup's own listener, which applies an automatic palette first.
      colorScheme.addEventListener("change", refreshColors);
      refreshColors();
      register();
    }

    // ------------------------------------------------------------ lifecycle

    function start(next) {
      options = next;
      if (running) return;
      running = true;
      session += 1;
      segmentEpoch += 1;
      statusEpoch += 1;
      intersections = new window.IntersectionObserver(onIntersection, { rootMargin: "100%" });
      mutations = new window.MutationObserver(onMutations);
      mutations.observe(document, { childList: true, subtree: true, characterData: true });
      if (document.body) for (const element of textBlocks(document.body)) track(element);
      window.addEventListener("scroll", onViewportChange, { capture: true, passive: true });
      window.addEventListener("resize", onViewportChange, { passive: true });
      schedule();
    }

    function stop() {
      if (!running) return;
      running = false;
      ready = false;
      preparing = false;
      session += 1;
      segmentEpoch += 1;
      intersections.disconnect();
      mutations.disconnect();
      window.removeEventListener("scroll", onViewportChange, { capture: true });
      window.removeEventListener("resize", onViewportChange);
      colorScheme.removeEventListener("change", refreshColors);
      window.clearTimeout(recheckTimer);
      window.clearTimeout(retryTimer);
      recheckTimer = null;
      retryTimer = null;
      failures = 0;
      for (const status of STATUSES) {
        if (window.CSS.highlights.get(HIGHLIGHT_NAMES[status]) === highlights[status]) {
          window.CSS.highlights.delete(HIGHLIGHT_NAMES[status]);
        }
        highlights[status].clear();
      }
      if (sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter(value => value !== sheet);
      blocks.clear();
      visible.clear();
      segments.clear();
      statuses.clear();
      generation = null;
      segmenting = false;
      statusing = false;
      statusesEpoch = -1;
      statusRevision = null;
      available = null;
    }

    // The dictionaries changed: segment the shown text again, each run
    // keeping its marks until its new segmentation arrives.
    function invalidate() {
      if (!running) return;
      segmentEpoch += 1;
      segmenting = false;
      segments.clear();
      generation = null;
      repaintAll();
      schedule();
    }

    function update(next) {
      const previous = options;
      options = next;
      if (!running) return;
      if (next.scanLength !== previous.scanLength || next.frequencyDictionary !== previous.frequencyDictionary
          || next.frequencyOrder !== previous.frequencyOrder
          || next.personalDictionaryEnabled !== previous.personalDictionaryEnabled) invalidate();
      if (next.wordHighlightStyle !== previous.wordHighlightStyle || next.popupTheme !== previous.popupTheme) refreshColors();
      register();
    }

    // The worker's change signal. A revision this frame has already read needs
    // nothing; null says the evidence itself changed.
    function statusChanged(revision) {
      if (!running) return;
      if (revision !== null && revision === statusRevision && statusesEpoch === statusEpoch && available === true) return;
      statusEpoch += 1;
      schedule();
    }

    // A screenshot of the page for a note leaves the marks out.
    function suspend() {
      suspended += 1;
      register();
      let restored = false;
      return () => {
        if (restored) return;
        restored = true;
        suspended -= 1;
        register();
      };
    }

    // Mark as known or Ignore changed a word: the marks shown are worked out
    // again from the statuses already read.
    function setOverrides(next) {
      overrides = next;
      if (!running) return;
      repaintAll();
      schedule();
    }

    return { start, stop, update, invalidate, statusChanged, refreshColors, suspend, setOverrides,
      get running() { return running; } };
  }

  // Mark as known and Ignore: two toggle buttons in each entry's action row,
  // after its Anki and pronunciation buttons, and the keybinds that act on
  // the current entry. A press asks the worker to set the entry's headword to
  // that status, or to clear it when it already has it; the stored record,
  // which every tab receives, then presses the buttons and re-marks the page.
  // The buttons show only while word highlighting is on, and only in a
  // renderer that styles them; the keybinds work in every renderer.
  // The prohibited sign rather than a crossed-out eye: in software raster that
  // eye's mask added about 1.5 ms to the slowest hovers (benchmark/word-highlights.mjs).
  const WORD_STATUS_ICONS = { known: "checkmark", ignored: "prohibited" };
  const WORD_STATUS_ANCHORS = ":scope > :is(.gsm-hoshidicts-popup-close, .gsm-hoshidicts-kanji-back, "
    + ".gsm-hoshidicts-mine-button, .gsm-hoshidicts-audio-control)";

  // A button's name for its word. A failed save stays in it until the button
  // is pressed again.
  function labelWordStatusButton(button, headword) {
    const action = button.dataset.wordStatus === "known" ? `Mark ${headword} as known` : `Ignore ${headword}`;
    const text = button.dataset.error ? `${action}. Could not save: ${button.dataset.error}` : action;
    button.title = text;
    button.setAttribute("aria-label", text);
  }

  function createWordStatusActions({ send }) {
    // Each popup level's bound entries, and the buttons in each entry's row.
    const owners = new Map();
    const rows = new Map();
    let enabled = false;
    let overrides = new Map();

    const headwordOf = item => item.result.term.expression;

    function sync(row) {
      const headword = headwordOf(row.item);
      for (const button of row.buttons) {
        labelWordStatusButton(button, headword);
        button.setAttribute("aria-pressed", String(overrides.get(headword) === button.dataset.wordStatus));
      }
    }

    async function change(item, status) {
      const headword = headwordOf(item);
      const button = rows.get(item.actions)?.buttons.find(candidate => candidate.dataset.wordStatus === status);
      if (button) {
        delete button.dataset.error;
        labelWordStatusButton(button, headword);
        button.setAttribute("aria-busy", "true");
      }
      try {
        await send("hd_word_status_override", { headword, status: overrides.get(headword) === status ? null : status });
      } catch (error) {
        if (button) {
          button.dataset.error = error.message;
          labelWordStatusButton(button, headword);
        }
      } finally {
        button?.removeAttribute("aria-busy");
      }
    }

    function createButton(document, item, status) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gsm-hoshidicts-word-status-button";
      button.dataset.wordStatus = status;
      const icon = document.createElement("span");
      icon.className = "hd-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.dataset.icon = WORD_STATUS_ICONS[status];
      button.append(icon);
      button.addEventListener("click", () => {
        const row = rows.get(item.actions);
        if (button.getAttribute("aria-busy") !== "true" && row) void change(row.item, status);
      });
      return button;
    }

    function removeRow(actions) {
      for (const button of rows.get(actions)?.buttons ?? []) button.remove();
      rows.delete(actions);
    }

    function render(group) {
      const shown = new Set(enabled && group.context.buttons !== false ? group.items.map(item => item.actions) : []);
      for (const [actions, row] of rows) {
        if (row.owner === group.context.owner && !shown.has(actions)) removeRow(actions);
      }
      for (const item of group.items) {
        if (!shown.has(item.actions)) continue;
        let row = rows.get(item.actions);
        if (!row) {
          const buttons = ["known", "ignored"].map(status => createButton(item.actions.ownerDocument, item, status));
          const anchor = [...item.actions.querySelectorAll(WORD_STATUS_ANCHORS)].at(-1);
          if (anchor) anchor.after(...buttons);
          else item.actions.prepend(...buttons);
          row = { buttons };
          rows.set(item.actions, row);
        }
        Object.assign(row, { item, owner: group.context.owner });
        sync(row);
      }
    }

    return {
      // `items` are a render's { actions, result } mining bindings; `context`
      // is { owner, isCurrent, buttons }.
      bind(items, context) {
        const group = { items, context };
        owners.set(context.owner, group);
        render(group);
      },
      // One popup level's rows, or every row without an owner.
      retire(owner) {
        for (const [actions, row] of rows) {
          if (owner === undefined || row.owner === owner) removeRow(actions);
        }
        if (owner === undefined) owners.clear();
        else owners.delete(owner);
      },
      update(options) {
        enabled = options.wordHighlightEnabled === true;
        for (const group of owners.values()) render(group);
      },
      setOverrides(next) {
        overrides = next;
        for (const row of rows.values()) sync(row);
      },
      // A keybind: the entry at `index` of `owner`'s current results.
      press(owner, index, status) {
        const group = owners.get(owner);
        const item = group?.items[index];
        if (!enabled || !item || group.context.isCurrent?.() === false) return false;
        void change(item, status);
        return true;
      },
    };
  }

  globalThis.HDWordHighlights = { createWordHighlighter, createWordStatusActions };
}());
