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
const engineHostFiles = new Map([
    ['integrations/hachidori/engine-host.html', 'gsm/engine-host.html'],
    ['integrations/hachidori/engine-host.js', 'gsm/engine-host.js'],
    ['integrations/hachidori/native-search.js', 'gsm/native-search.js'],
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
    const nativeOrigin = 'location.protocol === EXTENSION_PROTOCOL && location.host === new URL(chrome.runtime.getURL("")).host';
    source = source.replaceAll(nativeOrigin, 'location.protocol === EXTENSION_PROTOCOL');
    if (source.split('location.protocol === EXTENSION_PROTOCOL').length !== 6) throw new Error('Hachidori extension-origin hook changed upstream');
    source = source.replaceAll('location.protocol === EXTENSION_PROTOCOL', nativeOrigin);
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
        // Coalesce lifecycle/layout callbacks after the new buttons are bound.
        source = replaceOnce(source, `  ${signature} {`, `  ${signature} {\n    gsmBridge?.scheduleRefresh(); // GSM hook`);
    }
    source = replaceOnce(source, '  function teardown(reason) {', '  function teardown(reason) {\n    gsmBridge?.destroy(); // GSM hook');
    source = replaceOnce(source, '          resolve(reply);', '          gsmBridge?.requestCompleted(type, reply); // GSM hook\n          resolve(reply);');
    source = replaceOnce(source, '  start();', `  ${hook}\n  start();`);
    return source;
}

export function patchSearchShell(source) {
    source = source.replaceAll('\r\n', '\n').replace(/^  if \(!chrome\.permissions\).*\/\/ GSM hook\n/gmu, '');
    // Electron has no permissions API. GSM already owns clipboard capture, so
    // omit the extension's optional clipboard monitor while keeping search/mining.
    const anchor = 'function clipboardMonitor(clipboardSwitch, search, language) {';
    return replaceOnce(source, anchor, `${anchor}\n  if (!chrome.permissions) return { shown() {}, ready() {}, copied() {} }; // GSM hook`);
}

export function patchSearchFrame(source) {
    const hook = '    <script type="module" src="gsm/native-search.js"></script> <!-- GSM native search -->\n';
    source = source.replaceAll('\r\n', '\n').replace(hook, '');
    return replaceOnce(source, '    <script type="module" src="search.js"></script>', `${hook}    <script type="module" src="search.js"></script>`);
}

export function patchClipboard(source) {
    source = source.replaceAll('\r\n', '\n').replace(/^  if \(globalThis\.gsmEnv\?\.shell.*\/\/ GSM native clipboard\n/gmu, '');
    const anchor = 'export async function readClipboardText({ document, navigator, firefox }) {';
    return replaceOnce(source, anchor, `${anchor}\n  if (globalThis.gsmEnv?.shell === "tauri") return globalThis.clipboard.readText(); // GSM native clipboard`);
}

export function patchNativeEngine(source) {
    source = source.replaceAll('\r\n', '\n').replace(/^  if \(globalThis\.location\?\.protocol === "gsm-hachidori:"\).*\/\/ GSM native engine\n/gmu, '');
    // WebKit cannot import the engine's module workers from a custom scheme.
    // Its existing local engine runs in our dedicated hidden offscreen page.
    const anchor = 'async function selectEngine() {';
    return replaceOnce(source, anchor, `${anchor}\n  if (globalThis.location?.protocol === "gsm-hachidori:") return "local"; // GSM native engine`);
}

export async function prepareIntegration(extensionDir) {
    const content = patchContent(await fs.readFile(path.join(extensionDir, 'content.js'), 'utf8'));
    const offscreen = await fs.readFile(path.join(extensionDir, 'chrome-offscreen.js'), 'utf8');
    for (const anchor of ['export function chromeOffscreenSupported()', 'export async function ensureChromeOffscreen(url)']) {
        replaceOnce(offscreen, anchor, anchor);
    }
    const manifest = JSON.parse(await fs.readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));
    const scripts = manifest.content_scripts?.filter(item => item.js?.includes('content.js'));
    if (scripts?.length !== 1) throw new Error('Hachidori manifest must declare exactly one reader content script stack.');
    scripts[0].js = scripts[0].js.filter(file => ![...files.values()].includes(file));
    scripts[0].js.splice(scripts[0].js.indexOf('content.js'), 0, ...files.values());
    const assets = new Map([['search-shell.js', Buffer.from(patchSearchShell(await fs.readFile(path.join(extensionDir, 'search-shell.js'), 'utf8')))]]);
    assets.set('search-frame.html', Buffer.from(patchSearchFrame(await fs.readFile(path.join(extensionDir, 'search-frame.html'), 'utf8'))));
    assets.set('offscreen.js', Buffer.from(patchNativeEngine(await fs.readFile(path.join(extensionDir, 'offscreen.js'), 'utf8'))));
    assets.set('search-clipboard.js', Buffer.from(patchClipboard(await fs.readFile(path.join(extensionDir, 'search-clipboard.js'), 'utf8'))));
    for (const [source, destination] of [...files, ...engineHostFiles]) {
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
