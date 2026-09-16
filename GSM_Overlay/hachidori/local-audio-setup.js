// SPDX-License-Identifier: GPL-3.0-or-later
import { audioSourceUrl, parseAudioSourceList } from "./audio-sources.js";
import { LOCAL_AUDIO_SOURCE_URL, createLocalAudioSource } from "./local-audio-source.js";

const UNAVAILABLE = "No compatible local audio service found. Open Anki with Local Audio Server enabled and retry. For a custom port, add its URL in Audio settings.";

export function createLocalAudioSetup({ document, readSources, editSources, isLinked = () => false, detect = detectLocalAudioSource }) {
  const check = document.getElementById("anki-audio-check");
  const add = document.getElementById("anki-audio-add");
  const status = document.getElementById("anki-audio-status");
  let detected = null;
  let active = null;

  function render() {
    const linked = isLinked();
    if (linked) {
      const previous = active;
      active = null;
      detected = null;
      previous?.abort();
    }
    check.disabled = linked;
    const existing = readSources().find(source => source.type === "custom-json" && source.url === detected);
    add.hidden = !detected || Boolean(existing);
    check.textContent = active ? "Cancel audio check" : "Detect local audio";
    if (linked) status.textContent = "Detect local audio in Anki settings on your Hachidori host.";
    else if (existing) status.textContent = existing.enabled
      ? "Local audio is already in Audio settings."
      : "Local audio is already in Audio settings, but disabled. Enable it there when wanted.";
    else if (detected) status.textContent = `Found local audio: ${detected}`;
    else if (status.textContent.includes("Hachidori host")) status.textContent = "";
  }

  function cancel() {
    const previous = active;
    active = null;
    detected = null;
    previous?.abort();
    status.textContent = "Local audio check cancelled.";
    render();
  }

  check.addEventListener("click", async () => {
    if (isLinked()) { render(); return; }
    if (active) { cancel(); return; }
    const operation = new AbortController();
    active = operation;
    detected = null;
    status.textContent = "Checking the local audio service…";
    render();
    try {
      const result = await detect({ signal: operation.signal });
      if (active !== operation) return;
      detected = result;
      status.textContent = `Found local audio: ${detected}`;
    } catch (error) {
      if (active === operation) status.textContent = error.message;
    } finally {
      if (active === operation) { active = null; render(); }
    }
  });
  add.addEventListener("click", () => {
    if (isLinked()) { render(); return; }
    if (!detected || readSources().some(source => source.type === "custom-json" && source.url === detected)) return;
    editSources([...readSources(), createLocalAudioSource(document.defaultView.crypto.randomUUID(), detected)]);
    render();
  });
  document.defaultView.addEventListener("pagehide", cancel);
  return { render, cancel };
}

export async function detectLocalAudioSource({ fetch = globalThis.fetch, signal, timeoutMs = 2000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    const options = { signal: controller.signal, credentials: "omit", redirect: "error", cache: "no-store" };
    const response = await fetch("http://127.0.0.1:5050/v1/info", options);
    if (!response.ok) throw new Error(UNAVAILABLE);
    const info = await response.json();
    if (!info || typeof info.lookupMode !== "string" || !Array.isArray(info.sources)
        || !info.sources.every(source => typeof source === "string")
        || !(Object.hasOwn(info, "audioPack") || (info.status === "ok" && typeof info.serverVersion === "string"))) {
      throw new Error(UNAVAILABLE);
    }
    const sample = await fetch(audioSourceUrl(LOCAL_AUDIO_SOURCE_URL, { expression: "猫", reading: "ねこ" }), options);
    if (!sample.ok) throw new Error(UNAVAILABLE);
    parseAudioSourceList(await sample.json());
    if (controller.signal.aborted) throw new Error(UNAVAILABLE);
    return LOCAL_AUDIO_SOURCE_URL;
  } catch {
    throw new Error(signal?.aborted ? "Local audio check cancelled." : UNAVAILABLE);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
