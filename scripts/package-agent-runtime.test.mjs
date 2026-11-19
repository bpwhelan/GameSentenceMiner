import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {packageAgentRuntime, verifyAgentRuntimeArchive} from './package-agent-runtime.mjs';

test('separate runtime archive is stable across app releases and carries pinned hashes and licenses', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-agent-package-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const executable = path.join(root, 'host');
  await fs.writeFile(executable, 'fixture native runtime');
  const first = await packageAgentRuntime({executable, output: path.join(root, 'first'), version: '2026.11.0', platform: 'win32-x64'});
  const second = await packageAgentRuntime({executable, output: path.join(root, 'second'), version: '2026.12.0-beta.1', platform: 'win32-x64'});
  for (const source of ['../native/gsm-agent/src/lib.rs', '../native/gsm-packages/src/agent_runtime.rs']) {
    const rust = await fs.readFile(new URL(source, import.meta.url), 'utf8');
    assert.equal(rust.match(/pub const FRIDA_VERSION: &str = "([^"]+)"/)[1], first.manifest.fridaVersion);
  }
  assert.equal(first.manifest.archive.sha256, second.manifest.archive.sha256);
  assert.notEqual(first.manifest.archive.url, second.manifest.archive.url);
  assert.match(first.manifest.archive.url, /\/releases\/download\/v2026\.11\.0\/gsm-agent-runtime-win32-x64-/);
  assert.deepEqual(first.manifest.files.map(f => f.path), ['gsm-agent-host.exe', 'licenses/NOTICE.md', 'licenses/FRIDA-COPYING', 'licenses/COPYING.LIB']);
  await verifyAgentRuntimeArchive(first.manifest, first.archive);
  await fs.appendFile(first.archive, 'corrupt');
  await assert.rejects(verifyAgentRuntimeArchive(first.manifest, first.archive), /does not match/);
  await fs.writeFile(executable, 'changed runtime');
  const changed = await packageAgentRuntime({executable, output: path.join(root, 'changed'), version: '2026.12.0', platform: 'darwin-arm64'});
  assert.notEqual(changed.manifest.archive.sha256, second.manifest.archive.sha256);
  assert.equal(changed.manifest.files[0].path, 'gsm-agent-host');
});
