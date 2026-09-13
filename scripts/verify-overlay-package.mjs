import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
const productName = packageJson.productName || packageJson.name || 'GameSentenceMiner';
const platform = process.platform;
const arch = process.arch;
const overlayDirName = `gsm_overlay-${platform}-${arch}`;
const serverExecutableName = platform === 'win32' ? 'gsm_overlay_server.exe' : 'gsm_overlay_server';

function candidateResourceDirs() {
  if (platform === 'darwin') {
    return [
      path.join(repoRoot, 'dist', `mac-${arch}`, `${productName}.app`, 'Contents', 'Resources'),
      path.join(repoRoot, 'dist', 'mac', `${productName}.app`, 'Contents', 'Resources'),
      path.join(repoRoot, 'dist', `${productName}.app`, 'Contents', 'Resources'),
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
  const resourcesDirCandidates = candidateResourceDirs();
  let overlayResourcesDir = null;
  let packagedResourcesDir = null;

  for (const resourcesDir of resourcesDirCandidates) {
    const candidate = path.join(resourcesDir, 'GSM_Overlay', overlayDirName, 'resources');
    if (await exists(candidate)) {
      overlayResourcesDir = candidate;
      packagedResourcesDir = resourcesDir;
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
    path.join(overlayResourcesDir, 'mecab_bridge.py'),
    path.join(overlayResourcesDir, 'yomitan', 'manifest.json'),
    path.join(overlayResourcesDir, 'hachidori', 'manifest.json'),
    path.join(overlayResourcesDir, 'hachidori', 'background.js'),
    path.join(overlayResourcesDir, 'hachidori', 'offscreen.js'),
    path.join(overlayResourcesDir, 'hachidori', 'overlay-mode.js'),
    path.join(overlayResourcesDir, 'hachidori', 'vendor', 'hoshidicts.wasm'),
    path.join(overlayResourcesDir, 'hachidori', 'vendor', 'hoshidicts-threaded.wasm'),
    path.join(overlayResourcesDir, 'hachidori', 'LICENSE.hachidori'),
    path.join(overlayResourcesDir, 'hachidori', 'SOURCE.json'),
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

  const hachidoriManifest = JSON.parse(
    await fs.readFile(path.join(overlayResourcesDir, 'hachidori', 'manifest.json'), 'utf8')
  );
  if (typeof hachidoriManifest.key !== 'string' || hachidoriManifest.key.length === 0) {
    throw new Error('Packaged Hachidori manifest does not contain its stable extension key.');
  }

  const hachidoriOverlayMode = await fs.readFile(path.join(overlayResourcesDir, 'hachidori', 'overlay-mode.js'), 'utf8');
  if (!hachidoriOverlayMode.includes('export const OVERLAY_MODE = true;')) {
    throw new Error('Packaged Hachidori does not run in overlay mode.');
  }

  const hachidoriSource = JSON.parse(
    await fs.readFile(path.join(overlayResourcesDir, 'hachidori', 'SOURCE.json'), 'utf8')
  );
  if (!/^[0-9a-f]{40}$/.test(hachidoriSource.commit || '')) {
    throw new Error('Packaged Hachidori SOURCE.json does not identify an exact source commit.');
  }

  const packagedExperimentalTab = path.join(
    packagedResourcesDir,
    'GameSentenceMiner',
    'ui',
    'config',
    'tabs',
    'experimental.py'
  );
  if (await exists(packagedExperimentalTab)) {
    const packagedExperimentalContents = await fs.readFile(packagedExperimentalTab, 'utf8');
    if (!packagedExperimentalContents.includes('enable_hachidori')) {
      throw new Error('Packaged backend does not expose the Hachidori experimental toggle.');
    }
  }

  console.log(`[verify-overlay-package] Verified ${overlayResourcesDir}`);
}

main().catch((error) => {
  console.error(`[verify-overlay-package] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
