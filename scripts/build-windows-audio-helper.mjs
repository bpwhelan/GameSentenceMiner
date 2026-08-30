import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperRoot = path.join(repositoryRoot, 'native', 'windows-audio-capture');

if (process.platform !== 'win32') {
  console.log('Skipping Windows application-audio helper build on this platform.');
  process.exit(0);
}

const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
execFileSync(
  'cargo',
  ['build', '--release', '--locked', '--manifest-path', path.join(helperRoot, 'Cargo.toml')],
  { cwd: repositoryRoot, stdio: 'inherit', windowsHide: true }
);

const source = path.join(
  helperRoot,
  'target',
  'release',
  'gsm-windows-audio-capture.exe'
);
const outputDirectory = path.join(helperRoot, 'bin', architecture);
mkdirSync(outputDirectory, { recursive: true });
copyFileSync(
  source,
  path.join(outputDirectory, 'gsm-windows-audio-capture.exe')
);
console.log(`Built Windows application-audio helper for ${architecture}.`);
