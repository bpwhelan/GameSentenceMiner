// SPDX-License-Identifier: GPL-3.0-or-later
import "./theme-host.js";
import { buildAnkiFields } from "./anki-values.js";
import { createAnkiDefinitionRenderer } from "./anki-glossary.js";
import { ankiDigest } from "./anki-digest.js";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico", "tiff"]);

export async function ankiMediaFilename(bytes, extension) {
  return `hachidori_${await ankiDigest(bytes)}.${extension}`;
}

const LANGUAGE_TAG = /^[A-Za-z0-9-]{1,35}$/u;

// The language object of the profile a note is mined in (docs/languages.md
// 12), knowing the target language each of the request's dictionaries
// declares; null in the single-profile shape, whose notes are today's. A
// Japanese-profile note keeps today's glossary markup, so it takes no
// dictionary's target language as its body's default (12).
function noteLanguage(profile, request) {
  if (!profile) return null;
  const targets = profile.language === "ja" ? null : request.dictionaryTargetLanguages;
  const dictionaries = targets && typeof targets === "object" && !Array.isArray(targets)
    ? Object.entries(targets).filter(([, tag]) => typeof tag === "string" && LANGUAGE_TAG.test(tag))
      .map(([title, targetLanguage]) => ({ title, targetLanguage }))
    : [];
  return globalThis.HDThemeHost.createLanguage(globalThis.HDLanguages?.get?.(profile.language) ?? null,
    { marked: true, packSettings: profile.packSettings ?? {}, dictionaries });
}

// Planning reads no dictionary bytes and uploads nothing. Stable generation
// paths, unlike an engine's restart counter, keep first-field image identities
// identical between preflight and the authoritative write.
export async function buildAnkiResourceFields(request, templates, {
  document, dictionaryPaths, styles, audio = "", compactGlossary = false, compactGlossaries = false, profile = null,
}) {
  const language = noteLanguage(profile, request);
  const media = new Map();
  const source = { ...request, dictionaryMedia: [], dictionaryStyles: [] };
  let plainRenderer, richRenderer;
  function filenameFor(dictionary, path) {
    const generationPath = Object.hasOwn(dictionaryPaths, dictionary) ? dictionaryPaths[dictionary] : null;
    if (!generationPath) throw new Error(`The dictionary generation is no longer available: ${dictionary}`);
    const key = JSON.stringify([dictionary, path]);
    if (!media.has(key)) {
      const suffix = path.split(".").at(-1).toLowerCase();
      const bytes = new TextEncoder().encode(JSON.stringify([generationPath, path]));
      media.set(key, ankiMediaFilename(bytes, IMAGE_EXTENSIONS.has(suffix) ? suffix : "bin")
        .then(filename => ({ dictionary, path, filename })));
    }
    return media.get(key).then(item => item.filename);
  }
  const fields = await buildAnkiFields(request, templates, { audio, language, definition: async options => {
    if (options.plain) {
      plainRenderer ??= createAnkiDefinitionRenderer(document, source, undefined, { compactGlossaries, language });
      return plainRenderer(options);
    }
    richRenderer ??= Promise.resolve(styles()).then(dictionaryStyles =>
      createAnkiDefinitionRenderer(document, { ...source, dictionaryStyles }, filenameFor,
        { compact: compactGlossary, compactGlossaries, language }));
    return (await richRenderer)(options);
  } });
  return { fields, media: await Promise.all(media.values()) };
}
