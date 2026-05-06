import { execFileSync } from "child_process";
import axios from "axios";
import log from "electron-log";
import {getPythonPath} from "./store.js";

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

// Fetch latest version from PyPI
async function getLatestVersion(): Promise<string | null> {
    try {
        const response = await axios.get(`https://pypi.org/pypi/${PACKAGE_NAME}/json`);
        return response.data.info.version;
    } catch (error) {
        log.error(`Error fetching latest version from PyPI: ${error}`);
        return null;
    }
}

// Check for updates
async function checkForUpdates(force: boolean = false): Promise<{ updateAvailable: boolean; latestVersion: string | null }> {
    try {
        const installedVersion = getCurrentVersion();
        const latestVersion = await getLatestVersion();

        console.log(`Installed version: ${installedVersion}`);
        console.log(`Latest version: ${latestVersion}`);

        if (!latestVersion) {
            log.error("Could not determine latest version.");
            return { updateAvailable: false, latestVersion: null };
        }

        if (!installedVersion) {
            log.info(`No installed ${PACKAGE_NAME} version found. Treating ${latestVersion} as update target.`);
            return { updateAvailable: true, latestVersion };
        }

        if (installedVersion !== latestVersion || force) {
            log.info(`Update available: ${installedVersion} -> ${latestVersion}`);
            return { updateAvailable: true, latestVersion };
        } else {
            log.info("You are already using the latest version.");
            return { updateAvailable: false, latestVersion };
        }
    } catch (error) {
        log.error(`Error checking for updates: ${error}`);
        return { updateAvailable: false, latestVersion: null };
    }
}

export { checkForUpdates, getCurrentVersion, getLatestVersion };
