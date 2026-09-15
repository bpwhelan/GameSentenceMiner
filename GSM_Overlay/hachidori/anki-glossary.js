// SPDX-License-Identifier: GPL-3.0-or-later
import "./external-links.js";
import "./render/glossary.js";

const BLOCKS = new Set(["BR", "DIV", "LI", "OL", "P", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL"]);
function plainText(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.getAttribute?.("aria-hidden") === "true") return "";
  return [...node.childNodes].map(plainText).join("") + (BLOCKS.has(node.nodeName) ? "\n" : "");
}

function imageSize(image, value) {
  const units = value.sizeUnits === "em" ? "em" : "px";
  for (const dimension of ["width", "height"]) {
    if (Number.isFinite(value[dimension]) && value[dimension] > 0) image.setAttribute(dimension, String(value[dimension]));
    const preferred = value[dimension === "width" ? "preferredWidth" : "preferredHeight"];
    if (Number.isFinite(preferred) && preferred > 0) image.style[dimension] = `${preferred}${units}`;
  }
  if (image.style.width && !image.style.height) image.style.height = "auto";
  else if (image.style.height && !image.style.width) image.style.width = "auto";
}

export function createAnkiDefinitionRenderer(document, request, filenameFor) {
  const inert = document.implementation.createHTMLDocument("");
  const groups = new Map();
  for (const glossary of request.term.glossaries) {
    if (!groups.has(glossary.dictionary)) groups.set(glossary.dictionary, []);
    groups.get(glossary.dictionary).push(glossary);
  }
  const media = new Map(request.dictionaryMedia.map(item => [JSON.stringify([item.dictionary, item.path]), item.filename]));
  const dictionaryAlias = dictionary => Object.hasOwn(request.dictionaryAliases, dictionary)
    ? request.dictionaryAliases[dictionary] : dictionary;
  const escape = text => { const span = inert.createElement("span"); span.textContent = text; return span.innerHTML; };

  function appendImage(doc, parent, value, { dictionary, path }, pending) {
    const image = doc.createElement("img");
    image.className = "gloss-sc-img";
    pending.push(Promise.resolve(filenameFor ? filenameFor(dictionary, path) : media.get(JSON.stringify([dictionary, path])))
      .then(filename => { if (filename) image.setAttribute("src", filename); }));
    image.alt = typeof value.title === "string" ? value.title : "Dictionary image";
    image.style.maxWidth = "100%";
    image.style.objectFit = "contain";
    imageSize(image, value);
    parent.append(image);
  }

  function content(glossary, pending) {
    const body = inert.createElement("div");
    body.className = "gsm-hoshidicts-glossary-content";
    body.dataset.hoshidictsDictionary = glossary.dictionary;
    globalThis.HDGlossary.appendTextOnlyGlossary(inert, body, glossary.glossary, {
      dictionary: glossary.dictionary, appendImage: pending ? (...args) => appendImage(...args, pending) : () => {},
    });
    return body;
  }

  function plainDefinition(selected, noDictionary) {
    const lines = [];
    for (const [dictionary, glossaries] of selected) {
      if (!noDictionary) lines.push(`(${escape(dictionaryAlias(dictionary))})`);
      for (const glossary of glossaries) {
        lines.push(...plainText(content(glossary)).split(/\r?\n|\r/u).map(line => line.trim()).filter(Boolean).map(escape));
      }
    }
    return lines.join("<br>");
  }

  function entry(glossary, brief, noDictionary, pending) {
    const wrapper = inert.createElement("div");
    const labels = brief ? [] : [glossary.definitionTags, glossary.termTags,
      noDictionary ? "" : dictionaryAlias(glossary.dictionary)].filter(Boolean);
    if (labels.length) {
      const meta = inert.createElement("i");
      meta.className = "yomitan-glossary-meta";
      meta.textContent = `(${labels.join(", ")})`;
      wrapper.append(meta, " ");
    }
    wrapper.append(content(glossary, pending));
    return wrapper;
  }

  function appendStyles(root, selected) {
    const names = new Set(selected.map(([name]) => name));
    const styles = request.dictionaryStyles.filter(style => names.has(style.dictionary));
    if (!styles.length) return;
    const applied = globalThis.HDGlossary.applyDictionaryStyles(document, root, request.generation, styles);
    // Escape a serialized closing style tag's slash without corrupting CSS
    // strings or pre-existing selector escapes.
    for (const style of applied) style.textContent = style.textContent.replace(/<\/style/giu, value => String.raw`<\/${value.slice(2)}`);
  }

  function appendDetails(root) {
    const details = [];
    if (request.term.rules) details.push(`Rules: ${escape(request.term.rules)}`);
    if (request.trace.length) details.push(`Deinflection: ${request.trace.map(step => escape(step.name)).join(" &gt; ")}`);
    if (!details.length) return;
    const small = inert.createElement("small");
    small.className = "yomitan-glossary-details";
    small.innerHTML = details.join("<br>");
    root.append(small);
  }

  return async ({ dictionary, firstOnly = false, brief = false, noDictionary = false, plain = false }) => {
    let selected = [...groups].filter(([name]) => dictionary === undefined || name === dictionary);
    if (firstOnly) selected = selected.slice(0, 1);
    if (!selected.length) return "";
    if (plain) return plainDefinition(selected, noDictionary);
    const pending = [];
    const root = inert.createElement("div");
    root.className = "yomitan-glossary";
    root.style.cssText = "text-align: left; contain: layout paint style; isolation: isolate;";
    const list = inert.createElement("ol");
    for (const [name, glossaries] of selected) {
      const page = inert.createElement("li");
      page.dataset.dictionary = name;
      if (glossaries.length === 1) page.append(entry(glossaries[0], brief, noDictionary, pending));
      else {
        const senses = inert.createElement("ul");
        for (const glossary of glossaries) { const sense = inert.createElement("li"); sense.append(entry(glossary, brief, noDictionary, pending)); senses.append(sense); }
        page.append(senses);
      }
      list.append(page);
    }
    root.append(list);
    appendStyles(root, selected);
    if (!brief) appendDetails(root);
    await Promise.all(pending);
    return root.outerHTML;
  };
}
