// The only upstream touch points live here. GSM implementation stays outside the vendor tree.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const overlayRoot = path.resolve(import.meta.dirname, '../GSM_Overlay');
const files = new Map([
    ['popup_navigation.js', 'gsm/popup-navigation.js'],
    ['jiten_grading_bar.js', 'gsm/jiten-grading-bar.js'],
    ['integrations/hachidori/popup.js', 'gsm/popup.js'],
    ['integrations/hachidori/bridge.js', 'gsm/bridge.js'],
]);
const begin = '// GSM integration hook begin';
const end = '// GSM integration hook end';
const hook = `${begin}
  gsmBridge = globalThis.GsmHachidoriIntegration?.install({
    state: () => ({ disposed, levels, options, dictionaries, pendingCandidateLookup }),
    ready: () => globalThis.HDReaderReady,
    readOptions: async () => (await chrome.storage.local.get("options")).options ?? null,
    resolveCandidate, resolveCandidateAt, candidateSignature, sameAnchorNode, lookupCandidate, hide, sendRequest,
    cancelHover({ preserveLookup = false } = {}) {
      if (preserveLookup) clearScanTimer(); else cancelCandidateScan();
      clearHideTimer(); clearTransferTimer(); clearDescendantTimer();
    },
    command: (action, argument) => runKeybindAction({ action, argument }, { preventDefault() {}, stopPropagation() {} }),
  });
  ${end}`;

function replaceOnce(source, anchor, replacement) {
    if (source.split(anchor).length !== 2) {
        throw new Error(`Hachidori integration hook changed upstream: ${JSON.stringify(anchor)}. Update scripts/hachidori-integration.mjs.`);
    }
    return source.replace(anchor, replacement);
}

export function patchContent(source) {
    source = source.replaceAll('\r\n', '\n');
    // Regeneration is idempotent: strip only our marked insertions first.
    source = source.replace(/  \/\/ GSM integration hook begin[\s\S]*?  \/\/ GSM integration hook end\n/gu, '');
    source = source.replace(/^.*\/\/ GSM hook\n/gmu, '');
    source = replaceOnce(source, '  let disposed = false;', '  let gsmBridge = null; // GSM hook\n  let disposed = false;');
    for (const signature of ['function onMouseMove(event)', 'function onPopupMouseMove(event, level)',
        'function onMouseOut(event)', 'function onWindowBlur()', 'function scheduleHide()',
        'function onKeyDown(event)', 'function onKeyUp(event)']) {
        source = replaceOnce(source, `  ${signature} {`, `  ${signature} {\n    if (gsmBridge?.navigationActive) return; // GSM hook`);
    }
    for (const signature of ['function syncHostAttention()', 'function bindResultActions(rendered, level)',
        'function positionPopup(fromLevel = rootLevel, resetToolbar = false)']) {
        // bindResultActions refreshes on a microtask, after the new buttons are bound.
        source = replaceOnce(source, `  ${signature} {`, `  ${signature} {\n    queueMicrotask(() => gsmBridge?.refresh()); // GSM hook`);
    }
    source = replaceOnce(source, '  function teardown(reason) {', '  function teardown(reason) {\n    gsmBridge?.destroy(); // GSM hook');
    source = replaceOnce(source, '          resolve(reply);', '          gsmBridge?.requestCompleted(type, reply); // GSM hook\n          resolve(reply);');
    source = replaceOnce(source, '  start();', `  ${hook}\n  start();`);
    return source;
}

export async function prepareIntegration(extensionDir) {
    const content = patchContent(await fs.readFile(path.join(extensionDir, 'content.js'), 'utf8'));
    const manifest = JSON.parse(await fs.readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));
    const scripts = manifest.content_scripts?.filter(item => item.js?.includes('content.js'));
    if (scripts?.length !== 1) throw new Error('Hachidori manifest must declare exactly one reader content script stack.');
    scripts[0].js = scripts[0].js.filter(file => ![...files.values()].includes(file));
    scripts[0].js.splice(scripts[0].js.indexOf('content.js'), 0, ...files.values());
    const assets = new Map();
    for (const [source, destination] of files) {
        const text = await fs.readFile(path.join(overlayRoot, source), 'utf8');
        assets.set(destination, Buffer.from(text.replaceAll('\r\n', '\n')));
    }
    const hash = createHash('sha256').update(content).update(JSON.stringify(manifest.content_scripts));
    for (const [file, bytes] of assets) hash.update(file).update(bytes);
    return { content, manifest, assets, metadata: { version: 1, sha256: hash.digest('hex') } };
}

export async function writeIntegration(targetDir, prepared) {
    await fs.mkdir(path.join(targetDir, 'gsm'), { recursive: true });
    for (const [file, bytes] of prepared.assets) await fs.writeFile(path.join(targetDir, file), bytes);
    await fs.writeFile(path.join(targetDir, 'content.js'), prepared.content);
    await fs.writeFile(path.join(targetDir, 'manifest.json'), `${JSON.stringify(prepared.manifest, null, 2)}\n`);
}

export async function applyIntegration(targetDir = path.join(overlayRoot, 'hachidori')) {
    const prepared = await prepareIntegration(targetDir);
    const sourcePath = path.join(targetDir, 'SOURCE.json');
    const metadata = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
    metadata.gsmIntegration = prepared.metadata;
    const description = 'gsm/ contains GSM-owned bridge and navigation modules; content.js has generated integration hooks.';
    if (!metadata.modifications.includes(description)) metadata.modifications.push(description);
    await writeIntegration(targetDir, prepared);
    await fs.writeFile(sourcePath, `${JSON.stringify(metadata, null, 2)}\n`);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
    await applyIntegration();
    console.log('[hachidori-integration] Regenerated GSM integration.');
}
