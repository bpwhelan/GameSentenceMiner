import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {signingEnvironment} from './native-signing.mjs';
import {auditNativePackage} from './native-package-policy.mjs';
import {nativeTargetDirectory} from './native-paths.mjs';

const root=path.resolve(import.meta.dirname,'..');
const args=process.argv.slice(2),signed=args.includes('--signed');
const portablePreview=args.includes('--portable-preview');
if (portablePreview && (signed || args.includes('--debug'))) {
  throw Error('Build the portable preview as an unsigned release-profile application.');
}
const environment=signed?await signingEnvironment():{...process.env};
const stagedApp = path.join(root, 'build/native-desktop/app');
await auditNativePackage(stagedApp);
if (portablePreview) await fs.access(path.join(stagedApp, 'native/agent-runtime.zip'));
for (const name of ['APPLE_SIGNING_IDENTITY','APPLE_CERTIFICATE','APPLE_CERTIFICATE_PASSWORD','APPLE_ID','APPLE_PASSWORD','APPLE_TEAM_ID']) {
  if (!environment[name]) delete environment[name];
}
const bundles=process.platform==='win32'?'nsis':process.platform==='darwin'?'app,dmg':'appimage,deb';
const config={bundle:{createUpdaterArtifacts:signed}};
if (portablePreview) {
  config.productName = 'GSM Preview';
  config.mainBinaryName = 'gsm-desktop';
  config.identifier = 'com.beangate.gamesentenceminer.preview';
  if (process.platform === 'darwin') config.bundle.macOS = {signingIdentity: '-'};
}
const macOrt = process.platform === 'darwin' && process.arch === 'x64' && environment.GSM_MACOS_ORT_DIR;
if (macOrt) {
  const library = path.join(macOrt, 'libonnxruntime.1.24.2.dylib');
  config.bundle.macOS ??= {};
  config.bundle.macOS.frameworks = [library];
  config.bundle.resources = {
    [path.join(macOrt, 'LICENSE')]: 'onnxruntime/LICENSE',
    [path.join(macOrt, 'ThirdPartyNotices.txt')]: 'onnxruntime/ThirdPartyNotices.txt',
  };
}
const cli=['node_modules/@tauri-apps/cli/tauri.js','build','--ci','--config','src-tauri/tauri.bundle.conf.json','--config',JSON.stringify(config)];
if (portablePreview) {
  cli.push('--features', 'portable-preview');
  if (process.platform === 'win32') cli.push('--no-bundle');
  else cli.push('--bundles', process.platform === 'darwin' ? 'app' : 'appimage');
} else {
  cli.push('--bundles', bundles);
}
if(args.includes('--debug'))cli.push('--debug');
if(args.includes('--no-bundle'))cli.push('--no-bundle');
await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,cli,{cwd:root,env:environment,stdio:'inherit',windowsHide:true});
  child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`Native application build failed (${code})`)));
});
if(process.platform==='win32'&&!args.includes('--debug')&&!portablePreview) {
  const target=await nativeTargetDirectory({env:environment});
  const executable=path.join(target,'release/gsm-desktop.exe');
  if((await fs.stat(executable)).size>50*1024**2)throw Error('Desktop executable exceeds the 50 MiB budget; check for duplicated embedded resources.');
  if(!args.includes('--no-bundle')) {
    const config=JSON.parse(await fs.readFile(path.join(root,'src-tauri/tauri.conf.json')));
    const installer=path.join(target,'release/bundle/nsis',`${config.productName}_${config.version}_${process.arch}-setup.exe`);
    if(!signed)await fs.rm(installer+'.sig',{force:true}); // Never reuse a signature from an earlier build.
    const bytes=(await fs.stat(installer)).size;
    if(bytes>160*1024**2)throw Error('Windows installer exceeds the 160 MiB budget; inspect the package size report.');
    console.log(`Windows installer: ${(bytes/1024**2).toFixed(1)} MiB`);
    console.log('Installer file:',installer);
  }
}
