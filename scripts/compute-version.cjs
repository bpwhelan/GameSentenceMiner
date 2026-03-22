#!/usr/bin/env node
// scripts/compute-version.cjs
//
// Computes date-based versions for releases and CI pre-releases.
//
// Usage:
//   node scripts/compute-version.cjs
//   node scripts/compute-version.cjs --pre-release
//   node scripts/compute-version.cjs --pre-release --preid beta
//   node scripts/compute-version.cjs --pre-release --preid rc
//
// Output:
//   Stable:      YYYY.M.D
//   Pre-release: YYYY.M.D-<preid>.N
//
// How it works:
//   Stable:      Uses the current UTC calendar date directly.
//   Pre-release: Uses the current UTC calendar date as the base version and
//                increments only matching prerelease tags for that same date.

'use strict';

const { execSync } = require('child_process');

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

function formatUtcDateVersion(now = new Date()) {
    return `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}.${now.getUTCDate()}`;
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function computeStableVersion({ now = new Date() } = {}) {
    return formatUtcDateVersion(now);
}

function computePreReleaseVersion({ now = new Date(), preReleaseId = 'beta', tags = [] } = {}) {
    validatePreReleaseId(preReleaseId);

    const stableVersion = computeStableVersion({ now });
    const pattern = new RegExp(`^v${escapeRegex(stableVersion)}-${escapeRegex(preReleaseId)}\\.(\\d+)$`);

    let highestPreRelease = 0;
    for (const tag of tags) {
        const match = pattern.exec(tag);
        if (!match) {
            continue;
        }

        const preReleaseNumber = parseInt(match[1], 10);
        if (!Number.isNaN(preReleaseNumber) && preReleaseNumber > highestPreRelease) {
            highestPreRelease = preReleaseNumber;
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

    if (!isPreRelease) {
        process.stdout.write(computeStableVersion());
        return;
    }

    const tags = fetchVersionTags();
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
    computePreReleaseVersion,
    computeStableVersion,
    fetchVersionTags,
    formatUtcDateVersion,
    runCli,
    validatePreReleaseId,
};
