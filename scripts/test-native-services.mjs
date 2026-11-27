import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {nativeExecutable} from './native-paths.mjs';

const root=path.resolve(import.meta.dirname,'..');
const appRoot = process.env.GSM_SMOKE_APP_DIR || root;
const executable=nativeExecutable();
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'gsm-native-services-'));
const modes=process.argv.slice(2);
const targets=modes.length?modes:['services'];

for(const mode of targets) {
  const profile=path.join(temp,mode);
  await fs.mkdir(profile,{recursive:true});
  const resultFile=path.join(profile,'result.json');
  const env={
    ...process.env,
    ...(process.platform === 'win32' ? {PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')} : {}),
    GSM_APP_ROOT:appRoot,
    GSM_PROFILE_DIR:profile,
    GSM_SMOKE_TEST:'1',
    GSM_SMOKE_SUITE:mode,
    GSM_TEST_RESULT:resultFile,
  };
  delete env.GSM_NODE_EXECUTABLE;delete env.GSM_TEST_SERVICE;delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_PATH;
  await new Promise((resolve,reject)=>{
    const child=spawn(executable,[],{cwd:appRoot,env,windowsHide:true,stdio:'inherit'});
    const timer=setTimeout(()=>{child.kill();reject(Error(`Native service smoke timed out (${mode})`));},180000);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error(`Native service smoke failed (${mode}: ${code})`));});
  });
  const result=JSON.parse(await fs.readFile(resultFile,'utf8'));
  if(result.code!==0)throw Error(`Native service smoke did not finish cleanly (${mode}): ${result.error||''}`);
  console.log(`PASS native service ${mode}`);
}
