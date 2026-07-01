import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_REPO = "bpwhelan/GameSentenceMiner";

function parseArgs(argv) {
  const args = {
    mode: "stable",
    repo: DEFAULT_REPO,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") {
      args.mode = argv[i + 1] ?? args.mode;
      i += 1;
    } else if (arg === "--version") {
      args.version = argv[i + 1];
      i += 1;
    } else if (arg === "--repo") {
      args.repo = argv[i + 1] ?? args.repo;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function ensureVersion(version) {
  if (!version || !/^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid or missing --version: ${version ?? ""}`);
  }
}

function buildDownloadUrl(repo, version, fileName) {
  return `https://github.com/${repo}/releases/download/v${version}/${fileName}`;
}

function renderDownloadTable({ repo, version }) {
  const windowsFile = `GameSentenceMiner-Setup-${version}.exe`;
  const windowsUnpackedFile = `GameSentenceMiner-${version}-win-unpacked.zip`;
  const linuxFile = `GameSentenceMiner-${version}.AppImage`;
  const macFile = `GameSentenceMiner-${version}-arm64.dmg`;

  return [
    "| OS | Download |",
    "| --- | --- |",
    `| Windows | [${windowsFile}](${buildDownloadUrl(repo, version, windowsFile)}) |`,
    `| Windows (unpacked) | [${windowsUnpackedFile}](${buildDownloadUrl(repo, version, windowsUnpackedFile)}) |`,
    `| Linux | [${linuxFile}](${buildDownloadUrl(repo, version, linuxFile)}) |`,
    `| macOS (Apple Silicon) | [${macFile}](${buildDownloadUrl(repo, version, macFile)}) |`,
  ];
}

function sanitizeChangelogAssetName(version, ref) {
  const cleanRef = ref.replaceAll("\\", "/").replace(/[^0-9A-Za-z._-]+/g, "-");
  return `changelog-assets-${version}-${cleanRef}`;
}

function isExternalUrl(value) {
  return /^(?:https?:|data:|blob:|gsm-changelog:)/i.test(value);
}

function rewriteChangelogImagesForRelease(markdown, repo, version) {
  return markdown.replace(/!\[([^\]]*)]\(([^)\s]+)(\s+["'][^"']*["'])?\)/g, (match, alt, ref, title = "") => {
    if (isExternalUrl(ref)) {
      return match;
    }
    const assetName = sanitizeChangelogAssetName(version, ref);
    return `![${alt}](${buildDownloadUrl(repo, version, assetName)}${title})`;
  });
}

function loadBundledChangelogMarkdown(version) {
  const repoRoot = process.cwd();
  const changelogRoot = path.join(repoRoot, "electron-src", "assets", "changelog");
  const manifestPath = path.join(changelogRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return "";
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const releases = Array.isArray(manifest.releases) ? manifest.releases : [];
    const entry = releases.find((release) => release?.version === version);
    if (!entry) {
      return "";
    }
    const relativeFile = entry.file || `releases/${version}.md`;
    const markdownPath = path.resolve(changelogRoot, relativeFile);
    if (!markdownPath.startsWith(`${path.resolve(changelogRoot)}${path.sep}`)) {
      throw new Error(`Changelog path escapes root: ${relativeFile}`);
    }
    return fs.readFileSync(markdownPath, "utf8").trim();
  } catch (error) {
    console.warn(
      `[render-release-body] Could not append bundled changelog: ${
        error instanceof Error ? error.message : error
      }`
    );
    return "";
  }
}

function renderBundledChangelogSection(repo, version) {
  const markdown = loadBundledChangelogMarkdown(version);
  if (!markdown) {
    return [];
  }

  const body = markdown.replace(/^\s*# .*(?:\r?\n)+/, "").trim();
  return ["", "## What's Changed", "", rewriteChangelogImagesForRelease(body, repo, version)];
}

export function renderStableReleaseBody({ repo = DEFAULT_REPO, version }) {
  ensureVersion(version);

  return [
    "## Downloads",
    "",
    ...renderDownloadTable({ repo, version }),
    "",
    "Intel Mac builds are no longer provided. If you need GSM on Intel Mac, run it from source.",
    ...renderBundledChangelogSection(repo, version),
  ].join("\n");
}

export function renderPrereleaseBody({ repo = DEFAULT_REPO, version }) {
  if (!version) {
    return [
      "> **Development prerelease**",
      "> This is not the latest stable release and should only be downloaded if you know what you are doing.",
      `> Most users should use the latest stable release: https://github.com/${repo}/releases/latest`,
    ].join("\n");
  }

  ensureVersion(version);

  return [
    "> **Development prerelease**",
    "> This is not the latest stable release and should only be downloaded if you know what you are doing.",
    `> Most users should use the latest stable release: https://github.com/${repo}/releases/latest`,
    "",
    "## Downloads",
    "",
    ...renderDownloadTable({ repo, version }),
    ...renderBundledChangelogSection(repo, version),
  ].join("\n");
}

function printHelp() {
  console.log(
    "Usage: node scripts/render-release-body.mjs --mode <stable|prerelease> --version <version> [--repo owner/name]"
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (args.mode === "stable") {
    process.stdout.write(`${renderStableReleaseBody(args)}\n`);
    return;
  }

  if (args.mode === "prerelease") {
    process.stdout.write(`${renderPrereleaseBody(args)}\n`);
    return;
  }

  throw new Error(`Unsupported --mode: ${args.mode}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
