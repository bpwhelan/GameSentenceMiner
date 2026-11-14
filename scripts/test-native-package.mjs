import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createDictionaryFixture} from './dictionary-fixture.mjs';

const root=path.resolve(import.meta.dirname,'..');
const target=process.env.CARGO_TARGET_DIR?path.resolve(process.env.CARGO_TARGET_DIR):path.join(root,'src-tauri/target');
const releaseDir=path.join(target,'release');
const builtExecutable=path.join(releaseDir,process.platform==='win32'?'gsm-desktop.exe':'gsm-desktop');
await fs.access(builtExecutable);

// Outside the checkout: a missing packaged dependency must not resolve from
// the developer's checkout. The executable and resources are release builds.
const fixture=await fs.mkdtemp(path.join(os.tmpdir(),'gsm-packaged-check-'));
const executable=path.join(fixture,path.basename(builtExecutable));
await fs.copyFile(builtExecutable,executable);
if(process.platform==='win32') {
  for(const entry of await fs.readdir(releaseDir)) {
    if(entry.endsWith('.dll')) await fs.copyFile(path.join(releaseDir,entry),path.join(fixture,entry));
  }
} else {
  await fs.chmod(executable,0o755);
}
const app=path.join(fixture,'app');
await fs.cp(path.join(root,'build/native-desktop/app'),app,{recursive:true});
for(const forbidden of ['runtime','node_modules','desktop-runtime','dist/main','dist/shared']) {
  if(await fs.access(path.join(app,forbidden)).then(()=>true,()=>false)) {
    throw Error(`Forbidden Node/JS runtime directory found in staged app: ${forbidden}`);
  }
}
await fs.mkdir(path.join(app,'native/gsm-overlay/tests/fixtures'),{recursive:true});
await fs.copyFile(path.join(root,'native/gsm-overlay/tests/fixtures/dialogue.png'),path.join(app,'native/gsm-overlay/tests/fixtures/dialogue.png'));

const scenarios=process.argv.slice(2);
for(const scenario of scenarios.length?scenarios:['windows','workspace','settings','yomitan','hachidori','overlay']) {
  const profile=path.join(fixture,scenario);await fs.mkdir(profile,{recursive:true});
  await createDictionaryFixture(root,path.join(profile,'dictionary.zip'));
  const dictionary=['yomitan','hachidori'].includes(scenario)?scenario:'';
  for(const phase of dictionary?['import','reopen']:['windows']) {
    const resultFile=path.join(profile,`result-${phase}.json`);
    const environment={
      ...process.env,
      PATH:process.platform==='win32'?path.join(process.env.SystemRoot||'C:\\Windows','System32'):'/usr/bin:/bin',
      GSM_APP_ROOT:app,
      GSM_PROFILE_DIR:profile,
      GSM_SMOKE_TEST:'1',
      GSM_PACKAGE_TEST:'1',
      GSM_SMOKE_SCENARIO:scenario,
      GSM_SMOKE_DICTIONARY:dictionary,
      GSM_SMOKE_PHASE:phase,
      GSM_TEST_RESULT:resultFile,
    };
    delete environment.GSM_NODE_EXECUTABLE;
    delete environment.GSM_NATIVE_DEPS;
    delete environment.GSM_TEST_SERVICE;
    delete environment.NODE_PATH;
    const code=await new Promise((resolve,reject)=>{
      const child=spawn(executable,[],{cwd:app,env:environment,stdio:'inherit',windowsHide:true});
      const timer=setTimeout(()=>{console.error(`Packaged ${scenario} timed out`);child.kill();},180000);
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('exit',code=>{clearTimeout(timer);resolve(code??1);});
    });
    const result=await fs.readFile(resultFile,'utf8').then(JSON.parse,()=>null);
    if(code!==0||result?.code!==0)throw Error(`Packaged ${scenario}/${phase} failed (${result?.error||'exit '+code}); evidence: ${profile}`);
  }
  console.log(`PASS packaged ${scenario}`);
}
console.log('Packaged application verification evidence:',fixture);
