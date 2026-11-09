// The search page (#610), after Yomitan's search page and popup window
// (yomidevs/yomitan@d3c54c1 ext/search.html and
// ext/js/display/search-display-controller.js). A word typed or pasted into
// the box is looked up through the reader this page loads into itself, which
// docks its popup over the results area. The page follows the popup theme as
// Settings does, and the popup is the reader's own, with its theme, Anki,
// pronunciation, tabs and child popups. This page is search-frame.html, the
// sandboxed frame search.html holds under its header so that Custom JavaScript
// runs here too (#644); search-bridge.js lends it the extension APIs.
//
// It keeps each line it searches in its history (docs/search-history.md). Up
// and Down in the box walk back and forward through it as a shell's do; in the
// searched text, the arrow keys move Rubi's cursor word by word and row by row,
// and on to earlier lines (search-lines.js), each word looked up as the cursor
// reaches it. User scripts read and change the history through HDSearchHistory.
// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionApi as chrome } from "./browser-api.js";
import "./reader-options.js";
import { captureDebugLog, captureDocumentActions, recordUserError, setDebugLogLanguages } from "./debug-log.js";
import { describeErrorMessage } from "./error-text.js";
import { formatKeybind } from "./keybind-settings.js";
import { loadReaderScripts } from "./reader-page.js";
import { createNavigation, firstSelectable, ROW_STAY, rowKey, stopAt, textRows } from "./search-lines.js";
import { renderTemplateChoices } from "./search-templates.js";
import { applyPageTheme } from "./settings-dom.js";

const bridge = globalThis.HDSearchBridge;
// Settings → Advanced → Get debug info includes what failed here.
captureDocumentActions(document, captureDebugLog(window, {
  context: "search", store: bridge.debugLogStore, version: async () => (await bridge.ready).manifest.version,
}));

const { KEYBIND_MODIFIER_CODES, keybindModifiers, normaliseOptions, hasProfiles, profiles, profileDescriptor,
  activeProfileId, projectOptions, LANGUAGE_SELECTION_KEY } = globalThis.HDReaderOptions;
const input = document.getElementById("search-input");
const submit = document.getElementById("search-submit");
const lines = document.getElementById("search-lines");
const before = document.getElementById("search-before");
const query = document.getElementById("search-query");
const after = document.getElementById("search-after");
const where = document.getElementById("search-where");
const keys = document.getElementById("search-keys");
const cursorWord = document.getElementById("search-cursor-word");
const status = document.getElementById("search-status");
const templateChoices = document.querySelector("select.search-template");
// While Advanced → Search history is on, the searched text is a read-only
// text box, which takes focus and its arrow keys (a screen reader passes it
// them) and is described by its keys and, in a visit, where it is. It stays a
// text node in the page, not a textarea, so the reader looks its words up and
// the cursor's highlight can paint them. Off, it is the plain echoed query it
// was before, and the keys' note takes no room.
const TEXT_BOX = { tabindex: "0", role: "textbox", "aria-readonly": "true", "aria-multiline": "true",
  "aria-label": "Searched text", "aria-describedby": "search-where search-keys" };
function adoptFeature() {
  for (const [name, value] of Object.entries(TEXT_BOX)) {
    if (options.searchHistoryEnabled) query.setAttribute(name, value);
    else query.removeAttribute(name);
  }
  keys.hidden = !options.searchHistoryEnabled;
}
let reader = null;
let options = normaliseOptions(undefined);

// The history, which search.html keeps (search-shell.js).
const historyRequest = (op, args) => bridge.history(op, args);
// The kept line before (direction -1; the newest when `id` is undefined) or
// after (1) the line `id` whose text is not `unlike`, or null. A line from
// `newest` on is not an earlier line.
async function keptLine(id, direction, unlike, newest = null) {
  for (let from = id ?? undefined; ;) {
    if (direction > 0 && from === undefined) return null;
    const [found] = await historyRequest("list", direction < 0 ? { before: from, limit: 1 } : { after: from, limit: 1 });
    if (!found || (newest !== null && found.id >= newest)) return null;
    if (found.text !== unlike) return found;
    from = found.id;
  }
}

// Keeps a line searched from `source` (typed, paste or clipboard), while
// Advanced → Search history is on; resolves to its id, or null.
async function keep(text, source) {
  if (!options.searchHistoryEnabled) return null;
  try {
    return (await historyRequest("add", { text, source }))?.id ?? null;
  } catch (error) {
    console.warn("hachidori: the search history could not keep a line:", error);
    return null;
  }
}

// A line the searched text shows: its text, its history id (null when it was
// not kept), its cursor and the word the last lookup matched there.
const line = (text, id, cursor) => ({ text, id, cursor, match: null });
// Where an earlier line's cursor starts: on the first character it can rest
// on, after any brackets and spaces the line opens with, as a search starts.
// Rubi's starts on its first Japanese letter, or with Japanese characters
// only off, its first character.
function opening(text) {
  const start = globalThis.HDContent.searchStart(text);
  return firstSelectable(text, start, japaneseOnly(), wordRules()) ?? start;
}

// The line last searched; the line shown, which is it, or an earlier one in a
// visit to the history ({ older, newer, depth }: the lines around the shown
// one and how far back it is); the shown line's navigation (Right's history,
// Up and Down's column); and whether a line step is waiting for the history.
let current = null;
let shown = null;
let visit = null;
let navigation = createNavigation();
let stepping = false;

// The cursor's word, while the searched text has focus: what the last lookup
// matched at the cursor, or the character under it.
const CURSOR_HIGHLIGHT = "hd-search-cursor";
const characterEnd = (text, at) => at + (text.codePointAt(at) > 0xffff ? 2 : 1);
function paintCursor() {
  const highlights = globalThis.CSS?.highlights;
  if (!highlights || typeof Highlight !== "function") return;
  const node = query.firstChild;
  if (!shown || !node || document.activeElement !== query) {
    highlights.delete(CURSOR_HIGHLIGHT);
    return;
  }
  const at = Math.min(shown.cursor, node.length);
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, Math.min(shown.match?.at === at ? shown.match.end : characterEnd(node.data, at), node.length));
  highlights.set(CURSOR_HIGHLIGHT, new Highlight(range));
}

// Scrolls the searched text to the cursor's row (Rubi's header_follow).
function follow() {
  const node = query.firstChild;
  if (!shown || !node) return;
  const range = document.createRange();
  range.setStart(node, shown.cursor);
  range.setEnd(node, Math.min(characterEnd(node.data, shown.cursor), node.length));
  const cell = range.getBoundingClientRect();
  const box = query.getBoundingClientRect();
  if (cell.top < box.top) query.scrollTop -= box.top - cell.top;
  else if (cell.bottom > box.bottom) query.scrollTop += cell.bottom - box.bottom;
}

// Looks up the word at the shown line's cursor, and keeps how far it matched
// for the next Right.
async function lookUp(shownLine) {
  const node = query.firstChild;
  const at = shownLine.cursor;
  shownLine.lookingUp = at;
  const length = await reader.search(node, at);
  if (shown !== shownLine || shownLine.cursor !== at || query.firstChild !== node) return;
  shownLine.lookingUp = null;
  shownLine.match = length > 0 ? { at, end: at + length } : null;
  paintCursor();
  sayCursorWord();
}

// The word the cursor rests on (what its lookup matched, or its character),
// read out by a screen reader from a polite live region while the searched
// text has focus: after each move's lookup, and when the keyboard brings focus
// to the text. A lookup still on its way writes the word when it answers, so
// a search never reads out its first character first.
function sayCursorWord() {
  const node = query.firstChild;
  if (!shown || !node || document.activeElement !== query || shown.lookingUp === shown.cursor) return;
  const at = Math.min(shown.cursor, node.length);
  cursorWord.textContent = node.data.slice(at, shown.match?.at === at ? shown.match.end : characterEnd(node.data, at));
}

// Shows a line, between its neighbours in a visit, and looks up its cursor's word.
function show(shownLine) {
  shown = shownLine;
  navigation = createNavigation();
  query.textContent = shownLine.text;
  cursorWord.textContent = "";
  before.dataset.text = visit?.older?.text ?? "";
  before.hidden = !visit?.older;
  after.dataset.text = visit?.newer.text ?? "";
  after.hidden = !visit;
  const earlier = visit?.older ? " · ▲ earlier" : "";
  where.textContent = visit ? `Earlier line -${visit.depth}${earlier} · ▼ later` : "";
  where.hidden = !visit;
  lines.hidden = false;
  query.hidden = false;
  status.hidden = true;
  query.scrollTop = 0;
  paintCursor();
  follow();
  void lookUp(shownLine);
}

// Rubi's line history (docs/line-history.md), over this page's history: Up on
// the searched text's top row shows the line before the shown one, between the
// last row of the line before that and the first row of the line after it;
// Down on an earlier line's last row shows the line after it, and past the
// newest the current line again, its cursor where it was. An earlier line
// opens on its first word. A press while a step waits for the history is dropped.
async function stepLine(direction) {
  if (stepping || !shown || (direction > 0 && !visit)) return;
  stepping = true;
  const from = shown;
  const earlier = found => found && line(found.text, found.id, 0);
  try {
    let next = null;
    if (direction < 0) {
      next = visit ? visit.older : earlier(await keptLine(from.id, -1, from.text));
      const older = next && earlier(await keptLine(next.id, -1, next.text));
      if (!next || shown !== from) return;
      visit = { older, newer: from, depth: (visit?.depth ?? 0) + 1 };
    } else if (visit.newer === current) {
      next = current;
      visit = null;
    } else {
      next = visit.newer;
      const newer = earlier(await keptLine(next.id, 1, next.text, current.id)) ?? current;
      if (shown !== from) return;
      visit = { older: from, newer, depth: visit.depth - 1 };
    }
    if (next !== current) {
      next.cursor = opening(next.text);
      next.match = null;
    }
    show(next);
  } catch (error) {
    console.warn("hachidori: the search history could not be read:", error);
  } finally {
    stepping = false;
  }
}

// The shown text's rows, read again only when its text or size changes:
// textRows measures every character, which a long text makes slow for each
// key, and a held one.
let laidOut = null;
function rowsOf(node) {
  const size = `${query.clientWidth}x${query.scrollHeight}`;
  if (laidOut?.node !== node || laidOut.data !== node.data || laidOut.size !== size) {
    const rows = textRows(node);
    if (!rows) return null;
    laidOut = { node, data: node.data, size, rows };
  }
  return laidOut.rows;
}

// Rubi's arrow keys over the searched text (shell/overlay.cpp input_overlay):
// Left/Right word by word, Up/Down row by row, and past the text's top row, or
// an earlier line's last, on to another line.
function move(dx, dy, repeat) {
  const shownLine = shown;
  const node = query.firstChild;
  if (!shownLine || !node) return false;
  const matchedEnd = shownLine.match?.at === shownLine.cursor ? shownLine.match.end : 0;
  const { result, to } = rowKey(navigation, { text: shownLine.text, rows: rowsOf(node),
    japaneseOnly: japaneseOnly(), words: wordRules() }, shownLine.cursor, matchedEnd, dx, dy);
  // A held Left/Right stops at the text's ends: only a fresh press goes round a one-row text's.
  const wentRound = dx > 0 ? to < shownLine.cursor : to > shownLine.cursor;
  const cursor = repeat && dx && wentRound ? shownLine.cursor : to;
  if (result === ROW_STAY && dy && (dy < 0 || visit)) {
    void stepLine(dy);
  } else if (cursor !== shownLine.cursor) {
    shownLine.cursor = cursor;
    shownLine.match = null;
    paintCursor();
    follow();
    void lookUp(shownLine);
  }
  return true;
}

// Up and Down in the box walk its history as a shell's do: `draft` is what the
// box held before the walk and `line` the kept line it shows. Typing in the box
// ends the walk; Down past the newest line brings the draft back.
let walk = null;
let walking = false;
const collapsed = () => input.selectionStart === input.selectionEnd;
const onFirstRow = () => collapsed() && !input.value.slice(0, input.selectionStart).includes("\n");
const onLastRow = () => collapsed() && !input.value.slice(input.selectionEnd).includes("\n");

async function walkHistory(direction) {
  if (walking) return;
  walking = true;
  const value = input.value;
  try {
    const next = await keptLine(walk?.line.id, direction, value);
    if (input.value !== value || (direction < 0 && !next)) return;
    const draft = walk?.draft ?? value;
    walk = next ? { draft, line: next } : null;
    input.value = next ? next.text : draft;
    // Up leaves the caret on the line's first row and Down on its last, so the
    // next press walks on.
    const firstBreak = input.value.indexOf("\n");
    const caret = direction < 0 && firstBreak >= 0 ? firstBreak : input.value.length;
    input.setSelectionRange(caret, caret);
  } catch (error) {
    console.warn("hachidori: the search history could not be read:", error);
  } finally {
    walking = false;
  }
}
input.addEventListener("input", () => { walk = null; });

// The search page's keybinds (Settings → Keybinds, On the search page), each
// where it applies: the history's lines in the box, the cursor in the searched
// text, and there also a reader action such as Add note. Held, the moves repeat.
const REPEATING = new Set(["searchPreviousLine", "searchNextLine", "searchPreviousWord", "searchNextWord", "searchRowUp",
  "searchRowDown"]);
// Next and previous word go in reading order; in right-to-left text the arrow
// keys go the way they point, as a caret's do.
function wordDirection(action, event) {
  const next = action === "searchNextWord" ? 1 : -1;
  return /^Arrow(?:Left|Right)$/u.test(event.code) && getComputedStyle(query).direction === "rtl" ? -next : next;
}

function runSearchAction(action, event) {
  const inBox = document.activeElement === input;
  const inText = document.activeElement === query && shown !== null;
  switch (action) {
    case "searchPreviousLine":
      if (!inBox || !onFirstRow()) return false;
      void walkHistory(-1);
      return true;
    case "searchNextLine":
      if (!inBox || walk === null || !onLastRow()) return false;
      void walkHistory(1);
      return true;
    case "searchPreviousWord":
    case "searchNextWord":
      return inText && move(wordDirection(action, event), 0, event.repeat);
    case "searchRowUp":
    case "searchRowDown":
      return inText && move(0, action === "searchRowDown" ? 1 : -1, event.repeat);
    default:
      return inText && reader !== null && reader.act(action);
  }
}

function runSearchKeybinds(event) {
  if (!options.searchHistoryEnabled) return false;
  const key = KEYBIND_MODIFIER_CODES.has(event.code) ? null : event.code;
  const modifiers = keybindModifiers(event).join();
  return options.keybinds.some(bind => bind.enabled && bind.action !== "" && bind.scopes.includes("search")
    && bind.key === key && bind.modifiers.join() === modifiers && (!event.repeat || REPEATING.has(bind.action))
    && runSearchAction(bind.action, event));
}

// Names the searched text's keys beside it while it has focus, from the
// bindings: Left and Right are words, Up and Down rows and earlier lines.
function describeKeys() {
  const bound = action => options.keybinds.find(bind => bind.enabled && bind.action === action && bind.key !== null
    && bind.scopes.includes("search"));
  const named = (actions, what) => {
    const found = actions.map(bound).filter(Boolean)
      .map(({ key, modifiers }) => formatKeybind(key, modifiers).replace(/\bArrow(?=Left|Right|Up|Down)/gu, ""));
    return found.length === 0 ? null : `${found.join("/")}: ${what}`;
  };
  keys.textContent = [named(["searchPreviousWord", "searchNextWord"], "words"),
    named(["searchRowUp", "searchRowDown"], "rows and earlier lines"), named(["addNote"], "add to Anki"),
    "Escape: back to the box"].filter(Boolean).join(" · ");
}

// Yomitan's search trims the box's text, shows it above the results, where
// the reader can look up its other words, and moves focus from the box: here
// to the searched text, where the arrow keys move its cursor, unless focus is
// somewhere else of the user's choosing. The results cover the hint, which
// would show through a translucent popup. The line goes into the history.
function search(source = "typed") {
  const text = input.value.trim();
  if (!reader || !text) return;
  walk = null;
  visit = null;
  const focused = document.activeElement;
  const searched = line(text, null, globalThis.HDContent.searchStart(text));
  current = searched;
  show(searched);
  if (!options.searchHistoryEnabled) input.blur();
  else if ([input, query, document.body, null].includes(focused)) query.focus({ preventScroll: true });
  void keep(text, source).then((id) => { searched.id = id; });
}
// A press on the text gives it focus before its click, which can move the
// cursor while Look up words with a click is on: then the focus reads nothing
// out, and the click decides (see reader.lookUpOnClick below).
let pressed = false;
let clickMoved = false;
query.addEventListener("mousedown", () => {
  pressed = document.activeElement !== query && options.searchHistoryEnabled && options.searchClickLookup;
  clickMoved = false;
});
query.addEventListener("focus", () => {
  paintCursor();
  if (!pressed) sayCursorWord();
  pressed = false;
});
query.addEventListener("blur", paintCursor);

// The reader's popup keeps its own keys and pastes, its Note form's among
// them. Its shadow root is closed, so the page sees only the reader's host.
const inReader = node => node?.localName === "hachidori-host";

// Yomitan's _isElementInput: a key typed there stays there.
function typingTarget(element) {
  return ["input", "textarea", "button", "select"].includes(element?.localName) || element?.isContentEditable === true
    || inReader(element);
}

// Where a paste goes in as text.
function pasteTarget(node) {
  return ["input", "textarea"].includes(node?.localName) || node?.isContentEditable === true || inReader(node);
}

function clear() {
  input.value = "";
  walk = null;
  input.focus();
}

document.getElementById("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  search();
});
input.addEventListener("keydown", (event) => {
  // Enter searches and Shift+Enter starts a line. An IME's Enter confirms its text.
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  search();
});
document.getElementById("search-clear").addEventListener("click", clear);
// As on Yomitan's search page, Escape focuses the box and selects its text
// (its focusSearchBox hotkey), a character typed elsewhere goes into it, and
// Ctrl+U clears it, unless focus is in the popup. The reader has already
// taken any key it handles, such as an Escape that closes a child popup. The
// search page's keybinds come first.
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.isComposing) return;
  if (runSearchKeybinds(event)) {
    event.preventDefault();
    return;
  }
  if (event.key === "Escape") {
    input.focus();
    input.select();
    return;
  }
  if (event.ctrlKey && event.key === "u" && !inReader(document.activeElement)) {
    event.preventDefault();
    clear();
    return;
  }
  const typed = (event.key.length === 1 && event.key !== " ") || event.key === "Backspace";
  const modified = event.ctrlKey || event.metaKey || event.altKey;
  if (typed && (!modified || (event.ctrlKey && event.key === "Backspace")) && !typingTarget(document.activeElement)) {
    input.focus({ preventScroll: true });
  }
});

// What search.html's Clipboard monitor (#639) reads: text with Japanese in it,
// copied in any tab or program, goes into the box and is searched, as a paste
// is. A Note being written or saved in the result holds it off, and so does a
// user script's pause: the text is not searched.
let clipboardPaused = false;
bridge.onClipboard((text) => {
  if (clipboardPaused || !reader.isLookupWorthy(text) || reader.holdsNote()) return;
  input.value = text;
  search("clipboard");
});
// Text copied or cut on this page is not searched, as in Yomitan's _onCopy:
// once it has reached the clipboard, the monitor starts over from it.
for (const type of ["copy", "cut"]) window.addEventListener(type, () => { bridge.notify("copied"); });

// The same keys, pressed in search.html's header, where the Clipboard monitor
// switch is: Escape, and Ctrl+U as "u".
bridge.onKey((key) => {
  if (key === "u") clear();
  if (key !== "Escape") return;
  input.focus();
  input.select();
});

// Text pasted anywhere but a text field or the popup is searched at once.
window.addEventListener("paste", (event) => {
  if (event.composedPath().some(pasteTarget)) return;
  const text = event.clipboardData?.getData("text") ?? "";
  if (!text) return;
  event.preventDefault();
  input.value = text;
  search("paste");
});

// With profiles the box and the echoed query take the active profile's
// language, and a right-to-left language's direction from the text
// (docs/languages.md 8.5); the single-profile page keeps its markup.
let storedOptions;
let selection = null;
const JAPANESE_PLACEHOLDER = input.placeholder;

function applyLanguage() {
  if (!hasProfiles(storedOptions)) {
    if (!input.dataset.language) return;
    for (const node of [input, query]) {
      node.lang = "ja";
      node.removeAttribute("dir");
    }
    for (const node of [before, after]) node.lang = "ja";
    input.placeholder = JAPANESE_PLACEHOLDER;
    delete input.dataset.language;
    setDebugLogLanguages([]);
    return;
  }
  // This page's debug log redacts the profiles' languages too (8.5).
  setDebugLogLanguages(profiles(storedOptions).map(profile => profile.language));
  const language = profileDescriptor(storedOptions, activeProfileId(storedOptions, selection))?.language ?? "ja";
  const descriptor = globalThis.HDLanguages?.get?.(language);
  for (const node of [input, query]) {
    node.lang = descriptor?.bcp47 ?? language;
    if (descriptor?.direction === "rtl") node.dir = "auto";
    else node.removeAttribute("dir");
  }
  for (const node of [before, after]) node.lang = descriptor?.bcp47 ?? language;
  input.placeholder = JAPANESE_PLACEHOLDER.replace("Japanese", descriptor?.name ?? (language === "ja" ? "Japanese" : language));
  input.dataset.language = language;
}

// The page reads in the active profile, and so takes its palette, Templates
// and reading options, as the shell around it does (search-shell.js).
function pageOptions(stored) {
  return hasProfiles(stored) ? projectOptions(stored, activeProfileId(stored, selection)) : normaliseOptions(stored);
}

// Rubi's cursor rests only on Japanese letters while Japanese text only is on,
// in Japanese. Another language's text has none, so there it rests on every
// visible character (docs/languages.md 8.5).
function japaneseOnly() {
  const language = hasProfiles(storedOptions)
    ? profileDescriptor(storedOptions, activeProfileId(storedOptions, selection))?.language ?? "ja" : "ja";
  return options.onlyScanJapaneseText && language === "ja";
}

// A language read word by word looks a word up from its first character
// (docs/languages.md 8.3), so Rubi's cursor rests only there: the pack's word
// and word-internal characters, or null.
let wordRulesOf = null;
function wordRules() {
  const language = hasProfiles(storedOptions)
    ? profileDescriptor(storedOptions, activeProfileId(storedOptions, selection))?.language ?? "ja" : "ja";
  const text = language === "ja" ? null : globalThis.HDLanguages?.get?.(language)?.text;
  if (text?.scanStart !== "word") return null;
  if (wordRulesOf?.language !== language) {
    const pattern = source => {
      try {
        return source ? new RegExp(source, "u") : null;
      } catch {
        return null;
      }
    };
    const word = pattern(text.wordCharacters) ?? pattern(text.pattern);
    wordRulesOf = { language, rules: word === null ? null : { word, internal: pattern(text.wordInternal) } };
  }
  return wordRulesOf.rules;
}

// search.html's Anki Template switch lies over this header (#656). The copy
// here lists the same Templates, invisibly, so both documents lay it out alike;
// it is laid out before the page is shown.
const showTemplates = () => { renderTemplateChoices(templateChoices, options.anki); };

chrome.storage.onChanged.addListener((changes, area) => {
  const selected = changes[LANGUAGE_SELECTION_KEY];
  if (area !== "local" || !(changes.options || selected)) return;
  if (changes.options) storedOptions = changes.options.newValue;
  if (selected) selection = selected.newValue ?? null;
  applyLanguage();
  // Without profiles a language choice changes nothing else.
  if (!changes.options && !hasProfiles(storedOptions)) return;
  const wasOn = options.searchHistoryEnabled;
  options = pageOptions(storedOptions);
  applyPageTheme(document, options);
  describeKeys();
  showTemplates();
  adoptFeature();
  // Switched off, a visit ends on the searched line and a walk in the box on
  // its draft, which no key could reach now, and the spoken word goes.
  if (wasOn && !options.searchHistoryEnabled) {
    if (visit && current) {
      visit = null;
      show(current);
    }
    if (walk) input.value = walk.draft;
    walk = null;
    cursorWord.textContent = "";
  }
});

// The history for user scripts (docs/search-history.md): its lines, oldest
// first, as search.html keeps them, "line" for each line kept (here or on
// another search page) and "change" for every other change, a pause for the
// Clipboard monitor's text, and the searched text's lookup at a character.
class SearchHistory extends EventTarget {
  get enabled() { return options.searchHistoryEnabled; }
  get clipboardPaused() { return clipboardPaused; }
  set clipboardPaused(paused) { clipboardPaused = paused === true; }
  list({ before: older, after: newer, limit } = {}) { return historyRequest("list", { before: older, after: newer, limit }); }
  edit(id, text) { return historyRequest("edit", { id, text }); }
  remove(id) { return historyRequest("remove", { id }); }
  // Looks up the word at `offset` in the text node `node` and shows it in the
  // results; resolves to the length of the text it matched, 0 for none.
  lookUp(node, offset) {
    return reader && node?.nodeType === Node.TEXT_NODE && node.isConnected ? reader.search(node, offset) : Promise.resolve(0);
  }
}
const searchHistory = new SearchHistory();
globalThis.HDSearchHistory = Object.freeze(searchHistory);
bridge.onHistory((change) => {
  searchHistory.dispatchEvent(change.type === "add" ? new CustomEvent("line", { detail: change.line })
    : new CustomEvent("change", { detail: change }));
});


// Design → Custom JavaScript, the user script web pages run (custom-javascript.js),
// once the reader is ready, as a user script runs at document_idle after the
// content scripts. search.html hands it over only where the worker registered
// it, which Chrome's Allow User Scripts or Firefox's permission allows. The
// frame's sandbox allows eval for this alone; inline script stays blocked.
function runCustomJavaScript(code) {
  try {
    (0, eval)(code); // NOSONAR: the user's own Custom JavaScript, as their user script; see above.
  } catch (error) {
    console.error("hachidori: Custom JavaScript failed on the search page:", error);
  }
}

try {
  const stored = await chrome.storage.local.get(["options", LANGUAGE_SELECTION_KEY]);
  storedOptions ??= stored.options;
  selection ??= stored[LANGUAGE_SELECTION_KEY] ?? null;
  options = pageOptions(storedOptions);
  showTemplates();
  adoptFeature();
  const connection = await bridge.ready;
  applyPageTheme(document, options);
  applyLanguage();
  describeKeys();
  bridge.notify("shown");
  // The page opens ready to type into, as Yomitan's focuses its box. It is
  // hidden, and its box cannot take focus, until settings-theme.js has the
  // saved theme, which in search.html's frame waits for the bridge.
  input.focus();
  reader = await loadReaderScripts(document, chrome, "searchReader");
  reader.dock(document.getElementById("search-results"));
  // Reading → Search page → Look up words with a click (#656). While the
  // history's keys are on, a click on a character the cursor can rest on moves
  // the cursor there and looks the word up from it; any other click is the
  // reader's, as it always was.
  reader.lookUpOnClick(query, (node, offset) => {
    // A click on the cursor's own character is the reader's too, which looks
    // up (and counts) a word it already shows no second time.
    const at = node === query.firstChild ? stopAt(node.data, offset, japaneseOnly(), wordRules()) : null;
    if (!options.searchHistoryEnabled || !shown || at === null || at === shown.cursor) return false;
    clickMoved = true;
    shown.cursor = at;
    shown.match = null;
    navigation = createNavigation();
    void lookUp(shown);
    query.focus({ preventScroll: true });
    paintCursor();
    return true;
  });
  // A click that moved no cursor reads its word out if nothing has yet: a
  // press's focus left that to the click.
  query.addEventListener("click", () => {
    pressed = false;
    if (!clickMoved && cursorWord.textContent === "") sayCursorWord();
  });
  if (connection.customJavaScript) runCustomJavaScript(connection.customJavaScript);
  status.textContent = "Type or paste a word above, then press Enter.";
  submit.disabled = false;
  // The Clipboard monitor starts.
  bridge.notify("ready");
} catch (error) {
  status.textContent = `The search page could not start: ${describeErrorMessage(error)}`;
  recordUserError(window, "search-status", status.textContent, error);
}
