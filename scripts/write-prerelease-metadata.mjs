import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--')) {
      throw new Error(`Unexpected argument: ${name}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${name}`);
    }
    args[name.slice(2)] = value;
    index += 1;
  }
  return args;
}

function findOnlyWheel(wheelDir) {
  const wheelNames = fs
    .readdirSync(wheelDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.whl'))
    .map((entry) => entry.name);
  if (wheelNames.length !== 1) {
    throw new Error(`Expected exactly one wheel in ${wheelDir}; found ${wheelNames.length}.`);
  }
  return wheelNames[0];
}

export function buildPreReleaseMetadata({ branch, commit, version, wheelPath, generatedAt }) {
  if (!branch || !commit || !version) {
    throw new Error('branch, commit, and version are required.');
  }
  const fileName = path.basename(wheelPath);
  if (!fs.existsSync(wheelPath) || !fileName.toLowerCase().endsWith('.whl')) {
    throw new Error(`Invalid wheel path: ${wheelPath}`);
  }
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(wheelPath)).digest('hex');
  return {
    schemaVersion: 2,
    branch,
    commit,
    version,
    generatedAt: generatedAt ?? new Date().toISOString(),
    backendWheel: {
      fileName,
      sha256,
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const branch = args.branch || process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
  const commit = args.commit || process.env.GITHUB_SHA;
  const version = args.version;
  const wheelDir = path.resolve(args['wheel-dir'] || 'electron-src/assets/python');
  const outputPath = path.resolve(args.out || 'electron-src/assets/prerelease.json');
  const wheelPath = path.join(wheelDir, findOnlyWheel(wheelDir));
  const metadata = buildPreReleaseMetadata({ branch, commit, version, wheelPath });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  console.log(`Wrote prerelease metadata for ${metadata.backendWheel.fileName} to ${outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
