#!/usr/bin/env node
// scripts/compute-version.cjs
//
// Computes the next version for CI builds based on existing git tags.
// Uses CalVer format: YYYY.M.PATCH (semver-compatible)
//
// Usage:
//   node scripts/compute-version.cjs              # next stable version
//   node scripts/compute-version.cjs --pre-release # next pre-release version
//
// Output: prints the version string to stdout (e.g., "2026.2.0" or "2026.2.1-rc.1")
//
// How it works:
//   Stable:      Finds the highest vYYYY.MM.X tag for the current month and increments X.
//                If no tags exist for this month, starts at 0.
//   Pre-release: Computes the next stable version, then finds existing -rc.N tags for it
//                and increments N. First RC is -rc.1.

'use strict';

const { execSync } = require('child_process');

const isPreRelease = process.argv.includes('--pre-release');

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

// ── Pre-release: find next RC number ─────────────────────────────────
const rcPrefix = `${nextStableVersion}-rc.`;
const rcNumbers = [];
for (const tag of tags) {
    const stripped = tag.replace(/^v/, '');
    if (!stripped.startsWith(rcPrefix)) continue;

    const num = parseInt(stripped.slice(rcPrefix.length), 10);
    if (!isNaN(num)) rcNumbers.push(num);
}

rcNumbers.sort((a, b) => b - a);
const nextRc = rcNumbers.length > 0 ? rcNumbers[0] + 1 : 1;

process.stdout.write(`${nextStableVersion}-rc.${nextRc}`);
