#!/usr/bin/env node
// scripts/compute-version.cjs
//
// Computes the next version for CI builds based on existing git tags.
// Uses CalVer format: YYYY.M.PATCH (semver-compatible)
//
// Usage:
//   node scripts/compute-version.cjs              # next stable version
//   node scripts/compute-version.cjs --pre-release                 # next beta pre-release version
//   node scripts/compute-version.cjs --pre-release --preid beta    # next beta pre-release version
//   node scripts/compute-version.cjs --pre-release --preid dev     # next dev pre-release version
//
// Output: prints the version string to stdout (e.g., "2026.2.0" or "2026.2.1-beta.1")
//
// How it works:
//   Stable:      Finds the highest vYYYY.MM.X tag for the current month and increments X.
//                If no tags exist for this month, starts at 0.
//   Pre-release: Computes the next stable version, then finds existing -<preid>.N tags
//                and increments N. First pre-release is -<preid>.1.

'use strict';

const { execSync } = require('child_process');

const argv = process.argv.slice(2);
const isPreRelease = argv.includes('--pre-release');

function getArgValue(flagName) {
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

const preReleaseId = (getArgValue('--preid') || 'beta').toLowerCase();
if (!/^[0-9a-z-]+$/.test(preReleaseId)) {
    console.error(`Invalid --preid "${preReleaseId}". Use only lowercase letters, numbers, and "-".`);
    process.exit(1);
}

// Ensure we have all remote tags
try {
    execSync('git fetch --tags --force 2>&1', { encoding: 'utf8', stdio: 'pipe' });
} catch {
    // May fail in shallow clones; tags might already be present
}

// List all version tags
const rawTags = execSync('git tag -l "v*"', { encoding: 'utf8' }).trim();
const tags = rawTags ? rawTags.split('\n').filter(Boolean) : [];

const now = new Date();
const year = now.getUTCFullYear();
const month = now.getUTCMonth() + 1; // 1-12

// ── Parse stable tags ────────────────────────────────────────────────
// A stable tag looks like vYYYY.M.PATCH (no pre-release suffix).
const stableVersions = [];
for (const tag of tags) {
    const stripped = tag.replace(/^v/, '');
    if (stripped.includes('-')) continue; // skip pre-release tags

    const parts = stripped.split('.');
    if (parts.length !== 3) continue;

    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const p = parseInt(parts[2], 10);
    if (isNaN(y) || isNaN(m) || isNaN(p)) continue;

    stableVersions.push({ year: y, month: m, patch: p });
}

// Find the highest patch for the current year.month
const sameMonthStable = stableVersions
    .filter((v) => v.year === year && v.month === month)
    .sort((a, b) => b.patch - a.patch);

const nextPatch = sameMonthStable.length > 0 ? sameMonthStable[0].patch + 1 : 0;
const nextStableVersion = `${year}.${month}.${nextPatch}`;

if (!isPreRelease) {
    process.stdout.write(nextStableVersion);
    process.exit(0);
}

// ── Pre-release: find next number for selected preid ─────────────────
const prePrefix = `${nextStableVersion}-${preReleaseId}.`;
const preNumbers = [];
for (const tag of tags) {
    const stripped = tag.replace(/^v/, '');
    if (!stripped.startsWith(prePrefix)) continue;

    const num = parseInt(stripped.slice(prePrefix.length), 10);
    if (!isNaN(num)) preNumbers.push(num);
}

preNumbers.sort((a, b) => b - a);
const nextPre = preNumbers.length > 0 ? preNumbers[0] + 1 : 1;

process.stdout.write(`${nextStableVersion}-${preReleaseId}.${nextPre}`);
