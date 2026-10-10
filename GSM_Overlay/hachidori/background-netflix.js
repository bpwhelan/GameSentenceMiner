// Experimental Netflix mining in the service worker: the recorder frame's port, line recordings, and the
// WAV the player page cuts from what the viewer heard.
// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionApi as chrome } from "./browser-api.js";
import { normaliseOptions, OPTIONS_KEY } from "./background-core.js";
import { getAnkiMining } from "./background-requests.js";
import { sharingLinked } from "./background-sharing.js";
import { sharingReady } from "./background.js";
import { NETFLIX_SCRIPTS } from "./netflix.js";

// Experimental Netflix mining (docs/architecture.md, Netflix mining). The
// player page cuts a line's sentence audio from what the viewer heard and
// sends its WAV with `line_audio`. Otherwise, while the page replays the line,
// a hidden recorder frame in the Netflix tab (netflix-recorder.html) records
// the tab: `start` lets that frame open its tab-capture stream, `finish` has it
// cut the line out and gives its WAV and GIF to the Anki worker to hold for
// the note, `cancel` stops it. The frame connects on a port; the worker holds
// no media itself and only the WAV and GIF reach Anki. `load` adds the Netflix
// scripts to a page that was open before the switch went on.
const NETFLIX_TARGET = "hachidori-netflix";
const NETFLIX_RECORDER_PORT = "hachidori-netflix-recorder";
const NETFLIX_WATCH_URL = /^https:\/\/www\.netflix\.com\/watch\/\d+/u;
// How long the reader's recorder frame has to load and connect.
const NETFLIX_RECORDER_CONNECT_MS = 10_000;
// Beyond the line itself, an unfinished recording gets this long before the
// recorder stops it and gives the tab its sound back.
const NETFLIX_RECORDING_SLACK_MS = 60_000;
// Recorder frames that connected, by tab, until a recording claims them.
const netflixRecorders = new Map();
const netflixRecorderWaiters = new Map();
let netflixRecording = null;

function netflixCue(value) {
  if (!value || typeof value !== "object" || typeof value.movieId !== "string" || !/^\d+$/u.test(value.movieId)
      || !Number.isFinite(value.startMs) || !Number.isFinite(value.endMs)
      || value.startMs < 0 || value.endMs < value.startMs) {
    throw new Error("The Netflix line to record is invalid.");
  }
  return { movieId: value.movieId, startMs: value.startMs, endMs: value.endMs };
}

// The exact top-frame Netflix player document that asked.
async function netflixPlayerTab(sender) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || typeof sender.tab?.id !== "number"
      || !sender.documentId) {
    throw new Error("Only the Netflix player page can record a line.");
  }
  const tab = await chrome.tabs.get(sender.tab.id);
  if (!NETFLIX_WATCH_URL.test(tab?.url ?? "")) throw new Error("The tab is no longer playing a Netflix title.");
  const document = await chrome.tabs.sendMessage(tab.id, { target: "hachidori-anki-content", type: "hd_anki_document" },
    { documentId: sender.documentId }).catch(() => null);
  if (document?.present !== true) throw new Error("The Netflix page changed before the line was recorded.");
  return tab;
}

// Tab capture records the active tab's player page only.
async function netflixRecordingTab(sender) {
  const tab = await netflixPlayerTab(sender);
  if (tab.active !== true) throw new Error("The Netflix tab is no longer the active tab.");
  return tab;
}

function adoptNetflixRecorder(tabId, port) {
  const waiter = netflixRecorderWaiters.get(tabId);
  if (waiter) {
    netflixRecorderWaiters.delete(tabId);
    waiter(port);
  } else {
    netflixRecorders.get(tabId)?.disconnect();
    netflixRecorders.set(tabId, port);
    port.onDisconnect.addListener(() => {
      if (netflixRecorders.get(tabId) === port) netflixRecorders.delete(tabId);
    });
  }
}

function netflixRecorderPort(tabId) {
  const ready = netflixRecorders.get(tabId);
  if (ready) {
    netflixRecorders.delete(tabId);
    return Promise.resolve(ready);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      netflixRecorderWaiters.delete(tabId);
      reject(new Error("The recorder did not start in the Netflix tab."));
    }, NETFLIX_RECORDER_CONNECT_MS);
    netflixRecorderWaiters.set(tabId, port => {
      clearTimeout(timer);
      resolve(port);
    });
  });
}

// One request and its answer on the recorder's port.
function askRecorder(port, message, reply) {
  return new Promise((resolve, reject) => {
    const settle = answer => {
      port.onMessage.removeListener(settle);
      port.onDisconnect.removeListener(lost);
      if (answer?.type === reply) resolve(answer);
      else reject(new Error(answer?.error || "The recorder sent an unexpected reply."));
    };
    const lost = () => {
      port.onMessage.removeListener(settle);
      reject(new Error("The recording of this line was interrupted."));
    };
    port.onMessage.addListener(settle);
    port.onDisconnect.addListener(lost);
    port.postMessage(message);
  });
}

function stopNetflixRecording() {
  const recording = netflixRecording;
  netflixRecording = null;
  recording?.port.disconnect();
}

async function startNetflixRecording(message, sender) {
  if (sharingLinked) return { unavailable: "linked" };
  const cue = netflixCue(message.cue);
  const tab = await netflixRecordingTab(sender);
  // One line at a time: a newer Add takes over from an older one.
  stopNetflixRecording();
  const port = await netflixRecorderPort(tab.id);
  const recording = { sessionId: crypto.randomUUID(), documentId: sender.documentId, cue, port };
  netflixRecording = recording;
  port.onDisconnect.addListener(() => {
    if (netflixRecording === recording) netflixRecording = null;
  });
  let started;
  try {
    started = await askRecorder(port, { type: "record", targetTabId: tab.id, audio: message.audio !== false,
      gif: message.gif === true, limitMs: cue.endMs - cue.startMs + NETFLIX_RECORDING_SLACK_MS }, "started");
  } catch (error) {
    if (netflixRecording === recording) stopNetflixRecording();
    throw error;
  }
  if (typeof started.unavailable === "string") {
    if (netflixRecording === recording) stopNetflixRecording();
    return { unavailable: started.unavailable };
  }
  return { sessionId: recording.sessionId, padMs: started.padMs };
}

async function finishNetflixRecording(message, sender) {
  const recording = netflixRecording;
  if (recording?.sessionId !== message.sessionId || recording.documentId !== sender.documentId) {
    throw new Error("The recording of this line was replaced or interrupted.");
  }
  let clip;
  try {
    clip = await askRecorder(recording.port, { type: "finish", startMs: recording.cue.startMs,
      endMs: recording.cue.endMs, anchors: message.anchors }, "clip");
  } finally {
    if (netflixRecording === recording) stopNetflixRecording();
  }
  const mining = getAnkiMining();
  // The GIF, when the recorder made one, is held like the WAV: on its own token
  // for the {gif} field, independent of whether the audio was silent. A
  // recording for a {gif} field alone has no WAV to hold.
  const gif = typeof clip.gif === "string" ? await mining.gifImage(clip.gif, message.templateId) : null;
  let audio = null;
  if (clip.silent === true) audio = { unavailable: "silent" };
  else if (typeof clip.data === "string") audio = await mining.sentenceAudio(clip.data, message.templateId);
  return { audio, gif };
}

function cancelNetflixRecording(message, sender) {
  if (netflixRecording?.sessionId === message.sessionId && netflixRecording.documentId === sender.documentId) {
    stopNetflixRecording();
  }
  return { cancelled: true };
}

// The WAV the player page cut from what the viewer heard (netflix-audio.js),
// held for the note like a recorded one. Nothing was captured, so the page
// need not be the active tab.
async function holdNetflixLineAudio(message, sender) {
  if (sharingLinked) return { unavailable: "linked" };
  await netflixPlayerTab(sender);
  return getAnkiMining().sentenceAudio(message.data, message.templateId);
}

// Chrome adds a registered script only to pages that load after it was
// registered, so a Netflix page open when the switch went on has the reader
// without the Netflix scripts. Its reader asks once, and they are added to
// that exact document as netflix.js registers them: the page's hooks in its
// main world and the reader's scripts. Neither talks to the other as it loads.
// Netflix read the playing episode's subtitle list before the hooks were
// there, so that episode has no timing until the page reloads.
async function loadNetflixScripts(message, sender) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || typeof sender.tab?.id !== "number"
      || !sender.documentId || !(sender.url ?? "").startsWith("https://www.netflix.com/")) {
    throw new Error("Only a Netflix page can load the Netflix scripts.");
  }
  const target = { tabId: sender.tab.id, documentIds: [sender.documentId] };
  await Promise.all(NETFLIX_SCRIPTS.map(({ js, world }) => chrome.scripting.executeScript({ target, files: js, world })));
  return { loaded: true };
}

const NETFLIX_REQUESTS = {
  hd_netflix_capture_start: startNetflixRecording,
  hd_netflix_capture_finish: finishNetflixRecording,
  hd_netflix_capture_cancel: cancelNetflixRecording,
  hd_netflix_line_audio: holdNetflixLineAudio,
  hd_netflix_load: loadNetflixScripts,
};

async function handleNetflixRequest(message, sender) {
  if (!Object.hasOwn(NETFLIX_REQUESTS, message.type)) throw new Error("Unknown Netflix request.");
  await sharingReady;
  const options = normaliseOptions((await chrome.storage.local.get(OPTIONS_KEY))[OPTIONS_KEY]);
  if (options.experimental.netflixMining !== true) throw new Error("Netflix mining is turned off in Settings.");
  return NETFLIX_REQUESTS[message.type](message, sender);
}

export { NETFLIX_TARGET, NETFLIX_RECORDER_PORT, NETFLIX_WATCH_URL, adoptNetflixRecorder, handleNetflixRequest };
