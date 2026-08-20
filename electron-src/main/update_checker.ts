import { execFileSync } from "child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import log from "electron-log";
import { getPythonPath } from "./store.js";
import {
    getProjectPath,
} from "./services/python_ops.js";
import {
    getBackendUpdateDecision,
    selectLatestCompatibleVersion,
    type PyPiReleases,
} from './services/backend_version.js';

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

// Read the compatibility base shipped with this Electron build. PyPI post
// releases of this version are discovered separately below.
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

interface PyPiPackageResponse {
    releases?: PyPiReleases;
}

async function getLatestCompatibleVersion(bundledVersion: string): Promise<string> {
    try {
        const response = await fetch(`https://pypi.org/pypi/${PACKAGE_NAME}/json`, {
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
            throw new Error(`PyPI returned HTTP ${response.status}`);
        }

        const data = (await response.json()) as PyPiPackageResponse;
        return selectLatestCompatibleVersion(bundledVersion, data.releases ?? {});
    } catch (error) {
        log.warn(
            `Could not query PyPI for compatible backend post releases; using bundled ${bundledVersion}: ${error}`
        );
        return bundledVersion;
    }
}

// Check whether a compatible post release is newer than the installed backend.
async function checkForUpdates(
    force: boolean = false,
    knownInstalledVersion?: string | null
): Promise<{ updateAvailable: boolean; latestVersion: string | null }> {
    try {
        const installedVersion =
            knownInstalledVersion === undefined ? getCurrentVersion() : knownInstalledVersion;
        const bundledVersion = getLatestVersion();

        console.log(`Installed backend version: ${installedVersion}`);
        console.log(`Bundled backend version: ${bundledVersion}`);

        if (!bundledVersion) {
            log.error("Could not determine bundled backend version.");
            return { updateAvailable: false, latestVersion: null };
        }

        const latestVersion = await getLatestCompatibleVersion(bundledVersion);
        console.log(`Latest compatible backend version: ${latestVersion}`);

        const decision = getBackendUpdateDecision(
            installedVersion,
            bundledVersion,
            latestVersion,
            force
        );
        if (decision.updateAvailable) {
            log.info(`Backend version differs: ${installedVersion} -> ${latestVersion}`);
            return decision;
        } else {
            log.info("Backend already matches the latest compatible version.");
            return decision;
        }
    } catch (error) {
        log.error(`Error checking for updates: ${error}`);
        return { updateAvailable: false, latestVersion: null };
    }
}

export { checkForUpdates, getCurrentVersion, getLatestVersion };
