/*
 * Shared dictionary-group state rules for extension consumers.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

(function () {
  "use strict";

  function normaliseGroupName(value) {
    return (typeof value === "string" ? value : "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/gu, " ");
  }

  function groupNameKey(value) {
    return normaliseGroupName(value).toLowerCase();
  }

  function retainedMemberIds(value, installedIds) {
    const seen = new Set();
    return Array.isArray(value)
      ? value.filter((id) => {
        if (!installedIds.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      : [];
  }

  function normaliseDictionaryGroups(value, installedDictionaries) {
    if (!Array.isArray(value)) return [];
    const installedIds = new Set(installedDictionaries.map((dictionary) => dictionary.id));
    return value.map((group) => {
      const id = typeof group?.id === "string" ? group.id : "";
      const name = normaliseGroupName(group?.name);
      if (id === "" || name === "") return null;
      return { id, name, dictionaryIds: retainedMemberIds(group.dictionaryIds, installedIds) };
    }).filter((group) => group !== null);
  }

  function pruneGroupMemberships(value, dictionaries) {
    if (!Array.isArray(value)) return [];
    const installedIds = new Set(dictionaries.map((dictionary) => dictionary.id));
    return value.map((group) => ({
      ...group,
      dictionaryIds: retainedMemberIds(group.dictionaryIds, installedIds),
    }));
  }

  globalThis.HDDictionaryGroups = {
    normaliseGroupName, groupNameKey, normaliseDictionaryGroups, pruneGroupMemberships,
  };
}());
