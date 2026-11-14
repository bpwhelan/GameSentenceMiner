import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {root, launchDirectory, launchPointer} from './native-paths.mjs';

// Run a copy so Windows can rebuild the Rust executable while GSM is open.
// The next graceful restart selects this completed build, never a partial one.
const target = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(root, 'src-tauri', 'target', 'native-dev');
await new Promise((resolve, reject) => {
  const child = spawn('cargo', ['build', '--locked', '--release', '--manifest-path', 'GSM_Overlay/input_server/Cargo.toml', '--target-dir', 'GSM_Overlay/input_server/target'], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(Error(`Input service build failed (${code})`)));
});
await new Promise((resolve,reject)=>{
  const child=spawn('cargo',['build','--locked','--manifest-path','native/gsm-agent/Cargo.toml','--bin','gsm-agent-host','--target-dir','native/gsm-agent/target'],{cwd:root,stdio:'inherit',windowsHide:true});
  child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`Native Agent build failed (${code})`)));
});
await new Promise((resolve, reject) => {
  const child = spawn('cargo', ['build', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--target-dir', target], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(Error(`Native desktop build failed (${code})`)));
});
const basename = process.platform === 'win32' ? 'gsm-desktop.exe' : 'gsm-desktop';
const source = path.join(target, 'debug', basename);
const agentName=process.platform==='win32'?'gsm-agent-host.exe':'gsm-agent-host';
const agentSource=path.join(root,'native/gsm-agent/target/debug',agentName);
const inputName = process.platform === 'win32' ? 'gsm_overlay_server.exe' : 'gsm_overlay_server';
const inputSource = path.join(root, 'GSM_Overlay/input_server/target/release', inputName);
const hash = crypto.createHash('sha256').update(await fs.readFile(source)).update(await fs.readFile(agentSource)).update(await fs.readFile(inputSource)).digest('hex').slice(0, 20);
const directory = path.join(launchDirectory, `${process.platform}-${process.arch}-${hash}`);
const executable = path.join(directory, basename);
await fs.mkdir(directory, {recursive: true});
try { await fs.copyFile(source, executable, fs.constants.COPYFILE_EXCL); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
try { await fs.copyFile(agentSource,path.join(directory,agentName),fs.constants.COPYFILE_EXCL); }
catch (error) { if (error.code !== "EEXIST") throw error; }
try { await fs.copyFile(inputSource, path.join(directory, inputName), fs.constants.COPYFILE_EXCL); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
if (process.platform !== 'win32') {await fs.chmod(executable, 0o755);await fs.chmod(path.join(directory,agentName),0o755);await fs.chmod(path.join(directory,inputName),0o755);}
const temporary = `${launchPointer}.${process.pid}.tmp`;
await fs.writeFile(temporary, JSON.stringify({executable, hash}));
await fs.rename(temporary, launchPointer);
console.log('Native desktop is ready for the next launch.');
