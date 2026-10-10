const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const archiver = require('archiver');

async function run() {
  const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'gsm-hachidori-persistence-'));
  const output = fs.createWriteStream(path.join(directory, 'second.zip'));
  const archive = archiver('zip');
  const written = new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
  });
  archive.pipe(output);
  archive.append(JSON.stringify({ title: 'gsm-persistence-second', revision: 'test-1', format: 3 }), { name: 'index.json' });
  archive.append(JSON.stringify([['保存語', 'ほぞんご', '', '', 0, ['persisted dictionary'], 1, '']]), { name: 'term_bank_1.json' });
  await archive.finalize();
  await written;

  const env = { ...process.env, GSM_HACHIDORI_PERSISTENCE_DIRECTORY: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const results = [];
  for (const phase of ['import', 'overlay-restart', 'restart', 'update', 'restart-after-update']) {
    if (phase === 'update') {
      // Simulate a different vendored build: invalidate the worker cache on
      // every platform and refresh Linux's appdata extension copy too.
      const overlayData = path.join(directory, 'overlay');
      fs.writeFileSync(path.join(overlayData, 'hachidori_last_commit.json'), JSON.stringify({ commit: 'previous-release' }));
      if (process.platform === 'linux') {
        const versionsPath = path.join(overlayData, 'extensions/versions.json');
        const versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));
        versions.hachidori = 'previous-release';
        fs.writeFileSync(versionsPath, JSON.stringify(versions));
      }
    }
    const child = spawnSync(require('electron'), [
      ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : []),
      path.join(__dirname, 'hachidori-persistence-electron.cjs'),
    ], {
      env: { ...env, GSM_HACHIDORI_PERSISTENCE_PHASE: phase },
      encoding: 'utf8', timeout: 150_000, maxBuffer: 8 * 1024 * 1024,
    });
    const log = path.join(directory, `${phase}.log`);
    fs.writeFileSync(log, `${child.stdout || ''}\n${child.stderr || ''}`);
    if (child.error) throw child.error;
    if (child.status !== 0) process.stderr.write(child.stderr || '');
    assert.equal(child.status, 0, `${phase} succeeds; see ${log}`);
    const result = JSON.parse(fs.readFileSync(path.join(directory, `${phase}.json`), 'utf8'));
    results.push(result);
    console.log(`Hachidori dictionary persistence: ${phase} passed`);
  }
  assert.equal(new Set(results.map(result => result.pid)).size, results.length, 'use independent Electron processes');
  console.log(`Evidence: ${directory}`);
}

run().catch(error => { console.error(error); process.exitCode = 1; });
