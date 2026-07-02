import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const manifestPath = path.join(repoRoot, "electron-src", "assets", "changelog", "manifest.json");
const changelogRoot = path.dirname(manifestPath);
const packageJsonPath = path.join(repoRoot, "package.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseArgs(argv) {
  const args = {
    version: readJson(packageJsonPath).version,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version") {
      args.version = argv[i + 1] ?? args.version;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function isSafeRelativePath(value) {
  return Boolean(value) && !path.isAbsolute(value) && !value.replaceAll("\\", "/").split("/").includes("..");
}

function isValidVersion(value) {
  return typeof value === "string" && /^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function assertInsideRoot(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes changelog root: ${candidate}`);
  }
}

function extractImageRefs(markdown) {
  const refs = [];
  const imagePattern = /!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  let match;
  while ((match = imagePattern.exec(markdown)) !== null) {
    refs.push(match[1]);
  }
  return refs;
}

function isExternalUrl(value) {
  return /^(?:https?:|data:|blob:|gsm-changelog:)/i.test(value);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!isValidVersion(args.version)) {
    throw new Error(`Invalid package version: ${args.version}`);
  }

  const manifest = readJson(manifestPath);
  const releases = Array.isArray(manifest.releases) ? manifest.releases : [];
  const versions = new Set();
  let targetFound = false;

  for (const release of releases) {
    if (!release || !isValidVersion(release.version)) {
      throw new Error(`Invalid changelog release version: ${JSON.stringify(release)}`);
    }
    if (versions.has(release.version)) {
      throw new Error(`Duplicate changelog release version: ${release.version}`);
    }
    versions.add(release.version);
    targetFound ||= release.version === args.version;

    const relativeFile = release.file || `releases/${release.version}.md`;
    if (!isSafeRelativePath(relativeFile)) {
      throw new Error(`Unsafe changelog file path for ${release.version}: ${relativeFile}`);
    }
    const markdownPath = path.resolve(changelogRoot, relativeFile);
    assertInsideRoot(changelogRoot, markdownPath);
    if (!fs.existsSync(markdownPath)) {
      throw new Error(`Missing changelog markdown for ${release.version}: ${relativeFile}`);
    }

    const markdown = fs.readFileSync(markdownPath, "utf8");
    for (const ref of extractImageRefs(markdown)) {
      if (isExternalUrl(ref)) {
        continue;
      }
      if (!isSafeRelativePath(ref)) {
        throw new Error(`Unsafe image path in ${relativeFile}: ${ref}`);
      }
      const imagePath = path.resolve(changelogRoot, "images", ref);
      assertInsideRoot(path.join(changelogRoot, "images"), imagePath);
      if (!fs.existsSync(imagePath)) {
        throw new Error(`Missing changelog image referenced by ${relativeFile}: ${ref}`);
      }
    }
  }

  if (!targetFound) {
    throw new Error(`No bundled changelog entry exists for package version ${args.version}.`);
  }

  console.log(`[validate-changelog] ${releases.length} release note entr${releases.length === 1 ? "y" : "ies"} valid.`);
  console.log(`[validate-changelog] Remote asset name: changelog-v${args.version}.json`);
}

main();
