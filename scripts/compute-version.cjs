#!/usr/bin/env node
// scripts/compute-version.cjs
//
// Computes the next version for releases and CI pre-releases by looking at
// existing git tags instead of the current date.
//
// Usage:
//   node scripts/compute-version.cjs
//   node scripts/compute-version.cjs --pre-release
//   node scripts/compute-version.cjs --pre-release --preid beta
//   node scripts/compute-version.cjs --pre-release --preid rc
//
// Output:
//   Stable:      <latest stable release with its last numeric segment incremented>
//   Pre-release: <next stable version>-<preid>.N
//
// How it works:
//   Stable:      Finds the highest stable vX.Y.Z... tag and increments its last
//                numeric segment.
//   Pre-release: Uses that next stable version as the base, then increments only
//                matching prerelease tags for the requested preid.

'use strict';

const { execSync } = require('child_process');

const STABLE_TAG_PATTERN = /^v(\d+(?:\.\d+)*)$/;
const PRE_RELEASE_TAG_PATTERN = /^v(\d+(?:\.\d+)*)-([0-9a-z-]+)\.(\d+)$/;

function getArgValue(argv, flagName) {
    const inlinePrefix = `${flagName}=`;
    const inline = argv.find((arg) => arg.startsWith(inlinePrefix));
    if (inline) {
        return inline.slice(inlinePrefix.length).trim();
    }

    const index = argv.indexOf(flagName);
    if (index >= 0 && index + 1 < argv.length) {
        return String(argv[index + 1]).trim();
    }

    return '';
}

function validatePreReleaseId(preReleaseId) {
    if (!/^[0-9a-z-]+$/.test(preReleaseId)) {
        throw new Error(
            `Invalid --preid "${preReleaseId}". Use only lowercase letters, numbers, and "-".`,
        );
    }
}

function parseVersionParts(version) {
    if (!/^\d+(?:\.\d+)*$/.test(version)) {
        return null;
    }

    return version.split('.').map((segment) => Number.parseInt(segment, 10));
}

function compareVersionParts(a, b) {
    const maxLength = Math.max(a.length, b.length);
    for (let index = 0; index < maxLength; index += 1) {
        const left = a[index] ?? 0;
        const right = b[index] ?? 0;
        if (left !== right) {
            return left - right;
        }
    }

    return 0;
}

function formatVersionParts(parts) {
    return parts.join('.');
}

function bumpPatch(parts) {
    if (parts.length === 0) {
        return [0, 0, 1];
    }

    const next = [...parts];
    next[next.length - 1] += 1;
    return next;
}

function parseStableTag(tag) {
    const match = STABLE_TAG_PATTERN.exec(tag);
    if (!match) {
        return null;
    }

    const version = match[1];
    const parts = parseVersionParts(version);
    if (!parts) {
        return null;
    }

    return { tag, version, parts };
}

function parsePreReleaseTag(tag) {
    const match = PRE_RELEASE_TAG_PATTERN.exec(tag);
    if (!match) {
        return null;
    }

    const version = match[1];
    const parts = parseVersionParts(version);
    if (!parts) {
        return null;
    }

    return {
        tag,
        version,
        parts,
        preReleaseId: match[2],
        preReleaseNumber: Number.parseInt(match[3], 10),
    };
}

function getLatestStableRelease(tags) {
    let latest = null;

    for (const tag of tags) {
        const parsed = parseStableTag(tag);
        if (!parsed) {
            continue;
        }

        if (!latest || compareVersionParts(parsed.parts, latest.parts) > 0) {
            latest = parsed;
        }
    }

    return latest;
}

function getLatestVersionBase(tags) {
    let latest = null;

    for (const tag of tags) {
        const parsed = parseStableTag(tag) ?? parsePreReleaseTag(tag);
        if (!parsed) {
            continue;
        }

        if (!latest || compareVersionParts(parsed.parts, latest.parts) > 0) {
            latest = parsed;
        }
    }

    return latest;
}

function computeStableVersion({ tags = [] } = {}) {
    const latestStable = getLatestStableRelease(tags);
    const fallbackBase = latestStable ?? getLatestVersionBase(tags);
    const nextVersionParts = bumpPatch(fallbackBase?.parts ?? [0, 0, 0]);
    return formatVersionParts(nextVersionParts);
}

function computePreReleaseVersion({ preReleaseId = 'beta', tags = [] } = {}) {
    validatePreReleaseId(preReleaseId);

    const stableVersion = computeStableVersion({ tags });
    let highestPreRelease = 0;

    for (const tag of tags) {
        const parsed = parsePreReleaseTag(tag);
        if (!parsed) {
            continue;
        }

        if (parsed.version !== stableVersion || parsed.preReleaseId !== preReleaseId) {
            continue;
        }

        if (parsed.preReleaseNumber > highestPreRelease) {
            highestPreRelease = parsed.preReleaseNumber;
        }
    }

    return `${stableVersion}-${preReleaseId}.${highestPreRelease + 1}`;
}

function fetchVersionTags() {
    try {
        execSync('git fetch --tags --force 2>&1', { encoding: 'utf8', stdio: 'pipe' });
    } catch {
        // Shallow or detached CI contexts may already have enough tags locally.
    }

    const rawTags = execSync('git tag -l "v*"', { encoding: 'utf8' }).trim();
    return rawTags ? rawTags.split('\n').filter(Boolean) : [];
}

function runCli(argv = process.argv.slice(2)) {
    const isPreRelease = argv.includes('--pre-release');
    const preReleaseId = (getArgValue(argv, '--preid') || 'beta').toLowerCase();
    const tags = fetchVersionTags();

    if (!isPreRelease) {
        process.stdout.write(computeStableVersion({ tags }));
        return;
    }

    process.stdout.write(computePreReleaseVersion({ preReleaseId, tags }));
}

if (require.main === module) {
    try {
        runCli();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

module.exports = {
    bumpPatch,
    compareVersionParts,
    computePreReleaseVersion,
    computeStableVersion,
    fetchVersionTags,
    formatVersionParts,
    getLatestStableRelease,
    getLatestVersionBase,
    parsePreReleaseTag,
    parseStableTag,
    parseVersionParts,
    runCli,
    validatePreReleaseId,
};
