// SPDX-License-Identifier: GPL-3.0-or-later
import { audioSourceUrl, parseAudioSourceList } from "./audio-sources.js";
import { LOCAL_AUDIO_SOURCE_URL, createLocalAudioSource, findLocalAudioSource } from "./local-audio-source.js";

const UNAVAILABLE = "No compatible local audio service found. Open Anki with Local Audio Server enabled and retry. For a custom port, add its URL as a Yomitan JSON source.";

export function createLocalAudioSetup({ document, readSources, editSources, isLinked = () => false, detect = detectLocalAudioSource }) {
  const check = document.getElementById("anki-audio-check");
  const add = document.getElementById("anki-audio-add");
  const status = document.getElementById("anki-audio-status");
  const pill = document.getElementById("anki-audio-pill");
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
    // Detected now, or already configured and enabled in the source list.
    const ready = Boolean(detected) || findLocalAudioSource(readSources())?.enabled === true;
    pill.textContent = ready ? "Ready" : "Not detected";
    pill.dataset.state = ready ? "connected" : "offline";
    check.textContent = active ? "Cancel audio check" : "Detect local audio";
    if (linked) status.textContent = "Detect local audio in Audio settings on your Hachidori host.";
    else if (existing) status.textContent = existing.enabled
      ? "Local audio is already one of your sources."
      : "Local audio is already one of your sources, but disabled. Enable it in the list when wanted.";
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
    // Send only the Custom JSON term lookup the saved source makes, as Yomitan
    // does. AnkiWeb's Local Audio Server 1.7.0 raises on a path without a term
    // (such as /v1/info), and Anki shows that as an add-on error.
    const options = { signal: controller.signal, credentials: "omit", redirect: "error", cache: "no-store" };
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
