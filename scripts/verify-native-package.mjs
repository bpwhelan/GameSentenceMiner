import fs from 'node:fs/promises';
import path from 'node:path';
import {validateReleaseMetadata} from './sync-hachidori.mjs';
import {verifyVocrBundle} from './verify-vocr-package.mjs';
import {auditNativePackage} from './native-package-policy.mjs';

const root=path.resolve(process.argv[2]||'build/native-desktop/app');
for(const relative of [
  'dist/renderer/index.html',
  'resources/locales/en_us.json',
  'resources/assets/fireredvad/fireredvad_vad.onnx',
  'resources/assets/fireredvad/cmvn.ark',
  'resources/assets/silero/silero_vad_v6.onnx',
  'resources/web/templates/components/word_frequency_sources/jiten_global.json',
  'GSM_Overlay/index.html',
  'GSM_Overlay/yomitan/manifest.json',
  'GSM_Overlay/hachidori/manifest.json',
  'GSM_Overlay/'+(process.platform==='win32'?'gsm_overlay_server.exe':'gsm_overlay_server'),
  'LICENSE',
]) {
  await fs.access(path.join(root,relative));
}
const agentRuntime=JSON.parse(await fs.readFile(path.join(root,'native/agent-runtime.json'),'utf8'));
if(agentRuntime.schemaVersion!==1 || agentRuntime.platform!==`${process.platform}-${process.arch}` || !/^[a-f0-9]{64}$/.test(agentRuntime.archive?.sha256))throw Error('Missing pinned Agent runtime metadata');
for(const forbidden of ['runtime','node_modules','desktop-runtime','dist/main','dist/shared']) {
  if(await fs.access(path.join(root,forbidden)).then(()=>true,()=>false)) {
    throw Error(`Forbidden Node/JS runtime directory found in staged package: ${forbidden}`);
  }
}
const vendor=JSON.parse(await fs.readFile(path.join(root,'GSM_Overlay/hachidori/SOURCE.json')));
validateReleaseMetadata(vendor.release);
await verifyVocrBundle(path.join(root,'resources/assets/vocr'), {downloadable: true});
const audit=await auditNativePackage(root);
console.log(`Audited package contents: ${(audit.total/1024**2).toFixed(1)} MiB, ${audit.count} files, zero Node/Electron runtime payloads.`);
console.log('Verified native services, renderer, dictionary engines, input server, and downloadable Agent runtime metadata.');
