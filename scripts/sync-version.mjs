import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// package.json owns the desktop version.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(repoRoot, "package.json");

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
