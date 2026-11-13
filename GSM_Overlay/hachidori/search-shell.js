// The search page (#610) as the extension page that holds it (#644). Chrome
// and Firefox run no user script in an extension page, so the search box, its
// results and the reader live in a sandboxed frame, search-frame.html, where
// Advanced → User scripts run as they do on a web page. The frame has no
// extension APIs: this page answers for it over one MessagePort, which
// search-bridge.js offers it. The user's script shares the frame's
// document and globals with the reader, so whatever this page serves the
// reader, the script can use too, where on a web page it has no extension
// messaging at all. The frame therefore gets what the reader needs and no
// more: the requests a content script's reader sends, the stored keys it
// reads and the events sent to it, and the search page's own line history
// (search-history.js), which this page opens for it. This page keeps the header, whose
// Clipboard monitor switch asks for a permission: Firefox grants one only to
// the document that handles the click. Its Anki Template switch writes the
// options, which the frame may not.
// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionApi as chrome } from "./browser-api.js";
import { SCRIPT_ID } from "./custom-javascript.js";
import { captureDebugLog, debugLogRecord, openDebugLogStore } from "./debug-log.js";
import { describeErrorMessage } from "./error-text.js";
import { languageName } from "./language-names.js";
import "./reader-options.js";
import { CLIPBOARD_TARGET, createClipboardMonitor } from "./search-clipboard.js";
import { openSearchHistory } from "./search-history.js";
import { renderTemplateChoices, withBuiltinTemplate } from "./search-templates.js";
import { applyPageTheme } from "./settings-dom.js";

// The requests the reader sends, by target. test/search-bridge.test.mjs keeps
// these equal to the ones the content scripts name.
export const READER_REQUESTS = new Map(Object.entries({
  "hoshidicts-offscreen": ["hd_lookup", "hd_lookup_dictionary", "hd_kanji", "hd_media", "hd_styles", "hd_segment",
    "hd_custom_append"],
  "hoshidicts-worker": ["hd_options_write", "hd_open_external", "hd_lookup_stats_read", "hd_lookup_stats_record",
    "hd_word_status_override", "hd_language_selection_write", "hd_open_settings"],
  "hachidori-anki": ["hd_anki_status", "hd_anki_view", "hd_anki_preflight", "hd_anki_preflight_batch", "hd_anki_submit",
    "hd_anki_browse", "hd_anki_screenshot", "hd_anki_screenshot_discard", "hd_anki_maturity", "hd_anki_word_status"],
  "hachidori-audio": ["hd_audio_play", "hd_audio_candidates", "hd_audio_stop"],
  "hachidori-page-zoom": ["hd_page_zoom"],
}).map(([target, types]) => [target, new Set(types)]));
// The targets of the browser shortcuts, pronunciation progress and word-status
// events the reader listens for.
export const READER_EVENTS = new Set(["hachidori-reader", "hachidori-audio-content", "hachidori-anki-content"]);
// The stored keys it reads: options, dictionaries, lookup counts and their
// rows, the words marked known or ignored, and this browser's active
// language (docs/languages.md 4.4).
export const readerKey = key => ["options", "dictionaryState", "lookupStats", "wordStatusOverrides",
  "languageSelection"].includes(key) || key.startsWith("lookupStats:");

// What storage.local.get answers for `keys` (a key, a list or an object of
// defaults), restricted to the reader's keys: Chrome's callers may ask in
// any of those shapes.
async function readerGet(api, keys) {
  let defaults = keys ?? {};
  if (typeof keys === "string") defaults = { [keys]: undefined };
  else if (Array.isArray(keys)) defaults = Object.fromEntries(keys.map(key => [key, undefined]));
  const wanted = Object.keys(defaults).filter(readerKey);
  const stored = await api.storage.local.get(wanted);
  return Object.fromEntries(wanted.map(key => [key, readerValue(key, Object.hasOwn(stored, key) ? stored[key] : defaults[key])])
    .filter(([, value]) => value !== undefined));
}

// The reader never uses the AnkiConnect key.
const readerValue = (key, value) => (key === "options" && value?.anki
  ? { ...value, anki: { ...value.anki, apiKey: "" } } : value);

// The one option write the reader makes: a Toggle option keybind's boolean.
function readerOptionsWrite(options) {
  const entries = Object.entries(options ?? {});
  return entries.length === 1 && typeof entries[0][1] === "boolean"
    && globalThis.HDReaderOptions.KEYBIND_TOGGLE_OPTIONS.includes(entries[0][0]);
}

// The language switch the reader makes: the Switch to the next language
// keybind's choice of active profile, never Switch language automatically.
function readerLanguageSelectionWrite({ baseRevision, activeProfileId, ...rest }) {
  return Number.isSafeInteger(baseRevision) && typeof activeProfileId === "string" && Object.keys(rest).length === 0;
}

// The reader opens only Settings → Anki (a Template that names no deck).
const readerOpenSettings = ({ section, profileId, ...rest }) =>
  section === "anki" && (profileId === undefined || typeof profileId === "string") && Object.keys(rest).length === 0;

function readerRequest({ target, type, options, requestId: _requestId, ...fields } = {}) {
  if (!READER_REQUESTS.get(target)?.has(type)) return false;
  if (type === "hd_options_write") return readerOptionsWrite(options);
  if (type === "hd_language_selection_write") return readerLanguageSelectionWrite(fields);
  if (type === "hd_open_settings") return readerOpenSettings(fields);
  return true;
}

// The history requests the frame may make (docs/search-history.md), each
// checked here, as the frame shares its globals with the user's script: add a
// line, while Advanced → Search history is on and up to its limit;
// list, edit or remove lines. `settings()` resolves to the options, `page()`
// to the window the page is in.
export function searchHistoryRequests(history, { settings, page }) {
  return new Map(Object.entries({
    async add({ text, source }) {
      const { searchHistoryEnabled, searchHistoryLimit } = await settings();
      if (!searchHistoryEnabled) return null;
      return (await history.add({ text, source, page: await page() }, { limit: searchHistoryLimit })).line;
    },
    list: ({ before, after, limit }) => history.list({ before, after, limit }),
    edit: ({ id, text }) => history.edit(id, text),
    remove: ({ id }) => history.remove(id),
  }));
}

// Answers the frame on `port` until the returned function closes it. `page`
// hears when the frame shows its themed page, when its reader is ready and
// when text is copied there. `history` ({ requests, onChange }) answers the
// frame's history requests and tells it of every change.
export function serveSearchFrame(api, port, store, page, history = null) {
  // The ring's keys of the records this frame wrote, the only ones it may update.
  const written = new Set();
  const answer = (id, request) => {
    Promise.resolve().then(request).then((value) => { port.postMessage({ kind: "reply", id, value }); },
      (error) => { port.postMessage({ kind: "reply", id, error: describeErrorMessage(error) }); });
  };
  port.onmessage = ({ data }) => {
    if (data?.kind === "send") {
      answer(data.id, () => {
        if (!readerRequest(data.message)) {
          throw new Error(`The search page cannot send ${data.message?.type} to ${data.message?.target}.`);
        }
        return api.runtime.sendMessage(data.message);
      });
    } else if (data?.kind === "get") {
      answer(data.id, () => readerGet(api, data.keys));
    } else if (data?.kind === "log") {
      answer(data.id, async () => {
        const keys = await store.write(data.ops.map(({ key, record }) => ({ key: written.has(key) ? key : undefined,
          record: debugLogRecord({ ...record, context: "search" }) })));
        for (const key of keys) written.add(key);
        return keys;
      });
    } else if (data?.kind === "history") {
      answer(data.id, () => {
        const request = history?.requests.get(data.op);
        if (!request) throw new Error(`The search page cannot ask its history to ${data.op}.`);
        return request(data.args ?? {});
      });
    } else if (["shown", "ready", "copied"].includes(data?.kind)) {
      page[data.kind]();
    }
  };
  const unheard = history?.onChange((change) => { port.postMessage({ kind: "history", change }); });
  const onMessage = (message, sender) => {
    if (READER_EVENTS.has(message?.target)) port.postMessage({ kind: "message", message, sender: { id: sender.id } });
    return false;
  };
  const onChanged = (changes, area) => {
    const read = Object.fromEntries(Object.entries(changes).filter(([key]) => readerKey(key))
      .map(([key, { oldValue, newValue }]) => [key, { oldValue: readerValue(key, oldValue), newValue: readerValue(key, newValue) }]));
    if (area === "local" && Object.keys(read).length > 0) port.postMessage({ kind: "changed", changes: read, area });
  };
  api.runtime.onMessage.addListener(onMessage);
  api.storage.onChanged.addListener(onChanged);
  return () => {
    api.runtime.onMessage.removeListener(onMessage);
    api.storage.onChanged.removeListener(onChanged);
    unheard?.();
    port.close();
  };
}

// Connects `frame` once, through the port its document offers this page as it
// parses (search-bridge.js). A sandboxed frame's origin is opaque, so the offer
// is known by its window; Firefox before 154 does not sandbox it, and there
// it has this page's origin. Only the frame's own code can navigate it,
// perhaps to another site, so a later document is never connected: the page
// starts again instead, through `reload`.
export function connectSearchFrame({ window, frame, serve, connection, reload }) {
  let close = null;
  window.addEventListener("message", (event) => {
    if (close || event.source !== frame.contentWindow || !["null", window.location.origin].includes(event.origin)
        || event.data?.type !== "hachidori-search-bridge" || !event.ports?.[0]) return;
    const [port] = event.ports;
    close = serve(port);
    // Focused first, so the frame can focus its box once it is connected.
    frame.focus();
    port.postMessage({ kind: "connect", ...connection(event.origin === "null") });
  });
  let loads = 0;
  frame.addEventListener("load", () => {
    loads += 1;
    if (loads === 1) return;
    close?.();
    reload();
  });
}

// The user scripts' JavaScript, in the order web pages run it: once the worker
// has registered it (custom-javascript.js), which Chrome's Allow User Scripts
// or Firefox's userScripts permission allows. The bridge is a file, not code.
async function userScripts(api) {
  try {
    const [script] = await api.userScripts.getScripts({ ids: [SCRIPT_ID] });
    return script?.js?.flatMap(source => (typeof source.code === "string" ? [source.code] : [])) ?? [];
  } catch {
    return [];
  }
}

// Yomitan's search page clipboard monitor (#639; yomidevs/yomitan@ac1d839
// ext/js/display/search-display-controller.js): text with Japanese in it (with
// profiles, text in the language used for lookups; docs/languages.md 8.5),
// copied in any tab or program, is searched in the frame, as a paste is, up
// to Yomitan's 1,000 characters, which is all the offscreen document sends.
// Only that text reaches the frame, which the user's script shares: other
// text, which the reader would not search, stays here (isLookupWorthy in
// content.js). The switch is the browser's clipboardRead permission, which
// turning it on asks for and turning it off gives back. The monitor starts
// once the frame's reader is ready.
const CLIPBOARD_PERMISSION = { permissions: ["clipboardRead"] };

// The language used for lookups (docs/languages.md 8.1, rule 4), or null in
// the single-profile shape.
function activeLanguage(stored, selection) {
  const layer = globalThis.HDReaderOptions;
  return layer.hasProfiles(stored)
    ? layer.profileDescriptor(stored, layer.activeProfileId(stored, selection))?.language ?? "ja" : null;
}

// Text in that language, by its pack's text.pattern (8.2), or with Japanese the
// reader's Japanese character set, which content-scan.js publishes. Either is
// loaded once the monitor reads something, rather than as the page starts.
export async function lookupWorthy(text, language) {
  if (language !== null && language !== "ja") {
    await import("./vendor/languages/registry.js");
    const source = globalThis.HDLanguages?.get?.(language)?.text?.pattern;
    return typeof source === "string" && new RegExp(source, "u").test(text);
  }
  await import("./content-scan.js");
  return globalThis.HDContent.JAPANESE_CHARACTER_PATTERN.test(text);
}

function clipboardMonitor(clipboardSwitch, search, language) {
  let ready = false;
  const monitor = createClipboardMonitor({
    async read() {
      const reply = await chrome.runtime.sendMessage({ target: CLIPBOARD_TARGET, type: "hd_clipboard_read" });
      return reply?.ok === true ? reply.text : null;
    },
    // Not once the switch is off, which it may be by the time the import ends.
    async change(text) {
      if (await lookupWorthy(text, language()) && monitor.running) search(text);
    },
  });
  async function show() {
    const on = await chrome.permissions.contains(CLIPBOARD_PERMISSION).catch(() => false);
    clipboardSwitch.checked = on;
    if (!on || !ready) monitor.stop();
    else if (!monitor.running) monitor.start();
  }
  clipboardSwitch.addEventListener("change", () => {
    if (!clipboardSwitch.checked) monitor.stop();
    // The browser asks only for a request made while it handles the click.
    const asked = clipboardSwitch.checked ? chrome.permissions.request(CLIPBOARD_PERMISSION)
      : chrome.permissions.remove(CLIPBOARD_PERMISSION);
    void asked.catch(() => false).then(show);
  });
  chrome.permissions.onAdded.addListener(() => { void show(); });
  chrome.permissions.onRemoved.addListener(() => { void show(); });
  // Text copied or cut on the page is not searched, as in Yomitan's _onCopy:
  // once it has reached the clipboard, the monitor starts over from it.
  const copied = () => {
    if (!monitor.running) return;
    monitor.stop();
    setTimeout(() => { void show(); }, 0);
  };
  for (const type of ["copy", "cut"]) window.addEventListener(type, copied);
  // The switch shows its state while the reader loads.
  void show();
  return {
    // The switch appears with the frame's header, as it did when the header held it.
    shown() { clipboardSwitch.closest("[hidden]")?.removeAttribute("hidden"); },
    ready() {
      ready = true;
      clipboardSwitch.disabled = false;
      void show();
    },
    copied,
  };
}

// The Anki Template switch (#656): the Template the built-in Anki button
// uses, which is the first, as Settings → Anki → Set built-in makes it. The
// frame may write only the reader's own option, so this page writes the
// choice, with the stored record's revision, and again if another page wrote
// in between. While one choice is saved, only the last one made meanwhile is
// saved after it, and the switch shows it. A choice made with the mouse or a
// tap hands focus back to the frame, as a click on the Clipboard monitor
// switch does; the arrow keys change the choice and keep focus.
const WORKER_TARGET = "hoshidicts-worker";

// The Templates the switch lists and the fields its write names: once the
// records have profiles, the active profile's, as the search page reads in
// the active profile (docs/languages.md 5.2, 8.1, 12); otherwise today's.
export function activeTemplates(stored, selection) {
  const layer = globalThis.HDReaderOptions;
  if (!layer.hasProfiles(stored)) return { anki: layer.normaliseOptions(stored).anki, fields: {} };
  const profileId = layer.activeProfileId(stored, selection);
  return { anki: layer.projectOptions(stored, profileId).anki, fields: { profileId } };
}

// Moves Template `id` first, and resolves whether that wrote the options.
async function chooseTemplate(api, id) {
  const { options: stored, languageSelection } = await api.storage.local.get(["options", "languageSelection"]);
  const { anki: current, fields } = activeTemplates(stored, languageSelection);
  const next = current.templates[0].id === id ? null : withBuiltinTemplate(current, id);
  if (next === null) return false;
  const reply = await api.runtime.sendMessage({ target: WORKER_TARGET, type: "hd_options_write",
    baseRevision: Number.isInteger(stored?.revision) && stored.revision >= 0 ? stored.revision : 0,
    options: { anki: next }, ...fields });
  if (reply?.conflict === true) return chooseTemplate(api, id);
  if (!reply?.ok) throw new Error(reply?.error || "Hachidori did not reply.");
  return true;
}

// The switch `select` in this page's header, handing focus back to `frame`;
// `show(anki)` lists the stored Templates.
export function templateSwitch(select, frame, api = chrome) {
  let anki = null;
  let wanted = null;
  let saving = Promise.resolve();
  const show = (next = anki) => {
    anki = next;
    renderTemplateChoices(select, anki, wanted ?? anki.templates[0].id);
  };
  // Saves the last choice, unless a save before it already has. A write
  // shows itself through its storage change, unless that has come already.
  async function saveWanted() {
    const id = wanted;
    if (id === null) return;
    let wrote = false;
    try {
      wrote = await chooseTemplate(api, id);
    } catch (error) {
      console.error("hachidori: could not choose the Anki Template:", describeErrorMessage(error));
    }
    if (wanted !== id) return;
    wanted = null;
    if (!wrote || anki.templates[0].id === id) show();
  }
  let handBack = false;
  select.addEventListener("pointerdown", () => { handBack = select.ownerDocument.activeElement !== select; });
  select.addEventListener("keydown", () => { handBack = false; });
  select.addEventListener("change", () => {
    wanted = select.value;
    saving = saving.then(saveWanted);
    if (!handBack) return;
    handBack = false;
    setTimeout(() => { frame.focus(); }, 0);
  });
  return { show };
}

// The records start() adopts once its first read is in: for each, the newest,
// so a change that came meanwhile is not undone (main adopts its newest
// options there too).
export function newestRecords(first, changed, current) {
  return [changed.options ? current.options : first.options,
    changed.languageSelection ? current.languageSelection : first.languageSelection];
}

async function start() {
  const store = openDebugLogStore(window.indexedDB);
  captureDebugLog(window, { context: "search", store });
  const { normaliseOptions } = globalThis.HDReaderOptions;
  const frame = document.createElement("iframe");
  const templates = templateSwitch(document.getElementById("search-template"), frame);
  // The options, read once and followed: the theme, the Anki Templates, and
  // what the history keeps. With profiles the page reads in the active one,
  // so it takes that profile's palette and Templates (docs/languages.md 8.1).
  let storedOptions, languageSelection;
  // The records a change has brought since the first read, whose newest
  // values the end of start() adopts, as main adopts its newest options there.
  const changed = { options: false, languageSelection: false };
  const nameClipboardLanguage = () => {
    const language = activeLanguage(storedOptions, languageSelection);
    const label = document.getElementById("search-clipboard").closest("label");
    const title = `Search ${language === null ? "Japanese" : languageName(language)} text as soon as you copy it, in any tab or program`;
    if (label.title !== title) label.title = title;
  };
  const initial = chrome.storage.local.get(["options", "languageSelection"]);
  let options = initial.then(({ options: stored }) => normaliseOptions(stored));
  const adoptOptions = (stored, selection = languageSelection) => {
    storedOptions = stored;
    languageSelection = selection;
    const layer = globalThis.HDReaderOptions;
    applyPageTheme(document, layer.hasProfiles(stored)
      ? layer.projectOptions(stored, layer.activeProfileId(stored, selection)) : normaliseOptions(stored));
    templates.show(activeTemplates(stored, selection).anki);
    // The Clipboard monitor's tooltip names the language it searches; another
    // language's name comes from the registry, loaded for it.
    const language = activeLanguage(stored, selection);
    if (language === null || language === "ja") nameClipboardLanguage();
    else void import("./vendor/languages/registry.js").then(nameClipboardLanguage, nameClipboardLanguage);
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(changes.options || changes.languageSelection)) return;
    if (changes.options) {
      options = Promise.resolve(normaliseOptions(changes.options.newValue));
      changed.options = true;
    }
    if (changes.languageSelection) changed.languageSelection = true;
    const selection = changes.languageSelection ? changes.languageSelection.newValue : languageSelection;
    // A language choice made before any options were seen waits for them.
    if (!changed.options && storedOptions === undefined) {
      languageSelection = selection;
      return;
    }
    adoptOptions(changes.options ? changes.options.newValue : storedOptions, selection);
  });
  const lines = openSearchHistory({ indexedDB: window.indexedDB });
  const history = { onChange: lines.onChange, requests: searchHistoryRequests(lines, { settings: () => options,
    page: async () => ((await chrome.windows.getCurrent()).type === "popup" ? "popup" : "tab") }) };
  const scripts = await userScripts(chrome);
  frame.className = "search-frame";
  frame.title = "Hachidori Search";
  let port = null;
  const clipboardSwitch = document.getElementById("search-clipboard");
  const page = clipboardMonitor(clipboardSwitch, (text) => { port?.postMessage({ kind: "clipboard", text }); },
    () => activeLanguage(storedOptions, languageSelection));
  connectSearchFrame({ window, frame,
    serve: (offered) => { port = offered; return serveSearchFrame(chrome, offered, store, page, history); },
    connection: sandboxed => ({ id: chrome.runtime.id, manifest: chrome.runtime.getManifest(),
      userScripts: sandboxed ? scripts : [] }),
    reload: () => location.reload() });
  frame.src = "search-frame.html";
  document.body.append(frame);
  // The shortcuts bring the page forward with focus in this document, and a
  // click on the header leaves it there: the box takes it, unless the switch has.
  window.addEventListener("focus", () => {
    setTimeout(() => { if (document.activeElement === document.body) frame.focus(); }, 0);
  });
  // A mouse or touch click on the switch then hands focus back to the frame,
  // where the reader's keybinds and activation key work, as they did beside
  // the switch when it shared the page's document. It waits for the click: a
  // tap focuses the switch after its pointerup. A switch that already has
  // focus as the pointer goes down keeps it, and so does Space, whose click
  // has no pointerType: Chrome sends a screen reader's or voice control's
  // click as pointer events, but only after focusing the switch.
  const clipboardLabel = clipboardSwitch.closest("label");
  let handBack = false;
  clipboardLabel.addEventListener("pointerdown", () => { handBack = document.activeElement !== clipboardSwitch; });
  clipboardLabel.addEventListener("click", (event) => {
    if (!handBack || !event.pointerType) return;
    handBack = false;
    setTimeout(() => { frame.focus(); }, 0);
  });
  // The page's own keys work from the switch too, as they did when it shared
  // the page's document (search.js): Escape selects the box's text and Ctrl+U
  // clears it, rather than showing this page's source.
  window.addEventListener("keydown", (event) => {
    const clear = event.ctrlKey && event.key === "u";
    if (event.isComposing || (event.key !== "Escape" && !clear)) return;
    if (clear) event.preventDefault();
    frame.focus();
    port?.postMessage({ kind: "key", key: event.key });
  });
  adoptOptions(...newestRecords(await initial, changed, { options: storedOptions, languageSelection }));
}

if (globalThis.document) await start();
