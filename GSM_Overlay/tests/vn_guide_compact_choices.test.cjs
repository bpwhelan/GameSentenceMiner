const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findChoice, normalizeChoice, GuideTracker, validateRoute } = require('../vn_guide');
const { GuideLibrary } = require('../vn_guide_library');
const { createVnGuideController } = require('../vn_guide_controller');
const fixture = require('./fixtures/muv-luv-numbered-choices-oneocr.json');

const expected = 'ってそうじゃなくて！';
const corrected = ['１．満漢全席１人前プリーズ！', `２．${expected}`];
const line = (text, y, x = .4, width = .2) => ({ text, bounding_rect: { x1: x, y1: y, x3: x + width, y3: y + .03 } });
const frame = (data, lineId = 'choice') => ({ type: 'word_coordinates', data, is_final: true, line_id: lineId, presence_id: lineId });

function screenshotLines(correctText = false, x = 0, y = 0) {
  const normalize = rect => Object.fromEntries(Object.entries(rect).map(([key, value]) => (
    [key, key.startsWith('x') ? value / fixture.imageWidth + x : value / fixture.imageHeight + y]
  )));
  return fixture.lines.map((line, index) => ({
    ...line,
    // The backend log records these corrections before sending the two boxes.
    text: correctText ? corrected[index] : line.text,
    bounding_rect: normalize(line.bounding_rect),
    words: line.words.map(word => ({ ...word, bounding_rect: normalize(word.bounding_rect) })),
  }));
}

function unnumberedScreenshotLines(correctText = false, x = 0, y = 0) {
  return screenshotLines(correctText, x, y).map(line => ({
    ...line,
    text: line.text.normalize('NFKC').replace(/^\d\.\s*/u, ''),
    words: line.words.slice(1).map(word => ({
      ...word, text: correctText ? word.text.replace('つ', 'っ') : word.text,
    })),
  }));
}

test('Muv-Luv screenshot choices form a menu despite tight spacing, paragraph grouping and an OCR error', () => {
  for (const correctText of [false, true]) {
    for (const [x, y] of [[0, 0], [-.25, -.5], [.2, -.5]]) {
      const data = screenshotLines(correctText, x, y);
      const original = structuredClone(data);
      const match = findChoice(data, expected);
      assert.ok(match, `corrected=${correctText}, offset=${x},${y}`);
      assert.equal(match.menu, true);
      assert.equal(match.exact, correctText);
      assert.ok(match.options.includes(normalizeChoice(corrected[0])));
      assert.deepEqual(data, original, 'detection must preserve OCR text and geometry');
    }
  }
});

test('consecutive numbered choices support short answers, left alignment and full-width labels', () => {
  for (const [first, second] of [['1. はい', '2. いいえ'], ['１．はい', '２．いいえ'], ['1)はい', '2)いいえ']]) {
    const data = [line(first, .86, .08, .1), line(second, .89, .08, .2)];
    for (const expected of ['はい', 'いいえ']) {
      assert.equal(findChoice(data, expected)?.menu, true);
    }
  }
});

test('the same tightly stacked screenshot works without numbers, including fuzzy OCR and off-center menus', () => {
  for (const correctText of [false, true]) {
    for (const [x, y] of [[0, 0], [-.25, -.5], [.2, -.5]]) {
      const data = unnumberedScreenshotLines(correctText, x, y);
      const match = findChoice(data, expected);
      assert.equal(match?.menu, true, `corrected=${correctText}, offset=${x},${y}`);
      assert.equal(match.exact, correctText);
      assert.ok(match.options.includes(normalizeChoice(corrected[0])));
    }
  }
});

test('tightly stacked unnumbered short choices work with left or center alignment and equal widths', () => {
  for (const data of [
    [line('はい', .86, .08, .06), line('いいえ', .89, .08, .09)],
    [line('はい', .86, .485, .06), line('いいえ', .89, .47, .09)],
    [line('はい', .86, .08, .06), line('いや', .89, .08, .06)],
  ]) {
    for (const choice of data) assert.equal(findChoice(data, choice.text)?.menu, true);
  }
});

test('lookup paragraph grouping alone cannot veto a whole-row guide match', () => {
  // These layouts used to be rejected solely for their small inter-row gap.
  // Without labels or extra context, they also describe valid unnumbered menus.
  for (const [expected, observed] of [['大丈夫', '大丈夫'], ['わたしは首を横に振る', 'わたしは首を横に振ろ']]) {
    assert.equal(findChoice([line(observed, .86), line('ほかの選択肢', .9)], expected)?.menu, true);
  }
});

test('compact unnumbered menus still reject substrings, ambiguous choices, unrelated columns, and overlapping rows', () => {
  for (const data of [
    [line('「ってそうじゃなくて」と言った', .86), line('そのまま話を続けた', .9)],
    [line(expected, .86), line(expected, .9)],
    [line('つてそうじゃなくて', .86), line('ってそうじゃなぐて', .9)],
    [line(expected, .86, .08), line('別の列の文字', .9, .65)],
    [line(expected, .86), line('同じ行の文字', .86)],
    [line(expected, .86), line('SAVE', .9)],
  ]) assert.equal(findChoice(data, expected, { requireMenu: true }), null);
  assert.equal(findChoice([line('大丈犬', .86), line('やめる', .9)], '大丈夫'), null);
});

test('unnumbered screenshot choices open, advance once and catch up using OCR alone', () => {
  const steps = validateRoute(['最初の選択肢', expected, '次の選択肢'].map(simpleJp => ({ simpleJp })));
  const guide = new GuideTracker(steps, 1);
  guide.observe(frame(unnumberedScreenshotLines()), 1000);
  assert.equal(guide.detected, true);
  assert.equal(guide.armed.stable, true);
  guide.observe(frame(unnumberedScreenshotLines()), 2000);
  assert.equal(guide.index, 1);
  guide.observe(frame([line('次の会話が始まった', .86)], 'dialogue'), 2200);
  assert.equal(guide.index, 2);
  guide.observe(frame([line('会話が続く', .86)], 'dialogue-2'), 3000);
  assert.equal(guide.index, 2);
  guide.back();
  assert.equal(guide.index, 1);

  const behind = new GuideTracker(steps);
  behind.observe(frame(unnumberedScreenshotLines(true)), 1000);
  assert.equal(behind.index, 1);
  assert.equal(behind.detected, true);
  assert.equal(behind.recoveredFrom, 0);
});

test('embedded dialogue and inconsistent numeric labels cannot establish a menu', () => {
  for (const data of [
    [line('ってそうじゃなくてと言った', .86), line('そのまま話を続けた', .9)],
    [line('つてそうじゃなくてと言った', .86), line('そのまま話を続けた', .9)],
    [line(`1. ${expected}`, .86), line('続きの台詞', .9)],
    [line(`1. ${expected}`, .86), line('1. 同じ番号', .9)],
    [line(`2. ${expected}`, .86), line('1. 逆順の番号', .9)],
    [line(`1. ${expected}`, .86), line('3. 飛ばした番号', .9)],
    [line(`1. ${expected}`, .86, .08), line('2. 別の列', .9, .65)],
    [line(`1. ${expected}`, .86), line('2. 重なった行', .86)],
  ]) assert.equal(findChoice(data, expected, { requireMenu: true }), null);
  assert.equal(findChoice([line('1.5メートル進む', .86), line('2.5メートル戻る', .9)], '5メートル進む', { requireMenu: true }), null);
});

test('numbered screenshot detection arms once, advances on fresh dialogue and supports undo and catch-up', () => {
  const steps = validateRoute(['最初の選択肢', expected, '次の選択肢'].map(simpleJp => ({ simpleJp })));
  const guide = new GuideTracker(steps, 1);
  guide.observe({ type: 'game_text', text: corrected.join('') }, 1000);
  guide.observe({ type: 'overlay_clear', line_id: 'choice' }, 1100);
  guide.observe(frame(screenshotLines(true)), 1200);
  assert.equal(guide.detected, true);
  assert.equal(guide.armed.menu, true);
  assert.equal(guide.armed.stable, true);
  guide.observe(frame(screenshotLines(true)), 2000);
  assert.equal(guide.index, 1);
  guide.observe({ type: 'overlay_clear', line_id: 'dialogue' }, 2100);
  guide.observe(frame([line('次の会話が始まった', .86)], 'dialogue'), 2200);
  assert.equal(guide.index, 2);
  guide.observe(frame([line('会話が続く', .86)], 'dialogue-2'), 3000);
  assert.equal(guide.index, 2);
  guide.back();
  assert.equal(guide.index, 1);

  const behind = new GuideTracker(steps);
  behind.observe(frame(screenshotLines(true)), 1000);
  assert.equal(behind.index, 1);
  assert.equal(behind.detected, true);
  assert.equal(behind.recoveredFrom, 0);
});

for (const [label, getLines] of [['numbered', screenshotLines], ['unnumbered', unnumberedScreenshotLines]]) {
test(`the ${label} screenshot opens the automatic guide and persists progress after the menu leaves`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-vn-numbered-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const url = 'https://kanjieater.github.io/VN-Guide/test-game/';
  const library = new GuideLibrary(directory, { fetchJson: async source => source.endsWith('/guide.json')
    ? { title: 'Test Game', routes: [{ id: 'one', title: 'Route One' }] }
    : ['最初の選択肢', expected, '次の選択肢'].map(simpleJp => ({ simpleJp })) });
  let now = 1000;
  const updates = [];
  const controller = createVnGuideController({ library, hud: { update: state => updates.push(state), dispose() {} }, now: () => now });
  t.after(() => controller.dispose());
  await controller.configure({ vnGuideEnabled: true, vnGuideUrl: url, vnGuideMode: 'auto', vnGuideAutoAdvance: true });
  controller.setAvailable(true);
  controller.command('jump', 1);
  controller.command('hide');
  controller.observe({ type: 'overlay_clear', line_id: 'choice' });
  controller.observe(frame(getLines(true)));
  assert.equal(controller.snapshot().detected, true);
  assert.equal(controller.snapshot().visible, true);
  assert.equal(updates.at(-1).text, expected);
  now += 200;
  controller.observe({ type: 'overlay_clear', line_id: 'dialogue' });
  controller.observe(frame([line('次の会話が始まった', .86)], 'dialogue'));
  assert.equal(controller.snapshot().index, 2);
  assert.equal(controller.snapshot().loggedChoice, expected);
  assert.equal(library.progress['test-game/one'].index, 2);
});
}
