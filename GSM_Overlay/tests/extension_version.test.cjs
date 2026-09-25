const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { between } = require('./helpers/overlay-startup.cjs');

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const versionSource = between(main, 'function readExtensionPackageVersion(', 'function ensureExtensionCopy(');

function versionFor(source) {
  const files = { 'manifest.json': { version: '1.0' } };
  if (source) files['SOURCE.json'] = source;
  return vm.runInNewContext(`${versionSource}\nreadExtensionPackageVersion('extension');`, {
    path, console,
    fs: {
      existsSync: file => Object.hasOwn(files, path.basename(file)),
      readFileSync: file => JSON.stringify(files[path.basename(file)]),
    },
  });
}

test('extension copies refresh when the GSM integration changes without an upstream update', () => {
  const source = { commit: 'same-upstream-commit', gsmIntegration: { sha256: 'first' } };
  const first = versionFor(source);
  source.gsmIntegration.sha256 = 'second';
  assert.notEqual(versionFor(source), first);
  assert.notEqual(versionFor({ commit: source.commit }), first);
});

test('extensions without a GSM integration retain their existing version identity', () => {
  assert.equal(versionFor(), '1.0');
  assert.equal(versionFor({ commit: 'upstream' }), '1.0+upstream');
});
