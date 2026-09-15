// SPDX-License-Identifier: GPL-3.0-or-later
import { buildAnkiFields } from "./anki-values.js";
import { createAnkiDefinitionRenderer } from "./anki-glossary.js";
import { ankiDigest } from "./anki-digest.js";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico", "tiff"]);

export async function ankiMediaFilename(bytes, extension) {
  return `hachidori_${await ankiDigest(bytes)}.${extension}`;
}

// Planning reads no dictionary bytes and uploads nothing. Stable generation
// paths, unlike an engine's restart counter, keep first-field image identities
// identical between preflight and the authoritative write.
export async function buildAnkiResourceFields(request, templates, { document, dictionaryPaths, styles, audio = "" }) {
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
  const fields = await buildAnkiFields(request, templates, { audio, definition: async options => {
    if (options.plain) {
      plainRenderer ??= createAnkiDefinitionRenderer(document, source);
      return plainRenderer(options);
    }
    richRenderer ??= Promise.resolve(styles()).then(dictionaryStyles =>
      createAnkiDefinitionRenderer(document, { ...source, dictionaryStyles }, filenameFor));
    return (await richRenderer)(options);
  } });
  return { fields, media: await Promise.all(media.values()) };
}
