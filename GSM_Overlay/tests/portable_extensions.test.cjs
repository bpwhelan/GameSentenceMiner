const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { between } = require('./helpers/overlay-startup.cjs');

const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const copySource = between(main, 'function ensureExtensionCopy(', "ipcMain.on('set-platform-override'");

test('a portable Yomitan profile keeps manifest migration out of the shared extension', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-profile-extension-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'bundled');
  const extensionsRoot = path.join(root, 'profile', 'extensions');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'manifest.json'), 'original manifest');
  fs.writeFileSync(path.join(source, 'manifest_static.json'), 'static manifest');
  const versions = {};
  let revision = 'first';
  const copy = vm.runInNewContext(`${copySource}\nensureExtensionCopy;`, {
    fs, path, console: { log() {}, warn() {}, error() {} }, extensionsRoot,
    process: { env: { GSM_PROFILE_DIR: path.join(root, 'profile') } },
    isLinux: () => false, readExtensionVersions: () => versions,
    writeExtensionVersions: (value) => Object.assign(versions, value),
    getExtensionContentRevision: () => revision,
    readExtensionPackageVersion: () => revision,
  });
  const target = copy('yomitan', source);
  assert.equal(target, path.join(extensionsRoot, 'yomitan'));
  assert.equal(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'), 'static manifest');
  assert.equal(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'), 'original manifest');
  fs.writeFileSync(path.join(source, 'manifest_static.json'), 'updated static manifest');
  revision = 'second';
  copy('yomitan', source);
  assert.equal(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'), 'updated static manifest');
  assert.equal(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'), 'original manifest');
  // Read-only Hachidori assets can still be loaded directly from the bundle.
  assert.equal(copy('hachidori', source), source);
});
