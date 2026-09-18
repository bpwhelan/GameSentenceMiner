/*
 * Local dictionary import identity and revision helpers.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const MAX_REVISION_COMPONENTS = 32;
export const MAX_REVISION_COMPONENT_LENGTH = 64;
export const MAX_REVISION_LENGTH = 2048;

function optionalExactString(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function comparableRevision(value) {
  if (typeof value !== "string"
      || value.length === 0
      || value.length > MAX_REVISION_LENGTH
      || !/^[0-9]+(?:\.[0-9]+)*$/u.test(value)) {
    return null;
  }
  const components = value.split(".");
  if (components.length > MAX_REVISION_COMPONENTS
      || components.some(component => component.length > MAX_REVISION_COMPONENT_LENGTH)) {
    return null;
  }
  const normalised = components.map((component) => {
    const withoutLeadingZeroes = component.replace(/^0+(?=[0-9])/u, "");
    return withoutLeadingZeroes === "" ? "0" : withoutLeadingZeroes;
  });
  while (normalised.length > 1 && normalised.at(-1) === "0") normalised.pop();
  return normalised;
}

function compareNumericComponent(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function compareDictionaryRevisions(imported, installed) {
  const left = comparableRevision(imported);
  const right = comparableRevision(installed);
  if (left === null || right === null) return "uncomparable";
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = compareNumericComponent(left[index] ?? "0", right[index] ?? "0");
    if (comparison < 0) return "lower";
    if (comparison > 0) return "higher";
  }
  return "same";
}

export function dictionaryArchiveIdentity(index) {
  if (!index || typeof index !== "object" || Array.isArray(index)
      || typeof index.title !== "string" || index.title === "") {
    throw new Error("The selected archive's index.json has no dictionary title.");
  }
  return {
    title: index.title,
    revision: typeof index.revision === "string" ? index.revision : null,
    indexUrl: optionalExactString(index.indexUrl),
    downloadUrl: optionalExactString(index.downloadUrl),
  };
}

export function dictionaryImportTarget(dictionary) {
  return {
    id: typeof dictionary?.id === "string" ? dictionary.id : "",
    title: typeof dictionary?.title === "string" ? dictionary.title : "",
    path: typeof dictionary?.path === "string" ? dictionary.path : "",
    revision: typeof dictionary?.revision === "string" ? dictionary.revision : "",
    sourceId: optionalExactString(dictionary?.sourceId),
    indexUrl: optionalExactString(dictionary?.indexUrl),
    downloadUrl: optionalExactString(dictionary?.downloadUrl),
    isUpdatable: dictionary?.isUpdatable === true,
  };
}

export function dictionaryImportMatches(identity, dictionaries) {
  const exact = dictionaries
    .filter(dictionary => dictionary?.title === identity.title)
    .map(dictionary => ({ dictionary, kind: "title" }));
  if (exact.length > 0 || identity.indexUrl === null) return exact;
  return dictionaries
    .filter(dictionary => optionalExactString(dictionary?.indexUrl) === identity.indexUrl)
    .map(dictionary => ({ dictionary, kind: "source" }));
}

export function describeRevisionComparison(imported, installed) {
  switch (compareDictionaryRevisions(imported, installed)) {
    case "higher":
      return "The imported revision is newer than the installed revision.";
    case "same":
      return "The imported and installed revisions are the same.";
    case "lower":
      return "The imported revision is older than the installed revision. Replacing will downgrade it.";
    default:
      return "Hachidori cannot compare these revision values. Choose how to import the archive.";
  }
}
