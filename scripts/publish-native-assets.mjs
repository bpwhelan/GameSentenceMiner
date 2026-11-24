import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
const directory=path.resolve('dist/native-release'),version=process.env.GSM_RELEASE_VERSION;
if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version||''))throw Error('Invalid coordinated desktop version');
const repository=process.env.GITHUB_REPOSITORY;
if(repository!=='bpwhelan/GameSentenceMiner')throw Error('Release publishing is restricted to the GSM repository');
const tag=`v${version}`,prerelease=process.env.GSM_RELEASE_PRERELEASE==='true';
if (prerelease !== version.includes('-')) throw Error('Release type must match the coordinated desktop version');
const manifest = JSON.parse(await fs.readFile(path.join(directory, 'tauri-latest.json'), 'utf8'));
if (manifest.version !== version) throw Error('The signed update manifest does not match the release tag');
async function gh(args) {
  const code=await new Promise((resolve,reject)=>{const child=spawn('gh',args,{stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',resolve);});
  if(code!==0)throw Error(`Release operation failed (${code})`);
}
const lookup = spawnSync('gh', [
  'release', 'view', tag, '--repo', repository, '--json', 'isDraft,isPrerelease,targetCommitish',
], {encoding: 'utf8', windowsHide: true});
if (lookup.error) throw lookup.error;
const release = lookup.status === 0 ? JSON.parse(lookup.stdout) : null;
if (release && process.env.GSM_RELEASE_FORCE !== 'true') {
  // A retry can finish its own partial draft. Published versions are immutable here.
  if (!release.isDraft || release.targetCommitish !== process.env.GITHUB_SHA || release.isPrerelease !== prerelease) {
    throw Error('This version already belongs to another release.');
  }
}
// A new release stays a draft until every installer, migration feed and signed
// native manifest has been uploaded. A partial upload cannot become an update.
if(!release)await gh(['release','create',tag,'--repo',repository,'--draft','--target',process.env.GITHUB_SHA,'--title',`Release ${tag}`,'--notes-file',path.join(directory,'release-notes.md'),...(prerelease?['--prerelease']:[])]);
const files=(await fs.readdir(directory,{recursive:true})).filter(name=>!['tauri-platform.json','release-notes.md'].includes(path.basename(name)));
const assets=[];const names=new Set();
for(const name of files){const filename=path.join(directory,name);if(!(await fs.stat(filename)).isFile())continue;const base=path.basename(name);if(names.has(base))throw Error(`Duplicate release asset: ${base}`);names.add(base);assets.push(filename);}
await gh(['release','upload',tag,'--repo',repository,'--clobber',...assets]);
await gh(['release','edit',tag,'--repo',repository,'--draft=false',`--prerelease=${prerelease}`,...(prerelease?['--latest=false']:[]),'--notes-file',path.join(directory,'release-notes.md')]);
