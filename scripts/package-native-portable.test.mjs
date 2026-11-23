import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yauzl from 'yauzl';
import {packagePortable} from './package-native-portable.mjs';

const required = ['GameSentenceMiner.exe', 'app/dist/renderer/index.html', 'app/LICENSE', 'app/native/agent-runtime.json'];
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-portable-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'portable');
  for (const name of required) {
    const file = path.join(source, name);
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, `fixture:${name}`);
  }
  return {source, output: path.join(root, 'portable.zip')};
}
function zipFiles(filename) {
  return new Promise((resolve, reject) => {
    yauzl.open(filename, {lazyEntries: true}, (error, zip) => {
      if (error) return reject(error);
      const files = [];
      zip.on('error', reject);
      zip.on('entry', entry => { if (!entry.fileName.endsWith('/')) files.push(entry.fileName); zip.readEntry(); });
      zip.on('end', () => resolve(files.sort()));
      zip.readEntry();
    });
  });
}

test('packages the native layout without an obsolete app/package.json', async t => {
  const {source, output} = await fixture(t);
  await packagePortable(source, output);
  assert.deepEqual(await zipFiles(output), [...required].sort());
});

test('rejects missing native app resources before creating a ZIP', async t => {
  const {source, output} = await fixture(t);
  await fs.writeFile(path.join(source, 'app/package.json'), '{}');
  await fs.unlink(path.join(source, 'app/native/agent-runtime.json'));
  await assert.rejects(packagePortable(source, output), /agent-runtime\.json/);
  await assert.rejects(fs.access(output), {code: 'ENOENT'});
});
