export interface PyPiReleaseFile {
    yanked?: boolean;
}

export type PyPiReleases = Record<string, PyPiReleaseFile[]>;

export interface BackendUpdateDecision {
    updateAvailable: boolean;
    latestVersion: string;
}

export function isBackendVersionCompatible(
    installedVersion: string,
    bundledVersion: string
): boolean {
    const escapedBundledVersion = bundledVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
        `^${escapedBundledVersion}(?:\\.post\\d+)?(?:\\+[A-Za-z0-9.-]+)?$`,
        'i'
    ).test(installedVersion);
}

function getPostReleaseNumber(version: string, bundledVersion: string): number {
    if (version === bundledVersion) {
        return -1;
    }
    const escapedBundledVersion = bundledVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = version.match(
        new RegExp(`^${escapedBundledVersion}\\.post(\\d+)$`, 'i')
    );
    return match ? Number.parseInt(match[1], 10) : -1;
}

export function selectLatestCompatibleVersion(
    bundledVersion: string,
    releases: PyPiReleases
): string {
    let latestVersion = bundledVersion;
    let latestPostNumber = -1;

    for (const [version, files] of Object.entries(releases)) {
        if (!files.some((file) => !file.yanked)) {
            continue;
        }
        const postNumber = getPostReleaseNumber(version, bundledVersion);
        if (postNumber > latestPostNumber) {
            latestPostNumber = postNumber;
            latestVersion = version;
        }
    }

    return latestVersion;
}

export function getBackendUpdateDecision(
    installedVersion: string | null,
    bundledVersion: string,
    latestVersion: string,
    force: boolean = false
): BackendUpdateDecision {
    if (!installedVersion) {
        return { updateAvailable: true, latestVersion };
    }

    const newerPostReleaseAvailable =
        getPostReleaseNumber(latestVersion, bundledVersion) >
        getPostReleaseNumber(installedVersion, bundledVersion);

    return {
        updateAvailable:
            force ||
            !isBackendVersionCompatible(installedVersion, bundledVersion) ||
            newerPostReleaseAvailable,
        latestVersion,
    };
}

export function requiresBackendStartupPreparation(
    installedVersion: string | null,
    bundledVersion: string | null,
    isPreRelease: boolean
): boolean {
    if (!installedVersion) {
        return true;
    }
    return Boolean(
        !isPreRelease &&
            bundledVersion &&
            !isBackendVersionCompatible(installedVersion, bundledVersion)
    );
}
