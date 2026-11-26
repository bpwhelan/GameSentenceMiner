import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyVocrBundle} from './verify-vocr-package.mjs';
import {includeSource, stageChangelog, auditNativePackage} from './native-package-policy.mjs';
import {packageAgentRuntime} from './package-agent-runtime.mjs';
import {nativeTargetDirectory} from './native-paths.mjs';

const root=path.resolve(import.meta.dirname,'..');
export const destination=path.join(root,'build','native-desktop','app');
const exists=filename=>fs.access(filename).then(()=>true,()=>false);
async function run(executable,args,options={}) {
  await new Promise((resolve,reject)=>{const child=spawn(executable,args,{cwd:root,stdio:'inherit',windowsHide:true,...options});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`${path.basename(executable)} failed (${code})`)));});
}
async function copy(source,target,filter) {
  await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.cp(source,target,{recursive:true,filter});
}
export async function stageNativeDesktop({portablePreview = false} = {}) {
  const parent=path.dirname(destination);await fs.mkdir(parent,{recursive:true});
  if(await fs.realpath(parent)!==path.join(await fs.realpath(root),'build','native-desktop'))throw Error('Unexpected native staging directory');
  const marker=path.join(parent,'.gsm-native-stage');
  if(await exists(destination)) {
    if(!await exists(marker))throw Error('Refusing to replace an unowned native staging directory');
    if(await fs.realpath(destination)!==path.join(await fs.realpath(parent),'app'))throw Error('Native staging directory must not be a link');
    await fs.rm(destination,{recursive:true});
  }
  await fs.writeFile(marker,'GSM generated native application resources\n');
  await fs.mkdir(destination,{recursive:true});
  const sourceFilter=filename=>includeSource(path.relative(root,filename));
  for(const directory of ['dist/renderer','GameSentenceMiner/assets','GameSentenceMiner/locales','GameSentenceMiner/web/templates/components/word_frequency_sources']) {
    await copy(path.join(root,directory),path.join(destination,directory),filename=>sourceFilter(filename)&&!path.basename(filename).startsWith('desktop_bridge.'));
  }
  await verifyVocrBundle(path.join(destination,'GameSentenceMiner/assets/vocr'), {downloadable: true});
  await copy(path.join(root,'assets'),path.join(destination,'assets'),sourceFilter);
  await copy(path.join(root,'electron-src/assets'),path.join(destination,'assets'),filename=>sourceFilter(filename)&&!['texthook','changelog','old icon'].includes(path.basename(filename)));
  const packageInfo=JSON.parse(await fs.readFile(path.join(root,'package.json')));
  await stageChangelog(path.join(root,'electron-src/assets/changelog'),path.join(destination,'assets/changelog'),packageInfo.version);
  await copy(path.join(root,'GSM_Overlay'),path.join(destination,'GSM_Overlay'),filename=>sourceFilter(filename)&&!['input_server','scripts','forge.config.js','package-lock.json'].includes(path.basename(filename)));
  const overlayPackage=JSON.parse(await fs.readFile(path.join(root,'GSM_Overlay/package.json')));
  await fs.writeFile(path.join(destination,'GSM_Overlay/package.json'),JSON.stringify({name:overlayPackage.name,version:overlayPackage.version,main:'main.js',type:'commonjs'}));
  await copy(path.join(root,'LICENSE'),path.join(destination,'LICENSE'));
  const agentTarget=await nativeTargetDirectory({manifest:'native/gsm-agent/Cargo.toml'});
  const inputTarget=await nativeTargetDirectory({manifest:'GSM_Overlay/input_server/Cargo.toml'});
  await run('cargo',['build','--locked','--release','--manifest-path','native/gsm-agent/Cargo.toml','--bin','gsm-agent-host','--target-dir',agentTarget]);
  const agentName=process.platform==='win32'?'gsm-agent-host.exe':'gsm-agent-host';
  const {manifest, archive} = await packageAgentRuntime({
    executable: path.join(agentTarget,'release',agentName),
    output: path.join(parent,'agent-runtime'), version: packageInfo.version,
  });
  await fs.mkdir(path.join(destination,'native'),{recursive:true});
  await fs.writeFile(path.join(destination,'native/agent-runtime.json'),JSON.stringify(manifest,null,2));
  if (portablePreview) await copy(archive, path.join(destination, 'native/agent-runtime.zip'));
  const server=process.platform==='win32'?'gsm_overlay_server.exe':'gsm_overlay_server';
  const serverCandidates=[
    path.join(inputTarget,'release',server),
    ...['target/release','bin/'+process.platform,'bin'].map(directory=>path.join(root,'GSM_Overlay/input_server',directory,server)),
  ];
  const serverSource=(await Promise.all(serverCandidates.map(async filename=>await exists(filename)?filename:null))).find(Boolean);
  if(!serverSource)throw Error('Build the native input server before staging the application');
  await copy(serverSource,path.join(destination,'GSM_Overlay',server));
  if(process.platform!=='win32')await fs.chmod(path.join(destination,'GSM_Overlay',server),0o755);
  for(const relative of process.platform==='win32' ? ['native/windows-audio-capture','native/windows-speech-recognition'].map(directory=>`${directory}/bin/${process.arch==='arm64'?'arm64':'x64'}`) : []) {
    if(await exists(path.join(root,relative)))await copy(path.join(root,relative),path.join(destination,relative),sourceFilter);
  }
  if(process.platform==='win32') {
    if(!await exists(path.join(root,'build/game-background-hooks')))throw Error('Build Windows game helpers before staging');
    await copy(path.join(root,'build/game-background-hooks'),path.join(destination,'native/game-background-hooks'),sourceFilter);
  }
  const audit=await auditNativePackage(destination);
  await fs.writeFile(path.join(parent,'size-report.json'),JSON.stringify(audit,null,2));
  console.log(`Application resources: ${(audit.total/1024**2).toFixed(1)} MiB in ${audit.count} files`);
  console.log('Staged pure-Rust native GSM with zero Node/Electron runtime:',destination);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  await stageNativeDesktop({portablePreview: process.argv.includes('--portable-preview')});
}
