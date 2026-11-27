import {execFileSync} from 'node:child_process';
import path from 'node:path';

const windows = process.platform === 'win32';
const transfers = ['transfer', 'transfer-hachidori'];
if (windows) transfers.push('transfer-browser-yomitan', 'transfer-browser-hachidori');
const scenarios = [
  'services', ...(process.platform === 'linux' ? [] : ['runtime', 'foundation']),
  'windows', 'settings', 'database', 'database-recovery', 'vocabulary', 'longplay',
  ...(windows ? ['input', 'notifications', 'pythonless'] : []),
  'yomitan', 'hachidori', 'workspace', 'overlay', ...transfers,
];
const requested = process.argv.slice(2);
for (const scenario of requested.length ? requested : scenarios) {
  let script = 'test-native-desktop.mjs';
  let args = [scenario];
  const env = {...process.env};
  if (scenario === 'services') {
    script = 'test-native-services.mjs';
    args = [];
  } else if (transfers.includes(scenario)) {
    script = 'test-native-transfer.mjs';
    env.GSM_LEGACY_KIND = scenario.endsWith('hachidori') ? 'hachidori' : 'yomitan';
    args = scenario.startsWith('transfer-browser-') ? ['--browser'] : [];
  }
  console.log(`Checking native desktop scenario ${scenario}`);
  execFileSync(process.execPath, [path.join(import.meta.dirname, script), ...args], {
    env, stdio: 'inherit', windowsHide: true,
  });
}
