const { spawn } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [path.join(__dirname, 'overlay-render-electron.cjs'), ...process.argv.slice(2)], {
  env, windowsHide: true, stdio: 'inherit',
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
