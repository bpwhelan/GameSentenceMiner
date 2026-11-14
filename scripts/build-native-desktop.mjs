import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {signingEnvironment} from './native-signing.mjs';
import {auditNativePackage} from './native-package-policy.mjs';

const root=path.resolve(import.meta.dirname,'..');
const args=process.argv.slice(2),signed=args.includes('--signed');
const environment=signed?await signingEnvironment():{...process.env};
await auditNativePackage(path.join(root,'build/native-desktop/app'));
for (const name of ['APPLE_SIGNING_IDENTITY','APPLE_CERTIFICATE','APPLE_CERTIFICATE_PASSWORD','APPLE_ID','APPLE_PASSWORD','APPLE_TEAM_ID']) {
  if (!environment[name]) delete environment[name];
}
const bundles=process.platform==='win32'?'nsis':process.platform==='darwin'?'app,dmg':'appimage,deb';
const cli=['node_modules/@tauri-apps/cli/tauri.js','build','--ci','--config','src-tauri/tauri.bundle.conf.json','--config',JSON.stringify({bundle:{createUpdaterArtifacts:signed}}),'--bundles',bundles];
if(args.includes('--debug'))cli.push('--debug');
if(args.includes('--no-bundle'))cli.push('--no-bundle');
await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,cli,{cwd:root,env:environment,stdio:'inherit',windowsHide:true});
  child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`Native application build failed (${code})`)));
});
if(process.platform==='win32'&&!args.includes('--debug')) {
  const target=process.env.CARGO_TARGET_DIR?path.resolve(process.env.CARGO_TARGET_DIR):path.join(root,'src-tauri/target');
  const executable=path.join(target,'release/gsm-desktop.exe');
  if((await fs.stat(executable)).size>50*1024**2)throw Error('Desktop executable exceeds the 50 MiB budget; check for duplicated embedded resources.');
  if(!args.includes('--no-bundle')) {
    const config=JSON.parse(await fs.readFile(path.join(root,'src-tauri/tauri.conf.json')));
    const installer=path.join(target,'release/bundle/nsis',`${config.productName}_${config.version}_${process.arch}-setup.exe`);
    if(!signed)await fs.rm(installer+'.sig',{force:true}); // Never reuse a signature from an earlier build.
    const bytes=(await fs.stat(installer)).size;
    if(bytes>160*1024**2)throw Error('Windows installer exceeds the 160 MiB budget; inspect the package size report.');
    console.log(`Windows installer: ${(bytes/1024**2).toFixed(1)} MiB`);
  }
}
