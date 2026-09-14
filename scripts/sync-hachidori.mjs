import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(import.meta.dirname, '..');
const targetDir = path.join(repoRoot, 'GSM_Overlay', 'hachidori');
// Hachidori's own folder guide, which the overlay has no use for.
const excludedPaths = new Set(['README.md']);
const overlayModeOff = 'export const OVERLAY_MODE = false;';
const overlayModeOn = 'export const OVERLAY_MODE = true;';
const stableManifestKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3EBnBqP0Ma73KIk9Nx2ye+WFabltPVObI7QWPgYhdupw89RJ7J7xRUddIGszPDhpQNYnm37eLQupFXjqlSt0B1ltnltpzGynkRflAmRbtlqPWf19TWy6EowMm1SegxRR/YPxP5M93oQ/ojzfUPDQ4bhTE23vic/xY7sZttqcewAJou/TyCJTEjcoZgqDTD4PDnXyu1rB+bMJpu+uF/geKkkAOU4IRXHOEuE1JhJorvzmlZT07H01eqXGpmjR7ySbXryhN2gWb1arY+lCWd/qXWWUcIuyjak8D/6WgIaJwsBwoL/B/60gMoXDnDCRWi5kMWH68scx2QzF6g+FDykntwIDAQAB';

async function git(sourceRoot, ...args) {
  const { stdout } = await execFile('git', ['-C', sourceRoot, ...args]);
  return stdout.trim();
}

async function main() {
  const sourceRoot = path.resolve(process.argv[2] || '');
  if (!process.argv[2]) {
    throw new Error('Usage: node scripts/sync-hachidori.mjs /path/to/hachidori');
  }

  const sourceExtensionDir = path.join(sourceRoot, 'extension');
  const sourceManifestPath = path.join(sourceExtensionDir, 'manifest.json');
  const sourceLicensePath = path.join(sourceRoot, 'LICENSE');
  await Promise.all([
    fs.access(sourceManifestPath),
    fs.access(sourceLicensePath),
  ]);

  const dirty = await git(sourceRoot, 'status', '--porcelain');
  if (dirty) {
    throw new Error('The Hachidori checkout must be clean so SOURCE.json identifies the exact vendored source.');
  }
  const commit = await git(sourceRoot, 'rev-parse', 'HEAD');

  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.cp(sourceExtensionDir, targetDir, {
    recursive: true,
    filter: (source) => !excludedPaths.has(path.relative(sourceExtensionDir, source)),
  });

  const manifestPath = path.join(targetDir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.key = stableManifestKey;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // The overlay hosts Hachidori in its own window, so it runs in Hachidori's overlay mode.
  const overlayModePath = path.join(targetDir, 'overlay-mode.js');
  const overlayMode = await fs.readFile(overlayModePath, 'utf8');
  if (!overlayMode.includes(overlayModeOff)) {
    throw new Error(`overlay-mode.js no longer contains "${overlayModeOff}"; update this script for the new switch.`);
  }
  await fs.writeFile(overlayModePath, overlayMode.replace(overlayModeOff, overlayModeOn));

  await fs.copyFile(sourceLicensePath, path.join(targetDir, 'LICENSE.hachidori'));
  await fs.writeFile(
    path.join(targetDir, 'SOURCE.json'),
    `${JSON.stringify({
      name: 'Hachidori',
      repository: 'https://github.com/bee-san/hachidori',
      commit,
      sourceDirectory: 'extension',
      license: 'GPL-3.0-or-later',
      modifications: [
        'manifest.json includes a fixed public key so the GSM-hosted extension keeps one stable ID.',
        'overlay-mode.js enables overlay mode: hover lookups, no word highlight, and no first-run setup page.',
        'README.md is left out.',
      ],
    }, null, 2)}\n`,
  );

  console.log(`[sync-hachidori] Synced ${commit} to ${targetDir}`);
}

main().catch((error) => {
  console.error(`[sync-hachidori] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
