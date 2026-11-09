// Experimental Netflix and YouTube mining in the service worker: a site's
// recorder frame's port, line recordings, and the WAV the player page cuts from
// what the viewer heard. background-netflix.js and background-youtube.js give
// each site its names.
// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionApi as chrome } from "./browser-api.js";
import { normaliseOptions, OPTIONS_KEY } from "./background-core.js";
import { getAnkiMining } from "./background-requests.js";
import { sharingLinked } from "./background-sharing.js";
import { sharingReady } from "./background.js";
import { profileTemplateKey } from "./anki-worker.js";

// How long the reader's recorder frame has to load and connect.
const VIDEO_RECORDER_CONNECT_MS = 10_000;
// Beyond the line itself, an unfinished recording gets this long before the
// recorder stops it and gives the tab its sound back.
const VIDEO_RECORDING_SLACK_MS = 60_000;

// The Template a request holds media for: once the records have profiles the
// request names its profile (docs/languages.md 5.4).
function template(message) {
  return message.profileId === undefined ? message.templateId : profileTemplateKey(message.profileId, message.templateId);
}

// The part of the tab a GIF keeps, as fractions of its width and height (the
// video, on YouTube), with the tab's aspect ratio, when the reader sent one
// that fits in the tab.
function cropOf(value) {
  if (value === null || typeof value !== "object") return null;
  const { left, top, width, height, aspect } = value;
  const fits = [left, top, width, height, aspect].every(Number.isFinite) && left >= 0 && top >= 0 && width > 0
    && height > 0 && left + width <= 1 && top + height <= 1 && aspect > 0;
  return fits ? { left, top, width, height, aspect } : null;
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

// One site's mining service (docs/architecture.md, Netflix mining). The player
// page cuts a line's sentence audio from what the viewer heard and sends its
// WAV with `line_audio`. Otherwise, while the page replays the line, a hidden
// recorder frame in the site's tab records the tab: `start` lets that frame
// open its tab-capture stream, `finish` has it cut the line out and gives its
// WAV and GIF to the Anki worker to hold for the note, `cancel` stops it. The
// frame connects on a port; the worker holds no media itself and only the WAV
// and GIF reach Anki. `load` adds the site's scripts to a page that was open
// before the switch went on.
//
// `site` names the site and its switch (`name`, `flag`), its requests' target,
// its recorder port and page, the pages it plays on (`origin`, `playerUrl`,
// and `playing`, what the tab no longer does when it left them), its video
// IDs (`movieId`), its registered `scripts`, and `requests`, the message type
// of each operation.
function createVideoSiteService(site) {
  const { name } = site;
  // The switch the Anki worker checks before it holds the site's media.
  const feature = { flag: site.flag, label: `${name} mining` };
  // Recorder frames that connected, by tab, until a recording claims them.
  const recorders = new Map();
  const recorderWaiters = new Map();
  let recording = null;

  function cueOf(value) {
    if (!value || typeof value !== "object" || typeof value.movieId !== "string" || !site.movieId.test(value.movieId)
        || !Number.isFinite(value.startMs) || !Number.isFinite(value.endMs)
        || value.startMs < 0 || value.endMs < value.startMs) {
      throw new Error(`The ${name} line to record is invalid.`);
    }
    return { movieId: value.movieId, startMs: value.startMs, endMs: value.endMs };
  }

  // The exact top-frame player document that asked.
  async function playerTab(sender) {
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || typeof sender.tab?.id !== "number"
        || !sender.documentId) {
      throw new Error(`Only the ${name} player page can record a line.`);
    }
    const tab = await chrome.tabs.get(sender.tab.id);
    if (!site.playerUrl.test(tab?.url ?? "")) throw new Error(`The tab is no longer ${site.playing}.`);
    const document = await chrome.tabs.sendMessage(tab.id, { target: "hachidori-anki-content", type: "hd_anki_document" },
      { documentId: sender.documentId }).catch(() => null);
    if (document?.present !== true) throw new Error(`The ${name} page changed before the line was recorded.`);
    return tab;
  }

  // Tab capture records the active tab's player page only.
  async function recordingTab(sender) {
    const tab = await playerTab(sender);
    if (tab.active !== true) throw new Error(`The ${name} tab is no longer the active tab.`);
    return tab;
  }

  function adoptRecorder(tabId, port) {
    const waiter = recorderWaiters.get(tabId);
    if (waiter) {
      recorderWaiters.delete(tabId);
      waiter(port);
    } else {
      recorders.get(tabId)?.disconnect();
      recorders.set(tabId, port);
      port.onDisconnect.addListener(() => {
        if (recorders.get(tabId) === port) recorders.delete(tabId);
      });
    }
  }

  // Only this extension's own recorder page, framed in a player tab of the
  // site, may connect, and only while the site's switch is on: the page is
  // web-accessible to the site, so a frame the site made itself is refused with
  // the switch off.
  function connectRecorder(port) {
    const { sender } = port;
    const tabId = sender?.tab?.id;
    if (sender?.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL(site.recorderPage)
        || typeof tabId !== "number" || !sender.frameId || !site.playerUrl.test(sender.tab.url ?? "")) {
      port.disconnect();
      return;
    }
    let open = true;
    port.onDisconnect.addListener(() => { open = false; });
    chrome.storage.local.get(OPTIONS_KEY).then(stored => {
      if (!open) return;
      if (normaliseOptions(stored[OPTIONS_KEY]).experimental[site.flag] === true) adoptRecorder(tabId, port);
      else port.disconnect();
    }, () => port.disconnect());
  }

  function recorderPort(tabId) {
    const ready = recorders.get(tabId);
    if (ready) {
      recorders.delete(tabId);
      return Promise.resolve(ready);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        recorderWaiters.delete(tabId);
        reject(new Error(`The recorder did not start in the ${name} tab.`));
      }, VIDEO_RECORDER_CONNECT_MS);
      recorderWaiters.set(tabId, port => {
        clearTimeout(timer);
        resolve(port);
      });
    });
  }

  function stopRecording() {
    const current = recording;
    recording = null;
    current?.port.disconnect();
  }

  async function startRecording(message, sender) {
    if (sharingLinked) return { unavailable: "linked" };
    const cue = cueOf(message.cue);
    const crop = cropOf(message.crop);
    const tab = await recordingTab(sender);
    // One line at a time: a newer Add takes over from an older one.
    stopRecording();
    const port = await recorderPort(tab.id);
    const current = { sessionId: crypto.randomUUID(), documentId: sender.documentId, cue, port };
    recording = current;
    port.onDisconnect.addListener(() => {
      if (recording === current) recording = null;
    });
    let started;
    try {
      started = await askRecorder(port, { type: "record", targetTabId: tab.id, audio: message.audio !== false,
        gif: message.gif === true, limitMs: cue.endMs - cue.startMs + VIDEO_RECORDING_SLACK_MS, ...(crop ? { crop } : {}) },
      "started");
    } catch (error) {
      if (recording === current) stopRecording();
      throw error;
    }
    if (typeof started.unavailable === "string") {
      if (recording === current) stopRecording();
      return { unavailable: started.unavailable };
    }
    return { sessionId: current.sessionId, padMs: started.padMs };
  }

  async function finishRecording(message, sender) {
    const current = recording;
    if (current?.sessionId !== message.sessionId || current.documentId !== sender.documentId) {
      throw new Error("The recording of this line was replaced or interrupted.");
    }
    let clip;
    try {
      clip = await askRecorder(current.port, { type: "finish", startMs: current.cue.startMs,
        endMs: current.cue.endMs, anchors: message.anchors }, "clip");
    } finally {
      if (recording === current) stopRecording();
    }
    const mining = getAnkiMining();
    // The GIF, when the recorder made one, is held like the WAV: on its own token
    // for the {gif} field, independent of whether the audio was silent. A
    // recording for a {gif} field alone has no WAV to hold.
    const gif = typeof clip.gif === "string" ? await mining.gifImage(clip.gif, template(message), feature) : null;
    let audio = null;
    if (clip.silent === true) audio = { unavailable: "silent" };
    else if (typeof clip.data === "string") audio = await mining.sentenceAudio(clip.data, template(message), feature);
    return { audio, gif };
  }

  function cancelRecording(message, sender) {
    if (recording?.sessionId === message.sessionId && recording.documentId === sender.documentId) {
      stopRecording();
    }
    return { cancelled: true };
  }

  // The WAV the player page cut from what the viewer heard (netflix-audio.js),
  // held for the note like a recorded one. Nothing was captured, so the page
  // need not be the active tab.
  async function holdLineAudio(message, sender) {
    if (sharingLinked) return { unavailable: "linked" };
    await playerTab(sender);
    return getAnkiMining().sentenceAudio(message.data, template(message), feature);
  }

  // Chrome adds a registered script only to pages that load after it was
  // registered, so a page of the site open when the switch went on has the
  // reader without the site's scripts. Its reader asks once, and they are
  // added to that exact document as they are registered: the page's script in
  // its main world and the reader's. Neither talks to the other as it loads.
  // The player read what was playing before the page's script was there, so
  // that has no timing until the page reloads.
  async function loadScripts(message, sender) {
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || typeof sender.tab?.id !== "number"
        || !sender.documentId || !(sender.url ?? "").startsWith(site.origin)) {
      throw new Error(`Only a ${name} page can load the ${name} scripts.`);
    }
    const target = { tabId: sender.tab.id, documentIds: [sender.documentId] };
    await Promise.all(site.scripts.map(({ js, world }) => chrome.scripting.executeScript({ target, files: js, world })));
    return { loaded: true };
  }

  const handlers = {
    [site.requests.start]: startRecording,
    [site.requests.finish]: finishRecording,
    [site.requests.cancel]: cancelRecording,
    [site.requests.lineAudio]: holdLineAudio,
    [site.requests.load]: loadScripts,
  };

  async function handleRequest(message, sender) {
    if (!Object.hasOwn(handlers, message.type)) throw new Error(`Unknown ${name} request.`);
    await sharingReady;
    const options = normaliseOptions((await chrome.storage.local.get(OPTIONS_KEY))[OPTIONS_KEY]);
    if (options.experimental[site.flag] !== true) throw new Error(`${name} mining is turned off in Settings.`);
    return handlers[message.type](message, sender);
  }

  return { target: site.target, recorderPort: site.recorderPort, adoptRecorder, connectRecorder, handleRequest };
}

export { createVideoSiteService };
