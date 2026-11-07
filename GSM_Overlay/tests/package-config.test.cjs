const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { packagerConfig } = require('../forge.config.js');

test('packaging excludes a local link back to the full GSM checkout', () => {
  for (const entry of [
    '/node_modules/gamesentenceminer',
    '/node_modules/gamesentenceminer/GSM_Overlay/out',
    path.resolve(__dirname, '../node_modules/gamesentenceminer/package.json'),
  ]) {
    assert.equal(packagerConfig.ignore(entry), true, entry);
  }
});

test('packaging retains the overlay runtime dependencies', () => {
  for (const entry of ['/main.js', '/node_modules/ws/index.js', '/node_modules/koffi/index.js']) {
    assert.equal(packagerConfig.ignore(entry), false, entry);
  }
});

test('POSIX absolute checkout paths exclude the parent-project link', () => {
  const directory = '/home/runner/work/GameSentenceMiner/GameSentenceMiner/GSM_Overlay';
  const sandbox = {
    __dirname: directory,
    module: { exports: {} },
    process: { platform: 'linux' },
    require: (name) => name === 'path' ? path.posix : require(name),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../forge.config.js'), 'utf8'), sandbox);
  const { ignore } = sandbox.module.exports.packagerConfig;
  assert.equal(ignore(`${directory}/node_modules/gamesentenceminer/package.json`), true);
  assert.equal(ignore(`${directory}/node_modules/ws/index.js`), false);
  assert.equal(ignore('/node_modules/gamesentenceminer/package.json'), true);
});
