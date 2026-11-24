import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {packagePortable} from './package-native-portable.mjs';
import {verifyAgentRuntimeArchive} from './package-agent-runtime.mjs';
import {nativeTargetDirectory} from './native-paths.mjs';

const root=path.resolve(import.meta.dirname,'..');
const packageInfo=JSON.parse(await fs.readFile(path.join(root,'package.json')));
const version=packageInfo.version;
const profile=process.argv.includes('--debug')?'debug':'release';
const target=await nativeTargetDirectory();
const binaryRoot=path.join(target,profile),bundle=path.join(binaryRoot,'bundle');
const output=path.join(root,'dist/native-release',process.platform+'-'+process.arch);await fs.mkdir(output,{recursive:true});
const agentRuntime=JSON.parse(await fs.readFile(path.join(root,'build/native-desktop/app/native/agent-runtime.json'),'utf8'));
const runtimeAsset=new URL(agentRuntime.archive.url).pathname.split('/').at(-1);
if(!agentRuntime.archive.url.includes(`/releases/download/v${version}/`))throw Error('Agent runtime release version does not match the desktop');
const runtimeSource=path.join(root,'build/native-desktop/agent-runtime',runtimeAsset);
await verifyAgentRuntimeArchive(agentRuntime,runtimeSource);
await fs.copyFile(runtimeSource,path.join(output,runtimeAsset));
await fs.writeFile(path.join(output,`agent-runtime-${process.platform}-${process.arch}.json`),JSON.stringify(agentRuntime,null,2));
const oldManifest=await fs.readFile(path.join(output,'tauri-platform.json'),'utf8').then(JSON.parse,()=>null);
if(oldManifest&&oldManifest.version!==version)throw Error('The native release output contains a different version. Select a clean output folder before collecting this build.');
const files=await fs.readdir(bundle,{recursive:true});
const platforms={};
for(const relative of files) {
  // Bundlers also leave staging trees here, including helper executables inside .app/.
  if(!/^(?:nsis\/[^/]+-setup\.exe|appimage\/[^/]+\.AppImage|deb\/[^/]+\.deb|dmg\/[^/]+\.dmg|macos\/[^/]+\.app\.tar\.gz)$/.test(relative.split(path.sep).join('/')))continue;
  const source=path.join(bundle,relative),extension=path.basename(relative);
  let name=extension;
  if(extension.endsWith('.exe'))name=`GameSentenceMiner-Setup-${version}.exe`;
  else if(extension.endsWith('.AppImage'))name=`GameSentenceMiner-${version}.AppImage`;
  else if(extension.endsWith('.dmg'))name=`GameSentenceMiner-${version}-${process.arch}.dmg`;
  else if(extension.endsWith('.app.tar.gz'))name=`GameSentenceMiner-${version}-${process.arch}.app.tar.gz`;
  await fs.copyFile(source,path.join(output,name));
  if(/\.(exe|AppImage|deb|app\.tar\.gz)$/.test(relative)) {
    let signature;try{signature=(await fs.readFile(source+'.sig','utf8')).trim();await fs.copyFile(source+'.sig',path.join(output,name+'.sig'));}catch(error){if(error.code!=='ENOENT')throw error;await fs.rm(path.join(output,name+'.sig'),{force:true});}
    const os = process.platform === 'win32' ? 'windows' : process.platform;
    const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch;
    const target = `${os}-${arch}${extension.endsWith('.deb') ? '-deb' : ''}`;
    if (platforms[target]) throw Error(`Duplicate updater artifact for ${target}`);
    platforms[target]={signature:signature||'',url:`https://github.com/bpwhelan/GameSentenceMiner/releases/download/v${version}/${encodeURIComponent(name)}`};
  }
}
if(process.platform==='win32') {
  const portable=path.join(root,'build/native-desktop/portable');
  if(await fs.access(portable).then(()=>true,()=>false)) {
    const parent=await fs.realpath(path.join(root,'build/native-desktop'));
    if(await fs.realpath(portable)!==path.join(parent,'portable'))throw Error('Portable staging folder must not be a link');
    await fs.access(path.join(parent,'.gsm-native-stage'));
    await fs.rm(portable,{recursive:true});
  }
  await fs.mkdir(portable,{recursive:true});
  await fs.copyFile(path.join(binaryRoot,'gsm-desktop.exe'),path.join(portable,'GameSentenceMiner.exe'));
  await fs.cp(path.join(root,'build/native-desktop/app'),path.join(portable,'app'),{recursive:true});
  const filename=path.join(output,`GameSentenceMiner-${version}-win-unpacked.zip`);
  await packagePortable(portable,filename);
} else if(process.platform==='darwin' && !version.includes('-preview.')) {
  const app=(await fs.readdir(path.join(bundle,'macos'))).find(name=>name.endsWith('.app'));
  if(!app)throw Error('The macOS app bundle is missing');
  await new Promise((resolve,reject)=>{
    const child=spawn('ditto',['-c','-k','--sequesterRsrc','--keepParent',path.join(bundle,'macos',app),path.join(output,`GameSentenceMiner-${version}-${process.arch}.zip`)],{stdio:'inherit'});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Could not package the macOS migration update')));
  });
}
await fs.writeFile(path.join(output,'tauri-platform.json'),JSON.stringify({version,platforms},null,2));
console.log('Native release assets:',output);
