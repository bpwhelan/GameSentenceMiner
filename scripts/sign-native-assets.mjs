import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {signingEnvironment} from './native-signing.mjs';
import {verifyNativeFile} from './verify-native-signature.mjs';
const root=path.resolve(import.meta.dirname,'..');
const directory=path.resolve(process.argv[2]||`dist/native-release/${process.platform}-${process.arch}`);
const manifestPath=path.join(directory,'tauri-platform.json');
const manifest=JSON.parse(await fs.readFile(manifestPath));
const env=await signingEnvironment();
const config=JSON.parse(await fs.readFile(path.join(root,'src-tauri/tauri.conf.json')));
for(const platform of Object.values(manifest.platforms)) {
  const name=decodeURIComponent(new URL(platform.url).pathname.split('/').at(-1));
  if(path.basename(name)!==name)throw Error('Invalid native update filename');
  const filename=path.join(directory,name);
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['node_modules/@tauri-apps/cli/tauri.js','signer','sign','--app-version',manifest.version,filename],{cwd:root,env,stdio:'inherit',windowsHide:true});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`Update signing failed (${code})`)));
  });
  platform.signature=(await fs.readFile(filename+'.sig','utf8')).trim();
  await verifyNativeFile(filename,platform.signature,config.plugins.updater.pubkey,manifest.version);
}
await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2));
