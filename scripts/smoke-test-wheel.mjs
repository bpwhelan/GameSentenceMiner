import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const wheelDir = path.resolve(process.argv[2] || 'electron-src/assets/python');
const wheels = fs
  .readdirSync(wheelDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.whl'));
if (wheels.length !== 1) {
  throw new Error(`Expected exactly one wheel in ${wheelDir}; found ${wheels.length}.`);
}

const wheelPath = path.join(wheelDir, wheels[0].name);
const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-wheel-smoke-'));

function runPython(args, options = {}) {
  const result = spawnSync('python', args, { stdio: 'inherit', ...options });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`python ${args.join(' ')} failed with exit code ${result.status}.`);
  }
}

try {
  runPython(['-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps', '--target', targetDir, wheelPath]);
  runPython(
    ['-c', 'from GameSentenceMiner import _native; assert _native.api_version() == 1'],
    {
      cwd: targetDir,
      env: { ...process.env, PYTHONPATH: targetDir },
    }
  );
  console.log(`Smoke-tested prerelease backend wheel: ${wheels[0].name}`);
} finally {
  fs.rmSync(targetDir, { recursive: true, force: true });
}
