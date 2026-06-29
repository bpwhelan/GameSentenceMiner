import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Single source of truth: package.json `version`. This script copies it into
// pyproject.toml's [project] version so the bundled Python backend always
// reports the same version as the Electron app. Run as part of the build.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const pyprojectPath = path.join(repoRoot, "pyproject.toml");

const appVersion = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).version;
if (!appVersion || typeof appVersion !== "string") {
  console.error("[sync-version] Could not read version from package.json");
  process.exit(1);
}

const pyproject = fs.readFileSync(pyprojectPath, "utf8");

// Replace the version assignment inside the [project] table only.
const projectVersionRe = /(\[project\][\s\S]*?\nversion\s*=\s*)"[^"]*"/;
if (!projectVersionRe.test(pyproject)) {
  console.error("[sync-version] Could not locate [project] version in pyproject.toml");
  process.exit(1);
}

const updated = pyproject.replace(projectVersionRe, `$1"${appVersion}"`);
if (updated !== pyproject) {
  fs.writeFileSync(pyprojectPath, updated, "utf8");
  console.log(`[sync-version] pyproject.toml version set to ${appVersion}`);
  // `--stage` re-adds the file so a pre-commit run produces a single, in-sync commit.
  if (process.argv.includes("--stage")) {
    spawnSync("git", ["add", pyprojectPath], { stdio: "inherit" });
  }
} else {
  console.log(`[sync-version] pyproject.toml already at ${appVersion}`);
}
