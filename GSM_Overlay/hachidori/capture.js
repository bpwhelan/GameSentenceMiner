// SPDX-License-Identifier: GPL-3.0-or-later
// This page controls the offscreen recorder; closing it leaves capture running.
const CAPTURE_TARGET = "hachidori-capture";
const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
let config;
let selectedTabId = null;
let requestCounter = 0;
let pendingControl = false;
let lastVideos = "";
let lastPageStatus = "";
const describe = error => error instanceof Error ? error.message || String(error) : String(error);
async function send(type, fields = {}) {
  const reply = await chrome.runtime.sendMessage({
    target: CAPTURE_TARGET,
    type,
    requestId: `capture-${++requestCounter}`,
    ...fields,
  });
  if (!reply?.ok) throw new Error(reply?.error || "The capture service did not reply.");
  return reply;
}

function render(status) {
  config = status.config;
  selectedTabId = status.linkedPage?.tabId ?? null;
  const recording = status.state === "recording";
  const linkedPage = Boolean(status.linkedPage);
  const videos = status.videos ?? [];
  const serializedVideos = JSON.stringify(videos);
  if (serializedVideos !== lastVideos) {
    elements["reading-video"].replaceChildren(...videos.map(video => new Option(video.label, video.id)));
    elements["video-row"].hidden = videos.length < 2;
    lastVideos = serializedVideos;
  }
  if (lastPageStatus !== status.pageStatus) {
    elements["page-status"].textContent = status.pageStatus || "";
    lastPageStatus = status.pageStatus;
  }
  const duration = (oldest, newest) => Number.isFinite(oldest) && Number.isFinite(newest)
    ? `${Math.max(0, (newest - oldest) / 1000).toFixed(1)} s` : "0.0 s";
  const stateLabels = { recording: "Recording", disabled: "Disabled", stopped: "Stopped" };
  elements["capture-state"].textContent = stateLabels[status.state];
  elements["capture-state"].classList.toggle("recording", recording);
  elements["capture-start"].disabled = pendingControl || status.starting || recording || !config?.enabled;
  elements["capture-stop"].disabled = !recording && !status.starting;
  elements["link-page"].disabled = !recording;
  elements["select-video"].disabled = !recording || !linkedPage
    || config?.timingMode === "recent" || !config?.page.nativeCues;
  elements["track-area"].disabled = !recording || !linkedPage
    || config?.timingMode === "recent" || !config?.page.domText;
  elements["clear-area"].disabled = !recording || !linkedPage;
  elements["media-source"].textContent = captureSourceLabel(status.mediaSource);
  elements["capture-error"].textContent = status.error || "";
  elements["texthooker-status"].textContent = status.texthookerStatus;
  elements["video-history"].textContent = config?.includeAnimation
    ? `${duration(status.history.frameOldestMs, status.history.frameNewestMs)} · ${status.history.frameCount} frames · ${Math.round(status.history.frameBytes / 1024)} KiB`
    : "Disabled";
  let audioHistory = "Disabled";
  if (status.mediaSource && !status.mediaSource.audioAvailable) audioHistory = "Source audio unavailable";
  else if (config?.includeCapturedAudio) {
    audioHistory = `${duration(status.history.audioOldestMs, status.history.audioNewestMs)} · ${status.history.audioSamples.toLocaleString()} samples`;
  }
  elements["audio-history"].textContent = audioHistory;
  elements["pin-status"].textContent = status.pinActive ? "Pinned" : "None";
  elements["linked-page"].textContent = status.linkedPage?.title || "No reading page is linked.";
}

function captureSourceLabel(source) {
  if (!source) return "No tab, window, or screen is being captured.";
  const kind = { browser: "Browser tab", window: "Application window", monitor: "Entire screen" }[source.displaySurface]
    || "Shared media";
  return !source.name || /^(?:web-contents-media-stream|screen|window):/u.test(source.name)
    ? kind : `${source.name} · ${kind}`;
}

async function refreshTabs() {
  try {
    const reply = await send("hd_capture_tabs");
    elements["reading-tab"].replaceChildren(...reply.tabs.map(tab => new Option(tab.title || tab.url, String(tab.id))));
    if (reply.tabs.some(tab => tab.id === selectedTabId)) elements["reading-tab"].value = String(selectedTabId);
  } catch (error) {
    elements["page-status"].textContent = describe(error);
  }
}

async function control(type) {
  pendingControl = true;
  elements["capture-start"].disabled = true;
  elements["capture-stop"].disabled = false;
  try { render(await send(type)); }
  catch (error) { elements["capture-error"].textContent = describe(error); }
  finally { pendingControl = false; await refreshStatus(); }
}

elements["capture-start"].addEventListener("click", () => { void control("hd_capture_start"); });
elements["capture-stop"].addEventListener("click", () => { void control("hd_capture_stop"); });
elements["reading-tab"].addEventListener("focus", () => { void refreshTabs(); });
elements["link-page"].addEventListener("click", async () => {
  try {
    const tabId = Number(elements["reading-tab"].value);
    const reply = await send("hd_capture_link", { tabId });
    selectedTabId = reply.page.tabId;
    await refreshStatus();
  } catch (error) {
    elements["page-status"].textContent = describe(error);
  }
});
elements["select-video"].addEventListener("click", async () => {
  try {
    await send("hd_capture_video_select", {
      tabId: selectedTabId,
      videoId: elements["reading-video"].value,
    });
    elements["page-status"].textContent = "Video source selected.";
  } catch (error) {
    elements["page-status"].textContent = describe(error);
  }
});
elements["track-area"].addEventListener("click", async () => {
  try {
    await send("hd_capture_track_area", { tabId: selectedTabId });
    elements["page-status"].textContent = "Choose an area on the linked page; press Escape to cancel.";
  } catch (error) {
    elements["page-status"].textContent = describe(error);
  }
});
elements["clear-area"].addEventListener("click", async () => {
  try {
    await send("hd_capture_clear_area", { tabId: selectedTabId });
    elements["page-status"].textContent = "Tracked text area cleared.";
  } catch (error) {
    elements["page-status"].textContent = describe(error);
  }
});

async function refreshStatus() {
  try { render(await send("hd_capture_status")); }
  catch (error) { elements["capture-error"].textContent = describe(error); }
}

await refreshStatus();
await refreshTabs();
setInterval(() => { void refreshStatus(); }, 1000);
