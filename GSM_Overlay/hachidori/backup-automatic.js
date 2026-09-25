// Local daily automatic snapshots using the complete manual-backup payload.
// SPDX-License-Identifier: GPL-3.0-or-later
import { assertLookupStatsRows } from "./lookup-stats.js";
import { assertBackupSnapshot } from "./backup-state.js";

export const AUTOMATIC_BACKUPS_KEY = "automaticBackups";
export const AUTOMATIC_BACKUP_ALARM = "hachidori-automatic-backup";
export const AUTOMATIC_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const AUTOMATIC_BACKUP_SCHEMA_VERSION = 1;

export function emptyAutomaticBackupStore() {
  return { schemaVersion: AUTOMATIC_BACKUP_SCHEMA_VERSION, backups: [] };
}

export function automaticBackupStore(value) {
  if (value === undefined) return emptyAutomaticBackupStore();
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== AUTOMATIC_BACKUP_SCHEMA_VERSION
      || !Array.isArray(value.backups)) {
    throw new Error("The automatic backup index has an unsupported schema.");
  }
  return value;
}

export function automaticBackupTime(record) {
  const timestamp = typeof record?.createdAt === "string" ? Date.parse(record.createdAt) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function newestAutomaticBackupTime(value) {
  const store = automaticBackupStore(value);
  let newest = null;
  for (const record of store.backups) {
    const timestamp = automaticBackupTime(record);
    if (timestamp !== null && (newest === null || timestamp > newest)) newest = timestamp;
  }
  return newest;
}

export function automaticBackupDue(value, now = Date.now()) {
  const newest = newestAutomaticBackupTime(value);
  return newest === null || now - newest >= AUTOMATIC_BACKUP_INTERVAL_MS;
}

export function nextAutomaticBackupTime(value, now = Date.now()) {
  const newest = newestAutomaticBackupTime(value);
  return newest === null ? now : newest + AUTOMATIC_BACKUP_INTERVAL_MS;
}

export async function assertAutomaticBackupRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)
      || typeof record.id !== "string" || record.id === ""
      || automaticBackupTime(record) === null
      || !Array.isArray(record.lookupStatsRows)) {
    throw new Error("The automatic backup record is invalid.");
  }
  await assertBackupSnapshot(record.snapshot);
  assertLookupStatsRows(record.snapshot.lookupStats, record.lookupStatsRows);
  return record;
}

function newestFirst(left, right) {
  return automaticBackupTime(right) - automaticBackupTime(left)
    || String(right.id).localeCompare(String(left.id));
}

export async function validAutomaticBackups(value) {
  const store = automaticBackupStore(value);
  const valid = [];
  let corruptCount = 0;
  for (const record of store.backups) {
    try {
      await assertAutomaticBackupRecord(record);
      valid.push(record);
    } catch {
      corruptCount += 1;
    }
  }
  valid.sort(newestFirst);
  const ids = new Set();
  const backups = [];
  for (const record of valid) {
    if (ids.has(record.id)) {
      corruptCount += 1;
      continue;
    }
    ids.add(record.id);
    backups.push(record);
  }
  return { backups, corruptCount };
}

// `limit` is the user's `automaticBackupDays` option: one snapshot per day, so
// the retained count is the number of days kept. A lowered limit prunes when
// the next snapshot is written, not when the option changes.
export async function replaceAutomaticBackup(value, record, limit) {
  await assertAutomaticBackupRecord(record);
  const { backups } = await validAutomaticBackups(value);
  const retained = backups.filter(candidate => candidate.id !== record.id);
  retained.push(record);
  retained.sort(newestFirst);
  return {
    schemaVersion: AUTOMATIC_BACKUP_SCHEMA_VERSION,
    backups: retained.slice(0, limit),
  };
}

export function automaticBackupJsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function formatAutomaticBackupAge(createdAt, now = Date.now(), locale = undefined) {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return "unknown time";
  const delta = timestamp - now;
  const absolute = Math.abs(delta);
  if (absolute < 60_000) return delta > 0 ? "in less than a minute" : "less than a minute ago";
  let unit = "day";
  let unitMilliseconds = 24 * 60 * 60_000;
  if (absolute < 60 * 60_000) {
    unit = "minute";
    unitMilliseconds = 60_000;
  } else if (absolute < 24 * 60 * 60_000) {
    unit = "hour";
    unitMilliseconds = 60 * 60_000;
  }
  const magnitude = Math.max(1, Math.floor(absolute / unitMilliseconds));
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" })
    .format(delta < 0 ? -magnitude : magnitude, unit);
}
