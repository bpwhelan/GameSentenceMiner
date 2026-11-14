import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { patchContent, patchSearchShell, patchSearchFrame, patchNativeEngine, prepareIntegration } from './hachidori-integration.mjs';

const vendor = new URL('../GSM_Overlay/hachidori/', import.meta.url);
test('the overlay bridge accepts native hosts and rejects remote lookalikes', async () => {
    const source = await fs.readFile(new URL('../GSM_Overlay/integrations/hachidori/bridge.js', import.meta.url), 'utf8');
    const context = vm.createContext({ URL, module: { exports: {} } });
    new vm.Script(source).runInContext(context);
    const { isGsmHost } = context.module.exports;
    for (const url of ['http://gsm.localhost/overlay/index.html', 'gsm://localhost/overlay/index.html']) assert.equal(isGsmHost(url), true);
    for (const url of ['http://gsm.localhost.evil.test/overlay/index.html', 'https://gsm.localhost/overlay/index.html', 'http://gsm.localhost/renderer/index.html', 'https://example.com/index.html']) assert.equal(isGsmHost(url), false);
});
test('WebKit uses the existing offscreen engine and rejects upstream hook drift', async () => {
    const source = await fs.readFile(new URL('offscreen.js', vendor), 'utf8');
    const patched = patchNativeEngine(source);
    assert.equal(patchNativeEngine(patched), patched);
    assert.match(patched, /protocol === "gsm-hachidori:"\) return "local"/);
    assert.throws(() => patchNativeEngine(source.replace('async function selectEngine()', 'async function changedEngine()')), /changed upstream/);
});
test('native search keeps the sandbox and fails when its frame hook drifts', async () => {
    const source = await fs.readFile(new URL('search-frame.html', vendor), 'utf8');
    const patched = patchSearchFrame(source);
    assert.equal(patchSearchFrame(patched), patched);
    assert.equal(patched.split('gsm/native-search.js').length, 2);
    assert.throws(() => patchSearchFrame(source.replace('src="search.js"', 'src="changed.js"')), /changed upstream/);
});
test('search keeps working without browser permissions and detects upstream hook drift', async () => {
    const source = await fs.readFile(new URL('search-shell.js', vendor), 'utf8');
    const patched = patchSearchShell(source);
    assert.equal(patchSearchShell(patched), patched);
    assert.match(patched, /if \(!chrome.permissions\) return/);
    assert.throws(() => patchSearchShell(source.replace('function clipboardMonitor(clipboardSwitch, search, language)', 'function clipboardMonitor(changed)')), /changed upstream/);
});
test('the real Hachidori hooks generate valid JS and are idempotent', async () => {
    const content = await fs.readFile(new URL('content.js', vendor), 'utf8');
    const patched = patchContent(content);
    new vm.Script(patched);
    assert.equal(patchContent(patched), patched);
    assert.equal(patched.split('GsmHachidoriIntegration?.install').length, 2);
});
test('upstream hook drift fails with an actionable error', async () => {
    const content = await fs.readFile(new URL('content.js', vendor), 'utf8');
    assert.throws(() => patchContent(content.replace('function onMouseMove(event)', 'function onMouseMove(pointer)')), /changed upstream.*onMouseMove/);
});
test('upstream offscreen lifecycle hook drift fails before integration is written', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-offscreen-hooks-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    for (const file of ['content.js', 'manifest.json', 'chrome-offscreen.js']) {
        await fs.copyFile(new URL(file, vendor), path.join(directory, file));
    }
    const helper = await fs.readFile(path.join(directory, 'chrome-offscreen.js'), 'utf8');
    for (const name of ['chromeOffscreenSupported', 'ensureChromeOffscreen']) {
        await fs.writeFile(path.join(directory, 'chrome-offscreen.js'), helper.replace(name, `${name}Changed`));
        await assert.rejects(prepareIntegration(directory), new RegExp(`hook changed upstream.*${name}`));
    }
});
test('manifest loads GSM modules before the content hook and the integration hash is stable', async () => {
    const { fileURLToPath } = await import('node:url');
    const first = await prepareIntegration(fileURLToPath(vendor));
    const second = await prepareIntegration(fileURLToPath(vendor));
    assert.deepEqual(first.metadata, second.metadata);
    const scripts = first.manifest.content_scripts.find(item => item.js.includes('content.js')).js;
    assert.ok(scripts.indexOf('gsm/bridge.js') < scripts.indexOf('content.js'));
    assert.equal(new Set(scripts).size, scripts.length);
    for (const file of ['gsm/engine-host.html', 'gsm/engine-host.js']) {
        assert.ok(first.assets.has(file), `${file} must be generated for engine ownership`);
        assert.ok(!scripts.includes(file), `${file} must not run as a reader content script`);
    }
    for (const [file, bytes] of first.assets) {
        const generated = (await fs.readFile(new URL(file, vendor), 'utf8')).replaceAll('\r\n', '\n');
        assert.equal(generated, bytes.toString(), `${file} must be regenerated from its GSM source`);
    }
    const source = JSON.parse(await fs.readFile(new URL('SOURCE.json', vendor), 'utf8'));
    assert.deepEqual(source.gsmIntegration, first.metadata, 'Regenerate the checked-in integration fingerprint');
});
