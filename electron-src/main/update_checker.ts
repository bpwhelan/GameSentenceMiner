import { execFileSync } from "child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import log from "electron-log";
import { getPythonPath } from "./store.js";
import { getProjectPath } from "./services/python_ops.js";

const PACKAGE_NAME = "GameSentenceMiner";

// Get current installed version using `pip show`
function getCurrentVersion(): string | null {
    try {
        const pythonPath = getPythonPath();
        if (!pythonPath) {
            return null;
        }
        const output = execFileSync(pythonPath, ['-m', 'pip', 'show', PACKAGE_NAME], {
            encoding: 'utf-8',
        });
        const versionMatch = output.match(/^Version:\s*(.+)$/im);
        return versionMatch ? versionMatch[1].trim() : null;
    } catch (error) {
        log.error(`Error getting current version: ${error}`);
        return null;
    }
}

// The "latest" backend version is whatever ships in the bundled resources –
// the backend is locked to the Electron app, so this is read offline from the
// bundled pyproject.toml rather than from PyPI.
function getLatestVersion(): string | null {
    try {
        const pyprojectPath = path.join(getProjectPath(), 'pyproject.toml');
        const pyproject = fs.readFileSync(pyprojectPath, 'utf8');
        const match = pyproject.match(/\[project\][\s\S]*?\nversion\s*=\s*"([^"]+)"/);
        return match ? match[1].trim() : null;
    } catch (error) {
        log.error(`Error reading bundled backend version: ${error}`);
        return null;
    }
}

// Check whether the installed backend differs from the bundled one.
async function checkForUpdates(force: boolean = false): Promise<{ updateAvailable: boolean; latestVersion: string | null }> {
    try {
        const installedVersion = getCurrentVersion();
        const latestVersion = getLatestVersion();

        console.log(`Installed backend version: ${installedVersion}`);
        console.log(`Bundled backend version: ${latestVersion}`);

        if (!latestVersion) {
            log.error("Could not determine bundled backend version.");
            return { updateAvailable: false, latestVersion: null };
        }

        if (!installedVersion) {
            log.info(`No installed ${PACKAGE_NAME} version found. Treating bundled ${latestVersion} as install target.`);
            return { updateAvailable: true, latestVersion };
        }

        if (installedVersion !== latestVersion || force) {
            log.info(`Backend version differs: ${installedVersion} -> ${latestVersion}`);
            return { updateAvailable: true, latestVersion };
        } else {
            log.info("Backend already matches the bundled version.");
            return { updateAvailable: false, latestVersion };
        }
    } catch (error) {
        log.error(`Error checking for updates: ${error}`);
        return { updateAvailable: false, latestVersion: null };
    }
}

export { checkForUpdates, getCurrentVersion, getLatestVersion };
