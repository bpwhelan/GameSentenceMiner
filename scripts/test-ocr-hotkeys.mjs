import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {nativeExecutable,root} from './native-paths.mjs';
if(process.platform!=='win32')throw Error('This integration check sends real Windows key input to isolated test windows.');
fs.mkdirSync(path.join(root,'.tmp-ocr-benchmark'),{recursive:true});
const directory=fs.mkdtempSync(path.join(root,'.tmp-ocr-benchmark/hotkeys-'));
const result=path.join(directory,'exit.json');
const code=await new Promise((resolve,reject)=>{
    const child=spawn(nativeExecutable(),[],{cwd:root,windowsHide:true,stdio:'inherit',env:{...process.env,GSM_APP_ROOT:root,GSM_NODE_EXECUTABLE:process.execPath,GSM_SMOKE_TEST:'1',GSM_PROFILE_DIR:directory,GSM_TEST_RESULT:result,GSM_TEST_SERVICE:path.join(root,'desktop-runtime/tests/ocr-hotkeys-smoke.mjs')}});
    const timer=setTimeout(()=>{child.kill();reject(Error('Hotkey integration check timed out'));},180000);
    child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);resolve(code);});
});
console.error('Hotkey test results:',directory);
if(code!==0||JSON.parse(fs.readFileSync(result)).code!==0)process.exitCode=1;
