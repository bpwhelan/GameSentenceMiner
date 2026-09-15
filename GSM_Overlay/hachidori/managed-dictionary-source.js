import { RECOMMENDED_DICTIONARIES } from "./recommended-dictionaries.js";

/*
 * Canonical update-source, download trust, and schedule rules shared by every
 * runtime context that enforces managed dictionary updates.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const RECOMMENDED_BY_ID = new Map(
  RECOMMENDED_DICTIONARIES.map((entry) => [entry.sourceId, entry]),
);

export const MANAGED_UPDATE_SCHEDULE_MINUTES = Object.freeze({
  off: null,
  hourly: 60,
  daily: 24 * 60,
  weekly: 7 * 24 * 60,
  monthly: 30 * 24 * 60,
});

export function managedUpdateSchedule(value) {
  return typeof value === "string"
      && Object.hasOwn(MANAGED_UPDATE_SCHEDULE_MINUTES, value)
    ? value
    : null;
}

export function normaliseUpdateSettings(value) {
  return {
    revision: Number.isSafeInteger(value?.revision) && value.revision >= 0 ? value.revision : 0,
    schedule: managedUpdateSchedule(value?.schedule) ?? "off",
    lastCheckedAt: typeof value?.lastCheckedAt === "string" ? value.lastCheckedAt : null,
  };
}

export function effectiveDictionarySchedule(dictionary, globalSchedule) {
  return managedUpdateSchedule(dictionary.updateScheduleOverride) ?? globalSchedule;
}

export function assertDictionaryUpdateSchedule(dictionary) {
  if (dictionary.updateScheduleOverride != null && managedUpdateSchedule(dictionary.updateScheduleOverride) === null) {
    throw new Error("The dictionary update schedule is invalid.");
  }
}

export function nextDictionaryUpdateCheck(dictionary, globalSchedule, now) {
  if (managedDictionarySource(dictionary) === null) return null;
  const interval = MANAGED_UPDATE_SCHEDULE_MINUTES[effectiveDictionarySchedule(dictionary, globalSchedule)];
  if (interval === null) return null;
  const checkedAt = Date.parse(dictionary.lastUpdateCheck?.checkedAt);
  return Number.isNaN(checkedAt) ? now : checkedAt + interval * 60_000;
}

export function nextManagedUpdateCheck(dictionaries, globalSchedule, now) {
  let next = null;
  for (const dictionary of dictionaries) {
    const due = nextDictionaryUpdateCheck(dictionary, globalSchedule, now);
    if (due !== null && (next === null || due < next)) next = due;
  }
  return next === null ? null : Math.max(now, next);
}

export const MANAGED_DICTIONARY_CHANGED =
  "the managed dictionary changed while its update was being prepared";

export function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function recommendedDictionarySource(sourceId) {
  return RECOMMENDED_BY_ID.get(sourceId) ?? null;
}

// A recommendation counts as installed through its validated catalogue identity
// or its exact update index, never through a display name.
export function installedRecommendedDictionary(entry, dictionaries) {
  return dictionaries.find((dictionary) =>
    dictionary.sourceId === entry.sourceId || dictionary.indexUrl === entry.indexUrl) ?? null;
}

export function recommendedDictionaryInstalled(entry, dictionaries) {
  return installedRecommendedDictionary(entry, dictionaries) !== null;
}

export function assertRecommendedDictionary(source, dictionary) {
  if (!new RegExp(source.titlePattern, "u").test(dictionary.title)) {
    throw new Error(`${source.name} archive did not match its expected title`);
  }
  if (dictionary.indexUrl !== source.indexUrl) {
    throw new Error(`${source.name} archive did not match its expected update source`);
  }
  if (typeof dictionary.revision !== "string" || dictionary.revision === "") {
    throw new Error(`${source.name} archive did not declare a revision`);
  }
  const countKey = source.requiredCapability === "freq" ? "frequencyCount" : "termCount";
  const hasCapability = dictionary[countKey] > 0;
  if (!hasCapability) {
    throw new Error(`${source.name} archive did not contain its expected capability`);
  }
}

export function managedDictionarySource(dictionary) {
  const recommended = recommendedDictionarySource(dictionary?.sourceId);
  if (recommended !== null) {
    return {
      kind: "recommended",
      sourceId: recommended.sourceId,
      indexUrl: recommended.indexUrl,
      downloadUrl: recommended.downloadUrl,
    };
  }
  const indexUrl = httpsUrl(dictionary?.indexUrl);
  const downloadUrl = httpsUrl(dictionary?.downloadUrl);
  if (dictionary?.isUpdatable !== true || indexUrl === null || downloadUrl === null) {
    return null;
  }
  return {
    kind: "generic",
    sourceId: typeof dictionary?.sourceId === "string" && dictionary.sourceId !== ""
      ? dictionary.sourceId
      : null,
    indexUrl,
    downloadUrl,
  };
}

export function managedDictionaryFingerprint(dictionary) {
  const source = managedDictionarySource(dictionary);
  return source !== null
      && typeof dictionary?.id === "string"
      && dictionary.id !== ""
      && typeof dictionary?.path === "string"
      && dictionary.path !== ""
      && typeof dictionary?.revision === "string"
    ? {
        id: dictionary.id,
        path: dictionary.path,
        revision: dictionary.revision,
        source,
      }
    : null;
}

export function managedDictionaryMatches(dictionary, fingerprint) {
  const current = managedDictionaryFingerprint(dictionary);
  return current !== null
    && current.id === fingerprint?.id
    && current.path === fingerprint?.path
    && current.revision === fingerprint?.revision
    && current.source.kind === fingerprint?.source?.kind
    && current.source.sourceId === fingerprint?.source?.sourceId
    && current.source.indexUrl === fingerprint?.source?.indexUrl
    && current.source.downloadUrl === fingerprint?.source?.downloadUrl;
}

function recommendedAssetUrlMatches(source, value, declaredUrl, assetName) {
  let finalUrl;
  try {
    finalUrl = new URL(value);
  } catch {
    return false;
  }
  if (finalUrl.protocol !== "https:" || finalUrl.username !== "" || finalUrl.password !== "") {
    return false;
  }
  if (finalUrl.href === new URL(declaredUrl).href) {
    return true;
  }
  if (source.githubRepository === null) {
    return false;
  }
  if (finalUrl.hostname === "github.com") {
    const prefix = `/${source.githubRepository}/releases/download/`;
    const rest = finalUrl.pathname.startsWith(prefix) ? finalUrl.pathname.slice(prefix.length) : "";
    return rest.includes("/")
      && decodeURIComponent(rest.slice(rest.lastIndexOf("/") + 1)) === assetName;
  }
  if (finalUrl.hostname !== "release-assets.githubusercontent.com") {
    return false;
  }
  const assetPrefix = `/github-production-release-asset/${source.githubRepositoryId}/`;
  if (!finalUrl.pathname.startsWith(assetPrefix)) {
    return false;
  }
  const disposition = finalUrl.searchParams.get("response-content-disposition")
    ?? finalUrl.searchParams.get("rscd")
    ?? "";
  const match = /(?:^|;)\s*filename="?([^";]+)"?/iu.exec(disposition);
  return match?.[1] === assetName;
}

export function recommendedDownloadUrlMatches(source, value) {
  return recommendedAssetUrlMatches(
    source,
    value,
    source.downloadUrl,
    source.archiveName,
  );
}

export function recommendedIndexUrlMatches(source, value) {
  const index = new URL(source.indexUrl);
  const assetName = decodeURIComponent(index.pathname.slice(index.pathname.lastIndexOf("/") + 1));
  return recommendedAssetUrlMatches(source, value, index.href, assetName);
}
