import { execFileSync } from 'node:child_process';
import process from 'node:process';

if (process.platform !== 'win32') {
  console.log('Skipping Windows native helper builds on this platform.');
  process.exit(0);
}

for (const script of ['build-windows-audio-helper.mjs', 'build-windows-speech-helper.mjs']) {
  execFileSync(process.execPath, [`scripts/${script}`], {
    stdio: 'inherit',
    windowsHide: true,
  });
}
