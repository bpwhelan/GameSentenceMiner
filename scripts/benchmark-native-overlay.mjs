// Measure the Rust worker stages on a controlled WGC window after build:tauri.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {nativeExecutable, root} from './native-paths.mjs';

if(process.platform!=='win32')throw Error('The WGC comparison requires Windows.');
const run=(executable,args,env={})=>new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{cwd:root,windowsHide:true,stdio:'inherit',env:{...process.env,...env}});
  child.on('error',reject);
  child.on('exit',code=>code===0?resolve():reject(Error(`${executable} exited with ${code}`)));
});
const cargo=['test','--locked','--manifest-path','src-tauri/Cargo.toml','--target-dir','src-tauri/target/native-dev'];
await run('cargo',[...cargo,'--no-run']);
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gsm-overlay-benchmark-'));
const result=path.join(directory,'fixture.json'),stop=path.join(directory,'stop');
const control=path.join(directory,'control.json'),config=path.join(directory,'config.json');
const fixture=spawn(nativeExecutable(),[],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,
  GSM_APP_ROOT:root,GSM_SMOKE_SUITE:'capture-fixture',
  GSM_PROFILE_DIR:path.join(directory,'profile'),GSM_SMOKE_TEST:'1',GSM_TEST_RESULT:path.join(directory,'exit.json'),
  GSM_FIXTURE_RESULT:result,GSM_FIXTURE_STOP:stop,GSM_FIXTURE_CONTROL:control,
}});
const exited=new Promise((resolve,reject)=>{fixture.on('exit',resolve);fixture.on('error',reject);});
process.on('exit',()=>fixture.kill());
try {
  for(let attempt=0;attempt<150&&!fs.existsSync(result);attempt++)await new Promise(resolve=>setTimeout(resolve,100));
  if(!fs.existsSync(result))throw Error('Capture fixture did not start.');
  const {hwnd}=JSON.parse(fs.readFileSync(result,'utf8'));
  fs.writeFileSync(config,JSON.stringify({target_id:hwnd,fixture_control:control,fixture_stop:stop,
    profile:path.join(process.env.APPDATA,'GameSentenceMiner'),settings:{monitor_to_capture:0}}));
  await run('cargo',[...cargo,'benchmark_overlay_stages','--','--ignored','--nocapture'],{
    GSM_OVERLAY_PROFILE:'1',GSM_OVERLAY_BENCH_CONFIG:config,
  });
} finally {
  fs.writeFileSync(stop,'stop');
  const timeout=setTimeout(()=>fixture.kill(),5000);
  await exited;
  clearTimeout(timeout);
  console.error('Benchmark configuration:',directory);
}
