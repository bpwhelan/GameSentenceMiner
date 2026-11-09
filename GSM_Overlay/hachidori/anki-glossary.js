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

// Yomitan's anki-compact-gloss-style.js (67db60d) under Compact popup and
// Anki, scoped to the glossary as its addGlossaryScopeToCss scopes it: a
// structured `ul[data-sc-content="glossary"]` shares one line, its items
// separated by a grey bar.
const COMPACT_GLOSS_STYLES = `.yomitan-glossary ul[data-sc-content="glossary"] > li:not(:first-child)::before {
  white-space: pre-wrap;
  content: ' | ';
  display: inline;
  color: #777777;
}
.yomitan-glossary ul[data-sc-content="glossary"] > li {
  display: inline;
}
.yomitan-glossary ul[data-sc-content="glossary"] {
  display: inline;
  list-style: none;
  padding-left: 0;
}`;

const BLOCKS = new Set(["BR", "DIV", "LI", "OL", "P", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL"]);
function plainText(node) {
  const stack = [node], output = [];
  while (stack.length) {
    const current = stack.pop();
    if (current === "\n") output.push(current);
    else if (current.nodeType === 3) output.push(current.textContent);
    else if (current.getAttribute?.("aria-hidden") !== "true") {
      if (BLOCKS.has(current.nodeName)) stack.push("\n");
      for (let index = current.childNodes.length - 1; index >= 0; index--) stack.push(current.childNodes[index]);
    }
  }
  return output.join("");
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

// `language` is the language object (theme-host.js createLanguage) of the
// profile the note is mined in, once the records have profiles; without one
// the note is today's (docs/languages.md 4.5). `compactGlossaries` is Design →
// Compact glossaries → Compact popup and Anki; `compact` is Smaller Anki cards.
export function createAnkiDefinitionRenderer(document, request, filenameFor,
  { compact = false, compactGlossaries = false, language = null } = {}) {
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

  // docs/languages.md 12: each dictionary's direction, as the mining request
  // carries it beside its display name, else by 10.2's rule over its glosses.
  const directions = new Map();
  function directionOf(dictionary) {
    if (!directions.has(dictionary)) {
      const carried = request.dictionaryDirections && Object.hasOwn(request.dictionaryDirections, dictionary)
        ? request.dictionaryDirections[dictionary] : null;
      directions.set(dictionary, carried === "rtl" || carried === "ltr" ? carried : language.dictionaryDirection(dictionary, request));
    }
    return directions.get(dictionary);
  }
  // The right-to-left rules cover every root of a note mined in a right-to-left
  // profile, and elsewhere a root that holds a right-to-left dictionary.
  const followsRtlRules = names => language !== null
    && (language.direction === "rtl" || names.some(name => directionOf(name) === "rtl"));
  // A name with a right-to-left character sits alone in a dir="auto" element.
  function appendName(parent, name, rtlRules) {
    if (!rtlRules || !globalThis.HDGlossary.hasRtlText(name)) {
      parent.append(name);
      return;
    }
    const isolated = inert.createElement("span");
    isolated.dir = "auto";
    isolated.textContent = name;
    parent.append(isolated);
  }

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

  // With a language, glossary text takes 10.3's language, labelled where it
  // differs from the dictionary's target language, which the body carries.
  // Under the right-to-left rules each block of the other direction keeps its
  // own, a row's text that sits in the body itself included (10.2).
  function content(glossary, pending, rtlRules = false) {
    const body = inert.createElement("div");
    body.className = "gsm-hoshidicts-glossary-content";
    body.dataset.hoshidictsDictionary = glossary.dictionary;
    const tag = language?.dictionaryLanguage(glossary.dictionary) ?? null;
    if (tag) body.lang = tag;
    globalThis.HDGlossary.appendTextOnlyGlossary(inert, body, glossary.glossary, {
      dictionary: glossary.dictionary, layout: "anki", compactGlossaries, ...(language === null ? {} : { language }),
      appendImage: pending ? (...args) => appendImage(...args, pending) : () => {},
    });
    const direction = rtlRules ? directionOf(glossary.dictionary) : null;
    if (direction === "rtl" || (direction !== null && globalThis.HDGlossary.hasRtlText(glossary.glossary))) {
      const row = inert.createElement("div");
      row.append(body);
      globalThis.HDGlossary.markBlockDirections(row, direction, { listPadding: "40px" });
      body.remove();
    }
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

  function entry(glossary, brief, noDictionary, pending, rtlRules) {
    const wrapper = inert.createElement("div");
    // Yomitan's glossary-single: one comma-separated label per tag, the
    // definition tags in their tag-bank order.
    const { definitionTagList, parseTagList } = globalThis.HDGlossary;
    const tags = brief ? [] : [...definitionTagList(glossary).map(tag => tag.name), ...parseTagList(glossary.termTags)]
      .filter(Boolean);
    const name = brief || noDictionary ? "" : dictionaryAlias(glossary.dictionary);
    if (tags.length || name) {
      const meta = inert.createElement("i");
      meta.className = "yomitan-glossary-meta";
      meta.textContent = `(${[...tags, ...(name ? [""] : [])].join(", ")}`;
      if (name) appendName(meta, name, rtlRules);
      meta.append(")");
      meta.normalize();
      wrapper.append(meta, " ");
    }
    wrapper.append(replaceNewlines(content(glossary, pending, rtlRules)));
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

  function appendDetails(root, rtlRules) {
    const details = [];
    if (request.term.rules) details.push(`Rules: ${escape(request.term.rules)}`);
    if (request.trace.length) details.push(`Deinflection: ${request.trace.map(step => escape(step.name)).join(" &gt; ")}`);
    if (!details.length) return;
    const small = inert.createElement("small");
    small.className = "yomitan-glossary-details";
    // The footer is English.
    if (rtlRules) small.dir = "ltr";
    small.innerHTML = details.join("<br>");
    root.append(small);
  }

  // The field's root and list. Under the right-to-left rules the root takes
  // its dictionaries' direction, ltr included, so a right-to-left card cannot
  // turn English glosses around. Dictionaries of both directions keep each
  // item's own, and the list pads both sides so every number stays inside
  // the field.
  function glossaryRoot(names) {
    const rtlRules = followsRtlRules(names);
    const rootDirections = rtlRules ? new Set(names.map(directionOf)) : null;
    const mixed = rootDirections?.size > 1;
    const root = inert.createElement("div");
    root.className = "yomitan-glossary";
    root.style.cssText = `text-align: ${rtlRules ? "start" : "left"}; contain: layout paint style; isolation: isolate;`;
    if (rtlRules) root.dir = mixed ? language.direction : [...rootDirections][0];
    const list = inert.createElement("ol");
    if (mixed) list.style.paddingInline = "40px";
    return { root, list, rtlRules, mixed };
  }

  return async ({ dictionary, firstOnly = false, brief = false, noDictionary = false, plain = false }) => {
    let selected = [...groups].filter(([name]) => dictionary === undefined || name === dictionary);
    if (firstOnly) selected = selected.slice(0, 1);
    if (!selected.length) return "";
    if (plain) return plainDefinition(selected, noDictionary);
    const pending = [];
    const { root, list, rtlRules, mixed } = glossaryRoot(selected.map(([name]) => name));
    // One item per term-bank row, as Yomitan's {glossary} template emits: note
    // types page by li[data-dictionary] and pad any nested list (#359).
    for (const [name, glossaries] of selected) {
      for (const glossary of glossaries) {
        const page = inert.createElement("li");
        page.dataset.dictionary = name;
        if (mixed) page.dir = directionOf(name);
        page.append(entry(glossary, brief, noDictionary, pending, rtlRules));
        list.append(page);
      }
    }
    root.append(list);
    appendStyles(root, selected);
    if (compactGlossaries) {
      const style = inert.createElement("style");
      style.textContent = COMPACT_GLOSS_STYLES;
      root.append(style);
    }
    // Yomitan's {glossary} has no footer; {part-of-speech} and {conjugation}
    // carry this information, so compact fields leave it out (#399).
    if (!brief && !compact) appendDetails(root, rtlRules);
    await Promise.all(pending);
    if (compact) return compactAnkiGlossary(document, root, { textAlign: rtlRules ? "start" : "left" });
    applyClassStyles(list);
    return root.outerHTML;
  };
}
