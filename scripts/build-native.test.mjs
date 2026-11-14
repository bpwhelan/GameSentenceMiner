import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildNative } from './build-native.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm native build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

for (const platform of ['win32', 'linux', 'darwin']) {
  test(`uses the checkout's Python instead of PATH on ${platform}`, (t) => {
    const root = fixture(t);
    const python = path.join(root, '.venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, '');
    const spawn = t.mock.method(childProcess, 'spawnSync', () => ({ status: 0 }));

    assert.equal(buildNative(root, platform), 0);
    assert.equal(spawn.mock.callCount(), 1);
    const [command, args, options] = spawn.mock.calls[0].arguments;
    assert.equal(command, python);
    assert.deepEqual(args, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps', '-e', '.']);
    assert.equal(options.cwd, root);
    assert.equal(options.stdio, 'inherit');
    assert.ok(!options.shell, 'paths containing spaces must not go through a shell');
  });
}

test('keeps the configured PATH Python for builds without a local environment', (t) => {
  const root = fixture(t);
  const spawn = t.mock.method(childProcess, 'spawnSync', () => ({ status: 0 }));
  assert.equal(buildNative(root), 0);
  assert.equal(spawn.mock.calls[0].arguments[0], 'python');
});

test('returns a failed build status without retrying in another environment', (t) => {
  const root = fixture(t);
  const spawn = t.mock.method(childProcess, 'spawnSync', () => ({ status: 7 }));
  assert.equal(buildNative(root), 7);
  assert.equal(spawn.mock.callCount(), 1);
});

test('does not report a terminated build as successful', (t) => {
  const root = fixture(t);
  t.mock.method(childProcess, 'spawnSync', () => ({ status: null, signal: 'SIGTERM' }));
  assert.equal(buildNative(root), 1);
});

test('reports errors starting Python', (t) => {
  const root = fixture(t);
  const error = new Error('Python could not start');
  t.mock.method(childProcess, 'spawnSync', () => ({ status: null, error }));
  assert.throws(() => buildNative(root), error);
});
