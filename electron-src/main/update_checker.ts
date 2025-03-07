import { execSync } from "child_process";
import axios from "axios";
import log from "electron-log";

const PACKAGE_NAME = "GameSentenceMiner";

// Get current installed version using `pip show`
function getCurrentVersion(pythonPath: string): string | null {
    try {
        const output = execSync(`${pythonPath} -m pip show ${PACKAGE_NAME}`, { encoding: "utf-8" });
        console.log(output);
        const versionMatch = output.match(/Version: ([\d.]+)/);
        return versionMatch ? versionMatch[1] : null;
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
async function checkForUpdates(pythonPath: string, force: boolean = false): Promise<{ updateAvailable: boolean; latestVersion: string | null }> {
    try {
        const installedVersion = getCurrentVersion(pythonPath);
        const latestVersion = await getLatestVersion();

        console.log(`Installed version: ${installedVersion}`);
        console.log(`Latest version: ${latestVersion}`);

        if (!installedVersion || !latestVersion) {
            log.error("Could not determine versions.");
            return { updateAvailable: false, latestVersion: null };
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
