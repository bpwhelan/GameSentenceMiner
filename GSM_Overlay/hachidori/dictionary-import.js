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

// What a successful MDX import left out, from the engine's counts, adapted from
// manabitan's MDict conversion notes (mdict-import-feedback.js). They are notes,
// not errors: the dictionary is installed. A Yomitan ZIP reports zeros.
const MDX_IMPORT_NOTES = Object.freeze([
  {
    key: "skippedRecordCount",
    singular: "definition record could not be read and was skipped.",
    plural: "definition records could not be read and were skipped.",
    advice: "The imported dictionary is incomplete; try another copy of the .mdx file.",
  },
  {
    key: "unresolvedRedirectCount",
    singular: "redirect alias could not be resolved.",
    plural: "redirect aliases could not be resolved.",
    advice: "These aliases may not appear in search results; their target definitions may still be available.",
  },
  {
    key: "missingResourceCount",
    singular: "referenced resource was not included.",
    plural: "referenced resources were not included.",
    advice: "Choose the .mdx together with all of its .mdd files to include available images and styles. "
      + "This does not count missing definitions.",
  },
  {
    key: "unreadableResourceCount",
    singular: "resource in the .mdd files could not be read.",
    plural: "resources in the .mdd files could not be read.",
    advice: "Some images or styles are missing. Check that every .mdd belongs to this dictionary and is complete.",
  },
]);

export function mdxImportNotes(report, numberFormat = new Intl.NumberFormat()) {
  const notes = [];
  for (const { key, singular, plural, advice } of MDX_IMPORT_NOTES) {
    const count = report?.[key];
    if (!Number.isSafeInteger(count) || count <= 0) continue;
    notes.push(`${numberFormat.format(count)} ${count === 1 ? singular : plural} ${advice}`);
  }
  return notes;
}
