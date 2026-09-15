const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { detectTextBlocks } = require('../block_detection');
const { JitenParseCache } = require('../jiten_cache');

const highlighterSource = fs.readFileSync(path.join(__dirname, '../jiten_highlight.js'), 'utf8');
const readerSource = fs.readFileSync(path.join(__dirname, '../jiten.reader/js/ajb.js'), 'utf8');
function readerClass(name) {
  const start = readerSource.indexOf(`class ${name} `);
  assert.ok(start >= 0);
  return readerSource.slice(start, readerSource.indexOf('\n/***/ }),', start));
}

function setup(t, lines) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  let now = 10000;
  let nextId = 0;
  let parses = 0;
  const timers = new Map();
  window.Date.now = () => now;
  window.setTimeout = (fn, delay) => {
    const id = ++nextId;
    timers.set(id, { fn, at: now + delay });
    return id;
  };
  window.clearTimeout = id => timers.delete(id);
  window.console.log = () => {};
  window.addEventListener('keydown', () => parses++);
  const tick = duration => {
    const end = now + duration;
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].fn();
    }
    now = end;
  };
  // Exercise the shipped Reader's actual paragraph extraction, including its
  // block-element boundaries and fragment concatenation.
  window.eval(`${readerClass('BaseParagraphReader')}
    const _base_paragraph_reader__WEBPACK_IMPORTED_MODULE_0__ = { BaseParagraphReader };
    ${readerClass('ParagraphReader')}
    window.readParagraphs = node => new ParagraphReader(node).read()
      .map(fragments => fragments.map(fragment => fragment.node.data).join(''));`);
  window.eval(highlighterSource);
  lines.forEach((line, lineIndex) => {
    const block = document.createElement('p');
    block.className = 'text-block-container';
    // The renderer emits a box per visible code point, while Reader offsets
    // include whitespace and count UTF-16 code units.
    [...line.text].filter(char => !/\s/u.test(char)).forEach((char, index) => {
      const box = document.createElement('span');
      box.className = 'text-box';
      box.dataset.lineIndex = String(lineIndex);
      box.textContent = char;
      box.getBoundingClientRect = () => ({
        left: index * 10, right: index * 10 + 10,
        top: lineIndex * 30, bottom: lineIndex * 30 + 20, width: 10, height: 20,
      });
      block.appendChild(box);
    });
    document.body.appendChild(block);
  });
  return {
    api: window.GsmJitenHighlight, document, tick, parses: () => parses,
    paragraphs: () => Array.from(document.querySelector('#jiten-parse-container').children),
    readerTexts: () => Array.from(window.readParagraphs(document.querySelector('#jiten-parse-container'))),
    complete: async () => {
      await Promise.resolve(); // Deliver the Reader span mutations.
      tick(200);
    },
    highlights: () => Array.from(document.querySelectorAll('.gsm-jiten-hl'))
      .filter(el => el.style.display !== 'none')
      .map(el => [el.style.left, el.style.top, el.style.width, el.style.height]),
  };
}

const line = (text, y, x = 0.1, width = 0.6) => ({
  text, bounding_rect: { x1: x, y1: y, x3: x + width, y3: y + 0.04 },
});

test('detected multiline blocks reuse exact cached TextFeed paragraphs', async t => {
  const lines = [line('猫は図書', 0.6), line('設定', 0.02, 0.8, 0.1), line('館にいる。', 0.66)];
  const { lineBlocks } = detectTextBlocks(lines);
  assert.equal(lineBlocks.get(0), lineBlocks.get(2));
  assert.notEqual(lineBlocks.get(0), lineBlocks.get(1));
  const { api, tick, readerTexts } = setup(t, lines);
  const calls = [];
  const cache = new JitenParseCache({
    batchDelayMs: 0, minIntervalMs: 0, parseIntervalMs: 0,
    fetch: async (_url, init) => {
      const { text } = JSON.parse(init.body);
      calls.push(text);
      return Response.json({ tokens: text.map(() => []), vocabulary: [] });
    },
  });
  t.after(() => cache.dispose());
  const texts = ['猫は図書館にいる。', '設定'];
  await cache.parseMany({ apiKey: 'offline-test', texts });
  api.requestParse(lines, lineBlocks);
  tick(0);
  await cache.parseMany({ apiKey: 'offline-test', texts: readerTexts() });
  assert.deepEqual(calls, [texts], 'the overlay must not request individual OCR lines');
  assert.deepEqual(readerTexts(), texts);
  assert.equal(cache.getStats().cacheHits, 2);
});

test('blocks retain punctuation, Latin text, whitespace and original line order', t => {
  const lines = ['「', 'English ', '猫　𠮷', '」', 'Settings'].map(text => ({ text }));
  const { api, tick, readerTexts } = setup(t, lines);
  api.requestParse(lines, new Map([[0, 0], [1, 0], [2, 0], [3, 0], [4, 1]]));
  tick(0);
  assert.deepEqual(readerTexts(), ['「English 猫　𠮷」']);
});

test('a Reader token crossing OCR lines highlights and navigates both parts', async t => {
  const lines = [{ text: '猫は図書' }, { text: '館にいる。' }];
  const { api, tick, paragraphs, complete, highlights } = setup(t, lines);
  api.requestParse(lines, new Map([[0, 7], [1, 7]]));
  tick(0);
  paragraphs()[0].innerHTML = '猫は<span class="jiten-word new" wordId="42" readingIndex="0"><ruby>図書館<rt>としょかん</rt></ruby></span>にいる。';
  await complete();
  assert.deepEqual(highlights(), [['20px', '0px', '20px', '20px'], ['0px', '30px', '10px', '20px']]);
  const tokens = JSON.parse(JSON.stringify(api.getNavigationTokens()));
  assert.deepEqual(tokens.map(({ lineIndex, text, start, end }) => ({ lineIndex, text, start, end })), [
    { lineIndex: 0, text: '猫は図書', start: 2, end: 4 },
    { lineIndex: 1, text: '館にいる。', start: 0, end: 1 },
  ]);
  api.applyCardState(42, 0, ['mature']);
  assert.deepEqual(highlights(), []);
  assert.ok(api.getNavigationTokens().every(token => token.states.includes('mature') && !token.highlighted));
});

test('highlight offsets include whitespace and supplementary characters', async t => {
  const lines = [{ text: '𠮷 は猫' }];
  const { api, tick, paragraphs, complete, highlights } = setup(t, lines);
  api.requestParse(lines);
  tick(0);
  paragraphs()[0].innerHTML = '<span class="jiten-word mature"><ruby>𠮷<rt>よし</rt></ruby></span> は<span class="jiten-word new">猫</span>';
  await complete();
  assert.deepEqual(highlights(), [['20px', '0px', '10px', '20px']]);
  assert.deepEqual(Array.from(api.getNavigationTokens(), token => [token.start, token.end]), [[0, 2], [4, 5]]);
});

test('grouping changes reparse unchanged lines and refresh keeps the detected blocks', async t => {
  const lines = [{ text: '図書' }, { text: '館' }];
  const { api, tick, parses, paragraphs, readerTexts, complete } = setup(t, lines);
  api.requestParse(lines, new Map([[0, 0], [1, 1]]));
  tick(0);
  paragraphs().forEach(p => { p.innerHTML = `<span class="jiten-word new">${p.textContent}</span>`; });
  await complete();
  api.requestParse(lines, new Map([[0, 0], [1, 0]]));
  tick(0);
  assert.equal(parses(), 2);
  assert.deepEqual(readerTexts(), ['図書館']);
  paragraphs()[0].innerHTML = '<span class="jiten-word new">図書館</span>';
  await complete();
  api.requestParse(lines, new Map([[0, 8], [1, 8]]));
  tick(0);
  assert.equal(parses(), 2, 'renumbering an otherwise identical block needs no parse');
  api.refresh();
  tick(0);
  assert.equal(parses(), 3);
  assert.deepEqual(readerTexts(), ['図書館']);
});

test('a queued frame keeps its grouping without replacing the active Reader DOM', async t => {
  const lines = [{ text: '図書' }, { text: '館' }];
  const { api, tick, parses, paragraphs, readerTexts, complete } = setup(t, lines);
  api.requestParse(lines, new Map([[0, 0], [1, 0]]));
  tick(0);
  const activeParagraph = paragraphs()[0];
  api.requestParse(lines, new Map([[0, 0], [1, 1]]));
  tick(0);
  assert.equal(parses(), 1);
  assert.equal(paragraphs()[0], activeParagraph);
  assert.deepEqual(Array.from(api.getNavigationTokens()), []);
  activeParagraph.innerHTML = '<span class="jiten-word new">図書館</span>';
  await complete();
  assert.equal(parses(), 2);
  assert.deepEqual(readerTexts(), ['図書', '館']);
});
