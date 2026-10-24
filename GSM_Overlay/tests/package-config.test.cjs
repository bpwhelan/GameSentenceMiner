const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
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
