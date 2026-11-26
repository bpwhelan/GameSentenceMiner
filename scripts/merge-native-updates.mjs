import fs from 'node:fs/promises';
import path from 'node:path';
import {electronUpdateMetadata} from './electron-update-metadata.mjs';
import {verifyNativeFile} from './verify-native-signature.mjs';
import {verifyAgentRuntimeArchive} from './package-agent-runtime.mjs';
const directory=path.resolve(process.argv[2]||'dist/native-release');
const entries=await fs.readdir(directory,{recursive:true});
const manifests=await Promise.all(entries.filter(name=>path.basename(name)==='tauri-platform.json').map(async name=>JSON.parse(await fs.readFile(path.join(directory,name)))));
if(!manifests.length)throw Error('No native update manifests were found');
const version=manifests[0].version,platforms={};
for(const manifest of manifests){if(manifest.version!==version)throw Error('Native release versions do not match');for(const [name,platform] of Object.entries(manifest.platforms)){if(platforms[name])throw Error(`Duplicate native release platform: ${name}`);platforms[name]=platform;}}
for(const [name,platform] of Object.entries(platforms))if(!platform.signature||!platform.url.startsWith(`https://github.com/bpwhelan/GameSentenceMiner/releases/download/v${version}/`))throw Error(`Missing signature or invalid update URL for ${name}`);
for(const platform of ['windows-x86_64','linux-x86_64','linux-x86_64-deb','darwin-aarch64','darwin-x86_64'])if(!platforms[platform])throw Error(`Missing native release platform: ${platform}`);
// Every installer must have its pinned first-use runtime in the same release.
for(const platform of ['win32-x64','linux-x64','darwin-arm64','darwin-x64']) {
  const records=entries.filter(entry=>path.basename(entry)===`agent-runtime-${platform}.json`);
  if(records.length!==1)throw Error(`Missing or duplicate Agent runtime metadata for ${platform}`);
  const runtime=JSON.parse(await fs.readFile(path.join(directory,records[0]),'utf8'));
  if(runtime.platform!==platform || !runtime.archive?.url?.startsWith(`https://github.com/bpwhelan/GameSentenceMiner/releases/download/v${version}/`))throw Error(`Agent runtime version/platform mismatch: ${platform}`);
  const name=new URL(runtime.archive.url).pathname.split('/').at(-1);
  const archives=entries.filter(entry=>path.basename(entry)===name);
  if(archives.length!==1)throw Error(`Missing or duplicate Agent runtime archive for ${platform}`);
  await verifyAgentRuntimeArchive(runtime,path.join(directory,archives[0]));
}
const config=JSON.parse(await fs.readFile(new URL('../src-tauri/tauri.conf.json',import.meta.url)));
for(const [name,platform] of Object.entries(platforms)) {
  const filename=decodeURIComponent(new URL(platform.url).pathname.split('/').at(-1));
  const candidates=entries.filter(entry=>path.basename(entry)===filename);
  if(candidates.length!==1)throw Error(`Missing or duplicate update artifact for ${name}`);
  await verifyNativeFile(path.join(directory,candidates[0]),platform.signature,config.plugins.updater.pubkey,version);
}
await fs.writeFile(path.join(directory,'tauri-latest.json'),JSON.stringify({version,notes:'See the in-app changelog for this release.',pub_date:new Date().toISOString(),platforms},null,2));
console.log('Validated update manifest for Windows, Linux, Apple silicon and Intel macOS.');
if (version.includes('-preview.')) {
  console.log('Publishing this preview to Tauri clients only.');
  process.exit(0);
}
// Electron's installed updater can deliver the first native release. JSON is
// valid YAML and avoids introducing a second metadata serialization library.
for(const [suffix,filter] of [
  ['',name=>name===`GameSentenceMiner-Setup-${version}.exe`],
  ['-linux',name=>name===`GameSentenceMiner-${version}.AppImage`],
  ['-mac',name=>name===`GameSentenceMiner-${version}-arm64.zip`||name===`GameSentenceMiner-${version}-x64.zip`],
]) {
  const artifacts=entries.filter(name=>filter(path.basename(name))).map(name=>path.join(directory,name));
  if(artifacts.length!==(suffix==='-mac'?2:1))throw Error(`Missing legacy migration update assets for ${suffix||'Windows'}`);
  const metadata=await electronUpdateMetadata(version,artifacts);
  const channels=version.includes('-')?['latest',version.split('-')[1].split('.')[0]]:['latest'];
  for(const channel of channels)await fs.writeFile(path.join(directory,`${channel}${suffix}.yml`),JSON.stringify(metadata,null,2));
}
