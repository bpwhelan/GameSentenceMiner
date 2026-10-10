const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGuideUrl, validateGuide, validateRoute, stepKind, findChoice, GuideTracker } = require('../vn_guide');

const line = (text, y, x = 0.4, width = 0.2) => ({ text, bounding_rect: { x1: x, y1: y, x3: x + width, y3: y + 0.03 } });
const menu = (text = '大丈夫') => [line(text, 0.3), line('やめておこう', 0.43)];
const frame = (data, extra = {}) => ({ type: 'word_coordinates', data, is_final: true, ...extra });

test('accepts official page, GitHub and raw guide URLs, including Japanese slugs and navigation fragments', () => {
  const parsed = parseGuideUrl('https://kanjieater.github.io/VN-Guide/凍京necroトウキョウネクロ/#view=guide&route=main&step=4');
  assert.equal(parsed.slug, '凍京necroトウキョウネクロ');
  assert.equal(parsed.routeId, 'main');
  assert.equal(parsed.step, 4);
  for (const url of ['https://github.com/kanjieater/VN-Guide/tree/main/yuno', 'https://raw.githubusercontent.com/kanjieater/VN-Guide/main/yuno/guide.json']) {
    assert.equal(parseGuideUrl(url).slug, 'yuno');
  }
  for (const url of ['https://evil.test/yuno', 'file:///yuno', 'https://kanjieater.github.io/VN-Guide/', 'https://kanjieater.github.io/VN-Guide/yuno/extra/file', 'https://user:pass@kanjieater.github.io/VN-Guide/yuno/', 'https://kanjieater.github.io/VN-Guide/%2e%2e%2fyuno/']) {
    assert.throws(() => parseGuideUrl(url));
  }
});

test('validates the upstream manifest and step array without silently dropping steps', () => {
  const guide = validateGuide({ title: 'Example', routes: [{ id: 'route_1', title: 'Route', reviewed: true }] });
  assert.equal(guide.routes[0].reviewed, true);
  assert.throws(() => validateGuide({ routes: [{ id: '../bad', title: 'Bad' }] }));
  assert.throws(() => validateGuide({ title: 'Example', routes: [{ id: 'a', title: 'A' }, { id: 'a', title: 'A' }] }));
  assert.throws(() => validateRoute([{ simpleJp: 'はい' }, {}]));
  assert.throws(() => validateRoute([]));
  assert.equal(validateRoute([{ simpleJp: 'セーブ1にロード', isLoad: true }])[0].kind, 'load');
  assert.equal(stepKind({ simpleJp: 'セーブ２' }), 'save');
  assert.equal(stepKind({ simpleJp: 'セーブ2からロード' }), 'load');
  assert.equal(stepKind({ simpleJp: 'SAVE 3' }), 'save');
  assert.equal(stepKind({ simpleJp: '大丈夫', badEndPath: 'BAD END' }), 'choice');
  assert.equal(stepKind({ simpleJp: 'タイトル画面から始める' }), 'choice');
});

test('only accepts exact, isolated text with credible choice geometry', () => {
  assert.ok(findChoice(menu(), '大丈夫'));
  assert.ok(findChoice(menu('１．　大丈夫'), '大丈夫'));
  assert.equal(findChoice([line('本当に大丈夫なの？', 0.3), line('やめておこう', 0.43)], '大丈夫'), null);
  assert.equal(findChoice([line('「大丈夫」', 0.3), line('やめておこう', 0.43)], '大丈夫'), null);
  assert.equal(findChoice([line('大丈夫', 0.3)], '大丈夫'), null);
  assert.equal(findChoice([line('大丈夫', 0.8), line('そう言って彼女は笑った。', 0.84)], '大丈夫'), null);
  assert.equal(findChoice([line('大丈夫', 0.3), line('続きの台詞', 0.338)], '大丈夫'), null);
  assert.equal(findChoice([line('大丈夫', 0.3), line('別の文字', 0.43, 0.02)], '大丈夫'), null);
  assert.equal(findChoice([{ text: '大丈夫' }, { text: 'やめておこう' }], '大丈夫'), null);
});

function tracker(steps = ['大丈夫', 'セーブ1', '進む']) {
  return new GuideTracker(validateRoute(steps.map(simpleJp => ({ simpleJp }))));
}

test('choice disappearance advances one step tentatively and save/load always wait for Done', () => {
  const guide = tracker();
  guide.observe(frame(menu()), 1000);
  assert.equal(guide.detected, true);
  guide.observe(frame(menu()), 2000);
  assert.equal(guide.index, 0);
  guide.observe(frame([line('次の会話が始まった。', 0.8)]), 3000);
  assert.equal(guide.index, 1);
  assert.equal(guide.tentative, true);
  guide.observe(frame([line('セーブ1', 0.3), line('ロード', 0.43)]), 5000);
  assert.equal(guide.index, 1);
  guide.next();
  assert.equal(guide.index, 2);
  guide.back();
  assert.equal(guide.index, 1);
});

test('dialogue, empty/cleared/supplemental/stale frames and disappearing just one option cannot advance', () => {
  const guide = tracker();
  guide.observe('大丈夫', 1000);
  assert.equal(guide.detected, false);
  guide.observe(frame(menu(), { presence_id: 'menu' }), 2000);
  for (const payload of [frame([]), { type: 'overlay_clear' }, { type: 'ocr_text_invalidated' }, frame([line('次の会話', 0.8)], { supplemental: true }), frame([line('次の会話', 0.8)], { presence_id: 'menu' }), frame([line('やめておこう', 0.43)])]) {
    guide.observe(payload, 4000);
    assert.equal(guide.index, 0);
  }
});

test('manual-only advance, reconnect reset, undo, jumps, repeated choices and completion stay controllable', () => {
  const guide = tracker(['大丈夫', '大丈夫']);
  guide.observe(frame(menu()), 1000);
  guide.observe(frame([line('次の会話', 0.8)]), 3000, false);
  assert.equal(guide.index, 0);
  guide.resetDetection();
  guide.observe(frame([line('次の会話', 0.8)]), 4000);
  assert.equal(guide.index, 0);
  guide.next();
  guide.observe(frame([line('次の会話', 0.8)]), 5000);
  assert.equal(guide.index, 1);
  guide.next();
  assert.equal(guide.complete, true);
  guide.back();
  assert.equal(guide.index, 1);
  assert.equal(guide.complete, false);
  guide.jump(0);
  assert.equal(guide.index, 0);
  assert.throws(() => guide.jump(-1));
  assert.throws(() => guide.jump(NaN));
  assert.throws(() => guide.jump(3));
});

test('advancing manually while a menu is still open cannot consume the next identical choice', () => {
  const guide = tracker(['大丈夫', '大丈夫', '進む']);
  guide.observe(frame(menu()), 1000);
  guide.next();
  guide.observe(frame(menu()), 2000);
  guide.observe(frame([line('次の会話', .8)]), 4000);
  assert.equal(guide.index, 1);
  guide.observe(frame(menu()), 5000);
  guide.observe(frame([line('別の会話', .8)]), 7000);
  assert.equal(guide.index, 2);
});

test('presence invalidation can hide the hint but only fresh final text can advance', () => {
  const guide = tracker();
  guide.observe(frame(menu(), { presence_id: 'choice' }), 1000);
  guide.observe({ type: 'ocr_text_invalidated', presence_id: 'choice' }, 3000);
  assert.equal(guide.index, 0);
  assert.equal(guide.detected, false);
  guide.observe(frame([line('新しい会話', .8)], { presence_id: 'dialogue' }), 4000);
  assert.equal(guide.index, 1);
});
