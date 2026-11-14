import fs from 'node:fs/promises';
import path from 'node:path';
import {validateReleaseMetadata} from './sync-hachidori.mjs';
import {verifyVocrBundle} from './verify-vocr-package.mjs';
import {auditNativePackage} from './native-package-policy.mjs';

const root=path.resolve(process.argv[2]||'build/native-desktop/app');
for(const relative of [
  'dist/renderer/index.html',
  'assets/scripts/legacy_dictionary_export.py',
  'assets/scripts/vendor/chromium-reader/ccl_chromium_reader/ccl_chromium_indexeddb.py',
  'assets/scripts/vendor/simple-snappy/ccl_simplesnappy/ccl_simplesnappy.py',
  'GSM_Overlay/index.html',
  'GSM_Overlay/yomitan/manifest.json',
  'GSM_Overlay/hachidori/manifest.json',
  'GSM_Overlay/'+(process.platform==='win32'?'gsm_overlay_server.exe':'gsm_overlay_server'),
  'LICENSE',
]) {
  await fs.access(path.join(root,relative));
}
await fs.access(path.join(root,'native/gsm-agent',process.platform==='win32'?'gsm-agent-host.exe':'gsm-agent-host'));
await fs.access(path.join(root,'licenses/frida/FRIDA-COPYING'));
for(const forbidden of ['runtime','node_modules','desktop-runtime','dist/main','dist/shared']) {
  if(await fs.access(path.join(root,forbidden)).then(()=>true,()=>false)) {
    throw Error(`Forbidden Node/JS runtime directory found in staged package: ${forbidden}`);
  }
}
const vendor=JSON.parse(await fs.readFile(path.join(root,'GSM_Overlay/hachidori/SOURCE.json')));
validateReleaseMetadata(vendor.release);
await verifyVocrBundle(path.join(root,'GameSentenceMiner/assets/vocr'));
const audit=await auditNativePackage(root);
console.log(`Audited package contents: ${(audit.total/1024**2).toFixed(1)} MiB, ${audit.count} files, zero Node/Electron runtime payloads.`);
console.log('Verified pure-Rust native services, renderer, both dictionary engines, input server, and licenses.');
