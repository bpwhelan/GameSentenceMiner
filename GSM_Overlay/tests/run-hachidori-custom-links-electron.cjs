// SPDX-License-Identifier: LGPL-3.0-only
// Run under a real display, for example:
//   GSM_HACHIDORI_EVIDENCE_DIR=/path/to/evidence \
//     xvfb-run -a node tests/run-hachidori-custom-links-electron.cjs
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const evidenceDirectory = process.env.GSM_HACHIDORI_EVIDENCE_DIR;
if (!evidenceDirectory) {
  throw new Error('GSM_HACHIDORI_EVIDENCE_DIR is required.');
}
fs.mkdirSync(evidenceDirectory, { recursive: true });

const runDirectory = process.env.GSM_HACHIDORI_RUN_DIRECTORY
  || fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-hachidori-custom-links-'));
const fixturePath = process.env.GSM_HACHIDORI_FIXTURE
  || path.resolve(__dirname, 'fixtures', 'hachidori-fixture.zip');
const electronBinary = require('electron');
const childScript = path.join(__dirname, 'hachidori-custom-links-electron.cjs');
const sourceCommit = require('../hachidori/SOURCE.json').commit;
const logPath = path.join(evidenceDirectory, 'real-gsm-electron.log');
fs.writeFileSync(logPath, '');

const results = [];
for (const phase of ['edit', 'restart']) {
  const environment = {
    ...process.env,
    GSM_HACHIDORI_EVIDENCE_DIR: evidenceDirectory,
    GSM_HACHIDORI_RUN_DIRECTORY: runDirectory,
    GSM_HACHIDORI_FIXTURE: fixturePath,
    GSM_HACHIDORI_PHASE: phase,
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(electronBinary, [childScript], {
    cwd: path.resolve(__dirname, '..'),
    env: environment,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 210_000,
  });
  const phaseLog = [
    `===== ${phase} phase stdout =====`,
    child.stdout || '',
    `===== ${phase} phase stderr =====`,
    child.stderr || '',
    `===== ${phase} phase status ${child.status} signal ${child.signal || 'none'} =====`,
    '',
  ].join('\n');
  fs.appendFileSync(logPath, phaseLog);
  if (child.error) throw child.error;
  if (child.status !== 0) {
    process.stdout.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
  } else {
    console.log(`[real-gsm-electron] ${phase} phase passed`);
  }
  assert.equal(child.status, 0, `${phase} Electron phase succeeds; see ${logPath}`);
  const resultPath = path.join(evidenceDirectory, `real-gsm-electron-${phase}.json`);
  results.push(JSON.parse(fs.readFileSync(resultPath, 'utf8')));
}

assert.equal(results[0].runDirectory, runDirectory);
assert.equal(results[1].runDirectory, runDirectory);
assert.notEqual(results[0].pid, results[1].pid, 'reload persistence is followed by a full Electron process restart');
assert.equal(results[0].sourceCommit, sourceCommit);
assert.equal(results[1].sourceCommit, sourceCommit);
assert.deepEqual(results[0].reloaded.storedLinks, results[1].restarted.storedLinks);
assert.equal(results[0].openExternalAttempts.filter((attempt) => attempt.outcome === 'resolved').length, 1);
assert.equal(results[0].openExternalAttempts.filter((attempt) => attempt.outcome === 'rejected').length, 1);
assert.equal(results[1].openExternalAttempts.length, 0);

const aggregate = {
  ok: true,
  sourceCommit,
  runDirectory,
  sameProfileAcrossProcesses: true,
  distinctElectronPids: results.map((result) => result.pid),
  phases: results,
};
const aggregatePath = path.join(evidenceDirectory, 'real-gsm-electron-results.json');
fs.writeFileSync(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`);
console.log(JSON.stringify({
  ok: true,
  sourceCommit,
  runDirectory,
  distinctElectronPids: aggregate.distinctElectronPids,
  evidence: aggregatePath,
}));
