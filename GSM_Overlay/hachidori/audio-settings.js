// SPDX-License-Identifier: GPL-3.0-or-later
import { selectExtensionApi } from "./browser-api.js";
import { reorderSettingsRows } from "./settings-dom.js";
// A BCP 47 tag's primary language subtag, which speech.js matches voices by.
const primaryLanguage = tag => String(tag ?? "").split(/[-_]/u)[0].toLowerCase();
function labelControl(control, label) {
  if (control.getAttribute("aria-label") !== label) control.setAttribute("aria-label", label);
}

// Test plays 聞く in Japanese and the pack's sample entry in another
// language (docs/languages.md 13); `term` is null until that entry is read.
const JAPANESE_TEST = Object.freeze({ expression: "聞く", reading: "きく" });
function testLabel(term) {
  if (term === null) return "Test";
  return term.reading && term.reading !== term.expression ? `Test ${term.expression} / ${term.reading}` : `Test ${term.expression}`;
}

function setTesting(row, testing, term) {
  const text = testing ? "Stop" : "Test";
  if (row.test.textContent !== text) row.test.textContent = text;
  labelControl(row.test, `${testing ? "Stop Test" : testLabel(term)}: ${row.number.textContent.toLowerCase()}`);
}

// `readLanguage()` is the edited profile's `{ code, name, speech, warmup }`,
// or null: Japanese, as today.
export function createAudioSettingsController({ document, readSources, editSources, send, readLanguage = () => null }) {
  const window = document.defaultView;
  const extensionApi = selectExtensionApi(window);
  const list = document.getElementById("audio-source-list");
  const rows = new Map();
  const labels = window.HDReaderOptions.AUDIO_SOURCE_LABELS;
  let voices = [];
  let voiceVersion = 0;
  let active = null;
  const samples = new Map();

  const language = () => readLanguage() ?? null;
  const japanese = () => language() === null || language().code === "ja";
  const speechLanguage = () => primaryLanguage(language()?.speech ?? "ja-JP");
  // The language whose voices are listed first.
  let voicesFor = speechLanguage();

  // The pack's sample entry, from its vendored language.json; its warm-up
  // word, which the registry holds, when that cannot be read.
  function sampleEntry(current) {
    if (!samples.has(current.code)) {
      const fallback = { expression: current.warmup, reading: current.warmup };
      samples.set(current.code, { term: null, loading: window.fetch(new URL(`vendor/languages/${current.code}/language.json`,
        document.baseURI)).then(response => (response.ok ? response.json() : null)).then(pack => {
        const entry = pack?.host?.sample?.entry;
        return typeof entry?.expression === "string" && entry.expression && typeof entry.reading === "string"
          ? { expression: entry.expression, reading: entry.reading } : fallback;
      }, () => fallback).then(term => {
        samples.get(current.code).term = term;
        render();
        return term;
      }) });
    }
    return samples.get(current.code);
  }

  // The word Test plays now, or null while a pack's entry is being read.
  function testTerm() {
    return japanese() ? JAPANESE_TEST : sampleEntry(language()).term;
  }

  function stop() {
    if (!active) return;
    const previous = active;
    active = null;
    previous.row.status.textContent = "";
    setTesting(previous.row, false, testTerm());
    void send("hd_audio_stop", { playRequestId: previous.requestId }).catch(() => {});
  }

  function change(id, patch) {
    editSources(readSources().map(source => source.id === id ? { ...source, ...patch } : source));
    render();
  }

  async function testSource(id, row) {
    if (active?.id === id) { stop(); return; }
    stop();
    const source = readSources().find(source => source.id === id);
    const operation = { id, row, source: JSON.stringify(source), requestId: window.crypto.randomUUID() };
    row.testedSource = operation.source;
    active = operation;
    row.status.textContent = "";
    setTesting(row, true, testTerm());
    try {
      const term = japanese() ? null : await sampleEntry(language()).loading;
      if (active !== operation) return;
      const reply = await send("hd_audio_test", { source, requestId: operation.requestId, ...(term ? { term } : {}) });
      if (active !== operation) return;
      if (!reply.ok) throw new Error(reply.error);
      row.status.textContent = reply.status === "no-result" ? "No pronunciation was returned." : "";
    } catch (error) {
      if (active === operation) row.status.textContent = `Could not play: ${error.message}`;
    } finally {
      if (active === operation) { active = null; setTesting(row, false, testTerm()); }
    }
  }

  function move(id, offset) {
    const sources = [...readSources()];
    const index = sources.findIndex(source => source.id === id);
    [sources[index], sources[index + offset]] = [sources[index + offset], sources[index]];
    editSources(sources);
    render();
  }

  function createRow(source) {
    const element = document.createElement("li");
    element.className = "audio-source-row";
    // Only static markup. Provider names and user text are assigned as text or
    // control values below, never interpolated into HTML.
    element.innerHTML = `<div class="audio-source-heading">
      <label class="audio-source-enabled"><input class="audio-enabled" type="checkbox"><span class="audio-number"></span></label>
      <div class="audio-source-actions"><button type="button" class="ghost audio-up"><span class="hd-icon" data-icon="arrow-up" aria-hidden="true"></span></button><button type="button" class="ghost audio-down"><span class="hd-icon" data-icon="arrow-down" aria-hidden="true"></span></button>
      <button type="button" class="ghost audio-remove">Remove</button></div></div>
      <label class="field"><span class="field-label">Source type</span><select class="audio-type"></select></label>
      <label class="field audio-url-field"><span class="field-label">URL template</span><input class="audio-url" type="text" spellcheck="false" autocomplete="off"></label>
      <label class="field audio-voice-field"><span class="field-label">Voice</span><select class="audio-voice"></select></label>
      <div class="audio-test-line"><button type="button" class="ghost audio-test">Test</button><output class="audio-test-status" aria-live="polite"></output></div>`;
    const row = { element, voiceVersion: -1 };
    for (const name of ["enabled", "number", "type", "url", "voice", "up", "down", "remove", "test"]) {
      row[name] = element.querySelector(`.audio-${name}`);
    }
    row.status = element.querySelector(".audio-test-status");
    row.urlField = element.querySelector(".audio-url-field");
    row.voiceField = element.querySelector(".audio-voice-field");
    for (const type of window.HDReaderOptions.AUDIO_SOURCE_TYPES) row.type.add(new window.Option(labels[type], type));
    for (const name of ["enabled", "type", "url", "voice"]) row[name].id = `opt-audio-${name}-${source.id}`;
    row.enabled.addEventListener("change", () => change(source.id, { enabled: row.enabled.checked }));
    row.type.addEventListener("change", () => change(source.id, { type: row.type.value, url: "", voice: "" }));
    row.url.addEventListener("input", () => change(source.id, { url: row.url.value }));
    row.voice.addEventListener("change", () => change(source.id, { voice: row.voice.value }));
    row.up.addEventListener("click", () => move(source.id, -1));
    row.down.addEventListener("click", () => move(source.id, 1));
    row.remove.addEventListener("click", () => {
      editSources(readSources().filter(item => item.id !== source.id));
      render();
      document.getElementById("audio-source-add").focus();
    });
    row.test.addEventListener("click", () => { void testSource(source.id, row); });
    element.addEventListener("focusout", () => { window.queueMicrotask(render); });
    return row;
  }

  function renderVoice(row, source) {
    if (row.voice === document.activeElement) return;
    if (row.voiceVersion !== voiceVersion || row.voice.value !== source.voice) {
      row.voice.replaceChildren(new window.Option(`Automatic ${language()?.name ?? "Japanese"}`, ""));
      for (const voice of voices) row.voice.add(new window.Option(
        `${voice.name} (${voice.lang})${voice.localService ? "" : " — online"}`, voice.voiceURI));
      if (source.voice && !voices.some(voice => voice.voiceURI === source.voice)) {
        row.voice.add(new window.Option(`${source.voice} — unavailable`, source.voice));
      }
      row.voice.value = source.voice;
      row.voiceVersion = voiceVersion;
    }
  }

  function render() {
    // Another edited profile's language lists its own voices first.
    if (voicesFor !== speechLanguage()) sortVoices();
    const term = testTerm();
    const sources = readSources();
    if (active && active.source !== JSON.stringify(sources.find(source => source.id === active.id))) stop();
    const ids = new Set(sources.map(source => source.id));
    for (const [id, row] of rows) {
      if (!ids.has(id)) { row.element.remove(); rows.delete(id); }
    }
    const ordered = sources.map((source, index) => {
      if (!rows.has(source.id)) rows.set(source.id, createRow(source));
      const row = rows.get(source.id);
      if (row.testedSource && row.testedSource !== JSON.stringify(source)) {
        row.status.textContent = "";
        row.testedSource = null;
      }
      if (row.enabled.checked !== source.enabled) row.enabled.checked = source.enabled;
      const number = `Source ${index + 1}`;
      if (row.number.textContent !== number) row.number.textContent = number;
      for (const key of ["type", "url"]) {
        if (row[key] !== document.activeElement && row[key].value !== source[key]) row[key].value = source[key];
      }
      const speech = source.type.startsWith("text-to-speech");
      if (row.urlField.hidden !== speech) row.urlField.hidden = speech;
      if (row.voiceField.hidden === speech) row.voiceField.hidden = !speech;
      if (speech) renderVoice(row, source);
      if (row.up.disabled !== (index === 0)) row.up.disabled = index === 0;
      if (row.down.disabled !== (index === sources.length - 1)) row.down.disabled = index === sources.length - 1;
      for (const [key, label] of [["up", "Move up"], ["down", "Move down"], ["remove", "Remove"]]) {
        labelControl(row[key], `${label}: source ${index + 1}`);
      }
      setTesting(row, active?.id === source.id, term);
      return row.element;
    });
    reorderSettingsRows(list, ordered);
    const empty = document.getElementById("audio-source-empty");
    if (empty.hidden !== (sources.length > 0)) empty.hidden = sources.length > 0;
  }

  function sortVoices() {
    voicesFor = speechLanguage();
    const own = voice => Number(primaryLanguage(voice.lang) === voicesFor);
    voices = [...voices].sort((a, b) => own(b) - own(a));
    voiceVersion += 1;
  }

  // A voiceschanged list that arrives first is newer than the initial reply.
  let adoptions = 0;
  function adoptVoices(value) {
    adoptions += 1;
    voices = [...value];
    sortVoices();
    render();
  }
  const voiceListener = message => {
    if (message?.target === "hachidori-audio-ui" && message.type === "hd_audio_voices_changed") adoptVoices(message.voices);
  };
  extensionApi.runtime.onMessage.addListener(voiceListener);
  void send("hd_audio_voices").then(reply => {
    if (reply.ok && adoptions === 0) adoptVoices(reply.voices);
  }).catch(() => {}); // Test reports any current playback/voice failure itself.
  document.getElementById("audio-source-add").addEventListener("click", () => {
    const source = { id: window.crypto.randomUUID(), type: "custom", enabled: true, url: "", voice: "" };
    editSources([...readSources(), source]);
    render();
    rows.get(source.id).url.focus();
  });
  window.addEventListener("pagehide", () => { stop(); extensionApi.runtime.onMessage.removeListener(voiceListener); }, { once: true });
  return { render, stop };
}
