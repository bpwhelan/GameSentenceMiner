import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  hoshidictsHostExecutableName,
  verifyHoshiDictsHostBundle,
} from './hoshidicts-host-artifact.mjs';

const repoRoot = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
const productName = packageJson.productName || packageJson.name || 'GameSentenceMiner';
const platform = process.platform;
const arch = process.arch;
const overlayDirName = `gsm_overlay-${platform}-${arch}`;
const serverExecutableName = platform === 'win32' ? 'gsm_overlay_server.exe' : 'gsm_overlay_server';
const hostExecutableName = hoshidictsHostExecutableName(platform);

function candidateResourceDirs() {
  if (platform === 'darwin') {
    return [
      path.join(repoRoot, 'dist', `mac-${arch}`, `${productName}.app`, 'Contents', 'Resources'),
      path.join(repoRoot, 'dist', `mac-${arch}`, `${productName}.app`, 'Contents', 'Resources', 'resources'),
      path.join(repoRoot, 'dist', 'mac', `${productName}.app`, 'Contents', 'Resources'),
      path.join(repoRoot, 'dist', 'mac', `${productName}.app`, 'Contents', 'Resources', 'resources'),
      path.join(repoRoot, 'dist', `${productName}.app`, 'Contents', 'Resources'),
      path.join(repoRoot, 'dist', `${productName}.app`, 'Contents', 'Resources', 'resources'),
    ];
  }

  if (platform === 'win32') {
    return [
      path.join(repoRoot, 'dist', 'win-unpacked', 'resources'),
      path.join(repoRoot, 'dist', `${productName} win-unpacked`, 'resources'),
    ];
  }

  return [
    path.join(repoRoot, 'dist', 'linux-unpacked', 'resources'),
    path.join(repoRoot, 'dist', `${productName} linux-unpacked`, 'resources'),
  ];
}

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const requireTrusted = args.includes('--require-trusted');
  const allowResignedHost = args.includes('--allow-resigned-host');
  const resourcesRootIndex = args.indexOf('--resources-root');
  const explicitResourcesRoot =
    resourcesRootIndex >= 0 ? args[resourcesRootIndex + 1] : null;
  if (resourcesRootIndex >= 0 && !explicitResourcesRoot) {
    throw new Error('--resources-root requires a path');
  }
  const smokeFixtureIndex = args.indexOf('--smoke-fixture');
  const smokeFixture =
    smokeFixtureIndex >= 0 ? args[smokeFixtureIndex + 1] : null;
  if (smokeFixtureIndex >= 0 && !smokeFixture) {
    throw new Error('--smoke-fixture requires a path');
  }
  const resourcesDirCandidates = explicitResourcesRoot
    ? [path.resolve(explicitResourcesRoot)]
    : candidateResourceDirs();
  let overlayResourcesDir = null;

  for (const resourcesDir of resourcesDirCandidates) {
    const candidate = path.join(resourcesDir, 'GSM_Overlay', overlayDirName, 'resources');
    if (await exists(candidate)) {
      overlayResourcesDir = candidate;
      break;
    }
  }

  if (!overlayResourcesDir) {
    throw new Error(
      `Packaged overlay resources were not found for ${overlayDirName}.\nSearched:\n${resourcesDirCandidates
        .map((resourcesDir) => `  - ${path.join(resourcesDir, 'GSM_Overlay', overlayDirName, 'resources')}`)
        .join('\n')}`
    );
  }

  const requiredPaths = [
    path.join(overlayResourcesDir, 'app.asar'),
    path.join(overlayResourcesDir, serverExecutableName),
    path.join(overlayResourcesDir, hostExecutableName),
    path.join(overlayResourcesDir, 'mecab_bridge.py'),
    path.join(overlayResourcesDir, 'yomitan', 'manifest.json'),
  ];

  const missing = [];
  for (const requiredPath of requiredPaths) {
    if (!(await exists(requiredPath))) {
      missing.push(requiredPath);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Packaged overlay is incomplete. Missing:\n${missing.map((item) => `  - ${item}`).join('\n')}`);
  }

  await verifyHoshiDictsHostBundle({
    repoRoot,
    bundleRoot: overlayResourcesDir,
    platform,
    arch,
    requireTrusted,
    allowResignedHost,
    smokeFixture,
  });

  console.log(`[verify-overlay-package] Verified ${overlayResourcesDir}`);
}

main().catch((error) => {
  console.error(`[verify-overlay-package] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
