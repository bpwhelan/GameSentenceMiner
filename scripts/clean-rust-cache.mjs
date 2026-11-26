import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {launchDirectory, nativeTargetDirectory, pruneDesktopRuns, root} from './native-paths.mjs';

const {values} = parseArgs({
  args: process.argv.slice(2),
  options: {
    days: {type: 'string', default: '7'},
    maxsize: {type: 'string', default: '6GB'},
    'dry-run': {type: 'boolean', default: false},
    'keep-runs': {type: 'string', default: '1'},
    help: {type: 'boolean', short: 'h', default: false},
  },
});

if (values.help) {
  console.log(`Usage: npm run clean:rust -- [--days 7] [--maxsize 6GB] [--keep-runs 1] [--dry-run]

Prunes old dev launch snapshots in src-tauri/target/desktop-runs and sweeps
stale Rust build artifacts in the active Cargo target directory via cargo-sweep.`);
  process.exit(0);
}

const days = Number(values.days);
const keepRecent = Number(values['keep-runs']);
if (!Number.isFinite(days) || days < 0) throw Error('--days must be a non-negative number.');
if (!Number.isInteger(keepRecent) || keepRecent < 0) throw Error('--keep-runs must be a non-negative integer.');
const dryRun = values['dry-run'];

async function runSweep(targetPath, args) {
  const fullArgs = ['sweep', ...(dryRun ? ['--dry-run'] : []), ...args, targetPath];
  const result = spawnSync('cargo', fullArgs, {cwd: root, stdio: 'inherit', windowsHide: true});
  return result.status === 0;
}

function hasCommand(command, args = ['--version']) {
  const result = spawnSync(command, args, {cwd: root, stdio: 'ignore', windowsHide: true});
  return result.status === 0;
}

if (!dryRun) {
  const {removed, kept} = await pruneDesktopRuns(launchDirectory, {keepRecent});
  console.log(`desktop-runs: removed ${removed.length}, kept ${kept.length}`);
} else {
  console.log('desktop-runs: skipped in --dry-run mode');
}

const activeTarget = await nativeTargetDirectory();
console.log(`Active Cargo target dir: ${activeTarget}`);

if (hasCommand('cargo-sweep')) {
  // Sweep artifacts older than --days, artifacts from uninstalled toolchains,
  // and enforce a hard size ceiling on the target directory.
  const targetsToSweep = new Set([activeTarget]);
  const repoTarget = path.join(root, 'target');
  if (await fs.stat(repoTarget).then(s => s.isDirectory(), () => false)) {
    targetsToSweep.add(repoTarget);
  }
  for (const dir of targetsToSweep) {
    // cargo-sweep expects either a project path containing target/ or the target dir's parent.
    // Pass the directory containing Cargo.toml when target is inside the repo; for external
    // CARGO_TARGET_DIR, sweep directly by setting CARGO_TARGET_DIR on the repo root.
    const env = {...process.env, CARGO_TARGET_DIR: dir};
    for (const sweepArgs of [['--time', String(days)], ['--installed'], ['--maxsize', values.maxsize]]) {
      const fullArgs = ['sweep', ...(dryRun ? ['--dry-run'] : []), ...sweepArgs, root];
      spawnSync('cargo', fullArgs, {cwd: root, env, stdio: 'inherit', windowsHide: true});
    }
  }
} else {
  console.log('cargo-sweep not installed. Install with: cargo install cargo-sweep --locked');
}

if (hasCommand('sccache')) {
  console.log('\n--- sccache stats ---');
  spawnSync('sccache', ['--show-stats'], {cwd: root, stdio: 'inherit', windowsHide: true});
}
