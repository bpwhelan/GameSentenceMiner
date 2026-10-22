const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGuideUrl, validateGuide, validateRoute, stepKind, normalizeChoice, findChoice, GuideTracker } = require('../vn_guide');

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

test('choice comparisons remove punctuation and symbols while preserving letters, marks, and numbers', () => {
  for (const text of ['意識が―もう――', '「意識が——もう…」', '意識が──もう−−', '意識が、もう！？', '１．意識が　もう。', '▶ 意識が　もう。']) {
    assert.equal(normalizeChoice(text), '意識がもう');
  }
  assert.equal(normalizeChoice('“Don’t—go...”'), 'Dontgo');
  assert.equal(normalizeChoice('【ｺｰﾋｰ２】 cafe\u0301 q\u0301!'), 'コーヒー2caféq\u0301');
});

test('punctuation differences match in either direction without accepting empty or ambiguous choices', () => {
  for (const [expected, observed] of [
    ['意識が―もう――', '意識が──もう──'],
    ['忘れたくない！', '忘れたくない'],
    ['忘れたくない', '「忘れたくない…」'],
  ]) {
    assert.ok(findChoice(menu(observed), expected));
    assert.ok(findChoice(menu(expected), observed));
  }
  assert.equal(findChoice(menu('……'), '――'), null);
  assert.equal(findChoice([line('行く！', .3), line('行く？', .43)], '行く'), null);
  assert.equal(findChoice([line('行く', .3), line('……', .43)], '行く'), null);
  assert.equal(findChoice(menu('コヒ'), 'コーヒー'), null);
});

test('short choices require exact normalized text and credible menu geometry', () => {
  assert.ok(findChoice(menu(), '大丈夫'));
  assert.ok(findChoice(menu('１．　大丈夫'), '大丈夫'));
  assert.equal(findChoice([line('本当に大丈夫なの？', 0.3), line('やめておこう', 0.43)], '大丈夫'), null);
  assert.ok(findChoice([line('「大丈夫」', 0.3), line('やめておこう', 0.43)], '大丈夫'));
  assert.equal(findChoice([line('大丈夫', 0.3)], '大丈夫'), null);
  assert.equal(findChoice([line('大丈夫', 0.8), line('そう言って彼女は笑った。', 0.84)], '大丈夫'), null);
  assert.equal(findChoice([line('大丈夫', 0.3), line('続きの台詞', 0.338)], '大丈夫'), null);
  assert.equal(findChoice([line('大丈夫', 0.3), line('別の文字', 0.43, 0.02)], '大丈夫'), null);
  assert.equal(findChoice([{ text: '大丈夫' }, { text: 'やめておこう' }], '大丈夫'), null);
});

function tracker(steps = ['大丈夫', 'セーブ1', '進む']) {
  return new GuideTracker(validateRoute(steps.map(simpleJp => ({ simpleJp }))));
}

test('isolated choices tolerate small OCR errors at similar lengths anywhere on screen', () => {
  const expected = 'わたしは首を横に振る';
  for (const observed of ['わたしは首を横に振ろ', 'わたしは首を横振る', 'ひわたしは首を横に振る']) {
    for (const [x, y] of [[.4, .3], [.08, .78]]) {
      const match = findChoice([line(observed, y, x), line('わたしはこくりと頷いた', y - .16, x)], expected);
      assert.ok(match, observed);
      assert.equal(match.text, normalizeChoice(expected));
      assert.ok(match.options.includes(normalizeChoice(observed)));
    }
  }
  assert.ok(findChoice([line('わたしは首を横に振ろ', .8, .08)], expected), 'an isolated long block can show a hint without a second option');
  assert.ok(findChoice([line(expected, .8, .08)], expected));
});

test('fuzzy choices reject short, dissimilar, ambiguous, and paragraph text', () => {
  const expected = 'わたしは首を横に振る';
  for (const data of [
    menu('わたしは腕を縦に振る'),
    menu('わたしは首を横に振ると言った'),
    [line('わたしは首を横に振ろ', .3), line('わたしは首を横に振れ', .43)],
    [line('わたしは首を横に振ろ', .8), line('そのまま話を続けた', .84)],
    [line('わたしは首を横に振ろ', .3), line('そのまま話を続けた', .338), line('別の選択肢', .5)],
    [{ text: 'わたしは首を横に振ろ' }],
  ]) assert.equal(findChoice(data, expected), null);
  assert.equal(findChoice(menu('大丈犬'), '大丈夫'), null);
  assert.equal(findChoice(menu('進まない'), '進む'), null);
  assert.ok(findChoice([line(expected, .3), line('わたしは首を横に振ろ', .43)], expected), 'an exact option takes precedence');
});

test('fuzzy confidence uses menu and center bonuses without relaxing the edit or length limits', () => {
  const expected = '君と一緒に帰りたい';
  const observed = '君と一緒に帰りたぃ';
  assert.ok(findChoice([line(observed, .4)], expected), 'a centered isolated block gets a small confidence bonus');
  assert.equal(findChoice([line(observed, .8, .08)], expected), null);
  assert.ok(findChoice([line(observed, .8, .08), line('ひとりで帰る', .64, .08)], expected), 'an off-center menu supplies the same extra confidence');
  const long = 'abcdefghijklmnopqr';
  assert.ok(findChoice(menu('xbcdefghijklmnopqs'), long), 'long choices can tolerate two errors');
  assert.equal(findChoice(menu('xycdefghijklmnopqs'), long), null, 'three errors are never allowed');
  assert.equal(findChoice(menu('abcdefghijklmn'), long), null, 'a large length mismatch is never allowed');
});

test('fuzzy menu scans work without matching hooked text and advance only once', () => {
  const guide = tracker(['わたしは首を横に振る', '進む']);
  guide.observe({ type: 'game_text', text: 'きゅうっと胸が締め付けられる。' }, 900);
  guide.observe(frame([line('わたしは首を横に振ろ', .8), line('わたしはこくりと頷いた', .6)], {
    line_id: 'old-hook', latest_text: 'きゅうっと胸が締め付けられる。', presence_id: 'menu',
  }), 1000);
  assert.equal(guide.detected, true);
  guide.observe(frame([line('わたしは首を横に振れ', .8)], { line_id: 'retry', presence_id: 'retry' }), 2500);
  assert.equal(guide.index, 0, 'another OCR spelling of an option does not prove the menu left');
  guide.observe(frame([line('次の会話', .8)], { line_id: 'dialogue', presence_id: 'dialogue' }), 3000);
  assert.equal(guide.index, 1);
  guide.observe(frame([line('別の会話', .8)], { line_id: 'dialogue-2' }), 4000);
  assert.equal(guide.index, 1);
});

test('a lone matching block shows a hint but cannot arm automatic progression or catch-up', () => {
  for (const text of ['わたしは首を横に振る', 'わたしは首を横に振ろ']) {
    const guide = tracker(['わたしは首を横に振る', '進む']);
    guide.observe(frame([line(text, .8)]), 1000);
    assert.equal(guide.detected, true);
    guide.observe(frame([line('次の会話', .8)]), 3000);
    assert.equal(guide.index, 0);
    assert.equal(guide.detected, false, 'a lone-block hint must hide when fresh OCR shows different text');
    const ahead = tracker(['進む', 'わたしは首を横に振る']);
    ahead.observe(frame([line(text, .4)]), 1000);
    assert.equal(ahead.index, 0);
    ahead.observe(frame(menu(text)), 2000);
    assert.equal(ahead.index, text.endsWith('振る') ? 1 : 0, 'catch-up requires an exact menu match');
  }
});

test('time spent on a lone block cannot make the first partial menu scan stable', () => {
  const guide = tracker(['わたしは首を横に振る', '進む']);
  guide.observe(frame([line('わたしは首を横に振ろ', .3)]), 1000);
  guide.observe(frame(menu('わたしは首を横に振ろ'), { is_final: false }), 3000);
  guide.observe(frame([line('次の会話', .8)]), 4000);
  assert.equal(guide.index, 0);
});

test('an exact later instruction cannot be mistaken for a fuzzy current instruction', () => {
  const guide = tracker(['わたしは首を横に振る', 'わたしは首を縦に振る']);
  guide.observe(frame(menu('わたしは首を縦に振る')), 1000);
  assert.equal(guide.index, 1);
  assert.equal(guide.detected, true);
});

test('incoming text can reveal the current choice but cannot advance without a visual menu', () => {
  for (const text of ['大丈夫', '１．大丈夫！\nやめておこう']) {
    const guide = tracker();
    guide.observe({ type: 'game_text', text }, 1000);
    assert.equal(guide.detected, true);
    assert.equal(guide.rememberedChoice, false);
    guide.observe({ type: 'overlay_clear', line_id: 'scan' }, 1100);
    guide.observe(frame(menu('大丈犬'), { line_id: 'scan' }), 1200);
    assert.equal(guide.detected, true, 'an OCR miss must not erase correct hooked text');
    guide.observe({ type: 'game_text', text: '次の会話' }, 2000);
    assert.equal(guide.detected, false);
    guide.observe(frame([line('次の会話', .8)], { line_id: 'next' }), 3000);
    assert.equal(guide.index, 0);
  }
  const guide = tracker();
  for (const text of ['大丈犬', '本当に大丈夫なの', '大丈夫\n大丈夫', '進む', 'SAVE\n大丈夫\nいいえ']) {
    guide.observe({ type: 'game_text', text }, 1000);
    assert.equal(guide.detected, false);
    assert.equal(guide.index, 0);
  }
});

test('text and OCR confirmations share one choice and preserve manual advancement guards', () => {
  const guide = tracker(['大丈夫', '大丈夫', '進む']);
  guide.observe({ type: 'game_text', text: '大丈夫\nやめておこう' }, 1000);
  guide.next();
  guide.observe({ type: 'game_text', text: '大丈夫\nやめておこう' }, 1100);
  guide.observe(frame(menu()), 1200);
  assert.equal(guide.detected, false);
  guide.observe(frame([line('新しい会話', .8)]), 2000);
  guide.observe({ type: 'game_text', text: '大丈夫' }, 3000);
  guide.observe(frame(menu(), { line_id: 'menu' }), 3100);
  guide.observe({ type: 'game_text', text: '大丈夫' }, 3200);
  guide.observe({ type: 'game_text', text: '次の会話' }, 3300);
  guide.observe(frame([line('次の会話', .8)], { line_id: 'dialogue' }), 3400);
  assert.equal(guide.index, 2, 'plaintext must not replace confirmed OCR evidence');
});

test('choice disappearance carries a save into the next choice and Back undoes the whole advance', () => {
  const guide = tracker();
  guide.observe(frame(menu()), 1000);
  assert.equal(guide.detected, true);
  guide.observe(frame(menu()), 2000);
  assert.equal(guide.index, 0);
  guide.observe(frame([line('次の会話が始まった。', 0.8)]), 3000);
  assert.equal(guide.index, 2);
  assert.equal(guide.startIndex, 1);
  assert.equal(guide.current.text, '進む');
  assert.deepEqual(guide.saveInstructions, ['セーブ1']);
  assert.equal(guide.tentative, true);
  guide.observe(frame([line('セーブ1', 0.3), line('ロード', 0.43)]), 5000);
  assert.equal(guide.index, 2);
  guide.back();
  assert.equal(guide.index, 0);
  assert.deepEqual(guide.saveInstructions, []);
  guide.next();
  assert.deepEqual(guide.saveInstructions, ['セーブ1']);
  guide.next();
  assert.equal(guide.complete, true);
  assert.deepEqual(guide.saveInstructions, []);
  guide.back();
  assert.deepEqual(guide.saveInstructions, ['セーブ1']);
});

test('consecutive saves follow their choice across initial load, manual jumps, and Back', () => {
  const steps = validateRoute(['セーブ1', 'セーブ2', '大丈夫', '進む'].map(simpleJp => ({ simpleJp })));
  for (const index of [0, 1, 2]) {
    const guide = new GuideTracker(steps, index);
    assert.equal(guide.index, 2);
    assert.equal(guide.startIndex, 0);
    assert.deepEqual(guide.saveInstructions, ['セーブ1', 'セーブ2']);
    guide.back();
    assert.equal(guide.index, 2);
    guide.next();
    assert.equal(guide.index, 3);
    assert.deepEqual(guide.saveInstructions, []);
    guide.back();
    assert.equal(guide.index, 2);
    guide.jump(index);
    assert.deepEqual(guide.saveInstructions, ['セーブ1', 'セーブ2']);
  }
});

test('saves before loads or the end remain explicit actions and never disappear', () => {
  const guide = tracker(['セーブ1', 'セーブ2', 'セーブ1にロード', '大丈夫', 'セーブ3']);
  for (const [index, kind] of [[0, 'save'], [1, 'save'], [2, 'load']]) {
    assert.equal(guide.index, index);
    assert.equal(guide.current.kind, kind);
    assert.deepEqual(guide.saveInstructions, []);
    guide.observe(frame(menu()), 1000);
    guide.observe(frame([line('次の会話', .8)]), 3000);
    assert.equal(guide.index, index);
    guide.next();
  }
  guide.next();
  assert.equal(guide.current.kind, 'save');
  guide.next();
  assert.equal(guide.complete, true);
  guide.back();
  assert.equal(guide.current.text, 'セーブ3');
});

test('opening a save screen or overwrite prompt keeps the reminder until the choice returns', () => {
  for (const label of ['セーブ', 'SAVE GAME', 'ロード', '上書きしますか？']) {
    const guide = tracker(['セーブ1', '大丈夫', '進む']);
    guide.observe(frame(menu()), 1000);
    guide.observe(frame([line(label, .15), line('空きスロット', .3)]), 3000);
    assert.equal(guide.index, 1);
    assert.equal(guide.detected, false);
    assert.deepEqual(guide.saveInstructions, ['セーブ1']);
    guide.observe(frame([line('新しい会話', .8)]), 4000);
    assert.equal(guide.index, 1);
    guide.observe(frame(menu()), 5000);
    guide.observe(frame([line('選択後の会話', .8)]), 7000);
    assert.equal(guide.index, 2);
  }
});

test('permanent save buttons do not block progression, but a moved save heading still disarms it', () => {
  const guide = tracker(['セーブ1', '大丈夫', '進む']);
  const saveButton = line('セーブ', .92);
  guide.observe(frame([...menu(), saveButton]), 1000);
  guide.observe(frame([line('セーブ', .15), line('空きスロット', .3), saveButton]), 3000);
  assert.equal(guide.index, 1);
  assert.equal(guide.detected, false);
  guide.observe(frame([...menu(), saveButton]), 5000);
  guide.observe(frame([line('選択後の会話', .8), saveButton]), 7000);
  assert.equal(guide.index, 2);
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

test('advancing manually across a save while a menu is open cannot consume the next identical choice', () => {
  const guide = tracker(['大丈夫', 'セーブ1', '大丈夫', '進む']);
  guide.observe(frame(menu()), 1000);
  guide.next();
  guide.suspendDetection();
  guide.observe(frame(menu()), 2000);
  guide.observe(frame([line('次の会話', .8)]), 4000);
  assert.equal(guide.index, 2);
  assert.deepEqual(guide.saveInstructions, ['セーブ1']);
  guide.observe(frame(menu()), 5000);
  guide.observe(frame([line('別の会話', .8)]), 7000);
  assert.equal(guide.index, 3);
  assert.deepEqual(guide.saveInstructions, []);
});

test('presence invalidation can hide the hint but only fresh final text can advance', () => {
  const guide = tracker();
  guide.observe(frame(menu(), { presence_id: 'choice' }), 1000);
  guide.observe({ type: 'ocr_text_invalidated', presence_id: 'choice' }, 3000);
  assert.equal(guide.index, 0);
  assert.equal(guide.detected, false);
  guide.observe(frame([line('新しい会話', .8)], { presence_id: 'dialogue' }), 4000);
  assert.equal(guide.index, 2);
});

test('suspended choices only accept revalidation of the remembered presence and clear on new text', () => {
  const guide = tracker();
  const original = frame(menu(), { presence_id: 'choice' });
  guide.observe(original, 1000);
  guide.suspendDetection();
  guide.observe({ type: 'ocr_text_revalidated', presence_id: 'other', payload: original }, 3000);
  guide.observe({ type: 'ocr_text_revalidated', presence_id: 'choice', payload: { ...original, presence_id: 'other' } }, 3000);
  assert.equal(guide.rememberedChoice, true);
  guide.observe({ type: 'ocr_text_invalidated', presence_id: 'choice' }, 4000);
  assert.equal(guide.detected, false);
  guide.observe({ type: 'ocr_text_revalidated', presence_id: 'choice', payload: original }, 5000);
  assert.equal(guide.detected, true);
  assert.equal(guide.rememberedChoice, false);
  guide.suspendDetection();
  guide.observe(frame([line('新しい会話', .8)]), 6000);
  guide.observe({ type: 'ocr_text_revalidated', presence_id: 'choice', payload: original }, 7000);
  assert.equal(guide.detected, false);
  assert.equal(guide.index, 0);
});

test('a unique final menu within the next three choices recovers missed progression and Back undoes the jump', () => {
  for (const distance of [1, 2, 3]) {
    const guide = tracker(['大丈夫', '進む', '待つ', '帰る', '寝る']);
    guide.observe(frame(menu()), 500);
    guide.observe({ type: 'overlay_clear' }, 1000);
    guide.observe(frame(menu(guide.steps[distance].text)), 2000);
    assert.equal(guide.index, distance);
    assert.equal(guide.detected, true);
    assert.equal(guide.tentative, true);
    assert.equal(guide.recoveredFrom, 0);
    guide.back();
    assert.equal(guide.index, 0);
    assert.equal(guide.recoveredFrom, null);
  }
  const guide = tracker(['大丈夫', '進む', '待つ', '帰る', '寝る']);
  guide.observe(frame(menu('寝る')), 2000);
  assert.equal(guide.index, 0, 'recovery must remain bounded');
});

test('look-ahead rejects dialogue, partial/supplemental/stale frames, and manual-only mode', () => {
  const guide = tracker(['大丈夫', '進む', '待つ']);
  for (const payload of [
    frame([line('進む', .8), line('これは会話です', .84)]),
    frame(menu('進む'), { is_final: false }),
    frame(menu('進む'), { supplemental: true }),
    frame([line('進む', .3)]),
    frame([line('「進む」と言った。', .3), line('やめておこう', .43)]),
  ]) {
    guide.observe(payload, 1000);
    assert.equal(guide.index, 0);
  }
  guide.observe(frame(menu('進む')), 2000, false);
  assert.equal(guide.index, 0);
  guide.observe(frame(menu(), { presence_id: 'old' }), 3000);
  guide.observe(frame(menu('進む'), { presence_id: 'old' }), 4000);
  assert.equal(guide.index, 0);
  guide.observe(frame(menu('進む'), { presence_id: 'new' }), 5000);
  assert.equal(guide.index, 1);
});

test('current choices take priority and ambiguous or repeated future answers never trigger recovery', () => {
  const guide = tracker(['大丈夫', '進む', '待つ']);
  guide.observe(frame([line('大丈夫', .3), line('進む', .43)]), 1000);
  assert.equal(guide.index, 0);
  guide.observe(frame(menu('進む')), 1500);
  assert.equal(guide.index, 0, 'a previously visible alternative is not evidence of a later menu');
  guide.resetDetection();
  guide.observe(frame([line('進む', .3), line('待つ', .43)]), 3000);
  assert.equal(guide.index, 0);
  const repeated = tracker(['大丈夫', '進む', '待つ', '進む']);
  repeated.observe(frame(menu('進む')), 1000);
  assert.equal(repeated.index, 0);
});

test('look-ahead carries a save into its choice but never skips beyond that choice or a load', () => {
  const guide = tracker(['大丈夫', '待つ', 'セーブ1', 'セーブ2', '進む', '帰る']);
  guide.observe(frame(menu('帰る')), 1000);
  assert.equal(guide.index, 0);
  guide.observe(frame(menu('進む')), 2000);
  assert.equal(guide.index, 4);
  assert.deepEqual(guide.saveInstructions, ['セーブ1', 'セーブ2']);
  assert.equal(guide.recoveredFrom, 0);
  guide.back();
  assert.equal(guide.index, 0);
  const load = tracker(['大丈夫', '待つ', 'セーブ1にロード', '進む']);
  load.observe(frame(menu('進む')), 1000);
  assert.equal(load.index, 0);
  load.observe(frame(menu('待つ')), 2000);
  assert.equal(load.index, 1);
  load.next();
  load.observe(frame(menu('進む')), 3000);
  assert.equal(load.current.kind, 'load');
});

test('a pending save reminder limits recovery to the immediately following choice', () => {
  const guide = tracker(['セーブ1', '大丈夫', '進む', '帰る']);
  guide.observe(frame(menu('帰る')), 1000);
  assert.equal(guide.index, 1);
  assert.deepEqual(guide.saveInstructions, ['セーブ1']);
  guide.observe(frame(menu('進む')), 2000);
  assert.equal(guide.index, 2);
  guide.back();
  assert.equal(guide.index, 1);
  assert.deepEqual(guide.saveInstructions, ['セーブ1']);
});

test('save/overwrite menus cannot trigger look-ahead while permanent lower save buttons remain harmless', () => {
  for (const caption of ['セーブ', 'LOAD', '上書きしますか？']) {
    const guide = tracker(['大丈夫', 'はい', '進む']);
    guide.observe(frame([line(caption, .1), line('はい', .3), line('いいえ', .43)]), 1000);
    assert.equal(guide.index, 0);
  }
  const guide = tracker(['大丈夫', '進む', '帰る']);
  guide.observe(frame([...menu('進む'), line('セーブ', .92)]), 1000);
  assert.equal(guide.index, 1);
  guide.next();
  guide.back();
  assert.equal(guide.index, 1, 'an explicit advance confirms recovery and uses ordinary Back navigation');
});

test('opening save UI after an armed choice cannot advance through either recovery or disappearance', () => {
  const guide = tracker(['大丈夫', 'はい', '進む']);
  guide.observe(frame([...menu(), line('セーブ', .92)]), 1000);
  guide.observe(frame([line('上書きしますか？', .1), line('はい', .3), line('いいえ', .43)]), 3000);
  assert.equal(guide.index, 0);
  assert.equal(guide.detected, false);
});

test('suspension preserves the known alternatives when deciding whether a menu is new', () => {
  const guide = tracker(['大丈夫', '進む', '待つ']);
  guide.observe(frame([line('大丈夫', .3), line('進む', .43)], { presence_id: 'old' }), 1000);
  guide.suspendDetection();
  guide.observe(frame(menu('進む'), { presence_id: 'new' }), 3000);
  assert.equal(guide.index, 0);
  guide.observe(frame(menu('進む'), { presence_id: 'new' }), 4000);
  assert.equal(guide.index, 0);
});

test('a new-line OCR clear retains the choice until fresh final dialogue confirms its disappearance', () => {
  const guide = tracker();
  guide.observe(frame(menu(), { line_id: 'choice', presence_id: 'choice' }), 1000);
  guide.observe({ type: 'overlay_clear', line_id: 'dialogue' }, 2000);
  assert.equal(guide.index, 0);
  assert.equal(guide.detected, false);
  for (const payload of [
    frame([], { line_id: 'dialogue' }),
    frame([line('次の会話', .8)], { line_id: 'dialogue', is_final: false }),
    frame([line('次の会話', .8)], { line_id: 'dialogue', supplemental: true }),
    frame([line('次の会話', .8)], { line_id: 'choice', presence_id: 'rescan' }),
    { type: 'ocr_text_revalidated', presence_id: 'choice', payload: frame(menu(), { line_id: 'choice', presence_id: 'choice' }) },
  ]) {
    guide.observe(payload, 3000);
    assert.equal(guide.index, 0);
    assert.equal(guide.detected, false);
  }
  guide.observe(frame([line('次の会話', .8)], { line_id: 'dialogue', presence_id: 'dialogue' }), 3000);
  assert.equal(guide.index, 2);
  assert.equal(guide.recoveredFrom, null, 'ordinary progression must not need catch-up at the next menu');
  assert.deepEqual(guide.saveInstructions, ['セーブ1']);
  guide.observe({ type: 'overlay_clear', line_id: 'dialogue-2' }, 4000);
  guide.observe(frame([line('別の会話', .8)], { line_id: 'dialogue-2' }), 5000);
  assert.equal(guide.index, 2, 'later dialogue must not consume the unseen next choice');
  guide.back();
  assert.equal(guide.index, 0);
});

test('quick choices can advance on a distinct final text line, while same-line OCR revisions cannot', () => {
  for (const clear of [false, true]) {
    const guide = tracker();
    guide.observe(frame(menu(), { line_id: 'choice', presence_id: 'choice' }), 1000);
    if (clear) guide.observe({ type: 'overlay_clear', line_id: 'dialogue' }, 1100);
    guide.observe(frame([line('次の会話', .8)], { line_id: 'dialogue', presence_id: 'dialogue' }), 1200);
    assert.equal(guide.index, 2, 'a quickly selected choice must not depend on a later OCR event');
  }
  const guide = tracker(['大丈夫', '進む', '待つ']);
  guide.observe(frame(menu(), { line_id: 'choice', presence_id: 'first-pass' }), 1000);
  guide.observe(frame(menu('進む'), { line_id: 'choice', presence_id: 'final-pass' }), 3000);
  assert.equal(guide.index, 0, 'revisions of the same line must not trigger catch-up');
  guide.observe(frame([line('次の会話', .8)], { line_id: 'choice', presence_id: 'rescan' }), 4000);
  assert.equal(guide.index, 0, 'revisions of the same line must not confirm disappearance');
});

test('new-line clears can restore the same choice, but reset, suspension, and expiry discard progression evidence', () => {
  const guide = tracker();
  guide.observe(frame(menu(), { line_id: 'choice' }), 1000);
  guide.observe({ type: 'overlay_clear', line_id: 'rescan' }, 2000);
  guide.observe(frame(menu(), { line_id: 'rescan' }), 3000);
  assert.equal(guide.detected, true);
  assert.equal(guide.index, 0);
  guide.observe({ type: 'overlay_clear', line_id: 'dialogue' }, 4000);
  guide.observe(frame([line('次の会話', .8)], { line_id: 'dialogue' }), 5000);
  assert.equal(guide.index, 2);

  for (const reset of [null, { type: 'overlay_clear' }, 'suspend']) {
    const stale = tracker();
    stale.observe(frame(menu(), { line_id: 'choice' }), 1000);
    stale.observe({ type: 'overlay_clear', line_id: 'dialogue' }, 2000);
    if (reset === 'suspend') stale.suspendDetection();
    else if (reset) stale.observe(reset, 3000);
    stale.observe(frame([line('次の会話', .8)], { line_id: 'dialogue' }), reset ? 4000 : 18000);
    assert.equal(stale.index, 0);
  }
});

test('manual advancement keeps the old-menu guard across new-line clears', () => {
  const guide = tracker(['大丈夫', '大丈夫', '進む']);
  guide.observe(frame(menu(), { line_id: 'choice' }), 1000);
  guide.next();
  guide.observe({ type: 'overlay_clear', line_id: 'rescan' }, 2000);
  guide.observe(frame(menu(), { line_id: 'rescan' }), 3000);
  assert.equal(guide.detected, false);
  guide.observe({ type: 'overlay_clear', line_id: 'dialogue' }, 4000);
  guide.observe(frame([line('次の会話', .8)], { line_id: 'dialogue' }), 5000);
  assert.equal(guide.index, 1);
  guide.observe({ type: 'overlay_clear', line_id: 'choice-2' }, 6000);
  guide.observe(frame(menu(), { line_id: 'choice-2' }), 7000);
  assert.equal(guide.detected, true);
  guide.observe({ type: 'overlay_clear', line_id: 'dialogue-2' }, 8000);
  guide.observe(frame([line('別の会話', .8)], { line_id: 'dialogue-2' }), 9000);
  assert.equal(guide.index, 2);
});

test('a distinct final menu after manual advancement is detected on its first scan', () => {
  const guide = tracker(['大丈夫', '進む', '待つ']);
  guide.observe(frame(menu(), { line_id: 'choice' }), 1000);
  guide.next();
  guide.observe(frame([line('進む', .3), line('戻る', .43)], { line_id: 'choice-2' }), 3000);
  assert.equal(guide.index, 1);
  assert.equal(guide.detected, true);
});

test('new-line clears still respect save screens and manual-only progression', () => {
  for (const saving of [false, true]) {
    const guide = tracker();
    guide.observe(frame(menu(), { line_id: 'choice' }), 1000);
    guide.observe({ type: 'overlay_clear', line_id: 'next' }, 2000);
    guide.observe(frame(saving ? [line('セーブ', .15), line('空きスロット', .3)] : [line('次の会話', .8)], { line_id: 'next' }), 3000, saving);
    guide.observe({ type: 'overlay_clear', line_id: 'dialogue' }, 4000);
    guide.observe(frame([line('別の会話', .8)], { line_id: 'dialogue' }), 5000);
    assert.equal(guide.index, 0);
  }
});
