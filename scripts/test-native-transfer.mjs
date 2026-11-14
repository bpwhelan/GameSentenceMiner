import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {nativeExecutable} from './native-paths.mjs';

const root=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url);
const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'gsm-native-transfer-'));
const environment={...process.env,GSM_LEGACY_FIXTURE:fixture,GSM_APP_ROOT:root,GSM_PROFILE_DIR:path.join(fixture,'profile'),GSM_SMOKE_TEST:'1'};
delete environment.GSM_NODE_EXECUTABLE;delete environment.GSM_TEST_SERVICE;delete environment.ELECTRON_RUN_AS_NODE;

async function run(executable,args,env) {
  await new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd:root,env,windowsHide:true,stdio:'inherit'});
    const timer=setTimeout(()=>{child.kill();reject(Error('Dictionary transfer verification timed out'));},180000);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error(`Transfer fixture failed (${code})`));});
  });
}

const electron=process.env.GSM_LEGACY_ELECTRON||require('electron');
await run(electron,[...(process.platform==='linux'&&process.getuid?.()===0?['--no-sandbox']:[]),path.join(root,'scripts/legacy-fixture.cjs')],environment);
const source=JSON.parse(await fs.readFile(path.join(fixture,'fixture.json'),'utf8'));
// An installed upgrade moves extension resources. Discovery must recover the
// old Chromium identity from its saved settings, not the new installation path.
const upgraded=path.join(fixture,'upgraded-extension');
await fs.cp(source.extensionPath,upgraded,{recursive:true});
source.extensionPath=upgraded;
await fs.writeFile(path.join(fixture,'fixture.json'),JSON.stringify(source));

async function fingerprints() {
  const records={};
  for(const directory of ['IndexedDB','Local Extension Settings','File System']) {
    const base=path.join(source.profile,directory);
    if(!await fs.stat(base).catch(()=>null))continue;
    for(const relative of await fs.readdir(base,{recursive:true})) {
      const filename=path.join(base,relative);if(!(await fs.stat(filename)).isFile())continue;
      records[directory+'/'+relative]=crypto.createHash('sha256').update(await fs.readFile(filename)).digest('hex');
    }
  }
  return JSON.stringify(records);
}

const before=await fingerprints();
const executable=nativeExecutable();
for(const phase of ['import','reopen']) {
  const resultFile=path.join(fixture,`result-${phase}.json`);
  await run(executable,[],{...environment,GSM_SMOKE_PHASE:phase,GSM_TEST_RESULT:resultFile});
  const result=JSON.parse(await fs.readFile(resultFile,'utf8'));
  if(result.code!==0)throw Error(`Native transfer verification failed: ${result.error||''}`);
}
if(await fingerprints()!==before)throw Error('The legacy source profile changed during transfer');
console.log('PASS automatic legacy transfer, settings, native restart persistence, and unchanged source files. Fixture:',fixture);
