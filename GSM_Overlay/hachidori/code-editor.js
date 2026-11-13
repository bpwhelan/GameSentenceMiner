// SPDX-License-Identifier: GPL-3.0-or-later

// The code editor of Settings → Advanced → User scripts (docs/user-scripts.md):
// CodeMirror, from the build in vendor/codemirror (scripts/codemirror), in
// place of a <textarea>, and the read-only view of a Script Store package's
// code. user-script-settings.js and script-store.js import this module when
// the editor first opens or a package's code is first shown, so Settings
// loads CodeMirror only then.
import {
  EditorState, EditorView, HighlightStyle, bracketMatching, cssLanguage, defaultKeymap, ensureSyntaxTree,
  forEachDiagnostic, highlightSpecialChars, history, historyKeymap, indentOnInput, indentWithTab, javascriptLanguage,
  keymap, lineNumbers, lintGutter, lintKeymap, linter, placeholder, search, searchKeymap, setDiagnosticsEffect,
  syntaxHighlighting, tags,
} from "./vendor/codemirror/codemirror.js";

const LANGUAGES = { javascript: javascriptLanguage, css: cssLanguage };
// The search panel's buttons, in the sentence case of Settings.
const PHRASES = {
  next: "Next", previous: "Previous", all: "Select all", "match case": "Match case", regexp: "Regular expression",
  "by word": "Whole words", replace: "Replace", "replace all": "Replace all", close: "Close",
};

// Code is coloured with its palette's own hues. Settings' tokens are close to
// the text colour in most palettes, which would leave code one colour, so each
// hue is mixed with the text colour only as far as a 4.5:1 contrast on the
// editor's background needs, and comments fade towards the background as far
// as that contrast allows (fitColours). A Windows contrast theme replaces them
// all with its own colours.
const CONTRAST = 4.5;
const HUES = {
  keyword: "var(--hoshidicts-palette-primary, var(--accent))",
  string: "var(--hoshidicts-palette-success, var(--ok))",
  number: "var(--hoshidicts-palette-warning, var(--favorite))",
  invalid: "var(--hoshidicts-palette-error, var(--error))",
};
// The hue's share of the mix, strongest first; and the text's share of a
// comment's, faintest first.
const SHARES = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0];
const FADES = [60, 65, 70, 75, 80, 85, 90, 95, 100];
const mix = (colour, share, other) => `color-mix(in srgb, ${colour} ${share}%, ${other})`;
const linear = value => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

const highlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.self, tags.definitionKeyword, tags.moduleKeyword, tags.controlKeyword,
    tags.operatorKeyword, tags.tagName, tags.className, tags.constant(tags.className), tags.labelName,
    tags.attributeName], color: "var(--code-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.escape], color: "var(--code-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit, tags.color], color: "var(--code-number)" },
  { tag: tags.comment, color: "var(--code-comment)", fontStyle: "italic" },
  { tag: tags.invalid, color: "var(--code-invalid)" },
]);

// The text box's look in the Settings palette. Matches and search results
// also get an outline, which a Windows contrast theme keeps.
const theme = EditorView.theme({
  "&": {
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-control)",
    backgroundColor: "var(--surface)",
    color: "var(--text)",
    fontSize: "var(--font-small)",
  },
  "&.cm-focused": { outline: "2px solid var(--accent)", outlineOffset: "3px" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", lineHeight: "1.6" },
  ".cm-content": { padding: "10px 0", caretColor: "var(--text)" },
  ".cm-line": { padding: "0 10px" },
  // On the editor's own background, for which the comment colour is fitted.
  ".cm-gutters": { borderRight: "1px solid var(--border)", backgroundColor: "var(--surface)", color: "var(--code-comment)" },
  ".cm-placeholder": { color: "var(--code-comment)" },
  ".cm-specialChar": { color: "var(--code-invalid)" },
  "&.cm-focused .cm-matchingBracket": { outline: "1px solid var(--accent)", backgroundColor: "var(--accent-soft)" },
  "&.cm-focused .cm-nonmatchingBracket": { outline: "1px solid var(--error)", backgroundColor: "transparent" },
  ".cm-searchMatch": { outline: "1px solid var(--border-strong)", backgroundColor: "var(--accent-soft)" },
  ".cm-searchMatch.cm-searchMatch-selected": { outline: "2px solid var(--accent)", backgroundColor: "var(--accent-soft)" },
  ".cm-panels": { backgroundColor: "var(--surface-sunken)", color: "var(--text)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-panel.cm-search": { fontSize: "var(--font-caption)" },
  ".cm-textfield, .cm-button": {
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-control)",
    backgroundColor: "var(--surface)",
    backgroundImage: "none",
    color: "var(--text)",
    fontSize: "inherit",
  },
  ".cm-button:hover": { borderColor: "var(--accent)", backgroundColor: "var(--surface-sunken)" },
  ".cm-tooltip": { border: "1px solid var(--border-strong)", backgroundColor: "var(--surface)", color: "var(--text)" },
  ".cm-diagnostic-error": { borderLeftColor: "var(--error)" },
  ".cm-panel.cm-panel-lint ul [aria-selected]": { backgroundColor: "var(--accent-soft)", color: "var(--text)" },
});

// What the parser could not read, one diagnostic for each line it is on, as
// the code is typed. It only marks the lines: Save still saves.
function syntaxErrors({ state }) {
  const tree = ensureSyntaxTree(state, state.doc.length, 100);
  const lines = new Map();
  tree?.iterate({ enter: (node) => {
    if (!node.type.isError) return;
    const { number } = state.doc.lineAt(node.from);
    const seen = lines.get(number) ?? node;
    lines.set(number, { from: Math.min(seen.from, node.from), to: Math.max(seen.to, node.to) });
  } });
  return [...lines.values()].map(({ from, to }) => ({ from, to, severity: "error", message: "Syntax error" }));
}

// Sets the --code-* colours on `editor` for the palette it shows now.
function fitColours(editor) {
  const document = editor.ownerDocument;
  const probe = document.createElement("span");
  const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  editor.after(probe);
  const luminance = (colour) => {
    probe.style.color = colour;
    canvas.clearRect(0, 0, 1, 1);
    canvas.fillStyle = document.defaultView.getComputedStyle(probe).color;
    canvas.fillRect(0, 0, 1, 1);
    const [red, green, blue] = canvas.getImageData(0, 0, 1, 1).data;
    return 0.2126 * linear(red / 255) + 0.7152 * linear(green / 255) + 0.0722 * linear(blue / 255);
  };
  const background = luminance("var(--surface)");
  const readable = (colour) => {
    const [light, dark] = [luminance(colour), background].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05) >= CONTRAST;
  };
  for (const [name, hue] of Object.entries(HUES)) {
    const share = SHARES.find(value => readable(mix(hue, value, "var(--text)"))) ?? 0;
    editor.style.setProperty(`--code-${name}`, mix(hue, share, "var(--text)"));
  }
  const fade = FADES.find(value => readable(mix("var(--text)", value, "var(--surface)"))) ?? 100;
  editor.style.setProperty("--code-comment", mix("var(--text)", fade, "var(--surface)"));
  probe.remove();
}

// What the editor and the read-only view share: line numbers, highlighting in
// the palette's colours, bracket matching and search.
function shared(language) {
  return [
    lineNumbers(),
    highlightSpecialChars(),
    bracketMatching(),
    search(),
    syntaxHighlighting(highlighting),
    LANGUAGES[language].extension,
    EditorState.tabSize.of(2),
    EditorState.phrases.of(PHRASES),
    theme,
    EditorView.editorAttributes.of({ class: "code-editor", "data-language": language }),
  ];
}

// Fits the code's colours to the palette now and whenever Settings changes it
// by this attribute (settings-dom.js).
function followPalette(view) {
  fitColours(view.dom);
  new view.dom.ownerDocument.defaultView.MutationObserver(() => fitColours(view.dom))
    .observe(view.dom.ownerDocument.documentElement, { attributes: true, attributeFilter: ["data-hoshidicts-theme"] });
}

// A read-only view of `text` in `language`, named `label`, at the end of
// `parent`: it can be focused, selected, copied and searched, not changed.
export function createCodeView(parent, { language, text, label }) {
  const view = new EditorView({ parent, state: EditorState.create({ doc: text, extensions: [
    ...shared(language),
    EditorState.readOnly.of(true),
    keymap.of([...defaultKeymap, ...searchKeymap]),
    EditorView.contentAttributes.of({ "aria-label": label, "aria-readonly": "true" }),
  ] }) });
  followPalette(view);
  return view;
}

// Replaces `textarea` with a CodeMirror editor of its text, in `language`
// ("javascript" or "css"), and returns the editor's `value` and `focus()` as a
// textarea has them, and `problems`, the lines with a syntax error. Setting
// `value` starts the text afresh, without undo to the text before.
// `onChange` runs after each edit and when `problems` changes. The textarea
// stays, hidden, and lends the editor its label, description and placeholder.
export function createCodeEditor(textarea, { language, onChange }) {
  const document = textarea.ownerDocument;
  const { labels } = textarea;
  const extensions = [
    ...shared(language),
    history(),
    indentOnInput(),
    linter(syntaxErrors, { delay: 500 }),
    lintGutter(),
    // Tab indents; Escape and then Tab moves on, as CodeMirror documents.
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...lintKeymap, indentWithTab]),
    placeholder(textarea.placeholder),
    EditorView.contentAttributes.of({
      "aria-label": labels[0]?.textContent.trim() ?? language,
      "aria-describedby": textarea.getAttribute("aria-describedby") ?? "",
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged || update.transactions.some(({ effects }) => effects.some(effect => effect.is(setDiagnosticsEffect)))) {
        onChange();
      }
    }),
  ];
  const create = doc => EditorState.create({ doc, extensions });
  const focused = document.activeElement === textarea;
  const view = new EditorView({ state: create(textarea.value) });
  textarea.after(view.dom);
  textarea.hidden = true;
  followPalette(view);
  // The label names the hidden textarea, so a click on it focuses the editor.
  for (const label of labels) label.addEventListener("click", () => view.focus());
  if (focused) view.focus();
  return {
    get value() { return view.state.doc.toString(); },
    set value(text) { view.setState(create(text)); },
    get problems() {
      const lines = new Set();
      forEachDiagnostic(view.state, (diagnostic, from) => lines.add(view.state.doc.lineAt(from).number));
      return [...lines].sort((a, b) => a - b);
    },
    focus() { view.focus(); },
  };
}
