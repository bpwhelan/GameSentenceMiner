// Offline, deterministic block-history comparison; no OCR or network requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const root = path.resolve(__dirname, '..');
const reference = execFileSync('git', ['rev-parse', process.argv[2] || 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

function load(source) {
  const context = { module: { exports: {} } };
  vm.runInNewContext(source, context);
  return context.module.exports;
}
const before = load(execFileSync('git', ['show', `${reference}:GSM_Overlay/block_detection.js`], { cwd: root, encoding: 'utf8' }));
const after = load(fs.readFileSync(path.join(root, 'GSM_Overlay/block_detection.js'), 'utf8'));
const serialize = value => JSON.stringify(value, (_key, item) => item && typeof item.entries === 'function' && !Array.isArray(item) ? [...item.entries()] : item);
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];

let seed = 95317;
const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
const alphabet = Array.from('日本語の台詞を処理します漢字カタカナＡＢＣ１２３。！𠮷');
function makeLine() {
  return { text: Array.from({ length: 20 + random(50) }, () => alphabet[random(alphabet.length)]).join(''), bounding_rect: { x1: 0.05, y1: 0.1, x3: 0.9, y3: 0.15 } };
}
const scenarios = [3, 10, 24].map(count => {
  const frames = [];
  let current = [];
  for (let i = 0; i < 30; i++) {
    if (current.length >= count) current = current.slice(1);
    current = [...current, makeLine()];
    frames.push(current.map((line, index) => ({ ...line, bounding_rect: { ...line.bounding_rect, y1: 0.03 + index * 0.035, y3: 0.063 + index * 0.035 } })));
  }
  return { count, frames };
});
let comparisons = 0;
function replay(api, frames, verify) {
  const history = api.createRecentBlockHistory();
  return frames.map((lines, index) => {
    const result = api.detectTextBlocks(lines, undefined, history, { resultKey: `${Math.floor(index / 2)}`, latestText: lines.at(-1).text });
    if (verify) return serialize({ result, history: history.getRawTexts() });
    return null;
  });
}
const metrics = [];
for (const { count, frames } of scenarios) {
  assert.deepEqual(replay(after, frames, true), replay(before, frames, true));
  comparisons += frames.length;
  const timings = [[], []];
  for (let repeat = 0; repeat < 9; repeat++) {
    for (const index of (repeat % 2 ? [0, 1] : [1, 0])) {
      const start = performance.now();
      replay([before, after][index], frames, false);
      timings[index].push((performance.now() - start) / frames.length);
    }
  }
  metrics.push({ lines: count, beforeMs: median(timings[0]), afterMs: median(timings[1]), speedup: median(timings[0]) / median(timings[1]) });
}
console.log(JSON.stringify({ reference, comparisons, metrics }, null, 2));
