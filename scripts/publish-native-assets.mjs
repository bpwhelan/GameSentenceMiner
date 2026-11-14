import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
const directory=path.resolve('dist/native-release'),version=process.env.GSM_RELEASE_VERSION;
if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version||''))throw Error('Invalid coordinated desktop version');
const repository=process.env.GITHUB_REPOSITORY;
if(repository!=='bpwhelan/GameSentenceMiner')throw Error('Release publishing is restricted to the GSM repository');
const tag=`v${version}`,prerelease=process.env.GSM_RELEASE_PRERELEASE==='true';
async function gh(args,allowFailure=false) {
  const code=await new Promise((resolve,reject)=>{const child=spawn('gh',args,{stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',resolve);});
  if(code&&!allowFailure)throw Error(`Release operation failed (${code})`);
  return code===0;
}
const exists=await gh(['release','view',tag,'--repo',repository,'--json','tagName'],true);
if(exists&&process.env.GSM_RELEASE_FORCE!=='true')throw Error('This release already exists. Select force_rebuild to replace its assets.');
// A new release stays a draft until every installer, migration feed and signed
// native manifest has been uploaded. A partial upload cannot become an update.
if(!exists)await gh(['release','create',tag,'--repo',repository,'--draft','--target',process.env.GITHUB_SHA,'--title',`Release ${tag}`,'--notes-file',path.join(directory,'release-notes.md'),...(prerelease?['--prerelease']:[])]);
const files=(await fs.readdir(directory,{recursive:true})).filter(name=>!['tauri-platform.json','release-notes.md'].includes(path.basename(name)));
const assets=[];const names=new Set();
for(const name of files){const filename=path.join(directory,name);if(!(await fs.stat(filename)).isFile())continue;const base=path.basename(name);if(names.has(base))throw Error(`Duplicate release asset: ${base}`);names.add(base);assets.push(filename);}
await gh(['release','upload',tag,'--repo',repository,'--clobber',...assets]);
await gh(['release','edit',tag,'--repo',repository,'--draft=false',`--prerelease=${prerelease}`,'--notes-file',path.join(directory,'release-notes.md')]);
