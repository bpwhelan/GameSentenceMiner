import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const platform = process.platform;
const arch = process.arch;
const overlayDirName = `gsm_overlay-${platform}-${arch}`;
const overlayOutDir = path.join(repoRoot, 'GSM_Overlay', 'out', overlayDirName);
const stagedOverlayRoot = path.join(repoRoot, 'build', 'overlay');
const stagedOverlayDir = path.join(stagedOverlayRoot, overlayDirName);
const stagedResourcesDir = path.join(stagedOverlayDir, 'resources');
const overlaySourceDir = path.join(repoRoot, 'GSM_Overlay');
const serverExecutableName = platform === 'win32' ? 'gsm_overlay_server.exe' : 'gsm_overlay_server';

function overlayResourcesCandidates() {
  return [
    path.join(overlayOutDir, 'resources'),
    path.join(overlayOutDir, 'gsm_overlay.app', 'Contents', 'Resources'),
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

async function findOverlayResourcesDir() {
  for (const candidate of overlayResourcesCandidates()) {
    if (await exists(path.join(candidate, 'app.asar'))) {
      return candidate;
    }
  }

  const searched = overlayResourcesCandidates()
    .map((candidate) => `  - ${candidate}`)
    .join('\n');
  throw new Error(
    `Overlay package resources were not found for ${overlayDirName}.\nSearched:\n${searched}\nRun npm run package in GSM_Overlay first.`
  );
}

async function stageInputServerBinary() {
  const stagedServerPath = path.join(stagedResourcesDir, serverExecutableName);
  if (await exists(stagedServerPath)) {
    return;
  }

  const candidates = [
    path.join(overlaySourceDir, 'input_server', 'bin', platform, serverExecutableName),
    path.join(overlaySourceDir, 'input_server', 'bin', serverExecutableName),
  ];

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      await fs.copyFile(candidate, stagedServerPath);
      if (platform !== 'win32') {
        await fs.chmod(stagedServerPath, 0o755);
      }
      console.log(`[stage-overlay-build] Staged input server ${candidate} -> ${stagedServerPath}`);
      return;
    }
  }

  const searched = candidates.map((candidate) => `  - ${candidate}`).join('\n');
  throw new Error(`Overlay input server binary was not found.\nSearched:\n${searched}`);
}

async function main() {
  const resourcesDir = await findOverlayResourcesDir();

  await fs.rm(stagedOverlayRoot, { recursive: true, force: true });
  await fs.mkdir(stagedOverlayDir, { recursive: true });
  await fs.cp(resourcesDir, stagedResourcesDir, { recursive: true });
  await stageInputServerBinary();

  console.log(`[stage-overlay-build] Staged ${resourcesDir} -> ${stagedResourcesDir}`);
}

main().catch((error) => {
  console.error(`[stage-overlay-build] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
