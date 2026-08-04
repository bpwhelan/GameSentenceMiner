#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), '..');
const provenanceRelativePath = 'GSM_Overlay/hoshidicts_host/provenance.json';

function resolveInside(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes its provenance root: ${relativePath}`);
  }
  return resolved;
}

function runGit(workingDirectory, args) {
  return execFileSync('git', ['-C', workingDirectory, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function sha256(filePath) {
  const contents = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function parseGitlink(stageOutput, expectedPath) {
  const match = stageOutput.match(/^160000 ([0-9a-f]{40}) \d+\t(.+)$/);
  if (!match || match[2] !== expectedPath) {
    throw new Error(`Expected ${expectedPath} to be a tracked git submodule`);
  }
  return match[1];
}

function parseSubmoduleStatus(output) {
  const statuses = {};
  for (const line of output.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    const match = line.match(/^([ +\-U])([0-9a-f]{40}) ([^ ]+)(?: .*)?$/);
    if (!match) {
      throw new Error(`Unrecognized submodule status: ${line}`);
    }
    statuses[match[3]] = {
      state: match[1],
      commit: match[2],
    };
  }
  return statuses;
}

export function compareProvenance(expected, observed) {
  const problems = [];
  const expectedSourceCommit = expected.source.commit;

  if (observed.gitlinkCommit !== expectedSourceCommit) {
    problems.push(
      `tracked HoshiDicts gitlink is ${observed.gitlinkCommit}; expected ${expectedSourceCommit}`,
    );
  }
  if (observed.sourceCommit !== expectedSourceCommit) {
    problems.push(
      `checked-out HoshiDicts commit is ${observed.sourceCommit}; expected ${expectedSourceCommit}`,
    );
  }

  for (const [relativePath, expectedHash] of Object.entries(expected.source.files)) {
    const actualHash = observed.sourceFiles[relativePath];
    if (actualHash !== expectedHash) {
      problems.push(
        `source file ${relativePath} has SHA-256 ${actualHash ?? 'missing'}; expected ${expectedHash}`,
      );
    }
  }

  const expectedDependencyPaths = expected.dependencies.map((dependency) => dependency.path).sort();
  const actualDependencyPaths = Object.keys(observed.dependencies).sort();
  if (JSON.stringify(actualDependencyPaths) !== JSON.stringify(expectedDependencyPaths)) {
    problems.push(
      `recursive submodule set is ${JSON.stringify(actualDependencyPaths)}; expected ${JSON.stringify(expectedDependencyPaths)}`,
    );
  }

  for (const dependency of expected.dependencies) {
    const actual = observed.dependencies[dependency.path];
    if (!actual) {
      continue;
    }
    if (actual.state !== ' ') {
      problems.push(
        `dependency ${dependency.path} has submodule state ${JSON.stringify(actual.state)}; expected a clean initialized checkout`,
      );
    }
    if (actual.commit !== dependency.commit) {
      problems.push(
        `dependency ${dependency.path} is ${actual.commit}; expected ${dependency.commit}`,
      );
    }
    if (actual.licenseSha256 !== dependency.licenseSha256) {
      problems.push(
        `dependency ${dependency.path} license has SHA-256 ${actual.licenseSha256 ?? 'missing'}; expected ${dependency.licenseSha256}`,
      );
    }
  }

  return problems;
}

export async function collectObservedProvenance(repoRoot, expected) {
  const sourcePath = resolveInside(repoRoot, expected.source.path);
  const stageOutput = runGit(repoRoot, ['ls-files', '--stage', '--', expected.source.path]);
  const gitlinkCommit = parseGitlink(stageOutput, expected.source.path);
  const sourceCommit = runGit(sourcePath, ['rev-parse', 'HEAD']);
  const sourceFiles = {};

  for (const relativePath of Object.keys(expected.source.files)) {
    sourceFiles[relativePath] = await sha256(resolveInside(sourcePath, relativePath));
  }

  const statusOutput = execFileSync(
    'git',
    ['-C', sourcePath, 'submodule', 'status', '--recursive'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trimEnd();
  const submoduleStatuses = parseSubmoduleStatus(statusOutput);
  const dependencies = {};

  for (const [dependencyPath, status] of Object.entries(submoduleStatuses)) {
    const expectedDependency = expected.dependencies.find(
      (dependency) => dependency.path === dependencyPath,
    );
    dependencies[dependencyPath] = {
      ...status,
      licenseSha256: expectedDependency
        ? await sha256(
            resolveInside(
              sourcePath,
              path.join(dependencyPath, expectedDependency.licensePath),
            ),
          )
        : undefined,
    };
  }

  return {
    gitlinkCommit,
    sourceCommit,
    sourceFiles,
    dependencies,
  };
}

export async function verifyHoshiDictsProvenance(repoRoot = defaultRepoRoot) {
  const provenancePath = resolveInside(repoRoot, provenanceRelativePath);
  const expected = JSON.parse(await fs.readFile(provenancePath, 'utf8'));
  if (expected.schemaVersion !== 1) {
    throw new Error(`Unsupported HoshiDicts provenance schema: ${expected.schemaVersion}`);
  }
  const observed = await collectObservedProvenance(repoRoot, expected);
  const problems = compareProvenance(expected, observed);
  if (problems.length > 0) {
    throw new Error(`HoshiDicts provenance verification failed:\n- ${problems.join('\n- ')}`);
  }
  return { expected, observed };
}

async function main() {
  const args = process.argv.slice(2);
  let repoRoot = defaultRepoRoot;
  const rootIndex = args.indexOf('--repo-root');
  if (rootIndex >= 0) {
    if (!args[rootIndex + 1]) {
      throw new Error('--repo-root requires a path');
    }
    repoRoot = path.resolve(args[rootIndex + 1]);
  }
  const { expected } = await verifyHoshiDictsProvenance(repoRoot);
  console.log(
    `[verify-hoshidicts-provenance] verified ${expected.source.commit} and ${expected.dependencies.length} recursive dependencies`,
  );
}

if (path.resolve(process.argv[1] ?? '') === scriptPath) {
  main().catch((error) => {
    console.error(
      `[verify-hoshidicts-provenance] ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
}
