/*
 * Dictionary-group Settings controls.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./dictionary-group-state.js";

const { normaliseGroupName, groupNameKey } = globalThis.HDDictionaryGroups;
export const normaliseDictionaryGroups = globalThis.HDDictionaryGroups.normaliseDictionaryGroups;

const ALL_GROUP_NAME_KEY = groupNameKey("All");

function element(id) {
  return document.getElementById(id);
}

function groupNameError(groups, name, excludedId = null) {
  if (name === "") return "Enter a group name.";
  const key = groupNameKey(name);
  if (key === ALL_GROUP_NAME_KEY) return "All is reserved and cannot be used as a group name.";
  if (groups.some((group) =>
    group.id !== excludedId && groupNameKey(group.name) === key)) {
    return "A group with this name already exists.";
  }
  return "";
}

function bindMoveButtons(row, prefix, index, length, label, move) {
  const up = row.querySelector(`.${prefix}-up`);
  const down = row.querySelector(`.${prefix}-down`);
  up.dataset.pinnedDisabled = String(index === 0);
  down.dataset.pinnedDisabled = String(index === length - 1);
  up.setAttribute("aria-label", `Move ${label} up`);
  down.setAttribute("aria-label", `Move ${label} down`);
  up.addEventListener("click", () => move(-1));
  down.addEventListener("click", () => move(1));
}

export function createDictionaryGroupController({
  setError,
  readState,
  readDictionaries,
  commitGroups,
  dictionaryLabel,
  moveListItem,
  updateItemById,
  renderDeferredAfterBlur,
  bindNameDraft,
}) {
  function changeNamedGroup(name, excludedId, update) {
    void commitGroups((current) => {
      const error = groupNameError(current, name, excludedId);
      if (error) {
        setError(error);
        return null;
      }
      setError("");
      return update(current);
    });
  }

  function changeGroup(id, update) {
    void commitGroups((current) => updateItemById(current, id, update));
  }

  function moveGroup(id, step) {
    void commitGroups((current) => {
      const index = current.findIndex((group) => group.id === id);
      return moveListItem(current, index, index + step);
    });
  }

  function moveMember(groupId, dictionaryId, step) {
    changeGroup(groupId, (group) => {
      const index = group.dictionaryIds.indexOf(dictionaryId);
      const dictionaryIds = moveListItem(group.dictionaryIds, index, index + step);
      return dictionaryIds === null ? group : { ...group, dictionaryIds };
    });
  }

  function renderMember(group, dictionary, index) {
    const row = element("dict-group-member-template").content.firstElementChild.cloneNode(true);
    const label = dictionaryLabel(dictionary);
    row.dataset.dictionaryId = dictionary.id;
    row.querySelector(".dict-group-member-name").textContent = label;
    const canonical = row.querySelector(".dict-group-member-canonical");
    canonical.textContent = dictionary.displayName ? dictionary.title : "";
    canonical.hidden = !dictionary.displayName;

    bindMoveButtons(
      row,
      "dict-group-member",
      index,
      group.dictionaryIds.length,
      `${label} in ${group.name}`,
      (step) => moveMember(group.id, dictionary.id, step),
    );

    const remove = row.querySelector(".dict-group-member-remove");
    remove.setAttribute("aria-label", `Remove ${label} from ${group.name}`);
    remove.addEventListener("click", () => {
      changeGroup(group.id, (current) => ({
        ...current,
        dictionaryIds: current.dictionaryIds.filter((id) => id !== dictionary.id),
      }));
    });
    return row;
  }

  function bindName(row, group) {
    const input = row.querySelector(".dict-group-name");
    input.setAttribute("aria-label", `Name for ${group.name}`);
    bindNameDraft(input, "groups", group.id, "name", group.name, normaliseGroupName, groupNameError);
    renderDeferredAfterBlur(input);
  }

  function bindAdd(row, group, dictionaries) {
    const select = row.querySelector(".dict-group-add-select");
    const add = row.querySelector(".dict-group-add");
    const available = dictionaries.filter((dictionary) => !group.dictionaryIds.includes(dictionary.id));
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = available.length === 0 ? "All dictionaries added" : "Choose a dictionary";
    select.appendChild(placeholder);
    for (const dictionary of available) {
      const option = document.createElement("option");
      option.value = dictionary.id;
      option.textContent = dictionaryLabel(dictionary);
      select.appendChild(option);
    }
    select.dataset.pinnedDisabled = String(available.length === 0);
    add.dataset.pinnedDisabled = String(available.length === 0);
    add.addEventListener("click", () => {
      if (select.value === "") return;
      const dictionaryId = select.value;
      changeGroup(group.id, (current) => ({
        ...current,
        dictionaryIds: [...current.dictionaryIds, dictionaryId],
      }));
    });
  }

  function renderRow(group, index, state, dictionaries, installedById) {
    const row = element("dict-group-template").content.firstElementChild.cloneNode(true);
    row.dataset.groupId = group.id;
    bindName(row, group);

    const remove = row.querySelector(".dict-group-delete");
    remove.setAttribute("aria-label", `Delete ${group.name}`);
    bindMoveButtons(
      row,
      "dict-group",
      index,
      state.groups.length,
      group.name,
      (step) => moveGroup(group.id, step),
    );
    remove.addEventListener("click", () => {
      void commitGroups((current) => current.filter((entry) => entry.id !== group.id));
    });

    bindAdd(row, group, dictionaries);
    const members = row.querySelector(".dict-group-members");
    group.dictionaryIds.forEach((dictionaryId, memberIndex) => {
      members.appendChild(renderMember(group, installedById.get(dictionaryId), memberIndex));
    });
    row.querySelector(".dict-group-members-empty").hidden = group.dictionaryIds.length > 0;
    return row;
  }

  function render() {
    const state = readState();
    const dictionaries = readDictionaries();
    const installedById = new Map(dictionaries.map((dictionary) => [dictionary.id, dictionary]));
    const list = element("dict-group-list");
    list.textContent = "";
    state.groups.forEach((group, index) => {
      list.appendChild(renderRow(group, index, state, dictionaries, installedById));
    });
    element("dict-group-empty").hidden = state.groups.length > 0;
  }

  function create() {
    const input = element("dict-group-name-new");
    const name = normaliseGroupName(input.value);
    const error = groupNameError(readState().groups, name);
    if (error) {
      setError(error);
      return;
    }
    input.value = "";
    setError("");
    changeNamedGroup(name, null, (current) => [
      ...current,
      { id: crypto.randomUUID(), name, dictionaryIds: [] },
    ]);
  }

  return { create, render };
}
