#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  HOSHIDICTS_HOST_MANIFEST,
  hoshidictsHostArchiveName,
  hoshidictsHostBundleRelativePath,
  verifyHoshiDictsHostBundle,
} from './hoshidicts-host-artifact.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), '..');

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) {
    return fallback;
  }
  if (!args[index + 1]) {
    throw new Error(`${name} requires a value`);
  }
  return args[index + 1];
}

function run(executable, args, options = {}) {
  try {
    return execFileSync(executable, args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }).trim();
  } catch (error) {
    const stderr = error?.stderr?.toString?.().trim();
    throw new Error(
      `${executable} ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`,
      { cause: error },
    );
  }
}

function validateArchiveEntry(entry) {
  if (entry === '.' || entry === './') {
    return;
  }
  const normalized = entry.replaceAll('\\', '/').replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`Unsafe host archive entry: ${JSON.stringify(entry)}`);
  }
}

async function rejectLinks(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error(`Host archive contains a symbolic link: ${entry.name}`);
    }
    if (stat.isDirectory()) {
      await rejectLinks(candidate);
    }
  }
}

async function downloadArchive({
  archivePath,
  downloadDirectory,
  repository,
  releaseTag,
  assetName,
}) {
  if (archivePath) {
    return path.resolve(archivePath);
  }
  if (!repository) {
    throw new Error(
      '--repo is required when --archive is not provided',
    );
  }
  run('gh', [
    'release',
    'download',
    releaseTag,
    '--repo',
    repository,
    '--pattern',
    assetName,
    '--dir',
    downloadDirectory,
    '--clobber',
  ]);
  return path.join(downloadDirectory, assetName);
}

export async function fetchHoshiDictsHost({
  repoRoot = defaultRepoRoot,
  repository = process.env.GITHUB_REPOSITORY,
  releaseTag = 'hoshidicts-host',
  platform = process.platform,
  arch = process.arch,
  archivePath = null,
  destination = null,
  allowUnsignedDevelopment = false,
  smokeFixture = null,
}) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedDestination = path.resolve(
    destination ??
      path.join(
        resolvedRepoRoot,
        hoshidictsHostBundleRelativePath(platform, arch),
      ),
  );
  const destinationParent = path.dirname(resolvedDestination);
  await fs.mkdir(destinationParent, { recursive: true });
  const stagingRoot = await fs.mkdtemp(
    path.join(destinationParent, '.hoshidicts-host-fetch-'),
  );
  const downloadDirectory = path.join(stagingRoot, 'download');
  const extractedDirectory = path.join(stagingRoot, 'bundle');

  try {
    await fs.mkdir(downloadDirectory);
    await fs.mkdir(extractedDirectory);
    const assetName = hoshidictsHostArchiveName(platform, arch);
    const archive = await downloadArchive({
      archivePath,
      downloadDirectory,
      repository,
      releaseTag,
      assetName,
    });
    const entries = run('tar', ['-tzf', archive]).split(/\r?\n/).filter(Boolean);
    for (const entry of entries) {
      validateArchiveEntry(entry);
    }
    const verboseEntries = run('tar', ['-tvzf', archive])
      .split(/\r?\n/)
      .filter(Boolean);
    for (const entry of verboseEntries) {
      if (/^[lh]/.test(entry)) {
        throw new Error(
          `Host archive contains a link entry: ${JSON.stringify(entry)}`,
        );
      }
    }
    run('tar', ['-xzf', archive, '-C', extractedDirectory]);
    await rejectLinks(extractedDirectory);

    const manifestAtRoot = path.join(
      extractedDirectory,
      HOSHIDICTS_HOST_MANIFEST,
    );
    try {
      await fs.access(manifestAtRoot);
    } catch {
      throw new Error(
        `Host archive does not contain ${HOSHIDICTS_HOST_MANIFEST} at its root`,
      );
    }

    await verifyHoshiDictsHostBundle({
      repoRoot: resolvedRepoRoot,
      bundleRoot: extractedDirectory,
      platform,
      arch,
      requireTrusted: !allowUnsignedDevelopment,
      smokeFixture,
    });

    await fs.rm(resolvedDestination, { recursive: true, force: true });
    await fs.rename(extractedDirectory, resolvedDestination);
    console.log(
      `[fetch-hoshidicts-host] staged ${platform}-${arch} host at ${resolvedDestination}`,
    );
    return resolvedDestination;
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  await fetchHoshiDictsHost({
    repoRoot: path.resolve(optionValue(args, '--repo-root', defaultRepoRoot)),
    repository: optionValue(
      args,
      '--repo',
      process.env.GITHUB_REPOSITORY ?? null,
    ),
    releaseTag: optionValue(args, '--release-tag', 'hoshidicts-host'),
    platform: optionValue(args, '--platform', process.platform),
    arch: optionValue(args, '--arch', process.arch),
    archivePath: optionValue(args, '--archive'),
    destination: optionValue(args, '--destination'),
    allowUnsignedDevelopment: args.includes('--allow-unsigned-development'),
    smokeFixture: optionValue(args, '--smoke-fixture'),
  });
}

if (path.resolve(process.argv[1] ?? '') === scriptPath) {
  main().catch((error) => {
    console.error(
      `[fetch-hoshidicts-host] ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
}
