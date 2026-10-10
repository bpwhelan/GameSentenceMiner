// The service worker's Anki routes: mining, screenshots, linked Anki, word status and the duplicate
// index's role.
// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionApi as chrome } from "./browser-api.js";
import { describeErrorOrJson } from "./error-text.js";
import { captureNetflixPreview } from "./netflix-preview.js";
import { LINKED_ANKI_CAPABILITY, LINKED_ANKI_UNSUPPORTED } from "./sharing-protocol.js";
import { MINING_CAPABILITIES } from "./overlay-mode.js";
import { capabilityAnkiOptions } from "./setup-state.js";
import {
  normaliseOptions, OPTIONS_KEY, sleep, relay, startupSender, workerReply, failureReply,
} from "./background-core.js";
import { getAnkiDuplicateIndex, getAnkiMining } from "./background-requests.js";
import {
  sharingLinked, sharingTransitionTail, linkedAnkiConfigKey, hostLinkedAnkiRequest, getSharingClient, forwardToHost,
} from "./background-sharing.js";
import { sharingReady } from "./background.js";

let activeAnkiOperations = 0;
const ankiIdleWaiters = new Set();

function trackAnkiOperation(job) {
  activeAnkiOperations += 1;
  return Promise.resolve().then(job).finally(() => {
    activeAnkiOperations -= 1;
    if (activeAnkiOperations !== 0) return;
    for (const resolve of ankiIdleWaiters) resolve();
    ankiIdleWaiters.clear();
  });
}

function waitForAnkiIdle() {
  if (activeAnkiOperations === 0) return Promise.resolve();
  return new Promise(resolve => ankiIdleWaiters.add(resolve));
}

async function readAnkiOptions() {
  const options = normaliseOptions((await chrome.storage.local.get(OPTIONS_KEY))[OPTIONS_KEY]);
  return capabilityAnkiOptions(options, {
    screenshot: MINING_CAPABILITIES.screenshot,
    browserSpeech: MINING_CAPABILITIES.browserSpeech,
  });
}

const CONTENT_WORD_STATUS_TARGET = "hachidori-anki-content";

// Every reading tab's content script re-reads word status for the headwords it
// already shows when the duplicate index's row revision changes: an add, a
// click-time repair or the 30-minute refresh (#520). The index is derived
// state, so this is a signal, not stored data; the content script fetches the
// current statuses itself. A linked browser relays its host's revision here.
// `revision` is null when the evidence itself changed (another Template
// source, or linking to or unlinking from a host): earlier revisions then
// belong to other rows and cannot be compared with later ones.
function broadcastWordStatus(revision) {
  if (typeof chrome.tabs?.query !== "function") return;
  void (async () => {
    let tabs;
    try {
      tabs = await chrome.tabs.query({});
    } catch {
      return;
    }
    await Promise.all(tabs.map(async tab => {
      if (typeof tab.id !== "number") return;
      try {
        await chrome.tabs.sendMessage(tab.id, {
          target: CONTENT_WORD_STATUS_TARGET, type: "hd_anki_word_status_changed", revision,
        });
      } catch {
        // A tab without a content script (chrome://, the Web Store) has no reader.
      }
    }));
  })();
}

function indexRevision(value, key) {
  return value?.version === 1 && Number.isInteger(value[key]) ? value[key] : 0;
}

async function applyAnkiIndexRole() {
  const index = getAnkiDuplicateIndex();
  if (sharingLinked) await index.suspend();
  else await index.resume();
}

async function reconcileAnkiIndex() {
  await sharingReady;
  // A link suspends the old role before publishing the new one. An options
  // event or alarm in that interval must not resume local Anki behind it.
  await sharingTransitionTail;
  await applyAnkiIndexRole();
}

const ANKI_METHODS = { hd_anki_status: "status", hd_anki_view: "view", hd_anki_preflight: "preflight",
  hd_anki_preflight_batch: "preflightMany", hd_anki_submit: "submit",
  hd_anki_browse: "browse", hd_anki_screenshot: "screenshot", hd_anki_screenshot_discard: "discardScreenshot",
  hd_anki_maturity: "maturity", hd_anki_word_status: "wordStatus" };

// Chrome rate-limits viewport captures, so a second mining action in the same
// second waits once rather than losing its screenshot.
const CAPTURE_VISIBLE_RETRY_MS = 600;

// Startup messages can include or omit sender.tab. Chrome's live extension
// contexts bind either shape to the same document.
async function screenshotOwnedTab(sender, startup) {
  let tabId = sender.tab?.id;
  if (startup && typeof chrome.runtime.getContexts === "function") {
    const [context] = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentIds: [sender.documentId] });
    if (!context) throw new Error("The reading document changed before the screenshot.");
    tabId = context.tabId;
  }
  const tab = await chrome.tabs.get(tabId);
  if (tab?.active !== true) throw new Error("The reading tab is no longer the active tab.");
  // Tabs hides extension-page URLs; startup's exact live document was checked above.
  // The script URL can predate SPA navigation; sender.tab snapshots the current page.
  if (!startup && (sender.frameId ?? 0) === 0 && tab.url !== (sender.tab?.url ?? sender.url)) {
    throw new Error("The reading tab moved to another page before the screenshot.");
  }
  if (!startup) {
    // Address the exact content-script document, so a same-URL reload cannot
    // answer on its predecessor's behalf.
    const document = await chrome.tabs.sendMessage(tabId, {
      target: "hachidori-anki-content", type: "hd_anki_document",
    }, { documentId: sender.documentId }).catch(() => null);
    if (document?.present !== true) throw new Error("The reading document changed before the screenshot.");
  }
  return tab;
}

async function captureNetflixPreviewInDocument(tab, sender) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, documentIds: [sender.documentId] }, world: "MAIN",
    func: captureNetflixPreview, args: [tab.url],
  });
  if (injection?.documentId !== sender.documentId || injection?.frameId !== 0) {
    throw new Error("The reading document changed before the Netflix preview was read.");
  }
  if (typeof injection.result?.error === "string") throw new Error(injection.result.error);
  const dataUrl = injection.result?.dataUrl;
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/jpeg;base64,/9j/")) {
    throw new Error("Netflix preview screenshot: no JPEG preview image was returned.");
  }
  return dataUrl;
}

// captureVisibleTab takes the window's active tab. Both the active page and its
// document owner are checked around every attempt, including a rate-limit retry.
async function captureSenderViewport(sender, options) {
  const startup = startupSender(sender);
  if (typeof sender.tab?.id !== "number" && !startup) {
    throw new Error("Only a reading tab can be captured.");
  }
  if (!sender.documentId) throw new Error("The reading document identity is unavailable.");
  for (let attempt = 1; ; attempt += 1) {
    const tab = await screenshotOwnedTab(sender, startup);
    const preview = options.experimental.netflixPreviewScreenshots === true && !startup && (sender.frameId ?? 0) === 0
      && /^https:\/\/www\.netflix\.com\/watch\/\d+(?:[?#]|$)/u.test(tab.url);
    let captured;
    try {
      if (preview) {
        captured = await captureNetflixPreviewInDocument(tab, sender);
      } else {
        captured = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg" });
      }
    } catch (error) {
      if (preview || attempt >= 2 || !/per second|too many|MAX_CAPTURE/iu.test(describeErrorOrJson(error))) throw error;
      await sleep(CAPTURE_VISIBLE_RETRY_MS);
      continue;
    }
    // Capturing stays bound to this window even if the active reading tab is
    // dragged to another one before the pixels return.
    const afterCapture = await screenshotOwnedTab(sender, startup);
    if (afterCapture.windowId !== tab.windowId) {
      throw new Error("The reading tab moved to another window during the screenshot.");
    }
    return captured;
  }
}

async function handleAnkiRequest(message, sender) {
  await sharingReady;
  // Linking waits for operations admitted under the old role. Requests which
  // arrive during that transition wait too, so none can read one browser's
  // configuration and finish after routing has moved to another.
  await sharingTransitionTail;
  return trackAnkiOperation(async () => {
    if (sharingLinked) {
      // The reading browser alone can capture or discard its viewport bytes.
      if (["hd_anki_screenshot", "hd_anki_screenshot_discard"].includes(message.type)) {
        return answerAnkiRequest(message, sender);
      }
      // Mature-word evidence has always belonged to the host, including hosts
      // from before linked mining advertised a capability. Page-wide word
      // status reads the same host-owned index, always for its first Template.
      if (["hd_anki_maturity", "hd_anki_word_status"].includes(message.type)) return forwardToHost(message);
      if (message.type === "hd_anki_submit") return submitToLinkedAnki(message);
      if (message.type === "hd_anki_preflight_batch") return linkedPreflightBatch(message);
      if (["hd_anki_status", "hd_anki_view", "hd_anki_preflight", "hd_anki_browse"].includes(message.type)) {
        return forwardLinkedAnki(message);
      }
    }
    return answerAnkiRequest(message, sender);
  });
}

async function forwardLinkedAnki(message) {
  try {
    const reply = await getSharingClient().forward(message, { capability: LINKED_ANKI_CAPABILITY });
    if (message.type === "hd_anki_preflight" && reply?.ok !== false && reply?.clientSpeech) {
      await getAnkiMining().preflightClientSpeech({
        ...message.request,
        clientSpeech: reply.clientSpeech,
      });
    }
    return reply;
  } catch (error) {
    if (message.type === "hd_anki_status" && describeErrorOrJson(error) === LINKED_ANKI_UNSUPPORTED) {
      return workerReply(message, { available: false, configKey: "", error: LINKED_ANKI_UNSUPPORTED });
    }
    return failureReply(message, error);
  }
}

// The sharing protocol carries one preflight per request, so a linked browser
// forwards a popup batch to its host as single preflights, sent together and
// told apart by their sharing frames, and a host without batches keeps
// answering. Each entry becomes what the reader made of that single reply.
async function linkedPreflight(message, request) {
  const single = { target: message.target, type: "hd_anki_preflight", requestId: message.requestId, request };
  const reply = await forwardLinkedAnki(single);
  if (reply?.type !== `${single.type}_result` || reply.requestId !== single.requestId) {
    return { state: "error", canAdd: false, error: `unexpected reply for ${single.type}` };
  }
  if (reply.ok !== true) return { state: "error", canAdd: false, error: reply.error || `${single.type} failed` };
  const entry = Object.fromEntries(Object.entries(reply).filter(([key]) => !["type", "requestId", "ok"].includes(key)));
  // Netflix media stay with the reading browser's own Anki connection, so a
  // linked Netflix request is told it gets none.
  return request?.netflix !== null && typeof request?.netflix === "object" ? { ...entry, netflixLinked: true } : entry;
}

async function linkedPreflightBatch(message) {
  return workerReply(message, {
    replies: await Promise.all(message.requests.map(request => linkedPreflight(message, request))),
  });
}

async function sendAnkiRequest(target, fields) {
  const reply = await relay({ ...fields, target, requestId: `anki-${crypto.randomUUID()}` });
  if (!reply?.ok) throw new Error(reply?.error || "Anki preparation did not complete.");
  return reply;
}

async function submitToLinkedAnki(message) { // NOSONAR: moved verbatim (#533)
  const local = getAnkiMining();
  let clientMedia;
  try {
    clientMedia = await local.clientMedia(message.request);
  } catch (error) {
    return failureReply(message, error);
  }
  let sent = false;
  let reply;
  try {
    reply = await getSharingClient().forward({ ...message, clientMedia }, {
      capability: LINKED_ANKI_CAPABILITY,
      mutation: true,
      onSent: () => { sent = true; },
    });
  } catch (error) {
    if (!sent) return failureReply(message, error);
    return workerReply(message, {
      state: "uncertain",
      error: `The write could not be confirmed. Check Anki before trying again. ${describeErrorOrJson(error)}`,
    });
  }
  const states = ["added", "updated", "duplicate", "invalid", "uncertain"];
  if (!reply || reply.type !== `${message.type}_result` || reply.requestId !== message.requestId // NOSONAR: moved verbatim (#533)
      || typeof reply.ok !== "boolean" || (reply.ok === true && !states.includes(reply.state))) {
    return workerReply(message, {
      state: "uncertain",
      error: "The write could not be confirmed. Check Anki before trying again. The linked Hachidori returned an unexpected response.",
    });
  }
  const settlement = reply.ok === false ? "invalid"
    : ["added", "updated", "duplicate", "invalid"].includes(reply.state) ? reply.state : null; // NOSONAR: moved verbatim (#533)
  if (settlement !== null) {
    try {
      await local.settleClientMedia(message.request, settlement);
    } catch (error) {
      if (["added", "updated"].includes(settlement)) {
        reply = { ...reply, warnings: [...(Array.isArray(reply.warnings) ? reply.warnings : []),
          `Media cleanup: ${describeErrorOrJson(error)}`] };
      } else {
        console.warn("hachidori: could not discard rejected linked media:", describeErrorOrJson(error));
      }
    }
  }
  return reply;
}

function answerAnkiRequest(message, sender, linkedClient = false) {
  return Promise.resolve().then(async () => {
    if (sender.id !== chrome.runtime.id || !Object.hasOwn(ANKI_METHODS, message.type)) throw new Error("Unknown Anki request.");
    const service = getAnkiMining();
    // Only the screenshot needs to know which page asked, and it is given the
    // capture rather than the sender, so nothing else can capture a tab.
    if (message.type === "hd_anki_screenshot") {
      return service.screenshot(options => captureSenderViewport(sender, options), message.templateId);
    }
    if (linkedClient && message.type === "hd_anki_status") {
      const status = await service.status(message.templateId);
      return { ...status, configKey: linkedAnkiConfigKey(status.configKey) };
    }
    if (linkedClient && message.type === "hd_anki_view") {
      const result = await service.view(message.request);
      return { ...result, configKey: linkedAnkiConfigKey(result.configKey) };
    }
    if (linkedClient && message.type === "hd_anki_preflight") {
      return service.preflightClient(hostLinkedAnkiRequest(message.request));
    }
    if (linkedClient && message.type === "hd_anki_submit") {
      return service.submitClient(hostLinkedAnkiRequest(message.request), message.clientMedia);
    }
    if (linkedClient && message.type === "hd_anki_browse") {
      return service.browse(hostLinkedAnkiRequest(message.request));
    }
    if (message.type === "hd_anki_status") return service.status(message.templateId);
    if (message.type === "hd_anki_preflight_batch") return { replies: await service.preflightMany(message.requests) };
    return service[ANKI_METHODS[message.type]](message.type === "hd_anki_browse"
      ? message.request ?? message.expression : message.request);
  }).then(result => workerReply(message, result), error => failureReply(message, error));
}

export {
  trackAnkiOperation, waitForAnkiIdle, readAnkiOptions, broadcastWordStatus, indexRevision, applyAnkiIndexRole,
  reconcileAnkiIndex, handleAnkiRequest, sendAnkiRequest, answerAnkiRequest,
};
