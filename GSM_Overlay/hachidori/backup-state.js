// Complete persisted-state contract shared by the engine and storage owner.
// SPDX-License-Identifier: GPL-3.0-or-later
import "./reader-options.js";
import "./dictionary-group-state.js";
import {
  assertCustomSourceState, customDictionarySemanticRevision,
  normaliseCustomDictionaryDocument, parseCustomDictionary,
} from "./custom-dictionary.js";
import { assertDictionaryUpdateSchedule, assertRecommendedDictionary, normaliseUpdateSettings, recommendedDictionarySource } from "./managed-dictionary-source.js";
import { sameJsonValue } from "./json-value.js";
import { assertLookupStatsDescriptor } from "./lookup-stats.js";

export function backupRevisions(snapshot) {
  return Object.fromEntries(["state", "options", "document", "updates", "lookupStats"].map(key => {
    const revision = snapshot[key]?.revision;
    return [key, Number.isSafeInteger(revision) && revision >= 0 ? revision : 0];
  }));
}

export function restoredBackupSnapshot(current, archived, dictionaries) {
  return Object.fromEntries(Object.entries(backupRevisions(current)).map(([key, revision]) => [key, {
    ...archived[key],
    ...(key === "state" ? { dictionaries } : {}),
    ...(key === "lookupStats" ? { generation: crypto.randomUUID() } : {}),
    revision: revision + 1,
  }]));
}

function assertDictionaryList(dictionaries) {
  const ids = new Set(), titles = new Set();
  for (const entry of dictionaries) {
    assertDictionaryUpdateSchedule(entry);
    if (typeof entry?.id !== "string" || entry.id === "" || ids.has(entry.id)
        || typeof entry.title !== "string" || entry.title === "" || titles.has(entry.title)
        || /[\\/]/u.test(entry.title) || entry.title.includes("\0") || [".", ".."].includes(entry.title)
        || typeof entry.revision !== "string"
        || typeof entry.enabled !== "boolean" || typeof entry.favorite !== "boolean"
        || (entry.displayName !== null && typeof entry.displayName !== "string")
        || ["termCount", "frequencyCount", "pitchCount", "kanjiCount", "mediaCount"].some(key =>
          !Number.isSafeInteger(entry[key]) || entry[key] < 0)) {
      throw new Error("The backup contains invalid or duplicate dictionary packages.");
    }
    const recommended = recommendedDictionarySource(entry.sourceId);
    if (recommended) {
      assertRecommendedDictionary(recommended, entry);
      if (entry.downloadUrl !== recommended.downloadUrl) {
        throw new Error("The backup dictionary does not match its recommended source.");
      }
    }
    ids.add(entry.id);
    titles.add(entry.title);
  }
}

function assertGroups(groups, dictionaries) {
  const { normaliseDictionaryGroups, groupNameKey } = globalThis.HDDictionaryGroups;
  if (!Array.isArray(groups) || !sameJsonValue(groups, normaliseDictionaryGroups(groups, dictionaries))) {
    throw new Error("The backup contains invalid dictionary groups.");
  }
  const ids = new Set(), names = new Set(["all"]);
  for (const group of groups) {
    const key = groupNameKey(group.name);
    if (ids.has(group.id) || names.has(key)) throw new Error("The backup contains duplicate dictionary groups.");
    ids.add(group.id);
    names.add(key);
  }
}

export async function assertBackupSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
      || ["state", "options", "document", "updates"].some(key =>
        !Number.isSafeInteger(snapshot[key]?.revision) || snapshot[key].revision < 0)
      || snapshot.state?.schemaVersion !== 1 || !Array.isArray(snapshot.state.dictionaries)) {
    throw new Error("The backup contains invalid dictionary state.");
  }
  assertDictionaryList(snapshot.state.dictionaries);
  assertLookupStatsDescriptor(snapshot.lookupStats);
  assertGroups(snapshot.state.groups, snapshot.state.dictionaries);
  const document = normaliseCustomDictionaryDocument(snapshot.document);
  const entries = parseCustomDictionary(document.text).entries;
  const semanticRevision = await customDictionarySemanticRevision(entries);
  if (document.semanticRevision !== semanticRevision) throw new Error("The backup custom source has invalid semantics.");
  assertCustomSourceState(snapshot.state.dictionaries, semanticRevision, entries.length);
  const { revision, ...options } = snapshot.options ?? {};
  if (!Number.isSafeInteger(revision) || revision < 0
      || !sameJsonValue(options, globalThis.HDReaderOptions.validateOptionsPatch(options))) {
    throw new Error("The backup contains invalid reader settings.");
  }
  if (!sameJsonValue(snapshot.updates, normaliseUpdateSettings(snapshot.updates))) {
    throw new Error("The backup contains invalid update settings.");
  }
}
