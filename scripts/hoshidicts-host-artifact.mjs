#!/usr/bin/env node

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), '..');

export const HOSHIDICTS_HOST_MANIFEST = 'hoshidicts-host-manifest.json';
export const HOSHIDICTS_HOST_PROVENANCE = 'hoshidicts-provenance.json';
export const HOSHIDICTS_HOST_SOURCE_PATH = 'GSM_Overlay/hoshidicts_host';
export const HOSHIDICTS_PROTOCOL_VERSION = '1.0';

const provenanceSourcePath = `${HOSHIDICTS_HOST_SOURCE_PATH}/provenance.json`;
const payloadSources = Object.freeze([
  {
    source: 'THIRD_PARTY_NOTICES.md',
    destination: 'THIRD_PARTY_NOTICES.md',
  },
  {
    source: provenanceSourcePath,
    destination: HOSHIDICTS_HOST_PROVENANCE,
  },
  {
    source: 'LICENSE',
    destination: 'licenses/GameSentenceMiner-LGPL-3.0-only.txt',
  },
  {
    source: `${HOSHIDICTS_HOST_SOURCE_PATH}/vendor/hoshidicts/LICENSE`,
    destination: 'licenses/HoshiDicts-MIT.txt',
  },
  {
    source: `${HOSHIDICTS_HOST_SOURCE_PATH}/vendor/hoshidicts/external/Jiten/LICENSE`,
    destination: 'licenses/Jiten-Apache-2.0.txt',
  },
  {
    source: `${HOSHIDICTS_HOST_SOURCE_PATH}/vendor/hoshidicts/external/glaze/LICENSE`,
    destination: 'licenses/glaze-MIT.txt',
  },
  {
    source: `${HOSHIDICTS_HOST_SOURCE_PATH}/vendor/hoshidicts/external/libdeflate/COPYING`,
    destination: 'licenses/libdeflate-MIT.txt',
  },
  {
    source: `${HOSHIDICTS_HOST_SOURCE_PATH}/vendor/hoshidicts/external/unordered_dense/LICENSE`,
    destination: 'licenses/unordered_dense-MIT.txt',
  },
  {
    source: `${HOSHIDICTS_HOST_SOURCE_PATH}/vendor/hoshidicts/external/utfcpp/LICENSE`,
    destination: 'licenses/utfcpp-BSL-1.0.txt',
  },
  {
    source: `${HOSHIDICTS_HOST_SOURCE_PATH}/vendor/hoshidicts/external/xxHash/LICENSE`,
    destination: 'licenses/xxHash-BSD-2-Clause.txt',
  },
  {
    source: `${HOSHIDICTS_HOST_SOURCE_PATH}/vendor/hoshidicts/external/zstd/LICENSE`,
    destination: 'licenses/zstd-BSD-3-Clause.txt',
  },
  {
    source: `${HOSHIDICTS_HOST_SOURCE_PATH}/vendor/hoshidicts/external/zstd/COPYING`,
    destination: 'licenses/zstd-COPYING.txt',
  },
]);

function resolveInside(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes its root: ${relativePath}`);
  }
  return resolved;
}

function bundlePath(bundleRoot, relativePath) {
  return resolveInside(bundleRoot, path.join(...relativePath.split('/')));
}

async function sha256File(filePath) {
  const contents = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function runChecked(executable, args, options = {}) {
  try {
    return execFileSync(executable, args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }).trim();
  } catch (error) {
    const stderr = error?.stderr?.toString?.().trim();
    const detail = stderr ? `: ${stderr}` : '';
    throw new Error(`${executable} ${args.join(' ')} failed${detail}`, {
      cause: error,
    });
  }
}

function runGit(repoRoot, args) {
  return runChecked('git', ['-C', repoRoot, ...args]);
}

function parseHostVersion(output) {
  const match = /^gsm_hoshidicts_host ([^\s]+) hoshidicts ([0-9a-f]{40})$/.exec(
    output,
  );
  if (!match) {
    throw new Error(`Unexpected host --version output: ${JSON.stringify(output)}`);
  }
  return {
    hostVersion: match[1],
    hoshidictsCommit: match[2],
  };
}

function detectPe(buffer) {
  if (buffer.length < 0x40 || buffer.toString('ascii', 0, 2) !== 'MZ') {
    return null;
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (
    peOffset + 6 > buffer.length ||
    buffer.toString('binary', peOffset, peOffset + 4) !== 'PE\u0000\u0000'
  ) {
    throw new Error('Invalid PE executable header');
  }
  const machine = buffer.readUInt16LE(peOffset + 4);
  const architectures = new Map([
    [0x8664, 'x64'],
    [0xaa64, 'arm64'],
  ]);
  const arch = architectures.get(machine);
  if (!arch) {
    throw new Error(`Unsupported PE machine 0x${machine.toString(16)}`);
  }
  return { format: 'pe', arch };
}

function detectElf(buffer) {
  if (
    buffer.length < 20 ||
    buffer[0] !== 0x7f ||
    buffer.toString('ascii', 1, 4) !== 'ELF'
  ) {
    return null;
  }
  if (buffer[4] !== 2 || buffer[5] !== 1) {
    throw new Error('Only 64-bit little-endian ELF executables are supported');
  }
  const machine = buffer.readUInt16LE(18);
  const architectures = new Map([
    [0x3e, 'x64'],
    [0xb7, 'arm64'],
  ]);
  const arch = architectures.get(machine);
  if (!arch) {
    throw new Error(`Unsupported ELF machine 0x${machine.toString(16)}`);
  }
  return { format: 'elf', arch };
}

function detectMachO(buffer) {
  if (buffer.length < 8) {
    return null;
  }
  const magic = buffer.readUInt32LE(0);
  if (magic !== 0xfeedfacf) {
    if (magic === 0xbebafeca || magic === 0xcafebabe) {
      throw new Error('Universal Mach-O binaries are not accepted');
    }
    return null;
  }
  const cpuType = buffer.readUInt32LE(4);
  const architectures = new Map([
    [0x01000007, 'x64'],
    [0x0100000c, 'arm64'],
  ]);
  const arch = architectures.get(cpuType);
  if (!arch) {
    throw new Error(`Unsupported Mach-O CPU type 0x${cpuType.toString(16)}`);
  }
  return { format: 'mach-o', arch };
}

export function inspectExecutableBuffer(buffer) {
  for (const detector of [detectPe, detectElf, detectMachO]) {
    const result = detector(buffer);
    if (result) {
      return result;
    }
  }
  throw new Error('File is not a supported PE, ELF, or Mach-O executable');
}

export function executableContentSha256(
  buffer,
  inspection = inspectExecutableBuffer(buffer),
) {
  if (inspection.format !== 'pe') {
    return sha256Buffer(buffer);
  }

  const peOffset = buffer.readUInt32LE(0x3c);
  const numberOfSections = buffer.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = buffer.readUInt16LE(peOffset + 20);
  const optionalHeaderOffset = peOffset + 24;
  const optionalMagic = buffer.readUInt16LE(optionalHeaderOffset);
  const dataDirectoryOffset =
    optionalHeaderOffset + (optionalMagic === 0x20b ? 112 : 96);
  if (optionalMagic !== 0x20b && optionalMagic !== 0x10b) {
    throw new Error(`Unsupported PE optional header 0x${optionalMagic.toString(16)}`);
  }
  const checksumOffset = optionalHeaderOffset + 64;
  const securityDirectoryOffset = dataDirectoryOffset + 8 * 4;
  const sizeOfHeaders = buffer.readUInt32LE(optionalHeaderOffset + 60);
  const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;
  const sectionTableEnd = sectionTableOffset + numberOfSections * 40;
  if (
    sizeOfHeaders > buffer.length ||
    sectionTableEnd > sizeOfHeaders ||
    securityDirectoryOffset + 8 > sizeOfHeaders
  ) {
    throw new Error('Invalid PE image layout');
  }

  const normalizedHeaders = Buffer.from(buffer.subarray(0, sizeOfHeaders));
  normalizedHeaders.fill(0, checksumOffset, checksumOffset + 4);
  normalizedHeaders.fill(0, securityDirectoryOffset, securityDirectoryOffset + 8);
  const hash = crypto.createHash('sha256').update(normalizedHeaders);
  const sections = [];
  for (let index = 0; index < numberOfSections; index += 1) {
    const sectionOffset = sectionTableOffset + index * 40;
    const size = buffer.readUInt32LE(sectionOffset + 16);
    const offset = buffer.readUInt32LE(sectionOffset + 20);
    if (size === 0) {
      continue;
    }
    if (offset + size > buffer.length) {
      throw new Error('PE section extends beyond the executable');
    }
    sections.push({ offset, size });
  }
  sections.sort((left, right) => left.offset - right.offset);
  for (const section of sections) {
    hash.update(buffer.subarray(section.offset, section.offset + section.size));
  }
  return hash.digest('hex');
}

export function expectedExecutableFormat(platform) {
  const formats = {
    win32: 'pe',
    linux: 'elf',
    darwin: 'mach-o',
  };
  const format = formats[platform];
  if (!format) {
    throw new Error(`Unsupported HoshiDicts host platform: ${platform}`);
  }
  return format;
}

export function hoshidictsHostExecutableName(platform) {
  expectedExecutableFormat(platform);
  return platform === 'win32'
    ? 'gsm_hoshidicts_host.exe'
    : 'gsm_hoshidicts_host';
}

export function hoshidictsHostArchiveName(platform, arch) {
  expectedExecutableFormat(platform);
  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error(`Unsupported HoshiDicts host architecture: ${arch}`);
  }
  return `gsm-hoshidicts-host-${platform}-${arch}.tar.gz`;
}

export function hoshidictsHostBundleRelativePath(platform, arch) {
  expectedExecutableFormat(platform);
  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error(`Unsupported HoshiDicts host architecture: ${arch}`);
  }
  return path.join(HOSHIDICTS_HOST_SOURCE_PATH, 'bin', `${platform}-${arch}`);
}

async function inspectExecutable(executablePath) {
  return inspectExecutableBuffer(await fs.readFile(executablePath));
}

export function validatePlatformArchitecture(platform, arch, inspection) {
  const expectedFormat = expectedExecutableFormat(platform);
  if (inspection.format !== expectedFormat) {
    throw new Error(
      `Host format is ${inspection.format}; expected ${expectedFormat} for ${platform}`,
    );
  }
  if (inspection.arch !== arch) {
    throw new Error(
      `Host architecture is ${inspection.arch}; expected ${arch}`,
    );
  }
}

function currentSourceMetadata(repoRoot) {
  return {
    repositoryCommit: runGit(repoRoot, ['rev-parse', 'HEAD']),
    hostTree: runGit(repoRoot, [
      'rev-parse',
      `HEAD:${HOSHIDICTS_HOST_SOURCE_PATH}`,
    ]),
  };
}

function assertCleanArtifactInputs(repoRoot) {
  const paths = [
    HOSHIDICTS_HOST_SOURCE_PATH,
    'THIRD_PARTY_NOTICES.md',
    'LICENSE',
  ];
  const status = runGit(repoRoot, [
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--',
    ...paths,
  ]);
  if (status) {
    throw new Error(
      `Artifact inputs contain uncommitted changes:\n${status}`,
    );
  }
}

function powershellExecutable() {
  return process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
}

function verifyAuthenticode(executablePath) {
  const status = runChecked(
    powershellExecutable(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$signature = Get-AuthenticodeSignature -LiteralPath $env:GSM_HOSHIDICTS_HOST_VERIFY_PATH; Write-Output $signature.Status',
    ],
    {
      env: {
        ...process.env,
        GSM_HOSHIDICTS_HOST_VERIFY_PATH: executablePath,
      },
    },
  );
  if (status !== 'Valid') {
    throw new Error(`Authenticode status is ${status || 'unknown'}; expected Valid`);
  }
}

function verifyCodeSignature(executablePath) {
  runChecked('codesign', ['--verify', '--strict', '--verbose=2', executablePath]);
}

export function linuxDependencyProblems(dynamicSection, versionInfo) {
  const problems = [];
  const allowedLibraries = new Set([
    'ld-linux-x86-64.so.2',
    'libc.so.6',
    'libdl.so.2',
    'libm.so.6',
    'libpthread.so.0',
    'librt.so.1',
  ]);
  const libraries = [
    ...dynamicSection.matchAll(/Shared library: \[([^\]]+)\]/g),
  ].map((match) => match[1]);
  for (const library of libraries) {
    if (
      !allowedLibraries.has(library) &&
      library !== 'libstdc++.so.6' &&
      library !== 'libgcc_s.so.1'
    ) {
      problems.push(`unexpected dynamic dependency ${library}`);
    }
  }
  if (libraries.includes('libstdc++.so.6')) {
    problems.push('libstdc++ must be linked into the release host');
  }
  if (libraries.includes('libgcc_s.so.1')) {
    problems.push('libgcc must be linked into the release host');
  }

  const glibcVersions = [
    ...versionInfo.matchAll(/\bGLIBC_(\d+)\.(\d+)\b/g),
  ].map((match) => [Number(match[1]), Number(match[2])]);
  const tooNew = glibcVersions.filter(
    ([major, minor]) => major > 2 || (major === 2 && minor > 35),
  );
  if (tooNew.length > 0) {
    const newest = tooNew.sort(
      ([leftMajor, leftMinor], [rightMajor, rightMinor]) =>
        rightMajor - leftMajor || rightMinor - leftMinor,
    )[0];
    problems.push(
      `host requires GLIBC_${newest[0]}.${newest[1]}; maximum supported is GLIBC_2.35`,
    );
  }
  return problems;
}

function verifyLinuxDependencies(executablePath) {
  const problems = linuxDependencyProblems(
    runChecked('readelf', ['--dynamic', executablePath]),
    runChecked('readelf', ['--version-info', executablePath]),
  );
  if (problems.length > 0) {
    throw new Error(
      `Linux host dependency verification failed:\n- ${problems.join('\n- ')}`,
    );
  }
}

function verifyTrust(executablePath, platform, trustStatus, requireTrusted) {
  if (platform === 'linux') {
    if (trustStatus !== 'not-applicable') {
      throw new Error(
        `Linux host trust status is ${trustStatus}; expected not-applicable`,
      );
    }
    return;
  }

  if (!['signed', 'unsigned-development'].includes(trustStatus)) {
    throw new Error(`Unsupported host trust status: ${trustStatus}`);
  }
  if (requireTrusted && trustStatus !== 'signed') {
    throw new Error(
      `Host is marked ${trustStatus}; a signed stable artifact is required`,
    );
  }
  if (trustStatus !== 'signed') {
    return;
  }
  if (platform === 'win32') {
    verifyAuthenticode(executablePath);
  } else if (platform === 'darwin') {
    verifyCodeSignature(executablePath);
  }
}

function determineTrust(executablePath, platform, requestedTrust) {
  if (platform === 'linux') {
    if (requestedTrust && requestedTrust !== 'not-applicable' && requestedTrust !== 'auto') {
      throw new Error('Linux host trust must be not-applicable');
    }
    return 'not-applicable';
  }

  if (!requestedTrust || requestedTrust === 'auto') {
    try {
      if (platform === 'win32') {
        verifyAuthenticode(executablePath);
      } else {
        verifyCodeSignature(executablePath);
      }
      return 'signed';
    } catch {
      return 'unsigned-development';
    }
  }

  if (!['signed', 'unsigned-development'].includes(requestedTrust)) {
    throw new Error(`Unsupported requested trust status: ${requestedTrust}`);
  }
  verifyTrust(executablePath, platform, requestedTrust, requestedTrust === 'signed');
  return requestedTrust;
}

async function collectPayload(repoRoot) {
  const payload = {};
  for (const entry of payloadSources) {
    const sourcePath = resolveInside(repoRoot, entry.source);
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) {
      throw new Error(`Required artifact payload is not a file: ${entry.source}`);
    }
    payload[entry.destination] = {
      source: entry.source,
      sha256: await sha256File(sourcePath),
      size: stat.size,
    };
  }
  return payload;
}

async function copyPayload(repoRoot, bundleRoot) {
  for (const entry of payloadSources) {
    const destination = bundlePath(bundleRoot, entry.destination);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(resolveInside(repoRoot, entry.source), destination);
  }
}

function compareString(problems, label, actual, expected) {
  if (actual !== expected) {
    problems.push(`${label} is ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`);
  }
}

export function compareHoshiDictsHostManifest(
  manifest,
  {
    platform,
    arch,
    inspection,
    executableSha256,
    executableContentSha256: observedContentSha256,
    executableSize,
    executableMode,
    currentHoshidictsCommit,
    currentHostTree,
    payload,
    allowResigned = false,
  },
) {
  const problems = [];
  if (manifest?.schemaVersion !== 1) {
    problems.push(`manifest schema is ${JSON.stringify(manifest?.schemaVersion)}; expected 1`);
    return problems;
  }

  compareString(problems, 'artifact platform', manifest.artifact?.platform, platform);
  compareString(problems, 'artifact architecture', manifest.artifact?.arch, arch);
  compareString(
    problems,
    'artifact format',
    manifest.artifact?.format,
    inspection.format,
  );
  compareString(
    problems,
    'artifact executable',
    manifest.artifact?.executable,
    hoshidictsHostExecutableName(platform),
  );
  if (!allowResigned) {
    compareString(
      problems,
      'artifact SHA-256',
      manifest.artifact?.sha256,
      executableSha256,
    );
  }
  compareString(
    problems,
    'artifact content SHA-256',
    manifest.artifact?.contentSha256,
    observedContentSha256,
  );
  if (!allowResigned && manifest.artifact?.size !== executableSize) {
    problems.push(
      `artifact size is ${JSON.stringify(manifest.artifact?.size)}; expected ${executableSize}`,
    );
  }
  if (platform !== 'win32' && executableMode !== null && (executableMode & 0o111) === 0) {
    problems.push('artifact executable mode has no execute bit');
  }
  compareString(
    problems,
    'protocol version',
    manifest.host?.protocolVersion,
    HOSHIDICTS_PROTOCOL_VERSION,
  );
  compareString(
    problems,
    'HoshiDicts source pin',
    manifest.host?.hoshidictsCommit,
    currentHoshidictsCommit,
  );
  compareString(
    problems,
    'host source tree',
    manifest.source?.hostTree,
    currentHostTree,
  );
  compareString(
    problems,
    'host source path',
    manifest.source?.hostPath,
    HOSHIDICTS_HOST_SOURCE_PATH,
  );
  if (!/^[0-9a-f]{40}$/.test(manifest.source?.repositoryCommit ?? '')) {
    problems.push('repository commit is not a full Git object ID');
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.source?.hostTree ?? '')) {
    problems.push('host source tree is not a full Git object ID');
  }
  if (typeof manifest.host?.version !== 'string' || !manifest.host.version) {
    problems.push('host version is missing');
  }
  const acceptedTrust =
    platform === 'linux'
      ? ['not-applicable']
      : ['signed', 'unsigned-development'];
  if (!acceptedTrust.includes(manifest.trust?.status)) {
    problems.push(
      `trust status is ${JSON.stringify(manifest.trust?.status)}; expected one of ${JSON.stringify(acceptedTrust)}`,
    );
  }

  const expectedPayloadNames = Object.keys(payload).sort();
  const manifestPayloadNames = Object.keys(manifest.payload ?? {}).sort();
  if (JSON.stringify(manifestPayloadNames) !== JSON.stringify(expectedPayloadNames)) {
    problems.push(
      `payload file set is ${JSON.stringify(manifestPayloadNames)}; expected ${JSON.stringify(expectedPayloadNames)}`,
    );
  }
  for (const name of expectedPayloadNames) {
    const expected = payload[name];
    const actual = manifest.payload?.[name];
    compareString(problems, `payload ${name} source`, actual?.source, expected.source);
    compareString(problems, `payload ${name} SHA-256`, actual?.sha256, expected.sha256);
    if (actual?.size !== expected.size) {
      problems.push(
        `payload ${name} size is ${JSON.stringify(actual?.size)}; expected ${expected.size}`,
      );
    }
  }

  return problems;
}

async function runHostContract(executablePath, manifest) {
  const version = parseHostVersion(runChecked(executablePath, ['--version']));
  if (version.hostVersion !== manifest.host.version) {
    throw new Error(
      `Host version is ${version.hostVersion}; manifest records ${manifest.host.version}`,
    );
  }
  if (version.hoshidictsCommit !== manifest.host.hoshidictsCommit) {
    throw new Error(
      `Host reports HoshiDicts ${version.hoshidictsCommit}; manifest records ${manifest.host.hoshidictsCommit}`,
    );
  }
  const protocolVersion = runChecked(executablePath, ['--protocol-version']);
  if (protocolVersion !== manifest.host.protocolVersion) {
    throw new Error(
      `Host protocol is ${protocolVersion}; manifest records ${manifest.host.protocolVersion}`,
    );
  }
  runChecked(executablePath, ['--self-test']);
}

export async function createHoshiDictsHostBundle({
  repoRoot = defaultRepoRoot,
  executablePath,
  bundleRoot,
  platform = process.platform,
  arch = process.arch,
  trust = 'auto',
  allowDirtySource = false,
  smokeFixture = null,
}) {
  if (!executablePath || !bundleRoot) {
    throw new Error('create requires executablePath and bundleRoot');
  }
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedExecutable = path.resolve(executablePath);
  const resolvedBundleRoot = path.resolve(bundleRoot);
  if (!allowDirtySource) {
    assertCleanArtifactInputs(resolvedRepoRoot);
  }

  const inspection = await inspectExecutable(resolvedExecutable);
  validatePlatformArchitecture(platform, arch, inspection);
  const sourceMetadata = currentSourceMetadata(resolvedRepoRoot);
  const provenance = JSON.parse(
    await fs.readFile(resolveInside(resolvedRepoRoot, provenanceSourcePath), 'utf8'),
  );
  const hostVersion = parseHostVersion(
    runChecked(resolvedExecutable, ['--version']),
  );
  if (hostVersion.hoshidictsCommit !== provenance.source.commit) {
    throw new Error(
      `Host reports HoshiDicts ${hostVersion.hoshidictsCommit}; expected ${provenance.source.commit}`,
    );
  }
  const protocolVersion = runChecked(resolvedExecutable, ['--protocol-version']);
  if (protocolVersion !== HOSHIDICTS_PROTOCOL_VERSION) {
    throw new Error(
      `Host protocol is ${protocolVersion}; expected ${HOSHIDICTS_PROTOCOL_VERSION}`,
    );
  }
  runChecked(resolvedExecutable, ['--self-test']);

  const executableName = hoshidictsHostExecutableName(platform);
  const trustStatus = determineTrust(resolvedExecutable, platform, trust);
  const executableStat = await fs.stat(resolvedExecutable);
  const executableContents = await fs.readFile(resolvedExecutable);
  const payload = await collectPayload(resolvedRepoRoot);
  const manifest = {
    schemaVersion: 1,
    artifact: {
      platform,
      arch,
      format: inspection.format,
      executable: executableName,
      sha256: sha256Buffer(executableContents),
      contentSha256: executableContentSha256(executableContents, inspection),
      size: executableStat.size,
      unixMode: platform === 'win32' ? null : 0o755,
    },
    host: {
      version: hostVersion.hostVersion,
      protocolVersion,
      hoshidictsCommit: hostVersion.hoshidictsCommit,
    },
    source: {
      repositoryCommit: sourceMetadata.repositoryCommit,
      hostTree: sourceMetadata.hostTree,
      hostPath: HOSHIDICTS_HOST_SOURCE_PATH,
    },
    trust: {
      status: trustStatus,
    },
    payload,
  };

  await fs.rm(resolvedBundleRoot, { recursive: true, force: true });
  await fs.mkdir(resolvedBundleRoot, { recursive: true });
  const bundledExecutable = path.join(resolvedBundleRoot, executableName);
  await fs.copyFile(resolvedExecutable, bundledExecutable);
  if (platform !== 'win32') {
    await fs.chmod(bundledExecutable, 0o755);
  }
  await copyPayload(resolvedRepoRoot, resolvedBundleRoot);
  await fs.writeFile(
    path.join(resolvedBundleRoot, HOSHIDICTS_HOST_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  await verifyHoshiDictsHostBundle({
    repoRoot: resolvedRepoRoot,
    bundleRoot: resolvedBundleRoot,
    platform,
    arch,
    requireTrusted: trustStatus === 'signed',
    smokeFixture,
  });
  return manifest;
}

export async function verifyHoshiDictsHostBundle({
  repoRoot = defaultRepoRoot,
  bundleRoot,
  platform = process.platform,
  arch = process.arch,
  requireTrusted = false,
  allowResignedHost = false,
  execute = true,
  smokeFixture = null,
}) {
  if (!bundleRoot) {
    throw new Error('verify requires bundleRoot');
  }
  const resolvedRepoRoot = path.resolve(repoRoot);
  const resolvedBundleRoot = path.resolve(bundleRoot);
  const manifestPath = path.join(resolvedBundleRoot, HOSHIDICTS_HOST_MANIFEST);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const executablePath = path.join(
    resolvedBundleRoot,
    hoshidictsHostExecutableName(platform),
  );
  const executableStat = await fs.stat(executablePath);
  if (!executableStat.isFile()) {
    throw new Error(`Host executable is not a file: ${executablePath}`);
  }
  const inspection = await inspectExecutable(executablePath);
  const executableContents = await fs.readFile(executablePath);
  validatePlatformArchitecture(platform, arch, inspection);

  const provenance = JSON.parse(
    await fs.readFile(resolveInside(resolvedRepoRoot, provenanceSourcePath), 'utf8'),
  );
  const sourceMetadata = currentSourceMetadata(resolvedRepoRoot);
  const expectedPayload = await collectPayload(resolvedRepoRoot);
  const observedPayload = {};
  for (const [name, expected] of Object.entries(expectedPayload)) {
    const artifactPath = bundlePath(resolvedBundleRoot, name);
    const stat = await fs.stat(artifactPath);
    if (!stat.isFile()) {
      throw new Error(`Artifact payload is not a file: ${name}`);
    }
    observedPayload[name] = {
      source: expected.source,
      sha256: await sha256File(artifactPath),
      size: stat.size,
    };
  }

  const problems = compareHoshiDictsHostManifest(manifest, {
    platform,
    arch,
    inspection,
    executableSha256: sha256Buffer(executableContents),
    executableContentSha256: executableContentSha256(
      executableContents,
      inspection,
    ),
    executableSize: executableStat.size,
    executableMode: platform === 'win32' ? null : executableStat.mode,
    currentHoshidictsCommit: provenance.source.commit,
    currentHostTree: sourceMetadata.hostTree,
    payload: observedPayload,
    allowResigned: allowResignedHost,
  });
  for (const [name, current] of Object.entries(expectedPayload)) {
    const bundled = observedPayload[name];
    if (bundled.sha256 !== current.sha256 || bundled.size !== current.size) {
      problems.push(
        `payload ${name} does not match current source ${current.source}`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `HoshiDicts host artifact verification failed:\n- ${problems.join('\n- ')}`,
    );
  }

  verifyTrust(
    executablePath,
    platform,
    manifest.trust?.status,
    requireTrusted,
  );
  if (execute) {
    if (platform !== process.platform || arch !== process.arch) {
      throw new Error(
        `Cannot execute ${platform}-${arch} host on ${process.platform}-${process.arch}`,
      );
    }
    if (platform === 'linux') {
      verifyLinuxDependencies(executablePath);
    }
    await runHostContract(executablePath, manifest);
  }
  if (smokeFixture) {
    runChecked(process.execPath, [
      path.join(
        resolvedRepoRoot,
        HOSHIDICTS_HOST_SOURCE_PATH,
        'tests',
        'packaged_smoke.cjs',
      ),
      executablePath,
      path.resolve(smokeFixture),
    ]);
  }
  return { manifest, executablePath };
}

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

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['create', 'verify'].includes(command)) {
    throw new Error(
      'Usage: hoshidicts-host-artifact.mjs <create|verify> --bundle-dir PATH [options]',
    );
  }
  const repoRoot = path.resolve(optionValue(args, '--repo-root', defaultRepoRoot));
  const bundleRoot = path.resolve(optionValue(args, '--bundle-dir'));
  const platform = optionValue(args, '--platform', process.platform);
  const arch = optionValue(args, '--arch', process.arch);
  const smokeFixture = optionValue(args, '--smoke-fixture');

  if (command === 'create') {
    const executablePath = path.resolve(optionValue(args, '--executable'));
    const manifest = await createHoshiDictsHostBundle({
      repoRoot,
      executablePath,
      bundleRoot,
      platform,
      arch,
      trust: optionValue(args, '--trust', 'auto'),
      allowDirtySource: args.includes('--allow-dirty-source'),
      smokeFixture,
    });
    console.log(
      `[hoshidicts-host-artifact] created ${platform}-${arch} bundle from ${manifest.source.hostTree}`,
    );
    return;
  }

  const { manifest } = await verifyHoshiDictsHostBundle({
    repoRoot,
    bundleRoot,
    platform,
    arch,
    requireTrusted: args.includes('--require-trusted'),
    allowResignedHost: args.includes('--allow-resigned-host'),
    execute: !args.includes('--no-execute'),
    smokeFixture,
  });
  console.log(
    `[hoshidicts-host-artifact] verified ${platform}-${arch} bundle (${manifest.trust.status})`,
  );
}

if (path.resolve(process.argv[1] ?? '') === scriptPath) {
  main().catch((error) => {
    console.error(
      `[hoshidicts-host-artifact] ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
}
