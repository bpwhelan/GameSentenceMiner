import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperRoot = path.join(repositoryRoot, 'native', 'windows-speech-recognition');
const buildRoot = path.join(helperRoot, 'build');

if (process.platform !== 'win32') {
  console.log('Skipping Windows embedded speech helper build on this platform.');
  process.exit(0);
}

execFileSync(
  'cmake',
  ['-S', helperRoot, '-B', buildRoot, '-G', 'Visual Studio 17 2022', '-A', 'x64'],
  { cwd: repositoryRoot, stdio: 'inherit', windowsHide: true }
);
execFileSync(
  'cmake',
  [
    '--build',
    buildRoot,
    '--config',
    'Release',
    '--target',
    'gsm-windows-speech-recognition',
    '--target',
    'gsm-windows-speech-recognition-sapi',
  ],
  { cwd: repositoryRoot, stdio: 'inherit', windowsHide: true }
);

const candidates = [
  path.join(buildRoot, 'Release', 'gsm-windows-speech-recognition.exe'),
  path.join(buildRoot, 'gsm-windows-speech-recognition.exe'),
];
const source = candidates.find((candidate) => {
  try {
    return Boolean(statSync(candidate));
  } catch {
    return false;
  }
});
if (!source) {
  throw new Error('CMake completed but the Windows speech helper executable was not found.');
}

const outputDirectory = path.join(helperRoot, 'bin', 'x64');
mkdirSync(outputDirectory, { recursive: true });
copyFileSync(source, path.join(outputDirectory, 'gsm-windows-speech-recognition.exe'));

const sapiCandidates = [
  path.join(buildRoot, 'Release', 'gsm-windows-speech-recognition-sapi.exe'),
  path.join(buildRoot, 'gsm-windows-speech-recognition-sapi.exe'),
];
const sapiSource = sapiCandidates.find((candidate) => {
  try {
    return Boolean(statSync(candidate));
  } catch {
    return false;
  }
});
if (!sapiSource) {
  throw new Error('CMake completed but the Windows SAPI helper executable was not found.');
}
copyFileSync(sapiSource, path.join(outputDirectory, 'gsm-windows-speech-recognition-sapi.exe'));
console.log('Built Windows speech helpers for x64.');
