import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('importing the fixture helper does not treat the runner argument as an output file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-fixture-import-'));
  const destination = path.join(directory, 'overlay');
  const helper = new URL('./dictionary-fixture.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, [
    '--input-type=module', '-e', `await import(${JSON.stringify(helper)});`, 'runner', destination,
  ], {encoding:'utf8', windowsHide:true});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await fs.readdir(directory), []);
  await fs.rmdir(directory);
});
