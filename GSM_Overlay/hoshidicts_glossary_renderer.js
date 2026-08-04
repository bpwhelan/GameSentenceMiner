"use strict";

const { validateMediaPath } = require("./hoshidicts_media.js");

const MAX_STRUCTURED_DEPTH = 16;
const MAX_STRUCTURED_NODES = 1024;
const MAX_STRUCTURED_TEXT_BYTES = 128 * 1024;
const MAX_DICTIONARY_CSS_BYTES = 2 * 1024 * 1024;

const ALLOWED_TAGS = new Set([
  "br",
  "details",
  "div",
  "li",
  "ol",
  "rp",
  "rt",
  "ruby",
  "span",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

const ALLOWED_DATA_KEYS = new Set([
  "code",
  "content",
  "format",
  "type",
  "value",
]);

const INLINE_STYLE_PROPERTIES = Object.freeze({
  backgroundColor: {
    css: "background-color",
    validate: validColor,
  },
  borderColor: {
    css: "border-color",
    validate: validColor,
  },
  borderStyle: {
    css: "border-style",
    validate: (value) =>
      /^(?:none|solid|dashed|dotted|double)$/u.test(value),
  },
  borderWidth: {
    css: "border-width",
    validate: validLength,
  },
  color: {
    css: "color",
    validate: validColor,
  },
  fontSize: {
    css: "font-size",
    validate: validLength,
  },
  fontStyle: {
    css: "font-style",
    validate: (value) => /^(?:normal|italic|oblique)$/u.test(value),
  },
  fontWeight: {
    css: "font-weight",
    validate: (value) =>
      /^(?:normal|bold|[1-9]00)$/u.test(value),
  },
  marginBottom: {
    css: "margin-bottom",
    validate: validLength,
  },
  marginLeft: {
    css: "margin-left",
    validate: validLength,
  },
  marginRight: {
    css: "margin-right",
    validate: validLength,
  },
  marginTop: {
    css: "margin-top",
    validate: validLength,
  },
  textAlign: {
    css: "text-align",
    validate: (value) =>
      /^(?:start|end|left|right|center|justify)$/u.test(value),
  },
  textDecorationLine: {
    css: "text-decoration-line",
    validate: (value) =>
      /^(?:none|underline|overline|line-through)(?: (?:underline|overline|line-through))*$/u.test(
        value,
      ),
  },
  verticalAlign: {
    css: "vertical-align",
    validate: (value) =>
      /^(?:baseline|sub|super|text-top|text-bottom|middle|top|bottom)$/u.test(
        value,
      ) || validLength(value),
  },
  whiteSpace: {
    css: "white-space",
    validate: (value) =>
      /^(?:normal|pre|pre-wrap|pre-line|nowrap|break-spaces)$/u.test(value),
  },
});

const CSS_PROPERTY_VALIDATORS = new Map([
  ["background-color", validColor],
  ["border", validBorder],
  ["border-bottom", validBorder],
  ["border-color", validColor],
  ["border-left", validBorder],
  ["border-right", validBorder],
  ["border-style", (value) => /^(?:none|solid|dashed|dotted|double)(?: (?:none|solid|dashed|dotted|double)){0,3}$/u.test(value)],
  ["border-top", validBorder],
  ["border-width", validLengthList],
  ["color", validColor],
  ["display", (value) => /^(?:inline|inline-block|block|list-item|table|table-row|table-cell|none)$/u.test(value)],
  ["font-size", validLength],
  ["font-style", (value) => /^(?:normal|italic|oblique)$/u.test(value)],
  ["font-weight", (value) => /^(?:normal|bold|[1-9]00)$/u.test(value)],
  ["line-height", validLength],
  ["list-style-position", (value) => /^(?:inside|outside)$/u.test(value)],
  ["list-style-type", (value) => /^[a-z-]{1,32}$/u.test(value)],
  ["margin", validLengthList],
  ["margin-bottom", validLength],
  ["margin-left", validLength],
  ["margin-right", validLength],
  ["margin-top", validLength],
  ["padding", validLengthList],
  ["padding-bottom", validLength],
  ["padding-left", validLength],
  ["padding-right", validLength],
  ["padding-top", validLength],
  ["text-align", (value) => /^(?:start|end|left|right|center|justify)$/u.test(value)],
  ["text-decoration", (value) => /^(?:none|underline|overline|line-through)(?: (?:solid|double|dotted|dashed|wavy))?$/u.test(value)],
  ["text-decoration-color", validColor],
  ["text-decoration-line", (value) => /^(?:none|underline|overline|line-through)(?: (?:underline|overline|line-through))*$/u.test(value)],
  ["vertical-align", (value) => /^(?:baseline|sub|super|text-top|text-bottom|middle|top|bottom)$/u.test(value) || validLength(value)],
  ["white-space", (value) => /^(?:normal|pre|pre-wrap|pre-line|nowrap|break-spaces)$/u.test(value)],
]);

function validLength(value) {
  return /^(?:0|(?:\d{1,3}(?:\.\d{1,3})?)(?:px|em|rem|%))$/u.test(value);
}

function validLengthList(value) {
  const values = value.trim().split(/\s+/u);
  return values.length >= 1 && values.length <= 4 && values.every(validLength);
}

function validColor(value) {
  return (
    /^(?:#[0-9a-fA-F]{3,8}|transparent|currentColor|black|white|red|green|blue|gray|grey)$/u.test(
      value,
    ) ||
    /^(?:rgb|rgba|hsl|hsla)\([0-9.,% /+-]{1,64}\)$/u.test(value)
  );
}

function validBorder(value) {
  const parts = value.trim().split(/\s+/u);
  if (parts.length < 1 || parts.length > 3) {
    return false;
  }
  let length = false;
  let style = false;
  let color = false;
  for (const part of parts) {
    if (!length && validLength(part)) {
      length = true;
    } else if (!style && /^(?:none|solid|dashed|dotted|double)$/u.test(part)) {
      style = true;
    } else if (!color && validColor(part)) {
      color = true;
    } else {
      return false;
    }
  }
  return true;
}

function parseStructuredContent(source) {
  if (typeof source !== "string" || !source.trimStart().startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(source);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      parsed.type === "structured-content" &&
      Object.prototype.hasOwnProperty.call(parsed, "content")
    ) {
      return parsed.content;
    }
  } catch {
    // Malformed JSON remains visible as plain dictionary text.
  }
  return null;
}

function setSafeInlineStyles(element, styles) {
  if (!styles || typeof styles !== "object" || Array.isArray(styles)) {
    return;
  }
  for (const [name, rawValue] of Object.entries(styles).slice(0, 32)) {
    const property = INLINE_STYLE_PROPERTIES[name];
    if (!property || typeof rawValue !== "string") {
      continue;
    }
    const value = rawValue.trim();
    if (value.length <= 128 && property.validate(value)) {
      element.style.setProperty(property.css, value);
    }
  }
}

function setSafeDataAttributes(element, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return;
  }
  for (const [name, rawValue] of Object.entries(data).slice(0, 16)) {
    if (
      !ALLOWED_DATA_KEYS.has(name) ||
      !/^[a-z][a-z0-9-]{0,31}$/u.test(name)
    ) {
      continue;
    }
    const value =
      typeof rawValue === "string" || typeof rawValue === "number"
        ? String(rawValue)
        : null;
    if (value !== null && Buffer.byteLength(value, "utf8") <= 256) {
      element.setAttribute(`data-${name}`, value);
    }
  }
}

function positiveDimension(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  return Math.max(1, Math.min(2048, Math.round(number)));
}

function appendImageNode(parent, node, context) {
  let path;
  try {
    path = validateMediaPath(node.path);
  } catch {
    context.truncated = true;
    const placeholder = context.document.createElement("span");
    placeholder.className = "hoshidicts-media-placeholder";
    placeholder.textContent = "Media unavailable";
    parent.appendChild(placeholder);
    return;
  }

  const image = context.document.createElement("img");
  image.className = "hoshidicts-media hoshidicts-media-loading";
  image.dataset.hoshiDictionaryId = context.dictionaryId;
  image.dataset.hoshiMediaPath = path;
  image.alt =
    typeof node.title === "string" && node.title.length <= 512
      ? node.title
      : "Dictionary image";
  image.decoding = "async";
  image.loading = "lazy";
  const width = positiveDimension(node.width);
  const height = positiveDimension(node.height);
  if (width !== null) {
    image.width = width;
  }
  if (height !== null) {
    image.height = height;
  }
  parent.appendChild(image);

  if (typeof context.resolveMedia !== "function") {
    image.className = "hoshidicts-media-placeholder";
    image.removeAttribute("src");
    return;
  }
  const promise = Promise.resolve(
    context.resolveMedia(context.dictionaryId, path),
  )
    .then((media) => {
      if (
        media &&
        typeof media.dataUrl === "string" &&
        /^data:image\/(?:png|jpeg|gif|webp);base64,/u.test(media.dataUrl)
      ) {
        image.src = media.dataUrl;
        image.className = "hoshidicts-media";
      } else {
        throw new Error("Unsupported media response");
      }
    })
    .catch(() => {
      image.removeAttribute("src");
      image.className = "hoshidicts-media-placeholder";
      image.alt = "Media unavailable";
    });
  context.mediaPromises.push(promise);
}

function appendStructuredNode(parent, node, context, depth) {
  if (
    depth >= context.maxDepth ||
    context.nodes >= context.maxNodes ||
    context.textBytes >= context.maxTextBytes
  ) {
    context.truncated = true;
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      appendStructuredNode(parent, child, context, depth);
      if (context.truncated && context.nodes >= context.maxNodes) {
        break;
      }
    }
    return;
  }
  if (typeof node === "string" || typeof node === "number") {
    const text = String(node);
    const remaining = context.maxTextBytes - context.textBytes;
    const bytes = Buffer.from(text, "utf8");
    const safeText =
      bytes.length <= remaining
        ? text
        : bytes.subarray(0, Math.max(0, remaining)).toString("utf8");
    context.textBytes += Buffer.byteLength(safeText, "utf8");
    parent.appendChild(context.document.createTextNode(safeText));
    if (safeText !== text) {
      context.truncated = true;
    }
    return;
  }
  if (!node || typeof node !== "object") {
    return;
  }
  context.nodes += 1;
  if (node.tag === "img" || node.type === "image") {
    appendImageNode(parent, node, context);
    return;
  }
  if (typeof node.tag !== "string" || !ALLOWED_TAGS.has(node.tag)) {
    return;
  }
  const element = context.document.createElement(node.tag);
  if (
    typeof node.lang === "string" &&
    /^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8}){0,3}$/u.test(node.lang)
  ) {
    element.lang = node.lang;
  }
  setSafeDataAttributes(element, node.data);
  setSafeInlineStyles(element, node.style);
  parent.appendChild(element);
  if (node.tag !== "br" && Object.prototype.hasOwnProperty.call(node, "content")) {
    appendStructuredNode(element, node.content, context, depth + 1);
  }
}

function renderGlossaryContent(options = {}) {
  const document = options.document || globalThis.document;
  if (!document || typeof document.createElement !== "function") {
    throw new TypeError("renderGlossaryContent requires a DOM document");
  }
  const element = document.createElement("div");
  element.className = "hoshidicts-glossary-content";
  const structured = parseStructuredContent(options.content);
  if (structured === null) {
    element.textContent =
      typeof options.content === "string" ? options.content : "";
    return {
      element,
      mediaPromises: [],
      truncated: false,
    };
  }

  const context = {
    document,
    dictionaryId: String(options.dictionaryId || ""),
    resolveMedia: options.resolveMedia,
    mediaPromises: [],
    nodes: 0,
    textBytes: 0,
    maxDepth: Math.min(
      MAX_STRUCTURED_DEPTH,
      Math.max(1, Number(options.maxDepth) || MAX_STRUCTURED_DEPTH),
    ),
    maxNodes: Math.min(
      MAX_STRUCTURED_NODES,
      Math.max(1, Number(options.maxNodes) || MAX_STRUCTURED_NODES),
    ),
    maxTextBytes: Math.min(
      MAX_STRUCTURED_TEXT_BYTES,
      Math.max(1, Number(options.maxTextBytes) || MAX_STRUCTURED_TEXT_BYTES),
    ),
    truncated: false,
  };
  appendStructuredNode(element, structured, context, 0);
  return {
    element,
    mediaPromises: context.mediaPromises,
    truncated: context.truncated,
  };
}

function removeCssComments(source) {
  let output = "";
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) {
        return null;
      }
      index = end + 1;
      continue;
    }
    output += source[index];
  }
  return output;
}

function parseCssRules(source) {
  const rules = [];
  let cursor = 0;
  while (cursor < source.length) {
    while (cursor < source.length && /\s/u.test(source[cursor])) {
      cursor += 1;
    }
    if (cursor >= source.length) {
      break;
    }
    const open = source.indexOf("{", cursor);
    if (open < 0) {
      return null;
    }
    const selector = source.slice(cursor, open).trim();
    let quote = null;
    let close = -1;
    for (let index = open + 1; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (character === quote) {
          quote = null;
        }
      } else if (character === "'" || character === '"') {
        quote = character;
      } else if (character === "{") {
        return null;
      } else if (character === "}") {
        close = index;
        break;
      }
    }
    if (close < 0 || quote) {
      return null;
    }
    rules.push({
      selector,
      declarations: source.slice(open + 1, close).trim(),
    });
    cursor = close + 1;
  }
  return rules;
}

function splitCssList(source, delimiter) {
  const values = [];
  let start = 0;
  let quote = null;
  let parentheses = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) {
        quote = null;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "(") {
      parentheses += 1;
    } else if (character === ")") {
      parentheses -= 1;
      if (parentheses < 0) {
        return null;
      }
    } else if (character === delimiter && parentheses === 0) {
      values.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote || parentheses !== 0) {
    return null;
  }
  values.push(source.slice(start).trim());
  return values;
}

function safeSelector(selector) {
  if (
    !selector ||
    selector.length > 512 ||
    /[\\@#*:(){};]/u.test(selector) ||
    !/^[a-zA-Z0-9_.\-\s>\[\]="'~+]+$/u.test(selector)
  ) {
    return false;
  }
  const lower = selector.toLowerCase();
  if (
    /(^|[\s>+~])(html|body)(?=$|[\s>+~.[])/u.test(lower) ||
    lower.includes(":root")
  ) {
    return false;
  }
  const attributes = selector.match(/\[[^\]]+\]/gu) || [];
  if (
    attributes.some(
      (attribute) =>
        !/^\[data-[a-z0-9-]+(?:=(?:"[^"]{0,128}"|'[^']{0,128}'|[a-zA-Z0-9_-]{1,128}))?\]$/u.test(
          attribute,
        ),
    )
  ) {
    return false;
  }
  const withoutAttributes = selector.replace(/\[[^\]]+\]/gu, "");
  const classNames = withoutAttributes.match(/\.[a-zA-Z_][a-zA-Z0-9_-]*/gu) || [];
  const withoutClasses = withoutAttributes.replace(
    /\.[a-zA-Z_][a-zA-Z0-9_-]*/gu,
    "",
  );
  if (withoutClasses.includes(".") || classNames.length > 32) {
    return false;
  }
  const tagTokens = withoutClasses
    .split(/[\s>+~]+/u)
    .filter(Boolean)
    .filter((token) => /^[a-zA-Z][a-zA-Z0-9-]*$/u.test(token));
  return tagTokens.every(
    (token) => ALLOWED_TAGS.has(token.toLowerCase()) || token.includes("-"),
  );
}

function parseSafeDeclarations(source) {
  const declarations = splitCssList(source, ";");
  if (!declarations) {
    return null;
  }
  const safe = [];
  for (const declaration of declarations) {
    if (!declaration) {
      continue;
    }
    const colon = declaration.indexOf(":");
    if (colon <= 0) {
      return null;
    }
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    const validate = CSS_PROPERTY_VALIDATORS.get(property);
    if (
      !validate ||
      !value ||
      value.length > 256 ||
      /[\\@{}]/u.test(value) ||
      /(?:url|expression|javascript|vbscript|-moz-binding|behavior)\s*[:(]/iu.test(
        value,
      ) ||
      !validate(value)
    ) {
      return null;
    }
    safe.push(`${property}: ${value}`);
  }
  return safe.length > 0 ? safe : null;
}

function sanitizeDictionaryCss(css, dictionaryId) {
  if (
    typeof css !== "string" ||
    Buffer.byteLength(css, "utf8") > MAX_DICTIONARY_CSS_BYTES ||
    typeof dictionaryId !== "string" ||
    !/^[a-zA-Z0-9-]{1,128}$/u.test(dictionaryId) ||
    /[\0\\]/u.test(css)
  ) {
    return { css: "", acceptedRules: 0, rejectedRules: 1 };
  }
  const source = removeCssComments(css);
  if (source === null || /@/u.test(source)) {
    return { css: "", acceptedRules: 0, rejectedRules: 1 };
  }
  const rules = parseCssRules(source);
  if (!rules) {
    return { css: "", acceptedRules: 0, rejectedRules: 1 };
  }
  const scopedRules = [];
  let rejectedRules = 0;
  const prefix =
    `#hoshidicts-popup-root ` +
    `[data-hoshi-dictionary-id="${dictionaryId}"]`;
  for (const rule of rules) {
    const selectors = splitCssList(rule.selector, ",");
    const declarations = parseSafeDeclarations(rule.declarations);
    if (
      !selectors ||
      selectors.length === 0 ||
      selectors.length > 32 ||
      selectors.some((selector) => !safeSelector(selector)) ||
      !declarations
    ) {
      rejectedRules += 1;
      continue;
    }
    scopedRules.push(
      `${selectors.map((selector) => `${prefix} ${selector}`).join(", ")} { ${declarations.join("; ")}; }`,
    );
  }
  return {
    css: scopedRules.join("\n"),
    acceptedRules: scopedRules.length,
    rejectedRules,
  };
}

module.exports = {
  ALLOWED_TAGS,
  MAX_STRUCTURED_DEPTH,
  MAX_STRUCTURED_NODES,
  renderGlossaryContent,
  sanitizeDictionaryCss,
};
