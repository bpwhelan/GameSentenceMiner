const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const vendor = path.join(__dirname, '..', 'third_party', 'jiten-parser');
const importer = import('../../scripts/sync-jiten-parser-rules.mjs');

test('Jiten rule importer handles literal constructors and preserves all conditions', async () => {
  const { parseRewriteTable } = await importer;
  const rules = parseRewriteTable(`private static readonly RewriteRule[] RewriteRulesTable = [
    // This comment is not a rule.
    new RewriteRule("fixture", RewritePhase.Early,
      [new TokenPattern(TextAnyOf: ["あ", "い"], RequireUnpinned: false)],
      [new TokenTemplate("", DictForm: "ある", Pin: 123, PinReadingIndex: 2, HardPin: true)],
      Prev: new ContextCond(ClauseBoundary: true, Negate: true),
      Window: new WindowCond(-4, -1, PosAnyOf: [PartOfSpeech.Noun]),
      Guard: new LookupGuard(LookupGuardKind.CompoundExists, "{0}")),
  ];`);
  assert.deepEqual(rules, [{ id: 'fixture', phase: 'Early',
    match: [{ textAnyOf: ['あ', 'い'], requireUnpinned: false }],
    replace: [{ text: '', dictForm: 'ある', pin: 123, pinReadingIndex: 2, hardPin: true }],
    prev: { clauseBoundary: true, negate: true }, window: { from: -4, to: -1, posAnyOf: ['Noun'] },
    guard: { kind: 'CompoundExists', pattern: '{0}' } }]);
});

test('Jiten rule importer rejects unfamiliar syntax instead of silently dropping rules', async () => {
  const { parseRewriteTable } = await importer;
  const source = 'private static readonly RewriteRule[] RewriteRulesTable = [new RewriteRule("x", RewritePhase.Early, [new TokenPattern(Text: "x")], [new TokenTemplate("", Pin: 1)])];';
  assert.throws(() => parseRewriteTable(source.replace('Pin: 1', 'Unknown: true')), /Unknown/);
  assert.throws(() => parseRewriteTable(source.replace('Pin: 1', 'Pin: GetId()')), /Unsupported/);
  assert.throws(() => parseRewriteTable(source.replace('new TokenPattern(Text: "x")', '..OtherRules')), /Unsupported/);
  assert.throws(() => parseRewriteTable(source.replace('RewriteRulesTable', 'RenamedTable')), /RewriteRulesTable/);
  assert.throws(() => parseRewriteTable(source.replace('RewritePhase.Early', 'RewritePhase.NewPhase')), /NewPhase/);
});

test('vendored Jiten data regenerates exactly, carries provenance, and ships its license', async () => {
  const { parseRewriteTable, validateRules } = await importer;
  const manifest = JSON.parse(await fs.readFile(path.join(vendor, 'manifest.json'), 'utf8'));
  const source = await fs.readFile(path.join(vendor, 'upstream', 'MorphologicalAnalyser.RewriteRules.cs'));
  const bundle = JSON.parse(await fs.readFile(path.join(vendor, 'token-rewrite-rules.json'), 'utf8'));
  assert.equal(createHash('sha256').update(source).digest('hex'), manifest.sourceSha256);
  assert.equal(bundle.upstreamCommit, manifest.commit);
  assert.match(bundle.notice, /Jiten.*Apache-2\.0/);
  assert.deepEqual(bundle.rules, parseRewriteTable(source.toString('utf8')));
  validateRules(bundle.rules);
  assert.equal(bundle.rules.length, 133);
  assert.deepEqual(bundle.rules.filter(rule => rule.guard).map(rule => rule.id),
    ['kariru', 'konna-no', 'sonna-no', 'anna-no', 'donna-no']);
  assert.match(await fs.readFile(path.join(vendor, 'LICENSE'), 'utf8'), /Apache License/);
  assert.match(await fs.readFile(path.join(vendor, 'README.md'), 'utf8'), /Sirush/);
});
