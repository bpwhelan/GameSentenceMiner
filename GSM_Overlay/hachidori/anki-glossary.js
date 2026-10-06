// SPDX-License-Identifier: GPL-3.0-or-later
import "./external-links.js";
import "./render/glossary.js";
import { compactAnkiGlossary } from "./anki-compact.js";
import { STRUCTURED_CONTENT_STYLE } from "./vendor/yomitan/structured-content-style.js";

// Yomitan's CssStyleApplier.applyClassStyles (dom/css-style-applier.js at
// 67db60d) with structured-content-style.json, as its
// AnkiTemplateRenderer._normalizeHtml applies them to exported structured
// content: a note field has none of the popup's stylesheet, so each element's
// matching class rules become its inline style, ahead of any style it already
// has. Unlike Yomitan, the classes stay, so dictionary styles written against
// them keep applying on the card.
const STYLE_RULES = STRUCTURED_CONTENT_STYLE.map(({ selectors, styles }) => ({
  selectors: selectors.join(","),
  cssText: styles.map(([property, value]) => `${property}:${value};`).join(""),
}));
const candidateRules = new Map();
function rulesForClass(className) {
  let rules = candidateRules.get(className);
  if (rules) return rules;
  // _selectorMightMatch: a rule can only match if it names one of the classes.
  const tokens = className.split(/[\t\n\f\r ]+/u).filter(Boolean);
  rules = STYLE_RULES.filter(({ selectors }) => tokens.some(token => {
    for (let start = selectors.indexOf(`.${token}`); start >= 0; start = selectors.indexOf(`.${token}`, start + 1)) {
      if (!/[0-9a-zA-Z_-]/u.test(selectors[start + token.length + 1] ?? "")) return true;
    }
    return false;
  }));
  candidateRules.set(className, rules);
  return rules;
}
function applyClassStyles(root) {
  const styled = [];
  for (const element of root.querySelectorAll("[class]")) {
    let cssText = "";
    for (const { selectors, cssText: rule } of rulesForClass(element.getAttribute("class"))) {
      try {
        if (element.matches(selectors)) cssText += rule;
      } catch {
        // As in Yomitan, a selector the engine cannot match (a pseudo-element) is skipped.
      }
    }
    if (cssText) styled.push([element, cssText + element.style.cssText]);
  }
  for (const [element, cssText] of styled) element.setAttribute("style", cssText);
}

const BLOCKS = new Set(["BR", "DIV", "LI", "OL", "P", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL"]);
function plainText(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.getAttribute?.("aria-hidden") === "true") return "";
  return [...node.childNodes].map(plainText).join("") + (BLOCKS.has(node.nodeName) ? "\n" : "");
}

function imageSize(image, value) {
  const units = value.sizeUnits === "em" ? "em" : "px";
  const positive = size => Number.isFinite(size) && size > 0;
  const preferred = { width: value.preferredWidth, height: value.preferredHeight };
  // HTML width/height attributes are CSS pixels, so only a pixel-sized image can
  // use them. An em-sized image (sankoku8's 0.5em × 1em pitch-accent mark, #325)
  // carries its declared size as CSS instead of becoming a 0.5px × 1px image.
  const styled = positive(preferred.width) || positive(preferred.height) ? preferred : units === "em" ? value : {};
  for (const dimension of ["width", "height"]) {
    if (units === "px" && positive(value[dimension])) image.setAttribute(dimension, String(value[dimension]));
    if (positive(styled[dimension])) image.style[dimension] = `${styled[dimension]}${units}`;
  }
  if (image.style.width && !image.style.height) image.style.height = "auto";
  else if (image.style.height && !image.style.width) image.style.width = "auto";
}

export function createAnkiDefinitionRenderer(document, request, filenameFor, { compact = false } = {}) {
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
      dictionary: glossary.dictionary, layout: "anki",
      appendImage: pending ? (...args) => appendImage(...args, pending) : () => {},
    });
    return body;
  }

  // A note field has none of the popup's `white-space: pre-line`, so each line
  // break in rich dictionary text becomes a <br>, as in Yomitan's
  // AnkiTemplateRenderer._replaceNewlines (#359). Plain markers split lines themselves.
  function replaceNewlines(root) {
    const walker = inert.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (const text of texts) {
      const lines = text.nodeValue.split(/\r?\n|\r/u);
      if (lines.length > 1) text.replaceWith(...lines.flatMap((line, index) => index ? [inert.createElement("br"), line] : line));
    }
    return root;
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
    // Yomitan's glossary-single: one comma-separated label per tag, the
    // definition tags in their tag-bank order.
    const { definitionTagList, parseTagList } = globalThis.HDGlossary;
    const labels = brief ? [] : [...definitionTagList(glossary).map(tag => tag.name), ...parseTagList(glossary.termTags),
      noDictionary ? "" : dictionaryAlias(glossary.dictionary)].filter(Boolean);
    if (labels.length) {
      const meta = inert.createElement("i");
      meta.className = "yomitan-glossary-meta";
      meta.textContent = `(${labels.join(", ")})`;
      wrapper.append(meta, " ");
    }
    wrapper.append(replaceNewlines(content(glossary, pending)));
    return wrapper;
  }

  function appendStyles(root, selected) {
    const names = new Set(selected.map(([name]) => name));
    const styles = request.dictionaryStyles.filter(style => names.has(style.dictionary));
    if (!styles.length) return;
    // Yomitan's dictScopedStyles: each dictionary's rules under its own
    // li[data-dictionary] of this glossary, by selector prefix, because Anki
    // still ships Chromium builds without @scope.
    const applied = globalThis.HDGlossary.applyDictionaryStyles(document, root, request.generation, styles,
      { scope: title => `.yomitan-glossary [data-dictionary=${document.defaultView.CSS.escape(title)}]` });
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
    // One item per term-bank row, as Yomitan's {glossary} template emits: note
    // types page by li[data-dictionary] and pad any nested list (#359).
    for (const [name, glossaries] of selected) {
      for (const glossary of glossaries) {
        const page = inert.createElement("li");
        page.dataset.dictionary = name;
        page.append(entry(glossary, brief, noDictionary, pending));
        list.append(page);
      }
    }
    root.append(list);
    appendStyles(root, selected);
    // Yomitan's {glossary} has no footer; {part-of-speech} and {conjugation}
    // carry this information, so compact fields leave it out (#399).
    if (!brief && !compact) appendDetails(root);
    await Promise.all(pending);
    if (compact) return compactAnkiGlossary(document, root);
    applyClassStyles(list);
    return root.outerHTML;
  };
}
