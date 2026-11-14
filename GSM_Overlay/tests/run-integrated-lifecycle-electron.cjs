const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-integrated-overlay-'));
const env = { ...process.env, GSM_OVERLAY_LIFECYCLE_DIRECTORY: directory };
delete env.ELECTRON_RUN_AS_NODE;
const log = fs.createWriteStream(path.join(directory, 'lifecycle.log'));
const child = spawn(require('electron'), [path.join(__dirname, 'integrated-lifecycle-electron.cjs')], {
  env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.pipe(log);
child.stderr.pipe(log);
child.stdout.on('data', data => {
  for (const line of data.toString().split('\n')) if (/^(PASS:|Integrated overlay cycle)/.test(line)) console.log(line.trim());
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => {
  console.log(`Evidence: ${directory}`);
  process.exitCode = code ?? 1;
});
