import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveProjectVersion } from "./sync-version-logic.mjs";

// package.json is the source of truth for the Electron-compatible base version.
// Keep a matching Python .postN release, since backend-only hotfixes can advance
// independently without changing the Electron app version. Run as part of the build.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const pyprojectPath = path.join(repoRoot, "pyproject.toml");

const appVersion = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).version;
if (!appVersion || typeof appVersion !== "string") {
  console.error("[sync-version] Could not read version from package.json");
  process.exit(1);
}

const nativeConfigPath = path.join(repoRoot, 'src-tauri', 'tauri.conf.json');
const nativeConfig = JSON.parse(fs.readFileSync(nativeConfigPath, 'utf8'));
if (nativeConfig.version !== appVersion) {
  nativeConfig.version = appVersion;
  fs.writeFileSync(nativeConfigPath, `${JSON.stringify(nativeConfig, null, 2)}\n`);
}
const cargoPath = path.join(repoRoot, 'src-tauri', 'Cargo.toml');
const cargo = fs.readFileSync(cargoPath, 'utf8');
const nativeVersion = cargo.replace(/(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]*"/, `$1"${appVersion}"`);
if (cargo !== nativeVersion) fs.writeFileSync(cargoPath, nativeVersion);

// The desktop CI build uses cargo --locked, including for generated preview versions.
const rootCargoLockPath = path.join(repoRoot, 'Cargo.lock');
const cargoLockPath = fs.existsSync(rootCargoLockPath)
  ? rootCargoLockPath
  : path.join(repoRoot, 'src-tauri', 'Cargo.lock');
const cargoLock = fs.readFileSync(cargoLockPath, 'utf8');
const desktopLockVersion = /(\[\[package\]\]\r?\nname = "gsm-desktop"\r?\nversion = )"[^"]+"/;
if (!desktopLockVersion.test(cargoLock)) throw Error('Missing gsm-desktop package in Cargo.lock');
const updatedLock = cargoLock.replace(desktopLockVersion, `$1"${appVersion}"`);
if (updatedLock !== cargoLock) fs.writeFileSync(cargoLockPath, updatedLock);

const pyproject = fs.readFileSync(pyprojectPath, "utf8");

// Replace the version assignment inside the [project] table only.
const projectVersionRe = /(\[project\][\s\S]*?\nversion\s*=\s*)"([^"]*)"/;
const projectVersionMatch = pyproject.match(projectVersionRe);
if (!projectVersionMatch) {
  console.error("[sync-version] Could not locate [project] version in pyproject.toml");
  process.exit(1);
}

const currentProjectVersion = projectVersionMatch[2];
const targetProjectVersion = resolveProjectVersion(appVersion, currentProjectVersion);
const updated = pyproject.replace(
  projectVersionRe,
  (_match, prefix) => `${prefix}"${targetProjectVersion}"`,
);
if (updated !== pyproject) {
  fs.writeFileSync(pyprojectPath, updated, "utf8");
  console.log(`[sync-version] pyproject.toml version set to ${targetProjectVersion}`);
  // `--stage` re-adds the file so a pre-commit run produces a single, in-sync commit.
  if (process.argv.includes("--stage")) {
    spawnSync("git", ["add", pyprojectPath], { stdio: "inherit" });
  }
} else {
  console.log(`[sync-version] pyproject.toml already at ${targetProjectVersion}`);
}
