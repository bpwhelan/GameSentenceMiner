const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-yomitan-startup-'));
async function run() {
  const source = path.resolve(__dirname, '../yomitan');
  const extension = path.join(root, 'GSM_Overlay', 'yomitan');
  fs.cpSync(source, extension, { recursive: true });
  // Simulate an older worker whose settings work but whose frontend cannot start.
  // The following update keeps both the manifest version and timestamp unchanged.
  fs.writeFileSync(path.join(extension, 'stale-worker-fixture.js'), `
    import {Backend} from './js/background/backend.js';
    Backend.prototype._onApiGetEnvironmentInfo = () => { throw new Error('stale Yomitan worker fixture'); };
  `);
  fs.writeFileSync(path.join(extension, 'sw.js'), `import './stale-worker-fixture.js'; import './js/background/background-main.js';`);
  for (const phase of ['seed', 'upgrade', 'lookup']) {
    await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [path.join(__dirname, 'yomitan-startup-electron-smoke.cjs'), root, phase], {
        env, windowsHide: true, stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${phase} failed (${code})`)));
    });
    if (phase === 'seed') fs.copyFileSync(path.join(source, 'sw.js'), path.join(extension, 'sw.js'));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
