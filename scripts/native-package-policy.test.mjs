import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditNativePackage, includeSource, pruneDependencies, stageChangelog } from './native-package-policy.mjs';

test('includeSource excludes Node runtime, JS backend, build caches, sourcemaps, tests, and unrequested platform binaries', () => {
  assert.equal(includeSource('dist/renderer/index.html'), true);
  assert.equal(includeSource('assets/scripts/legacy_dictionary_export.py'), true);
  assert.equal(includeSource('GameSentenceMiner/gsm.py'), true);
  assert.equal(includeSource('GameSentenceMiner/assets/vocr/small-faithful.onnx'), true);
  assert.equal(includeSource('GSM_Overlay/hachidori/SOURCE.json'), true);
  assert.equal(includeSource('runtime/node.exe'), false);
  assert.equal(includeSource('runtime/node'), false);
  assert.equal(includeSource('node_modules/ws/index.js'), false);
  assert.equal(includeSource('desktop-runtime/service.mjs'), false);
  assert.equal(includeSource('desktop-runtime/tests/native-smoke.mjs'), false);
  assert.equal(includeSource('dist/main/main.js'), false);
  assert.equal(includeSource('dist/shared/constants.js'), false);
  assert.equal(includeSource('dist/main/main.js.map'), false);
  assert.equal(includeSource('dist/main/preload.d.ts'), false);
  assert.equal(includeSource('GameSentenceMiner/__pycache__/gsm.cpython-311.pyc'), false);
  assert.equal(includeSource('GSM_Overlay/input_server/target/release/gsm_overlay_server.exe'), false);
  assert.equal(includeSource('GSM_Overlay/yomitan/test/dictionary.test.js'), false);
  assert.equal(includeSource('GSM_Overlay/out/gsm_overlay-win32-x64/gsm_overlay.exe'), false);
});

test('excludes MeCab and runtime Sudachi dictionaries on every platform', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const file of ['sys.dic', 'user_dic.dic', 'matrix.bin', 'mecab.exe', 'libmecab.dll', 'mecab.lin', 'libmecab.so.1', 'mecab.mac', 'libmecab.2.dylib']) {
      assert.equal(includeSource('GameSentenceMiner/mecab/support/' + file, platform), false);
    }
    assert.equal(includeSource('GSM_Overlay/input_server/mecab_bridge.py', platform), false);
    assert.equal(includeSource('GameSentenceMiner/sudachi/system_small.dic', platform), false);
  }
});

test('pruneDependencies removes any lingering Node or JS runtime directories and auditNativePackage enforces pure-Rust packaging', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-pkg-policy-'));
  try {
    await fs.mkdir(path.join(temp, 'dist/renderer'), { recursive: true });
    await fs.writeFile(path.join(temp, 'dist/renderer/index.html'), '<html></html>');
    await fs.mkdir(path.join(temp, 'assets/scripts'), { recursive: true });
    await fs.writeFile(path.join(temp, 'assets/scripts/legacy_dictionary_export.py'), 'print("ok")');
    await fs.mkdir(path.join(temp, 'runtime'), { recursive: true });
    await fs.writeFile(path.join(temp, 'runtime/node.exe'), 'binary');
    await fs.mkdir(path.join(temp, 'node_modules/ws'), { recursive: true });
    await fs.writeFile(path.join(temp, 'node_modules/ws/index.js'), 'module.exports={}');
    await fs.mkdir(path.join(temp, 'desktop-runtime'), { recursive: true });
    await fs.writeFile(path.join(temp, 'desktop-runtime/service.mjs'), 'export default {}');
    await fs.mkdir(path.join(temp, 'dist/main'), { recursive: true });
    await fs.writeFile(path.join(temp, 'dist/main/main.js'), 'console.log(1)');

    await assert.rejects(
      () => auditNativePackage(temp, { platform: 'win32', arch: 'x64' }),
      /Forbidden/
    );

    await pruneDependencies(temp);
    const report = await auditNativePackage(temp, { platform: 'win32', arch: 'x64' });
    assert.ok(report.totalMiB < 1);
    assert.equal(report.fileCount, 2);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('packages only current release notes and referenced media, including for prerelease builds', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-package-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  await fs.mkdir(path.join(source, 'releases'), { recursive: true });
  await fs.mkdir(path.join(source, 'images', '1.0.0'), { recursive: true });
  await fs.mkdir(path.join(source, 'images', '2.0.0'), { recursive: true });
  await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ releases: [{ version: '1.0.0', file: 'releases/1.0.0.md' }, { version: '2.0.0', file: 'releases/2.0.0.md' }] }));
  await fs.writeFile(path.join(source, 'releases/1.0.0.md'), '# Old notes\n![Old](1.0.0/movie.avif)');
  await fs.appendFile(path.join(source, 'releases/1.0.0.md'), '\n![Static](1.0.0/screenshot.png)');
  await fs.writeFile(path.join(source, 'releases/2.0.0.md'), '# Current notes\n![Current](2.0.0/image.png)');
  await fs.writeFile(path.join(source, 'images/1.0.0/movie.avif'), 'old media');
  await fs.writeFile(path.join(source, 'images/1.0.0/screenshot.png'), 'old screenshot');
  await fs.writeFile(path.join(source, 'images/2.0.0/image.png'), 'current media');
  await stageChangelog(source, target, '2.0.0-beta.1');
  assert.equal(await fs.readFile(path.join(target, 'releases/2.0.0.md'), 'utf8'), '# Current notes\n![Current](2.0.0/image.png)');
  assert.deepEqual(await fs.readdir(path.join(target, 'releases')), ['2.0.0.md']);
  assert.deepEqual(await fs.readdir(path.join(target, 'images')), ['2.0.0']);
  assert.equal(await fs.readFile(path.join(target, 'images/2.0.0/image.png'), 'utf8'), 'current media');
  await assert.rejects(fs.access(path.join(target, 'images/1.0.0/screenshot.png')));
  await assert.rejects(fs.access(path.join(target, 'images/1.0.0/movie.avif')));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(target, 'manifest.json'))).releases, [{ version: '2.0.0', file: 'releases/2.0.0.md' }]);
  assert.equal(JSON.parse(await fs.readFile(path.join(source, 'manifest.json'))).releases.length, 2);
});
