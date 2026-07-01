import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_REPO = "bpwhelan/GameSentenceMiner";
const repoRoot = process.cwd();
const changelogRoot = path.join(repoRoot, "electron-src", "assets", "changelog");
const manifestPath = path.join(changelogRoot, "manifest.json");

function parseArgs(argv) {
  const args = {
    repo: DEFAULT_REPO,
    out: "",
    version: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version") {
      args.version = argv[i + 1] ?? args.version;
      i += 1;
    } else if (arg === "--repo") {
      args.repo = argv[i + 1] ?? args.repo;
      i += 1;
    } else if (arg === "--out") {
      args.out = argv[i + 1] ?? args.out;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.version) {
    throw new Error("Missing --version.");
  }
  if (!args.out) {
    args.out = path.join(repoRoot, "dist", `changelog-v${args.version}.json`);
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isExternalUrl(value) {
  return /^(?:https?:|data:|blob:|gsm-changelog:)/i.test(value);
}

function sanitizeAssetName(version, ref) {
  const cleanRef = ref.replaceAll("\\", "/").replace(/[^0-9A-Za-z._-]+/g, "-");
  return `changelog-assets-${version}-${cleanRef}`;
}

function fallbackMarkdown(version) {
  return [
    `# What's Changed in ${version}`,
    "",
    "This build does not include detailed bundled release notes yet.",
  ].join("\n");
}

function rewriteMarkdownImages(markdown, version, outDir) {
  return markdown.replace(/!\[([^\]]*)]\(([^)\s]+)(\s+["'][^"']*["'])?\)/g, (match, alt, ref, title = "") => {
    if (isExternalUrl(ref)) {
      return match;
    }

    const imageSource = path.resolve(changelogRoot, "images", ref);
    if (!imageSource.startsWith(`${path.resolve(changelogRoot, "images")}${path.sep}`)) {
      throw new Error(`Image path escapes changelog images root: ${ref}`);
    }
    if (!fs.existsSync(imageSource)) {
      throw new Error(`Missing image referenced by changelog: ${ref}`);
    }

    const assetName = sanitizeAssetName(version, ref);
    fs.copyFileSync(imageSource, path.join(outDir, assetName));
    return `![${alt}](${assetName}${title})`;
  });
}

function loadReleaseMarkdown(version, outDir) {
  const manifest = readJson(manifestPath);
  const releases = Array.isArray(manifest.releases) ? manifest.releases : [];
  const entry = releases.find((release) => release?.version === version);
  if (!entry) {
    return {
      title: `What's Changed in ${version}`,
      markdown: fallbackMarkdown(version),
    };
  }

  const relativeFile = entry.file || `releases/${version}.md`;
  const markdownPath = path.resolve(changelogRoot, relativeFile);
  if (!markdownPath.startsWith(`${path.resolve(changelogRoot)}${path.sep}`)) {
    throw new Error(`Changelog markdown path escapes root: ${relativeFile}`);
  }

  return {
    title: entry.title || `What's Changed in ${version}`,
    markdown: rewriteMarkdownImages(fs.readFileSync(markdownPath, "utf8").trim(), version, outDir),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.dirname(path.resolve(args.out));
  fs.mkdirSync(outDir, { recursive: true });

  const content = loadReleaseMarkdown(args.version, outDir);
  const payload = {
    version: args.version,
    title: content.title,
    markdown: content.markdown,
    assetBaseUrl: `https://github.com/${args.repo}/releases/download/v${args.version}/`,
  };

  fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`[export-changelog] Wrote ${args.out}`);
}

main();
