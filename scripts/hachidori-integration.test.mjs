import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { patchContent, prepareIntegration } from './hachidori-integration.mjs';

const vendor = new URL('../GSM_Overlay/hachidori/', import.meta.url);
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
test('manifest loads GSM modules before the content hook and the integration hash is stable', async () => {
    const { fileURLToPath } = await import('node:url');
    const first = await prepareIntegration(fileURLToPath(vendor));
    const second = await prepareIntegration(fileURLToPath(vendor));
    assert.deepEqual(first.metadata, second.metadata);
    const scripts = first.manifest.content_scripts.find(item => item.js.includes('content.js')).js;
    assert.ok(scripts.indexOf('gsm/bridge.js') < scripts.indexOf('content.js'));
    assert.equal(new Set(scripts).size, scripts.length);
    for (const [file, bytes] of first.assets) {
        const generated = (await fs.readFile(new URL(file, vendor), 'utf8')).replaceAll('\r\n', '\n');
        assert.equal(generated, bytes.toString(), `${file} must be regenerated from its GSM source`);
    }
    const source = JSON.parse(await fs.readFile(new URL('SOURCE.json', vendor), 'utf8'));
    assert.deepEqual(source.gsmIntegration, first.metadata, 'Regenerate the checked-in integration fingerprint');
});
