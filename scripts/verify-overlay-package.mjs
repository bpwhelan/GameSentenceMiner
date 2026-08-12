import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { extractFile, listPackage } from '@electron/asar';

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

function normalizeAsarPath(candidate) {
  return candidate.replaceAll('\\', '/').replace(/^\/+/, '');
}

function verifyAsarEntries(archivePath, requiredEntries) {
  const entries = new Set(listPackage(archivePath).map(normalizeAsarPath));
  const missing = requiredEntries.filter((entry) => !entries.has(entry));
  if (missing.length > 0) {
    throw new Error(
      `Packaged ASAR is missing required Hoshidicts files (${archivePath}):\n${missing
        .map((entry) => `  - ${entry}`)
        .join('\n')}`
    );
  }
  return entries;
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
    path.join(packagedResourcesDir, 'app.asar'),
    path.join(overlayResourcesDir, 'app.asar'),
    path.join(overlayResourcesDir, serverExecutableName),
    path.join(overlayResourcesDir, 'mecab_bridge.py'),
    path.join(overlayResourcesDir, 'yomitan', 'manifest.json'),
    path.join(packagedResourcesDir, 'GameSentenceMiner', 'hoshidicts_mining.py'),
    path.join(packagedResourcesDir, 'GameSentenceMiner', 'hoshidicts_mining_note.py'),
    path.join(packagedResourcesDir, 'GameSentenceMiner', 'hoshidicts_audio.py'),
    path.join(
      packagedResourcesDir,
      'GameSentenceMiner',
      'web',
      'hoshidicts_api.py'
    ),
    path.join(
      packagedResourcesDir,
      'GameSentenceMiner',
      'ui',
      'config',
      'tabs',
      'experimental.py'
    ),
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

  const packagedExperimentalSettings = path.join(
    packagedResourcesDir,
    'GameSentenceMiner',
    'ui',
    'config',
    'tabs',
    'experimental.py'
  );
  const packagedExperimentalContents = await fs.readFile(
    packagedExperimentalSettings,
    'utf8'
  );
  if (
    !packagedExperimentalContents.includes('enable_hoshidicts') ||
    !packagedExperimentalContents.includes('open_hoshidicts_settings')
  ) {
    throw new Error(
      'Packaged backend does not expose Hoshidicts enablement and its settings link.'
    );
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

  const desktopAsarPath = path.join(packagedResourcesDir, 'app.asar');
  const desktopEntries = verifyAsarEntries(desktopAsarPath, [
    'dist/main/features/hoshidicts/index.js',
    'dist/main/features/hoshidicts/ipc.js',
    'dist/main/features/hoshidicts/manager.js',
    'dist/main/features/hoshidicts/audio_profile.js',
    'dist/main/features/hoshidicts/profile.js',
    'dist/main/features/hoshidicts/window.js',
    'dist/shared/features/hoshidicts.js',
  ]);
  const rendererBundle = [...desktopEntries].find(
    (entry) =>
      /^dist\/renderer\/assets\/index-.*\.js$/u.test(entry)
  );
  if (!rendererBundle) {
    throw new Error('Packaged desktop renderer bundle was not found.');
  }
  const rendererContents = extractFile(
    desktopAsarPath,
    path.normalize(rendererBundle)
  ).toString('utf8');
  if (!rendererContents.includes('hoshidicts-settings')) {
    throw new Error(
      'Packaged desktop renderer does not contain the standalone Hoshidicts window.'
    );
  }

  const overlayAsarPath = path.join(overlayResourcesDir, 'app.asar');
  verifyAsarEntries(overlayAsarPath, [
    'features/hoshidicts/desktop_bridge.js',
    'features/hoshidicts/diagnostics.js',
    'features/hoshidicts/icons/add-duplicate-big-circle.svg',
    'features/hoshidicts/icons/big-circle.svg',
    'features/hoshidicts/reader.css',
    'features/hoshidicts/audio.js',
    'features/hoshidicts/popup.js',
    'features/hoshidicts/reader.js',
    'index.html',
    'settings.html',
  ]);
  const overlayIndexContents = extractFile(
    overlayAsarPath,
    'index.html'
  ).toString('utf8');
  const overlaySettingsContents = extractFile(
    overlayAsarPath,
    'settings.html'
  ).toString('utf8');
  if (
    overlayIndexContents.includes('btn-hoshidicts-settings') ||
    !overlaySettingsContents.includes('openHoshidictsSettings') ||
    !overlaySettingsContents.includes('open-hoshidicts-settings') ||
    !overlayIndexContents.includes('features/hoshidicts/audio.js') ||
    !overlayIndexContents.includes('features/hoshidicts/popup.js') ||
    !overlayIndexContents.includes('features/hoshidicts/reader.js') ||
    overlayIndexContents.indexOf('features/hoshidicts/audio.js') >
      overlayIndexContents.indexOf('features/hoshidicts/popup.js') ||
    overlayIndexContents.indexOf('features/hoshidicts/popup.js') >
      overlayIndexContents.indexOf('features/hoshidicts/reader.js')
  ) {
    throw new Error(
      'Packaged overlay does not expose the complete Hoshidicts reader in the required load order.'
    );
  }

  console.log(`[verify-overlay-package] Verified ${overlayResourcesDir}`);
}

main().catch((error) => {
  console.error(`[verify-overlay-package] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
