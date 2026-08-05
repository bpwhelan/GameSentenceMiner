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
  let packagedResourcesDir = null;
  let overlayResourcesDir = null;

  for (const resourcesDir of resourcesDirCandidates) {
    const candidate = path.join(resourcesDir, 'GSM_Overlay', overlayDirName, 'resources');
    if (await exists(candidate)) {
      packagedResourcesDir = resourcesDir;
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

  const sourcePreReleaseMetadata = path.join(
    repoRoot,
    'electron-src',
    'assets',
    'prerelease.json'
  );
  if (await exists(sourcePreReleaseMetadata)) {
    const packagedPreReleaseMetadata = path.join(
      packagedResourcesDir,
      'assets',
      'prerelease.json'
    );
    if (!(await exists(packagedPreReleaseMetadata))) {
      throw new Error(
        `Packaged prerelease metadata is missing: ${packagedPreReleaseMetadata}`
      );
    }
    const [sourceMetadata, packagedMetadata] = await Promise.all([
      fs.readFile(sourcePreReleaseMetadata, 'utf8'),
      fs.readFile(packagedPreReleaseMetadata, 'utf8'),
    ]);
    if (sourceMetadata !== packagedMetadata) {
      throw new Error('Packaged prerelease metadata does not match the build metadata.');
    }
  }

  const sourceExperimentalSettings = path.join(
    repoRoot,
    'GameSentenceMiner',
    'ui',
    'config',
    'tabs',
    'experimental.py'
  );
  const sourceExperimentalContents = await fs.readFile(
    sourceExperimentalSettings,
    'utf8'
  );
  if (sourceExperimentalContents.includes('enable_hoshidicts')) {
    const packagedExperimentalSettings = path.join(
      packagedResourcesDir,
      'GameSentenceMiner',
      'ui',
      'config',
      'tabs',
      'experimental.py'
    );
    if (!(await exists(packagedExperimentalSettings))) {
      throw new Error(
        `Packaged Hoshidicts settings source is missing: ${packagedExperimentalSettings}`
      );
    }
    const packagedExperimentalContents = await fs.readFile(
      packagedExperimentalSettings,
      'utf8'
    );
    if (!packagedExperimentalContents.includes('enable_hoshidicts')) {
      throw new Error(
        'Packaged backend does not expose the Hoshidicts Experimental setting.'
      );
    }
  }

  console.log(`[verify-overlay-package] Verified ${overlayResourcesDir}`);
}

main().catch((error) => {
  console.error(`[verify-overlay-package] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
