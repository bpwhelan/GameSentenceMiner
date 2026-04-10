import { pathToFileURL } from "node:url";

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

export function renderStableReleaseBody({ repo = DEFAULT_REPO, version }) {
  ensureVersion(version);

  const windowsFile = `GameSentenceMiner-Setup-${version}.exe`;
  const linuxFile = `GameSentenceMiner-${version}.AppImage`;
  const macFile = `GameSentenceMiner-${version}-arm64.dmg`;

  return [
    "## Downloads",
    "",
    "| OS | Download |",
    "| --- | --- |",
    `| Windows | [${windowsFile}](${buildDownloadUrl(repo, version, windowsFile)}) |`,
    `| Linux | [${linuxFile}](${buildDownloadUrl(repo, version, linuxFile)}) |`,
    `| macOS (Apple Silicon) | [${macFile}](${buildDownloadUrl(repo, version, macFile)}) |`,
    "",
    "Intel Mac builds are no longer provided. If you need GSM on Intel Mac, run it from source.",
  ].join("\n");
}

export function renderPrereleaseBody({ repo = DEFAULT_REPO }) {
  return [
    "> **Development prerelease**",
    "> This is not the latest stable release and should only be downloaded if you know what you are doing.",
    `> Most users should use the latest stable release: https://github.com/${repo}/releases/latest`,
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
