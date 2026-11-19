import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDictionaryFixture} from './dictionary-fixture.mjs';
import {nativeExecutable} from './native-paths.mjs';

const root=path.resolve(import.meta.dirname,'..');
const executable=nativeExecutable();
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'gsm-native-smoke-'));
const modes=process.argv.slice(2);
const targets=modes.length?modes:['runtime','foundation','yomitan','hachidori','home','overlay'];

for(const mode of targets) {
  const profile=path.join(temp,mode);await fs.mkdir(profile,{recursive:true});
  // Give the workspace check neither a checkout .venv nor a managed Python.
  const appRoot = mode === 'workspace' ? path.join(profile, 'app') : root;
  if (mode === 'workspace') {
    await fs.cp(path.join(root, 'dist', 'renderer'), path.join(appRoot, 'dist', 'renderer'), {recursive: true});
    // A raw cargo binary has no sibling input helper. Stage the built native
    // helper alone so the isolated wizard can exercise real dictionary setup.
    const helper = process.platform === 'win32' ? 'gsm_overlay_server.exe' : 'gsm_overlay_server';
    if (!(await fs.stat(path.join(path.dirname(executable), helper)).catch(() => null))?.isFile()) {
      const relative = 'GSM_Overlay/input_server/target/release';
      await fs.mkdir(path.join(appRoot, relative), {recursive: true});
      await fs.copyFile(path.join(root, relative, helper), path.join(appRoot, relative, helper));
    }
  }
  if(mode==='yomitan'||mode==='hachidori')await createDictionaryFixture(root,path.join(profile,'dictionary.zip'));
  const phases=mode==='yomitan'||mode==='hachidori'?['import','reopen']:['run'];
  for(const phase of phases) {
    const resultFile=path.join(profile,`result-${phase}.json`);
    const env={
      ...process.env,
      ...(process.platform === 'win32' ? {PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')} : {}),
      ...(mode === 'workspace' ? {
        GSM_SHARED_DATA_DIR: profile,
        PATH: process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') : appRoot,
      } : {}),
      GSM_APP_ROOT:appRoot,
      GSM_PROFILE_DIR:profile,
      GSM_SMOKE_TEST:'1',
      GSM_SMOKE_SUITE:mode,
      GSM_SMOKE_DICTIONARY:mode==='yomitan'||mode==='hachidori'?mode:'',
      GSM_SMOKE_PHASE:phase,
      GSM_TEST_RESULT:resultFile,
    };
    delete env.GSM_NODE_EXECUTABLE;delete env.GSM_TEST_SERVICE;delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_PATH;
    if (mode === 'workspace') {
      delete env.VITE_DEV_SERVER_URL;
      delete env.GSM_INPUT_SERVER_URL;
      delete env.GSM_MIGRATION_PYTHON;
    }
    await new Promise((resolve,reject)=>{
      const child=spawn(executable,[],{cwd:appRoot,env,windowsHide:true,stdio:'inherit'});
      const timer=setTimeout(()=>{child.kill();reject(Error(`Native smoke timed out (${mode}/${phase})`));},180000);
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error(`Native smoke failed (${mode}/${phase}: ${code})`));});
    });
    const result=JSON.parse(await fs.readFile(resultFile,'utf8'));
    if(result.code!==0)throw Error(`Native smoke did not finish cleanly (${mode}/${phase}): ${result.error||''}`);
    console.log(`PASS native ${mode}/${phase}`);
  }
}
