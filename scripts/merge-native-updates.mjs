import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {verifyNativeFile} from './verify-native-signature.mjs';
const directory=path.resolve(process.argv[2]||'dist/native-release');
const entries=await fs.readdir(directory,{recursive:true});
const manifests=await Promise.all(entries.filter(name=>path.basename(name)==='tauri-platform.json').map(async name=>JSON.parse(await fs.readFile(path.join(directory,name)))));
if(!manifests.length)throw Error('No native update manifests were found');
const version=manifests[0].version,platforms={};
for(const manifest of manifests){if(manifest.version!==version)throw Error('Native release versions do not match');for(const [name,platform] of Object.entries(manifest.platforms)){if(platforms[name])throw Error(`Duplicate native release platform: ${name}`);platforms[name]=platform;}}
for(const [name,platform] of Object.entries(platforms))if(!platform.signature||!platform.url.startsWith('https://github.com/bpwhelan/GameSentenceMiner/releases/download/'))throw Error(`Missing signature or invalid update URL for ${name}`);
for(const platform of ['windows-x86_64','linux-x86_64','darwin-aarch64','darwin-x86_64'])if(!platforms[platform])throw Error(`Missing native release platform: ${platform}`);
const config=JSON.parse(await fs.readFile(new URL('../src-tauri/tauri.conf.json',import.meta.url)));
for(const [name,platform] of Object.entries(platforms)) {
  const filename=decodeURIComponent(new URL(platform.url).pathname.split('/').at(-1));
  const candidates=entries.filter(entry=>path.basename(entry)===filename);
  if(candidates.length!==1)throw Error(`Missing or duplicate update artifact for ${name}`);
  await verifyNativeFile(path.join(directory,candidates[0]),platform.signature,config.plugins.updater.pubkey,version);
}
await fs.writeFile(path.join(directory,'tauri-latest.json'),JSON.stringify({version,notes:'See the in-app changelog for this release.',pub_date:new Date().toISOString(),platforms},null,2));
// Electron's installed updater can deliver the first native release. JSON is
// valid YAML and avoids introducing a second metadata serialization library.
const releaseDate=new Date().toISOString();
for(const [suffix,filter] of [
  ['',name=>name===`GameSentenceMiner-Setup-${version}.exe`],
  ['-linux',name=>name===`GameSentenceMiner-${version}.AppImage`],
  ['-mac',name=>name===`GameSentenceMiner-${version}-arm64.zip`||name===`GameSentenceMiner-${version}-x64.zip`],
]) {
  const files=[];
  for(const relative of entries.filter(name=>filter(path.basename(name)))) {
    const data=await fs.readFile(path.join(directory,relative));
    files.push({url:path.basename(relative),sha512:crypto.createHash('sha512').update(data).digest('base64'),size:data.length});
  }
  if(files.length!==(suffix==='-mac'?2:1))throw Error(`Missing legacy migration update assets for ${suffix||'Windows'}`);
  const metadata={version,files,path:files[0].url,sha512:files[0].sha512,releaseDate};
  const channels=version.includes('-')?['latest',version.split('-')[1].split('.')[0]]:['latest'];
  for(const channel of channels)await fs.writeFile(path.join(directory,`${channel}${suffix}.yml`),JSON.stringify(metadata,null,2));
}
console.log('Validated update manifest for Windows, Linux, Apple silicon and Intel macOS.');
