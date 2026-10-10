// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionApi as chrome } from "./browser-api.js";
import "./reader-options.js";

const { activationLabel, normaliseOptions } = globalThis.HDReaderOptions;
const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
let options = null;
let linkedAddress = null;
let revision = -1;
let pending = false;
let requestCounter = 0;

function adoptOptions(stored) {
  const nextRevision = Number.isInteger(stored?.revision) && stored.revision >= 0 ? stored.revision : 0;
  // Settings and the startup page skip an equal revision; the toolbar adopts
  // it again and re-renders.
  if (nextRevision < revision) return;
  revision = nextRevision;
  options = normaliseOptions(stored);
  render();
}

function render() {
  elements["lookup-toggle"].disabled = pending || !options;
  if (!options) return;
  elements["lookup-toggle"].setAttribute("aria-checked", String(options.hoverEnabled));
  elements["lookup-state"].textContent = options.hoverEnabled ? "On" : "Off";
  const activeHint = options.lookupMode !== "hover"
    ? `Hold ${activationLabel(options.activationKey)} to scan` : "Hover over Japanese text to scan";
  elements["activation-hint"].textContent = options.hoverEnabled ? activeHint : "Lookups paused";
}

function showError(error) {
  elements["toolbar-error"].textContent = error instanceof Error ? error.message : String(error);
  elements["toolbar-error"].hidden = false;
}

async function send(type, fields = {}, target = "hoshidicts-worker") {
  const reply = await chrome.runtime.sendMessage({ target, type, requestId: `toolbar-${++requestCounter}`, ...fields });
  if (reply?.options) adoptOptions(reply.options);
  if (!reply?.ok) throw new Error(reply?.error || "Hachidori did not reply. Please try again.");
  return reply;
}

async function writeOptions(patch) {
  await send("hd_options_write", { baseRevision: revision, options: patch }, "hoshidicts-worker");
}

async function run(action) {
  if (pending) return;
  pending = true;
  elements["toolbar-error"].hidden = true;
  render();
  try { await action(); }
  catch (error) { showError(error); }
  finally { pending = false; render(); }
}

// A linked install shows where its lookups go and whether that host answers.
function adoptSharing(stored) {
  linkedAddress = typeof stored?.client?.address === "string" ? stored.client.address : null;
  elements["toolbar-sharing"].hidden = linkedAddress === null;
  if (linkedAddress === null) elements["toolbar-sharing"].textContent = "";
}

async function refreshSharing() {
  if (linkedAddress === null) return;
  try {
    const status = await send("hd_sharing_status", {}, "hachidori-sharing");
    elements["toolbar-sharing"].textContent = status.sharing?.client?.connected
      ? "Linked to another Hachidori" : "Linked Hachidori not reachable";
  } catch (error) { showError(error); }
}

elements["lookup-toggle"].addEventListener("click", () => {
  void run(() => writeOptions({ hoverEnabled: !options.hoverEnabled }));
});
elements["open-settings"].addEventListener("click", () => {
  void run(async () => { await chrome.runtime.openOptionsPage(); window.close(); });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.options) {
    adoptOptions(changes.options.newValue);
  }
  if (changes.sharing) {
    adoptSharing(changes.sharing.newValue);
    void refreshSharing();
  }
});

try {
  const stored = await chrome.storage.local.get(["options", "sharing"]);
  adoptOptions(stored.options);
  adoptSharing(stored.sharing);
  await refreshSharing();
} catch (error) { showError(error); }
const sharingPoll = setInterval(() => { void refreshSharing(); }, 1000);
window.addEventListener("pagehide", () => clearInterval(sharingPoll), { once: true });
